'use strict';
// Reading modpacks: Modrinth's .mrpack and CurseForge's exported .zip. Both are zip
// archives holding a list of files to download plus an "overrides" folder to copy into
// the game folder. A pack is someone else's file, so every path and URL in it is checked.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { ApiError, arr } = require('./http');

const MAX_ENTRY = 512 * 2 ** 20;      // largest single file accepted from an archive
const MAX_TOTAL = 4 * 2 ** 30;        // and the most an archive may unpack to
// The .mrpack format only allows downloads from these hosts.
const MRPACK_HOSTS = ['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com'];
const LOADER_KEYS = { 'fabric-loader': 'fabric', 'quilt-loader': 'quilt', forge: 'forge', neoforge: 'neoforge', 'neo-forge': 'neoforge' };

const bad = (why) => new ApiError(`This modpack file cannot be used: ${why}.`, 'BAD_PACK');

function inside(base, rel) {
  const full = path.resolve(base, rel);
  if (full === base || !full.startsWith(base + path.sep)) throw bad(`it contains a file path that leaves the instance folder (${String(rel).slice(0, 80)})`);
  return full;
}

const openZip = (file) => require('./zip').openZip(file, bad, MAX_ENTRY);

function json(zip, name) {
  const entry = zip.entries.get(name);
  if (!entry) return null;
  try { return JSON.parse(zip.read(entry).toString('utf8')); } catch { throw bad(`${name} is not readable`); }
}

// What the pack is: { kind, name, gameVersion, loader, loaderVersion } plus what populate() needs.
function inspect(file) {
  const zip = openZip(file);
  try {
    const mr = json(zip, 'modrinth.index.json');
    if (mr) {
      const deps = mr.dependencies && typeof mr.dependencies === 'object' ? mr.dependencies : {};
      if (mr.game && mr.game !== 'minecraft') throw bad('it is not for Minecraft');
      if (typeof deps.minecraft !== 'string') throw bad('it does not say which Minecraft version it needs');
      const key = Object.keys(LOADER_KEYS).find((k) => typeof deps[k] === 'string');
      return {
        zip, kind: 'modrinth', name: String(mr.name || path.basename(file, path.extname(file))),
        gameVersion: deps.minecraft, loader: key ? LOADER_KEYS[key] : '', loaderVersion: key ? deps[key] : '',
        files: arr(mr.files), overrides: ['overrides/', 'client-overrides/'],
      };
    }
    const cf = json(zip, 'manifest.json');
    if (cf && cf.minecraft && typeof cf.minecraft.version === 'string') {
      const loaders = arr(cf.minecraft.modLoaders).filter((l) => l && typeof l.id === 'string');
      const id = (loaders.find((l) => l.primary) || loaders[0] || {}).id || '';
      const m = id.match(/^(forge|fabric|quilt|neoforge)-(.+)$/);
      return {
        zip, kind: 'curseforge', name: String(cf.name || path.basename(file, path.extname(file))),
        gameVersion: cf.minecraft.version, loader: m ? m[1] : '', loaderVersion: m ? m[2] : '',
        files: arr(cf.files), overrides: [`${String(cf.overrides || 'overrides').replace(/^\/+|\/+$/g, '')}/`],
      };
    }
    throw bad('it is neither a Modrinth .mrpack nor a CurseForge modpack zip');
  } catch (e) {
    zip.close();
    throw e;
  }
}

// The downloads a pack asks for, as items for the downloader, plus what had to be left out.
// What to download for a pack: `items` to fetch, `skipped` files that cannot be had at all,
// and `blocked` files whose authors only allow downloads from the CurseForge website (those
// can still be fetched by hand, one page at a time).
async function downloads(pack, gameDir, curseforge) {
  const items = [], skipped = [], blocked = [];
  if (pack.kind === 'modrinth') {
    for (const f of pack.files) {
      if (!f || typeof f.path !== 'string') continue;
      if (f.env && f.env.client === 'unsupported') continue; // server-only file
      const full = inside(gameDir, f.path);
      const url = arr(f.downloads).find((u) => {
        try { const x = new URL(u); return x.protocol === 'https:' && MRPACK_HOSTS.includes(x.hostname); } catch { return false; }
      });
      if (!url) { skipped.push({ title: path.basename(f.path), reason: 'the pack gives no download from an allowed site' }); continue; }
      const hashes = f.hashes || {};
      items.push({ url, sha512: hashes.sha512, sha1: hashes.sha1, size: Number(f.fileSize) || 0, dir: path.dirname(full), filename: path.basename(full) });
    }
    return { items, skipped, blocked };
  }

  const wanted = pack.files.filter((f) => f && f.fileID && f.required !== false).map((f) => Number(f.fileID)).filter(Number.isInteger);
  if (wanted.length && !curseforge.hasKey()) throw new ApiError('Importing a CurseForge modpack needs your CurseForge API key. Add it in Settings first.', 'NO_CF_KEY');
  const found = new Map();
  for (let i = 0; i < wanted.length; i += 50) {
    for (const v of await curseforge.getFiles(wanted.slice(i, i + 50))) found.set(Number(v.id), v);
  }
  for (const id of wanted) {
    const v = found.get(id);
    if (!v) { skipped.push({ title: `File ${id}`, reason: 'CurseForge no longer has it' }); continue; }
    // The manifest does not say what kind of file each one is; jars are mods, zips are resource packs.
    if (!v.file) {
      const filename = (v.expected && v.expected.filename) || '';
      blocked.push({ projectId: String(v.projectId), fileId: String(v.id), title: v.name, filename, type: /\.zip$/i.test(filename) ? 'resourcepack' : 'mod' });
      continue;
    }
    const folder = /\.jar$/i.test(v.file.filename) ? 'mods' : 'resourcepacks';
    const full = inside(gameDir, path.join(folder, path.basename(v.file.filename)));
    items.push({ ...v.file, dir: path.dirname(full), filename: path.basename(full) });
  }
  return { items, skipped, blocked };
}

// Copies the pack's bundled files (configs, resource packs, ...) into the game folder.
async function unpackOverrides(pack, gameDir) {
  let total = 0, count = 0;
  for (const prefix of pack.overrides) {
    for (const entry of pack.zip.entries.values()) {
      if (!entry.name.startsWith(prefix) || entry.name.endsWith('/')) continue;
      const full = inside(gameDir, entry.name.slice(prefix.length));
      total += entry.size;
      if (total > MAX_TOTAL) throw bad('it unpacks to more than Modion accepts');
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, pack.zip.read(entry));
      count++;
    }
  }
  return count;
}

module.exports = { inspect, downloads, unpackOverrides };
