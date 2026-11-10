'use strict';

/* ---------- helpers ---------- */

const $ = (sel) => document.querySelector(sel);

// Element builder. Everything on screen goes through this (never innerHTML), so
// text from the mod sites can only ever be text.
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k.startsWith('data-')) el.setAttribute(k, v);
    else el[k] = v;
  }
  return add(el, kids);
}

// The DOM's own append() and replaceChildren() print false, null and undefined as text, so
// a part written as `condition && element` would show up as the word "false". Everything
// goes through these two instead, which leave such parts out.
const present = (kids) => kids.flat(Infinity).filter((k) => k != null && k !== false && k !== true);
function add(el, ...kids) { el.append(...present(kids)); return el; }
function fill(el, ...kids) { el.replaceChildren(...present(kids)); return el; }

async function api(method, args) {
  let r;
  try {
    r = await window.modion.call(method, args);
  } catch {
    throw Object.assign(new Error('The app\'s background process did not answer.'), { code: 'IPC' });
  }
  if (!r || !r.ok) throw Object.assign(new Error((r && r.error) || 'Something went wrong.'), { code: r && r.code, detail: r && r.detail });
  return r.data;
}

const SOURCES = { modrinth: 'Modrinth', curseforge: 'CurseForge' };
const TYPES = { mod: 'Mods', resourcepack: 'Resource Packs', shader: 'Shaders', datapack: 'Data Packs' };
const LOADERS = { '': 'Any loader', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt' };
const SORTS = { relevance: 'Relevance', downloads: 'Downloads', updated: 'Recently updated', newest: 'Newest' };

function fmtNum(n) {
  if (n == null) return '?';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e4) return Math.round(n / 1e3) + 'k';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

function fmtSize(bytes) {
  if (!bytes) return '';
  return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!isFinite(s)) return 'unknown';
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [name, len] of units) {
    const n = Math.floor(s / len);
    if (n >= 1) return `${n} ${name}${n > 1 ? 's' : ''} ago`;
  }
  return 'just now';
}

function slot(src, size) {
  const img = h('img', { alt: '', src: src || Pixel.icon('missing'), class: src ? '' : 'px' });
  img.addEventListener('error', () => { img.src = Pixel.icon('missing'); img.className = 'px'; }, { once: true });
  return h('div', { class: `slot s${size}` }, img);
}

const btn = (label, onclick, cls) => h('button', { class: `btn ${cls || ''}`, onclick }, label);

function select(options, value, onchange) {
  const s = h('select', { class: 'field', onchange: () => onchange(s.value) },
    options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
  return h('label', { class: 'sel' }, s);
}

function check(label, value, onchange) {
  const box = h('input', { type: 'checkbox', checked: value, onchange: () => onchange(box.checked, box) });
  return h('label', { class: 'check', onclick: (e) => e.stopPropagation() }, box, h('span', { class: 'box' }), label);
}

const message = (...kids) => h('div', { class: 'empty' }, kids);
const loading = (text = 'Loading...') => message(h('p', { class: 'dim' }, text));

/* ---------- state ---------- */

const S = {
  cfg: { instances: [], activeInstanceId: null, hasCurseforgeKey: false, installed: {}, version: '' },
  gameVersions: [],
  view: 'browse',
  browse: { source: 'modrinth', type: 'mod', query: '', gameVersion: '', loader: '', category: '', sort: 'relevance', page: 0, results: null, scroll: 0 },
  project: null,
  library: { type: 'mod' },
};

const activeInst = () => S.cfg.instances.find((i) => i.id === S.cfg.activeInstanceId) || null;
const targetLabel = (t) => [t.gameVersion, t.loader && LOADERS[t.loader]].filter(Boolean).join(' ');
const instLabel = (i) => targetLabel(i) || 'version not set';

// Every change to what is being searched for goes through here. Bumping the token makes
// any search still in flight for the old filters throw its answer away.
let searchToken = 0;
function invalidateResults(patch) {
  Object.assign(S.browse, patch, { page: 0, scroll: 0, results: null });
  searchToken++;
}

// Browsing follows the active instance: its game version and loader become the filters.
function followInstance() {
  const inst = activeInst();
  if (!inst) return;
  invalidateResults({
    gameVersion: inst.gameVersion || S.browse.gameVersion,
    loader: inst.loader || S.browse.loader,
  });
}

function setConfig(cfg, { follow } = {}) {
  if (!cfg || typeof cfg !== 'object') return;
  const before = S.cfg.activeInstanceId;
  S.cfg = {
    ...S.cfg,
    ...cfg,
    instances: Array.isArray(cfg.instances) ? cfg.instances : [],
    installed: cfg.installed && typeof cfg.installed === 'object' ? cfg.installed : {},
  };
  if (follow || before !== S.cfg.activeInstanceId) followInstance();
}

// The list of Minecraft versions comes from Modrinth. One request is shared by everyone
// who asks, and a failed one is retried the next time a version menu is built.
let versionsLoading = null;
function loadGameVersions() {
  if (S.gameVersions.length) return Promise.resolve();
  if (!versionsLoading) {
    versionsLoading = api('meta.gameVersions')
      .then((list) => { if (Array.isArray(list)) S.gameVersions = list; })
      .catch(() => {})
      .finally(() => { versionsLoading = null; });
  }
  return versionsLoading;
}

function versionOptions(current, blank) {
  const list = S.gameVersions.includes(current) || !current ? S.gameVersions : [current, ...S.gameVersions];
  return [['', blank], ...list.map((v) => [v, v])];
}

// A version menu that fills itself in if the list arrives after it was drawn.
function versionSelect(value, blank, onchange) {
  const el = select(versionOptions(value, blank), value, onchange);
  if (!S.gameVersions.length) {
    loadGameVersions().then(() => {
      const menu = el.firstChild;
      if (!menu.isConnected || !S.gameVersions.length) return;
      const current = menu.value;
      fill(menu, ...versionOptions(current, blank).map(([v, label]) => h('option', { value: v, selected: v === current }, label)));
    });
  }
  return el;
}

/* ---------- toasts and the download bar ---------- */

function toast(title, text, { tone = 'yellow', icon, time = 5000 } = {}) {
  const el = h('div', { class: 'toast' },
    slot(icon || Pixel.icon('logo'), 48),
    h('div', { class: 'msg' }, h('div', { class: tone }, title), text && h('div', {}, text)));
  if (!icon) el.querySelector('img').className = 'px';
  add($('#toasts'), el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300); // not tied to the animation, which never ends in a hidden window
  }, time);
}

const fail = (e, title = 'That didn\'t work') => toast(title, (e && e.message) || String(e), { tone: 'red', time: 8000 });

const jobs = new Map();
function drawJobs() {
  const box = $('#jobs');
  if (!box) return;
  const active = [...jobs.values()];
  if (!active.length) { fill(box); return; }
  const j = active[active.length - 1];
  const pct = j.total ? Math.min(100, Math.round((j.received / j.total) * 100)) : 0;
  const bar = h('i');
  bar.style.width = pct + '%';
  fill(box, h('div', { class: 'job-name' }, `Downloading ${j.filename}${active.length > 1 ? ` (+${active.length - 1} more)` : ''}`),
    h('div', { class: 'job-line' }, h('div', { class: 'xp' }, bar), h('span', {}, j.total ? `${pct}%` : fmtSize(j.received))));
}

