'use strict';
// Looking for a newer Modion among the project's GitHub releases, and installing it.
//
// An update replaces Modion's own files (the "app" folder next to Electron) and nothing
// else. The package it downloads has to carry a signature made with the project's
// release key; the matching public key is below. A package that is not signed, or whose
// signature does not check out, is never installed, whatever GitHub served.

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { getJson, ApiError, arr } = require('./http');
const { download } = require('./content');
const { openZip } = require('./zip');

const REPO = 'pinexd/modion';
const RELEASES = `https://api.github.com/repos/${REPO}/releases?per_page=20`;
const PAGE = `https://github.com/${REPO}/releases`;
// The release key (an SSH signing key). Only its public half is here.
const RELEASE_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAICYU0f9pz3VlCZUA8wmLzI88Sydk3q2vNlEn90/XknFz';
const NAMESPACE = 'modion-update';

// "1.2.3-pre.1" -> { nums: [1, 2, 3], pre: ['pre', '1'] }, or null if it is not a version.
function parse(version) {
  const m = String(version || '').trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] } : null;
}

// Which version is newer, by the usual rules (1.0.0-pre.2 < 1.0.0 < 1.0.1). Returns <0, 0 or >0.
function compare(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) - (y.pre.length ? -1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// The newest release that is newer than `current`, or null. Pre-releases are only offered
// to someone who is running a pre-release.
async function check(current) {
  const mine = parse(current);
  if (!mine) return null;
  let best = null;
  for (const r of arr(await getJson(RELEASES))) {
    if (!r || r.draft || !parse(r.tag_name)) continue;
    if (r.prerelease && !mine.pre.length) continue;
    if (compare(r.tag_name, current) <= 0 || (best && compare(r.tag_name, best.tag_name) <= 0)) continue;
    best = r;
  }
  if (!best) return null;
  const version = best.tag_name.replace(/^v/, '');
  const asset = (name) => arr(best.assets).find((a) => a && a.name === name && typeof a.browser_download_url === 'string'
    && a.browser_download_url.startsWith(`https://github.com/${REPO}/releases/download/`));
  const pack = asset(`modion-${version}-app.zip`), sig = asset(`modion-${version}-app.zip.sig`);
  return {
    version,
    name: String(best.name || `Modion ${version}`).slice(0, 120),
    notes: String(best.body || '').slice(0, 4000),
    page: typeof best.html_url === 'string' && best.html_url.startsWith(`https://github.com/${REPO}/`) ? best.html_url : PAGE,
    // Present only when the release has a signed update package.
    payload: pack && sig ? { url: pack.browser_download_url, sig: sig.browser_download_url, size: Number(pack.size) || 0 } : null,
  };
}

/* ---------- the signature (OpenSSH's "SSHSIG" format, Ed25519) ---------- */

// Reads the length-prefixed fields SSH formats are made of.
function reader(buf) {
  let at = 0;
  return {
    bytes(n) { if (at + n > buf.length) throw new Error('short'); const b = buf.subarray(at, at + n); at += n; return b; },
    uint32() { return this.bytes(4).readUInt32BE(0); },
    string() { return this.bytes(this.uint32()); },
  };
}
const sshString = (b) => { const len = Buffer.alloc(4); len.writeUInt32BE(b.length); return Buffer.concat([len, Buffer.from(b)]); };

// Is `armored` a signature of `data`, in our namespace, made with the key `keyBase64`?
function verifySignature(data, armored, keyBase64 = RELEASE_KEY) {
  try {
    const body = String(armored).match(/-----BEGIN SSH SIGNATURE-----([\s\S]+?)-----END SSH SIGNATURE-----/);
    if (!body) return false;
    const r = reader(Buffer.from(body[1].replace(/\s+/g, ''), 'base64'));
    if (r.bytes(6).toString() !== 'SSHSIG' || r.uint32() !== 1) return false;
    const key = r.string(), namespace = r.string(), reserved = r.string(), hash = r.string().toString(), signature = r.string();
    const wanted = Buffer.from(keyBase64, 'base64');
    if (key.length !== wanted.length || !crypto.timingSafeEqual(key, wanted)) return false; // someone else's key
    if (namespace.toString() !== NAMESPACE || !['sha512', 'sha256'].includes(hash)) return false;
    const k = reader(key), s = reader(signature);
    if (k.string().toString() !== 'ssh-ed25519' || s.string().toString() !== 'ssh-ed25519') return false;
    const raw = k.string(), sig = s.string();
    if (raw.length !== 32 || sig.length !== 64) return false;
    const signed = Buffer.concat([Buffer.from('SSHSIG'), sshString(namespace), sshString(reserved), sshString(hash), sshString(crypto.createHash(hash).update(data).digest())]);
    const publicKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
    return crypto.verify(null, signed, publicKey, sig);
  } catch {
    return false;
  }
}

/* ---------- installing ---------- */

// Can this copy of Modion replace its own files? Only a packaged copy, where Modion is the
// "resources/app" folder beside its own Electron: not a source folder (which holds more
// than the update would put back), and not when the folder cannot be written to.
function canInstall(appDir) {
  const packaged = path.basename(appDir) === 'app' && path.basename(path.dirname(appDir)) === 'resources';
  if (!packaged || fs.existsSync(path.join(appDir, '.git'))) return false;
  try {
    fs.accessSync(appDir, fs.constants.W_OK);
    fs.accessSync(path.dirname(appDir), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Downloads the update, checks it, and puts it in place of `appDir`. The caller restarts.
// options.key and options.fetch exist for the tests.
async function install(info, appDir, { electron = process.versions.electron, onProgress = () => {}, key = RELEASE_KEY, fetchFile = download } = {}) {
  if (!info || !info.payload) throw new ApiError('This release has no signed update package. Download it from the release page instead.', 'NO_PAYLOAD');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'modion-update-'));
  const fresh = `${appDir}.update-${crypto.randomBytes(4).toString('hex')}`;
  const old = `${appDir}.old-${crypto.randomBytes(4).toString('hex')}`;
  try {
    await fetchFile({ url: info.payload.url, filename: 'app.zip', size: info.payload.size }, tmp, onProgress);
    await fetchFile({ url: info.payload.sig, filename: 'app.zip.sig' }, tmp);
    const file = path.join(tmp, 'app.zip');
    if (!verifySignature(await fsp.readFile(file), await fsp.readFile(path.join(tmp, 'app.zip.sig'), 'utf8'), key)) {
      throw new ApiError('The update did not pass its signature check, so it was not installed.', 'BAD_SIGNATURE');
    }

    const zip = openZip(file);
    try {
      const pkgEntry = zip.entries.get('package.json');
      const pkg = pkgEntry ? JSON.parse(zip.read(pkgEntry).toString('utf8')) : null;
      if (!pkg || pkg.version !== info.version || !zip.entries.has('main.js')) throw new ApiError('The update package is not what the release says it is.', 'BAD_PAYLOAD');
      // Modion's files only work with the Electron they were made for.
      if (String(pkg.modionElectron || '').split('.')[0] !== String(electron).split('.')[0]) {
        throw new ApiError(`Modion ${info.version} needs a newer base than this copy has. Download the full version from the release page.`, 'NEEDS_FULL');
      }
      await fsp.mkdir(fresh);
      for (const entry of zip.entries.values()) {
        if (entry.name.endsWith('/')) continue;
        const full = path.resolve(fresh, entry.name);
        if (!full.startsWith(fresh + path.sep)) throw new ApiError('The update package contains a file path that leaves its folder.', 'BAD_PAYLOAD');
        await fsp.mkdir(path.dirname(full), { recursive: true });
        await fsp.writeFile(full, zip.read(entry));
      }
    } finally {
      zip.close();
    }

    // Swap the folders; if the second step fails, the old one goes back.
    try {
      await fsp.rename(appDir, old);
    } catch (e) {
      throw new ApiError(`Modion's folder could not be replaced: ${e.code || e.message}.`, 'FS');
    }
    try {
      await fsp.rename(fresh, appDir);
    } catch (e) {
      await fsp.rename(old, appDir).catch(() => {});
      throw new ApiError(`The update could not be put in place: ${e.code || e.message}. Nothing was changed.`, 'FS');
    }
    await fsp.rm(old, { recursive: true, force: true }).catch(() => {}); // only the folder moved aside just above
    return { version: info.version };
  } catch (e) {
    await fsp.rm(fresh, { recursive: true, force: true }).catch(() => {}); // only the folder created above
    throw e instanceof ApiError ? e : new ApiError(`The update failed: ${e.code || e.message}.`, 'UPDATE');
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { check, compare, verifySignature, canInstall, install, PAGE, NAMESPACE };
