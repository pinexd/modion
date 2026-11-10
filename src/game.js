'use strict';
// Starting Minecraft directly: fetches the game, its libraries, assets and a matching Java
// from Mojang's own servers into a shared folder, builds the launch command from the
// version's metadata, and runs it in the instance's game folder.
//
// Covers vanilla from 1.0 on, and Fabric and Quilt wherever those loaders exist. Versions
// before 1.19 need native libraries unpacked; versions before 1.13 describe their launch
// command in an older format; versions before 1.7.3 keep their assets as plain files.
// Forge/NeoForge (which need their installers run) are not handled here yet.

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { getJson, ApiError, arr } = require('./http');
const { download } = require('./content');
const { openZip } = require('./zip');

const ROOT = require('./libraries').APP_DATA; // ~/.local/share/ModionApp
const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const RUNTIMES = 'https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const ASSETS = 'https://resources.download.minecraft.net';
const LOADER_META = {
  fabric: { name: 'Fabric', base: 'https://meta.fabricmc.net/v2/versions/loader' },
  quilt: { name: 'Quilt', base: 'https://meta.quiltmc.org/v3/versions/loader' },
};
const PARALLEL = 12;

const supports = (inst) => Boolean(inst && inst.gameVersion && (!inst.loader || Object.hasOwn(LOADER_META, inst.loader)));

// Mojang's metadata marks libraries and arguments with rules such as "only on macOS".
function allowed(rules) {
  if (!Array.isArray(rules) || !rules.length) return true;
  let ok = false;
  for (const r of rules) {
    if (!r) continue;
    const osOk = !r.os || ((!r.os.name || r.os.name === 'linux') && (!r.os.arch || r.os.arch === 'x64'));
    // Optional launcher features (demo mode, custom resolution, quick play) are all off.
    const featuresOk = !r.features || Object.values(r.features).every((v) => v === false);
    if (osOk && featuresOk) ok = r.action === 'allow';
  }
  return ok;
}

// "group:artifact:version[:classifier]" -> path inside a Maven repository
function mavenPath(name) {
  const [group, artifact, version, classifier] = String(name).split(':');
  if (!group || !artifact || !version) throw new ApiError(`Unreadable library name: ${name}`, 'BAD_REPLY');
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
}

// Keeps files inside the folder they belong to, whatever the metadata says.
function inside(base, rel) {
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) throw new ApiError('Refusing a file path that leaves its folder.', 'BAD_NAME');
  return full;
}

async function versionJson(gameVersion) {
  const file = path.join(ROOT, 'versions', gameVersion, `${gameVersion}.json`);
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch {}
  const entry = arr((await getJson(MANIFEST)).versions).find((v) => v && v.id === gameVersion);
  if (!entry || !entry.url) throw new ApiError(`Mojang does not list Minecraft ${gameVersion}.`, 'NO_GAME_VERSION');
  const json = await getJson(entry.url);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(json));
  return json;
}

async function loaderProfile(loader, gameVersion) {
  const meta = LOADER_META[loader];
  const builds = arr(await getJson(`${meta.base}/${encodeURIComponent(gameVersion)}`)).filter((b) => b && b.loader && b.loader.version);
  const pick = builds.find((b) => b.loader.stable) || builds.find((b) => !/beta|alpha|rc/i.test(b.loader.version)) || builds[0];
  if (!pick) throw new ApiError(`${meta.name} is not available for Minecraft ${gameVersion}.`, 'NO_LOADER_VERSION');
  return getJson(`${meta.base}/${encodeURIComponent(gameVersion)}/${encodeURIComponent(pick.loader.version)}/profile/json`);
}

