'use strict';
// Creating and starting instances. Modion does not sign in to Minecraft or download the
// game itself: it writes a Prism Launcher instance and asks Prism to run it, so the
// account, Java and game files are the ones Prism already manages.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getJson, ApiError, arr } = require('./http');

const HOME = os.homedir();
const DATA = process.env.XDG_DATA_HOME || path.join(HOME, '.local/share');
const META = 'https://meta.prismlauncher.org/v1';
const LOADER_UID = {
  fabric: 'net.fabricmc.fabric-loader',
  quilt: 'org.quiltmc.quilt-loader',
  forge: 'net.minecraftforge',
  neoforge: 'net.neoforged',
};
const LOADER_NAME = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function onPath(names) {
  const dirs = String(process.env.PATH || '').split(':').filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return name; } catch {}
    }
  }
  return null;
}

// Where Prism keeps its data, and how to start that copy of it. MODION_PRISM_ROOT is for tests.
function prismInstalls() {
  const all = process.env.MODION_PRISM_ROOT
    ? [{ root: process.env.MODION_PRISM_ROOT, cmd: ['prismlauncher'] }]
    : [
        { root: path.join(HOME, '.var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher'), cmd: ['flatpak', 'run', 'org.prismlauncher.PrismLauncher'] },
        { root: path.join(DATA, 'PrismLauncher'), cmd: ['prismlauncher'] },
      ];
  return all.filter((p) => isDir(path.join(p.root, 'instances')));
}

const canCreate = () => prismInstalls().length > 0;

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
  const under = (root) => !path.relative(root, gameDir).startsWith('..');
  if (under(path.join(HOME, '.var/app/com.modrinth.ModrinthApp'))) {
    return { play: false, label: 'Modrinth App', cmd: ['flatpak', 'run', 'com.modrinth.ModrinthApp'] };
  }
  if (under(path.join(DATA, 'ModrinthApp'))) {
    const bin = onPath(['modrinth-app', 'ModrinthApp']);
    return bin ? { play: false, label: 'Modrinth App', cmd: [bin] } : null;
  }
  if (under(path.join(HOME, '.var/app/com.mojang.Minecraft'))) {
    return { play: false, label: 'Minecraft Launcher', cmd: ['flatpak', 'run', 'com.mojang.Minecraft'] };
  }
  if (gameDir === path.join(HOME, '.minecraft')) {
    const bin = onPath(['minecraft-launcher']);
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
      child = require('child_process').spawn(how.cmd[0], how.cmd.slice(1), { detached: true, stdio: 'ignore' });
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

async function components(gameVersion, loader) {
  if (!(await index('net.minecraft')).some((v) => v.version === gameVersion)) {
    throw new ApiError(`Prism Launcher does not offer Minecraft ${gameVersion}.`, 'NO_GAME_VERSION');
  }
  const list = [{ uid: 'net.minecraft', version: gameVersion, important: true }];
  if (!loader) return list;

  const name = LOADER_NAME[loader];
  const missing = new ApiError(`${name} is not available for Minecraft ${gameVersion}.`, 'NO_LOADER_VERSION');
  let builds = await index(LOADER_UID[loader]);
  if (loader === 'fabric' || loader === 'quilt') {
    // These loaders are not tied to a game version; the mappings ("intermediary") are.
    if (!(await index('net.fabricmc.intermediary')).some((v) => v.version === gameVersion)) throw missing;
    list.push({ uid: 'net.fabricmc.intermediary', version: gameVersion, dependencyOnly: true });
  } else {
    builds = builds.filter((v) => arr(v.requires).some((r) => r && r.uid === 'net.minecraft' && r.equals === gameVersion));
  }
  // The index is newest first: take the recommended build, else the newest stable, else the newest.
  const pick = builds.find((v) => v.recommended) || builds.find((v) => !v.type || v.type === 'release') || builds[0];
  if (!pick) throw missing;
  list.push({ uid: LOADER_UID[loader], version: pick.version });
  return list;
}

// Writes a new Prism instance and returns its game folder. Prism downloads the game,
// loader and Java the first time the instance is started.
async function create({ name, gameVersion, loader }) {
  const prism = prismInstalls()[0];
  if (!prism) throw new ApiError('Creating instances needs Prism Launcher, which was not found on this computer.', 'NO_PRISM');
  if (!gameVersion) throw new ApiError('Pick a game version for the new instance.', 'BAD_REQUEST');
  if (loader && !Object.hasOwn(LOADER_UID, loader)) throw new ApiError('Unknown mod loader.', 'BAD_REQUEST');

  // Prism reads the name from an INI file and uses the folder name as the instance ID.
  const clean = String(name || '').replace(/[^\p{L}\p{N} ._()+-]/gu, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 60)
    || `${loader ? LOADER_NAME[loader] : 'Minecraft'} ${gameVersion}`;
  const parts = await components(gameVersion, loader);

  const instances = path.join(prism.root, 'instances');
  let dir = null;
  for (let n = 1; n < 100 && !dir; n++) {
    const candidate = path.join(instances, n === 1 ? clean : `${clean} (${n})`);
    try { fs.mkdirSync(candidate); dir = candidate; } catch (e) {
      if (e.code !== 'EEXIST') throw new ApiError(`Could not create the instance folder: ${e.code || e.message}.`, 'FS');
    }
  }
  if (!dir) throw new ApiError('Too many instances share that name.', 'EXISTS');
  try {
    const game = path.join(dir, 'minecraft');
    fs.mkdirSync(game);
    fs.writeFileSync(path.join(dir, 'mmc-pack.json'), JSON.stringify({ components: parts, formatVersion: 1 }, null, 4));
    // Written last: this file is what makes Prism see the folder as an instance.
    fs.writeFileSync(path.join(dir, 'instance.cfg'), `[General]\nConfigVersion=1.3\nInstanceType=OneSix\niconKey=default\nname=${clean}\n`);
    return { path: game, name: clean };
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true }); // only ever the folder created just above
    throw new ApiError(`Could not write the new instance: ${e.code || e.message}.`, 'FS');
  }
}

module.exports = { canCreate, describe, launch, create };
