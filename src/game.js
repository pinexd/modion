'use strict';
// Starting Minecraft directly: fetches the game, its libraries, assets and a matching Java
// from Mojang's own servers into a shared folder, builds the launch command from the
// version's metadata, and runs it in the instance's game folder.
//
// Covers vanilla, Fabric and Quilt on Minecraft 1.19 and newer. Older versions (which need
// native libraries unpacked) and Forge/NeoForge (which need their installers run) are not
// handled here and keep going through the launcher that owns the instance.

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { getJson, ApiError, arr } = require('./http');
const { download } = require('./content');

const ROOT = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'modion');
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
    else if (f.type === 'file' && f.downloads && f.downloads.raw) {
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

// Everything needed to start this instance, downloading what is missing.
async function prepare(inst, progress) {
  if (process.arch !== 'x64') throw new ApiError('Direct launching is only set up for 64-bit Intel/AMD Linux so far.', 'UNSUPPORTED');
  const game = await versionJson(inst.gameVersion);
  if (!game.arguments || !game.downloads || !game.downloads.client || !game.assetIndex) {
    throw new ApiError(`Minecraft ${inst.gameVersion} is too old for Modion to start directly (1.19 and newer work).`, 'UNSUPPORTED');
  }
  const profile = inst.loader ? await loaderProfile(inst.loader, inst.gameVersion) : null;

  const libDir = path.join(ROOT, 'libraries');
  const libs = new Map(); // "group:artifact[:classifier]" -> item; the loader's choice of a library wins
  const add = (name, item) => { const [g, a, , c] = String(name).split(':'); const key = `${g}:${a}${c ? `:${c}` : ''}`; if (!libs.has(key)) libs.set(key, item); };
  for (const lib of arr(profile && profile.libraries)) {
    if (!lib || !lib.name) continue;
    const rel = mavenPath(lib.name);
    const full = inside(libDir, rel);
    add(lib.name, { url: String(lib.url || 'https://libraries.minecraft.net/').replace(/\/?$/, '/') + rel, sha1: lib.sha1, size: lib.size, dir: path.dirname(full), filename: path.basename(full) });
  }
  for (const lib of arr(game.libraries)) {
    if (!lib || !allowed(lib.rules)) continue;
    if (lib.natives) throw new ApiError(`Minecraft ${inst.gameVersion} is too old for Modion to start directly (1.19 and newer work).`, 'UNSUPPORTED');
    const a = lib.downloads && lib.downloads.artifact;
    if (!a || !a.url || !a.path) continue;
    const full = inside(libDir, a.path);
    add(lib.name, { url: a.url, sha1: a.sha1, size: a.size, dir: path.dirname(full), filename: path.basename(full) });
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
  await fetchAll([client, ...libs.values(), ...assets.values()], progress);

  const classpath = [...[...libs.values()].map((l) => path.join(l.dir, l.filename)), path.join(versionDir, client.filename)];
  return { game, profile, java, classpath };
}

function launchArgs({ game, profile, classpath }, inst, session) {
  const natives = path.join(ROOT, 'natives', crypto.createHash('sha1').update(inst.path).digest('hex').slice(0, 12));
  fs.mkdirSync(natives, { recursive: true });
  const values = {
    auth_player_name: session.name,
    auth_uuid: session.uuid,
    auth_access_token: session.token,
    auth_xuid: '',
    clientid: '',
    user_type: session.offline ? 'legacy' : 'msa',
    user_properties: '{}',
    version_name: inst.gameVersion,
    version_type: game.type || 'release',
    game_directory: inst.path,
    assets_root: path.join(ROOT, 'assets'),
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
  const memory = Math.max(2, Math.min(4, Math.floor(os.totalmem() / 2 ** 30 / 2)));
  return [
    `-Xmx${memory}G`, '-Xms512M',
    ...expand(game.arguments.jvm),
    ...expand(profile && profile.arguments && profile.arguments.jvm),
    (profile && profile.mainClass) || game.mainClass,
    ...expand(game.arguments.game),
    ...expand(profile && profile.arguments && profile.arguments.game),
  ];
}

const running = new Set(); // instance paths being prepared or just started

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
    const logFile = path.join(ROOT, 'logs', `${crypto.createHash('sha1').update(inst.path).digest('hex').slice(0, 12)}.log`);
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

module.exports = { supports, launch, offlineSession, ROOT };
