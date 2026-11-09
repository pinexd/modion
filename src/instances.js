'use strict';
// Finds game folders belonging to launchers already on this machine
// (vanilla launcher, Prism/MultiMC-style launchers, Modrinth App), native or Flatpak.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const DATA = process.env.XDG_DATA_HOME || path.join(HOME, '.local/share');
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const subdirs = (p) => {
  try {
    return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(p, d.name));
  } catch {
    return [];
  }
};

const MMC_LOADERS = {
  'net.fabricmc.fabric-loader': 'fabric',
  'org.quiltmc.quilt-loader': 'quilt',
  'net.minecraftforge': 'forge',
  'net.neoforged': 'neoforge',
};

function prismStyle(root, launcher) {
  const out = [];
  for (const dir of subdirs(root)) {
    if (!fs.existsSync(path.join(dir, 'instance.cfg'))) continue;
    const game = ['minecraft', '.minecraft'].map((n) => path.join(dir, n)).find(isDir);
    if (!game) continue;
    let name = path.basename(dir), gameVersion = '', loader = '';
    try {
      const m = fs.readFileSync(path.join(dir, 'instance.cfg'), 'utf8').match(/^name=(.*)$/m);
      if (m && m[1].trim()) name = m[1].trim();
    } catch {}
    try {
      const pack = JSON.parse(fs.readFileSync(path.join(dir, 'mmc-pack.json'), 'utf8'));
      for (const c of Array.isArray(pack.components) ? pack.components : []) {
        if (!c) continue;
        if (c.uid === 'net.minecraft') gameVersion = String(c.version || '');
        if (Object.hasOwn(MMC_LOADERS, c.uid)) loader = MMC_LOADERS[c.uid];
      }
    } catch {}
    out.push({ name, path: game, gameVersion, loader, launcher });
  }
  return out;
}

function modrinthApp(root) {
  const profiles = subdirs(path.join(root, 'profiles'));
  if (!profiles.length) return [];
  const meta = {};
  let db = null;
  try {
    // The Modrinth App keeps profile metadata in a SQLite file; read it if this runtime can.
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(path.join(root, 'app.db'), { readOnly: true });
    // Current app versions keep version/loader on the instance's content set; older ones on a profiles table.
    const queries = [
      `SELECT i.path, i.name, s.game_version, s.loader AS mod_loader
         FROM instances i JOIN instance_content_sets s ON s.id = i.applied_content_set_id`,
      'SELECT path, name, game_version, mod_loader FROM profiles',
    ];
    for (const sql of queries) {
      try {
        for (const r of db.prepare(sql).all()) if (r && typeof r.path === 'string') meta[r.path] = r;
        break;
      } catch {}
    }
  } catch {
    // No database, or no SQLite in this runtime: the folders are still listed, without versions.
  } finally {
    try { if (db) db.close(); } catch {}
  }
  return profiles.map((dir) => {
    const m = meta[path.basename(dir)] || {};
    const loader = ['fabric', 'forge', 'neoforge', 'quilt'].includes(m.mod_loader) ? m.mod_loader : '';
    return { name: String(m.name || path.basename(dir)), path: dir, gameVersion: String(m.game_version || ''), loader, launcher: 'Modrinth App' };
  });
}

function detect() {
  const found = [];
  for (const p of [path.join(HOME, '.minecraft'), path.join(HOME, '.var/app/com.mojang.Minecraft/.minecraft')]) {
    if (isDir(p)) found.push({ name: '.minecraft', path: p, gameVersion: '', loader: '', launcher: 'Minecraft Launcher' });
  }
  const prismRoots = [
    [path.join(DATA, 'PrismLauncher/instances'), 'Prism Launcher'],
    [path.join(HOME, '.var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher/instances'), 'Prism Launcher'],
    [path.join(DATA, 'multimc/instances'), 'MultiMC'],
    [path.join(DATA, 'PolyMC/instances'), 'PolyMC'],
    [path.join(HOME, '.var/app/org.polymc.PolyMC/data/PolyMC/instances'), 'PolyMC'],
  ];
  for (const [root, launcher] of prismRoots) found.push(...prismStyle(root, launcher));
  for (const root of [
    path.join(DATA, 'ModrinthApp'),
    path.join(HOME, '.var/app/com.modrinth.ModrinthApp/data/ModrinthApp'),
  ]) found.push(...modrinthApp(root));
  // The same folder can be reached twice (XDG_DATA_HOME pointing into a Flatpak, symlinks).
  const seen = new Set();
  return found.filter((f) => {
    let real = f.path;
    try { real = fs.realpathSync(f.path); } catch {}
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

module.exports = { detect, isDir };
