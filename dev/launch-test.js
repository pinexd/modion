'use strict';
// Really starts Minecraft (offline test session) in a throwaway game folder, waits for it to
// get going, then stops it:   node dev/launch-test.js [gameVersion] [loader]
// The first run downloads the game, assets and Java into ~/.local/share/ModionApp.
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
  // Wait until the game has clearly got past startup, then stop it. Old versions log
  // little, so for them "the graphics and sound libraries came up and it kept running" counts.
  // (Forge for 1.1 and 1.2.x says nothing about itself, so there is no line to wait for.)
  const quiet = /^forge$/.test(loader) && /^1\.(1|2(\.\d)?)$/.test(gameVersion);
  const loaderLine = quiet ? null : { fabric: /with Fabric Loader/, quilt: /with Quilt Loader|Quilt Loader/, forge: /Forge Mod Loader|MinecraftForge|ModLauncher|FML/i, neoforge: /NeoForge|ModLauncher|FML/i }[loader];
  const reached = /Backend library|OpenAL initialized|Sound engine started|Created: \d+x\d+|LWJGL Version|Starting up SoundSystem|Initializing LWJGL OpenAL/;
  const broken = /Exception in thread "main"|#@!@# Game crashed|Could not find or load main class/;
  let log = '', ok = false, alive = true, since = 0, waited = 0;
  for (let i = 0; i < (loaderLine ? 420 : 150) && alive; i++) {
    await sleep(1000);
    log = fs.readFileSync(started.log, 'utf8');
    try { log += fs.readFileSync(path.join(dir, 'logs', 'latest.log'), 'utf8'); } catch {}
    try { process.kill(started.pid, 0); } catch { alive = false; }
    if (broken.test(log)) break;
    if (reached.test(log)) waited++;
    if (reached.test(log) && (!loaderLine || loaderLine.test(log))) since++;
    if (since >= 5 && alive) { ok = true; break; } // still up five seconds after getting there
    if (waited > 60) break; // the game is up but the loader never spoke: do not leave the window open
  }
  try { process.kill(-started.pid, 'SIGTERM'); } catch { try { process.kill(started.pid, 'SIGTERM'); } catch {} }
  const lines = log.split('\n').filter((l) => /Setting user|Loader|Backend library|LWJGL Version|ERROR|Exception|Error|Created:/.test(l)).slice(0, 10);
  console.log(lines.map((l) => '  ' + l.slice(0, 160)).join('\n'));
  console.log(ok ? `ok   Minecraft ${gameVersion}${loader ? ' + ' + loader : ''} started and reached the game` : `FAIL did not reach the game (process ${alive ? 'still running' : 'exited'})`);
  await sleep(1500);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
})();
