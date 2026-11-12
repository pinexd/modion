'use strict';
// CurseForge Core API client. Needs the user's own API key (console.curseforge.com).

const { getJson, ApiError, arr } = require('./http');

const BASE = 'https://api.curseforge.com/v1';
const GAME = 432; // Minecraft
const PAGE = 20;
const MAX_INDEX = 10000; // the API refuses index + pageSize beyond this
const CLASS = { mod: 6, resourcepack: 12, shader: 6552, datapack: 6945, modpack: 4471 };
const CLASS_SLUG = { mod: 'mc-mods', resourcepack: 'texture-packs', shader: 'shaders', datapack: 'data-packs', modpack: 'modpacks' };
// Mods and modpacks are made for a mod loader; the other kinds are not.
const hasLoader = (type) => type === 'mod' || type === 'modpack';
const LOADER = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
const LOADER_NAMES = Object.keys(LOADER);
const SORT = { downloads: 6, updated: 3, newest: 11 };
const CHANNEL = { 1: 'release', 2: 'beta', 3: 'alpha' };

let apiKey = '';
const setKey = (k) => { apiKey = String(k || '').trim(); };
const getKey = () => apiKey;
const hasKey = () => Boolean(apiKey);

async function cf(path, params, body) {
  if (!apiKey) throw new ApiError('CurseForge needs an API key. Add one in Settings.', 'NO_CF_KEY');
  const qs = params
    ? '?' + Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&')
    : '';
  let reply;
  try {
    reply = await getJson(`${BASE}${path}${qs}`, { headers: { 'x-api-key': apiKey }, ...(body ? { method: 'POST', body } : {}) });
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      throw new ApiError(
        `CurseForge refused the API key (HTTP ${e.status}, no reason given). It must be a Core API key from console.curseforge.com that starts with $2a$10$; keys starting with cfc_ are a different kind of token. Paste it without spaces or quotes.`,
        'BAD_CF_KEY', e.status);
    }
    throw e;
  }
  if (!reply || typeof reply !== 'object') throw new ApiError('CurseForge sent a reply that could not be read.', 'BAD_REPLY');
  return reply;
}

// Like cf(), for endpoints whose `data` must be an object.
async function cfObject(path, params) {
  const reply = await cf(path, params);
  if (!reply.data || typeof reply.data !== 'object') throw new ApiError('CurseForge has no such item.', 'NOT_FOUND');
  return reply.data;
}

function normProject(m, type) {
  const authors = arr(m.authors);
  const links = m.links || {};
  return {
    source: 'curseforge',
    id: String(m.id),
    slug: m.slug,
    type,
    title: m.name || m.slug || 'Untitled',
    summary: m.summary || '',
    author: (authors[0] && authors[0].name) || null,
    icon: (m.logo && (m.logo.thumbnailUrl || m.logo.url)) || null,
    downloads: m.downloadCount,
    follows: m.thumbsUpCount || null,
    updated: m.dateModified,
    created: m.dateCreated,
    categories: arr(m.categories).map((c) => c && c.name).filter(Boolean),
    loaders: [...new Set(arr(m.latestFilesIndexes).map((f) => LOADER_NAMES.find((n) => LOADER[n] === f.modLoader)).filter(Boolean))],
    url: links.websiteUrl || `https://www.curseforge.com/minecraft/${CLASS_SLUG[type] || 'mc-mods'}/${m.slug}`,
  };
}

const typeOf = (m) => Object.keys(CLASS).find((t) => CLASS[t] === m.classId) || 'mod';

function normFile(f) {
  const gv = arr(f.gameVersions).map(String);
  const sha1 = arr(f.hashes).find((h) => h && h.algo === 1 && h.value);
  const usable = Boolean(f.downloadUrl && f.fileName);
  return {
    id: String(f.id),
    projectId: String(f.modId),
    name: f.displayName || f.fileName || 'Unnamed file',
    versionNumber: f.fileName || '',
    channel: CHANNEL[f.releaseType] || 'release',
    gameVersions: gv.filter((v) => /^\d/.test(v)),
    loaders: gv.map((v) => v.toLowerCase()).filter((v) => LOADER_NAMES.includes(v)),
    date: f.fileDate,
    downloads: f.downloadCount,
    // downloadUrl is null when the author has opted out of third-party downloads.
    file: usable ? { url: f.downloadUrl, filename: f.fileName, size: f.fileLength || 0, sha1: sha1 && sha1.value } : null,
    // What the file must be, however it is obtained (used when it is downloaded from the website by hand).
    expected: f.fileName ? { filename: f.fileName, size: f.fileLength || 0, sha1: sha1 && sha1.value } : null,
    blocked: !usable,
    dependencies: arr(f.dependencies)
      .filter((d) => d && d.relationType === 3 && d.modId)
      .map((d) => ({ projectId: String(d.modId), versionId: null })),
  };
}

