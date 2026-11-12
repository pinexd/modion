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
const realSpawn = require('child_process').spawn;
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
  // Values that leaked into the page as text: a bare "false" or "null", or "undefined",
  // "NaN" and "[object ...]" anywhere outside project descriptions and the game log.
  const strayText = () => js(`(() => {
    const found = [], walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = walk.nextNode());) {
      if (n.parentElement.closest('.prose, .log, script, style')) continue;
      const t = n.data.trim();
      if (/^(false|true|null)$/.test(t) || /\\bundefined\\b|\\bNaN\\b|\\[object /.test(t)) found.push(t.slice(0, 60) + ' (in ' + (n.parentElement.className || n.parentElement.id || n.parentElement.tagName) + ')');
    }
    return found;
  })()`);
  const step = async (name, fn) => {
    try {
      await fn();
      const stray = await strayText();
      if (stray.length) throw new Error('stray text on the page: ' + stray.join('; '));
      console.log('ok  ', name); } catch (e) { problems.push(`${name}: ${e.message}`); console.log('FAIL', name, '-', e.message); }
  };
  const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

  await step('starting the game with the Microsoft account is the default', async () => {
    await waitFor(`S.cfg.version`, 'config');
    expect(await js(`S.cfg.launchMode`) === 'account' && !(await js(`S.cfg.account`)), `default launch mode: ${await js(`S.cfg.launchMode`)}`);
    // The rest of this suite was written around the Prism setting.
    await js(`api('settings.setLaunch', { mode: 'prism', offlineName: '' }).then((c) => setConfig(c))`);
  });

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
    // Starting the game switches to the live log, which follows the file as it grows.
    await waitFor(`S.view === 'library' && S.library.type === 'log' && document.querySelector('.log')`, 'log tab after launch');
    const logs = path.join(dir, 'minecraft', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, 'latest.log'), '[12:00:00] [main/INFO]: first line\n[12:00:01] [main/WARN]: careful\n');
    await waitFor(`document.querySelectorAll('.log > div').length === 2 && document.querySelector('.log .warn')`, 'log lines', 8000);
    fs.appendFileSync(path.join(logs, 'latest.log'), '[12:00:02] [main/ERROR]: broke \u00e9\u00e8\n[12:00:03] half a li');
    await waitFor(`document.querySelectorAll('.log > div').length === 3 && document.querySelector('.log .err').textContent.endsWith('\u00e9\u00e8')`, 'appended line', 8000);
    fs.appendFileSync(path.join(logs, 'latest.log'), 'ne\n');
    await waitFor(`document.querySelectorAll('.log > div').length === 4 && document.querySelector('.log').lastChild.textContent.endsWith('half a line')`, 'line completed later', 8000);
    await shot('18-log');
    fs.writeFileSync(path.join(logs, 'latest.log'), '[13:00:00] [main/INFO]: new session\n'); // the game was restarted
    await waitFor(`document.querySelectorAll('.log > div').length === 1 && document.querySelector('.log').textContent.includes('new session')`, 'restarted log', 8000);
    await js(`S.instancesTab = 'log'; go('instances')`);
    await waitFor(`document.querySelector('.log') && document.querySelector('.log').textContent.includes('new session')`, 'log tab on the instances page', 8000);
    await js(`S.instancesTab = 'all'; go('browse')`);
    expect((await js(`window.modion.call('settings.setOpenLog', { on: false }).then((r) => r.data.openLogOnLaunch)`)) === false, 'the log setting did not switch off');
    await js(`api('config.get').then(setConfig)`);
    spawned.length = 0;
    await sleep(4200); // Play re-enables after a few seconds
    await js(`document.querySelector('.play').click()`);
    await sleep(700);
    expect(spawned.length === 1 && await js(`S.view`) === 'browse', 'with the setting off, launching still switched to the log');
    await js(`window.modion.call('settings.setOpenLog', { on: true })`);
    await js(`api('instances.setActive', { id: S.cfg.instances[0].id }).then((c) => { setConfig(c); render(); })`); // back to the test folder
  });

  await step('the launch setting decides what Play does, and says so', async () => {
    const label = () => js(`api('config.get').then((c) => (c.instances[0].launch || {}).label || 'none')`);
    const set = (args) => js(`window.modion.call('settings.setLaunch', ${JSON.stringify(args)}).then((r) => (r.ok ? 'OK' : r.code))`);
    expect(await label() === 'none', `the Prism setting offered to start a folder Prism does not own: ${await label()}`);
    // The account setting with nobody signed in: Sign In takes the place of Play, and nothing can be started.
    expect(await set({ mode: 'account' }) === 'OK' && await label() === 'Sign in with Microsoft to play', `signed-out label: ${await label()}`);
    await js(`api('config.get').then((c) => { setConfig(c); go('library'); })`);
    await waitFor(`document.querySelector('#bottom .play') && document.querySelector('#bottom .play').textContent === 'Sign In'`, 'Sign In button');
    await shot('13-sign-in');
    const blocked = await js(`window.modion.call('instances.launch', { id: S.cfg.instances[0].id })`);
    expect(blocked.code === 'SIGNED_OUT' && spawned.length === 1, 'the game could be started without signing in');
    if (await js(`S.cfg.offlineAllowed`)) {
      expect(await set({ mode: 'offline', offlineName: 'no' }) === 'BAD_REQUEST', 'a bad player name was accepted');
      expect(await set({ mode: 'offline', offlineName: '' }) === 'OK' && await label() === 'none', 'offline mode without a name must not start the game');
      expect(await set({ mode: 'offline', offlineName: 'Tester_1' }) === 'OK' && await label() === 'Modion, offline as Tester_1', `offline label: ${await label()}`);
      await js(`api('config.get').then((c) => { setConfig(c); go('settings'); })`);
      await shot('14-launch-setting');
    } else {
      expect(await set({ mode: 'offline', offlineName: 'Tester_1' }) === 'FORBIDDEN', 'offline mode is selectable on a machine that is not the developer\'s');
    }
    // Without Prism Launcher the Prism option is greyed out, with a note, and cannot be chosen.
    const launcherMod = require('../src/launcher.js'), wasInstalled = launcherMod.prismInstalled;
    launcherMod.prismInstalled = () => false;
    try {
      await set({ mode: 'account' });
      expect(await set({ mode: 'prism' }) === 'NO_PRISM', 'the Prism setting could be chosen without Prism Launcher');
      await js(`api('config.get').then((c) => { setConfig(c); go('settings'); })`);
      await waitFor(`[...document.querySelectorAll('.settings option')].some(o => o.value === 'prism' && o.disabled) && /only available if Prism Launcher is installed/.test(document.querySelector('.settings').textContent)`, 'greyed-out Prism option');
      await shot('14b-no-prism');
    } finally {
      launcherMod.prismInstalled = wasInstalled;
    }
    expect(await set({ mode: 'nonsense' }) === 'OK' && await js(`api('config.get').then((c) => c.launchMode)`) === 'account', 'an unknown mode did not fall back to the default');
    await set({ mode: 'prism' });
    await js(`api('config.get').then((c) => { setConfig(c); go('browse'); })`);
  });

  await step('instances page: import a modpack, rename, delete; hostile packs are refused', async () => {
    // Build two .mrpack files: a real one (one mod + a config file) and one that tries to escape the instance folder.
    const real = (await require('../src/modrinth').versions('modmenu', { type: 'mod', gameVersion: '1.21.1', loader: 'fabric' }))[0];
    const index = (files) => JSON.stringify({ formatVersion: 1, game: 'minecraft', versionId: '1', name: 'Smoke Pack', dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.0' }, files });
    const good = [{ path: `mods/${real.file.filename}`, hashes: { sha1: real.file.sha1, sha512: real.file.sha512 }, downloads: [real.file.url], fileSize: real.file.size },
      { path: 'mods/server-only.jar', env: { client: 'unsupported' }, hashes: {}, downloads: ['https://cdn.modrinth.com/nope'], fileSize: 1 },
      { path: 'mods/elsewhere.jar', hashes: {}, downloads: ['https://evil.example/x.jar'], fileSize: 1 },
      { path: 'mods/unchecked.jar', hashes: {}, downloads: [real.file.url], fileSize: real.file.size }]; // no checksum: must not be fetched
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

    // With a setting where Modion starts the game itself, new instances live in Modion's own library.
    if (await js(`S.cfg.offlineAllowed`)) {
      const call = (method, args = {}) => js(`window.modion.call('${method}', ${JSON.stringify(args)})`);
      const data = path.join(work, 'data');
      await call('settings.setLaunch', { mode: 'offline', offlineName: 'Tester_1' });
      const made = await call('instances.create', { name: 'Own One', gameVersion: '1.21.1', loader: 'fabric' });
      const own = path.join(data, 'Modion', 'Own One');
      expect(made.ok && fs.existsSync(path.join(own, 'minecraft')), `own instance not created: ${JSON.stringify(made).slice(0, 200)}`);
      const inst = made.data.instances[made.data.instances.length - 1];
      expect(inst.launch && inst.launch.label === 'Modion, offline as Tester_1' && inst.movable, `own instance: ${JSON.stringify(inst)}`);
      expect(JSON.parse(fs.readFileSync(path.join(own, 'instance.json'), 'utf8')).id === inst.id, 'the instance folder does not carry its ID');
      const forge = await call('instances.create', { name: 'Forge One', gameVersion: '1.20.1', loader: 'forge' });
      expect(forge.ok && fs.existsSync(path.join(data, 'Modion', 'Forge One', 'minecraft')) && !fs.existsSync(path.join(prismInstances, 'Forge One')), `a Forge instance did not go to Modion's library: ${JSON.stringify(forge).slice(0, 200)}`);
      const forgeInst = forge.data.instances[forge.data.instances.length - 1];
      expect(forgeInst.launch && forgeInst.launch.label === 'Modion, offline as Tester_1', `forge instance launch: ${JSON.stringify(forgeInst.launch)}`);
      const none = await call('instances.create', { name: 'No Such', gameVersion: '1.0', loader: 'neoforge' });
      expect(!none.ok && none.code === 'NO_LOADER_VERSION', 'NeoForge for 1.0 was accepted');
      expect((await call('instances.delete', { id: forgeInst.id })).ok && !fs.existsSync(path.join(data, 'Modion', 'Forge One')), 'the Forge instance was not deleted');
      fs.writeFileSync(path.join(own, 'minecraft', 'world.dat'), 'precious');
      const cfg = async () => (await call('config.get')).data;
      const lib = (c, dir) => c.libraries.find((l) => l.path === dir);

      // Moved by hand, then added as a library: the instance is found again, same ID.
      const byHand = path.join(work, 'storage', 'modionstuff');
      fs.mkdirSync(byHand, { recursive: true });
      fs.renameSync(own, path.join(byHand, 'Own One'));
      nextPick = byHand;
      let c = (await call('libraries.add')).data;
      let again = c.instances.find((i) => i.id === inst.id);
      expect(again && again.home === path.join(byHand, 'Own One') && c.instances.filter((i) => i.name === 'Own One').length === 1, 'a library moved by hand was not picked up');
      expect(lib(c, byHand).count === 1 && lib(c, path.join(data, 'Modion')).isDefault, `libraries: ${JSON.stringify(c.libraries)}`);

      // Relocate the library: instances move, the library path follows.
      const second = path.join(work, 'storage', 'second');
      nextPick = second;
      const moved = await call('libraries.relocate', { path: byHand });
      c = moved.data.config;
      again = c.instances.find((i) => i.id === inst.id);
      expect(moved.ok && moved.data.moved === 1 && again.path === path.join(second, 'Own One', 'minecraft') && fs.readFileSync(path.join(again.path, 'world.dat'), 'utf8') === 'precious'
        && !fs.existsSync(path.join(byHand, 'Own One')) && lib(c, second) && !lib(c, byHand), `relocate: ${JSON.stringify(moved).slice(0, 300)}`);
      nextPick = second;
      expect((await call('libraries.relocate', { path: second })).code === 'BAD_PATH', 'a library could be relocated onto itself');
      nextPick = path.join(second, 'Own One', 'inner');
      expect((await call('libraries.relocate', { path: second })).code === 'BAD_PATH', 'a library could be relocated into itself');

      // The folder for new instances: choosing one adds it to the libraries, and it cannot be removed while in use.
      const third = path.join(work, 'storage', 'third');
      nextPick = third;
      c = (await call('libraries.setDefault', {})).data;
      expect(lib(c, third) && lib(c, third).isDefault && c.libraries.length === 3, `new default: ${JSON.stringify(c.libraries)}`);
      expect((await call('libraries.remove', { path: third })).code === 'IN_USE', 'the folder for new instances could be removed');
      const two = await call('instances.create', { name: 'Own Two', gameVersion: '1.21.1', loader: '' });
      expect(two.ok && fs.existsSync(path.join(third, 'Own Two', 'minecraft')), 'a new instance did not go to the chosen folder');
      const twoInst = two.data.instances[two.data.instances.length - 1];

      // A running game: Play rests as "Playing", and the red button beside it ends the game.
      const gameMod = require('../src/game.js'), realLaunch = gameMod.launch;
      let pretend;
      gameMod.launch = async (i) => { pretend = realSpawn('sleep', ['300'], { detached: true, stdio: 'ignore' }); gameMod.track(i.path, pretend); return { label: 'Modion', play: true }; };
      try {
        await call('instances.setActive', { id: twoInst.id });
        await js(`api('config.get').then((c) => { setConfig(c); go('browse'); })`);
        await waitFor(`document.querySelector('#bottom .btn.play') && document.querySelector('#bottom .btn.play').textContent === 'Play'`, 'Play button');
        await js(`document.querySelector('#bottom .btn.play').click()`);
        await waitFor(`document.querySelector('#bottom .btn.playing:disabled') && document.querySelector('#bottom .btn.playing').textContent === 'Playing' && document.querySelector('#bottom .stop')`, 'Playing state with a stop button');
        expect((await call('instances.move', { id: twoInst.id })).code === 'BUSY', 'a running instance could be moved');
        await shot('15b-playing');
        // Play and the stop button are centred as a pair.
        const off = await js(`(() => { const w = document.querySelector('#bottom .play-wrap').getBoundingClientRect(), b = document.querySelector('#bottom').getBoundingClientRect(); return Math.abs((w.left + w.right) / 2 - (b.left + b.right) / 2); })()`);
        expect(off < 2, `Play and stop are ${off}px off centre`);
        // Stopping warns first; Cancel leaves the game alone.
        const press = (label) => js(`[...document.querySelectorAll('#overlay .btn')].find(b => b.textContent === '${label}').click()`);
        await js(`document.querySelector('#bottom .stop').click()`);
        await waitFor(`!document.querySelector('#overlay').hidden && /unsaved progress/.test(document.querySelector('#overlay').textContent)`, 'stop warning');
        await shot('15c-stop-warning');
        await press('Cancel');
        await sleep(300);
        expect(pretend.exitCode === null && pretend.signalCode === null && await js(`Boolean(document.querySelector('#bottom .stop'))`), 'Cancel stopped the game');
        await js(`document.querySelector('#bottom .stop').click()`);
        await waitFor(`!document.querySelector('#overlay').hidden`, 'stop warning again');
        await js(`document.querySelector('#overlay input[type=checkbox]').click()`);
        await press('Stop the Game');
        await waitFor(`!document.querySelector('#bottom .stop') && document.querySelector('#bottom .btn.play').textContent === 'Play'`, 'Play button back after stopping');
        expect(pretend.exitCode !== null || pretend.signalCode !== null, 'the game process was not ended');
        expect((await call('instances.stop', { id: twoInst.id })).code === 'NOT_RUNNING', 'stopping a closed game did not say so');
        // The choice was remembered: no warning the next time, and Settings can bring it back.
        await waitFor(`S.cfg.skipStopWarning === true`, 'remembered choice');
        await js(`document.querySelector('#bottom .btn.play').click()`);
        await waitFor(`document.querySelector('#bottom .stop')`, 'running again');
        await js(`document.querySelector('#bottom .stop').click()`);
        await waitFor(`!document.querySelector('#bottom .stop')`, 'stopped without a warning');
        expect(await js(`document.querySelector('#overlay').hidden`), 'the warning came back although it was switched off');
        await js(`go('settings')`);
        await waitFor(`[...document.querySelectorAll('.settings .btn')].some(b => b.textContent === 'Warn Me Again')`, 'the setting that brings the warning back');
        await shot('15d-stop-warning-setting');
        await js(`[...document.querySelectorAll('.settings .btn')].find(b => b.textContent === 'Warn Me Again').click()`);
        await waitFor(`S.cfg.skipStopWarning === false && ![...document.querySelectorAll('.settings .btn')].some(b => b.textContent === 'Warn Me Again')`, 'warning switched back on');
        await js(`go('browse')`);
      } finally {
        gameMod.launch = realLaunch;
        if (pretend) try { process.kill(-pretend.pid, 'SIGKILL'); } catch {}
      }

      // Move a single instance; a name clash is refused and nothing moves.
      nextPick = second;
      c = (await call('instances.move', { id: twoInst.id })).data;
      expect(c.instances.find((i) => i.id === twoInst.id).home === path.join(second, 'Own Two') && fs.existsSync(path.join(second, 'Own Two', 'minecraft')) && !fs.existsSync(path.join(third, 'Own Two')), 'the instance was not moved');
      fs.mkdirSync(path.join(third, 'Own Two'));
      nextPick = third;
      expect((await call('instances.move', { id: twoInst.id })).code === 'EXISTS' && fs.existsSync(path.join(second, 'Own Two', 'minecraft')), 'a move onto an existing folder was not refused');
      expect((await call('instances.move', { id: foreign })).code === 'NOT_MANAGED', 'an instance from elsewhere could be moved');

      // Removing a library takes its instances off the list and leaves the files alone.
      await js(`api('config.get').then((c) => { setConfig(c); go('settings'); })`);
      await waitFor(`[...document.querySelectorAll('.panel h2')].some((x) => x.textContent === 'Instance libraries') && document.querySelectorAll('.settings .list .row').length === 3`, 'libraries panel');
      await shot('17-libraries');
      await js(`go('instances')`);
      await waitFor(`[...document.querySelectorAll('#view .row .btn')].filter((x) => x.textContent === 'Move...').length === 2`, 'Move buttons');
      c = (await call('libraries.remove', { path: second })).data;
      expect(!c.instances.some((i) => i.id === inst.id || i.id === twoInst.id) && fs.existsSync(path.join(second, 'Own One', 'minecraft', 'world.dat')), 'removing a library did not just unlist its instances');
      await call('settings.setLaunch', { mode: 'prism' });
      await js(`api('config.get').then((c) => setConfig(c))`);
    }
    await js(`api('instances.setActive', { id: '${foreign}' }).then((c) => { setConfig(c); go('browse'); })`);
  });

  await step('modpacks tab: listed first, mods still the default, a pack installs as a new instance', async () => {
    await js(`go('browse')`);
    await waitFor(`document.querySelectorAll('#top .tab').length === 5`, 'browse tabs');
    expect(await js(`[...document.querySelectorAll('#top .tab')].map(t => t.textContent).join('|')`) === 'Modpacks|Mods|Resource Packs|Shaders|Data Packs', 'the tabs are not in the expected order');
    expect(await js(`document.querySelector('#top .tab.on').textContent`) === 'Mods', 'Mods is not the tab selected by default');
    const before = await js(`({ v: S.browse.gameVersion, l: S.browse.loader, n: S.cfg.instances.length })`);
    await js(`document.querySelector('#top .tab').click()`);
    await waitFor(`S.browse.type === 'modpack' && S.browse.results && document.querySelectorAll('#results .row').length > 5`, 'modpack results');
    expect(await js(`S.browse.gameVersion === '' && S.browse.loader === '' && !document.querySelector('.bar.warn')`), 'the modpack tab kept the instance filters or warned about them');
    expect(await js(`S.browse.results.hits.every(h => h.type === 'modpack')`), 'something other than modpacks was listed');
    await shot('20-modpacks');
    // Install a small, known pack by its files tab request (the same call the buttons make).
    const pack = await js(`api('search', { source: 'modrinth', type: 'modpack', query: 'Fabulously Optimized', sort: 'relevance' }).then(r => r.hits[0])`);
    expect(pack && /Fabulously/.test(pack.title), `pack search: ${JSON.stringify(pack).slice(0, 120)}`);
    await js(`doPackInstall({ source: 'modrinth', projectId: '${pack.id}', type: 'modpack', title: 'Fabulously Optimized', gameVersion: '1.20.1', loader: 'fabric' })`);
    await waitFor(`S.cfg.instances.length === ${before.n + 1} && !busy.size`, 'pack instance', 240000);
    const made = await js(`S.cfg.instances[S.cfg.instances.length - 1]`);
    expect(made.gameVersion === '1.20.1' && made.loader === 'fabric' && made.managed && made.id === await js(`S.cfg.activeInstanceId`), `pack instance: ${JSON.stringify(made).slice(0, 200)}`);
    expect(fs.readdirSync(path.join(made.path, 'mods')).filter((f) => f.endsWith('.jar')).length > 5, 'the pack\'s mods were not downloaded');
    expect(!fs.readdirSync(os.tmpdir()).some((n) => n.startsWith('modion-pack-')), 'the downloaded pack file was left behind');
    // Leaving the tab brings the instance's filters back.
    await js(`[...document.querySelectorAll('#top .tab')][1].click()`);
    await waitFor(`S.browse.type === 'mod' && S.browse.gameVersion === '1.20.1' && S.browse.loader === 'fabric'`, 'filters to follow the new instance');
    await js(`window.modion.call('instances.delete', { id: '${made.id}' })`);
    await js(`api('config.get').then((c) => setConfig(c, { follow: true }))`);
    await waitFor(`S.cfg.instances.length === ${before.n}`, 'cleanup');
  });

  await step('a website-only modpack goes through the CurseForge page and becomes an instance', async () => {
    const cf = require('../src/curseforge'), web = require('../src/webinstall');
    const real = { latest: cf.latest, getVersion: cf.getVersion, brief: cf.brief, open: web.open };
    const blocked = { id: '77', name: 'Blocked Pack', file: null, expected: { filename: 'blocked-pack.zip', size: 0 } };
    let opened = null;
    cf.latest = async () => blocked;
    cf.getVersion = async () => blocked;
    cf.brief = async () => ({ title: 'Blocked Pack', url: 'https://www.curseforge.com/minecraft/modpacks/blocked-pack/' });
    web.open = async (o) => {
      opened = o;
      const tmp = path.join(o.destDir, 'blocked-pack.zip.part');
      fs.copyFileSync(path.join(work, 'good.mrpack'), tmp); // stands in for the file the person downloads
      return { tmp, filename: 'blocked-pack.zip' };
    };
    try {
      const n = await js(`S.cfg.instances.length`);
      await js(`doPackInstall({ source: 'curseforge', projectId: '5', type: 'modpack', title: 'Blocked Pack' })`);
      await waitFor(`S.cfg.instances.length === ${n + 1} && !busy.size`, 'instance from the website download', 120000);
      expect(opened && opened.url === 'https://www.curseforge.com/minecraft/modpacks/blocked-pack/files/77' && opened.expect.filename === 'blocked-pack.zip'
        && opened.siteHosts.join() === 'curseforge.com', `website window: ${JSON.stringify(opened && { url: opened.url, hosts: opened.siteHosts })}`);
      const made = await js(`S.cfg.instances[S.cfg.instances.length - 1]`);
      expect(fs.readdirSync(path.join(made.path, 'mods')).length === 1 && !fs.existsSync(opened.destDir), 'the pack was not unpacked, or its download was left behind');
      // Closing the window without downloading is not an error to shout about.
      web.open = async () => { throw Object.assign(new (require('../src/http').ApiError)('closed', 'CANCELLED')); };
      await js(`doPackInstall({ source: 'curseforge', projectId: '5', type: 'modpack', title: 'Blocked Pack' })`);
      await waitFor(`!busy.size`, 'cancelled install to settle');
      expect(await js(`S.cfg.instances.length`) === n + 1 && !(await js(`[...document.querySelectorAll('#toasts .toast')].some(t => /not installed/i.test(t.textContent))`)), 'a cancelled website download was reported as a failure');
      await js(`window.modion.call('instances.delete', { id: '${made.id}' })`);
      await js(`api('config.get').then((c) => setConfig(c, { follow: true }))`);
    } finally {
      Object.assign(cf, { latest: real.latest, getVersion: real.getVersion, brief: real.brief });
      web.open = real.open;
    }
  });

  await step('mods a pack had to leave out are listed and fetched one by one from the website', async () => {
    const cf = require('../src/curseforge'), web = require('../src/webinstall'), { writeZip } = require('../src/zip'), { ApiError } = require('../src/http');
    const real = { hasKey: cf.hasKey, getFiles: cf.getFiles, getVersion: cf.getVersion, brief: cf.brief, open: web.open };
    const mod = (await require('../src/modrinth').versions('modmenu', { type: 'mod', gameVersion: '1.21.1', loader: 'fabric' }))[0];
    const blockedFile = (id, name) => ({ id: String(id), projectId: String(id * 10), name, versionNumber: `${name}.jar`, file: null, expected: { filename: `${name}.jar`, size: 0 }, gameVersions: [], loaders: [], dependencies: [] });
    const files = { 1: { id: '1', projectId: '10', name: 'Mod Menu', file: mod.file }, 2: blockedFile(2, 'blocked-a'), 3: blockedFile(3, 'blocked-b') };
    cf.hasKey = () => true;
    cf.getFiles = async (ids) => ids.map((i) => files[i]).filter(Boolean);
    cf.getVersion = async (_p, v) => files[v];
    const withIcon = true;
    cf.brief = async (p) => ({ title: `project ${p}`, icon: withIcon ? 'https://example.com/logo.png' : null, url: `https://www.curseforge.com/minecraft/mc-mods/p${p}` });
    const packFile = path.join(work, 'cf-pack.zip');
    writeZip(packFile, [{ name: 'manifest.json', data: Buffer.from(JSON.stringify({
      name: 'Left Out Pack', minecraft: { version: '1.21.1', modLoaders: [{ id: 'fabric-0.16.0', primary: true }] }, overrides: 'overrides',
      files: [1, 2, 3].map((n) => ({ projectID: n * 10, fileID: n, required: true })) })) }]);
    const opens = [];
    let closeFirst = true;
    web.open = async (o) => {
      opens.push(o.url);
      if (closeFirst) { closeFirst = false; throw new ApiError('closed', 'CANCELLED'); } // the person closes the first window
      const tmp = path.join(o.destDir, `${o.expect.filename}.part`);
      fs.mkdirSync(o.destDir, { recursive: true });
      fs.writeFileSync(tmp, 'jar');
      return { tmp, filename: o.expect.filename };
    };
    try {
      await js(`go('instances')`);
      nextPick = packFile;
      await js(`[...document.querySelectorAll('#view .btn')].find(b => b.textContent === 'Import Modpack...').click()`);
      await waitFor(`!document.querySelector('#overlay').hidden && document.querySelectorAll('#overlay .step').length === 2`, 'left-out list', 120000);
      const inst = await js(`S.cfg.instances[S.cfg.instances.length - 1]`);
      expect(inst.leftOut && inst.leftOut.length === 2 && fs.readdirSync(path.join(inst.path, 'mods')).length === 1, `left-out record: ${JSON.stringify(inst.leftOut)}`);
      expect(await js(`[...document.querySelectorAll('#overlay .status')].every(x => x.classList.contains('pending'))`), 'the files do not start as pending');
      await shot('22-left-out');
      await js(`[...document.querySelectorAll('#overlay .btn')].find(b => b.textContent === 'Install Them One by One').click()`);
      // The first window is "closed": a second question appears over the list.
      await waitFor(`document.querySelector('#overlay .sub-dialog') && !document.querySelector('#overlay .sub-dialog').hidden`, 'skip-or-reopen question');
      expect(await js(`document.querySelector('#overlay .status').classList.contains('working')`), 'the mod in hand is not marked as in progress');
      await shot('23-left-out-closed');
      await js(`[...document.querySelectorAll('#overlay .sub-dialog .btn')].find(b => b.textContent === 'Re-open the Window').click()`);
      await waitFor(`[...document.querySelectorAll('#overlay .status')].every(x => x.classList.contains('done'))`, 'both files installed');
      expect(opens.length === 3 && opens[0] === opens[1] && /\/p20\/files\/2$/.test(opens[0]) && /\/p30\/files\/3$/.test(opens[2]), `pages opened: ${opens.join(' ')}`);
      const mods = fs.readdirSync(path.join(inst.path, 'mods')).sort();
      expect(mods.includes('blocked-a.jar') && mods.includes('blocked-b.jar') && mods.length === 3, `mods folder: ${mods.join()}`);
      expect(!(await js(`S.cfg.instances.find(i => i.id === '${inst.id}').leftOut`)), 'installed files stayed on the left-out list');
      await shot('24-left-out-done');
      // The fetched files carry their project's name and icon, not the file's.
      await js(`window.modion.call('instances.setActive', { id: '${inst.id}' })`);
      const fetched = async () => (await js(`window.modion.call('library.list', { type: 'mod' })`)).data.files.filter((f) => /^blocked-/.test(f.file));
      const got = await fetched();
      expect(got.length === 2 && got.every((f) => f.meta && /^project \d0$/.test(f.meta.title) && f.meta.icon === 'https://example.com/logo.png'), `website files in the library: ${JSON.stringify(got)}`);
      // Files recorded before this was done are asked about once and corrected.
      const old = { source: 'curseforge', projectId: '20', title: 'blocked-a', icon: null };
      let saved = 0;
      await require('../src/content.js').nameAdopted({ store: { saveManifest: () => saved++ }, sources: { curseforge: cf } }, [old]);
      expect(old.title === 'project 20' && old.icon && old.briefed && saved === 1, `an old record was not corrected: ${JSON.stringify(old)}`);
      await js(`closeScreen()`);

      // Skipping keeps the file on the list, and the instance row offers it again.
      await js(`window.modion.call('instances.delete', { id: '${inst.id}' })`);
      closeFirst = true;
      nextPick = packFile;
      await js(`api('config.get').then((c) => { setConfig(c); render(); })`);
      await js(`[...document.querySelectorAll('#view .btn')].find(b => b.textContent === 'Import Modpack...').click()`);
      await waitFor(`!document.querySelector('#overlay').hidden && document.querySelectorAll('#overlay .step').length === 2`, 'left-out list again', 120000);
      await js(`[...document.querySelectorAll('#overlay .btn')].find(b => b.textContent === 'Install Them One by One').click()`);
      await waitFor(`document.querySelector('#overlay .sub-dialog') && !document.querySelector('#overlay .sub-dialog').hidden`, 'question again');
      await js(`[...document.querySelectorAll('#overlay .sub-dialog .btn')].find(b => b.textContent === 'Skip This Mod').click()`);
      await waitFor(`document.querySelectorAll('#overlay .status.skipped').length === 1 && document.querySelectorAll('#overlay .status.done').length === 1`, 'one skipped, one installed');
      await js(`closeScreen()`);
      await waitFor(`[...document.querySelectorAll('#view .btn')].some(b => b.textContent === 'Left Out (1)')`, 'reminder on the instance row');
      const again = await js(`S.cfg.instances[S.cfg.instances.length - 1].id`);
      await js(`window.modion.call('instances.delete', { id: '${again}' })`);
      await js(`api('config.get').then((c) => { setConfig(c, { follow: true }); render(); })`);
    } finally {
      Object.assign(cf, { hasKey: real.hasKey, getFiles: real.getFiles, getVersion: real.getVersion, brief: real.brief });
      web.open = real.open;
    }
  });

  await step('files only CurseForge knows are named in the library', async () => {
    const cf = require('../src/curseforge');
    const real = { hasKey: cf.hasKey, identify: cf.identify, fingerprints: cf.fingerprints };
    let asked = 0;
    cf.hasKey = () => true;
    cf.fingerprints = async () => ({});
    cf.identify = async (prints) => { asked++; return Object.fromEntries(prints.slice(0, 1).map((p) => [p, { source: 'curseforge', projectId: '4242', versionId: '9', versionName: '1.0', title: 'Only On CurseForge', icon: null }])); };
    try {
      await js(`api('instances.setActive', { id: S.cfg.instances[0].id }).then((c) => setConfig(c))`);
      fs.writeFileSync(path.join(mods, 'cf-only-mod.jar'), 'not on modrinth ' + Date.now());
      fs.writeFileSync(path.join(mods, 'nobody-knows.jar'), 'nobody knows this one ' + Date.now());
      const find = (list, file) => list.files.find((f) => f.file === file);
      let list = (await js(`window.modion.call('library.list', { type: 'mod' })`)).data;
      const named = find(list, 'cf-only-mod.jar'), stranger = find(list, 'nobody-knows.jar');
      expect(named && named.meta && named.meta.title === 'Only On CurseForge' && named.meta.source === 'curseforge' && named.meta.projectId === '4242', `CurseForge-only file: ${JSON.stringify(named)}`);
      expect(stranger && !(stranger.meta && stranger.meta.projectId), `a file nobody knows was named: ${JSON.stringify(stranger)}`);
      list = (await js(`window.modion.call('library.list', { type: 'mod' })`)).data;
      expect(asked === 1 && find(list, 'cf-only-mod.jar').meta.title === 'Only On CurseForge', `CurseForge was asked ${asked} times for the same files`);
      fs.rmSync(path.join(mods, 'cf-only-mod.jar'));
      fs.rmSync(path.join(mods, 'nobody-knows.jar'));
    } finally {
      Object.assign(cf, real);
    }
  });

  await step('instance icons: pick a picture, choose how it fits, remove it; a pack brings its own', async () => {
    const zlib = require('zlib');
    // A plain-colour PNG of the given size, written by hand.
    const png = (w, h, file) => {
      const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body)); return Buffer.concat([len, body, crc]); };
      const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 2;
      const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x80)]);
      fs.writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]));
      return file;
    };
    const wide = png(200, 100, path.join(work, 'wide.png')), square = png(60, 60, path.join(work, 'square.png'));
    await js(`go('instances')`);
    const id = await js(`S.cfg.instances[0].id`);
    const size = () => js(`(async () => { const i = S.cfg.instances.find(x => x.id === '${id}'); if (!i.icon) return 'none'; const img = await loadImage(i.icon); return img.naturalWidth + 'x' + img.naturalHeight; })()`);
    const clickIcon = () => js(`document.querySelectorAll('#view .row')[0].querySelector('.icon-edit').click()`);
    const press = (label) => js(`[...document.querySelectorAll('#overlay button')].find(b => b.textContent.startsWith('${label}')).click()`);
    expect(await size() === 'none' && await js(`Boolean(document.querySelector('#view .icon-edit .pencil'))`), 'the instance does not start with the standard icon and a pencil');

    nextPick = wide;
    await clickIcon();
    await waitFor(`document.querySelectorAll('#overlay .fit').length === 3`, 'fit choices for a picture that is not square');
    await shot('25-icon-fit');
    await press('Crop to fit');
    await waitFor(`S.cfg.instances.find(x => x.id === '${id}').icon`, 'icon saved');
    expect(await size() === '128x128', `cropped icon is ${await size()}`);
    expect(await js(`!document.querySelector('#view .row .icon-edit img').classList.contains('px')`), 'the row still shows the standard icon');

    await clickIcon(); // it has an icon now: the choice between a new picture and removing it
    await waitFor(`[...document.querySelectorAll('#overlay button')].some(b => b.textContent === 'Remove Icon')`, 'change-or-remove screen');
    await press('Choose Picture');
    await waitFor(`document.querySelectorAll('#overlay .fit').length === 3`, 'fit choices again');
    await press('Leave as is');
    await waitFor(`!document.querySelector('#overlay .fit')`, 'choice made');
    await sleep(300);
    expect(await size() === '128x64', `as-is icon is ${await size()}`);
    await clickIcon();
    await waitFor(`[...document.querySelectorAll('#overlay button')].some(b => b.textContent === 'Remove Icon')`, 'change-or-remove screen');
    await press('Choose Picture');
    await waitFor(`document.querySelectorAll('#overlay .fit').length === 3`, 'fit choices a third time');
    await press('Stretch to fit');
    await sleep(400);
    expect(await size() === '128x128', `stretched icon is ${await size()}`);

    nextPick = square; // a square picture needs no question
    await clickIcon();
    await waitFor(`[...document.querySelectorAll('#overlay button')].some(b => b.textContent === 'Remove Icon')`, 'change-or-remove screen');
    await press('Choose Picture');
    await sleep(600);
    expect(await js(`document.querySelector('#overlay').hidden`) && await size() === '128x128', 'a square picture was not applied directly');
    expect(fs.existsSync(path.join(work, 'profile', 'icons', `${id}.png`)), 'the icon file was not written');

    const bad = (v) => js(`window.modion.call('instances.setIcon', { id: '${id}', png: ${JSON.stringify(v)} }).then(r => r.code || 'OK')`);
    expect(await bad('data:image/png;base64,' + Buffer.from('not a png at all, just text of some length').toString('base64')) === 'BAD_IMAGE'
      && await bad('data:text/html;base64,PGI+') === 'BAD_IMAGE' && await bad('data:image/png;base64,' + fs.readFileSync(png(400, 400, path.join(work, 'big.png'))).toString('base64')) === 'BAD_IMAGE', 'something that is not a small PNG was stored as an icon');

    // A modpack's icon from the site.
    const pack = await js(`api('search', { source: 'modrinth', type: 'modpack', query: 'Fabulously Optimized' }).then(r => r.hits[0])`);
    await js(`window.modion.call('instances.removeIcon', { id: '${id}' }).then(r => setConfig(r.data))`);
    expect(await size() === 'none', 'the icon was not removed');
    await js(`adoptPackIcon('${id}', ${JSON.stringify(pack.icon)})`);
    expect(await size() === '128x128', `pack icon is ${await size()}`);
    await shot('26-icons');
    // The same picture wherever the instance is shown: the bottom bar, the picker, its settings screen.
    await js(`api('instances.setActive', { id: '${id}' }).then((c) => { setConfig(c); render(); })`);
    await waitFor(`document.querySelector('#bottom .inst-btn img') && !document.querySelector('#bottom .inst-btn img').classList.contains('px')`, 'icon in the bottom bar');
    await js(`openInstances()`);
    await waitFor(`document.querySelectorAll('#overlay .row .slot img').length > 0`, 'icons in the instance picker');
    expect(await js(`(() => { const imgs = [...document.querySelectorAll('#overlay .list')[0].querySelectorAll('.row .slot img')]; return imgs.length === S.cfg.instances.length && !imgs[0].classList.contains('px') && imgs[0].src === S.cfg.instances[0].icon; })()`), 'the picker does not show each instance with its icon');
    await shot('27-picker-icons');
    await js(`closeScreen()`);
    await js(`go('instances')`);
    await js(`[...document.querySelectorAll('#view .row')[0].querySelectorAll('.btn')].find(b => b.textContent === 'Settings').click()`);
    await waitFor(`document.querySelector('#overlay .whose img') && !document.querySelector('#overlay .whose img').classList.contains('px')`, 'icon on the settings screen');
    await js(`closeScreen()`);
    await clickIcon();
    await waitFor(`[...document.querySelectorAll('#overlay button')].some(b => b.textContent === 'Remove Icon')`, 'change-or-remove screen');
    await press('Remove Icon');
    await waitFor(`!S.cfg.instances.find(x => x.id === '${id}').icon`, 'icon removed');
    expect(!fs.existsSync(path.join(work, 'profile', 'icons', `${id}.png`)), 'the icon file was left behind');
  });

  await step('theme: Classic by default, Fancy from the Settings dropdown', async () => {
    const fancy = () => js(`!document.getElementById('fancy').disabled`);
    const shadow = () => js(`getComputedStyle(document.querySelector('#rail')).boxShadow`);
    expect(await js(`S.cfg.theme`) === 'classic' && !(await fancy()) && await shadow() === 'none', 'the classic look is not the default');
    await js(`go('settings')`);
    const pick = (v) => js(`(() => { const s = [...document.querySelectorAll('.settings select')].find(x => [...x.options].some(o => o.value === 'fancy')); s.value = '${v}'; s.dispatchEvent(new Event('change')); })()`);
    await pick('fancy');
    await waitFor(`S.cfg.theme === 'fancy' && !document.getElementById('fancy').disabled && getComputedStyle(document.querySelector('#rail')).boxShadow !== 'none'`, 'fancy theme applied');
    await shot('28-fancy');
    expect((await js(`window.modion.call('settings.setTheme', { theme: 'nonsense' }).then((r) => r.data.theme)`)) === 'classic', 'an unknown theme was accepted');
    await pick('fancy');
    await waitFor(`S.cfg.theme === 'fancy'`, 'fancy again');
    await pick('classic');
    await waitFor(`S.cfg.theme === 'classic' && document.getElementById('fancy').disabled`, 'back to classic');
    expect(await shadow() === 'none', 'classic still shows fancy styles');
    await js(`go('browse')`);
  });

  await step('instance settings: Java, memory slider, arguments and environment', async () => {
    await js(`go('instances')`);
    const id = await js(`S.cfg.instances[0].id`);
    const call = (method, args = {}) => js(`window.modion.call('${method}', ${JSON.stringify(args)})`);
    const info = (await call('instances.settings', { id })).data;
    expect(info && info.settings.memory === null && info.totalMemory > 1024 && Array.isArray(info.javas), `settings info: ${JSON.stringify(info).slice(0, 200)}`);
    await js(`[...document.querySelectorAll('#view .row')[0].querySelectorAll('.btn')].find(b => b.textContent === 'Settings').click()`);
    await waitFor(`document.querySelector('#overlay .range')`, 'settings screen');
    expect(await js(`document.querySelector('#overlay .range').disabled`), 'the slider is not off while memory is automatic');
    await js(`(() => { const a = document.querySelectorAll('#overlay textarea')[0]; a.value = '-Xmx3G -Dx="a b"'; a.dispatchEvent(new Event('input')); })()`);
    expect(await js(`document.querySelector('#overlay .range').disabled && /Remove those/.test(document.querySelector('#overlay').textContent)`), 'the slider is not greyed out with a note when the arguments set -Xmx');
    await js(`(() => { const a = document.querySelectorAll('#overlay textarea')[0]; a.value = '-Dx="a b"'; a.dispatchEvent(new Event('input')); document.querySelector('#overlay .check input').click(); })()`);
    expect(!(await js(`document.querySelector('#overlay .range').disabled`)), 'the slider did not come back');
    await js(`(() => { const r = document.querySelector('#overlay .range'); r.value = 2048; r.dispatchEvent(new Event('input')); document.querySelectorAll('#overlay textarea')[1].value = 'MODION_TEST=1\\nOTHER=a=b'; })()`);
    await shot('18-instance-settings');
    await js(`[...document.querySelectorAll('#overlay .btn')].find(b => b.textContent === 'Save').click()`);
    await waitFor(`document.querySelector('#overlay').hidden`, 'settings saved');
    const saved = await js(`S.cfg.instances[0].settings`);
    expect(saved && saved.memory === 2048 && saved.jvmArgs === '-Dx="a b"' && saved.env === 'MODION_TEST=1\nOTHER=a=b' && saved.java === '', `saved settings: ${JSON.stringify(saved)}`);
    expect((await call('instances.setSettings', { id, memory: 64 })).code === 'BAD_REQUEST', 'too little memory was accepted');
    expect((await call('instances.setSettings', { id, memory: null, env: 'not a variable' })).code === 'BAD_REQUEST', 'a bad environment line was accepted');
    expect((await call('instances.setSettings', { id, memory: null, java: '/bin/sh' })).code === 'BAD_JAVA', 'a Java nobody offered was accepted');
    const cleared = await call('instances.setSettings', { id, memory: null, jvmArgs: '', env: '', java: '' });
    expect(cleared.ok && !cleared.data.instances[0].settings, 'default settings were not cleared');
    await js(`api('config.get').then((c) => setConfig(c))`);
  });

  await step('an available update is offered, never installed unasked', async () => {
    const updater = require('../src/updater.js');
    const real = { check: updater.check, canInstall: updater.canInstall };
    let installs = 0;
    updater.install = async () => { installs++; };
    updater.check = async () => ({ version: '9.9.9', name: 'Modion 9.9.9', notes: 'Something new.\n<b>not markup</b>', page: 'https://github.com/pinexd/modion/releases', payload: { url: 'x', sig: 'y', size: 1 } });
    try {
      await js(`go('settings')`);
      await waitFor(`[...document.querySelectorAll('.panel h2')].some((x) => x.textContent === 'Updates')`, 'updates panel');
      await js(`[...document.querySelectorAll('.settings .btn')].find(b => b.textContent === 'Check Now').click()`);
      await waitFor(`!document.querySelector('#overlay').hidden && /Modion 9\.9\.9 is available/.test(document.querySelector('#overlay').textContent)`, 'update screen');
      // This copy runs from the source folder, so it must offer the download page, not an install.
      expect(await js(`[...document.querySelectorAll('#overlay .btn')].map(b => b.textContent).join('|')`) === 'Later|Open Download Page', 'a source checkout was offered a self-update: ' + await js(`[...document.querySelectorAll('#overlay .btn')].map(b => b.textContent).join('|')`));
      expect(await js(`!document.querySelector('#overlay b') && document.querySelector('#overlay .notes').textContent.includes('<b>not markup</b>')`), 'release notes were treated as markup');
      expect((await js(`window.modion.call('update.install')`)).code === 'NOT_INSTALLABLE' && installs === 0, 'an install was possible from a source checkout');
      updater.canInstall = () => true;
      await js(`closeScreen()`);
      await js(`checkForUpdate(true)`);
      await waitFor(`[...document.querySelectorAll('#overlay .btn')].some(b => b.textContent === 'Update and Restart')`, 'install button');
      await shot('19-update');
      expect(installs === 0, 'the update was installed without being asked');
      await js(`closeScreen()`);
      updater.check = async () => null;
      await js(`checkForUpdate(true)`);
      await waitFor(`[...document.querySelectorAll('#toasts .toast')].some(t => /newest version/.test(t.textContent))`, 'no-update message');
      expect((await js(`window.modion.call('update.install')`)).code === 'BAD_REQUEST' && installs === 0, 'an install ran with no update found');
    } finally {
      Object.assign(updater, real);
    }
  });

  await step('page bar: neighbours, last page, and typing a page number', async () => {
    await js(`invalidateResults({ source: 'modrinth', type: 'mod', query: '', categories: [] }); go('browse')`);
    const labels = () => js(`[...document.querySelectorAll('#pager .pages > *')].map(x => x.classList.contains('arrow') ? (x.disabled ? '(' : '<') : x.textContent + (x.classList.contains('on') ? '*' : '')).join(' ')`);
    const on = (n) => waitFor(`document.querySelector('#pager .pg.on') && document.querySelector('#pager .pg.on').textContent === '${n}' && S.browse.results && S.browse.page === ${n - 1}`, `page ${n}`);
    await on(1);
    const last = await js(`[...document.querySelectorAll('#pager .pg:not(.arrow)')].pop().textContent`);
    expect(await labels() === `( 1* 2 ... ${last} <`, `first page bar: ${await labels()}`);
    await js(`[...document.querySelectorAll('#pager .pg')].find(x => x.textContent === '2').click()`);
    await on(2);
    expect(await labels() === `< 1 2* 3 ... ${last} <`, `second page bar: ${await labels()}`);
    // "..." becomes a box: a page out of range is refused, a good one is opened.
    const type = (v, key) => js(`(() => { const b = document.querySelector('#pager .pg-box'); b.value = '${v}'; b.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true })); })()`);
    await js(`document.querySelector('#pager .dots').click()`);
    await type('0', 'Enter');
    expect(await js(`document.querySelector('#pager .pg-box').classList.contains('bad')`) && await js(`S.browse.page`) === 1, 'page 0 was accepted');
    await type('', 'Escape');
    expect(await js(`Boolean(document.querySelector('#pager .dots')) && !document.querySelector('#pager .pg-box')`), 'Escape did not put the dots back');
    await js(`document.querySelector('#pager .dots').click()`);
    await type('5', 'Enter');
    await on(5);
    await shot('29-pages');
    await js(`[...document.querySelectorAll('#pager .pg.arrow')].pop().click()`);
    await on(6);
    await js(`[...document.querySelectorAll('#pager .pg:not(.arrow)')].pop().click()`);
    await waitFor(`S.browse.results && document.querySelector('#pager .pg.on') && document.querySelector('#pager .pg.on').textContent === '${last}'`, 'last page');
    expect((await labels()).endsWith(`${last}* (`), `last page bar: ${await labels()}`);
    await js(`invalidateResults({}); go('browse')`);
  });

  await step('category filter, filter-mismatch warning, and back/forward buttons', async () => {
    await js(`go('browse')`);
    await waitFor(`S.browse.results && document.querySelectorAll('#view .multi-menu .check').length > 8`, 'category menu');
    const all = await js(`S.browse.results.total`);
    const tick = (name) => js(`[...document.querySelectorAll('#view .multi-menu .check')].find(l => l.textContent === '${name}').querySelector('input').click()`);
    await js(`document.querySelector('#view .multi-face').click()`);
    await tick('Optimization');
    await waitFor(`S.browse.results && S.browse.categories.join() === 'optimization'`, 'filtered results');
    const one = await js(`S.browse.results.total`);
    expect(one < all, 'the category did not narrow the results');
    // A second category narrows further: results have to be in both. The menu stays open meanwhile.
    expect(!(await js(`document.querySelector('#view .multi-menu').hidden`)), 'the menu closed after one tick');
    await tick('Utility');
    await waitFor(`S.browse.results && S.browse.categories.join() === 'optimization,utility'`, 'results for two categories');
    const two = await js(`S.browse.results.total`);
    expect(two > 0 && two < one, `two categories gave ${two} results, one gave ${one}`);
    expect(await js(`document.querySelector('#view .multi-face').textContent`) === 'Optimization, Utility', 'the menu does not show what is ticked');
    await shot('21-categories');
    await tick('Utility');
    await waitFor(`S.browse.results && S.browse.categories.join() === 'optimization' && S.browse.results.total === ${one}`, 'back to one category');
    await js(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
    expect(await js(`document.querySelector('#view .multi-menu').hidden`), 'clicking elsewhere did not close the menu');
    expect(!(await js(`Boolean(document.querySelector('.warn'))`)), 'warning shown while the filters match the instance');
    await js(`(() => { const m = document.querySelectorAll('#view .bar select')[1]; m.value = 'forge'; m.dispatchEvent(new Event('change')); })()`);
    await waitFor(`document.querySelector('.warn')`, 'mismatch warning');
    await shot('17-filters');
    await js(`document.querySelector('.warn .btn').click()`);
    await waitFor(`!document.querySelector('.warn') && S.browse.loader === 'fabric'`, 'filters matched to the instance again');

    const side = (button) => js(`window.dispatchEvent(new MouseEvent('mouseup', { button: ${button}, cancelable: true }))`);
    await waitFor(`S.browse.results && document.querySelector('#results .row')`, 'results');
    await js(`document.querySelector('#results .row').click()`);
    await waitFor(`S.view === 'project'`, 'project page');
    const project = await js(`S.project.hit.id`);
    await js(`go('settings')`);
    await side(3);
    expect(await js(`S.view === 'project' && S.project.hit.id`) === project, 'back did not return to the project page');
    await side(3);
    expect(await js(`S.view`) === 'browse' && await js(`S.browse.categories.join()`) === 'optimization', 'back did not return to the search as it was');
    await side(4); await side(4);
    expect(await js(`S.view`) === 'settings', 'forward did not retrace the steps');
    await side(4);
    expect(await js(`S.view`) === 'settings', 'forward went past the newest place');
    await js(`go('library')`);
    await side(3); await side(4);
    expect(await js(`S.view`) === 'library', 'a new place did not replace the forward history');
    await js(`invalidateResults({ categories: [] }); go('browse')`);
  });

  await step('files are matched across both sites, and a website download is captured', async () => {
    const content = require('../src/content');
    const modrinth = require('../src/modrinth');
    const { Store } = require('../src/store');
    const webinstall = require('../src/webinstall');
    const dir = path.join(work, 'cross');
    fs.mkdirSync(path.join(dir, 'game', 'mods'), { recursive: true });
    const jar = jars('modmenu')[0];
    fs.copyFileSync(path.join(mods, jar), path.join(dir, 'game', 'mods', jar));
    fs.copyFileSync(path.join(mods, jar), path.join(dir, 'game', 'mods', 'from-cf.jar'));
    const store = new Store(path.join(dir, 'profile'));
    store.config.instances.push({ id: 'x', path: path.join(dir, 'game'), name: 'x', gameVersion: '1.21.1', loader: 'fabric' });
    store.config.activeInstanceId = 'x';
    // One file recorded as a CurseForge install; the other is found by Modrinth. CurseForge is a stand-in that knows every fingerprint.
    store.entries('x')['mods/from-cf.jar'] = { source: 'curseforge', projectId: '777', versionId: '1', title: 'From CF' };
    let asked = [];
    const fakeCf = { hasKey: () => true, fingerprints: async (list) => { asked = list; return Object.fromEntries(list.map((p) => [p, '424242'])); } };
    const ctx = { store, sources: { modrinth, curseforge: fakeCf }, trash: (p) => fs.promises.rm(p) };
    await content.list(ctx, 'mod');
    const ids = content.installedIds(store);
    const mr = Object.keys(ids).find((k) => k.startsWith('modrinth:'));
    expect(mr && ids['curseforge:777'] === '1' && Object.hasOwn(ids, 'curseforge:424242'), `cross-site links missing: ${JSON.stringify(ids)}`);
    expect(store.entries('x')['mods/from-cf.jar'].also.modrinth === mr.slice(9), 'a CurseForge install was not linked to its Modrinth project');
    expect(asked.length === 1 && Number.isInteger(asked[0]) && asked[0] > 0, `fingerprints sent: ${JSON.stringify(asked)}`);
    asked = [];
    await content.list(ctx, 'mod');
    expect(asked.length === 0, 'files were looked up again although already linked');

    // Website capture, with Modrinth's file server standing in for the CurseForge page.
    const real = (await modrinth.versions('modmenu', { type: 'mod', gameVersion: '1.21.1', loader: 'fabric' }))[1];
    const dest = path.join(dir, 'game', 'mods');
    const base = { url: real.file.url, siteHosts: ['cdn.modrinth.com'], downloadHosts: ['cdn.modrinth.com'], destDir: dest, show: false };
    let code = null;
    try { await webinstall.open({ ...base, siteHosts: ['curseforge.com'], expect: { filename: real.file.filename } }); } catch (e) { code = e.code; }
    expect(code === 'BAD_URL', `a page on another site was opened: ${code}`);
    const wrong = webinstall.open({ ...base, expect: { filename: 'something-else.jar' } }).then(() => 'OK', (e) => e.code);
    await sleep(4000);
    webinstall.cancel();
    expect(await wrong === 'CANCELLED' && !fs.readdirSync(dest).some((f) => f.includes('.part') || f === real.file.filename), 'an unexpected file was kept');
    code = await webinstall.open({ ...base, expect: { filename: real.file.filename, sha1: '0'.repeat(40) } }).then(() => 'OK', (e) => e.code);
    expect(code === 'CHECKSUM' && !fs.readdirSync(dest).some((f) => f.includes('.part')), `a file with the wrong checksum was kept: ${code}`);
    const got = await webinstall.open({ ...base, expect: { filename: real.file.filename, sha1: real.file.sha1 } });
    const version = { id: '9', name: 'v', versionNumber: real.file.filename, expected: { filename: real.file.filename } };
    await content.adoptFile(ctx, store.active(), { source: 'curseforge', projectId: '777', type: 'mod', title: 'From CF' }, got.tmp, version);
    const after = fs.readdirSync(dest);
    expect(after.includes(real.file.filename) && !after.includes('from-cf.jar') && !after.some((f) => f.includes('.part')), `after the website download: ${after}`);
    expect(content.installedIds(store)['curseforge:777'] === '9', 'the website download was not recorded as the installed version');
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
