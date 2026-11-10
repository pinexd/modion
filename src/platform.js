'use strict';
// Where things live and what they are called on this operating system (Linux or Windows).

const fs = require('fs');
const os = require('os');
const path = require('path');

const WIN = process.platform === 'win32';
const HOME = os.homedir();
const ROAMING = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
// XDG_DATA_HOME is honoured on both systems; the tests use it to work in a throwaway folder.
const OVERRIDE = process.env.XDG_DATA_HOME || '';

// Where applications keep their data: ~/.local/share, or %APPDATA% on Windows.
const DATA = OVERRIDE || (WIN ? ROAMING : path.join(HOME, '.local/share'));
// The game files Modion downloads, shared by all instances. They are large, so on Windows
// they go to the local (non-roaming) folder.
const APP_DATA = path.join(OVERRIDE || (WIN ? LOCAL : DATA), 'ModionApp');
// Where new instances go unless Settings says otherwise. On Windows %APPDATA%\Modion is
// already the settings folder, so the instances get a folder inside it.
const DEFAULT_LIBRARY = WIN && !OVERRIDE ? path.join(ROAMING, 'Modion', 'instances') : path.join(DATA, 'Modion');

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// The first of these programs that exists, by full path or by name on the PATH.
function findProgram(candidates) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const c of candidates) {
    if (path.isAbsolute(c)) { if (isFile(c)) return c; continue; }
    for (const dir of dirs) {
      const full = path.join(dir, c);
      try { fs.accessSync(full, WIN ? fs.constants.F_OK : fs.constants.X_OK); if (isFile(full)) return WIN ? full : c; } catch {}
    }
  }
  return null;
}

module.exports = {
  WIN, HOME, ROAMING, LOCAL, DATA, APP_DATA, DEFAULT_LIBRARY, isDir, isFile, findProgram,
  OS_NAME: WIN ? 'windows' : 'linux',          // as Mojang's metadata calls it
  RUNTIME_OS: WIN ? 'windows-x64' : 'linux',   // as Mojang's Java runtime list calls it
  JAVA: WIN ? path.join('bin', 'javaw.exe') : path.join('bin', 'java'),
};
