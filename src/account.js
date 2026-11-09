'use strict';
// Minecraft sign-in through Microsoft, the way native apps are meant to do it
// (OAuth authorization code + PKCE, RFC 8252): the sign-in page opens in the user's own
// browser, and Microsoft sends the result to a one-shot listener on this computer.
// Modion never sees a password and never shows a Microsoft page itself.
//
// Needs the client ID of an app registration that Mojang has approved for the
// Minecraft API; until then the last step answers 403 and says so.

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { ApiError, UA } = require('./http');

const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const SCOPE = 'XboxLive.signin offline_access';
const SIGN_IN_WINDOW_MS = 5 * 60 * 1000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const XBOX_PROBLEMS = {
  2148916233: 'This Microsoft account has no Xbox profile yet. Sign in at xbox.com once to create one.',
  2148916235: 'Xbox Live is not available in this account\'s country or region.',
  2148916236: 'This account needs adult verification on the Xbox website first.',
  2148916237: 'This account needs adult verification on the Xbox website first.',
  2148916238: 'This is a child account. It has to be added to a family by an adult before it can sign in.',
};

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function call(url, { form, json, bearer } = {}) {
  const host = new URL(url).hostname;
  let res;
  try {
    res = await fetch(url, {
      method: form || json ? 'POST' : 'GET',
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(json ? { 'Content-Type': 'application/json' } : {}),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : json ? JSON.stringify(json) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new ApiError(`Could not reach ${host}.`, 'NETWORK');
  }
  let body = null;
  try { body = JSON.parse(await res.text()); } catch {}
  return { status: res.status, ok: res.ok, body: body && typeof body === 'object' ? body : {} };
}

class Account {
  // seal/open encrypt the refresh token at rest when the system keyring is available.
  constructor({ dir, openExternal, seal, open }) {
    this.file = path.join(dir, 'account.json');
    this.openExternal = openExternal;
    this.seal = seal || null;
    this.open = open || null;
    this.pending = null;   // the sign-in in progress, if any
    this.session = null;   // { token, expires } for the game, kept in memory only
    this.saved = this.read();
  }

  read() {
    try {
      const a = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return a && typeof a.name === 'string' && typeof a.uuid === 'string' && typeof a.refresh === 'string' ? a : null;
    } catch {
      return null;
    }
  }

  write(account) {
    this.saved = account;
    if (!account) { fs.rmSync(this.file, { force: true }); return; }
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(account), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  status() {
    return this.saved ? { name: this.saved.name, uuid: this.saved.uuid } : null;
  }

  signOut() {
    this.cancel();
    this.session = null;
    this.write(null);
  }

  cancel() {
    if (this.pending) this.pending.stop(new ApiError('Sign-in was cancelled.', 'CANCELLED'));
  }

  // Opens the browser and resolves once the whole chain has produced a Minecraft profile.
  async signIn(clientId) {
    if (!GUID.test(clientId || '')) throw new ApiError('Add your Microsoft application (client) ID first.', 'NO_CLIENT_ID');
    this.cancel();
    const verifier = b64url(crypto.randomBytes(48));
    const state = b64url(crypto.randomBytes(24));
    const { code, redirect } = await this.listen(state, (redirectUri) => {
      const q = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: SCOPE,
        state,
        code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
        code_challenge_method: 'S256',
        prompt: 'select_account',
      });
      return `${AUTHORITY}/authorize?${q}`;
    });
    const ms = await this.microsoftToken(clientId, { grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier });
    return this.finish(clientId, ms);
  }

  // The redirect URI: a listener on this computer only, alive for one sign-in. It accepts a
  // single request carrying the `state` generated above, then shuts down.
  listen(state, buildUrl) {
    return new Promise((resolve, reject) => {
      const servers = [];
      let done = false;
      const stop = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pending = null;
        for (const s of servers) { s.close(); if (s.closeAllConnections) s.closeAllConnections(); }
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => stop(new ApiError('Sign-in timed out. Nothing was changed.', 'TIMEOUT')), SIGN_IN_WINDOW_MS);
      this.pending = { stop };

      const page = (res, status, text) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Modion</title><body style="font:16px system-ui;margin:15vh auto;max-width:28em;text-align:center"><h2>${text}</h2><p>You can close this tab.</p>`);
      };
      let redirect = '';
      const handler = (req, res) => {
        const u = new URL(req.url, redirect);
        if (req.method !== 'GET' || u.pathname !== '/') { res.writeHead(404, { Connection: 'close' }); res.end(); return; }
        const given = Buffer.from(u.searchParams.get('state') || '');
        if (given.length !== state.length || !crypto.timingSafeEqual(given, Buffer.from(state))) {
          page(res, 400, 'This sign-in link is not valid.');
          return; // keep waiting for the real one
        }
        const code = u.searchParams.get('code');
        if (!code) {
          page(res, 400, 'Sign-in was not completed.');
          const why = u.searchParams.get('error') === 'access_denied' ? 'Sign-in was declined.' : `Microsoft reported: ${(u.searchParams.get('error_description') || u.searchParams.get('error') || 'no code returned').slice(0, 200)}`;
          stop(new ApiError(why, 'DENIED'));
          return;
        }
        page(res, 200, 'Signed in. Return to Modion.');
        stop(null, { code, redirect });
      };

      // "localhost" may mean IPv4 or IPv6 to the browser, so answer on both where possible.
      const first = http.createServer(handler);
      servers.push(first);
      first.once('error', (e) => stop(new ApiError(`Could not open a local port for sign-in: ${e.code || e.message}.`, 'LISTEN')));
      first.listen(0, '127.0.0.1', () => {
        const { port } = first.address();
        redirect = `http://localhost:${port}`;
        const second = http.createServer(handler);
        second.once('error', () => {});
        second.listen(port, '::1', () => servers.push(second));
        Promise.resolve()
          .then(() => this.openExternal(buildUrl(redirect)))
          .catch(() => stop(new ApiError('Could not open your web browser for sign-in.', 'BROWSER')));
      });
    });
  }

  async microsoftToken(clientId, grant) {
    const r = await call(`${AUTHORITY}/token`, { form: { client_id: clientId, scope: SCOPE, ...grant } });
    if (!r.ok || !r.body.access_token) {
      const expired = r.body.error === 'invalid_grant';
      throw new ApiError(
        expired ? 'The saved sign-in has expired. Sign in again.' : `Microsoft refused the sign-in: ${String(r.body.error_description || r.body.error || r.status).split('\n')[0].slice(0, 200)}`,
        expired ? 'EXPIRED' : 'MS_AUTH');
    }
    return r.body;
  }

  // Microsoft token -> Xbox Live -> XSTS -> Minecraft -> profile.
  async finish(clientId, ms) {
    const xbl = await call('https://user.auth.xboxlive.com/user/authenticate', { json: {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${ms.access_token}` },
      RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT',
    } });
    if (!xbl.ok || !xbl.body.Token) throw new ApiError(`Xbox Live sign-in failed (${xbl.status}).`, 'XBOX');

    const xsts = await call('https://xsts.auth.xboxlive.com/xsts/authorize', { json: {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.body.Token] },
      RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT',
    } });
    const claims = xsts.body.DisplayClaims && Array.isArray(xsts.body.DisplayClaims.xui) ? xsts.body.DisplayClaims.xui[0] : null;
    if (!xsts.ok || !xsts.body.Token || !claims || !claims.uhs) {
      throw new ApiError(XBOX_PROBLEMS[xsts.body.XErr] || `Xbox sign-in was refused (${xsts.body.XErr || xsts.status}).`, 'XBOX');
    }

    const mc = await call('https://api.minecraftservices.com/authentication/login_with_xbox', { json: { identityToken: `XBL3.0 x=${claims.uhs};${xsts.body.Token}` } });
    if (mc.status === 403) {
      throw new ApiError('Microsoft and Xbox sign-in worked, but Minecraft refused this application ID. It has not been approved for the Minecraft API yet.', 'NOT_APPROVED');
    }
    if (!mc.ok || !mc.body.access_token) throw new ApiError(`Minecraft sign-in failed (${mc.status}).`, 'MC_AUTH');

    const profile = await call('https://api.minecraftservices.com/minecraft/profile', { bearer: mc.body.access_token });
    if (profile.status === 404) throw new ApiError('This Microsoft account does not own Minecraft: Java Edition.', 'NO_GAME');
    if (!profile.ok || !profile.body.id || !profile.body.name) throw new ApiError(`Could not read the Minecraft profile (${profile.status}).`, 'MC_PROFILE');

    this.session = { token: mc.body.access_token, expires: Date.now() + (Number(mc.body.expires_in) || 3600) * 1000 };
    const refresh = ms.refresh_token || '';
    this.write({
      name: profile.body.name,
      uuid: profile.body.id,
      clientId,
      sealed: Boolean(this.seal && refresh),
      refresh: this.seal && refresh ? this.seal(refresh) : refresh,
    });
    return this.status();
  }

  // A valid game token for launching, renewed silently from the saved sign-in when needed.
  async gameSession(clientId) {
    if (!this.saved) throw new ApiError('Sign in to Minecraft first.', 'SIGNED_OUT');
    if (this.session && this.session.expires - Date.now() > 5 * 60 * 1000) return { ...this.status(), token: this.session.token };
    if (this.renewing) return this.renewing; // callers share one renewal
    this.renewing = (async () => {
      let refresh = this.saved.refresh;
      if (this.saved.sealed) {
        try { refresh = this.open(refresh); } catch { refresh = ''; }
      }
      if (!refresh || this.saved.clientId !== clientId) throw new ApiError('The saved sign-in can no longer be used. Sign in again.', 'EXPIRED');
      const ms = await this.microsoftToken(clientId, { grant_type: 'refresh_token', refresh_token: refresh });
      await this.finish(clientId, { ...ms, refresh_token: ms.refresh_token || refresh });
      return { ...this.status(), token: this.session.token };
    })().finally(() => { this.renewing = null; });
    return this.renewing;
  }
}

module.exports = { Account, GUID };