// Downloads whatever is missing, a few files at a time, reporting overall progress.
async function fetchAll(items, progress) {
  const missing = [];
  for (const it of items) {
    let st = null;
    try { st = await fsp.stat(path.join(it.dir, it.filename)); } catch {}
    if (!st || !st.isFile() || (it.size && st.size !== it.size)) missing.push(it);
  }
  const total = missing.reduce((n, it) => n + (it.size || 0), 0);
  let done = 0, next = 0, failure = null;
  const worker = async () => {
    while (next < missing.length && !failure) {
      const it = missing[next++];
      try {
        await download(it, it.dir);
        if (it.mode) await fsp.chmod(path.join(it.dir, it.filename), it.mode);
      } catch (e) {
        failure = e;
        return;
      }
      done += it.size || 0;
      progress(done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, missing.length) }, worker));
  if (failure) throw failure;
  return missing.length;
}

// A Java of the right major version: one already on the system, or Mojang's own runtime.
async function findJava(wanted, progress) {
  const major = Number(wanted && wanted.majorVersion) || 8;
  const component = (wanted && wanted.component) || 'jre-legacy';
  let systems = [];
  try { systems = await fsp.readdir('/usr/lib/jvm'); } catch {}
  for (const name of systems) {
    const home = path.join('/usr/lib/jvm', name);
    try {
      const m = (await fsp.readFile(path.join(home, 'release'), 'utf8')).match(/^JAVA_VERSION="(\d+)(?:\.(\d+))?/m);
      const found = m && (m[1] === '1' ? Number(m[2]) : Number(m[1]));
      await fsp.access(path.join(home, 'bin/java'), fs.constants.X_OK);
      if (found === major) return path.join(home, 'bin/java');
    } catch {}
  }

  if (!/^[\w-]+$/.test(component)) throw new ApiError('Unreadable Java runtime name.', 'BAD_REPLY');
  const home = path.join(ROOT, 'runtimes', component);
  const java = path.join(home, 'bin/java');
  const marker = path.join(home, '.complete');
  if (fs.existsSync(marker) && fs.existsSync(java)) return java;

  const all = await getJson(RUNTIMES);
  const offer = arr(all.linux && all.linux[component])[0];
  if (!offer || !offer.manifest || !offer.manifest.url) throw new ApiError(`No Java ${major} runtime is available for this system. Install Java ${major} and try again.`, 'NO_JAVA');
  const files = (await getJson(offer.manifest.url)).files || {};
  const items = [], links = [];
  for (const [rel, f] of Object.entries(files)) {
    const full = inside(home, rel);
    if (f.type === 'directory') await fsp.mkdir(full, { recursive: true });
    else if (f.type === 'link' && typeof f.target === 'string') links.push([full, f.target]);
    else if (f.type === 'file' && f.downloads && f.downloads.raw && f.downloads.raw.size === 0) {
      // Some runtimes contain files that are meant to be empty; there is nothing to download.
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, '');
    } else if (f.type === 'file' && f.downloads && f.downloads.raw) {
      items.push({ url: f.downloads.raw.url, sha1: f.downloads.raw.sha1, size: f.downloads.raw.size, dir: path.dirname(full), filename: path.basename(full), mode: f.executable ? 0o755 : 0o644 });
    }
  }
  await fetchAll(items, progress);
  for (const [full, target] of links) {
    inside(home, path.join(path.dirname(path.relative(home, full)), target)); // links may not point outside the runtime
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.rm(full, { force: true });
    await fsp.symlink(target, full);
  }
  await fsp.writeFile(marker, offer.version && offer.version.name ? String(offer.version.name) : 'ok');
  return java;
}

// Old versions keep native code (LWJGL and friends) in separate jars that have to be unpacked
// into a folder the game is pointed at. Unpacked afresh for each start.
async function unpackNatives(jars, dir) {
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  for (const { file, exclude } of jars) {
    const zip = openZip(file);
    try {
      for (const entry of zip.entries.values()) {
        if (entry.name.endsWith('/') || exclude.some((x) => entry.name.startsWith(x))) continue;
        const full = inside(dir, entry.name);
        await fsp.mkdir(path.dirname(full), { recursive: true });
        await fsp.writeFile(full, zip.read(entry));
      }
    } finally {
      zip.close();
    }
  }
}

