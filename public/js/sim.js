// Deterministic game simulation. Every client runs the same Game with the same seed and the
// same ordered command list, so it must only use integer-safe math (+ - * / floor sqrt) and its
// own RNG. Never read Date, Math.random or anything client-specific in here.
import { TERRAIN, STRUCTURES, MISSILES, ABILITIES, AI_DIFFICULTY, TICKS_PER_SEC } from './data.js';
import { aiThink } from './ai.js';

export class Rng {
  constructor(seed) { this.s = seed >>> 0 || 1; }
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n) { return Math.floor(this.next() * n); }
}

const SEC = TICKS_PER_SEC;
const SPAWN_R = 3;

export class Game {
  // map {w,h,terrain}; roster [{name,color,team,ai,diff,uid}] (index+1 = player id); settings {seed,mode,winPct,timeLimit,spawnSecs}
  constructor(map, roster, settings) {
    this.W = map.w; this.H = map.h; this.N = map.w * map.h;
    this.terrain = map.terrain;
    this.owner = new Uint8Array(this.N);
    this.falloutUntil = new Int32Array(this.N);
    this.fallouts = [];
    this.settings = settings;
    this.rng = new Rng(settings.seed);
    this.tick = 0;
    this.phase = 'spawn';
    this.spawnEnd = (settings.spawnSecs || 12) * SEC;
    this.winner = null;
    this.landTotal = 0;
    for (let i = 0; i < this.N; i++) if (!TERRAIN[this.terrain[i]].water) this.landTotal++;
    this.players = [null];
    roster.forEach((r, k) => this.players.push(this.newPlayer(k + 1, r)));
    this.structs = [];
    this.structAt = new Map();
    this.nextId = 1;
    this.attacks = [];
    this.boats = [];
    this.warships = [];
    this.missiles = [];
    this.planes = [];
    this.events = [];
    this.dirty = [];
    this.bfsPrev = new Int32Array(this.N);
    this.bfsStamp = new Int32Array(this.N);
    this.bfsGen = 0;
  }

  newPlayer(id, r) {
    return {
      id, name: r.name, color: r.color, team: r.team || 0, ai: !!r.ai, admin: !!r.admin, diff: r.diff || 'normal', uid: r.uid || null,
      pers: id % 3, alive: true, spawned: false, spawnI: -1,
      troops: 2500, gold: 2000, tiles: 0, sumX: 0, sumY: 0,
      cap: 1000, growth: 20, goldRate: 2,
      border: new Set(), allies: new Set(), allyReq: new Map(), breaking: new Map(), hostile: new Map(),
      revealedTo: new Map(), traitorUntil: 0, nuker: false, capital: 0,
      counts: {}, act: {}, defList: [], artList: [], railList: [], hospitals: 0, hasCapital: false,
      ab: { blitzUntil: 0, blitzCd: 0, entrenchUntil: 0, entrenchCd: 0, rallyCd: 0 },
      god: false, power: false, free: false, frozenUntil: 0,
      stats: { taken: 0, lost: 0, peakTiles: 0, built: 0, missiles: 0 },
      aiMem: { next: 0, borderArr: [], borderAt: -999 },
    };
  }

  // ---------- helpers ----------
  isLand(i) { return !TERRAIN[this.terrain[i]].water; }
  isWater(i) { return TERRAIN[this.terrain[i]].water; }
  xy(i) { return [i % this.W, (i / this.W) | 0]; }
  idx(x, y) { return y * this.W + x; }
  inMap(x, y) { return x >= 0 && y >= 0 && x < this.W && y < this.H; }
  forN(i, f) {
    const x = i % this.W;
    if (i >= this.W) f(i - this.W);
    if (i < this.N - this.W) f(i + this.W);
    if (x > 0) f(i - 1);
    if (x < this.W - 1) f(i + 1);
  }
  isCoastal(i) {
    let c = false;
    this.forN(i, (n) => { if (this.isWater(n)) c = true; });
    return c;
  }
  claimable(i) { return this.isLand(i) && this.falloutUntil[i] <= this.tick; }
  ev(type, data) { this.events.push(Object.assign({ type, tick: this.tick }, data)); }
  sideOf(id) { const P = this.players[id]; return this.settings.mode === 'teams' && P.team ? 't' + P.team : 'p' + id; }
  allied(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    const A = this.players[a], B = this.players[b];
    if (this.settings.mode === 'teams' && A.team && A.team === B.team) return true;
    return A.allies.has(b);
  }
  hostile(a, b) { return !!a && !!b && !this.allied(a, b) && (this.players[a].hostile.get(b) || 0) > this.tick; }
  setHostile(a, b) {
    if (!a || !b || a === b) return;
    this.players[a].hostile.set(b, this.tick + 60 * SEC);
    this.players[b].hostile.set(a, this.tick + 60 * SEC);
  }
  costOf(p, type) {
    if (this.players[p].free) return 0;
    const n = this.players[p].counts[type] || 0;
    return Math.floor(STRUCTURES[type].cost * (1 + 0.3 * n));
  }
  dens(id) { const P = this.players[id]; return P.troops / Math.max(1, P.tiles); }
  near(list, x, y) { for (const s of list) { const dx = s.x - x, dy = s.y - y; if (dx * dx + dy * dy <= s.r2) return s; } return null; }

