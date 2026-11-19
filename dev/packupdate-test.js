'use strict';
// Checks, without a window or a network, the parts of Modion that decide what happens to an
// instance made from a modpack: who put each file there, what an update keeps, and what a
// website-only mod brings along. Downloads are answered from memory.
//   node dev/packupdate-test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const { Store } = require('../src/store');
const content = require('../src/content');
const packupdate = require('../src/packupdate');
const modpack = require('../src/modpack');
const { ApiError } = require('../src/http');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'modion-packupdate-'));
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '-', e.stack.split('\n').slice(0, 3).join(' | ')); }
};

// Every https download is answered from this table: url -> bytes.
const served = new Map();
const realFetch = global.fetch;
global.fetch = async (url) => {
  const bytes = served.get(String(url));
  if (!bytes) return new Response('no', { status: 404 });
  return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
};
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
let n = 0;
// A file of a project as the site APIs describe it.
function version(id, projectId, filename, { deps = [], blocked = false, date = '2025-01-01T00:00:00Z' } = {}) {
  const bytes = Buffer.from(`jar ${id} ${filename} ${n++}`);
  const url = `https://cdn.test/${projectId}/${id}/${filename}`;
  served.set(url, bytes);
  return {
    id: String(id), projectId: String(projectId), name: filename, versionNumber: filename, channel: 'release', date,
    gameVersions: ['1.21.1'], loaders: ['fabric'], dependencies: deps.map((d) => ({ projectId: d, versionId: null })),
    file: blocked ? null : { url, filename, size: bytes.length, sha1: sha1(bytes) },
    expected: { filename, size: bytes.length, sha1: sha1(bytes) },
  };
}
// A site: projects with a list of versions, newest last.
function site(name, projects) {
  const all = Object.values(projects).flat();
  return {
    hasKey: () => true,
    latest: async (pid) => [...projects[pid]].reverse().find((v) => v.file) || [...projects[pid]].reverse()[0] || null,
    getVersion: async (pid, vid) => all.find((v) => v.id === String(vid)),
    brief: async (pid) => ({ title: `Project ${pid}`, icon: null }),
    identify: async () => ({}),
    fingerprints: async () => ({}),
  };
}

function setup(label, { fromPack = true } = {}) {
  const dir = path.join(work, label);
  const game = path.join(dir, 'game');
  fs.mkdirSync(path.join(game, 'mods'), { recursive: true });
  const store = new Store(path.join(dir, 'settings'), path.join(dir, 'lib'));
  const inst = { id: `inst-${label}`, path: game, name: label, gameVersion: '1.21.1', loader: 'fabric', ...(fromPack ? { fromPack: true } : {}) };
  store.config.instances.push(inst);
  store.config.activeInstanceId = inst.id;
  return { dir, game, store, inst };
}
const trash = async (p) => fs.promises.rm(p, { recursive: true });
const put = (game, rel, text = rel) => { fs.mkdirSync(path.dirname(path.join(game, rel)), { recursive: true }); fs.writeFileSync(path.join(game, rel), text); };