// Versions before 1.7.3 read their sounds and language files by name, not through the
// asset index: from <game folder>/resources (up to 1.5.2) or from one shared folder.
async function legacyAssets(index, id, gameDir) {
  if (!index.virtual && !index.map_to_resources) return null;
  const dir = index.map_to_resources ? path.join(gameDir, 'resources') : path.join(ROOT, 'assets', 'virtual', id);
  for (const [name, o] of Object.entries(index.objects || {})) {
    if (!o || !/^[0-9a-f]{40}$/.test(o.hash)) continue;
    const to = inside(dir, name);
    let have = null;
    try { have = await fsp.stat(to); } catch {}
    if (have && have.size === o.size) continue;
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(path.join(ROOT, 'assets', 'objects', o.hash.slice(0, 2), o.hash), to);
  }
  return dir;
}

// Mojang's logging setup for the version. It matters for more than looks: for 1.7 to 1.18
// it is what closes the Log4Shell hole. Mojang's file prints the console output as XML for
// its own launcher, so the copy Modion uses prints it as plain lines instead.
async function loggingConfig(game) {
  const spec = game.logging && game.logging.client;
  const f = spec && spec.file;
  if (!f || !f.url || typeof spec.argument !== 'string' || !/^[\w.-]+\.xml$/.test(String(f.id))) return null;
  const dir = path.join(ROOT, 'assets', 'log_configs');
  await fetchAll([{ url: f.url, sha1: f.sha1, size: f.size, dir, filename: f.id }], () => {});
  const xml = await fsp.readFile(path.join(dir, f.id), 'utf8');
  const pattern = xml.match(/<PatternLayout\b[^>]*\/>/);
  const plain = pattern ? xml.replace(/<(?:Legacy)?XMLLayout\s*\/>/g, pattern[0]) : xml;
  const file = path.join(dir, `plain-${f.id}`);
  await fsp.writeFile(file, plain);
  return spec.argument.replace('${path}', file);
}

