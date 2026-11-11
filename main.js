'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { Store } = require('./src/store');
const { ApiError } = require('./src/http');
const modrinth = require('./src/modrinth');
const curseforge = require('./src/curseforge');
const instances = require('./src/instances');
const content = require('./src/content');
const launcher = require('./src/launcher');
const libraries = require('./src/libraries');
const javas = require('./src/java');
const updater = require('./src/updater');
const { Account, GUID, CLIENT_ID } = require('./src/account');
// The application ID used for sign-in: Modion's own, unless Settings names another.
const clientId = () => store.config.msClientId || CLIENT_ID;
const game = require('./src/game');
const modpack = require('./src/modpack');
const webinstall = require('./src/webinstall');

const INDEX = path.join(__dirname, 'ui', 'index.html');
const sources = { modrinth, curseforge };
const TYPES = Object.keys(content.FOLDER);
// What can be browsed: the kinds of content that go into an instance, and modpacks, which become one.
const BROWSE_TYPES = [...TYPES, 'modpack'];
const LOADERS = ['', 'fabric', 'forge', 'neoforge', 'quilt'];
const SORTS = ['relevance', 'downloads', 'updated', 'newest'];
// Used by dev/smoke.js: render without putting a window on screen.
const HEADLESS = Boolean(process.env.MODION_HEADLESS);

let store, win, account;
// Folders the user was shown by detection or picked in a dialog; only these may become instances.
const offered = new Set();
// Likewise for Java programs: only ones found on this computer or picked in a dialog may be set.
const offeredJava = new Set();
let pendingUpdate = null; // what the last update check found

const emit = (data) => {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('download', data);
};
const ctx = () => ({ store, sources, trash: (p) => shell.trashItem(p) });
const liveWindow = () => (win && !win.isDestroyed() ? win : undefined);

// Looks through the active instance's mods in the background (naming unrecorded files and
// linking them across the two sites), then tells the page what counts as installed.
function refreshInstalled() {
  if (!store || !store.active()) return;
  content.list(ctx(), 'mod').catch(() => {}).then(() => {
    const w = liveWindow();
    if (w && !w.webContents.isDestroyed()) w.webContents.send('installed', content.installedIds(store));
  });
}

/* ---------- everything the page sends is checked here before it is used ---------- */

const text = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, max) : '');
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);

function source(name) {
  if (!Object.hasOwn(sources, name)) throw new ApiError('Unknown source.', 'BAD_SOURCE');
  return sources[name];
}

function id(v, what = 'item') {
  const s = text(v, 80);
  if (!s) throw new ApiError(`No ${what} given.`, 'BAD_REQUEST');
  return s;
}

function contentType(v) {
  if (!TYPES.includes(v)) throw new ApiError('Unknown content type.', 'BAD_TYPE');
  return v;
}

const filter = (a) => ({
  type: oneOf(a.type, BROWSE_TYPES, 'mod'),
  gameVersion: text(a.gameVersion, 32),
  loader: oneOf(a.loader, LOADERS, ''),
});

// Offline launching exists for developing the launch pipeline, so it is locked to the
// developer's own computer: the option only appears where a hash of the system's machine
// ID matches this value. Everywhere else, starting the game directly requires signing in.
const OFFLINE_MACHINE = 'd7fa531aef498fec78dd4c870a3d9929f82345598772a9d5b4957afdc854e254';
const offlineAllowed = (() => {
  try {
    const id = fs.readFileSync('/etc/machine-id', 'utf8').trim();
    return Boolean(id) && crypto.createHash('sha256').update(`modion-offline:${id}`).digest('hex') === OFFLINE_MACHINE;
  } catch {
    return false;
  }
})();
const PLAYER_NAME = /^\w{3,16}$/;

// What Play will do for this instance under the chosen setting. When Modion cannot start
// the instance itself, it falls back to the launcher that owns it, and the label always
// says which it will be. With the account setting and nobody signed in, it asks for that.
function howToLaunch(inst) {
  const mode = store.config.launchMode;
  if (game.supports(inst)) {
    if (mode === 'offline' && offlineAllowed && PLAYER_NAME.test(store.config.offlineName)) {
      return { direct: 'offline', play: true, label: `Modion, offline as ${store.config.offlineName}` };
    }
    if (mode === 'account' && account.status()) return { direct: 'account', play: true, label: `Modion as ${account.status().name}` };
    // Not signed in yet: the Play button's place is taken by a Sign In button.
    if (mode === 'account') return { direct: null, play: false, signIn: true, label: 'Sign in with Microsoft to play' };
  }
  const how = launcher.describe(inst.path);
  return how ? { direct: null, play: how.play, label: how.label } : null;
}

