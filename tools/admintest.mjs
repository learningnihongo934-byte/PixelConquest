// Headless test of the in-game admin powers: runs a scripted match twice (must stay identical,
// since admin commands go through lockstep like any other) and checks each power did its job.
import { readFileSync } from 'node:fs';
import { Game } from '../public/js/sim.js';
import { COLORS, empireName, TICKS_PER_SEC } from '../public/js/data.js';

const buf = readFileSync(new URL('../public/data/world.bin', import.meta.url));
const map = { w: buf.readUInt16LE(0), h: buf.readUInt16LE(2), terrain: new Uint8Array(buf.buffer, buf.byteOffset + 4, buf.length - 4) };
const roster = Array.from({ length: 10 }, (_, k) => ({ name: empireName(k * 5), color: COLORS[k], ai: true, admin: k === 0, diff: 'hard' }));
const S = TICKS_PER_SEC;
const play = 2 * S;
const at = (sec) => play + sec * S;
const script = new Map([
  [at(1), [{ p: 2, k: 'adm', a: 'gold', n: 5000000 }, { p: 1, k: 'adm', a: 'gold', n: 5000000 }, { p: 1, k: 'adm', a: 'troops', n: 500000 }]],
  [at(2), [{ p: 1, k: 'adm', a: 'god' }, { p: 1, k: 'adm', a: 'power' }, { p: 1, k: 'adm', a: 'free' }]],
  [at(5), [{ p: 1, k: 'adm', a: 'freeze', t: 2 }, { p: 1, k: 'adm', a: 'gift', t: 6, n: 50000 }]],
  [at(10), [{ p: 1, k: 'adm', a: 'annex', t: 3 }]],
  [at(12), [{ p: 1, k: 'adm', a: 'drain', t: 4 }]],
  [at(14), [{ p: 1, k: 'adm', a: 'kill', t: 5 }]],
  [at(40), [{ p: 1, k: 'adm', a: 'killai' }]],
  [at(42), [{ p: 1, k: 'adm', a: 'win' }]],
]);

function run() {
  const g = new Game(map, roster, { seed: 777, mode: 'ffa', winPct: 0.95, spawnSecs: 2 });
  const log = {};
  const hashes = [];
  let godMin = Infinity, godStart = 0;
  for (let t = 0; t < at(60) && g.phase !== 'over'; t++) {
    const cmds = script.get(t) || [];
    // admin fires a free nuke at player 7's middle with no silo
    if (t === at(20)) {
      const Q = g.players[7];
      cmds.push({ p: 1, k: 'msl', m: 'nuke', x: Math.floor(Q.sumX / Q.tiles), y: Math.floor(Q.sumY / Q.tiles) });
      log.goldBeforeNuke = g.players[1].gold;
      log.missilesBefore = g.players[1].stats.missiles;
    }
    g.step(cmds);
    g.events.length = 0; g.dirty.length = 0;
    const A = g.players[1];
    if (t === at(1)) { log.gold = A.gold; log.troops = A.troops; log.p2gold = g.players[2].gold; }
    if (t === at(2)) godStart = A.tiles;
    if (t > at(2) && A.god) godMin = Math.min(godMin, A.tiles - godStart);
    if (t === at(5)) { log.frozen = g.players[2].frozenUntil > g.tick; log.p2tiles = g.players[2].tiles; }
    if (t === at(9)) { log.p3tiles = g.players[3].tiles; log.adminBeforeAnnex = A.tiles; }
    if (t === at(10)) { log.p3alive = g.players[3].alive; log.adminAfterAnnex = A.tiles; }
    if (t === at(12)) log.p4 = [g.players[4].troops, g.players[4].gold];
    if (t === at(14)) log.p5alive = g.players[5].alive;
    if (t === at(20)) log.missilesAfter = A.stats.missiles, log.goldAfterNuke = A.gold;
    if (t === at(60) - 1 || g.phase === 'over') log.end = { phase: g.phase, winner: g.winner, aliveAI: g.players.filter((P) => P && P.alive && P.id !== 1).length };
    if (t % 100 === 0) hashes.push(g.hash());
  }
  log.p2tilesLater = g.players[2].tiles;
  log.godMin = godMin;
  return { log, hashes, g };
}

const a = run(), b = run();
const L = a.log;
const checks = [
  ['deterministic with admin commands', a.hashes.join() === b.hashes.join()],
  ['non-admins can\'t use admin', L.p2gold < 1000000],
  ['+5M gold', L.gold >= 5000000],
  ['+500k troops', L.troops >= 500000],
  ['frozen player stops', L.frozen],
  ['annex takes all their land', !L.p3alive && L.adminAfterAnnex >= L.adminBeforeAnnex + L.p3tiles],
  ['drain zeroes troops and gold', L.p4[0] < 50 && L.p4[1] < 50],
  ['wipe out', L.p5alive === false],
  ['god mode never loses land', L.godMin >= 0],
  ['free nuke with no silo, no gold spent', L.missilesAfter === L.missilesBefore + 1 && L.goldAfterNuke >= L.goldBeforeNuke - 1],
  ['wipe out all AI + win now', L.end && L.end.phase === 'over' && L.end.winner === 'p1' && L.end.aliveAI === 0],
];
let ok = true;
for (const [name, pass] of checks) { console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}`); if (!pass) ok = false; }
if (!ok) { console.log(JSON.stringify(L)); process.exit(1); }
console.log('admin powers: OK');
