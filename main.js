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
const { Account, GUID } = require('./src/account');
const game = require('./src/game');
const modpack = require('./src/modpack');
const webinstall = require('./src/webinstall');

const INDEX = path.join(__dirname, 'ui', 'index.html');
const sources = { modrinth, curseforge };
const TYPES = Object.keys(content.FOLDER);
const LOADERS = ['', 'fabric', 'forge', 'neoforge', 'quilt'];
const SORTS = ['relevance', 'downloads', 'updated', 'newest'];
// Used by dev/smoke.js: render without putting a window on screen.
const HEADLESS = Boolean(process.env.MODION_HEADLESS);

let store, win, account;
// Folders the user was shown by detection or picked in a dialog; only these may become instances.
const offered = new Set();

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
  type: oneOf(a.type, TYPES, 'mod'),
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

// What Play will do for this instance under the chosen setting. Anything the chosen way
// cannot handle (not signed in, a Forge instance, an old version) falls back to the
// launcher that owns the instance, and the label always says which it will be.
function howToLaunch(inst) {
  const mode = store.config.launchMode;
  if (game.supports(inst)) {
    if (mode === 'offline' && offlineAllowed && PLAYER_NAME.test(store.config.offlineName)) {
      return { direct: 'offline', play: true, label: `Modion, offline as ${store.config.offlineName}` };
    }
    if (mode === 'account' && account.status()) return { direct: 'account', play: true, label: `Modion as ${account.status().name}` };
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
      return { ...i, launch: how ? { play: how.play, label: how.label } : null };
    }),
    canCreate: launcher.canCreate(),
    launchMode: store.config.launchMode,
    offlineName: store.config.offlineName,
    offlineAllowed,
    msClientId: store.config.msClientId,
    account: account.status(),
    activeInstanceId,
    hasCurseforgeKey: curseforge.hasKey(),
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

// Makes the folders for a new instance. It goes into Prism Launcher when Prism is what will
// start it (the Prism setting, or a loader Modion cannot start itself), otherwise into
// Modion's own instances folder.
async function makeInstance(spec) {
  const direct = game.supports(spec);
  if (launcher.canCreate() && (store.config.launchMode === 'prism' || !direct)) return launcher.create(spec);
  if (!direct) throw new ApiError('Forge, NeoForge and versions before 1.19 need Prism Launcher, which was not found on this computer.', 'NO_PRISM');
  await game.versionJson(spec.gameVersion); // fails for a version Mojang does not have
  return launcher.createOwn(spec, game.ROOT);
}

function adopt(made, spec) {
  offered.add(made.path);
  const inst = { id: crypto.randomUUID(), path: made.path, name: made.name, gameVersion: spec.gameVersion, loader: spec.loader, managed: true, home: made.home };
  store.config.instances.push(inst);
  store.config.activeInstanceId = inst.id;
  store.saveConfig();
  return inst;
}

// An instance Modion made, whose folder is still exactly where Modion puts instances.
function managed(idValue) {
  const inst = store.instance(idValue);
  if (!inst) throw new ApiError('That instance is no longer in the list.', 'GONE');
  const ok = inst.managed && inst.home
    && launcher.managedRoots(game.ROOT).includes(path.dirname(inst.home))
    && inst.path.startsWith(inst.home + path.sep);
  if (!ok) throw new ApiError('Modion only renames and deletes instances it created.', 'NOT_MANAGED');
  return inst;
}

function forget(idValue) {
  store.config.instances = store.config.instances.filter((i) => i.id !== idValue);
  delete store.manifest[idValue];
  if (!store.active()) store.config.activeInstanceId = store.config.instances[0] ? store.config.instances[0].id : null;
  store.saveConfig();
  store.saveManifest();
}

