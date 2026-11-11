'use strict';
// Tiny JSON-file persistence: config.json (instances, API key) and
// manifest.json (which file in which instance came from which project).

const fs = require('fs');
const path = require('path');

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

class Store {
  constructor(dir, defaultLibrary) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });

    const saved = this.read('config.json');
    const config = isObject(saved) ? saved : {};
    this.config = {
      // Hand-edited or damaged files must not be able to crash the app later on.
      instances: (Array.isArray(config.instances) ? config.instances : [])
        .filter((i) => isObject(i) && typeof i.id === 'string' && typeof i.path === 'string' && i.path)
        .map((i) => ({
          id: i.id,
          path: i.path,
          name: String(i.name || path.basename(i.path)),
          gameVersion: typeof i.gameVersion === 'string' ? i.gameVersion : '',
          loader: typeof i.loader === 'string' ? i.loader : '',
          // Set on instances Modion created or imported: `home` is the folder it may rename and delete.
          ...(i.managed === true && typeof i.home === 'string' && i.home ? { managed: true, home: i.home } : {}),
          // How Modion starts this instance's game, where the person changed it from the defaults.
          // Files a modpack wanted that can only be downloaded from the CurseForge website.
          ...(Array.isArray(i.leftOut) && i.leftOut.length ? { leftOut: i.leftOut
            .filter((f) => isObject(f) && typeof f.projectId === 'string' && typeof f.fileId === 'string')
            .map((f) => ({ projectId: f.projectId, fileId: f.fileId, title: String(f.title || f.filename || 'Unnamed file'), filename: String(f.filename || ''), type: f.type === 'resourcepack' ? 'resourcepack' : 'mod' })) } : {}),
          ...(isObject(i.settings) ? { settings: {
            memory: Number.isInteger(i.settings.memory) && i.settings.memory > 0 ? i.settings.memory : null, // MB; null = automatic
            jvmArgs: typeof i.settings.jvmArgs === 'string' ? i.settings.jvmArgs : '',
            env: typeof i.settings.env === 'string' ? i.settings.env : '',
            java: typeof i.settings.java === 'string' ? i.settings.java : '', // '' = automatic
          } } : {}),
        })),
      activeInstanceId: typeof config.activeInstanceId === 'string' ? config.activeInstanceId : null,
      curseforgeKey: typeof config.curseforgeKey === 'string' ? config.curseforgeKey : '',
      msClientId: typeof config.msClientId === 'string' ? config.msClientId : '',
      // How Play starts the game. Modion starting it itself, with the Microsoft account, is the default.
      launchMode: ['prism', 'account', 'offline'].includes(config.launchMode) ? config.launchMode : 'account',
      openLogOnLaunch: config.openLogOnLaunch !== false, // on unless switched off
      skipStopWarning: config.skipStopWarning === true, // stop a running game without asking first
      checkUpdates: config.checkUpdates !== false,       // likewise
      offlineName: typeof config.offlineName === 'string' ? config.offlineName : '',
      // Folders that hold instances Modion created; new ones go into newInstanceDir.
      libraries: [...new Set((Array.isArray(config.libraries) ? config.libraries : [])
        .filter((p) => typeof p === 'string' && path.isAbsolute(p)).map((p) => path.resolve(p)))],
      newInstanceDir: typeof config.newInstanceDir === 'string' && path.isAbsolute(config.newInstanceDir) ? path.resolve(config.newInstanceDir) : defaultLibrary,
    };
    if (!this.config.libraries.includes(this.config.newInstanceDir)) this.config.libraries.unshift(this.config.newInstanceDir);
    if (!this.instance(this.config.activeInstanceId)) {
      this.config.activeInstanceId = this.config.instances[0] ? this.config.instances[0].id : null;
    }

    const manifest = this.read('manifest.json');
    this.manifest = {};
    for (const [id, entries] of Object.entries(isObject(manifest) ? manifest : {})) {
      if (!isObject(entries)) continue;
      this.manifest[id] = {};
      for (const [key, e] of Object.entries(entries)) if (isObject(e)) this.manifest[id][key] = e;
    }
  }

  // Returns null when the file is absent. A file that exists but cannot be parsed is set
  // aside (not overwritten) so nothing is lost if it can be repaired by hand.
  read(name) {
    const file = path.join(this.dir, name);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      try { fs.renameSync(file, `${file}.damaged-${Date.now()}`); } catch {}
      return null;
    }
  }

  write(name, data) {
    const file = path.join(this.dir, name);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch {}
      throw e;
    }
  }

  saveConfig() { this.write('config.json', this.config); }
  saveManifest() { this.write('manifest.json', this.manifest); }

  instance(id) { return this.config.instances.find((i) => i.id === id) || null; }
  active() { return this.instance(this.config.activeInstanceId); }

  // The live record of tracked files for an instance (created on first use).
  entries(instanceId) {
    if (!isObject(this.manifest[instanceId])) this.manifest[instanceId] = {};
    return this.manifest[instanceId];
  }
}

module.exports = { Store };
