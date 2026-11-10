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
  el.append(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return el;
}

async function api(method, args) {
  let r;
  try {
    r = await window.modion.call(method, args);
  } catch {
    throw Object.assign(new Error('The app\'s background process did not answer.'), { code: 'IPC' });
  }
  if (!r || !r.ok) throw Object.assign(new Error((r && r.error) || 'Something went wrong.'), { code: r && r.code });
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
  browse: { source: 'modrinth', type: 'mod', query: '', gameVersion: '', loader: '', sort: 'relevance', page: 0, results: null, scroll: 0 },
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
      menu.replaceChildren(...versionOptions(current, blank).map(([v, label]) => h('option', { value: v, selected: v === current }, label)));
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
  $('#toasts').append(el);
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
  if (!active.length) { box.replaceChildren(); return; }
  const j = active[active.length - 1];
  const pct = j.total ? Math.min(100, Math.round((j.received / j.total) * 100)) : 0;
  const fill = h('i');
  fill.style.width = pct + '%';
  box.replaceChildren(
    h('div', { class: 'job-name' }, `Downloading ${j.filename}${active.length > 1 ? ` (+${active.length - 1} more)` : ''}`),
    h('div', { class: 'job-line' }, h('div', { class: 'xp' }, fill), h('span', {}, j.total ? `${pct}%` : fmtSize(j.received))));
}

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
  o.replaceChildren(h('div', { class: 'modal' },
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
  o.replaceChildren();
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
  o.replaceChildren(h('img', { src, alt: '' }));
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
  $('#rail').replaceChildren(
    h('div', { class: 'brand' },
      h('img', { class: 'px', alt: '', src: Pixel.icon('logo') }),
      h('div', {}, h('div', { class: 'brand-name' }, 'Modion'), h('div', { class: 'faint small' }, 'Mod manager'))),
    h('div', { class: 'nav-label' }, 'Browse'),
    ...Object.entries(SOURCES).map(([id, name]) =>
      item(P ? P.from === 'browse' && P.hit.source === id : S.view === 'browse' && S.browse.source === id, id, name, () => {
        if (S.browse.source !== id) invalidateResults({ source: id });
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
    tabs = typeTabs(S.browse.type, (type) => { if (type !== S.browse.type) invalidateResults({ type }); render(); });
  } else if (S.view === 'library') {
    const inst = activeInst();
    title = inst ? `Library / ${inst.name}` : 'Library';
    tabs = typeTabs(S.library.type, (type) => { S.library.type = type; render(); });
  } else if (S.view === 'project') {
    const P = S.project;
    title = P.hit.title;
    back = h('button', { class: 'back', title: 'Back', onclick: () => go(P.from || 'browse') }, '\u2190');
    tabs = [['description', 'Description'], ['gallery', P.detail && Array.isArray(P.detail.gallery) ? `Gallery (${P.detail.gallery.length})` : 'Gallery'], ['versions', 'Files']]
      .map(([id, label]) => tab(label, P.tab === id, () => { P.tab = id; render(); }));
  } else {
    title = 'Settings';
    tabs = [tab('General', true, () => {})];
  }
  $('#top').replaceChildren(h('div', { class: 'title' }, back, h('span', {}, title)), h('div', { class: 'tabs' }, tabs));
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
      } catch (e) { fail(e, 'Could not start the game'); }
      setTimeout(() => { play.disabled = false; }, 4000); // long enough that a double click cannot start it twice
      play.textContent = label;
    }, 'green play');
    action = h('div', { class: 'action' }, play,
      h('div', { class: 'faint small' }, inst.launch.play ? `via ${inst.launch.label}` : `${inst.launch.label} starts this instance`));
  }
  $('#bottom').replaceChildren(picker, action, h('div', { id: 'jobs' }));
  drawJobs();
}

function render() {
  renderRail();
  renderTop();
  renderBottom();
  const v = $('#view');
  v.replaceChildren();
  ({ browse: viewBrowse, project: viewProject, library: viewLibrary, settings: viewSettings })[S.view](v);
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
  b.textContent = working ? 'Installing...' : installed ? 'Installed' : 'Install';
  b.disabled = working || installed;
}

const paintInstalls = () => document.querySelectorAll('button[data-install]').forEach(paintInstall);