(async () => {
  await test('a mod of the pack that is installed again as a newer file is "updated by you"; a new mod is "added by you"', async () => {
    const { game, store, inst } = setup('provenance');
    const a1 = version('a1', 'A', 'a-1.jar'), a2 = version('a2', 'A', 'a-2.jar'), b1 = version('b1', 'B', 'b-1.jar');
    const modrinth = site('modrinth', { A: [a1, a2], B: [b1] });
    put(game, 'mods/a-1.jar');
    const st = fs.statSync(path.join(game, 'mods/a-1.jar'));
    store.entries(inst.id)['mods/a-1.jar'] = { source: 'modrinth', projectId: 'A', versionId: 'a1', title: 'A', type: 'mod', size: st.size, mtime: st.mtimeMs };
    store.savePackState(inst.id, { files: { 'mods/a-1.jar': 'x' }, overrides: { 'config/a.toml': 'h' } });
    const ctx = { store, sources: { modrinth, curseforge: site('curseforge', {}) }, trash };
    const want = { gameVersion: '1.21.1', loader: 'fabric', type: 'mod', source: 'modrinth' };

    await content.install(ctx, { ...want, projectId: 'A', title: 'A' }, () => {});
    let e = store.entries(inst.id);
    assert(!fs.existsSync(path.join(game, 'mods/a-1.jar')) && fs.existsSync(path.join(game, 'mods/a-2.jar')), 'the old file was not replaced');
    assert(e['mods/a-2.jar'] && e['mods/a-2.jar'].updated === true && !e['mods/a-2.jar'].added, `entry: ${JSON.stringify(e['mods/a-2.jar'])}`);

    await content.install(ctx, { ...want, projectId: 'B', title: 'B' }, () => {});
    e = store.entries(inst.id);
    assert(e['mods/b-1.jar'].added === true && !e['mods/b-1.jar'].updated, `entry: ${JSON.stringify(e['mods/b-1.jar'])}`);

    // The listing says the same, and a file the pack never had counts as added even if nobody knows what it is.
    put(game, 'mods/handmade.jar');
    const list = await content.list(ctx, 'mod');
    const origin = Object.fromEntries(list.files.map((f) => [f.name, f.origin]));
    assert.deepStrictEqual(origin, { 'a-2.jar': 'updated', 'b-1.jar': 'added', 'handmade.jar': 'added' });
  });

  await test('an update leaves a mod added by you as "added", and an instance that is not a pack shows no origins', async () => {
    const { game, store, inst } = setup('keeps');
    const c1 = version('c1', 'C', 'c-1.jar'), c2 = version('c2', 'C', 'c-2.jar');
    const modrinth = site('modrinth', { C: [c1, c2] });
    const ctx = { store, sources: { modrinth, curseforge: site('curseforge', {}) }, trash };
    const want = { gameVersion: '1.21.1', loader: 'fabric', type: 'mod', source: 'modrinth', projectId: 'C', title: 'C' };
    store.savePackState(inst.id, { files: {}, overrides: {} });
    await content.install(ctx, { ...want, versionId: 'c1' }, () => {});
    await content.install(ctx, want, () => {}); // newer file
    const e = store.entries(inst.id)['mods/c-2.jar'];
    assert(e.added === true && !e.updated, JSON.stringify(e));

    const plain = setup('plain', { fromPack: false });
    plain.store.entries(plain.inst.id);
    await content.install({ store: plain.store, sources: ctx.sources, trash }, { ...want, versionId: 'c1' }, () => {});
    const list = await content.list({ store: plain.store, sources: ctx.sources, trash }, 'mod');
    assert(list.files.every((f) => f.origin === ''), 'a plain instance has origins');
  });

  await test('what a website-only mod needs is installed, and what that needs from the website is handed back', async () => {
    const { game, store, inst } = setup('deps', { fromPack: false });
    const d1 = version('d1', 'D', 'd-1.jar'), e1 = version('e1', 'E', 'e-1.jar', { blocked: true }), f1 = version('f1', 'F', 'f-1.jar', { deps: ['D'] });
    const m1 = version('m1', 'M', 'm-1.jar', { blocked: true, deps: ['D', 'E', 'F'] });
    const curseforge = site('curseforge', { D: [d1], E: [e1], F: [f1], M: [m1] });
    const ctx = { store, sources: { modrinth: site('modrinth', {}), curseforge }, trash };
    const req = { source: 'curseforge', instanceId: inst.id, projectId: 'M', versionId: 'm1', type: 'mod', depsOnly: true, gameVersion: '1.21.1', loader: 'fabric' };

    // Without the dependency pass, installing M itself is refused as before and carries what to fetch.
    await assert.rejects(content.install(ctx, { ...req, depsOnly: false, title: 'M' }, () => {}), (e) => e.code === 'BLOCKED' && e.detail.versionId === 'm1');

    const r = await content.install(ctx, req, () => {});
    assert(fs.existsSync(path.join(game, 'mods/d-1.jar')) && fs.existsSync(path.join(game, 'mods/f-1.jar')), `installed: ${fs.readdirSync(path.join(game, 'mods'))}`);
    assert(!fs.existsSync(path.join(game, 'mods/m-1.jar')), 'the mod itself is the caller\'s to place');
    assert.deepStrictEqual(r.blocked.map((b) => [b.projectId, b.versionId, b.title]), [['E', 'e1', 'Project E']]);
    assert.deepStrictEqual(r.skipped, []);
    // D came in once, even though two files need it.
    assert.strictEqual(r.installed.filter((x) => x.filename === 'd-1.jar').length, 1);
  });

  await test('a mod Modion downloads itself reports its website-only dependencies the same way', async () => {
    const { store, inst } = setup('deps2', { fromPack: false });
    const g1 = version('g1', 'G', 'g-1.jar', { blocked: true }), h1 = version('h1', 'H', 'h-1.jar', { deps: ['G'] });
    const curseforge = site('curseforge', { G: [g1], H: [h1] });
    const r = await content.install({ store, sources: { modrinth: site('modrinth', {}), curseforge }, trash }, { source: 'curseforge', projectId: 'H', type: 'mod', gameVersion: '1.21.1', loader: 'fabric', title: 'H' }, () => {});
    assert.strictEqual(r.installed.length, 1);
    assert.deepStrictEqual(r.blocked.map((b) => b.projectId), ['G']);
  });

  await test('the plan: unchanged files stay, changed ones are fetched, dropped ones go, the person\'s own copy wins', () => {
    const old = { files: { 'mods/keep.jar': 's1', 'mods/change-1.jar': 's2', 'mods/drop.jar': 's3', 'mods/gone.jar': 's4', 'mods/theirs-1.jar': 's5' } };
    const wanted = [
      { rel: 'mods/keep.jar', sig: 's1' }, { rel: 'mods/change-2.jar', sig: 's6' }, { rel: 'mods/new.jar', sig: 's7' },
      { rel: 'mods/theirs-2.jar', sig: 's8' }, { rel: 'mods/gone.jar', sig: 's4' },
    ];
    const onDisk = (rel) => ['mods/keep.jar', 'mods/change-1.jar', 'mods/drop.jar'].includes(rel); // gone.jar was deleted by the person
    const plan = packupdate.plan(old, wanted, new Set(['mods/theirs-2.jar']), onDisk);
    assert.deepStrictEqual(plan.fetch.map((w) => w.rel), ['mods/change-2.jar', 'mods/new.jar']);
    assert.deepStrictEqual(plan.same, ['mods/keep.jar', 'mods/gone.jar']); // a deleted file is not brought back
    assert.deepStrictEqual(plan.mine, ['mods/theirs-2.jar']);
    assert.deepStrictEqual(plan.stale.sort(), ['mods/change-1.jar', 'mods/drop.jar']); // theirs-1 is already gone
  });

  await test('mods the person added or updated are found by project, so the pack\'s copy does not join theirs', async () => {
    const entries = {
      'mods/mine.jar': { source: 'modrinth', projectId: 'P1', added: true },
      'mods/moved.jar': { source: 'curseforge', projectId: '77', updated: true, also: { modrinth: 'P2' } },
      'mods/packs.jar': { source: 'modrinth', projectId: 'P3' },
      'mods/removed.jar': { source: 'modrinth', projectId: 'P4', added: true },
    };
    const wanted = [
      { rel: 'mods/p1.jar', site: 'modrinth', sig: 'a'.repeat(40) }, { rel: 'mods/p2.jar', site: 'modrinth', sig: 'b'.repeat(40) },
      { rel: 'mods/p3.jar', site: 'modrinth', sig: 'c'.repeat(40) }, { rel: 'mods/p4.jar', site: 'curseforge', projectId: '99', sig: 'cf:1' },
    ];
    const asked = [];
    const projects = await packupdate.projectsOf(wanted, { modrinth: { identify: async (h) => { asked.push(...h); return { ['a'.repeat(40)]: { projectId: 'P1' }, ['b'.repeat(40)]: { projectId: 'P2' }, ['c'.repeat(40)]: { projectId: 'P3' } }; } } }, true);
    const mine = packupdate.mineRels(entries, (k) => k !== 'mods/removed.jar', projects);
    assert.deepStrictEqual([...mine].sort(), ['mods/p1.jar', 'mods/p2.jar']);
    // Without anybody's own mods Modrinth is not even asked.
    const none = await packupdate.projectsOf(wanted, { modrinth: { identify: async () => { throw new Error('asked'); } } }, false);
    assert.strictEqual(none.get('curseforge:99'), 'mods/p4.jar');
  });

  await test('config files: the pack\'s change is taken unless the person edited the file', () => {
    const a = packupdate.overrideAction;
    assert.strictEqual(a('h1', 'h1', 'edited'), 'same');   // the pack did not change it
    assert.strictEqual(a('h1', 'h2', 'h1'), 'write');      // changed in the pack, untouched here
    assert.strictEqual(a('h1', 'h2', 'edited'), 'mine');   // changed in both: theirs stays
    assert.strictEqual(a('h1', 'h2', null), 'write');      // not there
    assert.strictEqual(a(undefined, 'h2', 'x'), 'mine');   // new in the pack, the person already has one
    assert.strictEqual(a(undefined, 'h2', 'h2'), 'same');
  });

  await test('swapping files in: stale ones go to the trash, new ones land, and a disabled mod stays disabled', async () => {
    const { game, store, inst } = setup('swap');
    const staging = path.join(game, '.stage');
    put(game, 'mods/old.jar'); put(game, 'mods/off-1.jar.disabled'); put(game, 'mods/stale.jar'); put(game, 'mods/stale2.jar.disabled');
    put(staging, 'mods/new.jar', 'new'); put(staging, 'mods/off-1.jar', 'newer'); put(staging, 'config/x.json', '{}');
    const entries = store.entries(inst.id);
    entries['mods/stale.jar'] = { unknown: true };
    const trashed = [];
    const r = await packupdate.swap({
      gameDir: game, staging, entries, trash: async (p) => { trashed.push(path.basename(p)); await fs.promises.rm(p); },
      stale: ['mods/stale.jar', 'mods/stale2.jar'],
      fetch: [{ rel: 'mods/new.jar' }, { rel: 'mods/off-1.jar' }, { rel: 'config/x.json' }],
    });
    assert.deepStrictEqual(trashed.sort(), ['stale.jar', 'stale2.jar.disabled']);
    assert.strictEqual(r.removed, 2); assert.strictEqual(r.added, 3);
    assert(!fs.existsSync(path.join(game, 'mods/stale.jar')) && !('mods/stale.jar' in entries));
    assert(fs.existsSync(path.join(game, 'mods/new.jar')) && fs.existsSync(path.join(game, 'config/x.json')));
    assert(fs.existsSync(path.join(game, 'mods/off-1.jar.disabled')) && !fs.existsSync(path.join(game, 'mods/off-1.jar')), 'a disabled mod was switched on');
    assert.strictEqual(fs.readFileSync(path.join(game, 'mods/off-1.jar.disabled'), 'utf8'), 'newer');
  });

  await test('the newest file of a pack: newer, no less stable, in the same line; a beta is not offered to a release', async () => {
    const mk = (id, date, channel, extra = {}) => ({ id, date, channel, file: { url: 'x' }, ...extra });
    const list = [mk('v3', '2025-03-01', 'beta'), mk('v2', '2025-02-01', 'release'), mk('v1', '2025-01-01', 'release'), mk('v0', '2024-12-01', 'release')];
    const api = { versions: async (pid, o) => { assert.deepStrictEqual(o, { type: 'modpack', gameVersion: '1.21.1', loader: 'fabric' }); return list; }, getVersion: async () => list.find((v) => v.id === 'v1') };
    const pack = { projectId: 'P', versionId: 'v1', gameVersion: '1.21.1', loader: 'fabric', channel: 'release' };
    assert.strictEqual((await packupdate.newest(api, pack)).id, 'v2');
    assert.strictEqual(await packupdate.newest({ ...api, getVersion: async () => list.find((v) => v.id === 'v2') }, { ...pack, versionId: 'v2' }), null);
    // Someone on a beta is offered the newer beta.
    assert.strictEqual((await packupdate.newest({ ...api, getVersion: async () => ({ ...list[2], channel: 'beta' }) }, { ...pack, channel: 'beta' })).id, 'v3');
  });

  await test('a pack read from disk records where every file goes and which file it is', async () => {
    const { writeZip } = require('../src/zip');
    const zipFile = path.join(work, 'p.mrpack');
    const sha = 'e'.repeat(40);
    writeZip(zipFile, [
      { name: 'modrinth.index.json', data: Buffer.from(JSON.stringify({ game: 'minecraft', name: 'P', dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.0' }, files: [{ path: 'mods/x.jar', hashes: { sha1: sha, sha512: 'f'.repeat(128) }, downloads: ['https://cdn.modrinth.com/x.jar'], fileSize: 3 }] })) },
      { name: 'overrides/config/a.toml', data: Buffer.from('a = 1') },
    ]);
    const pack = modpack.inspect(zipFile);
    const { items } = await modpack.downloads(pack, path.join(work, 'g'), {});
    assert.deepStrictEqual([items[0].rel, items[0].sig, items[0].site], ['mods/x.jar', sha, 'modrinth']);
    const { count, hashes } = await modpack.unpackOverrides(pack, path.join(work, 'g'));
    assert.strictEqual(count, 1);
    assert.strictEqual(hashes['config/a.toml'], modpack.sha1Hex(Buffer.from('a = 1')));
    // An update can keep one back.
    const kept = await modpack.unpackOverrides(pack, path.join(work, 'g2'), async () => true);
    assert.strictEqual(kept.count, 0);
    assert(!fs.existsSync(path.join(work, 'g2/config/a.toml')));
    pack.zip.close();
  });

  await test('the store keeps a pack link and loader build, and drops damaged ones', () => {
    const { store, inst } = setup('store');
    inst.loaderVersion = '0.16.0';
    inst.pack = { source: 'modrinth', projectId: 'P', versionId: 'v1', versionName: '1.0', title: 'Pack', icon: null, channel: 'release', gameVersion: '1.21.1', loader: 'fabric' };
    store.saveConfig();
    store.savePackState(inst.id, { files: { 'mods/a.jar': 's' }, overrides: {} });
    const again = new Store(store.dir, path.join(work, 'lib'));
    const got = again.instance(inst.id);
    assert.strictEqual(got.loaderVersion, '0.16.0');
    assert.strictEqual(got.pack.versionId, 'v1');
    assert.deepStrictEqual(again.packState(inst.id).files, { 'mods/a.jar': 's' });
    again.config.instances[0].pack = { source: 'elsewhere', projectId: 'P', versionId: 'v' };
    again.saveConfig();
    assert.strictEqual(new Store(store.dir, path.join(work, 'lib')).instance(inst.id).pack, undefined);
    again.dropPackState(inst.id);
    assert.strictEqual(new Store(store.dir, path.join(work, 'lib')).packState(inst.id), null);
  });

  global.fetch = realFetch;
  fs.rmSync(work, { recursive: true, force: true });
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