// The background check of the instance's files finished: what counts as installed may have grown.
window.modion.onInstalled((ids) => {
  if (!ids || typeof ids !== 'object') return;
  S.cfg.installed = ids;
  paintInstalls();
});

window.modion.onDownload((d) => {
  if (!d || !d.id) return;
  if (d.state === 'progress') jobs.set(d.id, d);
  else jobs.delete(d.id);
  if (d.state === 'done' && !d.saved) toast('Installed', d.title, { icon: d.icon, time: 3500 });
  drawJobs();
});

/* ---------- full-window screens ---------- */

let screenClose = null;

// Opening a dialog over another one ends the first properly (its close handler still runs).
function supersede() {
  const prior = screenClose;
  screenClose = null;
  if (prior) prior();
}

function showScreen(title, body, buttons, onClose) {
  supersede();
  const o = $('#overlay');
  o.className = '';
  o.onclick = null;
  fill(o, h('div', { class: 'modal' },
    h('div', { class: 'modal-title' }, title), body, h('div', { class: 'screen-buttons' }, buttons)));
  o.hidden = false;
  screenClose = onClose || null;
  const last = [...o.querySelectorAll('.screen-buttons .btn')].pop();
  if (last) last.focus();
}

function closeScreen() {
  const o = $('#overlay');
  if (o.hidden) return;
  o.hidden = true;
  o.onclick = null;
  fill(o);
  const cb = screenClose;
  screenClose = null;
  if (cb) cb();
}

function confirmScreen(title, lines, yesLabel) {
  return new Promise((resolve) => {
    let answer = false;
    showScreen(title,
      h('div', { class: 'screen-body' }, h('div', { class: 'confirm' }, lines.map((l, i) => h('p', { class: i ? 'dim' : '' }, l)))),
      [btn('Cancel', closeScreen), btn(yesLabel, () => { answer = true; closeScreen(); }, 'green')],
      () => resolve(answer));
  });
}

function lightbox(src) {
  if (!src) return;
  supersede();
  const o = $('#overlay');
  o.className = 'lightbox';
  fill(o, h('img', { src, alt: '' }));
  o.hidden = false;
  o.onclick = closeScreen;
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeScreen(); });

// Links never navigate the window; web links are handed to the system browser.
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a) return;
  e.preventDefault();
  api('openExternal', { url: a.href }).catch(fail);
});

/* ---------- chrome ---------- */

function go(view) {
  if (S.view === 'browse') S.browse.scroll = ($('#results') || {}).scrollTop || 0;
  S.view = view;
  render();
}

function renderRail() {
  const P = S.view === 'project' ? S.project : null;
  const item = (on, icon, label, onclick) =>
    h('button', { class: `nav-item ${on ? 'on' : ''}`, onclick }, h('img', { class: 'px', alt: '', src: Pixel.icon(icon) }), h('span', {}, label));
  fill($('#rail'), h('div', { class: 'brand' },
      h('img', { class: 'px', alt: '', src: Pixel.icon('logo') }),
      h('div', {}, h('div', { class: 'brand-name' }, 'Modion'), h('div', { class: 'faint small' }, 'Mod manager'))),
    item(S.view === 'instances', 'logo', 'Instances', () => go('instances')),
    h('div', { class: 'nav-label' }, 'Browse'),
    ...Object.entries(SOURCES).map(([id, name]) =>
      item(P ? P.from === 'browse' && P.hit.source === id : S.view === 'browse' && S.browse.source === id, id, name, () => {
        if (S.browse.source !== id) invalidateResults({ source: id, category: '' }); // each site has its own categories
        go('browse');
      })),
    h('div', { class: 'nav-label' }, 'Installed'),
    item(P ? P.from === 'library' : S.view === 'library', 'library', 'Library', () => go('library')),
    h('div', { class: 'spacer' }),
    item(S.view === 'settings', 'settings', 'Settings', () => go('settings')));
}

// Header: section name with the launcher's uppercase tab strip underneath.
function renderTop() {
  const tab = (label, on, onclick) => h('button', { class: `tab ${on ? 'on' : ''}`, onclick }, label);
  const typeTabs = (current, pick) => Object.entries(TYPES).map(([id, name]) => tab(name, current === id, () => pick(id)));
  let title, tabs, back = null;
  if (S.view === 'browse') {
    title = SOURCES[S.browse.source];
    tabs = typeTabs(S.browse.type, (type) => { if (type !== S.browse.type) invalidateResults({ type, category: '' }); render(); });
  } else if (S.view === 'library') {
    const inst = activeInst();
    title = inst ? `Library / ${inst.name}` : 'Library';
    tabs = [...typeTabs(S.library.type, (type) => { S.library.type = type; render(); }),
      tab('Log', S.library.type === 'log', () => { S.library.type = 'log'; render(); })];
  } else if (S.view === 'project') {
    const P = S.project;
    title = P.hit.title;
    back = h('button', { class: 'back', title: 'Back', onclick: () => go(P.from || 'browse') }, '\u2190');
    tabs = [['description', 'Description'], ['gallery', P.detail && Array.isArray(P.detail.gallery) ? `Gallery (${P.detail.gallery.length})` : 'Gallery'], ['versions', 'Files']]
      .map(([id, label]) => tab(label, P.tab === id, () => { P.tab = id; render(); }));
  } else if (S.view === 'instances') {
    title = 'Instances';
    tabs = [tab('All', S.instancesTab !== 'log', () => { S.instancesTab = 'all'; render(); }),
      tab('Log', S.instancesTab === 'log', () => { S.instancesTab = 'log'; render(); })];
  } else {
    title = 'Settings';
    tabs = [tab('General', true, () => {})];
  }
  fill($('#top'), h('div', { class: 'title' }, back, h('span', {}, title)), h('div', { class: 'tabs' }, tabs));
}