// Everything needed to start this instance, downloading what is missing.
async function prepare(inst, progress) {
  if (process.arch !== 'x64') throw new ApiError('Direct launching is only set up for 64-bit Intel/AMD Linux so far.', 'UNSUPPORTED');
  const game = await versionJson(inst.gameVersion);
  if ((!game.arguments && typeof game.minecraftArguments !== 'string') || !game.downloads || !game.downloads.client || !game.assetIndex) {
    throw new ApiError(`Mojang's description of Minecraft ${inst.gameVersion} is not one Modion can start.`, 'UNSUPPORTED');
  }
  const profile = inst.loader ? await loaderProfile(inst.loader, inst.gameVersion) : null;

  const libDir = path.join(ROOT, 'libraries');
  const libs = new Map(); // "group:artifact[:classifier]" -> item; the loader's choice of a library wins
  const nativeJars = [];  // jars of native code to unpack (versions before 1.19)
  const add = (name, item) => { const [g, a, , c] = String(name).split(':'); const key = `${g}:${a}${c ? `:${c}` : ''}`; if (!libs.has(key)) libs.set(key, item); };
  for (const lib of arr(profile && profile.libraries)) {
    if (!lib || !lib.name) continue;
    const rel = mavenPath(lib.name);
    const full = inside(libDir, rel);
    add(lib.name, { url: String(lib.url || 'https://libraries.minecraft.net/').replace(/\/?$/, '/') + rel, sha1: lib.sha1, size: lib.size, dir: path.dirname(full), filename: path.basename(full) });
  }
  for (const lib of arr(game.libraries)) {
    if (!lib || !allowed(lib.rules)) continue;
    const a = lib.downloads && lib.downloads.artifact;
    if (a && a.url && a.path) {
      const full = inside(libDir, a.path);
      add(lib.name, { url: a.url, sha1: a.sha1, size: a.size, dir: path.dirname(full), filename: path.basename(full) });
    }
    const key = lib.natives && typeof lib.natives.linux === 'string' ? lib.natives.linux.replace('${arch}', '64') : null;
    const n = key && lib.downloads && lib.downloads.classifiers && lib.downloads.classifiers[key];
    if (n && n.url && n.path) {
      const full = inside(libDir, n.path);
      nativeJars.push({
        item: { url: n.url, sha1: n.sha1, size: n.size, dir: path.dirname(full), filename: path.basename(full) },
        file: full,
        exclude: arr(lib.extract && lib.extract.exclude).filter((x) => typeof x === 'string' && x),
      });
    }
  }

  const versionDir = path.join(ROOT, 'versions', inst.gameVersion);
  const client = { url: game.downloads.client.url, sha1: game.downloads.client.sha1, size: game.downloads.client.size, dir: versionDir, filename: `${inst.gameVersion}.jar` };

  if (!/^[\w.-]+$/.test(String(game.assetIndex.id))) throw new ApiError('Unreadable asset index name.', 'BAD_REPLY');
  const indexFile = path.join(ROOT, 'assets', 'indexes', `${game.assetIndex.id}.json`);
  let index;
  try { index = JSON.parse(await fsp.readFile(indexFile, 'utf8')); } catch {
    index = await getJson(game.assetIndex.url);
    await fsp.mkdir(path.dirname(indexFile), { recursive: true });
    await fsp.writeFile(indexFile, JSON.stringify(index));
  }
  const assets = new Map();
  for (const o of Object.values(index.objects || {})) {
    if (!o || !/^[0-9a-f]{40}$/.test(o.hash)) continue;
    const two = o.hash.slice(0, 2);
    assets.set(o.hash, { url: `${ASSETS}/${two}/${o.hash}`, sha1: o.hash, size: o.size, dir: path.join(ROOT, 'assets', 'objects', two), filename: o.hash });
  }

  // Java first: its progress is reported on its own, then the game files as one total.
  const java = await findJava(game.javaVersion, progress);
  await fetchAll([client, ...libs.values(), ...nativeJars.map((n) => n.item), ...assets.values()], progress);

  const natives = path.join(ROOT, 'natives', crypto.createHash('sha1').update(inst.path).digest('hex').slice(0, 12));
  await unpackNatives(nativeJars, natives);
  const gameAssets = await legacyAssets(index, game.assetIndex.id, inst.path);
  const logging = await loggingConfig(game);

  const classpath = [...[...libs.values()].map((l) => path.join(l.dir, l.filename)), path.join(versionDir, client.filename)];
  return { game, profile, java, classpath, natives, gameAssets, logging };
}

function launchArgs({ game, profile, classpath, natives, gameAssets, logging }, inst, session) {
  const values = {
    auth_player_name: session.name,
    auth_uuid: session.uuid,
    auth_access_token: session.token,
    auth_session: `token:${session.token}:${session.uuid}`, // what versions before 1.7 are given
    auth_xuid: '',
    clientid: '',
    user_type: session.offline ? 'legacy' : 'msa',
    user_properties: '{}',
    version_name: inst.gameVersion,
    version_type: game.type || 'release',
    game_directory: inst.path,
    assets_root: path.join(ROOT, 'assets'),
    game_assets: gameAssets || path.join(ROOT, 'assets'),
    assets_index_name: game.assetIndex.id,
    natives_directory: natives,
    launcher_name: 'modion',
    launcher_version: require('../package.json').version,
    classpath: classpath.join(':'),
  };
  const fill = (s) => String(s).replace(/\$\{(\w+)\}/g, (m, k) => (Object.hasOwn(values, k) ? values[k] : ''));
  const expand = (list) => arr(list).flatMap((a) => {
    if (typeof a === 'string') return [fill(a)];
    if (!a || !allowed(a.rules)) return [];
    return (Array.isArray(a.value) ? a.value : [a.value]).filter((v) => typeof v === 'string').map(fill);
  });
  // Up to 1.12.2 the game's own arguments are one line of text, and the Java ones are implied.
  const words = (line) => String(line || '').split(/\s+/).filter(Boolean).map(fill);
  const modern = Boolean(game.arguments);
  const memory = Math.max(2, Math.min(4, Math.floor(os.totalmem() / 2 ** 30 / 2)));
  return [
    `-Xmx${memory}G`, '-Xms512M',
    '-Dlog4j2.formatMsgNoLookups=true',
    ...(logging ? [logging] : []),
    ...(modern ? expand(game.arguments.jvm) : [`-Djava.library.path=${natives}`, '-cp', values.classpath]),
    ...expand(profile && profile.arguments && profile.arguments.jvm),
    (profile && profile.mainClass) || game.mainClass,
    ...(modern ? expand(game.arguments.game) : words(game.minecraftArguments)),
    ...expand(profile && profile.arguments && profile.arguments.game),
  ];
}