async function search({ type = 'mod', query = '', gameVersion, loader, categories = [], sort = 'relevance', page = 0 }) {
  const ids = arr(categories).filter((c) => /^\d+$/.test(c)).slice(0, 10); // the API takes at most ten
  const index = page * PAGE;
  if (index + PAGE > MAX_INDEX) throw new ApiError('CurseForge only serves the first 10,000 results. Narrow the search instead.', 'RANGE');
  const res = await cf('/mods/search', {
    gameId: GAME,
    classId: CLASS[type] || CLASS.mod,
    searchFilter: query,
    categoryId: ids.length === 1 ? ids[0] : undefined,
    categoryIds: ids.length > 1 ? `[${ids.join(',')}]` : undefined,
    gameVersion,
    modLoaderType: hasLoader(type) && loader ? LOADER[loader] : undefined,
    sortField: SORT[sort] || (query ? undefined : 2),
    sortOrder: 'desc',
    index,
    pageSize: PAGE,
  });
  const hits = arr(res.data).map((m) => normProject(m, type));
  const reported = Number(res.pagination && res.pagination.totalCount);
  return {
    total: Math.min(Number.isFinite(reported) ? reported : index + hits.length, MAX_INDEX),
    page,
    pageSize: PAGE,
    hits,
  };
}

async function project(id) {
  const [m, desc] = await Promise.all([
    cfObject(`/mods/${encodeURIComponent(id)}`),
    cf(`/mods/${encodeURIComponent(id)}/description`).catch(() => ({ data: '' })),
  ]);
  const links = m.links || {};
  return {
    ...normProject(m, typeOf(m)),
    gameVersions: [...new Set(arr(m.latestFilesIndexes).map((f) => f.gameVersion).filter(Boolean))],
    body: { format: 'html', text: typeof desc.data === 'string' ? desc.data : '' },
    gallery: arr(m.screenshots)
      .filter((s) => s && (s.url || s.thumbnailUrl))
      .map((s) => ({ url: s.thumbnailUrl || s.url, full: s.url || s.thumbnailUrl, title: s.title || '', description: s.description || '' })),
    license: null,
    links: { source: links.sourceUrl, issues: links.issuesUrl, wiki: links.wikiUrl },
  };
}

async function versions(id, { type, gameVersion, loader } = {}) {
  const res = await cf(`/mods/${encodeURIComponent(id)}/files`, {
    gameVersion,
    modLoaderType: hasLoader(type) && loader ? LOADER[loader] : undefined,
    pageSize: 50,
  });
  return arr(res.data).map(normFile);
}

async function getVersion(projectId, versionId) {
  return normFile(await cfObject(`/mods/${encodeURIComponent(projectId)}/files/${encodeURIComponent(versionId)}`));
}

// Newest downloadable file; if every file is website-only, return one so the caller can say so.
async function latest(projectId, opts) {
  const list = await versions(projectId, opts);
  return list.find((v) => v.file) || list[0] || null;
}