// People often pick the "mods" folder itself; the instance is the folder around it.
function gameFolder(dir) {
  return Object.values(content.FOLDER).includes(path.basename(dir)) ? path.dirname(dir) : dir;
}

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
    curseforge.setKey(next);
    store.config.curseforgeKey = next;
    store.saveConfig();
    return publicConfig();
  },

  'settings.setLaunch': (a) => {
    const mode = oneOf(a.mode, ['prism', 'account', 'offline'], 'prism');
    if (mode === 'offline' && !offlineAllowed) throw new ApiError('Offline launching is not available on this computer.', 'FORBIDDEN');
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
    if (next !== store.config.msClientId) account.signOut(); // a sign-in belongs to the ID it was made with
    store.config.msClientId = next;
    store.saveConfig();
    return publicConfig();
  },
  'account.signIn': async () => { await account.signIn(store.config.msClientId); return publicConfig(); },
  'account.cancel': () => { account.cancel(); return publicConfig(); },
  'account.signOut': () => { account.signOut(); return publicConfig(); },

  'meta.gameVersions': () => modrinth.gameVersions(),
  'meta.categories': (a) => source(a.source).categories(oneOf(a.type, TYPES, 'mod')),

  // For a file its author only offers on the website: show that page and wait for the
  // person to download the file there.
  'install.viaWebsite': async (a) => {
    const inst = content.activeInstance(store);
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
    refreshInstalled();
    return { installed_ids: content.installedIds(store) };
  },

  search: (a) => source(a.source).search({
    ...filter(a),
    query: text(a.query, 200),
    sort: oneOf(a.sort, SORTS, 'relevance'),
    category: text(a.category, 60),
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

  // Makes a new Prism Launcher instance and selects it.
  'instances.create': async (a) => {
    const spec = { name: text(a.name, 80), gameVersion: text(a.gameVersion, 32), loader: oneOf(a.loader, LOADERS, '') };
    adopt(await makeInstance(spec), spec);
    return publicConfig();
  },

  // Creates an instance from a Modrinth .mrpack or a CurseForge modpack zip.
  'instances.import': async () => {
    const pick = await dialog.showOpenDialog(liveWindow(), {
      title: 'Import a modpack',
      filters: [{ name: 'Modpacks (.mrpack, .zip)', extensions: ['mrpack', 'zip'] }],
      properties: ['openFile'],
    });
    if (pick.canceled || !pick.filePaths[0]) return null;
    const pack = modpack.inspect(pick.filePaths[0]);
    let made = null;
    const job = { id: crypto.randomUUID(), title: pack.name, filename: pack.name, saved: true };
    try {
      const spec = { name: text(pack.name, 80), gameVersion: text(pack.gameVersion, 32), loader: oneOf(pack.loader, LOADERS, ''), loaderVersion: text(pack.loaderVersion, 40) };
      // Checked before any folder is made, so a pack that cannot be fetched leaves nothing behind.
      if (pack.kind === 'curseforge' && pack.files.length && !curseforge.hasKey()) {
        throw new ApiError('Importing a CurseForge modpack needs your CurseForge API key. Add it in Settings first.', 'NO_CF_KEY');
      }
      made = await makeInstance(spec);
      const { items, skipped } = await modpack.downloads(pack, made.path, curseforge);
      await game.fetchAll(items, (received, total) => emit({ ...job, state: 'progress', received, total }));
      const copied = await modpack.unpackOverrides(pack, made.path);
      const inst = adopt(made, spec);
      return { config: publicConfig(), name: inst.name, files: items.length, copied, skipped };
    } catch (e) {
      if (made) fs.rmSync(made.home, { recursive: true, force: true }); // only the folder created just above
      throw e;
    } finally {
      pack.zip.close();
      emit({ ...job, state: 'done' });
    }
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
    if (how && how.direct) {
      const session = how.direct === 'account' ? await account.gameSession(store.config.msClientId) : game.offlineSession(store.config.offlineName);
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

app.setDesktopName('modion.desktop');

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
  store = new Store(dir);
  const keyring = safeStorage.isEncryptionAvailable();
  account = new Account({
    dir,
    openExternal: (target) => shell.openExternal(target),
    seal: keyring ? (s) => safeStorage.encryptString(s).toString('base64') : null,
    open: keyring ? (s) => safeStorage.decryptString(Buffer.from(s, 'base64')) : null,
  });
  curseforge.setKey(store.config.curseforgeKey || process.env.CURSEFORGE_API_KEY || '');
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