// Bottom bar, as in the launcher's Play tab: instance picker on the left, the big green
// button in the middle (when a project is open), download progress on the right.
function renderBottom() {
  const inst = activeInst();
  const picker = h('button', { class: 'inst-btn', title: inst ? inst.path : '', onclick: () => openInstances() },
    h('img', { class: 'px', alt: '', src: Pixel.icon('logo') }),
    h('div', { class: 'inst-text' },
      h('div', { class: 'inst-name' }, inst ? inst.name : 'No instance selected'),
      h('div', { class: 'faint small' }, inst ? instLabel(inst) : 'Choose where to install')),
    h('span', { class: 'caret' }));
  let action = h('div');
  if (S.view === 'project') {
    const p = S.project.hit, t = installTarget();
    const play = installButton({ source: p.source, projectId: p.id, type: p.type, title: p.title, icon: p.icon, ...t }, 'play');
    action = h('div', { class: 'action' }, play,
      h('div', { class: 'faint small' }, targetLabel(t) ? `Latest file for ${targetLabel(t)}` : 'Latest file'));
  } else if (inst && inst.launch) {
    // Outside a project page the middle of the bar is the launcher's Play button.
    const label = inst.launch.play ? 'Play' : 'Open Launcher';
    const play = btn(label, async () => {
      play.disabled = true;
      play.textContent = 'Starting...'; // a first launch downloads the game, which takes a while
      try {
        const r = await api('instances.launch', { id: inst.id });
        toast(r.play ? `Starting ${inst.name}` : `Opening ${r.label}`, r.play ? `${r.label} is launching the game.` : `Start "${inst.name}" from there.`);
        if (S.cfg.openLogOnLaunch !== false) { S.library.type = 'log'; go('library'); } // watch the game start
      } catch (e) { fail(e, 'Could not start the game'); }
      setTimeout(() => { play.disabled = false; }, 4000); // long enough that a double click cannot start it twice
      play.textContent = label;
    }, 'green play');
    action = h('div', { class: 'action' }, play,
      h('div', { class: 'faint small' }, inst.launch.play ? `via ${inst.launch.label}` : `${inst.launch.label} starts this instance`));
  }
  fill($('#bottom'), picker, action, h('div', { id: 'jobs' }));
  drawJobs();
}

// Back and forward. Every redraw notes where the app is; a new place is added to the
// history, the same place is left alone. Tabs inside a project page do not count as places.
const nav = { stack: [], at: -1, moving: false };
const navKey = (n) => [n.view, n.source, n.btype, n.ltype, n.project ? `${n.project.hit.source}:${n.project.hit.id}` : ''].join('|');

function navRecord() {
  if (nav.moving) return;
  const now = { view: S.view, source: S.browse.source, btype: S.browse.type, ltype: S.library.type, project: S.view === 'project' ? S.project : null };
  if (nav.at >= 0 && navKey(nav.stack[nav.at]) === navKey(now)) { nav.stack[nav.at] = now; return; }
  nav.stack.length = nav.at + 1; // going somewhere new drops the "forward" places
  nav.stack.push(now);
  if (nav.stack.length > 100) nav.stack.shift();
  nav.at = nav.stack.length - 1;
}

function navMove(step) {
  if (!$('#overlay').hidden) { if (step < 0) closeScreen(); return; } // back closes an open dialog first
  const to = nav.stack[nav.at + step];
  if (!to) return;
  if (S.view === 'browse') S.browse.scroll = ($('#results') || {}).scrollTop || 0;
  nav.at += step;
  nav.moving = true;
  try {
    if (to.source !== S.browse.source || to.btype !== S.browse.type) invalidateResults({ source: to.source, type: to.btype, category: '' });
    S.library.type = to.ltype;
    if (to.project) S.project = to.project;
    S.view = to.view;
    render();
  } finally {
    nav.moving = false;
  }
}

// The side buttons of a mouse arrive as buttons 3 (back) and 4 (forward).
window.addEventListener('mousedown', (e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); });
window.addEventListener('mouseup', (e) => {
  if (e.button !== 3 && e.button !== 4) return;
  e.preventDefault();
  navMove(e.button === 3 ? -1 : 1);
});
window.addEventListener('keydown', (e) => {
  if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
  e.preventDefault();
  navMove(e.key === 'ArrowLeft' ? -1 : 1);
});

function render() {
  clearInterval(logTimer); // the Log tab restarts its own polling when it is drawn
  navRecord();
  renderRail();
  renderTop();
  renderBottom();
  const v = $('#view');
  fill(v);
  ({ browse: viewBrowse, project: viewProject, library: viewLibrary, settings: viewSettings, instances: viewInstances })[S.view](v);
}

/* ---------- browse ---------- */

function installTarget() {
  const inst = activeInst() || {};
  return { gameVersion: inst.gameVersion || S.browse.gameVersion, loader: inst.loader || S.browse.loader };
}

// Installs in flight, as "source:projectId". Buttons for the same project can be on screen
// several times (list row, file rows, bottom bar) and are redrawn while an install runs,
// so their state lives here and each button is painted from it.
const busy = new Set();

function paintInstall(b) {
  const key = b.dataset.install, ver = b.dataset.version;
  const installed = ver ? S.cfg.installed[key] === ver : key in S.cfg.installed;
  const working = busy.has(key);
  b.textContent = working ? (b.dataset.label ? 'Waiting...' : 'Installing...') : installed ? 'Installed' : b.dataset.label || 'Install';
  b.disabled = working || installed;
}

const paintInstalls = () => document.querySelectorAll('button[data-install]').forEach(paintInstall);

function installButton(req, cls, { label, run = doInstall } = {}) {
  const b = h('button', {
    class: `btn green ${cls || ''}`,
    'data-install': `${req.source}:${req.projectId}`,
    'data-version': req.versionId || null,
    'data-label': label || null,
    onclick: (e) => { e.stopPropagation(); run(req); },
  });
  paintInstall(b);
  return b;
}

async function doInstall(req) {
  if (!activeInst()) {
    toast('No instance selected', 'Choose where mods should be installed.');
    openInstances();
    return;
  }
  const key = `${req.source}:${req.projectId}`;
  if (busy.has(key)) return;
  busy.add(key);
  paintInstalls();
  let fromWebsite = null;
  try {
    const r = await api('install', req);
    if (r && r.installed_ids) S.cfg.installed = r.installed_ids;
    for (const s of (r && r.skipped) || []) toast('Heads up', `${s.title}: ${s.reason}`, { tone: 'gold', time: 9000 });
    if (!req.versionId && !req.gameVersion) {
      toast('Newest file installed', 'This instance has no game version set, so compatibility was not checked.', { tone: 'gold', time: 9000 });
    }
  } catch (e) {
    // The author only offers this file on the website: carry on there.
    if (e.code === 'BLOCKED' && e.detail && e.detail.versionId) fromWebsite = { ...req, versionId: e.detail.versionId };
    else fail(e, 'Install failed');
  } finally {
    busy.delete(key);
    paintInstalls();
  }
  if (fromWebsite) doWebInstall(fromWebsite);
}

// Opens the file's own page on CurseForge. The person presses Download there; Modion
// waits for that file and puts it in the instance.
async function doWebInstall(req) {
  if (!activeInst()) {
    toast('No instance selected', 'Choose where mods should be installed.');
    openInstances();
    return;
  }
  const key = `${req.source}:${req.projectId}`;
  if (busy.has(key)) return;
  busy.add(key);
  paintInstalls();
  toast('Download it on the website', 'This file is only offered on CurseForge. Press Download in the window that opens and Modion will put the file in place.', { time: 10000 });
  try {
    const r = await api('install.viaWebsite', req);
    if (r && r.installed_ids) S.cfg.installed = r.installed_ids;
  } catch (e) {
    if (e.code !== 'CANCELLED') fail(e, 'Website download failed');
  } finally {
    busy.delete(key);
    paintInstalls();
  }
}

