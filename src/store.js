'use strict';
// Tiny JSON-file persistence: config.json (instances, API key) and
// manifest.json (which file in which instance came from which project).

const fs = require('fs');
const path = require('path');

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

class Store {
  constructor(dir) {
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
        })),
      activeInstanceId: typeof config.activeInstanceId === 'string' ? config.activeInstanceId : null,
      curseforgeKey: typeof config.curseforgeKey === 'string' ? config.curseforgeKey : '',
      msClientId: typeof config.msClientId === 'string' ? config.msClientId : '',
      launchMode: ['prism', 'account', 'offline'].includes(config.launchMode) ? config.launchMode : 'prism',
      openLogOnLaunch: config.openLogOnLaunch !== false, // on unless switched off
      offlineName: typeof config.offlineName === 'string' ? config.offlineName : '',
    };
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
