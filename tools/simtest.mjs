// Headless sim test: runs an AI-only match twice with the same seed and checks that both
// runs stay identical (lockstep depends on it), then reports speed and a few sanity numbers.
import { readFileSync } from 'node:fs';
import { Game } from '../public/js/sim.js';
import { COLORS, empireName } from '../public/js/data.js';

const buf = readFileSync(new URL('../public/data/world.bin', import.meta.url));
const map = { w: buf.readUInt16LE(0), h: buf.readUInt16LE(2), terrain: new Uint8Array(buf.buffer, buf.byteOffset + 4, buf.length - 4) };
const roster = Array.from({ length: 30 }, (_, k) => ({ name: empireName(k * 7), color: COLORS[k], ai: true, diff: ['easy', 'normal', 'hard', 'brutal'][k % 4] }));
const TICKS = +(process.argv[2] || 6000);

function run(seed) {
  const g = new Game(map, roster, { seed, mode: 'ffa', winPct: 0.95, spawnSecs: 2 });
  const hashes = [];
  const t0 = performance.now();
  let maxMs = 0;
  for (let t = 0; t < TICKS && g.phase !== 'over'; t++) {
    const a = performance.now();
    g.step([]);
    maxMs = Math.max(maxMs, performance.now() - a);
    g.events.length = 0; g.dirty.length = 0;
    if (t % 500 === 0) hashes.push(g.hash());
  }
  return { g, hashes, ms: performance.now() - t0, maxMs };
}

const a = run(12345), b = run(12345);
const same = a.hashes.length === b.hashes.length && a.hashes.every((h, k) => h === b.hashes[k]);
const g = a.g;
const alive = g.players.filter((P) => P && P.alive);
const top = alive.sort((x, y) => y.tiles - x.tiles).slice(0, 5);
console.log(`ticks ${g.tick} (${(g.tick / 600).toFixed(1)} min game) in ${a.ms.toFixed(0)}ms, avg ${(a.ms / g.tick).toFixed(2)}ms/tick, worst ${a.maxMs.toFixed(1)}ms`);
console.log(`alive ${alive.length}/30, structures ${g.structs.length}, attacks ${g.attacks.length}, boats ${g.boats.length}, warships ${g.warships.length}, missiles so far ${g.players.reduce((s, P) => s + (P ? P.stats.missiles : 0), 0)}`);
for (const P of top) console.log(`  ${P.name.padEnd(10)} ${P.diff.padEnd(6)} tiles ${P.tiles} troops ${Math.round(P.troops)} gold ${Math.round(P.gold)} tier ${P.tier} built ${P.stats.built}`);
console.log(same ? 'deterministic: OK' : 'deterministic: MISMATCH');
if (!same) process.exit(1);
