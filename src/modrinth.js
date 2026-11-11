'use strict';
// Modrinth API v2 client. Everything is normalised to the shapes the UI uses
// so the renderer never has to care which site a project came from.

const { getJson, ApiError, arr } = require('./http');

const BASE = 'https://api.modrinth.com/v2';
const PAGE = 20;
const SORT = { relevance: 'relevance', downloads: 'downloads', updated: 'updated', newest: 'newest' };
const LOADERS = ['fabric', 'forge', 'neoforge', 'quilt'];
// Quilt loads Fabric mods, so a Quilt instance is offered both.
const ACCEPTS = { quilt: ['quilt', 'fabric'] };
const accepted = (loader) => ACCEPTS[loader] || [loader];

const q = (params) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(typeof v === 'string' ? v : JSON.stringify(v))}`)
    .join('&');

function normVersion(v) {
  const files = arr(v.files);
  const f = files.find((x) => x.primary) || files[0];
  return {
    id: v.id,
    projectId: v.project_id,
    name: v.name || v.version_number || 'Unnamed file',
    versionNumber: v.version_number || '',
    channel: ['release', 'beta', 'alpha'].includes(v.version_type) ? v.version_type : 'release',
    gameVersions: arr(v.game_versions),
    loaders: arr(v.loaders),
    date: v.date_published,
    downloads: v.downloads,
    file: f && f.url && f.filename
      ? { url: f.url, filename: f.filename, size: f.size || 0, sha1: f.hashes && f.hashes.sha1, sha512: f.hashes && f.hashes.sha512 }
      : null,
    dependencies: arr(v.dependencies)
      .filter((d) => d.dependency_type === 'required' && (d.project_id || d.version_id))
      .map((d) => ({ projectId: d.project_id || null, versionId: d.version_id || null })),
  };
}

async function search({ type = 'mod', query = '', gameVersion, loader, category, sort = 'relevance', page = 0 }) {
  const facets = [[`project_type:${type}`]];
  if (category) facets.push([`categories:${category}`]);
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  if (loader && type === 'mod') facets.push(accepted(loader).map((l) => `categories:${l}`));
  if (loader && type === 'modpack') facets.push([`categories:${loader}`]); // a pack is built for one loader exactly
  const data = await getJson(
    `${BASE}/search?${q({ query, facets, index: SORT[sort] || 'relevance', offset: page * PAGE, limit: PAGE })}`
  );
  return {
    total: Number(data.total_hits) || 0,
    page,
    pageSize: PAGE,
    hits: arr(data.hits).map((p) => ({
      source: 'modrinth',
      id: p.project_id,
      slug: p.slug,
      type,
      title: p.title || p.slug || 'Untitled',
      summary: p.description || '',
      author: p.author || null,
      icon: p.icon_url || null,
      downloads: p.downloads,
      follows: p.follows,
      updated: p.date_modified,
      categories: arr(p.display_categories || p.categories).filter((c) => !LOADERS.includes(c)),
      loaders: arr(p.categories).filter((c) => LOADERS.includes(c)),
      url: `https://modrinth.com/${type}/${p.slug}`,
    })),
  };
}

async function project(id) {
  const [p, members] = await Promise.all([
    getJson(`${BASE}/project/${encodeURIComponent(id)}`),
    getJson(`${BASE}/project/${encodeURIComponent(id)}/members`).catch(() => []),
  ]);
  const team = arr(members).filter((m) => m && m.user);
  const owner = team.find((m) => m.role === 'Owner') || team[0];
  return {
    source: 'modrinth',
    id: p.id,
    slug: p.slug,
    type: p.project_type,
    title: p.title || p.slug || 'Untitled',
    summary: p.description || '',
    author: owner ? owner.user.username : null,
    icon: p.icon_url || null,
    downloads: p.downloads,
    follows: p.followers,
    updated: p.updated,
    created: p.published,
    categories: arr(p.categories),
    loaders: arr(p.loaders).filter((l) => LOADERS.includes(l)),
    gameVersions: arr(p.game_versions),
    body: { format: 'markdown', text: p.body || '' },
    gallery: arr(p.gallery)
      .filter((g) => g && g.url)
      .sort((a, b) => (a.ordering || 0) - (b.ordering || 0))
      .map((g) => ({ url: g.url, full: g.raw_url || g.url, title: g.title || '', description: g.description || '' })),
    license: (p.license && (p.license.name || p.license.id)) || null,
    clientSide: p.client_side,
    serverSide: p.server_side,
    links: { source: p.source_url, issues: p.issues_url, wiki: p.wiki_url, discord: p.discord_url },
    url: `https://modrinth.com/${p.project_type}/${p.slug}`,
  };
}