function tags(p, max = 6) {
  return h('div', { class: 'tags' },
    (p.loaders || []).map((l) => h('span', { class: 'tag loader' }, LOADERS[l] || l)),
    (p.categories || []).slice(0, max).map((c) => h('span', { class: 'tag' }, c)));
}

function hitRow(p) {
  const install = installButton({ source: p.source, projectId: p.id, type: p.type, title: p.title, icon: p.icon, ...installTarget() }, 'small');
  const open = () => openProject(p, 'browse');
  return h('div', { class: 'row click', tabIndex: 0, onclick: open, onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(); } },
    slot(p.icon, 64),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, p.title, p.author && h('span', { class: 'faint' }, ` by ${p.author}`)),
      h('div', { class: 'row-sum' }, p.summary),
      tags(p, 4)),
    h('div', { class: 'row-side' },
      h('div', {}, `${fmtNum(p.downloads)} downloads`),
      h('div', { class: 'faint' }, `Updated ${ago(p.updated)}`),
      install));
}

async function loadResults() {
  const b = S.browse;
  const token = ++searchToken;
  const list = $('#results'), pager = $('#pager');
  if (!list) return; // not on screen: the browse view searches again when it is next shown
  fill(list, loading(`Searching ${SOURCES[b.source]}...`));
  fill(pager);
  let res = null, error = null;
  try {
    const { source, type, query, gameVersion, loader, category, sort, page } = b;
    res = await api('search', { source, type, query, gameVersion, loader, category, sort, page });
  } catch (e) {
    error = e;
  }
  if (token !== searchToken) return; // the filters changed while this was in flight
  if (res && Array.isArray(res.hits)) {
    b.results = res;
    drawResults();
    return;
  }
  b.results = null;
  const now = $('#results'); // the view may have been redrawn since the search started
  if (!now) return;
  if (error && (error.code === 'NO_CF_KEY' || error.code === 'BAD_CF_KEY')) {
    fill(now, message(
      h('p', { class: 'yellow' }, error.code === 'NO_CF_KEY' ? 'CurseForge needs an API key' : 'CurseForge rejected the API key'),
      h('p', { class: 'dim' }, 'CurseForge only lets apps browse with a key. You can get a free one and paste it into Settings.'),
      btn('Open Settings', () => go('settings'), 'green')));
  } else {
    fill(now, message(h('p', { class: 'red' }, error ? error.message : 'The search returned nothing usable.'), btn('Try Again', loadResults)));
  }
}

function drawResults() {
  const b = S.browse, res = b.results;
  const list = $('#results'), pager = $('#pager');
  if (!list || !res) return;
  fill(list, ...(res.hits.length ? res.hits.map(hitRow) : [message(h('p', { class: 'dim' }, 'Nothing found. Try fewer filters.'))]));
  list.scrollTop = b.scroll;
  b.scroll = 0;
  const total = Number(res.total) || 0;
  const pages = Math.max(1, Math.ceil(total / (res.pageSize || 20)));
  const turn = (d) => () => { b.page = Math.min(Math.max(b.page + d, 0), pages - 1); loadResults(); };
  const prev = btn('< Prev', turn(-1), 'small'), next = btn('Next >', turn(1), 'small');
  prev.disabled = b.page <= 0;
  next.disabled = b.page >= pages - 1;
  fill(pager, h('div', { class: 'dim' }, `${total.toLocaleString()} result${total === 1 ? '' : 's'}`),
    h('div', { class: 'bar' }, prev, h('span', {}, `Page ${b.page + 1} of ${pages.toLocaleString()}`), next),
    h('div'));
}

const categoryLists = new Map(); // "source:type" -> [{ id, label }]

// The search box updates the query at once and searches a moment after typing stops.
let searchTimer = null;

function viewBrowse(v) {
  const b = S.browse;
  if (searchTimer) {
    // Redrawn while a search was still waiting on the typing delay: it is due now.
    clearTimeout(searchTimer);
    searchTimer = null;
    invalidateResults();
  }
  const change = (patch) => { invalidateResults(patch); render(); };
  const search = h('input', {
    class: 'field grow', type: 'search', value: b.query, spellcheck: false, maxLength: 200,
    placeholder: `Search ${TYPES[b.type].toLowerCase()} on ${SOURCES[b.source]}...`,
    oninput: () => {
      b.query = search.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { searchTimer = null; invalidateResults(); loadResults(); }, 350);
    },
  });
  // Categories differ per site and content type; the menu fills in once they have loaded.
  const catKey = `${b.source}:${b.type}`;
  const catOptions = () => [['', 'Any category'], ...(categoryLists.get(catKey) || []).map((c) => [c.id, c.label])];
  const category = select(catOptions(), b.category, (val) => change({ category: val }));
  if (!categoryLists.has(catKey)) {
    api('meta.categories', { source: b.source, type: b.type }).then((list) => {
      if (!Array.isArray(list)) return;
      categoryLists.set(catKey, list);
      const menu = category.firstChild;
      if (menu.isConnected) fill(menu, ...catOptions().map(([val, label]) => h('option', { value: val, selected: val === b.category }, label)));
    }).catch(() => {}); // e.g. CurseForge without a key: the menu just stays at "Any category"
  }
  // Browsing for a different version or loader than the selected instance is allowed, but flagged.
  const inst = activeInst();
  const mismatch = inst && ((inst.gameVersion && b.gameVersion !== inst.gameVersion) || (b.type === 'mod' && inst.loader && b.loader !== inst.loader));
  add(v, h('div', { class: 'bar' },
      search,
      category,
      versionSelect(b.gameVersion, 'Any version', (gameVersion) => change({ gameVersion })),
      b.type === 'mod' && select(Object.entries(LOADERS), b.loader, (loader) => change({ loader })),
      select(Object.entries(SORTS), b.sort, (sort) => change({ sort }))),
    mismatch && h('div', { class: 'bar warn' },
      h('span', {}, `These filters do not match "${inst.name}" (${instLabel(inst)}). What is listed here may have no file that works in that instance.`),
      h('div', { class: 'push' }, btn('Match Instance', () => change({ gameVersion: inst.gameVersion || b.gameVersion, loader: inst.loader || b.loader }), 'small'))),
    h('div', { class: 'list', id: 'results' }),
    h('div', { class: 'pager', id: 'pager' }));
  if (b.results) drawResults(); else loadResults();
}

/* ---------- project page ---------- */

function openProject(hit, from) {
  if (!hit || !hit.id || !SOURCES[hit.source]) return;
  if (S.view === 'browse') S.browse.scroll = ($('#results') || {}).scrollTop || 0;
  const target = installTarget();
  S.project = { hit, from, tab: 'description', detail: null, versions: null, wanted: null, error: null, compatible: Boolean(target.gameVersion || target.loader) };
  S.view = 'project';
  render();
  const mine = S.project;
  api('project', { source: hit.source, id: hit.id })
    .then((d) => { mine.detail = d; })
    .catch((e) => { mine.error = (e && e.message) || 'This project could not be loaded.'; })
    .finally(() => { if (S.project === mine && S.view === 'project') render(); });
}