function publicConfig() {
  const { instances: list, activeInstanceId } = store.config;
  return {
    // `launch` says how each instance can be started: { play, label }, or null when it cannot.
    instances: list.map((i) => {
      const how = howToLaunch(i);
      // `movable`: an instance of Modion's own kind, which can be moved to another folder.
      return { ...i, launch: how ? { play: how.play, label: how.label, ...(how.signIn ? { signIn: true } : {}) } : null, movable: Boolean(i.managed && libraries.isOwn(i.home)) };
    }),
    canCreate: store.config.launchMode !== 'prism' || launcher.canCreate(),
    // Folders holding the instances Modion made itself; new ones go into the default one.
    libraries: store.config.libraries.map((dir) => ({
      path: dir,
      isDefault: dir === store.config.newInstanceDir,
      exists: libraries.isDir(dir),
      count: list.filter((i) => i.managed && i.home && path.dirname(i.home) === dir).length,
    })),
    launchMode: store.config.launchMode,
    prismInstalled: launcher.prismInstalled(), // the Prism setting is only offered when it is
    openLogOnLaunch: store.config.openLogOnLaunch,
    checkUpdates: store.config.checkUpdates && !HEADLESS, // the tests do not go looking for releases
    // Whether this copy can replace its own files; otherwise an update is a download from the release page.
    canSelfUpdate: updater.canInstall(__dirname),
    offlineName: store.config.offlineName,
    offlineAllowed,
    msClientId: store.config.msClientId,
    account: account.status(),
    activeInstanceId,
    hasCurseforgeKey: curseforge.hasKey(),
    ownCurseforgeKey: Boolean(store.config.curseforgeKey), // false while the key that came with Modion is in use
    installed: content.installedIds(store),
    version: require('./package.json').version,
  };
}

function cleanInstance(input, base) {
  return {
    ...base,
    name: text(input.name, 80) || path.basename(base.path),
    gameVersion: text(input.gameVersion, 32),
    loader: oneOf(input.loader, LOADERS, ''),
  };
}

// Makes the folders for a new instance. With the Prism setting it becomes a Prism Launcher
// instance; with either "start directly" setting it goes into Modion's own default library.
async function makeInstance(spec) {
  if (store.config.launchMode === 'prism') {
    if (!launcher.canCreate()) {
      throw new ApiError('Prism Launcher was not found on this computer. To have Modion keep and start instances itself, change "Starting the game" in Settings.', 'NO_PRISM');
    }
    return launcher.create(spec);
  }
  if (!game.supports(spec)) throw new ApiError('Modion cannot start that kind of instance itself.', 'UNSUPPORTED');
  await game.versionJson(spec.gameVersion); // fails for a version Mojang does not have
  if (spec.loader) await launcher.loaderBuild(spec.loader, spec.gameVersion); // fails if the loader has no build for this version
  return launcher.createOwn(spec, libraries.usable(store.config.newInstanceDir));
}

function adopt(made, spec) {
  offered.add(made.path);
  const inst = { id: made.id || crypto.randomUUID(), path: made.path, name: made.name, gameVersion: spec.gameVersion, loader: spec.loader, managed: true, home: made.home };
  store.config.instances.push(inst);
  store.config.activeInstanceId = inst.id;
  store.saveConfig();
  return inst;
}

// An instance Modion made: one of its own kind (wherever it was moved to), or a Prism
// instance still sitting directly in Prism's instances folder.
function managed(idValue) {
  const inst = store.instance(idValue);
  if (!inst) throw new ApiError('That instance is no longer in the list.', 'GONE');
  const ok = inst.managed && inst.home && inst.path.startsWith(inst.home + path.sep)
    && (libraries.isOwn(inst.home) || launcher.prismRoots().includes(path.dirname(inst.home)));
  if (!ok) throw new ApiError('Modion only renames and deletes instances it created.', 'NOT_MANAGED');
  return inst;
}

// One of Modion's own instances, which can be moved; refuses while its game is open.
function movable(inst) {
  if (!inst.managed || !libraries.isOwn(inst.home)) throw new ApiError('Only instances Modion keeps itself can be moved. A Prism Launcher instance has to stay in Prism\'s folder.', 'NOT_MANAGED');
  if (game.inUse(inst.path)) throw new ApiError(`"${inst.name}" is running. Close the game before moving it.`, 'BUSY');
  return inst;
}

function relocated(inst, home) {
  inst.home = home;
  inst.path = path.join(home, libraries.GAME);
  offered.add(inst.path);
}

// Reads every library folder and brings the instance list in line with what is there:
// new folders are added, and an instance whose folder turned up somewhere else (the ID
// in its instance.json says which one it is) is followed to its new place.
function indexLibraries() {
  const list = store.config.instances;
  const seen = new Set();
  let changed = false;
  for (const dir of store.config.libraries) {
    for (const f of libraries.scan(dir)) {
      let inst = list.find((i) => i.managed && i.home === f.home);
      if (!inst && typeof f.meta.id === 'string') {
        const same = list.find((i) => i.id === f.meta.id && i.managed && !seen.has(i.id));
        if (same && !libraries.exists(same.home)) { inst = same; relocated(inst, f.home); changed = true; }
      }
      if (!inst) {
        const wanted = typeof f.meta.id === 'string' && /^[\w-]{8,64}$/.test(f.meta.id) && !store.instance(f.meta.id) ? f.meta.id : crypto.randomUUID();
        inst = {
          id: wanted,
          path: f.path,
          name: text(f.meta.name, 80) || path.basename(f.home),
          gameVersion: text(f.meta.gameVersion, 32),
          loader: oneOf(f.meta.loader, LOADERS, ''),
          managed: true,
          home: f.home,
        };
        list.push(inst);
        changed = true;
      }
      seen.add(inst.id);
      if (f.meta.id !== inst.id) { try { libraries.writeMeta(f.home, { ...f.meta, id: inst.id }); } catch {} }
    }
  }
  if (changed) {
    if (!store.active()) store.config.activeInstanceId = list[0] ? list[0].id : null;
    store.saveConfig();
  }
}

function addLibrary(dir) {
  libraries.usable(dir);
  if (!store.config.libraries.includes(dir)) store.config.libraries.push(dir);
}

