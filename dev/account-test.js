// Exercises the sign-in chain with stand-ins for Microsoft, Xbox and Minecraft.
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const { Account } = require('../src/account.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modion-acct-'));
const ID = '11111111-2222-3333-4444-555555555555';
const realFetch = global.fetch;
let mode = 'ok', seen = [], issued = 0;
global.fetch = async (url, opts) => {
  url = String(url);
  if (url.startsWith('http://localhost')) return realFetch(url, opts);
  seen.push(url.replace(/^https:\/\//, '').split('?')[0]);
  const reply = (status, body) => ({ status, ok: status < 300, text: async () => JSON.stringify(body) });
  if (url.endsWith('/token')) {
    const form = new URLSearchParams(opts.body);
    if (form.get('grant_type') === 'authorization_code' && (form.get('code') !== 'THECODE' || !form.get('code_verifier') || !form.get('redirect_uri').startsWith('http://localhost:'))) return reply(400, { error: 'bad_exchange' });
    return reply(200, { access_token: 'ms', refresh_token: 'refresh-' + form.get('grant_type') });
  }
  if (url.includes('user.auth.xboxlive')) return reply(200, { Token: 'xbl' });
  if (url.includes('xsts')) return mode === 'child' ? reply(401, { XErr: 2148916238 }) : reply(200, { Token: 'xsts', DisplayClaims: { xui: [{ uhs: 'hash' }] } });
  if (url.includes('login_with_xbox')) return mode === 'unapproved' ? reply(403, {}) : reply(200, { access_token: 'mc-token-' + (++issued), expires_in: mode === 'short' ? 1 : 86400 });
  if (url.endsWith('/minecraft/profile')) return mode === 'nogame' ? reply(404, {}) : reply(200, { id: 'abc123', name: 'Steve' });
  throw new Error('unexpected request ' + url);
};
// Plays the browser: follows the sign-in link's redirect_uri with whatever the scenario says.
let browser = (u) => `${u.searchParams.get('redirect_uri')}/?code=THECODE&state=${u.searchParams.get('state')}`;
const acct = new Account({ dir, seal: (s) => 'sealed:' + s, open: (s) => s.replace(/^sealed:/, ''),
  openExternal: async (link) => {
    const u = new URL(link);
    check('authorize link', u.origin === 'https://login.microsoftonline.com' && u.searchParams.get('code_challenge_method') === 'S256' && u.searchParams.get('client_id') === ID && /^http:\/\/localhost:\d+$/.test(u.searchParams.get('redirect_uri')));
    const base = u.searchParams.get('redirect_uri');
    // Strangers knocking on the port first must not end or hijack the sign-in.
    const wrong = await realFetch(`${base}/?code=EVIL&state=guess`);
    const other = await realFetch(`${base}/elsewhere`);
    check('forged callbacks refused', wrong.status === 400 && other.status === 404);
    const target = browser(u);
    if (target) realFetch(target).catch(() => {});
  } });
let failed = 0;
function check(name, ok, extra = '') { if (!ok) failed++; console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : extra); }
const code = async (p) => { try { await p; return 'OK'; } catch (e) { return e.code; } };
(async () => {
  check('no client id', await code(acct.signIn('')) === 'NO_CLIENT_ID');
  const who = await acct.signIn(ID);
  check('full chain signs in', who && who.name === 'Steve' && seen.length === 5, JSON.stringify([who, seen]));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'account.json'), 'utf8'));
  check('refresh token sealed, file private, no game token on disk', saved.refresh === 'sealed:refresh-authorization_code' && (fs.statSync(path.join(dir, 'account.json')).mode & 0o777) === 0o600 && !JSON.stringify(saved).includes('mc-token'));
  const s1 = await acct.gameSession(ID); seen = [];
  const s2 = await acct.gameSession(ID);
  check('valid session reused without network', s1.token === s2.token && seen.length === 0);
  acct.session.expires = 0;
  const [a, b] = await Promise.all([acct.gameSession(ID), acct.gameSession(ID)]);
  check('expired session renewed once for concurrent callers', a.token === b.token && a.token !== s1.token && seen.filter((u) => u.endsWith('/token')).length === 1, JSON.stringify(seen));
  check('restart keeps the sign-in', new Account({ dir }).status().name === 'Steve');
  check('other client id cannot reuse it', (acct.session.expires = 0, await code(acct.gameSession('99999999-2222-3333-4444-555555555555'))) === 'EXPIRED');
  for (const [m, want] of [['unapproved', 'NOT_APPROVED'], ['child', 'XBOX'], ['nogame', 'NO_GAME']]) { mode = m; check(`${m} -> ${want}`, await code(acct.signIn(ID)) === want); }
  mode = 'ok';
  browser = (u) => `${u.searchParams.get('redirect_uri')}/?error=access_denied&state=${u.searchParams.get('state')}`;
  check('declined in browser', await code(acct.signIn(ID)) === 'DENIED');
  browser = () => null;
  const waiting = code(acct.signIn(ID)); await new Promise((r) => setTimeout(r, 300));
  const port = acct.pending && 1; acct.cancel();
  check('cancel ends a waiting sign-in', port && await waiting === 'CANCELLED' && acct.pending === null);
  check('failed attempts kept the earlier sign-in', acct.status().name === 'Steve');
  acct.signOut();
  check('sign out removes the file', !fs.existsSync(path.join(dir, 'account.json')) && acct.status() === null && await code(acct.gameSession(ID)) === 'SIGNED_OUT');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