// Files are fetched per filter; `wanted` names the filter the list on screen should be for.
async function loadVersions(P, d, wanted, filter) {
  let result;
  try {
    result = await api('versions', { source: d.source, id: d.id, type: d.type, ...filter });
  } catch (e) {
    result = { error: e.message };
  }
  if (P.wanted !== wanted) return; // the filter changed while this was in flight
  P.versions = Array.isArray(result) || (result && result.error) ? result : { error: 'The file list could not be read.' };
  if (S.project === P && S.view === 'project' && P.tab === 'versions') render();
}

function versionRow(d, v) {
  const req = { source: d.source, projectId: d.id, versionId: v.id, type: d.type, title: d.title, icon: d.icon, ...installTarget() };
  let actions;
  if (v.file) {
    const install = installButton(req, 'small');
    const save = btn('Save As...', async () => {
      save.disabled = true; // one folder dialog at a time
      try {
        const r = await api('saveAs', req);
        if (r) toast('Saved to folder', r.dir);
      } catch (e) { fail(e, 'Download failed'); }
      save.disabled = false;
    }, 'small');
    actions = [install, save];
  } else {
    actions = [installButton(req, 'small', { label: 'Get from Website', run: doWebInstall })];
  }
  const channel = String(v.channel || 'release');
  const mc = v.gameVersions.length > 4 ? `${v.gameVersions.slice(0, 4).join(', ')} +${v.gameVersions.length - 4}` : v.gameVersions.join(', ');
  return h('div', { class: 'row' },
    h('div', { class: `badge ${channel}`, title: channel }, channel[0].toUpperCase()),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, v.name),
      h('div', { class: 'dim row-title' }, [mc, v.loaders.map((l) => LOADERS[l] || l).join(', ')].filter(Boolean).join('  |  ')),
      h('div', { class: 'faint row-title' }, [ago(v.date), v.file && fmtSize(v.file.size), v.downloads != null && `${fmtNum(v.downloads)} downloads`].filter(Boolean).join('  |  '))),
    h('div', { class: 'row-actions' }, actions));
}

function viewProject(v) {
  const P = S.project;
  const d = { ...P.hit, ...(P.detail || {}) };
  if (!d.author) d.author = P.hit.author;
  if (P.hit.type) d.type = P.hit.type;
  const t = installTarget();
  if (P.tab === 'versions' && P.detail) {
    const wanted = P.compatible ? `${t.gameVersion}/${t.loader}` : 'all';
    if (P.wanted !== wanted) {
      P.wanted = wanted;
      P.versions = null;
      loadVersions(P, d, wanted, P.compatible ? t : {});
    }
  }

  const content = h('div', { class: 'list' });
  if (P.error) add(content, message(h('p', { class: 'red' }, P.error), btn('Try Again', () => openProject(P.hit, P.from))));
  else if (!P.detail) add(content, loading());
  else if (P.tab === 'description') {
    const prose = h('div', { class: 'prose' });
    try {
      add(prose, Markdown.render(d.body || { format: 'markdown', text: '' }));
    } catch {
      // Never let a strange description take the page down: show it as plain text instead.
      fill(prose, h('pre', {}, String((d.body && d.body.text) || '')));
    }
    if (!prose.childNodes.length) add(prose, h('p', { class: 'dim' }, 'This project has no description.'));
    add(content, prose);
  } else if (P.tab === 'gallery') {
    add(content, Array.isArray(d.gallery) && d.gallery.length
      ? h('div', { class: 'gallery' }, d.gallery.map((g) =>
        h('figure', { class: 'shot', onclick: () => lightbox(g.full || g.url) },
          h('img', { src: g.url, alt: g.title || '', loading: 'lazy' }),
          g.title && h('figcaption', { class: 'dim' }, g.title))))
      : message(h('p', { class: 'dim' }, 'No screenshots.')));
  } else if (P.tab === 'versions') {
    if (!P.versions) { add(content, loading('Loading files...')); }
    else if (P.versions.error) add(content, message(h('p', { class: 'red' }, P.versions.error), btn('Try Again', () => { P.wanted = null; render(); })));
    else if (!P.versions.length) {
      add(content, message(
        h('p', { class: 'dim' }, P.compatible ? `No files for ${targetLabel(t)}.` : 'No files.'),
        P.compatible && btn('Show All Files', () => { P.compatible = false; render(); })));
    } else add(content, ...P.versions.map((ver) => versionRow(d, ver)));
  }

  const hasFilter = Boolean(t.gameVersion || t.loader);
  const fact = (k, val) => val != null && val !== '' && [h('dt', {}, k), h('dd', {}, val)];
  const link = (label, href) => href && h('a', { href }, label);
  const L = d.links || {};

  add(v, h('div', { class: 'proj' },
    h('div', { class: 'proj-main' },
      h('div', { class: 'proj-head' },
        slot(d.icon, 96),
        h('div', { class: 'row-main' },
          h('div', { class: 'big' }, d.title),
          h('div', { class: 'faint' }, d.author ? `by ${d.author} on ` : 'on ', h('span', { class: `pip ${d.source}` }), SOURCES[d.source]),
          h('div', { class: 'row-sum' }, d.summary))),
      P.tab === 'versions' && hasFilter && h('div', { class: 'bar' },
        check(`Only show files for ${targetLabel(t)}`, P.compatible, (on) => { P.compatible = on; render(); })),
      content),
    h('div', { class: 'proj-side' },
      h('dl', {},
        fact('Downloads', d.downloads != null ? fmtNum(d.downloads) : null),
        fact(d.source === 'modrinth' ? 'Followers' : 'Likes', d.follows != null ? fmtNum(d.follows) : null),
        fact('Updated', d.updated && ago(d.updated)),
        fact('Created', d.created && ago(d.created)),
        fact('License', d.license),
        fact('Client', d.clientSide),
        fact('Server', d.serverSide)),
      h('hr'),
      tags(d, 12),
      h('hr'),
      h('div', { class: 'links' },
        link(`Open on ${SOURCES[d.source]}`, d.url),
        link('Source code', L.source), link('Issue tracker', L.issues), link('Wiki', L.wiki), link('Discord', L.discord)))));
}

/* ---------- game log ---------- */

let logTimer = null;
const LOG_LINES = 4000; // the view keeps this many lines; the full log stays in its file