async function pickFolder(title, defaultPath) {
  const pick = await dialog.showOpenDialog(liveWindow(), { title, defaultPath, properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'] });
  return pick.canceled || !pick.filePaths[0] ? null : path.resolve(pick.filePaths[0]);
}

function knownLibrary(v) {
  const dir = path.resolve(text(v, 4096) || '/nonexistent');
  if (!store.config.libraries.includes(dir)) throw new ApiError('That folder is not one of the instance libraries.', 'GONE');
  return dir;
}

// The app's own data folder was ~/.local/share/modion and held the instances too. It is now
// ModionApp, and the instances have a folder of their own (the default library).
function migrateData() {
  if (process.platform !== 'linux') return; // the old layout only ever existed on Linux
  const old = path.join(path.dirname(libraries.APP_DATA), 'modion');
  try {
    const ours = ['versions', 'libraries', 'assets', 'instances'].some((n) => libraries.isDir(path.join(old, n)));
    if (ours && !libraries.exists(libraries.APP_DATA)) fs.renameSync(old, libraries.APP_DATA);
  } catch (e) {
    console.error('Could not rename the data folder:', e.message);
    return;
  }
  const from = path.join(libraries.APP_DATA, 'instances');
  let names;
  try { names = fs.readdirSync(from); } catch { return; }
  for (const name of names) {
    const was = path.join(from, name), to = path.join(libraries.DEFAULT, name);
    if (!libraries.isDir(was) || libraries.exists(to)) continue;
    try {
      fs.mkdirSync(libraries.DEFAULT, { recursive: true });
      fs.renameSync(was, to);
    } catch { continue; }
    for (const inst of store.config.instances) {
      if (inst.home === was || inst.home === path.join(old, 'instances', name)) relocated(inst, to);
    }
  }
  try { fs.rmdirSync(from); } catch {} // only if it is empty now
  store.saveConfig();
}

// Makes a new instance from a modpack file: reads what it needs, creates the instance,
// downloads the pack's files into it and copies the pack's own folders over.
async function importPack(file, fallbackName) {
  const pack = modpack.inspect(file);
  let made = null;
  const job = { id: crypto.randomUUID(), title: pack.name, filename: pack.name, saved: true };
  try {
    const spec = { name: text(pack.name, 80) || fallbackName || '', gameVersion: text(pack.gameVersion, 32), loader: oneOf(pack.loader, LOADERS, ''), loaderVersion: text(pack.loaderVersion, 40) };
    // Checked before any folder is made, so a pack that cannot be fetched leaves nothing behind.
    if (pack.kind === 'curseforge' && pack.files.length && !curseforge.hasKey()) {
      throw new ApiError('Importing a CurseForge modpack needs your CurseForge API key. Add it in Settings first.', 'NO_CF_KEY');
    }
    made = await makeInstance(spec);
    const { items, skipped, blocked } = await modpack.downloads(pack, made.path, curseforge);
    await game.fetchAll(items, (received, total) => emit({ ...job, state: 'progress', received, total }));
    const copied = await modpack.unpackOverrides(pack, made.path);
    const inst = adopt(made, spec);
    // Remembered with the instance, so they can be fetched from the website now or later.
    if (blocked.length) { inst.leftOut = blocked; store.saveConfig(); }
    return { config: publicConfig(), id: inst.id, name: inst.name, files: items.length, copied, skipped, leftOut: blocked.length };
  } catch (e) {
    if (made) fs.rmSync(made.home, { recursive: true, force: true }); // only the folder created just above
    throw e;
  } finally {
    pack.zip.close();
    emit({ ...job, state: 'done' });
  }
}

function forget(idValue, { keepRecords } = {}) {
  store.config.instances = store.config.instances.filter((i) => i.id !== idValue);
  if (!keepRecords) delete store.manifest[idValue];
  if (!store.active()) store.config.activeInstanceId = store.config.instances[0] ? store.config.instances[0].id : null;
  store.saveConfig();
  store.saveManifest();
}

// People often pick the "mods" folder itself; the instance is the folder around it.
function gameFolder(dir) {
  return Object.values(content.FOLDER).includes(path.basename(dir)) ? path.dirname(dir) : dir;
}

// A CurseForge key that ships with a packaged copy of Modion: the file curseforge.key next
// to this one. It is never committed (see .gitignore); a key saved in Settings wins over it.
const builtinKey = (() => {
  if (process.env.MODION_HEADLESS) return '';
  try { return fs.readFileSync(path.join(__dirname, 'curseforge.key'), 'utf8').trim().slice(0, 200); } catch { return ''; }
})();
const fallbackKey = () => builtinKey || process.env.CURSEFORGE_API_KEY || '';

const methods = {
  'config.get': () => publicConfig(),

  'config.setCurseforgeKey': async (a) => {
    const next = text(a.key, 200);
    const previous = curseforge.getKey();
    if (next) {
      curseforge.setKey(next);
      try {
        await curseforge.testKey();
      } catch (e) {
        curseforge.setKey(previous);
        throw e;
      }
    }
    curseforge.setKey(next || fallbackKey());
    store.config.curseforgeKey = next;
    store.saveConfig();
    return publicConfig();
  },

  'settings.setCheckUpdates': (a) => {
    store.config.checkUpdates = a.on === true;
    store.saveConfig();
    return publicConfig();
  },

  // Is there a newer Modion? Answers { version, name, notes, page, installable } or null.
  'update.check': async () => {
    const found = await updater.check(require('./package.json').version);
    pendingUpdate = found;
    if (!found) return null;
    return { version: found.version, name: found.name, notes: found.notes, page: found.page, installable: Boolean(found.payload) && updater.canInstall(__dirname) };
  },

  // Installs the update found by the last check, then restarts Modion.
  'update.install': async () => {
    if (!pendingUpdate) throw new ApiError('Check for updates first.', 'BAD_REQUEST');
    if (!updater.canInstall(__dirname)) throw new ApiError('This copy of Modion cannot update itself. Download the new version from the release page.', 'NOT_INSTALLABLE');
    const job = { id: crypto.randomUUID(), title: pendingUpdate.name, filename: `Modion ${pendingUpdate.version}`, saved: true };
    try {
      await updater.install(pendingUpdate, __dirname, { onProgress: (received, total) => emit({ ...job, state: 'progress', received, total }) });
    } finally {
      emit({ ...job, state: 'done' });
    }
    setTimeout(() => { app.relaunch(); app.exit(0); }, 600); // after the answer has reached the page
    return { version: pendingUpdate.version };
  },

  'settings.setOpenLog': (a) => {
    store.config.openLogOnLaunch = a.on === true;
    store.saveConfig();
    return publicConfig();
  },

  // The newest part of an instance's game log, for the Log tab. The page calls this about
  // once a second with where it got to (`source` and `offset`) and receives what is new.
  // Two files can hold the log: the output of a game Modion started itself, and the
  // latest.log that Minecraft writes whichever launcher started it; the fresher one is used.
  'log.read': async (a) => {
    const inst = store.instance(a.id);
    if (!inst) throw new ApiError('That instance is no longer in the list.', 'GONE');
    let pick = null;
    for (const file of [game.outputLog(inst.path), path.join(inst.path, 'logs', 'latest.log')]) {
      try {
        const st = await fs.promises.stat(file);
        if (st.isFile() && (!pick || st.mtimeMs > pick.mtime)) pick = { file, size: st.size, mtime: st.mtimeMs };
      } catch {}
    }
    if (!pick) return { source: '', offset: 0, text: '', reset: Boolean(a.source) };
    const TAIL = 200000, CHUNK = 262144;
    const same = a.source === pick.file && Number.isInteger(a.offset) && a.offset >= 0 && a.offset <= pick.size;
    let offset = same ? a.offset : Math.max(0, pick.size - TAIL); // a new or restarted log is shown from near its end
    const handle = await fs.promises.open(pick.file, 'r');
    let data;
    try {
      const buf = Buffer.alloc(Math.min(CHUNK, pick.size - offset));
      const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
      data = buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    // Hand over whole lines only, so a line (or a multi-byte character) is never cut in half.
    if (!same && offset > 0) {
      const first = data.indexOf(10);
      if (first >= 0) { offset += first + 1; data = data.subarray(first + 1); }
    }
    const last = data.lastIndexOf(10);
    if (last >= 0) data = data.subarray(0, last + 1);
    else if (data.length < CHUNK) data = data.subarray(0, 0); // an unfinished line: wait for the rest
    return { source: pick.file, offset: offset + data.length, text: data.toString('utf8'), reset: !same };
  },

  'settings.setLaunch': (a) => {
    const mode = oneOf(a.mode, ['prism', 'account', 'offline'], 'account');
    if (mode === 'offline' && !offlineAllowed) throw new ApiError('Offline launching is not available on this computer.', 'FORBIDDEN');
    if (mode === 'prism' && store.config.launchMode !== 'prism' && !launcher.prismInstalled()) {
      throw new ApiError('Starting through Prism Launcher is only available when Prism Launcher is installed.', 'NO_PRISM');
    }
    const name = text(a.offlineName, 16);
    if (name && !PLAYER_NAME.test(name)) throw new ApiError('A player name is 3 to 16 letters, digits or underscores.', 'BAD_REQUEST');
    store.config.launchMode = mode;
    if (offlineAllowed) store.config.offlineName = name;
    store.saveConfig();
    return publicConfig();
  },

  // The application (client) ID is an identifier, not a secret.
  'account.setClientId': (a) => {
    const next = text(a.clientId, 60);
    if (next && !GUID.test(next)) throw new ApiError('That is not an application (client) ID. It looks like 00000000-0000-0000-0000-000000000000.', 'BAD_REQUEST');
    const before = clientId();
    store.config.msClientId = next === CLIENT_ID ? '' : next;
    if (clientId() !== before) account.signOut(); // a sign-in belongs to the ID it was made with
    store.saveConfig();
    return publicConfig();
  },
  'account.signIn': async () => { await account.signIn(clientId()); return publicConfig(); },
  'account.cancel': () => { account.cancel(); return publicConfig(); },
  'account.signOut': () => { account.signOut(); return publicConfig(); },

  'meta.gameVersions': () => modrinth.gameVersions(),
  'meta.categories': (a) => source(a.source).categories(oneOf(a.type, BROWSE_TYPES, 'mod')),

  // For a file its author only offers on the website: show that page and wait for the
  // person to download the file there.
  'install.viaWebsite': async (a) => {
    // Normally the selected instance; the left-out files of a pack name theirs.
    const inst = a.instanceId ? store.instance(a.instanceId) : content.activeInstance(store);
    if (!inst) throw new ApiError('That instance is no longer in the list.', 'GONE');
    if (!instances.isDir(inst.path)) throw new ApiError(`The folder for "${inst.name}" no longer exists: ${inst.path}`, 'NO_FOLDER');
    const type = contentType(a.type);
    const projectId = id(a.projectId, 'project');
    const v = await curseforge.getVersion(projectId, id(a.versionId, 'file'));
    if (!v.expected) throw new ApiError('CurseForge did not say which file this is.', 'BAD_REPLY');
    const page = (await curseforge.brief(projectId)).url;
    if (!page) throw new ApiError('CurseForge did not give a page for this project.', 'BAD_REPLY');
    const job = { id: crypto.randomUUID(), title: text(a.title, 200) || v.name, filename: v.expected.filename };
    try {
      const got = await webinstall.open({
        parent: liveWindow(),
        url: `${page.replace(/\/+$/, '')}/files/${encodeURIComponent(v.id)}`,
        title: `Download ${v.expected.filename} from CurseForge`,
        siteHosts: ['curseforge.com'],
        downloadHosts: ['forgecdn.net', 'curseforge.com'],
        expect: v.expected,
        destDir: path.join(inst.path, content.FOLDER[type]),
        onProgress: (received, total) => emit({ ...job, state: 'progress', received, total }),
      });
      await content.adoptFile(ctx(), inst, { source: 'curseforge', projectId, type, title: text(a.title, 200), icon: text(a.icon, 2000) || null }, got.tmp, v);
      emit({ ...job, state: 'done', icon: text(a.icon, 2000) || null });
    } catch (e) {
      emit({ ...job, state: 'error', error: e.message });
      throw e;
    }
    // One fewer on the instance's list of left-out files, if it was one of those.
    if (inst.leftOut) {
      inst.leftOut = inst.leftOut.filter((f) => f.fileId !== String(v.id));
      if (!inst.leftOut.length) delete inst.leftOut;
      store.saveConfig();
    }
    refreshInstalled();
    return { installed_ids: content.installedIds(store), config: publicConfig() };
  },

  // Drops an instance's list of left-out files (the person does not want them).
  'instances.clearLeftOut': (a) => {
    const inst = store.instance(a.id);
    if (!inst) throw new ApiError('That instance is no longer in the list.', 'GONE');
    delete inst.leftOut;
    store.saveConfig();
    return publicConfig();
  },

  // For a modpack its author only offers on the website: show that file's page, wait for
  // the person to download the pack there, then make the instance from it.
  'modpack.installViaWebsite': async (a) => {
    const projectId = id(a.projectId, 'project');
    const v = await curseforge.getVersion(projectId, id(a.versionId, 'file'));
    if (!v.expected) throw new ApiError('CurseForge did not say which file this is.', 'BAD_REPLY');
    const page = (await curseforge.brief(projectId)).url;
    if (!page) throw new ApiError('CurseForge did not give a page for this project.', 'BAD_REPLY');
    const dir = await fs.promises.mkdtemp(path.join(require('os').tmpdir(), 'modion-pack-'));
    const job = { id: crypto.randomUUID(), title: text(a.title, 200) || v.name, filename: v.expected.filename };
    try {
      let got;
      try {
        got = await webinstall.open({
          parent: liveWindow(),
          url: `${page.replace(/\/+$/, '')}/files/${encodeURIComponent(v.id)}`,
          title: `Download ${v.expected.filename} from CurseForge`,
          siteHosts: ['curseforge.com'],
          downloadHosts: ['forgecdn.net', 'curseforge.com'],
          expect: v.expected,
          destDir: dir,
          onProgress: (received, total) => emit({ ...job, state: 'progress', received, total }),
        });
      } finally {
        emit({ ...job, state: 'done', saved: true });
      }
      return await importPack(got.tmp, text(a.title, 80));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true }); // only the temporary folder made just above
    }
  },

  search: (a) => source(a.source).search({
    ...filter(a),
    query: text(a.query, 200),
    sort: oneOf(a.sort, SORTS, 'relevance'),
    categories: (Array.isArray(a.categories) ? a.categories : []).map((c) => text(c, 60)).filter(Boolean).slice(0, 10),
    page: Math.min(Math.max(Math.floor(Number(a.page)) || 0, 0), 100000),
  }),
  project: (a) => source(a.source).project(id(a.id, 'project')),
  versions: (a) => source(a.source).versions(id(a.id, 'project'), filter(a)),

  install: async (a) => {
    source(a.source);
    const result = await content.install(ctx(), {
      source: a.source,
      projectId: id(a.projectId, 'project'),
      versionId: a.versionId ? id(a.versionId, 'file') : null,
      type: contentType(a.type),
      gameVersion: text(a.gameVersion, 32),
      loader: oneOf(a.loader, LOADERS, ''),
      title: text(a.title, 200),
      icon: text(a.icon, 2000) || null,
    }, emit);
    refreshInstalled();
    return { ...result, installed_ids: content.installedIds(store) };
  },

  saveAs: async (a) => {
    source(a.source);
    const req = { source: a.source, projectId: id(a.projectId, 'project'), versionId: id(a.versionId, 'file'), title: text(a.title, 200) };
    const pick = await dialog.showOpenDialog(liveWindow(), {
      title: 'Save file to folder',
      defaultPath: app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (pick.canceled || !pick.filePaths[0]) return null;
    return content.saveTo(ctx(), req, pick.filePaths[0], emit);
  },

  'instances.detect': () => {
    const known = new Set(store.config.instances.map((i) => i.path));
    const found = instances.detect();
    found.forEach((f) => offered.add(f.path));
    return found.map((f) => ({ ...f, added: known.has(f.path) }));
  },

  'instances.pickFolder': async () => {
    const pick = await dialog.showOpenDialog(liveWindow(), {
      title: 'Choose a Minecraft game folder (the one that holds "mods")',
      properties: ['openDirectory', 'showHiddenFiles'],
    });
    if (pick.canceled || !pick.filePaths[0]) return null;
    const dir = gameFolder(path.resolve(pick.filePaths[0]));
    offered.add(dir);
    return dir;
  },

  'instances.add': (a) => {
    const dir = path.resolve(text(a.path, 4096) || '/nonexistent');
    if (!offered.has(dir) || !instances.isDir(dir)) throw new ApiError('That folder is not available.', 'BAD_PATH');
    let inst = store.config.instances.find((i) => i.path === dir);
    if (!inst) {
      inst = cleanInstance(a, { id: crypto.randomUUID(), path: dir });
      store.config.instances.push(inst);
    }
    store.config.activeInstanceId = inst.id;
    store.saveConfig();
    return publicConfig();
  },

  // Makes a new instance (see makeInstance for where) and selects it.
  'instances.create': async (a) => {
    const spec = { name: text(a.name, 80), gameVersion: text(a.gameVersion, 32), loader: oneOf(a.loader, LOADERS, '') };
    adopt(await makeInstance(spec), spec);
    return publicConfig();
  },

  // Creates an instance from a Modrinth .mrpack or a CurseForge modpack zip on this computer.
  'instances.import': async () => {
    const pick = await dialog.showOpenDialog(liveWindow(), {
      title: 'Import a modpack',
      filters: [{ name: 'Modpacks (.mrpack, .zip)', extensions: ['mrpack', 'zip'] }],
      properties: ['openFile'],
    });
    if (pick.canceled || !pick.filePaths[0]) return null;
    return importPack(pick.filePaths[0]);
  },

  // Downloads a modpack from Modrinth or CurseForge and makes a new instance out of it.
  'modpack.install': async (a) => {
    const src = source(a.source);
    const projectId = id(a.projectId, 'project');
    const v = a.versionId
      ? await src.getVersion(projectId, id(a.versionId, 'file'))
      : await src.latest(projectId, { type: 'modpack', gameVersion: text(a.gameVersion, 32), loader: oneOf(a.loader, LOADERS, '') });
    if (!v) throw new ApiError('This modpack has no file for the chosen game version and loader.', 'NO_VERSION');
    if (!v.file) {
      // The page carries on with the website download, the same way as for a single mod.
      throw new ApiError('The author only offers this modpack on the website.', 'BLOCKED', undefined, { versionId: v.id });
    }
    const dir = await fs.promises.mkdtemp(path.join(require('os').tmpdir(), 'modion-pack-'));
    const job = { id: crypto.randomUUID(), title: text(a.title, 200) || v.name, filename: v.file.filename };
    try {
      try {
        await content.download(v.file, dir, (received, total) => emit({ ...job, state: 'progress', received, total }));
      } finally {
        emit({ ...job, state: 'done', saved: true });
      }
      return await importPack(path.join(dir, fs.readdirSync(dir)[0]), text(a.title, 80));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true }); // only the temporary folder made just above
    }
  },

  // Moves one of Modion's own instances into a folder the person picks.
  'instances.move': async (a) => {
    const found = store.instance(a.id);
    if (!found) throw new ApiError('That instance is no longer in the list.', 'GONE');
    const inst = movable(found);
    const dest = await pickFolder(`Move "${inst.name}" into which folder?`, path.dirname(inst.home));
    if (!dest) return null;
    if (dest === path.dirname(inst.home)) throw new ApiError('The instance is already in that folder.', 'BAD_PATH');
    if (libraries.within(inst.home, dest)) throw new ApiError('An instance cannot be moved into itself.', 'BAD_PATH');
    libraries.usable(dest);
    const to = path.join(dest, path.basename(inst.home));
    await libraries.move(inst.home, to);
    relocated(inst, to);
    store.saveConfig();
    return publicConfig();
  },

  'libraries.rescan': () => { indexLibraries(); return publicConfig(); },

  'libraries.add': async () => {
    const dir = await pickFolder('Add a folder of Modion instances');
    if (!dir) return null;
    addLibrary(dir);
    store.saveConfig();
    indexLibraries();
    return publicConfig();
  },

  // Where new instances are created. A folder picked here joins the libraries.
  'libraries.setDefault': async (a) => {
    const dir = a.path ? knownLibrary(a.path) : await pickFolder('Choose where new instances are created', store.config.newInstanceDir);
    if (!dir) return null;
    addLibrary(dir);
    store.config.newInstanceDir = dir;
    store.saveConfig();
    indexLibraries();
    return publicConfig();
  },

  // Stops indexing a folder. Its instances leave the list; nothing on disk is touched.
  'libraries.remove': (a) => {
    const dir = knownLibrary(a.path);
    if (dir === store.config.newInstanceDir) throw new ApiError('New instances are created in this folder. Choose another folder for new instances first.', 'IN_USE');
    store.config.libraries = store.config.libraries.filter((d) => d !== dir);
    // Their records are kept, so adding the folder again brings them back as they were.
    for (const i of store.config.instances.filter((x) => x.managed && x.home && path.dirname(x.home) === dir && libraries.isOwn(x.home))) forget(i.id, { keepRecords: true });
    store.saveConfig();
    return publicConfig();
  },

  // Moves every instance in a library to a new folder, which takes the library's place.
  'libraries.relocate': async (a) => {
    const dir = knownLibrary(a.path);
    const dest = await pickFolder('Move this library and its instances to which folder?', path.dirname(dir));
    if (!dest) return null;
    if (dest === dir) throw new ApiError('That is where the library already is.', 'BAD_PATH');
    if (libraries.within(dir, dest)) throw new ApiError('A library cannot be moved into itself.', 'BAD_PATH');
    libraries.usable(dest);
    indexLibraries();
    const found = libraries.scan(dir);
    // Everything is checked before anything is moved.
    for (const f of found) {
      const inst = store.config.instances.find((i) => i.home === f.home);
      if (inst && game.inUse(inst.path)) throw new ApiError(`"${inst.name}" is running. Close the game before moving its library.`, 'BUSY');
      if (libraries.exists(path.join(dest, path.basename(f.home)))) {
        throw new ApiError(`${dest} already has a folder named "${path.basename(f.home)}". Nothing was moved.`, 'EXISTS');
      }
    }
    const swap = () => {
      store.config.libraries = [...new Set(store.config.libraries.map((d) => (d === dir ? dest : d)))];
      if (store.config.newInstanceDir === dir) store.config.newInstanceDir = dest;
      store.saveConfig();
    };
    let moved = 0;
    try {
      for (const f of found) {
        const to = path.join(dest, path.basename(f.home));
        await libraries.move(f.home, to);
        const inst = store.config.instances.find((i) => i.home === f.home);
        if (inst) relocated(inst, to);
        moved++;
      }
    } catch (e) {
      // Some instances may already be in the new place: keep both folders listed so none is lost from view.
      if (moved) { addLibrary(dest); store.saveConfig(); }
      throw e;
    }
    swap();
    return { config: publicConfig(), moved };
  },

  // What the instance settings screen shows: the saved settings and what there is to choose from.
  'instances.settings': (a) => {
    const inst = store.instance(a.id);
    if (!inst) throw new ApiError('That instance is no longer in the list.', 'GONE');
    const found = javas.detect(game.ROOT);
    found.forEach((j) => offeredJava.add(j.path));
    const how = howToLaunch(inst);
    return {
      settings: { memory: null, jvmArgs: '', env: '', java: '', ...inst.settings },
      javas: found,
      wantedJava: game.wantedJava(inst.gameVersion),
      totalMemory: Math.floor(require('os').totalmem() / 2 ** 20),
      defaultMemory: game.defaultMemory(),
      // The settings only take effect when Modion starts the game itself.
      direct: Boolean(how && how.direct),
      startedBy: how ? how.label : null,
    };
  },

  'instances.pickJava': async () => {
    const pick = await dialog.showOpenDialog(liveWindow(), { title: `Choose the Java program (${javas.EXE})`, properties: ['openFile', 'showHiddenFiles'] });
    if (pick.canceled || !pick.filePaths[0]) return null;
    const found = await javas.probe(path.resolve(pick.filePaths[0]));
    if (!found) throw new ApiError('That file did not answer like a Java program.', 'BAD_JAVA');
    offeredJava.add(found.path);
    return found;
  },

  'instances.setSettings': (a) => {
    const inst = store.instance(a.id);
    if (!inst) throw new ApiError('That instance is no longer in the list.', 'GONE');
    const total = Math.floor(require('os').totalmem() / 2 ** 20);
    const memory = a.memory === null || a.memory === undefined ? null : Math.floor(Number(a.memory));
    if (memory !== null && !(memory >= 512 && memory <= total)) throw new ApiError(`Memory has to be between 512 MB and this computer's ${total} MB.`, 'BAD_REQUEST');
    const java = text(a.java, 4096);
    const kept = inst.settings && inst.settings.java === java;
    if (java && !kept && (!offeredJava.has(java) || !require('./src/platform').isFile(java))) throw new ApiError('That Java is not available.', 'BAD_JAVA');
    const lines = (v, max) => (typeof v === 'string' ? v.replace(/\r/g, '').slice(0, max) : '');
    const env = lines(a.env, 8000);
    const bad = env.split('\n').find((l) => l.trim() && !/^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(l));
    if (bad) throw new ApiError(`Environment variables are written NAME=value, one per line. This line is not: ${bad.slice(0, 60)}`, 'BAD_REQUEST');
    const next = { memory, jvmArgs: lines(a.jvmArgs, 8000).replace(/\n/g, ' ').trim(), env: env.trim(), java };
    if (next.memory === null && !next.jvmArgs && !next.env && !next.java) delete inst.settings;
    else inst.settings = next;
    store.saveConfig();
    return publicConfig();
  },

  'instances.rename': (a) => {
    const inst = managed(a.id);
    const name = launcher.cleanName(text(a.name, 80), inst.gameVersion, inst.loader);
    launcher.rename(inst.home, name);
    inst.name = name;
    store.saveConfig();
    return publicConfig();
  },

  // Moves the whole instance (worlds included) to the trash.
  'instances.delete': async (a) => {
    const inst = managed(a.id);
    if (instances.isDir(inst.home)) {
      try { await shell.trashItem(inst.home); } catch {
        throw new ApiError(`"${inst.name}" could not be moved to the trash. Nothing was deleted.`, 'TRASH');
      }
    }
    forget(inst.id);
    return publicConfig();
  },

  'instances.openFolder': async (a) => {
    const inst = store.instance(a.id);
    if (!inst) throw new ApiError('That instance is no longer in the list.', 'GONE');
    if (!instances.isDir(inst.path)) throw new ApiError(`The folder for "${inst.name}" no longer exists: ${inst.path}`, 'NO_FOLDER');
    const problem = await shell.openPath(inst.path);
    if (problem) throw new ApiError(`Could not open the folder: ${problem}`, 'OPEN');
    return true;
  },

  'instances.launch': async (a) => {
    const inst = store.instance(a.id);
    if (!inst) throw new ApiError('That instance is no longer in the list.', 'GONE');
    if (!instances.isDir(inst.path)) throw new ApiError(`The folder for "${inst.name}" no longer exists: ${inst.path}`, 'NO_FOLDER');
    const how = howToLaunch(inst);
    if (how && how.signIn) throw new ApiError('Sign in with Microsoft first.', 'SIGNED_OUT');
    if (how && how.direct) {
      const session = how.direct === 'account' ? await account.gameSession(clientId()) : game.offlineSession(store.config.offlineName);
      await game.launch(inst, session, emit);
      return { label: 'Modion', play: true };
    }
    return launcher.launch(inst.path);
  },

  'instances.update': (a) => {
    const inst = store.instance(a.id);
    if (!inst) throw new ApiError('That instance is no longer in the list.', 'GONE');
    Object.assign(inst, cleanInstance(a, { id: inst.id, path: inst.path }));
    store.saveConfig();
    return publicConfig();
  },

  // Forgets the instance in Modion only; nothing on disk is touched.
  'instances.remove': (a) => {
    forget(a.id);
    return publicConfig();
  },

  'instances.setActive': (a) => {
    if (!store.instance(a.id)) throw new ApiError('That instance is no longer in the list.', 'GONE');
    store.config.activeInstanceId = a.id;
    store.saveConfig();
    refreshInstalled();
    return publicConfig();
  },

  'library.list': (a) => content.list(ctx(), contentType(a.type)),
  'library.toggle': (a) => content.toggle(ctx(), contentType(a.type), a.file),
  'library.remove': (a) => content.remove(ctx(), contentType(a.type), a.file),
  'library.openFolder': async (a) => {
    const inst = store.active();
    if (!inst) throw new ApiError('No instance selected.', 'NO_INSTANCE');
    const dir = path.join(inst.path, content.FOLDER[contentType(a.type)]);
    const target = [dir, inst.path].find((p) => instances.isDir(p));
    if (!target) throw new ApiError(`The folder for "${inst.name}" no longer exists: ${inst.path}`, 'NO_FOLDER');
    const problem = await shell.openPath(target);
    if (problem) throw new ApiError(`Could not open the folder: ${problem}`, 'OPEN');
    return true;
  },

  openExternal: async (a) => {
    let u;
    try { u = new URL(text(a.url, 4096)); } catch { throw new ApiError('That link is not valid.', 'BAD_URL'); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ApiError('Only web links can be opened.', 'BAD_URL');
    await shell.openExternal(u.href);
    return true;
  },
};

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: !HEADLESS,
    backgroundColor: '#313131',
    title: 'Modion',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      offscreen: HEADLESS,
    },
  });
  // Mod pages are untrusted content: the window never navigates or opens popups.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => { win = null; });
  win.webContents.once('did-finish-load', refreshInstalled);
  win.loadFile(INDEX);
  return win;
}

