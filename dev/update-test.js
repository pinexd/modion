'use strict';
// Checks the updater without touching the network or the real release key:
//   node dev/update-test.js        (needs ssh-keygen, which makes a throwaway key)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const u = require('../src/updater');
const { writeZip } = require('../src/zip');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'modion-update-test-'));
let failed = 0;
const t = (name, ok) => { console.log(ok ? 'ok  ' : 'FAIL', name); if (!ok) failed++; };
const code = async (p) => { try { await p; return 'OK'; } catch (e) { return e.code; } };

(async () => {
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'test', '-f', path.join(T, 'k')]);
  const key = fs.readFileSync(path.join(T, 'k.pub'), 'utf8').split(' ')[1];
  const pkg = (version, electron) => Buffer.from(JSON.stringify({ name: 'modion', version, modionElectron: electron }));
  const make = (name, files) => { writeZip(path.join(T, name), files); return path.join(T, name); };
  const zip = make('app.zip', [{ name: 'package.json', data: pkg('9.9.9', '44.10.2') }, { name: 'main.js', data: Buffer.from('// new') }, { name: 'src/a.js', data: Buffer.from('1') }]);
  execFileSync('ssh-keygen', ['-q', '-Y', 'sign', '-f', path.join(T, 'k'), '-n', u.NAMESPACE, zip]);
  const data = fs.readFileSync(zip), sig = fs.readFileSync(`${zip}.sig`, 'utf8');
  const other = execFileSync('ssh-keygen', ['-q', '-Y', 'sign', '-f', path.join(T, 'k'), '-n', 'something-else'], { input: data }).toString();

  t('a good signature is accepted', u.verifySignature(data, sig, key));
  t('changed data is refused', !u.verifySignature(Buffer.concat([data, Buffer.from('x')]), sig, key));
  t('a signature made for another purpose is refused', !u.verifySignature(data, other, key));
  t('a signature by another key is refused', !u.verifySignature(data, sig));
  t('nonsense is refused', !u.verifySignature(data, 'hello', key) && !u.verifySignature(data, '', key));
  t('versions are ordered properly', u.compare('1.0.0', '1.0.0-pre.2') > 0 && u.compare('1.0.0-pre.10', '1.0.0-pre.2') > 0
    && u.compare('v1.2.0', '1.10.0') < 0 && u.compare('1.0.0', '1.0.0') === 0 && u.compare('nonsense', '1.0.0') === 0);

  const app = path.join(T, 'inst', 'resources', 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'main.js'), '// old');
  fs.writeFileSync(path.join(app, 'stale.txt'), 'stale');
  const fetchFile = async (f, dir) => fs.copyFileSync(path.join(T, f.filename), path.join(dir, f.filename));
  const info = { version: '9.9.9', payload: { url: 'x', sig: 'y', size: 0 } };
  const untouched = () => fs.readFileSync(path.join(app, 'main.js'), 'utf8') === '// old' && fs.existsSync(path.join(app, 'stale.txt'));

  t('no package -> NO_PAYLOAD', await code(u.install({ version: '9.9.9', payload: null }, app, { key, fetchFile })) === 'NO_PAYLOAD');
  t('another Electron -> NEEDS_FULL, nothing changed', await code(u.install(info, app, { electron: '45.0.0', key, fetchFile })) === 'NEEDS_FULL' && untouched());
  t('another version -> BAD_PAYLOAD, nothing changed', await code(u.install({ ...info, version: '9.9.8' }, app, { electron: '44.1.0', key, fetchFile })) === 'BAD_PAYLOAD' && untouched());
  t('not signed by the release key -> BAD_SIGNATURE, nothing changed', await code(u.install(info, app, { electron: '44.1.0', fetchFile })) === 'BAD_SIGNATURE' && untouched());
  t('a good update replaces the folder', await code(u.install(info, app, { electron: '44.1.0', key, fetchFile })) === 'OK'
    && fs.readFileSync(path.join(app, 'main.js'), 'utf8') === '// new' && !fs.existsSync(path.join(app, 'stale.txt')) && fs.existsSync(path.join(app, 'src', 'a.js'))
    && fs.readdirSync(path.dirname(app)).join() === 'app');
  t('only an installed copy may update itself', u.canInstall(app) && !u.canInstall(path.join(T, 'inst')) && !u.canInstall(path.join(__dirname, '..')));

  fs.rmSync(T, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
