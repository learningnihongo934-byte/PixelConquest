// AI nations. Runs inside the deterministic sim (same on every client), so it may only use
// game.rng for randomness and must never read anything outside the Game.
import { STRUCTURES, AI_DIFFICULTY, MISSILES, TERRAIN } from './data.js';

// build wishlist by personality: 0 economist, 1 warmonger, 2 turtle
const PLANS = [
  ['farm', 'mine', 'market', 'barracks', 'harbor', 'rail', 'hospital', 'oil', 'market', 'radar', 'shield', 'fortress', 'silo', 'airbase', 'spy'],
  ['barracks', 'farm', 'mine', 'bunker', 'artillery', 'harbor', 'rail', 'hospital', 'navalyard', 'airbase', 'silo', 'spy', 'radar', 'shield', 'oil'],
  ['farm', 'bunker', 'mine', 'watchtower', 'barracks', 'fortress', 'market', 'harbor', 'hospital', 'artillery', 'shield', 'radar', 'oil', 'silo', 'navalyard'],
];
const LIMIT = {
  farm: (T) => Math.min(14, 1 + T / 300), mine: (T) => Math.min(14, 1 + T / 280), barracks: (T) => Math.min(10, T / 450),
  market: (T) => Math.min(8, T / 600), bunker: (T) => Math.min(10, T / 500), watchtower: (T) => T / 1400, harbor: (T) => (T > 120 ? 1 + T / 3000 : 0),
  fortress: (T) => T / 1500, artillery: (T) => T / 1200, rail: (T) => T / 2000, hospital: () => 2, navalyard: (T) => (T > 600 ? 1 : 0),
  radar: (T) => T / 3000, shield: (T) => T / 2000, airbase: (T) => (T > 900 ? 1 : 0), oil: (T) => T / 900, spy: (T) => (T > 1200 ? 1 : 0), silo: (T) => (T > 1000 ? 1 : 0),
};

export function aiThink(g, P) {
  if (!P.alive) return;
  if (g.phase === 'spawn') { if (!P.spawned) pickSpawn(g, P); return; }
  const D = AI_DIFFICULTY[P.diff], rng = g.rng, tk = g.tick;
  const mem = P.aiMem;
  if (tk - mem.borderAt > 50) { mem.borderArr = [...P.border]; mem.borderAt = tk; }
  const border = mem.borderArr;
  if (!border.length) return;

  // diplomacy
  for (const from of [...P.allyReq.keys()]) {
    const Q = g.players[from];
    const ok = !Q.nuker && Q.traitorUntil <= tk && !g.hostile(P.id, from) && (Q.tiles > P.tiles * 0.8 || rng.next() < 0.35) && P.allies.size < 2;
    if (ok) g.doAlly(P.id, from); else P.allyReq.delete(from);
  }
  if (D.smart >= 2) {
    for (const t of P.allies) {
      const Q = g.players[t];
      if (Q.troops < P.troops * 0.35 && rng.next() < 0.004 * D.smart) g.doUnally(P.id, t);
    }
  }

  // neighbours: sample the border
  const nb = new Map();
  let wild = -1;
  for (let k = 0; k < 40; k++) {
    const b = border[rng.int(border.length)];
    g.forN(b, (n) => {
      const o = g.owner[n];
      if (o === P.id || !g.claimable(n)) return;
      if (!o) { if (wild < 0) wild = n; } else if (!g.allied(P.id, o)) nb.set(o, (nb.get(o) || 0) + 1);
    });
  }

  if (D.smart >= 1 && P.allies.size === 0 && rng.next() < 0.01) {
    for (const [o] of nb) { const Q = g.players[o]; if (Q.tiles > P.tiles && !g.hostile(P.id, o)) { g.doAlly(P.id, o); break; } }
  }

  build(g, P, border);

  // abilities when under pressure
  const incoming = g.attacks.filter((a) => a.t === P.id);
  const pressure = incoming.reduce((s, a) => s + a.troops, 0);
  if (D.smart >= 1 && pressure > P.troops * 0.4 && P.ab.entrenchCd <= tk) g.doAbility(P.id, 'entrench');
  if (D.smart >= 1 && P.troops < P.cap * 0.25 && P.gold > 8000 && P.ab.rallyCd <= tk) g.doAbility(P.id, 'rally');

  // missiles
  if (D.smart >= 1 && P.act.silo && rng.next() < 0.25) {
    const foes = [...P.hostile.keys()].filter((o) => g.hostile(P.id, o) && g.players[o].alive);
    if (foes.length) {
      const foe = foes[rng.int(foes.length)];
      const nukeOk = D.smart >= 3 && tk > 9000 && P.gold > MISSILES.nuke.cost * 1.3;
      const type = nukeOk ? 'nuke' : P.gold > MISSILES.strike.cost * 1.5 ? (rng.next() < 0.3 ? 'emp' : 'strike') : null;
      const targets = g.structs.filter((s) => s.owner === foe);
      if (type && targets.length) { const s = targets[rng.int(targets.length)]; g.doMissile(P.id, type, s.i); }
    }
  }

  const fill = P.troops / P.cap;
  const ongoing = g.attacks.filter((a) => a.p === P.id && a.t);
  // expanding into wilderness is free, so keep one expansion running alongside any war
  if (wild >= 0 && !g.attacks.some((a) => a.p === P.id && !a.t)) {
    const [x, y] = g.xy(wild);
    const send = Math.floor(P.troops * (0.3 + 0.1 * P.pers));
    P.troops -= send;
    if (!g.launchAttack(P.id, 0, send, x, y, null)) P.troops += send;
  }
  // war: hit the weakest neighbour we clearly beat
  const thresh = 0.55 / D.aggro;
  if (fill > thresh && ongoing.length < 2 && nb.size) {
    let target = 0, best = -1e9;
    for (const [o, contact] of nb) {
      const Q = g.players[o];
      const score = (P.troops / Math.max(1, Q.troops)) * 2 + contact * 0.05 + (g.hostile(P.id, o) ? 1 : 0) + (Q.ai ? 0 : 0.3 * D.aggro) - (Q.allies.size * 0.4);
      if (score > best) { best = score; target = o; }
    }
    const Q = g.players[target];
    if (target && P.troops * 0.45 > Q.troops * 0.35 / D.aggro) {
      if (D.smart >= 2 && P.ab.blitzCd <= tk) g.doAbility(P.id, 'blitz');
      let fi = -1;
      for (let k = 0; k < 30 && fi < 0; k++) { const b = border[rng.int(border.length)]; g.forN(b, (n) => { if (g.owner[n] === target) fi = n; }); }
      if (fi >= 0) {
        const [x, y] = g.xy(fi);
        const send = Math.floor(P.troops * 0.45);
        P.troops -= send;
        if (!g.launchAttack(P.id, target, send, x, y, null)) P.troops += send;
      }
      return;
    }
  }
  // nothing left to take by land: sail or fly to the weakest rival, or end a stale alliance
  if (wild < 0 && !nb.size && fill > 0.5 && rng.next() < 0.3) {
    const harbor = g.activeOf(P.id, 'harbor').length > 0, air = g.activeOf(P.id, 'airbase').length > 0;
    let wildCoast = -1;
    for (let k = 0; k < 40 && wildCoast < 0; k++) { const i = rng.int(g.N); if (g.claimable(i) && !g.owner[i] && g.isCoastal(i)) wildCoast = i; }
    if (wildCoast >= 0 && harbor) { g.doBoat(P.id, wildCoast, 0.35); return; }
    const foes = g.players.filter((Q) => Q && Q.alive && Q.tiles && Q.id !== P.id && !g.allied(P.id, Q.id)).sort((a, b) => a.troops - b.troops || a.id - b.id);
    if (foes.length && (harbor || air)) {
      const qb = [...foes[0].border];
      for (let k = 0; k < 40; k++) {
        const i = qb[rng.int(qb.length)];
        if (harbor && g.isCoastal(i)) { g.doBoat(P.id, i, 0.4); return; }
        if (air && k > 20) { g.doDrop(P.id, i, 0.3); return; }
      }
    } else if (!foes.length && P.allies.size && D.smart >= 1 && rng.next() < 0.05) {
      const weakest = [...P.allies].sort((a, b) => g.players[a].troops - g.players[b].troops || a - b)[0];
      g.doUnally(P.id, weakest);
    }
  }
}