  setOwner(i, np) {
    const op = this.owner[i];
    if (op === np) return;
    this.owner[i] = np;
    const x = i % this.W, y = (i / this.W) | 0;
    if (op) { const P = this.players[op]; P.tiles--; P.sumX -= x; P.sumY -= y; P.border.delete(i); }
    if (np) { const P = this.players[np]; P.tiles++; P.sumX += x; P.sumY += y; if (P.tiles > P.stats.peakTiles) P.stats.peakTiles = P.tiles; }
    const s = this.structAt.get(i);
    if (s) this.captureStructure(s, np, op);
    this.updateBorder(i);
    this.forN(i, (n) => this.updateBorder(n));
    this.dirty.push(i);
  }
  updateBorder(i) {
    const o = this.owner[i];
    if (!o) return;
    const x = i % this.W;
    let b = i < this.W || i >= this.N - this.W || x === 0 || x === this.W - 1;
    if (!b) this.forN(i, (n) => { if (this.owner[n] !== o) b = true; });
    const set = this.players[o].border;
    if (b) set.add(i); else set.delete(i);
  }

  // ---------- commands (validated here, since they arrive from untrusted clients) ----------
  apply(c) {
    const P = this.players[c.p];
    if (!P) return;
    if (c.k === 'bot') { P.ai = true; P.diff = 'normal'; this.ev('bot', { p: c.p }); return; }
    if (!P.alive || this.phase === 'over') return;
    if (P.frozenUntil > this.tick && c.k !== 'adm' && c.k !== 'emote') { this.ev('fail', { p: c.p, msg: 'You are frozen by an admin.' }); return; }
    const tile = (Number.isInteger(c.x) && Number.isInteger(c.y) && this.inMap(c.x, c.y)) ? this.idx(c.x, c.y) : -1;
    const ratio = Math.min(1, Math.max(0.01, +c.r || 0.3));
    switch (c.k) {
      case 'spawn': if (tile >= 0 && this.doSpawn(c.p, tile) !== true) this.ev('fail', { p: c.p, msg: this.spawnErr }); break;
      case 'atk': if (tile >= 0 && this.phase === 'play') this.doAttack(c.p, tile, ratio); break;
      case 'boat': if (tile >= 0 && this.phase === 'play') this.doBoat(c.p, tile, ratio); break;
      case 'drop': if (tile >= 0 && this.phase === 'play') this.doDrop(c.p, tile, ratio); break;
      case 'build': if (tile >= 0 && STRUCTURES[c.s]) this.doBuild(c.p, c.s, tile); break;
      case 'demolish': if (tile >= 0) this.doDemolish(c.p, tile); break;
      case 'msl': if (tile >= 0 && MISSILES[c.m] && this.phase === 'play') this.doMissile(c.p, c.m, tile); break;
      case 'spy': if (tile >= 0 && this.phase === 'play') this.doSpy(c.p, tile); break;
      case 'ab': if (ABILITIES[c.a] && this.phase === 'play') this.doAbility(c.p, c.a); break;
      case 'ally': if (this.players[c.t] && c.t !== c.p) this.doAlly(c.p, c.t); break;
      case 'unally': if (this.players[c.t]) this.doUnally(c.p, c.t); break;
      case 'decline': P.allyReq.delete(c.t); break;
      case 'retreat': this.doRetreat(c.p); break;
      case 'emote': if (Number.isInteger(c.e)) this.ev('emote', { p: c.p, e: c.e, t: c.t | 0 }); break;
      case 'ping': if (tile >= 0) this.ev('ping', { p: c.p, i: tile }); break;
      case 'surrender': this.eliminate(c.p, true); break;
      case 'adm': this.doAdmin(c); break;
    }
  }

  // admin powers: only for roster slots the host flagged as admin (checked against /admins)
  doAdmin(c) {
    const P = this.players[c.p];
    if (!P.admin || this.phase !== 'play') return;
    const T = this.players[c.t];
    const other = T && T.alive && T !== P;
    const n = [50000, 500000, 5000000].includes(c.n) ? c.n : 50000;
    switch (c.a) {
      // you
      case 'gold': P.gold += n; break;
      case 'troops': P.cap = Math.max(P.cap, P.troops + n); P.troops += n; break;
      case 'shield': P.ab.entrenchUntil = this.tick + 120 * SEC; break;
      case 'god': P.god = !P.god; break; // your land can't be taken or damaged
      case 'power': P.power = !P.power; break; // attacks 10x cheaper and 3x faster
      case 'free': P.free = !P.free; break; // free structures, missiles from anywhere, no cooldowns
      case 'win':
        this.phase = 'over';
        this.winner = this.sideOf(P.id);
        this.ev('over', { winner: this.winner });
        break;
      // another player
      case 'kill': if (!other) return; this.eliminate(T.id, true); break;
      case 'annex': // take all their land and structures
        if (!other) return;
        for (let i = 0; i < this.N; i++) if (this.owner[i] === T.id) this.setOwner(i, P.id);
        this.eliminate(T.id, false);
        this.recount();
        break;
      case 'drain': if (!other) return; T.troops = 0; T.gold = 0; break;
      case 'freeze':
        if (!other) return;
        T.frozenUntil = this.tick + 60 * SEC;
        this.attacks = this.attacks.filter((a) => a.p !== T.id);
        this.boats = this.boats.filter((b) => b.p !== T.id);
        break;
      case 'gift': if (!other) return; T.gold += n; break;
      // everyone
      case 'killai': for (const Q of this.players) if (Q && Q.ai && Q.alive && Q !== P) this.eliminate(Q.id, true); break;
      default: return;
    }
    this.ev('admin', { p: c.p, a: c.a, t: c.t | 0, n, on: c.a === 'god' ? P.god : c.a === 'power' ? P.power : c.a === 'free' ? P.free : undefined });
  }