// Live view of the selected instance's game log: asks for what is new once a second and
// keeps the view pinned to the bottom unless the reader has scrolled up.
function viewLog(v, inst) {
  const where = h('span', { class: 'dim path' });
  const out = h('div', { class: 'log' });
  const box = h('div', { class: 'list' }, out);
  const follow = check('Follow', true, () => { if (follow.firstChild.checked) box.scrollTop = box.scrollHeight; });
  add(v, h('div', { class: 'bar' }, h('span', {}, `Game log of ${inst.name}`), where, h('div', { class: 'push' }, follow)), box);
  box.addEventListener('scroll', () => { follow.firstChild.checked = box.scrollHeight - box.scrollTop - box.clientHeight < 40; });

  let source = '', offset = 0, waiting = false, empty = true;
  const note = (text) => { fill(out, h('div', { class: 'faint' }, text)); empty = true; };
  note('Waiting for the game to write a log...');
  const poll = async () => {
    if (waiting || !out.isConnected) return;
    waiting = true;
    let r = null;
    try { r = await api('log.read', { id: inst.id, source, offset }); } catch {}
    waiting = false;
    if (!r || !out.isConnected) return;
    if (r.reset) note(r.source ? '' : 'No log yet. It appears here once the game has been started.');
    source = r.source;
    offset = r.offset;
    where.textContent = r.source ? '\u200e' + r.source : '';
    if (!r.text) return;
    if (empty) { fill(out); empty = false; }
    for (const line of r.text.split('\n')) {
      if (!line) continue;
      const tone = /\b(ERROR|FATAL|Exception|Caused by)\b|^\s+at /.test(line) ? 'err' : /\bWARN\b/.test(line) ? 'warn' : '';
      add(out, h('div', { class: tone }, line));
    }
    while (out.childElementCount > LOG_LINES) out.firstChild.remove();
    if (follow.firstChild.checked) box.scrollTop = box.scrollHeight;
  };
  poll();
  logTimer = setInterval(poll, 1000);
}

/* ---------- library ---------- */

function viewLibrary(v) {
  const inst = activeInst();
  const lib = S.library;
  if (!inst) {
    add(v, h('div', { class: 'list' }, message(
      h('p', {}, 'No instance selected'),
      h('p', { class: 'dim' }, 'An instance is a Minecraft game folder. Modion installs into it and lists what is inside.'),
      btn('Select Instance...', () => openInstances()))));
    return;
  }
  if (lib.type === 'log') { viewLog(v, inst); return; }
  const list = h('div', { class: 'list' }, loading('Reading folder...'));
  const summary = h('span', { class: 'dim' });
  add(v, h('div', { class: 'bar' }, summary,
      h('div', { class: 'push' }, btn('Open Folder', () => api('library.openFolder', { type: lib.type }).catch(fail)))),
    list);

  const type = lib.type;
  const stale = () => S.view !== 'library' || lib.type !== type || !list.isConnected;
  let latest = 0;
  const refresh = async () => {
    const mine = ++latest; // a slower, older listing must not overwrite a newer one
    let res = null, error = null;
    try { res = await api('library.list', { type }); } catch (e) { error = e; }
    if (stale() || mine !== latest) return;
    if (!res || !Array.isArray(res.files)) {
      summary.textContent = '';
      fill(list, message(h('p', { class: 'red' }, error ? error.message : 'The folder could not be read.'), btn('Try Again', refresh)));
      return;
    }
    const off = res.files.filter((f) => !f.enabled).length;
    summary.textContent = `${res.files.length} file${res.files.length === 1 ? '' : 's'}${off ? `, ${off} disabled` : ''}`;
    if (!res.files.length) {
      fill(list, message(
        h('p', {}, `No ${TYPES[type].toLowerCase()} in this instance yet`),
        btn(`Browse ${TYPES[type]}`, () => { invalidateResults({ type, category: '' }); go('browse'); })));
      return;
    }
    fill(list, ...res.files.map((f) => {
      const m = f.meta;
      const title = h('div', { class: `row-title ${f.enabled ? '' : 'faint'}` }, m ? m.title : f.name);
      const open = m && (() => openProject({ source: m.source, id: m.projectId, type, title: m.title, icon: m.icon, summary: '' }, 'library'));
      return h('div', { class: `row ${open ? 'click' : ''}`, onclick: open || null },
        slot(m && m.icon, 48),
        h('div', { class: 'row-main' },
          title,
          h('div', { class: 'faint row-title' }, [m && m.versionName, m ? SOURCES[m.source] || m.source : 'Unrecognised file', fmtSize(f.size)].filter(Boolean).join('  |  ')),
          m && h('div', { class: 'faint row-title' }, f.name)),
        h('div', { class: 'row-actions' },
          check('Enabled', f.enabled, async (on, box) => {
            box.disabled = true; // the file is being renamed; a second click would target the old name
            try { await api('library.toggle', { type, file: f.file }); } catch (err) { fail(err); }
            refresh();
          }),
          btn('Remove', async (e) => {
            e.stopPropagation();
            const yes = await confirmScreen('Remove this file?', [`'${m ? m.title : f.name}' will be moved to the trash.`, f.name], 'Remove');
            if (!yes) return;
            try {
              await api('library.remove', { type, file: f.file });
              setConfig(await api('config.get'));
            } catch (err) { fail(err); }
            refresh();
          }, 'small')));
    }));
  };
  refresh();
}

/* ---------- settings ---------- */

let signingIn = false; // a Microsoft sign-in is waiting on the browser

