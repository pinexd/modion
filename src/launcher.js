'use strict';
// Creating instances, and starting them through the launcher that owns them. For Prism
// Launcher, Modion writes a Prism instance and asks Prism to run it, so the account, Java
// and game files are the ones Prism already manages. (Starting the game directly is game.js.)

const fs = require('fs');
const path = require('path');
const { getJson, ApiError, arr } = require('./http');

const { WIN, HOME, DATA, ROAMING, LOCAL, findProgram } = require('./platform');
const META = 'https://meta.prismlauncher.org/v1';
const LOADER_UID = {
  fabric: 'net.fabricmc.fabric-loader',
  quilt: 'org.quiltmc.quilt-loader',
  forge: 'net.minecraftforge',
  neoforge: 'net.neoforged',
};
const LOADER_NAME = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// Where the other launchers' programs are usually installed on Windows.
const WIN_PROGRAMS = {
  prism: [path.join(LOCAL, 'Programs', 'PrismLauncher', 'prismlauncher.exe'), 'prismlauncher.exe'],
  modrinth: [path.join(LOCAL, 'Modrinth App', 'Modrinth App.exe'), 'C:\\Program Files\\Modrinth App\\Modrinth App.exe'],
  minecraft: ['C:\\Program Files (x86)\\Minecraft Launcher\\MinecraftLauncher.exe', 'C:\\XboxGames\\Minecraft Launcher\\Content\\Minecraft.exe'],
};

// Where Prism keeps its data, and how to start that copy of it. MODION_PRISM_ROOT is for tests.
function prismInstalls() {
  const all = process.env.MODION_PRISM_ROOT
    ? [{ root: process.env.MODION_PRISM_ROOT, cmd: ['prismlauncher'] }]
    : WIN
      ? [{ root: path.join(ROAMING, 'PrismLauncher'), cmd: [findProgram(WIN_PROGRAMS.prism) || 'prismlauncher.exe'] }]
      : [
          { root: path.join(HOME, '.var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher'), cmd: ['flatpak', 'run', 'org.prismlauncher.PrismLauncher'] },
          { root: path.join(DATA, 'PrismLauncher'), cmd: ['prismlauncher'] },
        ];
  return all.filter((p) => isDir(path.join(p.root, 'instances')));
}

const canCreate = () => prismInstalls().length > 0;

// Is Prism Launcher on this computer at all? Its data folder (it has been run), its
// program, or its Flatpak counts.
const prismInstalled = () => prismInstalls().length > 0
  || Boolean(findProgram(WIN ? WIN_PROGRAMS.prism : ['prismlauncher']))
  || (!WIN && isDir(path.join(HOME, '.var/app/org.prismlauncher.PrismLauncher')))
  || (!WIN && ['/var/lib/flatpak/app/org.prismlauncher.PrismLauncher', path.join(DATA, 'flatpak/app/org.prismlauncher.PrismLauncher')].some(isDir));

// How the instance at this game folder gets started, or null if Modion has no way to.
//   play: true  -> the game itself can be launched
//   play: false -> the best we can do is open the launcher that owns it
function describe(gameDir) {
  for (const p of prismInstalls()) {
    const rel = path.relative(path.join(p.root, 'instances'), gameDir).split(path.sep);
    if (rel.length === 2 && rel[0] && rel[0] !== '..' && ['minecraft', '.minecraft'].includes(rel[1])) {
      return { play: true, label: 'Prism Launcher', cmd: [...p.cmd, '--launch', rel[0]] };
    }
  }
  const under = (root) => { const rel = path.relative(root, gameDir); return !rel.startsWith('..') && !path.isAbsolute(rel); };
  if (WIN) {
    if (under(path.join(ROAMING, 'ModrinthApp')) || under(path.join(ROAMING, 'com.modrinth.theseus'))) {
      const exe = findProgram(WIN_PROGRAMS.modrinth);
      return exe ? { play: false, label: 'Modrinth App', cmd: [exe] } : null;
    }
    if (gameDir === path.join(ROAMING, '.minecraft')) {
      const exe = findProgram(WIN_PROGRAMS.minecraft);
      return exe ? { play: false, label: 'Minecraft Launcher', cmd: [exe] } : null;
    }
    return null;
  }
  if (under(path.join(HOME, '.var/app/com.modrinth.ModrinthApp'))) {
    return { play: false, label: 'Modrinth App', cmd: ['flatpak', 'run', 'com.modrinth.ModrinthApp'] };
  }
  if (under(path.join(DATA, 'ModrinthApp'))) {
    const bin = findProgram(['modrinth-app', 'ModrinthApp']);
    return bin ? { play: false, label: 'Modrinth App', cmd: [bin] } : null;
  }
  if (under(path.join(HOME, '.var/app/com.mojang.Minecraft'))) {
    return { play: false, label: 'Minecraft Launcher', cmd: ['flatpak', 'run', 'com.mojang.Minecraft'] };
  }
  if (gameDir === path.join(HOME, '.minecraft')) {
    const bin = findProgram(['minecraft-launcher']);
    return bin ? { play: false, label: 'Minecraft Launcher', cmd: [bin] } : null;
  }
  return null;
}

