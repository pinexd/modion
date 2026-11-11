'use strict';
// Downloading into an instance, and managing what is already in one.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { ApiError, UA } = require('./http');

const FOLDER = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks', datapack: 'datapacks' };
const OFF = '.disabled';
const STALL_MS = 60000; // a download is abandoned after this long without receiving anything

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const exists = (p) => fs.existsSync(p) || fs.existsSync(p + OFF);

function safeName(name) {
  // Control characters go everywhere; the characters Windows forbids in names go there too.
  const base = path.basename(String(name || '').replace(/\\/g, '/')).replace(/[\0-\x1f]/g, '')
    .replace(process.platform === 'win32' ? /[<>:"|?*]/g : /(?!)/g, '_');
  if (!base || base === '.' || base === '..') throw new ApiError('Refusing an unsafe file name.', 'BAD_NAME');
  return base;
}

function folderFor(type) {
  if (!Object.hasOwn(FOLDER, type)) throw new ApiError('Unknown content type.', 'BAD_TYPE');
  return FOLDER[type];
}

function pickSource(sources, name) {
  if (!Object.hasOwn(sources, name)) throw new ApiError('Unknown source.', 'BAD_SOURCE');
  return sources[name];
}

function activeInstance(store) {
  const inst = store.active();
  if (!inst) throw new ApiError('Pick an instance first.', 'NO_INSTANCE');
  // Never recreate a game folder that a launcher has since deleted.
  if (!isDir(inst.path)) throw new ApiError(`The folder for "${inst.name}" no longer exists: ${inst.path}`, 'NO_FOLDER');
  return inst;
}

function fsProblem(e, what) {
  if (e instanceof ApiError) return e;
  const reasons = { ENOSPC: 'the disk is full', EACCES: 'permission was denied', EPERM: 'permission was denied', EROFS: 'the disk is read-only', EDQUOT: 'the disk quota is used up' };
  return new ApiError(`${what}: ${reasons[e.code] || e.code || e.message}.`, 'FS');
}

// Installs change files and the manifest in several awaited steps, so they run one at a
// time. Two installs that share a dependency would otherwise both download it at once.
let queue = Promise.resolve();
function exclusive(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

// Temporary files of downloads in flight, so they can be removed if the app quits mid-way.
const partials = new Set();
function discardPartials() {
  for (const p of partials) { try { fs.unlinkSync(p); } catch {} }
  partials.clear();
}

async function download(file, destDir, onProgress = () => {}) {
  let url;
  try { url = new URL(file.url); } catch { throw new ApiError('The download link is not valid.', 'BAD_URL'); }
  if (url.protocol !== 'https:') throw new ApiError('Refusing a non-HTTPS download.', 'BAD_URL');
  const name = safeName(file.filename);
  const dest = path.join(destDir, name);
  // Unique per attempt: concurrent downloads of the same file never share a temp file.
  const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.part`;

  const abort = new AbortController();
  let timer = null;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => abort.abort(), STALL_MS); };
  const netProblem = () => new ApiError(
    abort.signal.aborted ? `Download stalled: ${url.hostname} stopped responding.` : `Download failed: lost the connection to ${url.hostname}.`, 'NETWORK');

  let handle = null;
  let received = 0;
  partials.add(tmp);
  try {
    try { await fsp.mkdir(destDir, { recursive: true }); } catch (e) { throw fsProblem(e, `Could not create ${destDir}`); }

    arm();
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA }, signal: abort.signal });
    } catch {
      throw netProblem();
    }
    if (!res.ok || !res.body) throw new ApiError(`Download failed: ${url.hostname} answered ${res.status}.`, 'HTTP', res.status);
    if (res.url && !res.url.startsWith('https:')) throw new ApiError('Refusing a download that was redirected off HTTPS.', 'BAD_URL');

    const declared = res.headers.get('content-encoding') ? 0 : Number(res.headers.get('content-length')) || 0;
    const total = declared || file.size || 0;
    const expected = String(file.sha512 || file.sha1 || '').toLowerCase();
    const hash = crypto.createHash(file.sha512 ? 'sha512' : 'sha1');

    try { handle = await fsp.open(tmp, 'w'); } catch (e) { throw fsProblem(e, `Could not write to ${destDir}`); }
    const body = res.body[Symbol.asyncIterator]();
    let last = 0;
    for (;;) {
      let step;
      try { step = await body.next(); } catch { throw netProblem(); }
      if (step.done) break;
      arm();
      hash.update(step.value);
      received += step.value.length;
      try { await handle.writeFile(step.value); } catch (e) { throw fsProblem(e, `Could not write ${name}`); }
      const now = Date.now();
      if (now - last > 80) { last = now; onProgress(received, total); }
    }
    clearTimeout(timer);
    await handle.close();
    handle = null;

    if (!received) throw new ApiError(`${name} arrived empty and was discarded.`, 'EMPTY');
    if (expected) {
      if (hash.digest('hex') !== expected) throw new ApiError(`${name} failed its checksum and was discarded.`, 'CHECKSUM');
    } else if (declared && received !== declared) {
      throw new ApiError(`${name} arrived incomplete and was discarded.`, 'TRUNCATED');
    }
    try { await fsp.rename(tmp, dest); } catch (e) { throw fsProblem(e, `Could not save ${name}`); }
  } catch (e) {
    abort.abort(); // drop the connection if it is still open
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  } finally {
    clearTimeout(timer);
    partials.delete(tmp);
  }
  onProgress(received, received);
  return name;
}

const hashCache = new Map();
function sha1File(file, size, mtime) {
  const id = `${file}|${size}|${mtime}`;
  if (hashCache.has(id)) return Promise.resolve(hashCache.get(id));
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => { const hex = h.digest('hex'); hashCache.set(id, hex); resolve(hex); })
      .on('error', reject);
  });
}

// CurseForge identifies files by a MurmurHash2 (seed 1) of their bytes with whitespace removed.
const printCache = new Map();
async function fingerprintFile(file, size, mtime) {
  const id = `${file}|${size}|${mtime}`;
  if (printCache.has(id)) return printCache.get(id);
  if (size > 256 * 2 ** 20) return null;
  const raw = await fsp.readFile(file);
  const data = Buffer.allocUnsafe(raw.length);
  let n = 0;
  for (const b of raw) if (b !== 9 && b !== 10 && b !== 13 && b !== 32) data[n++] = b;
  const m = 0x5bd1e995;
  let h = (1 ^ n) >>> 0, i = 0;
  for (; i + 4 <= n; i += 4) {
    let k = data.readUInt32LE(i);
    k = Math.imul(k, m); k ^= k >>> 24; k = Math.imul(k, m);
    h = Math.imul(h, m) ^ k;
  }
  if (n - i === 3) h ^= data[i + 2] << 16;
  if (n - i >= 2) h ^= data[i + 1] << 8;
  if (n - i >= 1) { h ^= data[i]; h = Math.imul(h, m); }
  h ^= h >>> 13; h = Math.imul(h, m); h ^= h >>> 15;
  const print = h >>> 0;
  printCache.set(id, print);
  return print;
}

// Reads one content folder and brings the manifest in line with it: forgets entries whose
// files are gone and asks Modrinth (by hash) what the files nobody recorded are.
// Runs concurrently with installs, so it re-checks before every write to the manifest.
async function scan({ store, sources }, inst, type) {
  const folder = folderFor(type);
  const dir = path.join(inst.path, folder);
  const tracked = () => (store.instance(inst.id) ? store.entries(inst.id) : null); // null once the instance is forgotten

  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch (e) {
    if (e.code !== 'ENOENT') throw fsProblem(e, `Could not read ${dir}`);
  }
  const files = [];
  for (const file of names) {
    const enabled = !file.endsWith(OFF);
    const name = enabled ? file : file.slice(0, -OFF.length);
    if (!/\.(jar|zip)$/i.test(name)) continue;
    let st;
    try { st = await fsp.stat(path.join(dir, file)); } catch { continue; } // vanished, or a dangling link
    if (!st.isFile()) continue;
    files.push({ file, name, enabled, size: st.size, mtime: st.mtimeMs, key: `${folder}/${name}` });
  }

  let entries = tracked();
  if (!entries) return { dir, files };
  let dirty = false;

  for (const key of Object.keys(entries)) {
    // Checked against the disk, not the listing above: an install may have added the file since.
    if (key.startsWith(folder + '/') && !exists(path.join(inst.path, key))) { delete entries[key]; dirty = true; }
  }

  const unknown = [];
  for (const f of files) {
    const e = entries[f.key];
    if (e && !e.unknown && e.size === undefined) { e.size = f.size; e.mtime = f.mtime; dirty = true; continue; } // recorded before sizes were kept
    if (!e || e.size !== f.size || e.mtime !== f.mtime) unknown.push(f);
  }

  if (unknown.length) {
    const byHash = new Map(); // identical files share a hash
    for (const f of unknown) {
      let hash;
      try { hash = await sha1File(path.join(dir, f.file), f.size, f.mtime); } catch { continue; }
      if (!byHash.has(hash)) byHash.set(hash, []);
      byHash.get(hash).push(f);
    }
    let found = null;
    try { found = await sources.modrinth.identify([...byHash.keys()]); } catch {} // offline: try again next time
    entries = tracked();
    if (found && entries) {
      for (const [hash, group] of byHash) {
        for (const f of group) {
          const now = entries[f.key];
          if (now && now.size === f.size && now.mtime === f.mtime) continue; // an install recorded it meanwhile
          entries[f.key] = found[hash]
            ? { ...found[hash], type, size: f.size, mtime: f.mtime }
            : { unknown: true, size: f.size, mtime: f.mtime };
          dirty = true;
        }
      }
    }
  }
  // Files Modrinth does not know may be CurseForge-only (most of a CurseForge modpack is).
  // CurseForge is asked once per file, and again if the file changes; without a key, later.
  entries = tracked();
  if (entries && sources.curseforge && sources.curseforge.hasKey()) {
    const strangers = files.filter((f) => { const e = entries[f.key]; return e && e.unknown && !e.askedCurseforge && e.size === f.size && e.mtime === f.mtime; });
    if (strangers.length) {
      try {
        const prints = new Map();
        for (const f of strangers) {
          const print = await fingerprintFile(path.join(dir, f.file), f.size, f.mtime);
          if (print !== null) prints.set(f, print);
        }
        const found = await sources.curseforge.identify([...new Set(prints.values())]);
        entries = tracked();
        for (const f of entries ? strangers : []) {
          const now = entries[f.key];
          if (!now || !now.unknown || now.size !== f.size || now.mtime !== f.mtime) continue; // changed meanwhile
          const hit = found[prints.get(f)];
          entries[f.key] = hit ? { ...hit, type, size: f.size, mtime: f.mtime, linkedCurseforge: true } : { ...now, askedCurseforge: true };
          dirty = true;
        }
      } catch {} // offline or refused: asked again next time
    }
  }

  // Cross-links: the same file usually exists on the other site too. Recording that project
  // lets a mod installed from Modrinth show as installed on CurseForge, and the reverse.
  // Each lookup is tried until it gets an answer (it is skipped while offline or without a key).
  entries = tracked();
  if (entries) {
    const known = files.map((f) => ({ f, e: entries[f.key] }))
      .filter(({ f, e }) => e && !e.unknown && e.projectId && e.size === f.size && e.mtime === f.mtime);
    const forModrinth = known.filter(({ e }) => e.source !== 'modrinth' && !e.linkedModrinth);
    const cf = sources.curseforge;
    const forCurseforge = cf && cf.hasKey() ? known.filter(({ e }) => e.source !== 'curseforge' && !e.linkedCurseforge) : [];
    if (forModrinth.length) {
      try {
        const hashes = new Map();
        for (const x of forModrinth) hashes.set(x, await sha1File(path.join(dir, x.f.file), x.f.size, x.f.mtime));
        const found = await sources.modrinth.identify([...new Set(hashes.values())]);
        for (const [x, hash] of hashes) {
          if (found[hash]) x.e.also = { ...x.e.also, modrinth: found[hash].projectId };
          x.e.linkedModrinth = true;
        }
        dirty = true;
      } catch {}
    }
    if (forCurseforge.length) {
      try {
        const prints = new Map();
        for (const x of forCurseforge) {
          const print = await fingerprintFile(path.join(dir, x.f.file), x.f.size, x.f.mtime);
          if (print !== null) prints.set(x, print);
        }
        const found = await cf.fingerprints([...new Set(prints.values())]);
        for (const [x, print] of prints) {
          if (found[print]) x.e.also = { ...x.e.also, curseforge: found[print] };
          x.e.linkedCurseforge = true;
        }
        dirty = true;
      } catch {}
    }
  }
  if (dirty && tracked()) store.saveManifest();
  return { dir, files };
}

// Installs one project (plus its required dependencies, for mods) into the active instance.
function install(ctx, req, emit) {
  return exclusive(() => installNow(ctx, req || {}, emit));
}

async function installNow(ctx, req, emit) {
  const { store, sources, trash } = ctx;
  const inst = activeInstance(store);
  const api = pickSource(sources, req.source);
  const folder = folderFor(req.type);
  const dir = path.join(inst.path, folder);
  if (req.projectId === undefined || req.projectId === null || req.projectId === '') throw new ApiError('No project to install.', 'BAD_REQUEST');
  const tracked = () => (store.instance(inst.id) ? store.entries(inst.id) : null);
  const want = { type: req.type, gameVersion: req.gameVersion || '', loader: req.loader || '' };
  const seen = new Set();
  const result = { installed: [], skipped: [] };

  // Learn what is already in the folder (including files other launchers put there), so an
  // existing copy of a project is replaced rather than joined by a second one.
  await scan(ctx, inst, req.type).catch(() => {});

  // Gets a superseded file out of the game's way: to the trash, or failing that, disabled.
  async function retire(file, title) {
    if (!fs.existsSync(file)) return;
    try {
      await trash(file);
    } catch {
      if (!file.endsWith(OFF) && !fs.existsSync(file + OFF)) await fsp.rename(file, file + OFF).catch(() => {});
      result.skipped.push({ title, reason: `the old file ${path.basename(file)} could not be moved to the trash${file.endsWith(OFF) ? '' : ', so it was disabled instead'}` });
    }
  }

  async function one(projectId, versionId, meta, isDep, opts) {
    projectId = String(projectId);
    if (seen.has(projectId)) return;
    seen.add(projectId);
    const before = tracked() || {};
    const prior = Object.entries(before).find(([key, e]) =>
      key.startsWith(folder + '/') && e.source === req.source && String(e.projectId) === projectId);
    if (isDep && prior && exists(path.join(inst.path, prior[0]))) return;

    const v = versionId ? await api.getVersion(projectId, versionId) : await api.latest(projectId, opts);
    if (!meta || !meta.title) meta = await api.brief(projectId).catch(() => ({ title: v ? v.name : projectId, icon: null }));
    if (!v) {
      const target = [opts.gameVersion, opts.loader].filter(Boolean).join(' ') || 'this instance';
      throw new ApiError(`${meta.title} has no file for ${target}.`, 'NO_VERSION');
    }
    if (!v.file) {
      throw new ApiError(`${meta.title}: the author only allows downloads from the CurseForge website.`, 'BLOCKED', undefined,
        isDep ? undefined : { projectId, versionId: v.id });
    }

    const base = { id: crypto.randomUUID(), title: meta.title, filename: v.file.filename };
    emit({ ...base, state: 'progress', received: 0, total: v.file.size || 0 });
    let filename;
    try {
      filename = await download(v.file, dir, (received, total) => emit({ ...base, state: 'progress', received, total }));
    } catch (e) {
      emit({ ...base, state: 'error', error: e.message });
      throw e;
    }
    emit({ ...base, state: 'done', icon: meta.icon || null });

    const key = `${folder}/${filename}`;
    const dest = path.join(dir, filename);
    // A disabled copy under the same name would shadow the new file in the library.
    await retire(dest + OFF, meta.title);
    if (prior && prior[0] !== key) {
      // A different file from the same project is an older version: the game must not load both.
      await retire(path.join(inst.path, prior[0]), meta.title);
      await retire(path.join(inst.path, prior[0]) + OFF, meta.title);
    }
    const entries = tracked();
    if (entries) {
      if (prior && prior[0] !== key && !exists(path.join(inst.path, prior[0]))) delete entries[prior[0]];
      let st = null;
      try { st = await fsp.stat(dest); } catch {}
      entries[key] = {
        source: req.source, projectId, versionId: v.id, versionName: v.versionNumber || v.name,
        title: meta.title, icon: meta.icon || null, type: req.type,
        ...(st ? { size: st.size, mtime: st.mtimeMs } : {}),
      };
      store.saveManifest();
    }
    result.installed.push({ title: meta.title, filename, dependency: isDep });

    if (req.type !== 'mod') return;
    // Dependencies must fit the file that needs them. Normally that is the instance's own
    // version and loader; if the user hand-picked a file for something else, follow the file.
    const depOpts = {
      type: req.type,
      gameVersion: v.gameVersions.includes(opts.gameVersion) ? opts.gameVersion : v.gameVersions[v.gameVersions.length - 1] || opts.gameVersion,
      loader: v.loaders.includes(opts.loader) ? opts.loader : v.loaders[0] || opts.loader,
    };
    for (const dep of v.dependencies) {
      let name = 'A required dependency';
      try {
        let pid = dep.projectId;
        if (!pid && dep.versionId) pid = (await api.getVersion(null, dep.versionId)).projectId;
        if (!pid) continue;
        const depMeta = await api.brief(pid).catch(() => null);
        if (depMeta) name = depMeta.title;
        await one(pid, dep.versionId, depMeta, true, depOpts);
      } catch (e) {
        result.skipped.push({ title: name, reason: e.message });
      }
    }
  }

  await one(req.projectId, req.versionId || null, req.title ? { title: String(req.title), icon: req.icon || null } : null, false, want);
  return result;
}

// Takes over a file that was downloaded by hand from the website (see webinstall.js):
// moves it into place and records it exactly as an install would.
function adoptFile({ store, trash }, inst, req, tmp, v) {
  return exclusive(async () => {
    const folder = folderFor(req.type);
    const filename = safeName(v.expected.filename);
    const dest = path.join(inst.path, folder, filename);
    const key = `${folder}/${filename}`;
    const projectId = String(req.projectId);
    const bin = async (p) => {
      if (!fs.existsSync(p)) return;
      try { await trash(p); } catch {
        if (!p.endsWith(OFF) && !fs.existsSync(p + OFF)) await fsp.rename(p, p + OFF).catch(() => {});
      }
    };
    try { await fsp.rename(tmp, dest); } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw fsProblem(e, `Could not save ${filename}`);
    }
    await bin(dest + OFF);
    const entries = store.instance(inst.id) ? store.entries(inst.id) : null;
    if (!entries) return filename;
    const prior = Object.entries(entries).find(([k, e]) => k.startsWith(folder + '/') && e.source === req.source && String(e.projectId) === projectId);
    if (prior && prior[0] !== key) {
      await bin(path.join(inst.path, prior[0]));
      await bin(path.join(inst.path, prior[0]) + OFF);
      if (!exists(path.join(inst.path, prior[0]))) delete entries[prior[0]];
    }
    let st = null;
    try { st = await fsp.stat(dest); } catch {}
    entries[key] = {
      source: req.source, projectId, versionId: v.id, versionName: v.versionNumber || v.name,
      title: req.title || v.name, icon: req.icon || null, type: req.type,
      ...(st ? { size: st.size, mtime: st.mtimeMs } : {}),
    };
    store.saveManifest();
    return filename;
  });
}

// "Save As": one file into a folder of the user's choosing; nothing is tracked.
async function saveTo({ sources }, req, destDir, emit) {
  const api = pickSource(sources, req.source);
  if (!req.versionId) throw new ApiError('No file to save.', 'BAD_REQUEST');
  const v = await api.getVersion(req.projectId, req.versionId);
  if (!v.file) throw new ApiError('The author only allows downloads from the CurseForge website.', 'BLOCKED');
  const base = { id: crypto.randomUUID(), title: req.title || v.name, filename: v.file.filename, saved: true };
  try {
    const filename = await download(v.file, destDir, (received, total) => emit({ ...base, state: 'progress', received, total }));
    emit({ ...base, state: 'done' });
    return { filename, dir: destDir };
  } catch (e) {
    emit({ ...base, state: 'error', error: e.message });
    throw e;
  }
}

async function list(ctx, type) {
  const { store } = ctx;
  const inst = activeInstance(store);
  const { dir, files } = await scan(ctx, inst, type);
  const entries = store.instance(inst.id) ? store.entries(inst.id) : {};
  const label = (f) => { const e = entries[f.key]; return (e && !e.unknown && e.title) || f.name; };
  return {
    dir,
    files: files
      .map((f) => {
        const e = entries[f.key];
        return { file: f.file, name: f.name, enabled: f.enabled, size: f.size, meta: e && !e.unknown && e.projectId ? e : null, sort: label(f) };
      })
      .sort((a, b) => a.sort.localeCompare(b.sort, undefined, { sensitivity: 'base' }) || a.file.localeCompare(b.file))
      .map(({ sort, ...f }) => f),
  };
}

function resolveFile(store, type, file) {
  const inst = activeInstance(store);
  const folder = folderFor(type);
  const name = safeName(file);
  const full = path.join(inst.path, folder, name);
  let st = null;
  try { st = fs.statSync(full); } catch {}
  if (!st || !st.isFile()) throw new ApiError(`${name} is no longer there.`, 'GONE');
  return { inst, folder, name, full };
}

async function toggle({ store }, type, file) {
  const { name, full } = resolveFile(store, type, file);
  const next = name.endsWith(OFF) ? full.slice(0, -OFF.length) : full + OFF;
  if (fs.existsSync(next)) throw new ApiError(`Cannot ${name.endsWith(OFF) ? 'enable' : 'disable'} ${name}: a file named ${path.basename(next)} is in the way.`, 'EXISTS');
  try { await fsp.rename(full, next); } catch (e) { throw fsProblem(e, `Could not rename ${name}`); }
  return true;
}

async function remove({ store, trash }, type, file) {
  const { inst, folder, name, full } = resolveFile(store, type, file);
  try {
    await trash(full);
  } catch {
    throw new ApiError(`${name} could not be moved to the trash. Use "Open Folder" to delete it by hand.`, 'TRASH');
  }
  const key = `${folder}/${name.endsWith(OFF) ? name.slice(0, -OFF.length) : name}`;
  // Keep the record if a twin (enabled/disabled copy under the same name) is still there.
  if (store.instance(inst.id) && !exists(path.join(inst.path, key))) {
    delete store.entries(inst.id)[key];
    store.saveManifest();
  }
  return true;
}

// What the active instance has installed, as { "source:projectId": versionId }, for files still on disk.
function installedIds(store) {
  const inst = store.active();
  const out = {};
  if (!inst) return out;
  for (const [key, e] of Object.entries(store.entries(inst.id))) {
    if (!e.projectId || !exists(path.join(inst.path, key))) continue;
    out[`${e.source}:${e.projectId}`] = e.versionId;
    // The same file's project on the other site counts as installed too (version unknown there).
    for (const [site, id] of Object.entries(e.also || {})) {
      if (id && !Object.hasOwn(out, `${site}:${id}`)) out[`${site}:${id}`] = null;
    }
  }
  return out;
}

module.exports = { download, install, adoptFile, activeInstance, saveTo, list, toggle, remove, installedIds, discardPartials, FOLDER };
