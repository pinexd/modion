'use strict';
// For files whose author only allows downloads from the website: opens that file's page
// in a separate browser window, lets the person press Download there themselves, and
// catches the one file Modion is waiting for. The window can only visit the site it was
// opened for, runs with no access to the app or the computer, and every other download
// is turned away.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { BrowserWindow, session, dialog } = require('electron');
const { ApiError } = require('./http');

let current = null; // one page at a time

const hostOf = (u) => { try { const x = new URL(u); return x.protocol === 'https:' ? x.hostname : ''; } catch { return ''; } };
const matches = (host, list) => Boolean(host) && list.some((h) => host === h || host.endsWith(`.${h}`));

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

// expect: { filename, sha1?, size? }. Resolves with the path of the downloaded file
// (a temporary name inside destDir) once it has arrived and checks out.
function open({ parent, url, title, siteHosts, downloadHosts, expect, destDir, onProgress = () => {}, show = true }) {
  if (current) throw new ApiError('Another website download is already open.', 'BUSY');
  if (!matches(hostOf(url), siteHosts)) throw new ApiError('That page is not on the expected website.', 'BAD_URL');
  if (!expect || !expect.filename) throw new ApiError('Modion does not know which file to expect.', 'BAD_REQUEST');

  return new Promise((resolve, reject) => {
    const ses = session.fromPartition('persist:website');
    ses.setPermissionRequestHandler((_wc, _permission, done) => done(false));
    // Sites treat an unfamiliar browser name as a robot; this is an ordinary Chromium window.
    ses.setUserAgent(ses.getUserAgent().replace(/\s(?:Electron|modion|Modion)\/\S+/g, ''));

    const win = new BrowserWindow({
      parent: parent || undefined,
      width: 1180,
      height: 860,
      show,
      title: title || 'Download from website',
      autoHideMenuBar: true,
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: !show },
    });
    const tmp = path.join(destDir, `${expect.filename}.${crypto.randomBytes(4).toString('hex')}.part`);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      current = null;
      ses.removeListener('will-download', onDownload);
      if (!win.isDestroyed()) win.destroy();
      if (error) { fs.rmSync(tmp, { force: true }); reject(error); } else resolve(value);
    };
    current = { cancel: () => finish(new ApiError('The website download was cancelled.', 'CANCELLED')) };

    const tell = (message) => { if (!win.isDestroyed() && show) dialog.showMessageBox(win, { type: 'info', message, buttons: ['OK'] }).catch(() => {}); };

    function onDownload(event, item, contents) {
      if (contents !== win.webContents) return;
      const name = item.getFilename();
      const chain = [...item.getURLChain(), item.getURL()];
      if (!chain.every((u) => matches(hostOf(u), downloadHosts))) {
        event.preventDefault();
        tell('That download does not come from the expected site, so it was not saved.');
        return;
      }
      if (name !== expect.filename) {
        event.preventDefault();
        tell(`Modion is waiting for "${expect.filename}". "${name}" was not saved.`);
        return;
      }
      item.setSavePath(tmp);
      item.on('updated', () => onProgress(item.getReceivedBytes(), item.getTotalBytes() || expect.size || 0));
      item.once('done', async (_e, state) => {
        if (state !== 'completed') {
          await fsp.rm(tmp, { force: true }).catch(() => {});
          if (state === 'cancelled') return; // the person can press Download again
          tell('The download was interrupted. Press Download again.');
          return;
        }
        try {
          const st = await fsp.stat(tmp);
          if (!st.size) throw new ApiError(`${name} arrived empty and was discarded.`, 'EMPTY');
          if (expect.sha1 && (await sha1File(tmp)) !== String(expect.sha1).toLowerCase()) {
            throw new ApiError(`${name} failed its checksum and was discarded.`, 'CHECKSUM');
          }
          finish(null, { tmp, filename: name });
        } catch (e) {
          finish(e instanceof ApiError ? e : new ApiError(`Could not keep ${name}: ${e.code || e.message}.`, 'FS'));
        }
      });
    }

    try { fs.mkdirSync(destDir, { recursive: true }); } catch (e) {
      finish(new ApiError(`Could not create ${destDir}: ${e.code || e.message}.`, 'FS'));
      return;
    }
    ses.on('will-download', onDownload);
    // The window stays on the site it was opened for: no pop-ups, no wandering off.
    win.webContents.setWindowOpenHandler(({ url: target }) => {
      if (matches(hostOf(target), [...siteHosts, ...downloadHosts])) win.loadURL(target).catch(() => {});
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, target) => { if (!matches(hostOf(target), [...siteHosts, ...downloadHosts])) e.preventDefault(); });
    win.on('closed', () => finish(new ApiError('The website window was closed before the file was downloaded.', 'CANCELLED')));
    win.setMenu(null);
    win.loadURL(url).catch(() => {}); // a URL that is itself a download "fails" to load as a page; the download still arrives
  });
}

const cancel = () => { if (current) current.cancel(); };

module.exports = { open, cancel };