function launch(gameDir) {
  const how = describe(gameDir);
  if (!how) throw new ApiError('Modion does not know which launcher starts this instance.', 'NO_LAUNCHER');
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = require('child_process').spawn(how.cmd[0], how.cmd.slice(1), { detached: true, stdio: 'ignore', windowsHide: true });
    } catch (e) {
      reject(new ApiError(`Could not start ${how.label}: ${e.message}`, 'LAUNCH'));
      return;
    }
    child.once('error', (e) => reject(new ApiError(
      e.code === 'ENOENT' ? `Could not start ${how.label}: the command "${how.cmd[0]}" was not found.` : `Could not start ${how.label}: ${e.message}`, 'LAUNCH')));
    child.once('spawn', () => { child.unref(); resolve({ label: how.label, play: how.play }); });
  });
}

// Prism's own metadata service says which game and loader versions it can install.
const cache = new Map();
async function index(uid) {
  const hit = cache.get(uid);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.versions;
  const versions = arr((await getJson(`${META}/${uid}/index.json`)).versions).filter((v) => v && typeof v.version === 'string');
  cache.set(uid, { at: Date.now(), versions });
  return versions;
}

// Which build of a loader goes with a game version, as Prism's metadata service has it.
async function loaderBuild(loader, gameVersion, loaderVersion) {
  const missing = new ApiError(`${LOADER_NAME[loader]} is not available for Minecraft ${gameVersion}.`, 'NO_LOADER_VERSION');
  let builds = await index(LOADER_UID[loader]);
  if (loader === 'fabric' || loader === 'quilt') {
    // These loaders are not tied to a game version; the mappings ("intermediary") are.
    if (!(await index('net.fabricmc.intermediary')).some((v) => v.version === gameVersion)) throw missing;
  } else {
    builds = builds.filter((v) => arr(v.requires).some((r) => r && r.uid === 'net.minecraft' && r.equals === gameVersion));
  }
  // The index is newest first: take the recommended build, else the newest stable, else the newest.
  // A modpack names the exact loader build it was made for; use it when Prism knows it.
  const pick = builds.find((v) => loaderVersion && v.version === loaderVersion)
    || builds.find((v) => v.recommended) || builds.find((v) => !v.type || v.type === 'release') || builds[0];
  if (!pick) throw missing;
  return pick.version;
}

// Prism's description of the game itself for a version (it lists patched libraries).
const gameMeta = (gameVersion) => getJson(`${META}/net.minecraft/${encodeURIComponent(gameVersion)}.json`);

// The full description of one loader build (libraries, main class, arguments).
const loaderMeta = (loader, version) => getJson(`${META}/${LOADER_UID[loader]}/${encodeURIComponent(version)}.json`);

async function components(gameVersion, loader, loaderVersion) {
  if (!(await index('net.minecraft')).some((v) => v.version === gameVersion)) {
    throw new ApiError(`Prism Launcher does not offer Minecraft ${gameVersion}.`, 'NO_GAME_VERSION');
  }
  const list = [{ uid: 'net.minecraft', version: gameVersion, important: true }];
  if (!loader) return list;
  const version = await loaderBuild(loader, gameVersion, loaderVersion);
  if (loader === 'fabric' || loader === 'quilt') list.push({ uid: 'net.fabricmc.intermediary', version: gameVersion, dependencyOnly: true });
  list.push({ uid: LOADER_UID[loader], version });
  return list;
}

// Writes a new Prism instance and returns its game folder. Prism downloads the game,
// loader and Java the first time the instance is started.
// Instance names end up as folder names and in an INI file, so they are kept simple.
function cleanName(name, gameVersion, loader) {
  const clean = String(name || '').replace(/[^\p{L}\p{N} ._()+-]/gu, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 60)
    .replace(/[. ]+$/, ''); // Windows drops trailing dots and spaces from folder names
  // A few names (CON, NUL, COM1...) cannot be folders on Windows.
  return (clean && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(clean) ? clean : '')
    || `${loader ? LOADER_NAME[loader] : 'Minecraft'} ${gameVersion}`;
}