function viewSettings(v) {
  const key = h('input', { class: 'field', type: 'password', placeholder: S.cfg.ownCurseforgeKey ? 'A key is saved. Paste a new one to replace it.' : 'Paste your CurseForge API key', spellcheck: false, autocomplete: 'off' });
  const status = h('p', { class: S.cfg.hasCurseforgeKey ? 'label' : '' }, !S.cfg.hasCurseforgeKey ? 'CurseForge is not connected yet.' : S.cfg.ownCurseforgeKey ? 'CurseForge is connected with your own key.' : 'CurseForge is connected with the key that came with Modion. You can use your own instead.');
  const save = btn('Save Key', async () => {
    if (!key.value.trim()) return;
    save.disabled = true;
    save.textContent = 'Checking...';
    try {
      setConfig(await api('config.setCurseforgeKey', { key: key.value }));
      invalidateResults();
      toast('CurseForge connected', 'The key works and has been saved.');
    } catch (e) { fail(e, 'Key not saved'); }
    if (S.view === 'settings') render();
  }, 'green');
  const forget = S.cfg.ownCurseforgeKey && btn('Forget Key', async () => {
    try { setConfig(await api('config.setCurseforgeKey', { key: '' })); invalidateResults(); } catch (e) { fail(e); }
    if (S.view === 'settings') render();
  });
  key.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });

  // Minecraft account: sign-in happens in the system browser; this panel only starts it and shows the result.
  const who = S.cfg.account;
  const clientId = h('input', { class: 'field', value: S.cfg.msClientId || '', placeholder: 'Modion\'s own application ID', spellcheck: false, maxLength: 60 });
  const act = async (call, title) => {
    try { setConfig(await call); } catch (e) { if (e.code !== 'CANCELLED') fail(e, title); }
    signingIn = false;
    if (S.view === 'settings') render();
  };
  const saveId = btn('Save ID', () => act(api('account.setClientId', { clientId: clientId.value }), 'ID not saved'));
  const signIn = signingIn
    ? btn('Cancel Sign-in', () => api('account.cancel').catch(() => {}))
    : who
      ? btn('Sign Out', () => act(api('account.signOut'), 'Could not sign out'))
      : btn('Sign In with Microsoft', () => { signingIn = true; render(); act(api('account.signIn'), 'Sign-in failed'); }, 'green');

  // How Play starts the game.
  const mode = S.cfg.launchMode || 'prism';
  const setLaunch = (patch) => act(api('settings.setLaunch', { mode, offlineName: S.cfg.offlineName || '', ...patch }), 'Setting not saved');
  const modes = [['prism', 'Through Prism Launcher'], ['account', 'Directly, with my Microsoft account']];
  if (S.cfg.offlineAllowed) modes.push(['offline', 'Directly, offline (this developer machine only)']);
  const offlineName = h('input', { class: 'field', value: S.cfg.offlineName || '', placeholder: 'Player name', spellcheck: false, maxLength: 16 });
  const modeNote = mode === 'prism'
    ? 'Play hands the instance to Prism Launcher, or opens the launcher that owns it.'
    : mode === 'account'
      ? (who ? `Play starts the game as ${who.name}.` : 'Not signed in yet, so Play still goes through Prism Launcher. Sign in below.')
      : (/^\w{3,16}$/.test(S.cfg.offlineName || '') ? `Play starts the game offline as ${S.cfg.offlineName}. Online servers will refuse an offline player.` : 'Enter a player name (3 to 16 letters, digits or underscores) to use offline mode.');

  add(v, h('div', { class: 'settings' },
    h('div', { class: 'panel' },
      h('h2', {}, 'Starting the game'),
      h('div', { class: 'bar' }, select(modes, mode, (val) => setLaunch({ mode: val }))),
      mode === 'offline' && h('div', { class: 'bar' }, offlineName, btn('Save Name', () => setLaunch({ offlineName: offlineName.value }))),
      h('p', {}, modeNote),
      h('div', { class: 'bar' }, check('Show the game log when the game is started', S.cfg.openLogOnLaunch !== false,
        (on) => act(api('settings.setOpenLog', { on }), 'Setting not saved'))),
      h('p', { class: 'label' }, 'Starting directly works for vanilla, Fabric and Quilt on Minecraft 1.19 and newer. Other instances always use the launcher that owns them; the line under the Play button says which.')),
    h('div', { class: 'panel' },
      h('h2', {}, 'Minecraft account'),
      h('p', {}, 'Sign in with the Microsoft account that owns Minecraft: Java Edition. The sign-in page opens in your web browser; Modion never sees your password.'),
      h('p', {}, signingIn ? 'Waiting for you to finish signing in in your browser...' : who ? `Signed in as ${who.name}.` : 'Not signed in.'),
      h('div', { class: 'bar' }, signIn),
      who && mode !== 'account' && h('p', { class: 'label' }, 'Choose "Directly, with my Microsoft account" above to have Play start the game itself.'),
      h('details', {},
        h('summary', { class: 'label' }, 'Use a different application ID'),
        h('p', { class: 'label' }, 'For developers: the client ID of your own Microsoft app registration, approved for the Minecraft API, with the redirect URI http://localhost under "Mobile and desktop applications". Leave empty to use Modion\'s own. Changing it signs you out.'),
        h('div', { class: 'bar' }, clientId, saveId))),
    h('div', { class: 'panel' },
      h('h2', {}, 'CurseForge API key'),
      h('p', {}, 'Modrinth works out of the box. CurseForge only answers apps that send an API key, so browsing it needs your own (free) key from ',
        h('a', { href: 'https://console.curseforge.com/' }, 'console.curseforge.com'), '.'),
      status,
      h('div', { class: 'bar' }, key, save, forget),
      h('p', { class: 'label' }, 'The key is stored in Modion\'s config folder, readable only by your user. Some CurseForge authors switch off third-party downloads; for those files Modion opens the CurseForge page so you can press Download there, and puts the file in place.')),
    h('div', { class: 'panel' },
      h('h2', {}, 'Instances'),
      h('p', {}, `${S.cfg.instances.length} instance${S.cfg.instances.length === 1 ? '' : 's'} set up. Removed files go to the trash, and new versions replace old ones.`),
      btn('Manage Instances...', () => openInstances())),
    h('div', { class: 'panel' },
      h('h2', {}, `Modion ${S.cfg.version}`),
      h('p', { class: 'label' }, 'Not affiliated with Mojang, Microsoft, Modrinth or CurseForge. All artwork is drawn by the app itself.'))));
}

/* ---------- instances ---------- */

function openInstances({ autoDetect, start } = {}) {
  const body = h('div', { class: 'screen-body' });
  let detected = null;

  let editing = false; // true while the add/edit form is showing instead of the lists

  const apply = async (call) => {
    let ok = true;
    try { setConfig(await call, { follow: true }); } catch (e) { ok = false; fail(e); }
    if (ok || !editing) draw(); // a failed save leaves the form up with what was typed
  };

  function form(initial, onSave, { note, saveLabel = 'Save', vanilla = 'Not set / vanilla' } = {}) {
    const name = h('input', { class: 'field', value: initial.name || '', maxLength: 80 });
    let gameVersion = initial.gameVersion || '', loader = initial.loader || '';
    if (!body.isConnected) return;
    editing = true;
    footer(false);
    const save = btn(saveLabel, async () => {
      save.disabled = true; // creating talks to the network; one attempt at a time
      await onSave({ name: name.value, gameVersion, loader });
      save.disabled = false;
    }, 'green');
    fill(body, h('div', { class: 'form' },
      initial.path && h('div', { class: 'full dim path' }, '\u200e' + initial.path),
      h('div', {}, 'Name'), name,
      h('div', {}, 'Game version'), versionSelect(gameVersion, 'Not set', (val) => { gameVersion = val; }),
      h('div', {}, 'Mod loader'), select([['', vanilla], ...Object.entries(LOADERS).slice(1)], loader, (val) => { loader = val; }),
      h('div', { class: 'full faint' }, note || 'Version and loader decide which files Modion offers for this instance.'),
      h('div', { class: 'full bar' }, btn('Cancel', draw), save)));
    name.focus();
  }

  const instRow = (i) => h('div', {
    class: `row click ${i.id === S.cfg.activeInstanceId ? 'selected' : ''}`, tabIndex: 0,
    onclick: () => apply(api('instances.setActive', { id: i.id })),
  },
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, i.name, h('span', { class: 'gold' }, `  ${instLabel(i)}`)),
      h('div', { class: 'faint path' }, '\u200e' + i.path)),
    h('div', { class: 'row-actions' },
      btn('Edit', (e) => { e.stopPropagation(); form(i, (vals) => apply(api('instances.update', { id: i.id, ...vals }))); }, 'small'),
      btn('Forget', (e) => { e.stopPropagation(); apply(api('instances.remove', { id: i.id })); }, 'small')));

  const foundRow = (f) => {
    const add = btn(f.added ? 'Added' : 'Add', async () => { await apply(api('instances.add', f)); await detect(); }, 'green small');
    add.disabled = f.added;
    return h('div', { class: 'row' },
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title' }, f.name, h('span', { class: 'gold' }, `  ${instLabel(f)}`), h('span', { class: 'faint' }, `  ${f.launcher}`)),
        h('div', { class: 'faint path' }, '\u200e' + f.path)),
      h('div', { class: 'row-actions' }, add));
  };

  // The dialog's own buttons step aside while the edit form (with its Save/Cancel) is up.
  function footer(show) {
    const el = $('#overlay .screen-buttons');
    if (el) el.hidden = !show;
  }

  function draw() {
    if (!body.isConnected) return; // the dialog was closed while something was in flight
    editing = false;
    footer(true);
    const mine = S.cfg.instances;
    // replaceChildren() would print a null argument as the text "null", so absent parts are filtered out.
    fill(body, ...[
      h('div', { class: 'list' }, mine.length ? mine.map(instRow) : message(
        h('p', {}, 'No instances yet'),
        h('p', { class: 'dim' }, 'An instance is a Minecraft game folder (the one that holds "mods"). Create a new one, add one from your launchers, or pick a folder.'))),
      detected && h('div', { class: 'dim' }, detected.length ? 'Found on this computer:' : 'No launcher folders were found. Use "Add Folder..." instead.'),
      detected && detected.length ? h('div', { class: 'list' }, detected.map(foundRow)) : null,
    ].filter(Boolean));
  }

  const detect = async () => {
    try {
      const found = await api('instances.detect');
      detected = Array.isArray(found) ? found : [];
    } catch (e) { fail(e); }
    if (!editing) draw(); // never pull the form out from under someone typing in it
  };
  const newInstance = () => {
    form({ name: '', gameVersion: (activeInst() || {}).gameVersion || S.gameVersions[0] || '', loader: 'fabric' },
      async (vals) => {
        if (!vals.gameVersion) { fail(new Error('Pick a game version for the new instance.')); return; }
        await apply(api('instances.create', vals));
        if (start === 'new' && !editing) closeScreen(); // opened just to create one: done
      },
      {
        saveLabel: 'Create',
        vanilla: 'Vanilla (no mods)',
        note: 'The game is downloaded the first time you press Play. Leave the name empty to name the instance after its version.',
      });
  };
  const create = btn('New Instance...', newInstance);
  const addFolder = async () => {
    let dir;
    try { dir = await api('instances.pickFolder'); } catch (e) { return fail(e); }
    if (!dir || typeof dir !== 'string') return;
    form({ path: dir, name: dir.split('/').filter(Boolean).pop() }, (vals) => apply(api('instances.add', { path: dir, ...vals })));
  };

  showScreen('Select Instance', body,
    [btn('Detect Launchers', detect), btn('Add Folder...', addFolder), create, btn('Done', closeScreen, 'green')],
    render);
  draw();
  if (autoDetect) detect();
  if (start === 'new') newInstance();
}

