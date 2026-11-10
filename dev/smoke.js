'use strict';
// End-to-end check against the live Modrinth API, in a throwaway profile:
//   MODION_HEADLESS=1 electron dev/smoke.js <output-dir>
// Drives the real window, installs mods into a temp instance, pokes at the known
// race conditions and failure paths, and saves screenshots.

const electron = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'modion-smoke'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'modion-smoke-'));
const instanceDir = path.join(work, 'instance');
const mods = path.join(instanceDir, 'mods');
fs.mkdirSync(mods, { recursive: true });
fs.mkdirSync(out, { recursive: true });

electron.app.setPath('userData', path.join(work, 'profile'));
// Pick the "mods" folder itself, as people do; the app should step up to the game folder.
let nextPick = mods;
electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [nextPick] });
electron.shell.trashItem = (p) => fs.promises.rm(p, { recursive: true });
// Modion's own data (instances it creates, game files) goes to the throwaway folder too.
process.env.XDG_DATA_HOME = path.join(work, 'data');
// A pretend Prism Launcher: new instances are written here, and "launching" only records the command.
process.env.MODION_PRISM_ROOT = path.join(work, 'prism');
fs.mkdirSync(path.join(work, 'prism', 'instances'), { recursive: true });
const spawned = [];
require('child_process').spawn = (cmd, args) => {
  spawned.push([cmd, ...args]);
  const child = new (require('events'))();
  child.unref = () => {};
  setImmediate(() => child.emit('spawn'));
  return child;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const jars = (prefix) => fs.readdirSync(mods).filter((m) => m.startsWith(prefix));

require('../main.js').ready.then(async (win) => {
  if (!win) throw new Error('the app did not start');
  const wc = win.webContents;
  wc.on('console-message', (e) => {
    // The page's security policy refusing inline styles in a parsed description is it working as intended.
    if (/Applying inline style violates/.test(e.message)) return;
    if (e.level === 'error' || e.level === 'warning') problems.push(`${e.level}: ${e.message}`);
  });
  const js = (code) => wc.executeJavaScript(code, true);
  const waitFor = async (expr, label, ms = 30000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) if (await js(`Boolean(${expr})`)) return;
    throw new Error(`timed out waiting for ${label || expr}`);
  };
  const idle = () => waitFor(`!busy.size && !document.querySelector('#jobs').children.length`, 'installs to finish', 180000);
  const shot = async (name) => {
    await sleep(400);
    wc.invalidate();
    const image = await Promise.race([wc.capturePage(), sleep(5000).then(() => null)]);
    if (!image) throw new Error(`no frame for screenshot ${name}`);
    fs.writeFileSync(path.join(out, name + '.png'), image.toPNG());
  };
  const step = async (name, fn) => {
    try { await fn(); console.log('ok  ', name); } catch (e) { problems.push(`${name}: ${e.message}`); console.log('FAIL', name, '-', e.message); }
  };
  const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

  await step('first run shows the instance picker with detected launchers', async () => {
    await waitFor(`!document.querySelector('#overlay').hidden && document.querySelectorAll('#overlay .list').length === 2`, 'detected list');
    await shot('01-instances');
  });

  await step('add a folder as an instance (picking "mods" resolves to the game folder)', async () => {
    await js(`[...document.querySelectorAll('#overlay .btn')].find(b => b.textContent === 'Add Folder...').click()`);
    await waitFor(`document.querySelector('#overlay .form') && document.querySelectorAll('#overlay .form select')[0].options.length > 20`, 'instance form with versions');
    // Launcher detection finishing late must not replace the form someone is filling in.
    await js(`[...document.querySelectorAll('#overlay .btn')].find(b => b.textContent === 'Detect Launchers').click()`);
    await sleep(800);
    expect(await js(`Boolean(document.querySelector('#overlay .form'))`), 'detection replaced the open form');
    await js(`(() => { const [ver, loader] = document.querySelectorAll('#overlay .form select');
      ver.value = '1.21.1'; ver.dispatchEvent(new Event('change')); loader.value = 'fabric'; loader.dispatchEvent(new Event('change')); })()`);
    await shot('02-instance-form');
    await js(`[...document.querySelectorAll('#overlay .btn')].find(b => b.textContent === 'Save').click()`);
    await waitFor(`S.cfg.instances.length === 1`, 'instance saved');
    expect(await js(`S.cfg.instances[0].path`) === instanceDir, 'instance path is not the game folder');
    await js(`[...document.querySelectorAll('#overlay .btn')].find(b => b.textContent === 'Done').click()`);
  });

  await step('search follows the instance filters, even if an older search answers late', async () => {
    await waitFor(`S.browse.results && document.querySelectorAll('#results .row').length >= 10`, 'search rows');
    expect(await js(`S.browse.gameVersion === '1.21.1' && S.browse.loader === 'fabric'`), 'filters did not follow the instance');
    expect(await js(`S.browse.results.total`) < 60000, 'results are unfiltered (a stale search won)');
    await shot('03-browse');
    // Start a search, then change the query before it answers: only the second may be shown.
    await js(`(() => { S.browse.query = 'lithium'; loadResults(); invalidateResults({ query: 'sodium' }); render(); })()`);
    await waitFor(`S.browse.results && document.querySelector('#results .row-title')`, 'results after racing searches');
    await sleep(1500);
    expect((await js(`document.querySelector('#results .row-title').textContent`)).startsWith('Sodium'), 'a stale search overwrote the newer one');
  });

  await step('typing searches', async () => {
    await js(`(() => { const i = document.querySelector('input[type=search]'); i.value = 'mod menu'; i.dispatchEvent(new Event('input')); })()`);
    expect(await js(`S.browse.query`) === 'mod menu', 'query state lags behind the input');
    await waitFor(`S.browse.results && document.querySelector('#results .row-title')?.textContent.startsWith('Mod Menu')`, 'Mod Menu first');
  });

  await step('project page renders the description safely', async () => {
    await js(`document.querySelector('#results .row').click()`);
    await waitFor(`document.querySelector('.prose') && document.querySelector('.prose').children.length > 3`, 'prose');
    expect(await js(`document.querySelector('.prose').querySelectorAll('script,iframe,[style],[onclick],[onerror]').length`) === 0, 'unsafe nodes in description');
    await sleep(1200);
    await shot('04-project');
  });

  await step('an unrecorded older Fabric API in the folder is recognised, not duplicated', async () => {
    const modrinth = require('../src/modrinth');
    const list = await modrinth.versions('fabric-api', { type: 'mod', gameVersion: '1.21.1', loader: 'fabric' });
    const old = list[list.length - 1];
    const res = await fetch(old.file.url);
    fs.writeFileSync(path.join(mods, old.file.filename), Buffer.from(await res.arrayBuffer()));

    await js(`[...document.querySelectorAll('.tab')].find(b => b.textContent === 'Files').click()`);
    await waitFor(`document.querySelectorAll('.proj .list .row').length > 1`, 'file rows');
    await shot('05-files');
    // Install the second-newest Mod Menu on purpose.
    await js(`document.querySelectorAll('.proj .list .row')[1].querySelector('button[data-install]').click()`);
    await sleep(300);
    expect(await js(`document.querySelector('.play').textContent`) === 'Installing...', 'other buttons for the project do not show the install in progress');
    await js(`[...document.querySelectorAll('.tab')].find(b => b.textContent === 'Description').click()`); // redraw mid-install
    expect(await js(`document.querySelector('.play').disabled`), 'install button re-enabled by a redraw mid-install');
    await idle();
    expect(jars('fabric-api').length === 1 && jars('fabric-api')[0] === old.file.filename, `Fabric API was duplicated or replaced: ${jars('fabric-api')}`);
    expect(jars('modmenu').length === 1, `expected one Mod Menu, got ${jars('modmenu')}`);
    expect(!fs.readdirSync(mods).some((m) => m.endsWith('.part')), 'temp files left behind');
  });

  await step('installing a newer file replaces the older one', async () => {
    const before = jars('modmenu')[0];
    await js(`[...document.querySelectorAll('.tab')].find(b => b.textContent === 'Files').click()`);
    await waitFor(`document.querySelectorAll('.proj .list .row').length > 1`, 'file rows');
    await js(`document.querySelectorAll('.proj .list .row')[0].querySelector('button[data-install]').click()`);
    await sleep(300);
    await idle();
    expect(jars('modmenu').length === 1 && jars('modmenu')[0] !== before, `old version not replaced: ${jars('modmenu')}`);
    expect(await js(`document.querySelectorAll('.proj .list .row')[0].querySelector('button[data-install]').textContent`) === 'Installed', 'file row not marked installed');
    await shot('06-installed');
  });

  await step('two installs that share a dependency do not collide', async () => {
    const result = await js(`(async () => {
      const find = async (query) => (await api('search', { source: 'modrinth', type: 'mod', query, gameVersion: '1.21.1', loader: 'fabric' })).hits[0];
      const [a, b] = await Promise.all([find('sodium extra'), find("reese's sodium options")]);
      const req = (p) => ({ source: 'modrinth', projectId: p.id, type: 'mod', title: p.title, icon: p.icon, gameVersion: '1.21.1', loader: 'fabric' });
      doInstall(req(a)); doInstall(req(a)); // the second click on the same project is ignored
      await Promise.all([api('install', req(b)), new Promise((r) => setTimeout(r, 200))]);
      return [a.title, b.title];
    })()`);
    await idle();
    const all = fs.readdirSync(mods);
    expect(jars('sodium-fabric').length === 1, `Sodium (shared dependency) count: ${jars('sodium-fabric')}`);
    expect(!all.some((m) => m.endsWith('.part')), 'temp files left behind');
    expect(all.filter((m) => /sodium-extra|reeses/i.test(m)).length === 2, `expected both ${result.join(' and ')}: ${all}`);
    const manifest = JSON.parse(fs.readFileSync(path.join(work, 'profile', 'manifest.json'), 'utf8'));
    const tracked = Object.keys(Object.values(manifest)[0]).filter((k) => fs.existsSync(path.join(instanceDir, k)));
    expect(tracked.length === all.length, `manifest tracks ${tracked.length} of ${all.length} files`);
  });

  await step('library lists, identifies, disables and removes files', async () => {
    fs.copyFileSync(path.join(mods, jars('modmenu')[0]), path.join(mods, 'zz-mystery.jar'));
    fs.copyFileSync(path.join(mods, jars('modmenu')[0]), path.join(mods, 'zz-mystery-twin.jar')); // identical content, twice
    fs.writeFileSync(path.join(mods, 'zz-not-a-mod.jar'), 'hello');
    fs.symlinkSync(path.join(work, 'nowhere.jar'), path.join(mods, 'zz-dangling.jar')); // must not break the listing
    await js(`go('library')`);
    await waitFor(`document.querySelectorAll('#view .list .row').length >= 6`, 'library rows');
    const titles = await js(`[...document.querySelectorAll('#view .list .row')].map(r => r.querySelector('.row-title').textContent)`);
    expect(titles.filter((t) => t === 'Mod Menu').length === 3, `identical copies not all identified: ${titles}`);
    expect(titles.includes('zz-not-a-mod.jar') && !titles.includes('zz-dangling.jar'), `unexpected listing: ${titles}`);
    // Two quick clicks on the same switch: only one rename may happen.
    await js(`(() => { const box = document.querySelector('#view .list .row .check input'); box.click(); box.click(); })()`);
    await sleep(1200);
    expect(fs.readdirSync(mods).filter((m) => m.endsWith('.disabled')).length === 1, 'double click did not disable exactly one file');
    expect(!(await js(`document.querySelector('#toasts .red')`)), 'toggling produced an error');
    await shot('08-library');
    const before = fs.readdirSync(mods).length;
    await js(`[...document.querySelectorAll('#view .list .row .btn')].filter(b => b.textContent === 'Remove').pop().click()`);
    await waitFor(`!document.querySelector('#overlay').hidden`, 'confirm screen');
    await shot('09-confirm');
    await js(`[...document.querySelectorAll('#overlay .btn')].find(b => b.textContent === 'Remove').click()`);
    await waitFor(`document.querySelector('#overlay').hidden`, 'confirm closed');
    await sleep(800);
    expect(fs.readdirSync(mods).length === before - 1, 'remove did not delete exactly one file');
  });

  await step('hostile descriptions are neutralised', async () => {
    const report = await js(`(() => {
      const evil = [
        '<img src=x onerror="window.pwned=1"><script>window.pwned=1</scr' + 'ipt>',
        '<a href="javascript:window.pwned=1">x</a> [y](javascript:alert(1)) <iframe src="https://evil.example"></iframe>',
        '<div style="position:fixed" onclick="window.pwned=1">z</div><form action="https://evil.example"><input name=q></form>',
        '\\u00010\\u0001 stray marker',
        'See https://example.com/page. Next sentence.',
        '> '.repeat(5000) + 'deep',
        '- '.repeat(3000) + 'deep',
        '[' .repeat(4000) + 'x',
        '\`'.repeat(4000),
      ].join('\\n\\n');
      const t = performance.now();
      const box = document.createElement('div');
      box.append(Markdown.render({ format: 'markdown', text: evil }));
      box.append(Markdown.render({ format: 'html', text: evil }));
      box.append(Markdown.render(null), Markdown.render({}), Markdown.render({ format: 'markdown', text: null }));
      return {
        ms: Math.round(performance.now() - t),
        bad: box.querySelectorAll('script,iframe,form,input,[style],[onclick],[onerror]').length,
        js: [...box.querySelectorAll('a[href]')].filter(a => !/^https?:/.test(a.getAttribute('href'))).length,
        link: [...box.querySelectorAll('a[href]')].some(a => a.getAttribute('href') === 'https://example.com/page'),
        undef: box.textContent.includes('undefined'),
        pwned: Boolean(window.pwned),
      };
    })()`);
    expect(!report.bad && !report.js && !report.pwned, `unsafe output: ${JSON.stringify(report)}`);
    expect(report.link, 'trailing punctuation was swallowed into a bare link');
    expect(!report.undef, 'placeholder marker leaked into the output');
    expect(report.ms < 3000, `rendering took ${report.ms}ms`);
  });

  await step('a download that fails its checksum leaves nothing behind', async () => {
    const content = require('../src/content');
    const modrinth = require('../src/modrinth');
    const real = (await modrinth.versions('modmenu', { type: 'mod', gameVersion: '1.21.1', loader: 'fabric' }))[0];
    const fake = { fake: { getVersion: async () => ({ ...real, file: { ...real.file, sha512: 'ab'.repeat(64) } }) } };
    const dest = path.join(work, 'saveas');
    const events = [];
    let code = null;
    try { await content.saveTo({ sources: fake }, { source: 'fake', projectId: 'x', versionId: 'y' }, dest, (e) => events.push(e.state)); } catch (e) { code = e.code; }
    expect(code === 'CHECKSUM', `expected a checksum failure, got ${code}`);
    expect(events[events.length - 1] === 'error', 'no error event for the progress bar');
    expect(fs.readdirSync(dest).length === 0, `files left behind: ${fs.readdirSync(dest)}`);
    let bad = null;
    try { await content.saveTo({ sources: { constructor: {} } }, { source: 'toString', projectId: 'x', versionId: 'y' }, dest, () => {}); } catch (e) { bad = e.code; }
    expect(bad === 'BAD_SOURCE', `prototype names accepted as a source: ${bad}`);
  });

  await step('a vanished instance folder is reported, not recreated', async () => {
    const away = instanceDir + '-moved';
    fs.renameSync(instanceDir, away);
    try {
      const r = await js(`window.modion.call('install', { source: 'modrinth', projectId: 'sodium', type: 'mod', gameVersion: '1.21.1', loader: 'fabric' })`);
      expect(!r.ok && r.code === 'NO_FOLDER', `expected NO_FOLDER, got ${JSON.stringify(r).slice(0, 200)}`);
      const l = await js(`window.modion.call('library.list', { type: 'mod' })`);
      expect(!l.ok && l.code === 'NO_FOLDER', `library: expected NO_FOLDER, got ${l.code}`);
      expect(!fs.existsSync(instanceDir), 'the missing folder was recreated');
      expect(Object.keys(await js(`api('config.get').then(c => c.installed)`)).length === 0, 'files of a missing folder still count as installed');
    } finally {
      fs.renameSync(away, instanceDir);
    }
  });

  await step('bad requests are refused cleanly', async () => {
    const codes = await js(`Promise.all([
      window.modion.call('nope'), window.modion.call('constructor'), window.modion.call('search', null),
      window.modion.call('project', { source: 'modrinth' }), window.modion.call('project', { source: '__proto__', id: 'x' }),
      window.modion.call('install', { source: 'modrinth', projectId: 'sodium', type: 'constructor' }),
      window.modion.call('library.toggle', { type: 'mod', file: '../../etc/passwd' }),
      window.modion.call('library.remove', { type: 'mod', file: { evil: true } }),
      window.modion.call('instances.add', { path: '/' }), window.modion.call('openExternal', { url: 'file:///etc/passwd' }),
      window.modion.call('project', { source: 'modrinth', id: 'this-project-does-not-exist-zz9' }),
    ]).then(rs => rs.map(r => r.ok ? 'OK' : r.code))`);
    expect(codes[2] === 'BAD_SOURCE' && !codes.includes('OK') && !codes.includes('ERROR'), `unexpected answers: ${codes}`);
  });

  await step('a new instance is created for Prism Launcher and Play starts it', async () => {
    await js(`go('browse')`);
    expect(!(await js(`Boolean(document.querySelector('.play'))`)), 'a plain folder instance offers Play');
    await js(`openInstances()`);
    expect(!(await js(`document.querySelector('#overlay').textContent.includes('null')`)), 'stray "null" text in the instance dialog');
    await js(`[...document.querySelectorAll('#overlay .btn')].find(b => b.textContent === 'New Instance...').click()`);
    await waitFor(`document.querySelector('#overlay .form')`, 'new instance form');
    await js(`document.querySelector('#overlay .form input').value = 'Smoke: Test/Pack'`);
    await shot('12-new-instance');
    await js(`[...document.querySelectorAll('#overlay .btn')].find(b => b.textContent === 'Create').click()`);
    await waitFor(`S.cfg.instances.length === 2 && !document.querySelector('#overlay .form')`, 'instance created');
    const dir = path.join(work, 'prism', 'instances', 'Smoke TestPack');
    const pack = JSON.parse(fs.readFileSync(path.join(dir, 'mmc-pack.json'), 'utf8'));
    const uids = pack.components.map((c) => `${c.uid}@${c.version}`);
    expect(uids[0] === 'net.minecraft@1.21.1' && uids[1] === 'net.fabricmc.intermediary@1.21.1' && /^net\.fabricmc\.fabric-loader@\d/.test(uids[2]), `unexpected components: ${uids}`);
    expect(fs.readFileSync(path.join(dir, 'instance.cfg'), 'utf8').includes('name=Smoke TestPack\n'), 'instance.cfg has the wrong name');
    expect(await js(`activeInst().path`) === path.join(dir, 'minecraft'), 'the new instance is not the active one');
    let refused = await js(`window.modion.call('instances.create', { name: 'x', gameVersion: '9.9.9', loader: 'fabric' })`);
    expect(!refused.ok && refused.code === 'NO_GAME_VERSION', `made-up game version accepted: ${refused.code}`);
    refused = await js(`window.modion.call('instances.create', { name: 'x', gameVersion: '1.7.10', loader: 'neoforge' })`);
    expect(!refused.ok && refused.code === 'NO_LOADER_VERSION', `impossible loader accepted: ${refused.code}`);
    expect(fs.readdirSync(path.join(work, 'prism', 'instances')).length === 1, 'a refused instance left a folder behind');
    await js(`[...document.querySelectorAll('#overlay .btn')].find(b => b.textContent === 'Done').click()`);
    await waitFor(`document.querySelector('.play')?.textContent === 'Play'`, 'Play button');
    await shot('13-play');
    await js(`(() => { const b = document.querySelector('.play'); b.click(); b.click(); })()`);
    await sleep(600);
    expect(spawned.length === 1 && spawned[0].join(' ') === 'prismlauncher --launch Smoke TestPack', `launch command: ${JSON.stringify(spawned)}`);
    await js(`api('instances.setActive', { id: S.cfg.instances[0].id }).then((c) => { setConfig(c); render(); })`); // back to the test folder
  });

  await step('the launch setting decides what Play does, and says so', async () => {
    const label = () => js(`api('config.get').then((c) => (c.instances[0].launch || {}).label || 'none')`);
    const set = (args) => js(`window.modion.call('settings.setLaunch', ${JSON.stringify(args)}).then((r) => (r.ok ? 'OK' : r.code))`);
    expect(await js(`S.cfg.launchMode`) === 'prism' && await label() === 'none', `default is not Prism: ${await label()}`);
    expect(await set({ mode: 'account' }) === 'OK' && await label() === 'none', 'account mode without a sign-in must not start the game directly');
    if (await js(`S.cfg.offlineAllowed`)) {
      expect(await set({ mode: 'offline', offlineName: 'no' }) === 'BAD_REQUEST', 'a bad player name was accepted');
      expect(await set({ mode: 'offline', offlineName: '' }) === 'OK' && await label() === 'none', 'offline mode without a name must not start the game');
      expect(await set({ mode: 'offline', offlineName: 'Tester_1' }) === 'OK' && await label() === 'Modion, offline as Tester_1', `offline label: ${await label()}`);
      await js(`api('config.get').then((c) => { setConfig(c); go('settings'); })`);
      await shot('14-launch-setting');
    } else {
      expect(await set({ mode: 'offline', offlineName: 'Tester_1' }) === 'FORBIDDEN', 'offline mode is selectable on a machine that is not the developer\'s');
    }
    expect(await set({ mode: 'nonsense' }) === 'OK' && await js(`api('config.get').then((c) => c.launchMode)`) === 'prism', 'an unknown mode did not fall back to Prism');
    await js(`api('config.get').then((c) => { setConfig(c); go('browse'); })`);
  });

  await step('instances page: import a modpack, rename, delete; hostile packs are refused', async () => {
    // Build two .mrpack files: a real one (one mod + a config file) and one that tries to escape the instance folder.
    const real = (await require('../src/modrinth').versions('modmenu', { type: 'mod', gameVersion: '1.21.1', loader: 'fabric' }))[0];
    const index = (files) => JSON.stringify({ formatVersion: 1, game: 'minecraft', versionId: '1', name: 'Smoke Pack', dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.0' }, files });
    const good = [{ path: `mods/${real.file.filename}`, hashes: { sha1: real.file.sha1, sha512: real.file.sha512 }, downloads: [real.file.url], fileSize: real.file.size },
      { path: 'mods/server-only.jar', env: { client: 'unsupported' }, hashes: {}, downloads: ['https://cdn.modrinth.com/nope'], fileSize: 1 },
      { path: 'mods/elsewhere.jar', hashes: {}, downloads: ['https://evil.example/x.jar'], fileSize: 1 }];
    const make = (file, entries) => require('child_process').execFileSync('python3', ['-c',
      'import sys,json,zipfile\nz=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED)\nfor n,d in json.loads(sys.argv[2]): z.writestr(n,d)\nz.close()', file, JSON.stringify(entries)]);
    const goodPack = path.join(work, 'good.mrpack'), slipPack = path.join(work, 'slip.mrpack'), pathPack = path.join(work, 'path.mrpack');
    make(goodPack, [['modrinth.index.json', index(good)], ['overrides/config/smoke.txt', 'hello'], ['overrides/options.txt', 'x']]);
    make(slipPack, [['modrinth.index.json', index([])], ['overrides/../../escaped.txt', 'bad']]);
    make(pathPack, [['modrinth.index.json', index([{ ...good[0], path: '../../escaped.jar' }])]]);
    const prismInstances = path.join(work, 'prism', 'instances');
    const before = fs.readdirSync(prismInstances).length;

    await js(`go('instances')`);
    expect(await js(`document.querySelector('.nav-item').textContent`) === 'Instances', 'Instances is not the first sidebar entry');
    for (const evil of [slipPack, pathPack]) {
      nextPick = evil;
      const r = await js(`window.modion.call('instances.import')`);
      expect(!r.ok && r.code === 'BAD_PACK', `a pack escaping its folder was accepted: ${JSON.stringify(r).slice(0, 160)}`);
    }
    expect(fs.readdirSync(prismInstances).length === before && !fs.existsSync(path.join(work, 'escaped.txt')) && !fs.existsSync(path.join(prismInstances, 'escaped.jar')), 'a refused pack left files behind');
    nextPick = path.join(work, 'missing.mrpack');
    fs.writeFileSync(nextPick, 'not a zip at all');
    expect((await js(`window.modion.call('instances.import')`)).code === 'BAD_PACK', 'a non-zip was accepted');

    nextPick = goodPack;
    const count = await js(`S.cfg.instances.length`);
    await js(`[...document.querySelectorAll('#view .btn')].find(b => b.textContent === 'Import Modpack...').click()`);
    await waitFor(`S.cfg.instances.length === ${count + 1} && S.view === 'instances' && [...document.querySelectorAll('#view .btn')].some(b => b.textContent === 'Import Modpack...')`, 'import to finish', 120000);
    const home = path.join(prismInstances, 'Smoke Pack'), gameDir = path.join(home, 'minecraft');
    expect(fs.existsSync(path.join(gameDir, 'mods', real.file.filename)), 'the pack\'s mod was not downloaded');
    expect(fs.readFileSync(path.join(gameDir, 'config', 'smoke.txt'), 'utf8') === 'hello', 'overrides were not copied');
    expect(fs.readdirSync(path.join(gameDir, 'mods')).length === 1, `server-only or off-site files were fetched: ${fs.readdirSync(path.join(gameDir, 'mods'))}`);
    expect(await js(`activeInst().managed === true && activeInst().name === 'Smoke Pack'`), 'imported instance is not selected and managed');
    await shot('15-instances');

    await js(`[...document.querySelectorAll('#view .row.selected .btn')].find(b => b.textContent === 'Rename').click()`);
    await waitFor(`document.querySelector('#overlay .form input')`, 'rename dialog');
    await js(`document.querySelector('#overlay .form input').value = 'Renamed; Pack'`);
    await js(`[...document.querySelectorAll('#overlay .btn')].find(b => b.textContent === 'Rename').click()`);
    await waitFor(`document.querySelector('#overlay').hidden && activeInst().name === 'Renamed Pack'`, 'rename');
    expect(fs.readFileSync(path.join(home, 'instance.cfg'), 'utf8').includes('name=Renamed Pack\n'), 'Prism\'s copy of the name was not updated');

    // Instances Modion did not make can be forgotten but never renamed or deleted.
    const foreign = await js(`S.cfg.instances[0].id`);
    expect((await js(`window.modion.call('instances.delete', { id: '${foreign}' })`)).code === 'NOT_MANAGED' && fs.existsSync(mods), 'a foreign instance could be deleted');
    expect((await js(`window.modion.call('instances.rename', { id: '${foreign}', name: 'x' })`)).code === 'NOT_MANAGED', 'a foreign instance could be renamed');

    await js(`[...document.querySelectorAll('#view .row.selected .btn')].find(b => b.textContent === 'Delete').click()`);
    await waitFor(`!document.querySelector('#overlay').hidden`, 'delete confirmation');
    await shot('16-delete-confirm');
    await js(`[...document.querySelectorAll('#overlay .btn')].find(b => b.textContent === 'Delete').click()`);
    await waitFor(`S.cfg.instances.length === ${count}`, 'delete');
    expect(!fs.existsSync(home), 'the instance folder is still there');

    // With a setting where Modion starts the game itself, new instances live in Modion's own folder.
    if (await js(`S.cfg.offlineAllowed`)) {
      await js(`window.modion.call('settings.setLaunch', { mode: 'offline', offlineName: 'Tester_1' })`);
      const made = await js(`window.modion.call('instances.create', { name: 'Own One', gameVersion: '1.21.1', loader: 'fabric' })`);
      const own = path.join(work, 'data', 'modion', 'instances', 'Own One');
      expect(made.ok && fs.existsSync(path.join(own, 'minecraft')), `own instance not created: ${JSON.stringify(made).slice(0, 200)}`);
      const inst = made.data.instances[made.data.instances.length - 1];
      expect(inst.launch && inst.launch.label === 'Modion, offline as Tester_1', `own instance launch: ${JSON.stringify(inst.launch)}`);
      const forge = await js(`window.modion.call('instances.create', { name: 'Forge One', gameVersion: '1.20.1', loader: 'forge' })`);
      expect(forge.ok && fs.existsSync(path.join(prismInstances, 'Forge One')), 'a Forge instance did not go to Prism');
      for (const i of [inst, forge.data.instances[forge.data.instances.length - 1]]) await js(`window.modion.call('instances.delete', { id: '${i.id}' })`);
      expect(!fs.existsSync(own) && !fs.existsSync(path.join(prismInstances, 'Forge One')), 'deleted instances left folders');
      await js(`window.modion.call('settings.setLaunch', { mode: 'prism' })`);
    }
    await js(`api('instances.setActive', { id: '${foreign}' }).then((c) => { setConfig(c); go('browse'); })`);
  });

  await step('curseforge without a key explains itself', async () => {
    await js(`go('browse')`);
    await js(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent === 'CurseForge').click()`);
    await waitFor(`document.querySelector('#results .empty .btn')`, 'key notice');
    await shot('10-curseforge-nokey');
    await js(`go('settings')`);
    await shot('11-settings');
  });

  console.log(problems.length ? `\nPROBLEMS:\n${problems.join('\n')}` : '\nNo problems.');
  fs.rmSync(work, { recursive: true, force: true });
  electron.app.exit(problems.length ? 1 : 0);
}).catch((e) => {
  console.log('FAIL smoke run aborted -', e.message);
  fs.rmSync(work, { recursive: true, force: true });
  electron.app.exit(1);
});