// A new, empty folder named after the instance (with " (2)" and so on if taken).
function freshFolder(instances, clean) {
  try { fs.mkdirSync(instances, { recursive: true }); } catch (e) {
    throw new ApiError(`Could not create the instances folder: ${e.code || e.message}.`, 'FS');
  }
  for (let n = 1; n < 100; n++) {
    const candidate = path.join(instances, n === 1 ? clean : `${clean} (${n})`);
    try { fs.mkdirSync(candidate); return candidate; } catch (e) {
      if (e.code !== 'EEXIST') throw new ApiError(`Could not create the instance folder: ${e.code || e.message}.`, 'FS');
    }
  }
  throw new ApiError('Too many instances share that name.', 'EXISTS');
}

function check({ gameVersion, loader }) {
  if (!gameVersion) throw new ApiError('Pick a game version for the new instance.', 'BAD_REQUEST');
  if (loader && !Object.hasOwn(LOADER_UID, loader)) throw new ApiError('Unknown mod loader.', 'BAD_REQUEST');
}

// An instance of Modion's own kind, inside the given library folder, for when Modion
// starts the game itself.
function createOwn({ name, gameVersion, loader }, library) {
  check({ gameVersion, loader });
  const clean = cleanName(name, gameVersion, loader);
  const dir = freshFolder(library, clean);
  const id = require('crypto').randomUUID();
  try {
    const game = path.join(dir, 'minecraft');
    fs.mkdirSync(game);
    fs.writeFileSync(path.join(dir, 'instance.json'), JSON.stringify({ id, name: clean, gameVersion, loader: loader || '' }, null, 2));
    return { id, path: game, name: clean, home: dir };
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true }); // only ever the folder created just above
    throw new ApiError(`Could not write the new instance: ${e.code || e.message}.`, 'FS');
  }
}

// Keeps the launcher's own record of the name in step with Modion's.
function rename(home, name) {
  const cfg = path.join(home, 'instance.cfg'), own = path.join(home, 'instance.json');
  try {
    if (fs.existsSync(cfg)) {
      const text = fs.readFileSync(cfg, 'utf8');
      fs.writeFileSync(cfg, /^name=.*$/m.test(text) ? text.replace(/^name=.*$/m, () => `name=${name}`) : `${text.replace(/\n*$/, '\n')}name=${name}\n`);
    } else if (fs.existsSync(own)) {
      fs.writeFileSync(own, JSON.stringify({ ...JSON.parse(fs.readFileSync(own, 'utf8')), name }, null, 2));
    }
  } catch (e) {
    throw new ApiError(`Could not rename the instance: ${e.code || e.message}.`, 'FS');
  }
}

// Prism's instance folders; a Prism instance Modion made is a direct child of one of these.
const prismRoots = () => prismInstalls().map((p) => path.join(p.root, 'instances'));

async function create({ name, gameVersion, loader, loaderVersion }) {
  const prism = prismInstalls()[0];
  if (!prism) throw new ApiError('Creating this instance needs Prism Launcher, which was not found on this computer.', 'NO_PRISM');
  check({ gameVersion, loader });

  // Prism reads the name from an INI file and uses the folder name as the instance ID.
  const clean = cleanName(name, gameVersion, loader);
  const parts = await components(gameVersion, loader, loaderVersion);
  const dir = freshFolder(path.join(prism.root, 'instances'), clean);
  try {
    const game = path.join(dir, 'minecraft');
    fs.mkdirSync(game);
    fs.writeFileSync(path.join(dir, 'mmc-pack.json'), JSON.stringify({ components: parts, formatVersion: 1 }, null, 4));
    // Written last: this file is what makes Prism see the folder as an instance.
    fs.writeFileSync(path.join(dir, 'instance.cfg'), `[General]\nConfigVersion=1.3\nInstanceType=OneSix\niconKey=default\nname=${clean}\n`);
    return { path: game, name: clean, home: dir };
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true }); // only ever the folder created just above
    throw new ApiError(`Could not write the new instance: ${e.code || e.message}.`, 'FS');
  }
}

module.exports = { prismInstalled, canCreate, describe, launch, create, createOwn, rename, cleanName, prismRoots, loaderBuild, loaderMeta, gameMeta };
