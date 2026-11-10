'use strict';
// Instance libraries: folders that hold the instances Modion itself creates. Each instance
// is one folder with an instance.json (its ID, name, game version and loader) and the game
// folder "minecraft" inside. Because the ID travels with the folder, a library can be moved
// by hand and added again, and Modion recognises the instances in it.

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { ApiError } = require('./http');

const platform = require('./platform');
const DEFAULT = platform.DEFAULT_LIBRARY; // where new instances go unless Settings says otherwise
const APP_DATA = platform.APP_DATA;       // the game files Modion downloads (shared by all instances)
const META = 'instance.json';
const GAME = 'minecraft';

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const within = (parent, child) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

function readMeta(home) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(home, META), 'utf8'));
    return m && typeof m === 'object' && !Array.isArray(m) ? m : null;
  } catch {
    return null;
  }
}

function writeMeta(home, meta) {
  const file = path.join(home, META), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, file);
}

// Is this folder an instance of Modion's own kind (and not, say, a Prism one)?
const isOwn = (home) => Boolean(home) && readMeta(home) !== null && isDir(path.join(home, GAME));

// The instances directly inside a library folder.
function scan(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const found = [];
  for (const name of names.sort()) {
    const home = path.join(dir, name);
    const meta = isDir(home) ? readMeta(home) : null;
    if (meta && isDir(path.join(home, GAME))) found.push({ home, path: path.join(home, GAME), meta });
  }
  return found;
}

// Moves a folder, also across disks (where a plain rename is refused and it has to be
// copied and then removed). `to` must not exist yet.
async function move(from, to) {
  if (exists(to)) throw new ApiError(`There is already something at ${to}.`, 'EXISTS');
  try {
    await fsp.mkdir(path.dirname(to), { recursive: true });
  } catch (e) {
    throw new ApiError(`Could not create ${path.dirname(to)}: ${e.code || e.message}.`, 'FS');
  }
  try {
    await fsp.rename(from, to);
    return;
  } catch (e) {
    if (e.code !== 'EXDEV') throw new ApiError(`Could not move ${from}: ${e.code || e.message}.`, 'FS');
  }
  try {
    await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  } catch (e) {
    await fsp.rm(to, { recursive: true, force: true }).catch(() => {}); // only the incomplete copy made just above
    throw new ApiError(`Could not copy ${from} to ${to}: ${e.code || e.message}. Nothing was moved.`, 'FS');
  }
  try {
    await fsp.rm(from, { recursive: true, force: true });
  } catch (e) {
    throw new ApiError(`Copied to ${to}, but the original at ${from} could not be removed: ${e.code || e.message}.`, 'FS');
  }
}

// A folder that can be used as a library: creatable, writable, and not somewhere silly.
function usable(dir) {
  if (!path.isAbsolute(dir) || dir === path.parse(dir).root) throw new ApiError('Choose a folder, not a whole disk.', 'BAD_PATH');
  if (within(APP_DATA, dir)) throw new ApiError('That folder holds Modion\'s own game files. Choose another one.', 'BAD_PATH');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
  } catch (e) {
    throw new ApiError(`Modion cannot write to ${dir}: ${e.code || e.message}.`, 'FS');
  }
  return dir;
}

module.exports = { DEFAULT, APP_DATA, GAME, isDir, exists, within, readMeta, writeMeta, isOwn, scan, move, usable };
