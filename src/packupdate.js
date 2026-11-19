'use strict';
// Updating an instance that was made from a downloaded modpack. A pack update is not a
// reinstall: what the person did to the instance since (mods they added, mods they moved
// to another file, config files they edited, files they deleted) has to survive it.
//
// What is known about the pack as it was installed is kept in the store (`packState`):
// every file it downloaded with a signature (a checksum, or the CurseForge file ID), and a
// checksum of each file it unpacked from its overrides. Comparing that with the new pack
// says what changed in the pack itself; comparing it with the disk says what changed in
// the instance.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { ApiError } = require('./http');

const OFF = '.disabled';
const RANK = { release: 0, beta: 1, alpha: 2 };

// The newest file of the pack's project that is a real update for the installed one: newer,
// and no less stable (someone on a release is not moved to a beta). Stays in the line the
// pack was installed for (same game version and loader). Answers a version or null.
async function newest(api, pack) {
  const asked = { type: 'modpack', gameVersion: pack.gameVersion || '', loader: pack.loader || '' };
  const list = (await api.versions(pack.projectId, asked)).filter((v) => v && (v.file || v.expected));
  let mine = null;
  try { mine = await api.getVersion(pack.projectId, pack.versionId); } catch {}
  const since = mine ? Date.parse(mine.date) : NaN;
  const level = RANK[mine ? mine.channel : pack.channel] ?? 0;
  return list
    .filter((v) => String(v.id) !== String(pack.versionId) && RANK[v.channel] <= level && (!Number.isFinite(since) || Date.parse(v.date) > since))
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0] || null;
}

// What an update does, decided from plain data.
//   old       { files: { rel: signature } } as the last install or update left it
//   wanted    the new pack's files, [{ rel, sig }] (downloads and website-only ones alike)
//   mine      Set of rels the person has their own copy of (see mineRels)
//   onDisk    (rel) => true when the file (or its disabled twin) is there
// -> { fetch: [wanted], same: [rel], mine: [rel], stale: [rel] }
//   fetch: new or changed in the pack; same: unchanged (left alone, even if the person
//   deleted it); mine: the person's version stays; stale: the old pack had it, the new one
//   does not, so it goes.
function plan(old, wanted, mine, onDisk) {
  const out = { fetch: [], same: [], mine: [], stale: [] };
  const now = new Set();
  for (const w of wanted) {
    if (!w.rel) continue;
    now.add(w.rel);
    if (mine.has(w.rel)) out.mine.push(w.rel);
    else if (old.files[w.rel] === w.sig) out.same.push(w.rel);
    else out.fetch.push(w);
  }
  for (const rel of Object.keys(old.files)) if (!now.has(rel) && onDisk(rel)) out.stale.push(rel);
  return out;
}

// Which of the new pack's files the person already has their own copy of: mods they added,
// or pack mods they updated, are found by project, so the pack's copy does not join theirs
// as a second jar of the same mod. `entries` is the instance's manifest; `projects` maps
// "site:projectId" to the new pack's rel. -> Set of rels.
function mineRels(entries, exists, projects) {
  const out = new Set();
  for (const [key, e] of Object.entries(entries)) {
    if (!e || e.unknown || !e.projectId || !(e.added || e.updated) || !exists(key)) continue;
    for (const [site, pid] of [[e.source, e.projectId], ...Object.entries(e.also || {})]) {
      const rel = projects.get(`${site}:${pid}`);
      if (rel) out.add(rel);
    }
  }
  return out;
}

// "site:projectId" -> rel for the new pack's files. CurseForge files say which project they
// are; Modrinth's are looked up by checksum, and only when somebody's own copy needs it.
async function projectsOf(wanted, sources, needModrinth) {
  const out = new Map();
  for (const w of wanted) if (w.site === 'curseforge' && w.projectId && w.rel) out.set(`curseforge:${w.projectId}`, w.rel);
  if (!needModrinth) return out;
  const sha1 = wanted.filter((w) => w.site === 'modrinth' && /^[0-9a-f]{40}$/.test(w.sig));
  if (!sha1.length) return out;
  const found = await sources.modrinth.identify(sha1.map((w) => w.sig));
  for (const w of sha1) if (found[w.sig]) out.set(`modrinth:${found[w.sig].projectId}`, w.rel);
  return out;
}

// What an update does with one file of the pack's overrides (config files and the like).
//   before  the checksum the pack had for it last time, or undefined
//   hash    the checksum in the new pack
//   now     the checksum of what is on disk, or null when nothing is
// -> 'same' (nothing to do), 'write' (put the pack's file in) or 'mine' (the person has
// changed it themselves, so their version stays).
function overrideAction(before, hash, now) {
  if (before === hash) return 'same';                    // the pack did not change it
  if (now === null) return 'write';
  if (now === hash) return 'same';
  if (before !== undefined && now === before) return 'write'; // still as the pack left it
  return 'mine';
}

const present = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

// Puts a trashed-or-disabled file out of the game's way. Returns false if it could not be.
async function discard(trash, file) {
  if (!present(file)) return true;
  try { await trash(file); return true; } catch {}
  if (!file.endsWith(OFF) && !present(file + OFF)) {
    try { await fsp.rename(file, file + OFF); return true; } catch {}
  }
  return false;
}

// Moves staged files into the game folder and removes the stale ones. A file the person
// had disabled stays disabled when its new version arrives. `entries` is the instance's
// manifest, kept in step. -> { removed, added, stuck: [rel that could not be removed] }
async function swap({ gameDir, staging, fetch, stale, trash, entries }) {
  const stuck = [];
  let removed = 0, added = 0;
  const forget = (rel) => { delete entries[rel]; }; // the next look at the folder names what is there now
  for (const rel of stale) {
    const full = path.join(gameDir, rel);
    const a = await discard(trash, full), b = await discard(trash, full + OFF);
    if (a && b) { removed++; forget(rel); } else stuck.push(rel);
  }
  for (const w of fetch) {
    const from = path.join(staging, w.rel), to = path.join(gameDir, w.rel);
    const parked = !present(to) && present(to + OFF); // the person had switched it off
    await fsp.mkdir(path.dirname(to), { recursive: true });
    try { await fsp.rename(from, parked ? to + OFF : to); } catch (e) {
      throw new ApiError(`Could not put ${path.basename(w.rel)} in place: ${e.code || e.message}.`, 'FS');
    }
    forget(w.rel);
    added++;
  }
  return { removed, added, stuck };
}

module.exports = { newest, plan, mineRels, projectsOf, swap, overrideAction, present };