function pickSpawn(g, P) {
  let best = -1, bestScore = -1;
  for (let k = 0; k < 40; k++) {
    const i = g.rng.int(g.N);
    if (!g.claimable(i) || g.owner[i]) continue;
    const t = g.terrain[i];
    if (t === 7 || t === 9) continue;
    const [x, y] = g.xy(i);
    let near = 1e9;
    for (const Q of g.players) {
      if (!Q || !Q.spawned) continue;
      const [qx, qy] = g.xy(Q.spawnI);
      near = Math.min(near, (qx - x) ** 2 + (qy - y) ** 2);
    }
    if (near > bestScore) { bestScore = near; best = i; }
  }
  if (best >= 0) g.doSpawn(P.id, best);
}

function build(g, P, border) {
  const T = P.tiles, rng = g.rng;
  if (!P.hasCapital && P.gold >= g.costOf(P.id, 'capital')) { place(g, P, 'capital', border, false); return; }
  // pick among the first few unmet wishes so late-game buildings (silos, airbases) still get built
  const unmet = PLANS[P.pers].filter((type) => (P.counts[type] || 0) < LIMIT[type](T));
  if (!unmet.length) return;
  const type = unmet[rng.int(Math.min(3, unmet.length))];
  if (P.gold < g.costOf(P.id, type)) return; // save up for it
  const military = type === 'bunker' || type === 'fortress' || type === 'artillery' || type === 'watchtower';
  place(g, P, type, border, military);
}

function place(g, P, type, border, onBorder) {
  const S = STRUCTURES[type], rng = g.rng;
  const cx = Math.floor(P.sumX / Math.max(1, P.tiles)), cy = Math.floor(P.sumY / Math.max(1, P.tiles));
  for (let k = 0; k < 40; k++) {
    let i;
    if (onBorder || S.coastal) {
      const b = border[rng.int(border.length)];
      const [bx, by] = g.xy(b);
      // step a few tiles inward so it isn't lost to the first attack
      const sx = bx + Math.sign(cx - bx) * (S.coastal ? 0 : 3), sy = by + Math.sign(cy - by) * (S.coastal ? 0 : 3);
      if (!g.inMap(sx, sy)) continue;
      i = g.idx(sx, sy);
    } else {
      const R = Math.max(3, Math.floor(Math.sqrt(P.tiles) / 2));
      const x = cx + rng.int(2 * R + 1) - R, y = cy + rng.int(2 * R + 1) - R;
      if (!g.inMap(x, y)) continue;
      i = g.idx(x, y);
    }
    if (type === 'mine' && TERRAIN[g.terrain[i]].def < 1.3 && k < 20) continue;
    if (!g.canBuild(P.id, type, i)) { g.doBuild(P.id, type, i); return true; }
  }
  return false;
}
