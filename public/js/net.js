// Networking. Matches run in lockstep: every browser simulates the same game, and the host
// relays everyone's commands as numbered "turns" through Firebase Realtime Database.
// LocalNet is the same interface for solo games against AI, with no network at all.
import { firebaseConfig } from './firebase-config.js';
import { TURN_TICKS } from './data.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
const TURN_MS = 1000 / 10 * TURN_TICKS;

export class LocalNet {
  constructor() { this.queue = []; this.turns = new Map(); this.online = false; }
  send(cmd) { this.queue.push(Object.assign({}, cmd, { p: this.me })); }
  // solo: turns are produced on demand, so the game never waits
  turnFor(n) { if (!this.turns.has(n)) { this.turns.set(n, this.queue); this.queue = []; } const t = this.turns.get(n); this.turns.delete(n); return t; }
  available() { return Infinity; }
  leave() {}
}

let fb = null;
export async function loadFirebase() {
  if (fb) return fb;
  if (!firebaseConfig) throw new Error('Online play is not set up yet (missing Firebase config).');
  const [app, auth, db] = await Promise.all([import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-database.js')]);
  const a = app.initializeApp(firebaseConfig);
  // ?fresh = a throwaway player for this tab only (lets you test a lobby against yourself)
  const au = new URLSearchParams(location.search).has('fresh') ? auth.initializeAuth(a, { persistence: auth.inMemoryPersistence }) : auth.getAuth(a);
  await au.authStateReady();
  if (!au.currentUser) await auth.signInAnonymously(au);
  // uid is a getter: signing in with Google (admin) swaps the user mid-session
  fb = { ...db, db: db.getDatabase(a), au, A: auth, get uid() { return au.currentUser.uid; } };
  return fb;
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const clean = (s, n) => String(s || '').replace(/[^\w .!?'-]/g, '').slice(0, n);

export class OnlineNet {
  constructor() { this.online = true; this.turns = new Map(); this.maxTurn = -1; this.unsubs = []; this.pending = []; this.slotOf = {}; this.lobby = null; }

  async connect() {
    this.f = await loadFirebase();
    this.uid = this.f.uid;
    const ban = await this.f.get(this.f.ref(this.f.db, 'bans/' + this.uid));
    if (ban.exists()) throw new Error('You are banned from online play.');
    return this;
  }
  async adminUids() {
    const snap = await this.f.get(this.f.ref(this.f.db, 'admins'));
    return new Set(Object.keys(snap.val() || {}));
  }
  r(path) { return this.f.ref(this.f.db, `lobbies/${this.code}` + (path ? '/' + path : '')); }

  async create(me, settings) {
    const f = this.f;
    for (let k = 0; k < 8; k++) {
      let code = '';
      for (let j = 0; j < 5; j++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      const snap = await f.get(f.ref(f.db, 'lobbies/' + code));
      if (snap.exists()) continue;
      this.code = code;
      await f.set(this.r(), { host: this.uid, status: 'lobby', created: Date.now(), settings, players: {} });
      await this.join(code, me);
      return code;
    }
    throw new Error('Could not make a lobby code, try again.');
  }

  async join(code, me) {
    const f = this.f;
    this.code = clean(code, 5).toUpperCase();
    const snap = await f.get(this.r());
    if (!snap.exists()) throw new Error('No lobby with that code.');
    const v = snap.val();
    if (v.status !== 'lobby' && !(v.players && v.players[this.uid])) throw new Error('That match already started.');
    if (Object.keys(v.players || {}).length >= 12 && !(v.players && v.players[this.uid])) throw new Error('That lobby is full.');
    const meRef = this.r('players/' + this.uid);
    await f.set(meRef, { name: clean(me.name, 16) || 'Player', color: me.color, team: me.team || 0, joined: Date.now(), online: true });
    f.onDisconnect(f.child(meRef, 'online')).set(false);
    // listen to each metadata key on its own; the lobby root also holds turns/inbox, which change 5x a second
    this.lobby = { host: v.host, status: v.status, settings: v.settings || {}, players: v.players || {}, match: v.match || null };
    for (const key of ['host', 'status', 'settings', 'players', 'match']) {
      this.unsubs.push(f.onValue(this.r(key), (s) => { this.lobby[key] = s.val(); this.onLobby && this.onLobby(this.lobby); }));
    }
    this.unsubs.push(f.onChildAdded(f.query(this.r('chat'), f.limitToLast(40)), (s) => {
      const v = s.val();
      if (v && typeof v.t === 'string' && typeof v.u === 'string') this.onChat && this.onChat(v);
    }));
    return this.code;
  }

  // chat lives beside the match, not in the lockstep turns, so it never touches the sim
  sendChat(name, text, ch) {
    return this.f.push(this.r('chat'), { u: this.uid, n: clean(name, 16) || 'Player', t: String(text).slice(0, 140), ch, ts: this.f.serverTimestamp() });
  }

  isHost() { return this.lobby && this.lobby.host === this.uid; }
  setMe(patch) { return this.f.update(this.r('players/' + this.uid), patch); }
  setSettings(s) { return this.f.update(this.r('settings'), s); }
  setPublic(name, on) {
    const f = this.f, ref = f.ref(f.db, 'open/' + this.code);
    if (on) { f.set(ref, { name: clean(name, 24), ts: Date.now() }); f.onDisconnect(ref).remove(); } else f.remove(ref);
  }
  async listOpen() {
    const f = this.f;
    const snap = await f.get(f.ref(f.db, 'open'));
    const out = [];
    snap.forEach((c) => { const v = c.val(); if (Date.now() - v.ts < 2 * 3600e3) out.push({ code: c.key, name: v.name }); });
    return out;
  }

  // host: freeze the roster and start the match. Roster + settings (with the seed) go in one
  // node so every client starts from exactly the same data.
  async start(roster, settings) {
    const f = this.f;
    await f.update(this.r(), { status: 'playing', match: { roster, settings }, startedAt: Date.now() });
    f.remove(f.ref(f.db, 'open/' + this.code));
  }

  // called by every client once status becomes 'playing'
  beginMatch(roster, mySlot, onHostChange) {
    const f = this.f;
    this.me = mySlot;
    roster.forEach((r, k) => { if (r.uid) this.slotOf[r.uid] = k + 1; });
    this.unsubs.push(f.onChildAdded(this.r('turns'), (s) => {
      const n = +s.key;
      let cmds = [];
      try { cmds = JSON.parse(s.val()); } catch { cmds = []; }
      this.turns.set(n, Array.isArray(cmds) ? cmds : []);
      if (n > this.maxTurn) this.maxTurn = n;
    }));
    this.onHostChange = onHostChange;
    this.watchPresence(roster);
    if (this.isHost()) this.startHosting(0);
  }

  watchPresence(roster) {
    const botted = new Set();
    this.unsubs.push(this.f.onValue(this.r('players'), (s) => {
      const players = s.val() || {};
      if (!this.lobby) return;
      if (!players[this.uid]) { this.onKicked && this.onKicked(); return; }
      const hostGone = !players[this.lobby.host] || players[this.lobby.host].online === false;
      if (hostGone && !this.hosting) {
        // the first still-online player in roster order takes over as host
        const next = roster.find((r) => r.uid && players[r.uid] && players[r.uid].online !== false);
        if (next && next.uid === this.uid) {
          this.f.set(this.r('host'), this.uid).then(() => { this.startHosting(this.maxTurn + 1); this.onHostChange && this.onHostChange(); });
        }
      }
      if (this.hosting) {
        for (const r of roster) {
          if (!r.uid || botted.has(r.uid)) continue;
          if (!players[r.uid] || players[r.uid].online === false) { botted.add(r.uid); this.pending.push({ k: 'bot', p: this.slotOf[r.uid] }); }
        }
      }
    }));
  }

  startHosting(fromTurn) {
    const f = this.f;
    this.hosting = true;
    this.nextTurn = fromTurn;
    this.unsubs.push(f.onChildAdded(this.r('inbox'), (s) => {
      const v = s.val();
      f.remove(s.ref);
      const p = this.slotOf[v && v.u];
      if (!p || typeof v.c !== 'string' || v.c.length > 600) return;
      try { const c = JSON.parse(v.c); if (c && typeof c === 'object') { c.p = p; this.pending.push(c); } } catch { /* ignore junk */ }
    }));
    this.hostTimer = setInterval(() => {
      const cmds = this.pending.splice(0, 200);
      f.set(this.r('turns/' + this.nextTurn), JSON.stringify(cmds));
      this.nextTurn++;
    }, TURN_MS);
  }

  send(cmd) {
    const c = Object.assign({}, cmd);
    delete c.p;
    if (this.hosting) { c.p = this.me; this.pending.push(c); return; }
    this.f.push(this.r('inbox'), { u: this.uid, c: JSON.stringify(c) });
  }
  turnFor(n) { const t = this.turns.get(n); this.turns.delete(n); return t; }
  available() { return this.maxTurn; }
  reportHash(tick, h) { this.f.set(this.r('hashes/' + this.uid), { t: tick, h }); }

  async endMatch() { if (this.hosting) await this.f.update(this.r(), { status: 'ended' }); }

  leave() {
    clearInterval(this.hostTimer);
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    if (!this.f || !this.code) return;
    const f = this.f;
    if (this.lobby && this.lobby.host === this.uid && this.lobby.status !== 'playing') { f.remove(this.r()); f.remove(f.ref(f.db, 'open/' + this.code)); }
    else f.remove(this.r('players/' + this.uid));
  }
}
