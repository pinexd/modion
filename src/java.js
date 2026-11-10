'use strict';
// Finding the Java installations on this computer, and reading what version one is.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const platform = require('./platform');

const EXE = platform.WIN ? 'javaw.exe' : 'java';

// "17.0.9" -> 17, "1.8.0_202" -> 8
function major(version) {
  const m = String(version || '').match(/^(\d+)(?:\.(\d+))?/);
  return m ? (m[1] === '1' ? Number(m[2]) : Number(m[1])) || 0 : 0;
}

// A Java home folder has a "release" file naming its version.
function fromHome(home, source) {
  const exe = path.join(home, 'bin', EXE);
  if (!platform.isFile(exe)) return null;
  let version = '';
  try { version = (fs.readFileSync(path.join(home, 'release'), 'utf8').match(/^JAVA_VERSION="([^"]+)"/m) || [])[1] || ''; } catch {}
  return { path: exe, version, major: major(version), source };
}

const children = (dir) => {
  try { return fs.readdirSync(dir).map((n) => path.join(dir, n)).filter(platform.isDir); } catch { return []; }
};

// Every Java found in the usual places, the ones Modion downloaded included.
function detect(appData) {
  const homes = [];
  for (const dir of children(path.join(appData, 'runtimes'))) homes.push([dir, 'downloaded by Modion']);
  if (platform.WIN) {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
      for (const vendor of ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft']) {
        for (const dir of children(path.join(base, vendor))) homes.push([dir, 'installed']);
      }
    }
  } else {
    for (const dir of children('/usr/lib/jvm')) homes.push([dir, 'installed']);
    for (const dir of children('/usr/lib64/jvm')) homes.push([dir, 'installed']);
    for (const dir of children('/opt')) if (/j(dk|re|ava)/i.test(path.basename(dir))) homes.push([dir, 'installed']);
  }
  for (const dir of children(path.join(platform.HOME, '.sdkman', 'candidates', 'java'))) homes.push([dir, 'SDKMAN']);
  for (const dir of children(path.join(platform.HOME, '.jdks'))) homes.push([dir, 'IDE download']);
  if (process.env.JAVA_HOME) homes.push([process.env.JAVA_HOME, 'JAVA_HOME']);

  const seen = new Set(), found = [];
  for (const [home, source] of homes) {
    let real = home;
    try { real = fs.realpathSync(home); } catch {}
    if (seen.has(real)) continue; // /usr/lib/jvm is full of links to the same few Javas
    seen.add(real);
    const j = fromHome(real, source);
    if (j) found.push(j);
  }
  return found.sort((a, b) => b.major - a.major || a.path.localeCompare(b.path));
}

// Asks a Java program what it is. Resolves null if it does not answer like Java does.
function probe(exe) {
  return new Promise((resolve) => {
    execFile(exe, ['-version'], { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
      const m = `${stderr}\n${stdout}`.match(/version "([^"]+)"/);
      resolve(m ? { path: exe, version: m[1], major: major(m[1]), source: 'chosen by you' } : null);
    });
  });
}

module.exports = { detect, probe, major, EXE };