/* ---------- instances page ---------- */

function renameInstance(i) {
  const input = h('input', { class: 'field', value: i.name, maxLength: 60 });
  const save = async () => {
    try {
      setConfig(await api('instances.rename', { id: i.id, name: input.value }));
      closeScreen();
    } catch (e) { fail(e, 'Could not rename'); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  showScreen('Rename Instance', h('div', { class: 'screen-body' }, h('div', { class: 'form' }, h('div', {}, 'Name'), input)),
    [btn('Cancel', closeScreen), btn('Rename', save, 'green')], render);
  input.focus();
  input.select();
}

function viewInstances(v) {
  if (S.instancesTab === 'log') {
    const inst = activeInst();
    if (inst) viewLog(v, inst);
    else add(v, h('div', { class: 'list' }, message(h('p', {}, 'No instance selected'), h('p', { class: 'dim' }, 'Select an instance to see its game log.'))));
    return;
  }
  const redraw = () => { if (S.view === 'instances') render(); };
  const change = async (call, title) => {
    try { setConfig(await call, { follow: true }); } catch (e) { fail(e, title); }
    redraw();
  };
  const importPack = btn('Import Modpack...', async () => {
    importPack.disabled = true;
    importPack.textContent = 'Importing...';
    try {
      const r = await api('instances.import');
      if (r) {
        setConfig(r.config, { follow: true });
        toast('Modpack imported', `${r.name}: ${r.files} file${r.files === 1 ? '' : 's'} downloaded.`);
        const left = Array.isArray(r.skipped) ? r.skipped : [];
        for (const sk of left.slice(0, 4)) toast('Left out of the pack', `${sk.title}: ${sk.reason}`, { tone: 'gold', time: 12000 });
        if (left.length > 4) toast('Left out of the pack', `...and ${left.length - 4} more files.`, { tone: 'gold', time: 12000 });
      }
    } catch (e) { fail(e, 'Import failed'); }
    redraw();
  });

  const row = (i) => {
    const active = i.id === S.cfg.activeInstanceId;
    const select = btn(active ? 'Selected' : 'Select', () => change(api('instances.setActive', { id: i.id }), 'Could not select'), 'small');
    select.disabled = active;
    return h('div', { class: `row ${active ? 'selected' : ''}` },
      h('div', { class: 'slot s48' }, h('img', { class: 'px', alt: '', src: Pixel.icon('logo') })),
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title' }, i.name, h('span', { class: 'gold' }, `  ${instLabel(i)}`),
          h('span', { class: 'faint' }, `  ${i.managed ? 'made by Modion' : 'added from elsewhere'}`)),
        h('div', { class: 'faint path' }, '\u200e' + i.path),
        h('div', { class: 'faint row-title' }, i.launch ? `${i.launch.play ? 'Play' : 'Open'}: ${i.launch.label}` : 'Play is not available for this instance with the current launch setting')),
      h('div', { class: 'row-actions' },
        select,
        btn('Open Folder', () => api('instances.openFolder', { id: i.id }).catch(fail), 'small'),
        i.managed && btn('Rename', () => renameInstance(i), 'small'),
        i.managed
          ? btn('Delete', async () => {
            const yes = await confirmScreen('Delete this instance?',
              [`"${i.name}" and everything in it, including its worlds, will be moved to the trash.`, i.home], 'Delete');
            if (yes) change(api('instances.delete', { id: i.id }), 'Could not delete');
          }, 'small')
          : btn('Forget', () => change(api('instances.remove', { id: i.id }), 'Could not remove'), 'small')));
  };

  add(v, h('div', { class: 'bar' },
      btn('New Instance...', () => openInstances({ start: 'new' }), 'green'),
      importPack,
      btn('Add Existing...', () => openInstances({ autoDetect: true })),
      h('span', { class: 'push dim' }, `${S.cfg.instances.length} instance${S.cfg.instances.length === 1 ? '' : 's'}`)),
    h('div', { class: 'list' }, S.cfg.instances.length ? S.cfg.instances.map(row) : message(
      h('p', {}, 'No instances yet'),
      h('p', { class: 'dim' }, 'Create a new instance, import a modpack (.mrpack or a CurseForge zip), or add a game folder you already have.'))));
}

/* ---------- start ---------- */

(async function start() {
  try {
    setConfig(await api('config.get'), { follow: true });
  } catch (e) { fail(e); }
  render();
  loadGameVersions();
  if (!S.cfg.instances.length) openInstances({ autoDetect: true });
})();