  doSpawn(p, i) {
    this.spawnErr = 'Pick a land tile nobody owns.';
    if (this.phase !== 'spawn' || !this.claimable(i) || this.owner[i]) return false;
    const [x, y] = this.xy(i);
    for (const Q of this.players) {
      if (!Q || Q.id === p || !Q.spawned) continue;
      const [qx, qy] = this.xy(Q.spawnI);
      if ((qx - x) ** 2 + (qy - y) ** 2 < 100) { this.spawnErr = `Too close to ${Q.name}. Pick a spot further away.`; return false; }
    }
    const P = this.players[p];
    if (P.spawned) { // move spawn: give back the old land
      for (const s of this.structs.filter((s) => s.owner === p)) this.removeStruct(s);
      const [ox, oy] = this.xy(P.spawnI);
      for (let dy = -SPAWN_R; dy <= SPAWN_R; dy++) for (let dx = -SPAWN_R; dx <= SPAWN_R; dx++) {
        if (this.inMap(ox + dx, oy + dy) && this.owner[this.idx(ox + dx, oy + dy)] === p) this.setOwner(this.idx(ox + dx, oy + dy), 0);
      }
    }
    for (let dy = -SPAWN_R; dy <= SPAWN_R; dy++) for (let dx = -SPAWN_R; dx <= SPAWN_R; dx++) {
      if (dx * dx + dy * dy > SPAWN_R * SPAWN_R + 1 || !this.inMap(x + dx, y + dy)) continue;
      const j = this.idx(x + dx, y + dy);
      if (this.claimable(j) && !this.owner[j]) this.setOwner(j, p);
    }
    P.spawned = true; P.spawnI = i;
    this.addStruct(p, 'capital', i);
    return true;
  }

  // left click: expand into wilderness / attack a neighbour, or ship troops if the target is overseas
  doAttack(p, i, ratio) {
    const P = this.players[p];
    const t = this.owner[i];
    if (t === p || !this.isLand(i)) return;
    if (t && this.allied(p, t)) return;
    const [x, y] = this.xy(i);
    let best = 1e18;
    for (const b of P.border) { const [bx, by] = this.xy(b); const d = (bx - x) ** 2 + (by - y) ** 2; if (d < best) best = d; }
    if (best > 400 && this.isCoastal(i) && this.activeOf(p, 'harbor').length) return this.doBoat(p, i, ratio);
    const troops = Math.floor(P.troops * ratio);
    if (troops < 1) return;
    P.troops -= troops;
    if (!this.launchAttack(p, t, troops, x, y, null)) { P.troops += troops; this.ev('fail', { p, msg: t ? 'No shared border. Build a Harbor or Airbase to reach them.' : 'No land route. Build a Harbor to sail there.' }); }
  }

  launchAttack(p, t, troops, fx, fy, seeds) {
    const P = this.players[p];
    let a = this.attacks.find((a) => a.p === p && a.t === t);
    const fresh = !a;
    if (fresh) a = { id: this.nextId++, p, t, troops: 0, fx, fy, cand: [], inCand: new Map(), rail: false };
    const steer = !fresh && (a.fx !== fx || a.fy !== fy);
    a.fx = fx; a.fy = fy;
    if (steer) this.candRekey(a);
    const add = (n) => { if (this.owner[n] === t && this.claimable(n) && !a.inCand.has(n)) this.candPush(a, n, 0); };
    if (seeds) seeds.forEach(add);
    else for (const b of P.border) this.forN(b, add);
    if (!a.cand.length) return false;
    // expanding into wilderness is free: the troops stay home and only set the pace.
    // A new click re-picks the crew size; boats and paradrops never shrink it.
    if (!t) { P.troops += troops; a.troops = seeds && !fresh ? Math.max(a.troops, troops) : troops; a.prog = a.prog || 0; }
    else a.troops += troops;
    if (P.railList.length) { const [cx, cy] = this.xy(a.cand[0].i); if (this.near(P.railList, cx, cy)) a.rail = true; }
    if (fresh) this.attacks.push(a);
    if (t) { this.setHostile(p, t); this.ev('attack', { p, t, troops }); }
    return true;
  }

  // Attack fronts are a priority queue: tiles nearer the starting border (lower depth) go first,
  // so the front rolls forward as a solid line. The click point bends it into a bulge, and
  // tiles already hugged by our land are favoured so no holes are left behind.
  candKey(a, i, depth) {
    const [x, y] = this.xy(i);
    let own = 0;
    this.forN(i, (m) => { if (this.owner[m] === a.p) own++; });
    return depth + Math.sqrt((x - a.fx) ** 2 + (y - a.fy) ** 2) * 0.35 - own * 0.25;
  }

  candLess(e, f) { return e.k < f.k || (e.k === f.k && e.i < f.i); }