// For projects already installed: the newest released file of each that fits `opts`.
// installed: [{ projectId, versionId }] -> { projectId: { id, name } } where that file is
// newer than the installed one (CurseForge's file IDs only ever go up).
async function updates(installed, opts = {}) {
  if (!opts.gameVersion || (opts.type === 'mod' && !opts.loader)) return {};
  const wantLoader = opts.type === 'mod' ? [LOADER[opts.loader], ...(opts.loader === 'quilt' ? [LOADER.fabric] : [])] : null;
  const out = {};
  for (let i = 0; i < installed.length; i += 200) {
    const part = installed.slice(i, i + 200);
    const mods = arr((await cf('/mods', null, { modIds: part.map((x) => Number(x.projectId)).filter(Number.isInteger) })).data);
    for (const m of mods) {
      const mine = part.find((x) => String(x.projectId) === String(m.id));
      if (!mine) continue;
      const fits = arr(m.latestFilesIndexes).filter((f) => f && f.gameVersion === opts.gameVersion && (!wantLoader || wantLoader.includes(f.modLoader)));
      // Betas and alphas are only offered to someone who is on one already.
      const own = fits.find((f) => String(f.fileId) === String(mine.versionId));
      const level = own ? own.releaseType : 1;
      const best = fits.filter((f) => f.releaseType <= level).sort((a, b) => b.fileId - a.fileId)[0];
      if (best && Number(best.fileId) > Number(mine.versionId)) out[String(m.id)] = { id: String(best.fileId), name: String(best.filename || best.fileId) };
    }
  }
  return out;
}

async function brief(projectId) {
  const m = await cfObject(`/mods/${encodeURIComponent(projectId)}`);
  return { title: m.name || String(projectId), icon: (m.logo && m.logo.thumbnailUrl) || null, url: (m.links && m.links.websiteUrl) || null };
}

const categoryCache = new Map();
async function categories(type) {
  const classId = CLASS[type] || CLASS.mod;
  if (!categoryCache.has(classId)) {
    const list = arr((await cf('/categories', { gameId: GAME, classId })).data)
      .filter((c) => c && !c.isClass && c.name)
      .map((c) => ({ id: String(c.id), label: String(c.name) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    categoryCache.set(classId, list);
  }
  return categoryCache.get(classId);
}

// Which CurseForge projects do these local files belong to? Takes CurseForge's own file
// fingerprints and returns { fingerprint: projectId }.
async function fingerprints(list) {
  const out = {};
  for (let i = 0; i < list.length; i += 200) {
    const reply = await cf(`/fingerprints/${GAME}`, null, { fingerprints: list.slice(i, i + 200) });
    for (const m of arr(reply.data && reply.data.exactMatches)) {
      if (m && m.file && m.file.fileFingerprint !== undefined && m.file.modId) out[m.file.fileFingerprint] = String(m.file.modId);
    }
  }
  return out;
}

// Names local files that CurseForge knows: takes file fingerprints and returns
// { fingerprint: { source, projectId, versionId, versionName, title, icon } }.
async function identify(list) {
  const files = {};
  for (let i = 0; i < list.length; i += 200) {
    const reply = await cf(`/fingerprints/${GAME}`, null, { fingerprints: list.slice(i, i + 200) });
    for (const m of arr(reply.data && reply.data.exactMatches)) {
      if (m && m.file && m.file.fileFingerprint !== undefined && m.file.modId) files[m.file.fileFingerprint] = m.file;
    }
  }
  // The match says which project a file belongs to; the project's name and icon are asked for in one go.
  const projects = new Map();
  const ids = [...new Set(Object.values(files).map((f) => Number(f.modId)))];
  for (let i = 0; i < ids.length; i += 200) {
    for (const m of arr((await cf('/mods', null, { modIds: ids.slice(i, i + 200) })).data)) if (m && m.id) projects.set(Number(m.id), m);
  }
  const out = {};
  for (const [print, f] of Object.entries(files)) {
    const m = projects.get(Number(f.modId)) || {};
    out[print] = {
      source: 'curseforge', projectId: String(f.modId), versionId: String(f.id), versionName: f.displayName || f.fileName || '',
      title: m.name || f.displayName || f.fileName || 'Unnamed', icon: (m.logo && (m.logo.thumbnailUrl || m.logo.url)) || null,
    };
  }
  return out;
}

// Several files by ID in one request (used when importing a modpack).
async function getFiles(fileIds) {
  if (!fileIds.length) return [];
  return arr((await cf('/mods/files', null, { fileIds })).data).map(normFile);
}

async function testKey() {
  await cf(`/games/${GAME}`);
  return true;
}

module.exports = { identify, setKey, getKey, hasKey, search, project, versions, getVersion, getFiles, latest, updates, brief, categories, fingerprints, testKey };