// Where the output of a game Modion started itself is written.
const outputLog = (gameDir) => path.join(ROOT, 'logs', `${crypto.createHash('sha1').update(gameDir).digest('hex').slice(0, 12)}.log`);

const running = new Set(); // instance paths being prepared or just started
const live = new Set();    // instance paths whose game, started from here, is still open
// Is the game for this folder being started or running (as far as this session knows)?
const inUse = (gameDir) => running.has(gameDir) || live.has(gameDir);

// session: { name, uuid, token, offline? }. Resolves once the game process has stayed up
// for a few seconds; a crash on startup is reported with the end of its log.
async function launch(inst, session, emit) {
  if (!supports(inst)) throw new ApiError('Modion cannot start this instance directly.', 'UNSUPPORTED');
  if (running.has(inst.path)) throw new ApiError(`"${inst.name}" is already being started.`, 'BUSY');
  running.add(inst.path);
  const job = { id: crypto.randomUUID(), title: inst.name, filename: `Minecraft ${inst.gameVersion}`, saved: true };
  let last = 0;
  const progress = (received, total) => {
    const now = Date.now();
    if (now - last < 100 && received < total) return;
    last = now;
    emit({ ...job, state: 'progress', received, total });
  };
  try {
    let ready;
    try {
      ready = await prepare(inst, progress);
    } finally {
      emit({ ...job, state: 'done' });
    }
    const args = launchArgs(ready, inst, session);
    const logFile = outputLog(inst.path);
    await fsp.mkdir(path.dirname(logFile), { recursive: true });
    const log = fs.openSync(logFile, 'w');
    let child;
    try {
      child = require('child_process').spawn(ready.java, args, { cwd: inst.path, detached: true, stdio: ['ignore', log, log] });
    } finally {
      fs.closeSync(log);
    }
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ up: true }), 6000);
      child.once('error', (e) => { clearTimeout(timer); resolve({ error: e.message }); });
      child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    if (!outcome.up) {
      let tail = '';
      try { tail = (await fsp.readFile(logFile, 'utf8')).trim().split('\n').slice(-4).join(' | ').slice(-400); } catch {}
      throw new ApiError(`Minecraft stopped right after starting (${outcome.error || `exit ${outcome.code ?? outcome.signal}`}). ${tail}`.trim(), 'CRASHED');
    }
    child.unref();
    live.add(inst.path);
    child.once('exit', () => live.delete(inst.path));
    return { label: 'Modion', play: true, pid: child.pid, log: logFile };
  } finally {
    running.delete(inst.path);
  }
}

// The profile ID Minecraft itself gives an offline player of this name.
function offlineSession(name) {
  const h = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  return { name, uuid: h.toString('hex'), token: '0', offline: true };
}

module.exports = { supports, launch, inUse, outputLog, offlineSession, fetchAll, versionJson, ROOT };
