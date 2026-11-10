'use strict';
// Really starts Minecraft (offline test session) in a throwaway game folder, waits for it to
// get going, then stops it:   node dev/launch-test.js [gameVersion] [loader]
// The first run downloads the game, assets and Java into ~/.local/share/modion.
const fs = require('fs');
const os = require('os');
const path = require('path');
const game = require('../src/game');

const gameVersion = process.argv[2] || '1.21.4';
const loader = process.argv[3] || '';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modion-launch-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let shown = 0;

(async () => {
  const inst = { name: 'launch test', path: dir, gameVersion, loader };
  const t = Date.now();
  let started;
  try {
    started = await game.launch(inst, game.offlineSession('ModionTest'), (e) => {
      if (e.state === 'progress' && e.total && Date.now() - shown > 5000) { shown = Date.now(); console.log(`  downloading ${Math.round(e.received / 1048576)} / ${Math.round(e.total / 1048576)} MB`); }
    });
  } catch (e) {
    console.log('FAIL', e.code, e.message);
    process.exit(1);
  }
  console.log(`started pid ${started.pid} after ${Math.round((Date.now() - t) / 1000)}s`);
  // Wait until the game has clearly got past startup, then stop it.
  const want = loader ? /Loading Minecraft .* with (Fabric|Quilt) Loader/ : /Setting user: ModionTest/;
  let log = '', ok = false, alive = true;
  for (let i = 0; i < 90 && alive; i++) {
    await sleep(1000);
    log = fs.readFileSync(started.log, 'utf8');
    ok = want.test(log) && /Setting user: ModionTest/.test(log) && /Backend library|OpenAL initialized|Sound engine started|Created: \d+x\d+/.test(log);
    try { process.kill(started.pid, 0); } catch { alive = false; }
    if (ok) break;
  }
  try { process.kill(-started.pid, 'SIGTERM'); } catch { try { process.kill(started.pid, 'SIGTERM'); } catch {} }
  const lines = log.split('\n').filter((l) => /Setting user|Loader|Backend library|ERROR|Exception|Created:/.test(l)).slice(0, 8);
  console.log(lines.map((l) => '  ' + l.slice(0, 160)).join('\n'));
  console.log(ok ? `ok   Minecraft ${gameVersion}${loader ? ' + ' + loader : ''} started and reached the game` : `FAIL did not reach the game (process ${alive ? 'still running' : 'exited'})`);
  await sleep(1500);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
})();