// The app was called Modstone at first; carry its settings over once.
function adoptLegacySettings(dir) {
  const legacy = path.join(path.dirname(dir), 'Modstone');
  for (const name of ['config.json', 'manifest.json']) {
    const from = path.join(legacy, name), to = path.join(dir, name);
    try {
      if (!fs.existsSync(to) && fs.existsSync(from)) {
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(from, to);
        fs.chmodSync(to, 0o600);
      }
    } catch {}
  }
}

if (process.platform === 'linux') app.setDesktopName('modion.desktop');

// Two copies would overwrite each other's settings, so a second launch just raises the first.
const first = HEADLESS || app.requestSingleInstanceLock();
if (!first) app.quit();
app.on('second-instance', () => {
  const w = liveWindow();
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
});

const ready = !first ? Promise.resolve(null) : app.whenReady().then(() => {
  const dir = app.getPath('userData');
  adoptLegacySettings(dir);
  store = new Store(dir, libraries.DEFAULT);
  migrateData();
  indexLibraries();
  const keyring = safeStorage.isEncryptionAvailable();
  account = new Account({
    dir,
    openExternal: (target) => shell.openExternal(target),
    seal: keyring ? (s) => safeStorage.encryptString(s).toString('base64') : null,
    open: keyring ? (s) => safeStorage.decryptString(Buffer.from(s, 'base64')) : null,
  });
  curseforge.setKey(store.config.curseforgeKey || fallbackKey());
  Menu.setApplicationMenu(null);

  ipcMain.handle('modion', async (event, method, args) => {
    try {
      // Only the app's own page, in the app's own window, may call in.
      const w = liveWindow();
      if (!w || event.sender !== w.webContents || event.senderFrame !== w.webContents.mainFrame) {
        throw new ApiError('Untrusted caller.', 'FORBIDDEN');
      }
      if (typeof method !== 'string' || !Object.hasOwn(methods, method)) throw new ApiError('Unknown request.', 'BAD_METHOD');
      const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
      return { ok: true, data: await methods[method](input) };
    } catch (e) {
      if (!(e instanceof ApiError)) console.error(`[${method}]`, e);
      return { ok: false, error: (e && e.message) || String(e), code: (e && e.code) || 'ERROR', detail: e instanceof ApiError ? e.detail : undefined };
    }
  });

  return createWindow();
}).catch((e) => {
  console.error(e);
  dialog.showErrorBox('Modion could not start', (e && e.message) || String(e));
  app.exit(1);
  return null;
});

app.on('will-quit', () => { content.discardPartials(); webinstall.cancel(); if (account) account.cancel(); });
app.on('window-all-closed', () => app.quit());

module.exports = { ready };