function installButton(req, cls) {
  const b = h('button', {
    class: `btn green ${cls || ''}`,
    'data-install': `${req.source}:${req.projectId}`,
    'data-version': req.versionId || null,
    onclick: (e) => { e.stopPropagation(); doInstall(req); },
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
  try {
    const r = await api('install', req);
    if (r && r.installed_ids) S.cfg.installed = r.installed_ids;
    for (const s of (r && r.skipped) || []) toast('Heads up', `${s.title}: ${s.reason}`, { tone: 'gold', time: 9000 });
    if (!req.versionId && !req.gameVersion) {
      toast('Newest file installed', 'This instance has no game version set, so compatibility was not checked.', { tone: 'gold', time: 9000 });
    }
  } catch (e) {
    fail(e, 'Install failed');
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
  list.replaceChildren(loading(`Searching ${SOURCES[b.source]}...`));
  pager.replaceChildren();
  let res = null, error = null;
  try {
    const { source, type, query, gameVersion, loader, sort, page } = b;
    res = await api('search', { source, type, query, gameVersion, loader, sort, page });
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
    now.replaceChildren(message(
      h('p', { class: 'yellow' }, error.code === 'NO_CF_KEY' ? 'CurseForge needs an API key' : 'CurseForge rejected the API key'),
      h('p', { class: 'dim' }, 'CurseForge only lets apps browse with a key. You can get a free one and paste it into Settings.'),
      btn('Open Settings', () => go('settings'), 'green')));
  } else {
    now.replaceChildren(message(h('p', { class: 'red' }, error ? error.message : 'The search returned nothing usable.'), btn('Try Again', loadResults)));
  }
}

function drawResults() {
  const b = S.browse, res = b.results;
  const list = $('#results'), pager = $('#pager');
  if (!list || !res) return;
  list.replaceChildren(...(res.hits.length ? res.hits.map(hitRow) : [message(h('p', { class: 'dim' }, 'Nothing found. Try fewer filters.'))]));
  list.scrollTop = b.scroll;
  b.scroll = 0;
  const total = Number(res.total) || 0;
  const pages = Math.max(1, Math.ceil(total / (res.pageSize || 20)));
  const turn = (d) => () => { b.page = Math.min(Math.max(b.page + d, 0), pages - 1); loadResults(); };
  const prev = btn('< Prev', turn(-1), 'small'), next = btn('Next >', turn(1), 'small');
  prev.disabled = b.page <= 0;
  next.disabled = b.page >= pages - 1;
  pager.replaceChildren(
    h('div', { class: 'dim' }, `${total.toLocaleString()} result${total === 1 ? '' : 's'}`),
    h('div', { class: 'bar' }, prev, h('span', {}, `Page ${b.page + 1} of ${pages.toLocaleString()}`), next),
    h('div'));
}

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
  v.append(
    h('div', { class: 'bar' },
      search,
      versionSelect(b.gameVersion, 'Any version', (gameVersion) => change({ gameVersion })),
      b.type === 'mod' && select(Object.entries(LOADERS), b.loader, (loader) => change({ loader })),
      select(Object.entries(SORTS), b.sort, (sort) => change({ sort }))),
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
    actions = [btn('Website Only', () => api('openExternal', { url: d.url }).catch(fail), 'small')];
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
  if (P.error) content.append(message(h('p', { class: 'red' }, P.error), btn('Try Again', () => openProject(P.hit, P.from))));
  else if (!P.detail) content.append(loading());
  else if (P.tab === 'description') {
    const prose = h('div', { class: 'prose' });
    try {
      prose.append(Markdown.render(d.body || { format: 'markdown', text: '' }));
    } catch {
      // Never let a strange description take the page down: show it as plain text instead.
      prose.replaceChildren(h('pre', {}, String((d.body && d.body.text) || '')));
    }
    if (!prose.childNodes.length) prose.append(h('p', { class: 'dim' }, 'This project has no description.'));
    content.append(prose);
  } else if (P.tab === 'gallery') {
    content.append(Array.isArray(d.gallery) && d.gallery.length
      ? h('div', { class: 'gallery' }, d.gallery.map((g) =>
        h('figure', { class: 'shot', onclick: () => lightbox(g.full || g.url) },
          h('img', { src: g.url, alt: g.title || '', loading: 'lazy' }),
          g.title && h('figcaption', { class: 'dim' }, g.title))))
      : message(h('p', { class: 'dim' }, 'No screenshots.')));
  } else if (P.tab === 'versions') {
    if (!P.versions) { content.append(loading('Loading files...')); }
    else if (P.versions.error) content.append(message(h('p', { class: 'red' }, P.versions.error), btn('Try Again', () => { P.wanted = null; render(); })));
    else if (!P.versions.length) {
      content.append(message(
        h('p', { class: 'dim' }, P.compatible ? `No files for ${targetLabel(t)}.` : 'No files.'),
        P.compatible && btn('Show All Files', () => { P.compatible = false; render(); })));
    } else content.append(...P.versions.map((ver) => versionRow(d, ver)));
  }

  const hasFilter = Boolean(t.gameVersion || t.loader);
  const fact = (k, val) => val != null && val !== '' && [h('dt', {}, k), h('dd', {}, val)];
  const link = (label, href) => href && h('a', { href }, label);
  const L = d.links || {};

  v.append(h('div', { class: 'proj' },
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

/* ---------- library ---------- */

function viewLibrary(v) {
  const inst = activeInst();
  const lib = S.library;
  if (!inst) {
    v.append(h('div', { class: 'list' }, message(
      h('p', {}, 'No instance selected'),
      h('p', { class: 'dim' }, 'An instance is a Minecraft game folder. Modion installs into it and lists what is inside.'),
      btn('Select Instance...', () => openInstances()))));
    return;
  }
  const list = h('div', { class: 'list' }, loading('Reading folder...'));
  const summary = h('span', { class: 'dim' });
  v.append(
    h('div', { class: 'bar' }, summary,
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
      list.replaceChildren(message(h('p', { class: 'red' }, error ? error.message : 'The folder could not be read.'), btn('Try Again', refresh)));
      return;
    }
    const off = res.files.filter((f) => !f.enabled).length;
    summary.textContent = `${res.files.length} file${res.files.length === 1 ? '' : 's'}${off ? `, ${off} disabled` : ''}`;
    if (!res.files.length) {
      list.replaceChildren(message(
        h('p', {}, `No ${TYPES[type].toLowerCase()} in this instance yet`),
        btn(`Browse ${TYPES[type]}`, () => { invalidateResults({ type }); go('browse'); })));
      return;
    }
    list.replaceChildren(...res.files.map((f) => {
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
  const key = h('input', { class: 'field', type: 'password', placeholder: S.cfg.hasCurseforgeKey ? 'A key is saved. Paste a new one to replace it.' : 'Paste your CurseForge API key', spellcheck: false, autocomplete: 'off' });
  const status = h('p', { class: S.cfg.hasCurseforgeKey ? 'label' : '' }, S.cfg.hasCurseforgeKey ? 'CurseForge is connected.' : 'CurseForge is not connected yet.');
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
  const forget = S.cfg.hasCurseforgeKey && btn('Forget Key', async () => {
    try { setConfig(await api('config.setCurseforgeKey', { key: '' })); invalidateResults(); } catch (e) { fail(e); }
    if (S.view === 'settings') render();
  });
  key.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });

  // Minecraft account: sign-in happens in the system browser; this panel only starts it and shows the result.
  const who = S.cfg.account;
  const clientId = h('input', { class: 'field', value: S.cfg.msClientId || '', placeholder: '00000000-0000-0000-0000-000000000000', spellcheck: false, maxLength: 60 });
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
  if (!who && !signingIn && !S.cfg.msClientId) signIn.disabled = true;

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

  v.append(h('div', { class: 'settings' },
    h('div', { class: 'panel' },
      h('h2', {}, 'Starting the game'),
      h('div', { class: 'bar' }, select(modes, mode, (val) => setLaunch({ mode: val }))),
      mode === 'offline' && h('div', { class: 'bar' }, offlineName, btn('Save Name', () => setLaunch({ offlineName: offlineName.value }))),
      h('p', {}, modeNote),
      h('p', { class: 'label' }, 'Starting directly works for vanilla, Fabric and Quilt on Minecraft 1.19 and newer. Other instances always use the launcher that owns them; the line under the Play button says which.')),
    h('div', { class: 'panel' },
      h('h2', {}, 'Minecraft account'),
      h('p', {}, 'Signing in needs the application (client) ID of your own Microsoft app registration, approved for the Minecraft API. The sign-in page opens in your web browser; Modion never sees your password.'),
      h('div', { class: 'bar' }, clientId, saveId),
      h('p', {}, signingIn ? 'Waiting for you to finish signing in in your browser...' : who ? `Signed in as ${who.name}.` : 'Not signed in.'),
      h('div', { class: 'bar' }, signIn),
      h('p', { class: 'label' }, 'In the app registration, add the redirect URI http://localhost under "Mobile and desktop applications". Once signed in, choose "Directly, with my Microsoft account" above to have Play start the game itself.')),
    h('div', { class: 'panel' },
      h('h2', {}, 'CurseForge API key'),
      h('p', {}, 'Modrinth works out of the box. CurseForge only answers apps that send an API key, so browsing it needs your own (free) key from ',
        h('a', { href: 'https://console.curseforge.com/' }, 'console.curseforge.com'), '.'),
      status,
      h('div', { class: 'bar' }, key, save, forget),
      h('p', { class: 'label' }, 'The key is stored in Modion\'s config folder, readable only by your user. Some CurseForge authors switch off third-party downloads; those files show a "Website Only" button.')),
    h('div', { class: 'panel' },
      h('h2', {}, 'Instances'),
      h('p', {}, `${S.cfg.instances.length} instance${S.cfg.instances.length === 1 ? '' : 's'} set up. Removed files go to the trash, and new versions replace old ones.`),
      btn('Manage Instances...', () => openInstances())),
    h('div', { class: 'panel' },
      h('h2', {}, `Modion ${S.cfg.version}`),
      h('p', { class: 'label' }, 'Not affiliated with Mojang, Microsoft, Modrinth or CurseForge. All artwork is drawn by the app itself.'))));
}

/* ---------- instances ---------- */

function openInstances({ autoDetect } = {}) {
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
    body.replaceChildren(h('div', { class: 'form' },
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
    body.replaceChildren(...[
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
      (vals) => (vals.gameVersion ? apply(api('instances.create', vals)) : fail(new Error('Pick a game version for the new instance.'))),
      {
        saveLabel: 'Create',
        vanilla: 'Vanilla (no mods)',
        note: 'The instance is created in Prism Launcher, which downloads the game the first time you press Play. Leave the name empty to name it after the version.',
      });
  };
  const create = btn('New Instance...', newInstance);
  if (!S.cfg.canCreate) {
    create.disabled = true;
    create.title = 'Creating instances needs Prism Launcher, which was not found on this computer.';
  }
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