  candPush(a, i, depth) {
    const h = a.cand, e = { i, d: depth, k: this.candKey(a, i, depth) };
    a.inCand.set(i, depth);
    let c = h.length;
    h.push(e);
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (!this.candLess(e, h[p])) break;
      h[c] = h[p]; c = p;
    }
    h[c] = e;
  }

  candPop(a) {
    const h = a.cand, top = h[0], last = h.pop();
    if (h.length) {
      let c = 0;
      for (;;) {
        const l = 2 * c + 1, r = l + 1;
        let m = c, best = last;
        if (l < h.length && this.candLess(h[l], best)) { m = l; best = h[l]; }
        if (r < h.length && this.candLess(h[r], best)) { m = r; best = h[r]; }
        if (m === c) break;
        h[c] = h[m]; c = m;
      }
      h[c] = last;
    }
    a.inCand.delete(top.i);
    return top;
  }

  // the player clicked a new target: re-aim the whole front (a sorted array is a valid heap)
  candRekey(a) {
    for (const e of a.cand) e.k = this.candKey(a, e.i, e.d);
    a.cand.sort((e, f) => e.k - f.k || e.i - f.i);
  }

  tileCost(a, i) {
    const P = this.players[a.p];
    const ter = TERRAIN[this.terrain[i]];
    const [x, y] = this.xy(i);
    let c;
    {
      const D = this.players[a.t];
      if (D.god) return 1e15;
      c = (6 + this.dens(a.t) * 1.1) * ter.def;
      const f = this.near(D.defList, x, y);
      if (f) c *= f.mult;
      if (D.ab.entrenchUntil > this.tick) c *= 1.5;
      if (P.traitorUntil > this.tick) c *= 1.2;
      if (this.near(P.artList, x, y)) c *= 0.75;
    }
    if (P.ab.blitzUntil > this.tick) c *= 0.85;
    c *= 1 - 0.15 * Math.min(3, P.hospitals);
    if (P.power) c *= 0.1;
    return c;
  }

  processAttack(a) {
    const P = this.players[a.p];
    if (a.t && this.allied(a.p, a.t)) return true;
    const wild = !a.t;
    let n = Math.min(30, 2 + Math.floor(a.troops / 700));
    if (wild) {
      // pace in terrain-cost points per tick; the crew can't be bigger than the army at home
      let sp = Math.min(8, 0.8 + Math.min(a.troops, P.troops) / 2000);
      if (P.ab.blitzUntil > this.tick) sp *= 2;
      if (a.rail) sp *= 1.5;
      if (P.power) sp = 40;
      a.prog = Math.min(a.prog + sp, 40);
      n = 64;
    } else {
      if (P.ab.blitzUntil > this.tick) n *= 2;
      if (a.rail) n = Math.floor(n * 1.5);
      if (P.power) n *= 3;
    }
    while (n-- > 0 && a.cand.length) {
      if (wild && a.prog < 1) break;
      const { i, d } = this.candPop(a);
      const grow = (m) => { if (this.owner[m] === a.t && this.claimable(m) && !a.inCand.has(m)) this.candPush(a, m, d + 1); };
      if (this.owner[i] !== a.t || !this.claimable(i)) continue;
      if (wild) {
        a.prog -= TERRAIN[this.terrain[i]].cost;
        P.stats.taken++;
        this.setOwner(i, a.p);
        this.forN(i, grow);
        continue;
      }
      const cost = this.tileCost(a, i);
      if (cost > a.troops) { a.cand.length = 0; break; }
      a.troops -= cost;
      P.stats.lost += cost;
      if (a.t) {
        const D = this.players[a.t];
        const loss = Math.min(D.troops, this.dens(a.t) * 0.7);
        D.troops -= loss; D.stats.lost += loss;
      }
      P.stats.taken++;
      this.setOwner(i, a.p);
      this.forN(i, grow);
    }
    return a.cand.length === 0;
  }

  doRetreat(p) {
    const P = this.players[p];
    this.attacks = this.attacks.filter((a) => {
      if (a.p !== p) return true;
      if (a.t) P.troops += a.troops * 0.75;
      return false;
    });
  }

  // ---------- naval ----------
  activeOf(p, type) { return this.structs.filter((s) => s.owner === p && s.type === type && s.disabledUntil <= this.tick); }

  waterPath(from, to) {
    const gen = ++this.bfsGen, W = this.W, N = this.N;
    const stamp = this.bfsStamp, prev = this.bfsPrev;
    const goal = new Set();
    this.forN(to, (n) => { if (this.isWater(n)) goal.add(n); });
    if (!goal.size) return null;
    const q = [];
    this.forN(from, (n) => { if (this.isWater(n) && stamp[n] !== gen) { stamp[n] = gen; prev[n] = -1; q.push(n); } });
    for (let h = 0; h < q.length && h < 120000; h++) {
      const c = q[h];
      if (goal.has(c)) {
        const path = [];
        for (let k = c; k !== -1; k = prev[k]) path.push(k);
        return path.reverse();
      }
      const x = c % W;
      const ns = [c >= W ? c - W : -1, c < N - W ? c + W : -1, x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1];
      for (const n of ns) if (n >= 0 && stamp[n] !== gen && this.isWater(n)) { stamp[n] = gen; prev[n] = c; q.push(n); }
    }
    return null;
  }

  doBoat(p, i, ratio) {
    const P = this.players[p];
    if (!this.isLand(i) || this.owner[i] === p) return;
    const [x, y] = this.xy(i);
    const hs = this.activeOf(p, 'harbor').sort((a, b) => ((a.x - x) ** 2 + (a.y - y) ** 2) - ((b.x - x) ** 2 + (b.y - y) ** 2) || a.id - b.id);
    if (!hs.length) { this.ev('fail', { p, msg: 'You need a Harbor to send boats.' }); return; }
    for (const h of hs.slice(0, 2)) {
      const path = this.waterPath(h.i, i);
      if (!path) continue;
      const troops = Math.floor(P.troops * ratio);
      if (troops < 1) return;
      P.troops -= troops;
      this.boats.push({ id: this.nextId++, p, troops, path, k: 0, target: i });
      this.ev('boat', { p, t: this.owner[i], i });
      return;
    }
    this.ev('fail', { p, msg: 'No sea route from your harbors to there.' });
  }

  landAt(p, troops, i) {
    const o = this.owner[i];
    const P = this.players[p];
    if (o === p || (o && this.allied(p, o)) || !this.claimable(i)) { P.troops += troops; return; }
    const [x, y] = this.xy(i);
    if (!this.launchAttack(p, o, troops, x, y, [i])) P.troops += troops;
    else this.ev('landing', { p, t: o, i });
  }

  stepBoats() {
    this.boats = this.boats.filter((b) => {
      if (b.troops <= 0) { this.ev('sunk', { p: b.p, i: b.path[Math.min(b.k, b.path.length - 1)] }); return false; }
      b.k += 1 + (this.tick & 1);
      if (b.k >= b.path.length) { this.landAt(b.p, b.troops, b.target); return false; }
      return true;
    });
    for (const w of this.warships) {
      if (w.stunUntil > this.tick) continue;
      const yard = this.structs.find((s) => s.id === w.yard);
      let target = null, best = 30 * 30;
      for (const b of this.boats) {
        if (b.p === w.owner || this.allied(b.p, w.owner)) continue;
        const [bx, by] = this.xy(b.path[Math.min(b.k, b.path.length - 1)]);
        const d = (bx - yard.x) ** 2 + (by - yard.y) ** 2;
        const dw = (bx - w.x) ** 2 + (by - w.y) ** 2;
        if (d <= 900 && dw < best) { best = dw; target = { b, bx, by }; }
      }
      let foe = null;
      for (const o of this.warships) if (o.owner !== w.owner && !this.allied(o.owner, w.owner) && (o.x - w.x) ** 2 + (o.y - w.y) ** 2 <= 9) foe = o;
      if (foe) { foe.hp -= 2; continue; }
      const gx = target ? target.bx : w.hx, gy = target ? target.by : w.hy;
      if (target && best <= 9) { target.b.troops -= 80; continue; }
      let bx = w.x, by = w.y, bd = (w.x - gx) ** 2 + (w.y - gy) ** 2;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const nx = w.x + dx, ny = w.y + dy;
        if (!this.inMap(nx, ny) || !this.isWater(this.idx(nx, ny))) continue;
        const d = (nx - gx) ** 2 + (ny - gy) ** 2;
        if (d < bd) { bd = d; bx = nx; by = ny; }
      }
      w.x = bx; w.y = by;
    }
    this.warships = this.warships.filter((w) => {
      if (w.hp > 0) return true;
      this.ev('sunk', { p: w.owner, i: this.idx(w.x, w.y) });
      return false;
    });
  }

  // ---------- air ----------
  doDrop(p, i, ratio) {
    const P = this.players[p];
    const [x, y] = this.xy(i);
    if (!this.claimable(i) || this.owner[i] === p) return;
    const t = this.owner[i];
    if (t && this.allied(p, t)) return;
    const ab = this.activeOf(p, 'airbase').find((s) => s.cdUntil <= this.tick && (s.x - x) ** 2 + (s.y - y) ** 2 <= 70 * 70);
    if (!ab) { this.ev('fail', { p, msg: 'No ready Airbase within 70 tiles.' }); return; }
    if (P.gold < 2000) { this.ev('fail', { p, msg: 'A paradrop costs 2,000 gold.' }); return; }
    const troops = Math.floor(P.troops * ratio);
    if (troops < 1) return;
    P.gold -= 2000; P.troops -= troops;
    ab.cdUntil = this.tick + 30 * SEC;
    const dist = Math.sqrt((ab.x - x) ** 2 + (ab.y - y) ** 2);
    this.planes.push({ id: this.nextId++, p, troops, sx: ab.x, sy: ab.y, tx: x, ty: y, t: 0, total: Math.max(10, Math.ceil(dist / 2.5)), target: i });
    this.ev('plane', { p, t, i });
  }

  // ---------- missiles ----------
  doMissile(p, m, i) {
    const P = this.players[p], M = MISSILES[m];
    if (!P.free && P.gold < M.cost) { this.ev('fail', { p, msg: `${M.name} costs ${M.cost.toLocaleString()} gold.` }); return; }
    const [x, y] = this.xy(i);
    let silo = this.activeOf(p, 'silo').find((s) => s.cdUntil <= this.tick && (s.x - x) ** 2 + (s.y - y) ** 2 <= M.range * M.range);
    if (!silo && P.free && P.tiles) silo = { x: Math.floor(P.sumX / P.tiles), y: Math.floor(P.sumY / P.tiles), fake: true };
    if (!silo) { this.ev('fail', { p, msg: 'No ready Missile Silo in range.' }); return; }
    if (!P.free) P.gold -= M.cost;
    P.stats.missiles++;
    if (!silo.fake && !P.free) silo.cdUntil = this.tick + 15 * SEC;
    const dist = Math.sqrt((silo.x - x) ** 2 + (silo.y - y) ** 2);
    this.missiles.push({ id: this.nextId++, p, m, sx: silo.x, sy: silo.y, tx: x, ty: y, t: 0, total: Math.max(15, Math.ceil(dist / 3)) });
    const t = this.owner[i];
    if (t && t !== p) this.setHostile(p, t);
    this.ev('launch', { p, m, t, i });
    if (m === 'nuke') {
      P.nuker = true;
      for (const Q of this.players) if (Q && Q.ai && Q.id !== p && !this.allied(Q.id, p)) this.setHostile(Q.id, p);
    }
  }

  detonate(ms) {
    const M = MISSILES[ms.m], p = ms.p;
    const need = ms.m === 'nuke' ? 2 : 1;
    for (const s of this.structs) {
      if (s.type !== 'shield' || s.disabledUntil > this.tick || this.allied(s.owner, p) || s.charges < need) continue;
      if ((s.x - ms.tx) ** 2 + (s.y - ms.ty) ** 2 <= 14 * 14) {
        s.charges -= need;
        this.ev('intercept', { p, t: s.owner, i: this.idx(ms.tx, ms.ty) });
        return;
      }
    }
    const r = M.radius, loss = new Map();
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const d2 = dx * dx + dy * dy, x = ms.tx + dx, y = ms.ty + dy;
      if (d2 > r * r || !this.inMap(x, y)) continue;
      const i = this.idx(x, y), o = this.owner[i];
      if (o && this.players[o].god) continue;
      if (ms.m === 'nuke') {
        if (o) loss.set(o, (loss.get(o) || 0) + 3);
        if (d2 <= 100 && this.isLand(i)) {
          const s = this.structAt.get(i);
          if (s) this.removeStruct(s);
          if (o) this.setOwner(i, 0);
          this.falloutUntil[i] = this.tick + 45 * SEC;
          this.dirty.push(i);
        }
      } else if (ms.m === 'strike') {
        if (o && o !== p && !this.allied(o, p)) {
          loss.set(o, (loss.get(o) || 0) + 1.5);
          const s = this.structAt.get(i);
          if (s && d2 <= 9) this.removeStruct(s);
        }
      } else {
        const s = this.structAt.get(i);
        if (s && s.owner !== p && !this.allied(s.owner, p)) s.disabledUntil = this.tick + 30 * SEC;
      }
    }
    if (ms.m === 'emp') for (const w of this.warships) if ((w.x - ms.tx) ** 2 + (w.y - ms.ty) ** 2 <= r * r && !this.allied(w.owner, p) && !this.players[w.owner].god) w.stunUntil = this.tick + 30 * SEC;
    if (ms.m === 'nuke') this.fallouts.push({ until: this.tick + 45 * SEC, x: ms.tx, y: ms.ty });
    for (const [o, mult] of loss) {
      const Q = this.players[o];
      const l = Math.min(Q.troops, this.dens(o) * mult * 8);
      Q.troops -= l; Q.stats.lost += l;
    }
    this.ev('boom', { p, m: ms.m, i: this.idx(ms.tx, ms.ty), r });
  }

  // ---------- spy / abilities / diplomacy ----------
  doSpy(p, i) {
    const P = this.players[p];
    const s = this.structAt.get(i);
    if (!s || s.owner === p || this.allied(s.owner, p)) { this.ev('fail', { p, msg: 'Pick an enemy structure to sabotage.' }); return; }
    if (this.players[s.owner].god) { this.ev('fail', { p, msg: 'That nation is protected.' }); return; }
    const hq = this.activeOf(p, 'spy').find((h) => h.cdUntil <= this.tick);
    if (!hq) { this.ev('fail', { p, msg: 'No ready Spy HQ.' }); return; }
    if (P.gold < 2500) { this.ev('fail', { p, msg: 'Sabotage costs 2,500 gold.' }); return; }
    P.gold -= 2500;
    hq.cdUntil = this.tick + 45 * SEC;
    const D = this.players[s.owner];
    s.disabledUntil = this.tick + 40 * SEC;
    const steal = Math.floor(D.gold * 0.1);
    D.gold -= steal; P.gold += steal;
    D.revealedTo.set(p, this.tick + 60 * SEC);
    this.ev('spy', { p, t: s.owner, i, steal, caught: this.rng.next() < 0.5 });
  }

  doAbility(p, a) {
    const P = this.players[p], A = ABILITIES[a], ab = P.ab;
    if (!P.free && (ab[a + 'Cd'] || 0) > this.tick) return;
    if (a === 'rally') {
      if (!P.free && P.gold < A.gold) { this.ev('fail', { p, msg: 'Rally costs 3,000 gold.' }); return; }
      if (!P.free) P.gold -= A.gold;
      P.troops = Math.min(P.cap * 1.3, P.troops * 1.2 + 200);
    } else ab[a + 'Until'] = this.tick + A.dur;
    ab[a + 'Cd'] = P.free ? 0 : this.tick + A.cd;
    this.ev('ability', { p, a });
  }

  doAlly(p, t) {
    const P = this.players[p], Q = this.players[t];
    if (!Q.alive || this.allied(p, t)) return;
    if (this.settings.mode !== 'teams' && (P.allies.size >= 3 || Q.allies.size >= 3)) { this.ev('fail', { p, msg: 'Alliances are capped at 3 per nation.' }); return; }
    if (P.allyReq.has(t)) {
      P.allyReq.delete(t); Q.allyReq.delete(p);
      P.allies.add(t); Q.allies.add(p);
      P.hostile.delete(t); Q.hostile.delete(p);
      this.attacks = this.attacks.filter((a) => {
        if ((a.p === p && a.t === t) || (a.p === t && a.t === p)) { this.players[a.p].troops += a.troops; return false; }
        return true;
      });
      this.ev('allied', { p, t });
    } else if (!Q.allyReq.has(p)) {
      Q.allyReq.set(p, this.tick + 30 * SEC);
      this.ev('allyReq', { p, t });
    }
  }

  doUnally(p, t) {
    const P = this.players[p];
    if (!P.allies.has(t) || P.breaking.has(t)) return;
    P.breaking.set(t, this.tick + 10 * SEC);
    this.ev('breaking', { p, t });
  }

  // ---------- structures ----------
  canBuild(p, type, i) {
    const P = this.players[p], S = STRUCTURES[type];
    if (this.owner[i] !== p) return 'Build on your own land.';
    if (type === 'capital' && P.hasCapital) return 'You already have a capital.';
    if (S.coastal && !this.isCoastal(i)) return `${S.name} must be on the coast.`;
    if (S.terrain && !S.terrain.includes(this.terrain[i])) return `${S.name} must be on desert, tundra or snow.`;
    const [x, y] = this.xy(i);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (this.inMap(x + dx, y + dy) && this.structAt.has(this.idx(x + dx, y + dy))) return 'Too close to another structure.';
    }
    if (P.gold < this.costOf(p, type)) return 'Not enough gold.';
    return '';
  }
  doBuild(p, type, i) {
    const err = this.canBuild(p, type, i);
    if (err) { this.ev('fail', { p, msg: err }); return; }
    this.players[p].gold -= this.costOf(p, type);
    this.players[p].stats.built++;
    this.addStruct(p, type, i);
    this.ev('built', { p, s: type, i });
  }
  addStruct(p, type, i) {
    const [x, y] = this.xy(i);
    const s = { id: this.nextId++, type, owner: p, i, x, y, disabledUntil: 0, cdUntil: 0, charges: 3 };
    this.structs.push(s);
    this.structAt.set(i, s);
    const P = this.players[p];
    P.counts[type] = (P.counts[type] || 0) + 1;
    if (type === 'navalyard') this.spawnWarships(s);
    this.recount();
    return s;
  }
  spawnWarships(s) {
    const water = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (this.inMap(s.x + dx, s.y + dy) && this.isWater(this.idx(s.x + dx, s.y + dy))) water.push([s.x + dx, s.y + dy]);
    }
    for (let k = 0; k < 2 && water.length; k++) {
      const [wx, wy] = water[k % water.length];
      this.warships.push({ id: this.nextId++, owner: s.owner, yard: s.id, x: wx, y: wy, hx: wx, hy: wy, hp: 100, stunUntil: 0 });
    }
  }
  removeStruct(s) {
    this.structs = this.structs.filter((o) => o !== s);
    this.structAt.delete(s.i);
    const P = this.players[s.owner];
    P.counts[s.type]--;
    if (s.type === 'navalyard') this.warships = this.warships.filter((w) => w.yard !== s.id);
    this.ev('destroyed', { p: s.owner, s: s.type, i: s.i });
    this.recount();
  }
  captureStructure(s, np, op) {
    if (!np || s.type === 'capital') {
      if (s.type === 'capital' && op) this.ev('capitalLost', { p: op, t: np });
      this.removeStruct(s);
      return;
    }
    this.players[s.owner].counts[s.type]--;
    s.owner = np;
    this.players[np].counts[s.type] = (this.players[np].counts[s.type] || 0) + 1;
    if (s.type === 'navalyard') { this.warships = this.warships.filter((w) => w.yard !== s.id); this.spawnWarships(s); }
    this.ev('captured', { p: np, t: op, s: s.type, i: s.i });
    this.recount();
  }
  doDemolish(p, i) {
    const s = this.structAt.get(i);
    if (!s || s.owner !== p) return;
    this.players[p].gold += Math.floor(STRUCTURES[s.type].cost * 0.25);
    this.removeStruct(s);
  }

  // recompute per-player rates and effect lists from structures (cheap; runs on change and every second)
  recount() {
    for (const P of this.players) {
      if (!P) continue;
      P.act = {}; P.defList = []; P.artList = []; P.railList = []; P.hospitals = 0; P.hasCapital = false;
    }
    for (const s of this.structs) {
      const P = this.players[s.owner];
      if (s.type === 'capital') { P.hasCapital = true; P.capital = s.id; }
      if (s.disabledUntil > this.tick) continue;
      P.act[s.type] = (P.act[s.type] || 0) + 1;
      if (s.type === 'bunker') P.defList.push({ x: s.x, y: s.y, r2: 25, mult: 1.6 });
      if (s.type === 'fortress') P.defList.push({ x: s.x, y: s.y, r2: 64, mult: 2.5 });
      if (s.type === 'watchtower') P.defList.push({ x: s.x, y: s.y, r2: 16, mult: 1.25 });
      if (s.type === 'artillery') P.artList.push({ x: s.x, y: s.y, r2: 100 });
      if (s.type === 'rail') P.railList.push({ x: s.x, y: s.y, r2: 196 });
      if (s.type === 'hospital') P.hospitals++;
      if (s.type === 'mine' && (this.terrain[s.i] === 6 || this.terrain[s.i] === 7)) P.act.mineBonus = (P.act.mineBonus || 0) + 1;
    }
    for (const P of this.players) {
      if (!P) continue;
      P.defList.sort((a, b) => b.mult - a.mult);
      const a = P.act, m = P.ai ? AI_DIFFICULTY[P.diff].econ : 1;
      const gold = 2 + P.tiles * 0.06 + (a.mine || 0) * 12 + (a.mineBonus || 0) * 12 + (a.market || 0) * 15 * (1 + 0.25 * P.allies.size)
        + (a.oil || 0) * 45 + (a.harbor || 0) * 8 + (P.hasCapital ? 10 : 0);
      P.goldRate = gold * m;
      P.cap = (1000 + P.tiles * 20 + (a.barracks || 0) * 6000 + (P.hasCapital ? 3000 : 0)) * (P.ai ? Math.sqrt(m) : 1);
      P.growth = (20 + P.tiles * 0.25 + (a.farm || 0) * 25) * (P.hasCapital ? 1 : 0.7) * (1 + 0.1 * Math.min(3, a.rail || 0)) * m;
    }
  }

  eliminate(p, surrender) {
    const P = this.players[p];
    if (!P.alive) return;
    if (surrender) for (let i = 0; i < this.N; i++) if (this.owner[i] === p) this.setOwner(i, 0);
    P.alive = false;
    this.attacks = this.attacks.filter((a) => a.p !== p);
    this.boats = this.boats.filter((b) => b.p !== p);
    for (const Q of this.players) if (Q) { Q.allies.delete(p); Q.allyReq.delete(p); }
    this.ev('eliminated', { p });
  }

  // ---------- main step ----------
  step(cmds) {
    for (const c of cmds) this.apply(c);
    const tk = this.tick;
    if (this.phase === 'spawn') {
      for (const P of this.players) if (P && P.ai && (tk + P.id) % 5 === 0) aiThink(this, P);
      if (tk + 1 >= this.spawnEnd) {
        for (const P of this.players) {
          if (!P || P.spawned) continue;
          for (let k = 0; k < 400 && !P.spawned; k++) this.doSpawn(P.id, this.rng.int(this.N));
        }
        this.phase = 'play';
        this.recount();
        this.ev('start', {});
      }
      this.tick++;
      return;
    }
    if (this.phase === 'over') { this.tick++; return; }

    if (tk % SEC === 0) this.recount();
    for (const P of this.players) {
      if (!P || !P.alive) continue;
      P.gold += P.goldRate / SEC;
      if (P.troops < P.cap) P.troops = Math.min(P.cap, P.troops + (P.growth * (1 - P.troops / P.cap)) / SEC + 0.5);
      else P.troops -= (P.troops - P.cap) * 0.01 / SEC;
      for (const [t, until] of P.breaking) {
        if (until > tk) continue;
        P.breaking.delete(t); P.allies.delete(t); this.players[t].allies.delete(P.id);
        P.traitorUntil = tk + 90 * SEC;
        this.setHostile(P.id, t);
        this.ev('betrayed', { p: P.id, t });
      }
      for (const [t, until] of P.allyReq) if (until <= tk) P.allyReq.delete(t);
      if (P.ai && P.frozenUntil <= tk && (tk + P.id) % AI_DIFFICULTY[P.diff].think === 0) aiThink(this, P);
    }

    this.attacks = this.attacks.filter((a) => {
      if (!this.processAttack(a)) return true;
      if (a.t) this.players[a.p].troops += a.troops;
      return false;
    });

    this.stepBoats();
    this.planes = this.planes.filter((pl) => {
      if (++pl.t < pl.total) return true;
      this.landAt(pl.p, pl.troops, pl.target);
      return false;
    });
    this.missiles = this.missiles.filter((ms) => {
      if (++ms.t < ms.total) return true;
      this.detonate(ms);
      return false;
    });

    if (tk % (3 * SEC) === 0) this.stepArtillery();
    if (tk % (20 * SEC) === 0) for (const s of this.structs) if (s.type === 'shield' && s.charges < 3) s.charges++;
    this.fallouts = this.fallouts.filter((f) => {
      if (f.until > tk) return true;
      for (let dy = -10; dy <= 10; dy++) for (let dx = -10; dx <= 10; dx++) if (this.inMap(f.x + dx, f.y + dy)) this.dirty.push(this.idx(f.x + dx, f.y + dy));
      return false;
    });

    if (tk % SEC === 0) this.checkEnd();
    this.tick++;
  }

  stepArtillery() {
    for (const s of this.structs) {
      if (s.type !== 'artillery' || s.disabledUntil > this.tick) continue;
      for (let k = 0; k < 14; k++) {
        const x = s.x + this.rng.int(21) - 10, y = s.y + this.rng.int(21) - 10;
        if (!this.inMap(x, y) || (x - s.x) ** 2 + (y - s.y) ** 2 > 100) continue;
        const o = this.owner[this.idx(x, y)];
        if (!o || !this.hostile(s.owner, o) || this.players[o].god) continue;
        const D = this.players[o];
        const l = Math.min(D.troops, 30 + this.dens(o) * 4);
        D.troops -= l; D.stats.lost += l;
        this.ev('shell', { p: s.owner, t: o, sx: s.x, sy: s.y, i: this.idx(x, y) });
        break;
      }
    }
  }

  checkEnd() {
    for (const P of this.players) if (P && P.alive && P.spawned && P.tiles === 0) this.eliminate(P.id, false);
    const sides = new Map();
    for (const P of this.players) {
      if (!P || !P.alive) continue;
      const k = this.sideOf(P.id);
      sides.set(k, (sides.get(k) || 0) + P.tiles);
    }
    let top = null, topN = -1;
    for (const [k, n] of sides) if (n > topN) { topN = n; top = k; }
    const limit = (this.settings.timeLimit || 0) * 60 * SEC;
    const humansLeft = this.players.some((P) => P && P.alive && !P.ai);
    if (sides.size <= 1 || topN >= this.landTotal * (this.settings.winPct || 0.6) || (limit && this.tick >= limit) || (!humansLeft && this.settings.endWhenHumansOut)) {
      this.phase = 'over';
      this.winner = top;
      this.ev('over', { winner: top });
    }
  }

  // cheap checksum so lockstep peers can spot a desync
  hash() {
    let h = this.tick | 0;
    for (const P of this.players) if (P) h = (Math.imul(h, 31) + Math.floor(P.troops) + P.tiles * 7 + Math.floor(P.gold)) | 0;
    for (let i = 0; i < this.N; i += 97) h = (Math.imul(h, 31) + this.owner[i]) | 0;
    return h >>> 0;
  }
}