function loaderFilter(type, loader) {
  if (type === 'datapack') return ['datapack'];
  if (type === 'mod' && loader) return accepted(loader);
  if (type === 'modpack' && loader) return [loader];
  return undefined;
}

async function versions(id, { type, gameVersion, loader } = {}) {
  const data = await getJson(
    `${BASE}/project/${encodeURIComponent(id)}/version?${q({
      loaders: loaderFilter(type, loader),
      game_versions: gameVersion ? [gameVersion] : undefined,
      include_changelog: 'false',
    })}`
  );
  return arr(data).slice(0, 100).map(normVersion);
}

async function getVersion(projectId, versionId) {
  return normVersion(await getJson(`${BASE}/version/${encodeURIComponent(versionId)}`));
}

// Newest file that fits. For a Quilt instance a native Quilt build wins over a Fabric one.
async function latest(projectId, opts = {}) {
  const list = (await versions(projectId, opts)).filter((v) => v.file);
  return list.find((v) => !opts.loader || v.loaders.includes(opts.loader)) || list[0] || null;
}

async function brief(projectId) {
  const p = await getJson(`${BASE}/project/${encodeURIComponent(projectId)}`);
  return { title: p.title || p.slug || String(projectId), icon: p.icon_url || null };
}

// The tags a project type can be filtered by, as [{ id, label }].
let categoryCache = null;
async function categories(type) {
  if (!categoryCache) categoryCache = arr(await getJson(`${BASE}/tag/category`)).filter((c) => c && typeof c.name === 'string');
  const kind = type === 'datapack' ? 'mod' : type;
  return categoryCache
    .filter((c) => c.project_type === kind)
    .map((c) => ({ id: c.name, label: c.name.replace(/-/g, ' ').replace(/^./, (ch) => ch.toUpperCase()) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// Cached once it succeeds; a failed fetch is retried on the next call, and concurrent
// callers share one request.
let gvCache = null, gvPending = null;
function gameVersions() {
  if (gvCache) return Promise.resolve(gvCache);
  if (!gvPending) {
    gvPending = getJson(`${BASE}/tag/game_version`)
      .then((all) => {
        const list = arr(all).filter((v) => v.version_type === 'release').map((v) => v.version);
        if (!list.length) throw new ApiError('Modrinth returned no game versions.', 'BAD_REPLY');
        gvCache = list;
        return list;
      })
      .finally(() => { gvPending = null; });
  }
  return gvPending;
}

// Identify local files by sha1 -> { hash: {projectId, versionId, versionName, title, icon} }
async function identify(hashes) {
  const out = {};
  for (let i = 0; i < hashes.length; i += 500) {
    const byHash = await getJson(`${BASE}/version_files`, { method: 'POST', body: { hashes: hashes.slice(i, i + 500), algorithm: 'sha1' } });
    const found = Object.entries(byHash || {}).filter(([, v]) => v && v.project_id);
    const ids = [...new Set(found.map(([, v]) => v.project_id))];
    const pmap = {};
    for (let j = 0; j < ids.length; j += 100) {
      const projects = await getJson(`${BASE}/projects?${q({ ids: ids.slice(j, j + 100) })}`);
      for (const p of arr(projects)) pmap[p.id] = p;
    }
    for (const [hash, v] of found) {
      const p = pmap[v.project_id];
      out[hash] = {
        source: 'modrinth',
        projectId: v.project_id,
        versionId: v.id,
        versionName: v.version_number || '',
        title: (p && p.title) || v.name || v.project_id,
        icon: (p && p.icon_url) || null,
      };
    }
  }
  return out;
}

module.exports = { search, project, versions, getVersion, latest, brief, gameVersions, categories, identify };
