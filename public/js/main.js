// App shell: menus, lobby flow, input, HUD and the fixed-step game loop.
import { STRUCTURES, STRUCTURE_ORDER, MISSILES, ABILITIES, EMOTES, COLORS, TERRAIN, TURN_TICKS, AI_DIFFICULTY, empireName, ICON } from './data.js';
import { Game } from './sim.js';
import { Renderer, fmt } from './render.js';
import { Sfx } from './sfx.js';
import { LocalNet, OnlineNet } from './net.js';
import { initAdmin, admin } from './admin.js';

const $ = (id) => document.getElementById(id);
const cv = $('cv');
const sfx = new Sfx();
const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } };

let MAP = null, ICONS = null;
let game = null, R = null, net = null, me = 0, solo = false, paused = false;
let attract = null; // AI-only demo game behind the main menu
let acc = 0, lastT = 0, hudAt = 0, boardAt = 0;
let mode = null; // null | {k:'build',s} | {k:'msl',m} | {k:'drop'} | {k:'boat'} | {k:'spy'} | {k:'ping'}
let myColor = store('pc.color') || COLORS[Math.floor(Math.random() * 12)];
let lastSettings = null;
let wasAtWar = false, spawnBanner = false;

// ---------- icons ----------
function setIco(el, n, size) {
  size = size || el.offsetWidth || 32;
  el.style.backgroundSize = `${size * 16}px ${size * 2}px`;
  el.style.backgroundPosition = `${-(n % 16) * size}px ${-Math.floor(n / 16) * size}px`;
}
const ico = (n, size = 32) => { const s = document.createElement('span'); s.className = 'ico'; s.style.width = s.style.height = size + 'px'; setIco(s, n, size); return s; };
function fixStaticIcons() {
  document.querySelectorAll('.ico[style*="--i"]').forEach((el) => setIco(el, +getComputedStyle(el).getPropertyValue('--i'), el.offsetWidth || 32));
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 2600);
}

// ---------- boot ----------
async function boot() {
  const [buf, img] = await Promise.all([
    fetch('data/world.bin').then((r) => r.arrayBuffer()),
    new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = 'art/icons.png'; }),
  ]);
  const dv = new DataView(buf);
  MAP = { w: dv.getUint16(0, true), h: dv.getUint16(2, true), terrain: new Uint8Array(buf, 4) };
  ICONS = img;
  initMenu();
  initAdmin({ get game() { return game; }, get me() { return me; }, get R() { return R; }, send, toast, feed: (t, c) => feed(String(t).replace(/</g, '&lt;'), c), inMatch: () => !!game && game !== attract && game.phase !== 'over' });
  fixStaticIcons();
  startAttract();
  const join = new URLSearchParams(location.search).get('join');
  if (join) { $('joinCode').value = join.toUpperCase(); }
  requestAnimationFrame(loop);
}

function startAttract() {
  const roster = [];
  for (let k = 0; k < 26; k++) roster.push({ name: empireName(k * 7 + 3), color: COLORS[k % COLORS.length], ai: true, diff: 'hard' });
  attract = new Game(MAP, roster, { seed: (Math.random() * 1e9) | 0, mode: 'ffa', winPct: 0.95, spawnSecs: 1 });
  game = attract; net = new LocalNet(); me = 0; solo = true;
  R = new Renderer(cv, game, 0, ICONS);
  R.cam.z = R.minZ * 1.4;
}

// ---------- menu ----------
function initMenu() {
  $('name').value = store('pc.name') || 'Commander' + Math.floor(Math.random() * 900 + 100);
  $('name').oninput = () => store('pc.name', $('name').value);
  const sw = $('swatches');
  COLORS.slice(0, 24).forEach((c) => {
    const i = document.createElement('i');
    i.style.background = c;
    if (c === myColor) i.className = 'on';
    i.onclick = () => { myColor = c; store('pc.color', c); sw.querySelectorAll('i').forEach((x) => x.classList.toggle('on', x === i)); sfx.play('click'); if (net && net.online && net.code) net.setMe({ color: c }); };
    sw.appendChild(i);
  });
  $('optSfx').checked = sfx.sfxOn; $('optMusic').checked = sfx.musicOn;
  $('optSfx').onchange = (e) => sfx.setSfx(e.target.checked);
  $('optMusic').onchange = (e) => { sfx.setMusic(e.target.checked); sfx.ensure(); };
  document.addEventListener('pointerdown', () => sfx.ensure(), { once: true });

  $('btnSolo').onclick = () => { sfx.play('click'); openSetup(false); };
  $('btnCreate').onclick = () => { sfx.play('click'); createLobby(); };
  $('btnJoin').onclick = () => { sfx.play('click'); joinLobby($('joinCode').value.trim()); };
  $('joinCode').onkeydown = (e) => { if (e.key === 'Enter') joinLobby($('joinCode').value.trim()); };
  $('btnBrowse').onclick = browseLobbies;
  $('btnHelp').onclick = () => $('help').classList.remove('hidden');
  $('helpClose').onclick = () => $('help').classList.add('hidden');
  $('btnBack').onclick = () => { if (net && net.online) net.leave(); net = new LocalNet(); showScreen('menu'); };
  $('btnStart').onclick = startFromSetup;
  $('setAis').oninput = () => { $('setAisV').textContent = $('setAis').value; pushSettings(); };
  for (const id of ['setMode', 'setDiff', 'setWin', 'setTime']) $(id).onchange = () => { syncTeamSelect(); pushSettings(); };
  $('setTeam').onchange = () => { if (net && net.online) net.setMe({ team: +$('setTeam').value }); };
  $('optPublic').onchange = (e) => net && net.online && net.setPublic($('name').value + "'s lobby", e.target.checked);
  $('btnCopy').onclick = () => {
    const url = location.origin + location.pathname + '?join=' + net.code;
    navigator.clipboard && navigator.clipboard.writeText(url).then(() => toast('Invite link copied!'), () => toast(url));
  };
  syncTeamSelect();
}

function showScreen(name) {
  for (const s of ['menu', 'setup']) $(s).classList.toggle('hidden', s !== name);
  $('hud').classList.toggle('hidden', name !== 'hud');
}

function syncTeamSelect() {
  const m = $('setMode').value;
  const n = m === 'ffa' ? 0 : +m.slice(5);
  $('setTeam').parentElement.classList.toggle('hidden', !n);
  [...$('setTeam').options].forEach((o, k) => { o.hidden = k >= n; });
  if (n && +$('setTeam').value > n) $('setTeam').value = '1';
}

function readSettings() {
  return { mode: $('setMode').value, ais: +$('setAis').value, diff: $('setDiff').value, winPct: +$('setWin').value, timeLimit: +$('setTime').value };
}
function writeSettings(s) {
  if (!s) return;
  $('setMode').value = s.mode; $('setAis').value = s.ais; $('setAisV').textContent = s.ais; $('setDiff').value = s.diff;
  $('setWin').value = String(s.winPct); $('setTime').value = String(s.timeLimit);
  syncTeamSelect();
}
function pushSettings() { if (net && net.online && net.isHost()) net.setSettings(readSettings()); }

function openSetup(online) {
  showScreen('setup');
  $('setupTitle').textContent = online ? 'Lobby' : 'Solo match';
  $('lobbyBox').classList.toggle('hidden', !online);
  $('setupNote').textContent = online ? 'Share the code or link with friends. The host picks the settings and starts.' : 'You against AI nations on the real world map.';
  $('btnStart').disabled = false;
  for (const id of ['setMode', 'setAis', 'setDiff', 'setWin', 'setTime']) $(id).disabled = false;
}

async function ensureOnline() {
  try { const n = new OnlineNet(); await n.connect(); return n; } catch (e) { toast(e.message || 'Could not connect.'); sfx.play('error'); return null; }
}

async function createLobby() {
  const n = await ensureOnline();
  if (!n) return;
  net = n;
  net.onLobby = renderLobby;
  net.onChat = onChat;
  net.onKicked = kicked;
  $('lobbyChatLog').innerHTML = ''; $('chatLog').innerHTML = '';
  try {
    await net.create({ name: $('name').value, color: myColor, team: 1 }, readSettings());
    $('lobbyCode').textContent = net.code;
    openSetup(true);
  } catch (e) { toast(e.message); }
}

async function joinLobby(code) {
  if (!code) { toast('Type a lobby code first.'); return; }
  const n = await ensureOnline();
  if (!n) return;
  net = n;
  net.onLobby = renderLobby;
  net.onChat = onChat;
  net.onKicked = kicked;
  $('lobbyChatLog').innerHTML = ''; $('chatLog').innerHTML = '';
  try {
    await net.join(code, { name: $('name').value, color: myColor, team: 1 });
    $('lobbyCode').textContent = net.code;
    openSetup(true);
  } catch (e) { toast(e.message); }
}

async function browseLobbies() {
  const n = await ensureOnline();
  if (!n) return;
  const list = await n.listOpen();
  const el = $('openList');
  el.innerHTML = '';
  el.classList.remove('hidden');
  if (!list.length) { el.innerHTML = '<div class="muted">No open lobbies right now. Create one!</div>'; return; }
  for (const l of list) {
    const d = document.createElement('div');
    d.innerHTML = `<span></span><b>${l.code}</b>`;
    d.firstChild.textContent = l.name;
    d.onclick = () => joinLobby(l.code);
    el.appendChild(d);
  }
}

function renderLobby(lb) {
  if (!lb) return;
  const host = net.isHost();
  if (!lb.host || (lb.status === 'lobby' && !lb.players)) { toast('The lobby closed.'); net.leave(); net = new LocalNet(); showScreen('menu'); return; }
  if (lb.players && !lb.players[net.uid] && lb.status === 'lobby') { kicked(); return; }
  if (lb.status === 'playing' && lb.match && !(game && game.netGame === net)) { startOnline(lb.match); return; }
  if (!host) writeSettings(lb.settings);
  for (const id of ['setMode', 'setAis', 'setDiff', 'setWin', 'setTime']) $(id).disabled = !host;
  $('optPublic').parentElement.classList.toggle('hidden', !host);
  $('btnStart').disabled = !host;
  $('btnStart').textContent = host ? 'Start' : 'Waiting for host';
  const pl = $('playerList');
  pl.innerHTML = '';
  const players = Object.entries(lb.players || {}).sort((a, b) => a[1].joined - b[1].joined);
  for (const [uid, p] of players) {
    const d = document.createElement('div');
    d.innerHTML = `<i style="background:${/^#[0-9a-f]{6}$/i.test(p.color) ? p.color : '#888'}"></i><span></span><small class="muted">${uid === lb.host ? 'host' : ''}${lb.settings && lb.settings.mode !== 'ffa' ? ' team ' + (p.team || 1) : ''}${p.online === false ? ' (offline)' : ''}</small>`;
    d.querySelector('span').textContent = p.name + (uid === net.uid ? ' (you)' : '');
    pl.appendChild(d);
  }
}

function kicked() {
  toast('You were removed by an admin.');
  if (game && game !== attract) leaveMatch();
  else { net.leave(); net = new LocalNet(); showScreen('menu'); }
}

// ---------- starting matches ----------
function buildRoster(humans, s, seedRng) {
  const teams = s.mode === 'ffa' ? 0 : +s.mode.slice(5);
  const used = new Set();
  const roster = humans.map((h, k) => {
    let color = h.color;
    if (!COLORS.includes(color) || used.has(color)) color = COLORS.find((c) => !used.has(c));
    used.add(color);
    return { name: h.name, color, team: teams ? Math.min(teams, Math.max(1, h.team || 1)) : 0, ai: false, uid: h.uid || null, admin: !!h.admin };
  });
  const free = COLORS.filter((c) => !used.has(c));
  const nameBase = Math.floor(seedRng() * 400);
  for (let k = 0; k < s.ais; k++) {
    roster.push({ name: empireName(nameBase + k * 11), color: free[k % free.length], team: teams ? (k % teams) + 1 : 0, ai: true, diff: s.diff });
  }
  return roster;
}

async function startFromSetup() {
  sfx.play('click');
  const s = readSettings();
  lastSettings = s;
  if (net && net.online) {
    if (!net.isHost()) return;
    const players = Object.entries(net.lobby.players || {}).filter(([, p]) => p.online !== false).sort((a, b) => a[1].joined - b[1].joined);
    const admins = await net.adminUids().catch(() => new Set());
    const roster = buildRoster(players.map(([uid, p]) => ({ uid, name: p.name, color: p.color, team: p.team, admin: admins.has(uid) })), s, Math.random);
    net.start(roster, Object.assign({}, s, { seed: (Math.random() * 2 ** 31) | 0 }));
    return;
  }
  const roster = buildRoster([{ name: $('name').value || 'You', color: myColor, team: +$('setTeam').value, admin: admin.on }], s, Math.random);
  net = new LocalNet();
  net.me = 1;
  beginGame(roster, Object.assign({}, s, { seed: (Math.random() * 2 ** 31) | 0 }), 1, true);
}

function startOnline(match) {
  const roster = match.roster;
  const slot = roster.findIndex((r) => r.uid === net.uid) + 1;
  if (!slot) { toast('The match started without you.'); return; }
  net.beginMatch(roster, slot, () => feed('You are now the host.', 'good'));
  beginGame(roster, Object.assign({}, match.settings), slot, false);
  game.netGame = net;
}

function beginGame(roster, settings, slot, isSolo) {
  settings.endWhenHumansOut = true;
  game = new Game(MAP, roster, settings);
  attract = null;
  me = slot; solo = isSolo; paused = false; acc = 0; mode = null; wasAtWar = false;
  R = new Renderer(cv, game, me, ICONS);
  R.cam.z = R.minZ * 1.15;
  $('feed').innerHTML = '';
  $('end').classList.add('hidden');
  $('btnPause').classList.toggle('hidden', !isSolo);
  $('chat').classList.toggle('hidden', isSolo);
  closeChat(); setChatCh('all');
  buildHud();
  showScreen('hud');
  setBanner('Pick your starting land', 'Click anywhere on land');
  sfx.play('spawn');
}

// ---------- HUD ----------
function buildHud() {
  const bb = $('buildbar');
  bb.innerHTML = '';
  for (const k of STRUCTURE_ORDER) {
    const S = STRUCTURES[k];
    const b = document.createElement('button');
    b.className = 'bb'; b.dataset.s = k;
    b.appendChild(ico(S.icon, 32));
    b.insertAdjacentHTML('beforeend', `<small></small><kbd>${S.key.toUpperCase()}</kbd>`);
    b.onclick = () => setMode(mode && mode.k === 'build' && mode.s === k ? null : { k: 'build', s: k });
    tipOn(b, () => `<b>${S.name}</b><br>${S.desc}<br>Cost: ${fmt(game.costOf(me, k))} gold`);
    bb.appendChild(b);
  }
  const mb = $('missilebar');
  mb.innerHTML = '';
  for (const [k, M] of Object.entries(MISSILES)) {
    const b = document.createElement('button');
    b.className = 'bb'; b.dataset.m = k;
    b.appendChild(ico(M.icon, 32));
    b.insertAdjacentHTML('beforeend', `<small>${fmt(M.cost)}</small>`);
    b.onclick = () => setMode(mode && mode.k === 'msl' && mode.m === k ? null : { k: 'msl', m: k });
    tipOn(b, () => `<b>${M.name}</b><br>${k === 'strike' ? 'Kills troops and wrecks structures in a 6-tile blast.' : k === 'emp' ? 'Shuts down enemy structures and warships within 10 tiles for 30s.' : 'Wipes out a 10-tile area and leaves fallout for 45s. Everyone will hate you.'}<br>Needs a Missile Silo${k === 'nuke' ? '' : ' within 140 tiles'}. Cost ${fmt(M.cost)} gold.`);
    mb.appendChild(b);
  }
  const ab = $('abilities');
  ab.innerHTML = '';
  for (const [k, A] of Object.entries(ABILITIES)) {
    const b = document.createElement('button');
    b.dataset.a = k;
    b.appendChild(ico(A.icon, 28));
    b.insertAdjacentHTML('beforeend', `<kbd>${A.key.toUpperCase()}</kbd><span class="cd hidden"></span>`);
    b.onclick = () => send({ k: 'ab', a: k });
    tipOn(b, () => `<b>${A.name}</b><br>${A.desc}`);
    ab.appendChild(b);
  }
}

function tipOn(el, html) {
  el.onmouseenter = (e) => { const t = $('tip'); t.innerHTML = html(); t.classList.remove('hidden'); placeTip(e); sfx.play('hover'); };
  el.onmousemove = placeTip;
  el.onmouseleave = () => $('tip').classList.add('hidden');
}
function placeTip(e) {
  const t = $('tip');
  t.style.left = Math.min(innerWidth - t.offsetWidth - 8, e.clientX + 12) + 'px';
  t.style.top = Math.max(8, e.clientY - t.offsetHeight - 12) + 'px';
}

function updateHud() {
  const P = game.players[me];
  if (!P) return;
  $('sTroops').textContent = fmt(P.troops);
  showSendCount();
  $('sCap').textContent = '/' + fmt(P.cap);
  $('sGold').textContent = fmt(P.gold);
  $('sGoldR').textContent = '+' + fmt(P.goldRate) + '/s';
  const share = P.tiles / Math.max(1, game.landTotal || 1);
  $('sLand').textContent = (share * 100).toFixed(1) + '%';
  $('sWin').style.width = Math.min(100, (share / (game.settings.winPct || 0.6)) * 100) + '%';
  for (const b of $('buildbar').children) {
    const k = b.dataset.s, cost = game.costOf(me, k);
    b.querySelector('small').textContent = fmt(cost);
    b.classList.toggle('poor', P.gold < cost);
    b.classList.toggle('sel', !!(mode && mode.k === 'build' && mode.s === k));
  }
  for (const b of $('missilebar').children) {
    const M = MISSILES[b.dataset.m];
    b.classList.toggle('locked', !(P.counts.silo > 0));
    b.classList.toggle('poor', P.gold < M.cost);
    b.classList.toggle('sel', !!(mode && mode.k === 'msl' && mode.m === b.dataset.m));
  }
  for (const b of $('abilities').children) {
    const k = b.dataset.a, cd = P.ab[k + 'Cd'] - game.tick, on = (P.ab[k + 'Until'] || 0) > game.tick;
    const el = b.querySelector('.cd');
    el.classList.toggle('hidden', cd <= 0 && !on);
    el.textContent = on ? 'ON' : Math.ceil(cd / 10) + 's';
    el.style.color = on ? '#58b048' : '';
  }
  if (game.phase === 'spawn') { setBanner(P.spawned ? 'Get ready!' : 'Pick your starting land', `${P.spawned ? 'Click again to move. ' : ''}Starting in ${Math.ceil((game.spawnEnd - game.tick) / 10)}s`); spawnBanner = true; }
  else if (spawnBanner && game.tick > game.spawnEnd + 25) { setBanner(null); spawnBanner = false; }
  const war = [...P.hostile.keys()].some((t) => game.hostile(me, t)) || game.attacks.some((a) => a.t === me);
  if (war !== wasAtWar) { sfx.mood = war ? 'war' : 'calm'; wasAtWar = war; }
}

function updateBoard() {
  const list = game.players.filter((P) => P && P.alive).sort((a, b) => b.tiles - a.tiles);
  const el = $('board');
  const rank = list.findIndex((P) => P.id === me);
  const top = list.slice(0, 10);
  if (rank >= 10) top.push(list[rank]);
  el.innerHTML = `<h3>NATIONS ${list.length}</h3>`;
  for (const P of top) {
    const d = document.createElement('div');
    if (P.id === me) d.className = 'me';
    const rel = P.id === me ? '' : game.allied(me, P.id) ? 'peace' : game.hostile(me, P.id) ? 'war' : '';
    d.innerHTML = `<i style="background:${P.color}"></i><span></span><b class="pct">${((P.tiles / game.landTotal) * 100).toFixed(1)}%</b>`;
    d.querySelector('span').textContent = (P.ai ? '' : '★ ') + P.name;
    if (rel) d.insertBefore(ico(ICON[rel], 16), d.querySelector('b'));
    d.onclick = () => { if (P.tiles) R.centerOn(game.idx(Math.floor(P.sumX / P.tiles), Math.floor(P.sumY / P.tiles))); };
    el.appendChild(d);
  }
}

function setBanner(big, small) {
  const b = $('banner');
  if (!big) { b.classList.add('hidden'); return; }
  b.innerHTML = `${big}<small>${small || ''}</small>`;
  b.classList.remove('hidden');
}

function feed(html, cls, opts = {}) {
  const f = $('feed');
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.innerHTML = html;
  if (opts.buttons) { d.classList.add('sticky'); for (const [label, fn] of opts.buttons) { const b = document.createElement('button'); b.textContent = label; b.onclick = () => { fn(); d.remove(); }; d.appendChild(b); } setTimeout(() => d.remove(), 30000); }
  else setTimeout(() => d.remove(), 12000);
  f.prepend(d);
  while (f.children.length > 9) f.lastChild.remove();
}
const nm = (id) => { const P = game.players[id]; if (!P) return 'Wilderness'; const s = document.createElement('b'); s.style.color = P.color; s.textContent = P.name; return s.outerHTML; };

function setMode(m) {
  mode = m;
  sfx.play('click');
  const mb = $('modebar');
  R.ghost = null;
  if (!m) { mb.classList.add('hidden'); return; }
  const label = m.k === 'build' ? `Place ${STRUCTURES[m.s].name}` : m.k === 'msl' ? `Target for ${MISSILES[m.m].name}` : m.k === 'drop' ? 'Paradrop target' : m.k === 'boat' ? 'Boat landing spot' : m.k === 'spy' ? 'Structure to sabotage' : 'Ping location';
  mb.textContent = label + ' (right-click / Esc to cancel)';
  mb.classList.remove('hidden');
}

// ---------- commands ----------
const ratio = () => +$('ratio').value / 100;
function send(cmd) {
  if (!game || game === attract || !game.players[me] || game.phase === 'over') return;
  if (!game.players[me].alive && cmd.k !== 'emote') return;
  net.send(cmd);
}

function clickTile(i) {
  if (i < 0 || !game || game === attract) return;
  const [x, y] = game.xy(i);
  if (game.phase === 'spawn') { send({ k: 'spawn', x, y }); sfx.play('click'); return; }
  if (mode) {
    if (mode.k === 'build') { send({ k: 'build', s: mode.s, x, y }); if (!window.event || !window.event.shiftKey) setMode(null); return; }
    if (mode.k === 'msl') send({ k: 'msl', m: mode.m, x, y });
    if (mode.k === 'drop') send({ k: 'drop', x, y, r: ratio() });
    if (mode.k === 'boat') send({ k: 'boat', x, y, r: ratio() });
    if (mode.k === 'spy') send({ k: 'spy', x, y });
    if (mode.k === 'ping') send({ k: 'ping', x, y });
    setMode(null);
    return;
  }
  const o = game.owner[i];
  if (o === me) { const s = game.structAt.get(i); if (s) openCtx(i, lastPointer.x, lastPointer.y); return; }
  if (!TERRAIN[game.terrain[i]].water) { send({ k: 'atk', x, y, r: ratio() }); sfx.play(o ? 'attack' : 'expand'); }
}

// right-click / long-press menu with every action for that tile
function openCtx(i, sx, sy) {
  if (!game || game === attract || i < 0) return;
  const el = $('ctx'), P = game.players[me], o = game.owner[i], O = game.players[o];
  const [x, y] = game.xy(i);
  const s = game.structAt.get(i);
  const ter = TERRAIN[game.terrain[i]];
  el.innerHTML = '';
  const hd = document.createElement('div'); hd.className = 'hd';
  hd.innerHTML = O ? `<i style="background:${O.color}"></i><b></b>` : `<b>${ter.water ? 'Ocean' : 'Wilderness'}</b>`;
  if (O) hd.querySelector('b').textContent = O.name + (o === me ? ' (you)' : '');
  el.appendChild(hd);
  const sub = document.createElement('div'); sub.className = 'sub';
  sub.textContent = `${ter.name}${ter.water ? '' : ` · cost x${ter.cost} · defense x${ter.def}`}` + (O ? ` · ${R.troopText(O)} troops · ${O.tiles} tiles${game.allied(me, o) && o !== me ? ' · ALLY' : ''}${game.hostile(me, o) ? ' · AT WAR' : ''}` : '');
  el.appendChild(sub);
  if (s && R.canSee(s)) {
    const d = document.createElement('div'); d.className = 'sub';
    d.innerHTML = `<b>${STRUCTURES[s.type].name}</b>${s.disabledUntil > game.tick ? ' (disabled)' : ''}: ${STRUCTURES[s.type].desc}`;
    el.appendChild(d);
  }
  const add = (label, n, fn, ok = true, why = '') => {
    const b = document.createElement('button');
    if (n != null) b.appendChild(ico(n, 20));
    b.appendChild(document.createTextNode(label));
    b.disabled = !ok; if (why) b.title = why;
    b.onclick = () => { closeCtx(); fn(); };
    el.appendChild(b);
  };
  const alive = P && P.alive;
  if (game.phase === 'spawn' && !ter.water) add('Spawn here', 0, () => send({ k: 'spawn', x, y }));
  if (alive && game.phase === 'play' && !ter.water && o !== me && !(o && game.allied(me, o))) {
    // troop picker: sets the same send % as the top bar, used by the actions below
    const tr = document.createElement('div'); tr.className = 'troops';
    tr.innerHTML = `<div class="row1"><input type="range" min="5" max="100" step="5" value="${$('ratio').value}"><b></b></div>
      <div class="row2">${[10, 25, 50, 75, 100].map((r) => `<button data-r="${r}">${r === 100 ? 'All' : r + '%'}</button>`).join('')}</div>`;
    tr.querySelector('input').oninput = (e) => setRatio(+e.target.value);
    tr.querySelector('.row2').onclick = (e) => { const b = e.target.closest('[data-r]'); if (b) { setRatio(+b.dataset.r); sfx.play('click'); } };
    el.appendChild(tr);
    setRatio(+$('ratio').value);
    add(o ? 'Attack here' : 'Expand here', 25, () => send({ k: 'atk', x, y, r: ratio() }));
    const coastal = game.isCoastal(i);
    add('Send troop boat', 20, () => send({ k: 'boat', x, y, r: ratio() }), coastal && P.counts.harbor > 0, coastal ? 'Needs a Harbor' : 'Must target a coast');
    add('Paradrop', 17, () => send({ k: 'drop', x, y, r: ratio() }), P.counts.airbase > 0, 'Needs an Airbase');
    for (const [k, M] of Object.entries(MISSILES)) add(`${M.name} (${fmt(M.cost)})`, M.icon, () => send({ k: 'msl', m: k, x, y }), P.counts.silo > 0, 'Needs a Missile Silo');
    if (s && o) add('Sabotage (2.5k)', 19, () => send({ k: 'spy', x, y }), P.counts.spy > 0, 'Needs a Spy HQ');
  }
  if (alive && o === me && s && s.type !== 'capital') add(`Demolish (+${fmt(STRUCTURES[s.type].cost * 0.25)})`, 24, () => send({ k: 'demolish', x, y }));
  if (alive && O && o !== me && O.alive) {
    if (game.allied(me, o)) {
      if (game.settings.mode === 'ffa') add(P.breaking.has(o) ? 'Breaking alliance...' : 'Break alliance', 31, () => send({ k: 'unally', t: o }), !P.breaking.has(o));
    } else add(P.allyReq.has(o) ? 'Accept alliance' : O.allyReq.has(me) ? 'Alliance requested' : 'Request alliance', 30, () => send({ k: 'ally', t: o }), !O.allyReq.has(me));
  }
  if (alive && !ter.water) add('Ping for allies', 29, () => send({ k: 'ping', x, y }));
  if (alive && P.admin && O && o !== me && O.alive) add('Admin: wipe out', 24, () => { if (confirm(`Wipe out ${O.name}?`)) send({ k: 'adm', a: 'kill', t: o }); });
  if (net.online && O && O.uid && o !== me) {
    add(muted.has(O.uid) ? 'Unmute chat' : 'Mute chat', null, () => {
      if (muted.has(O.uid)) muted.delete(O.uid); else muted.add(O.uid);
      store('pc.muted', JSON.stringify([...muted]));
      toast(muted.has(O.uid) ? `Muted ${O.name}.` : `Unmuted ${O.name}.`);
    });
  }
  if (O && o !== me) {
    const em = document.createElement('div'); em.className = 'emotes';
    EMOTES.forEach((t, k) => { const b = document.createElement('button'); b.textContent = t; b.onclick = () => { closeCtx(); send({ k: 'emote', e: k, t: o }); }; em.appendChild(b); });
    el.appendChild(em);
  }
  el.classList.remove('hidden');
  el.style.left = Math.min(innerWidth - el.offsetWidth - 8, sx) + 'px';
  el.style.top = Math.min(innerHeight - el.offsetHeight - 8, sy) + 'px';
  sfx.play('click');
}
function closeCtx() { $('ctx').classList.add('hidden'); }

// ---------- sim events -> feed, sound, effects ----------
function handleEvents() {
  const evs = game.events;
  if (!evs.length) return;
  game.events = [];
  if (game === attract) { for (const e of evs) if (e.type !== 'emote' && e.type !== 'ping') R.addFx(e); return; }
  for (const e of evs) {
    const mine = e.p === me, atMe = e.t === me;
    if (e.type === 'emote') {
      e.text = EMOTES[e.e] || '';
      if (!e.t || atMe || mine) { R.addFx(e); feed(`${nm(e.p)}: ${e.text}`); sfx.play('emote'); }
      continue;
    }
    if (e.type === 'ping') { if (mine || game.allied(e.p, me)) { R.addFx(e); sfx.play('request'); } continue; }
    R.addFx(e);
    switch (e.type) {
      case 'start': {
        setBanner('GO!', 'Click land to expand. Right-click for more.'); setTimeout(() => setBanner(null), 2200); sfx.play('spawn');
        const P = game.players[me];
        if (P && P.spawnI >= 0) R.centerOn(P.spawnI, Math.max(R.cam.z, 7));
        break;
      }
      case 'attack': if (atMe) { feed(`${nm(e.p)} is attacking you with ${fmt(e.troops)} troops!`, 'bad'); sfx.play('underAttack'); } break;
      case 'boat': if (mine) sfx.play('boat'); break;
      case 'landing': if (atMe) { feed(`${nm(e.p)} landed troops on your coast!`, 'bad'); sfx.play('underAttack'); } break;
      case 'plane': if (mine) sfx.play('plane'); if (atMe) feed(`Paratroopers from ${nm(e.p)} incoming!`, 'bad'); break;
      case 'launch':
        if (e.m === 'nuke') { feed(`☢ ${nm(e.p)} launched a NUKE!`, 'big'); sfx.play('siren'); }
        else if (atMe) { feed(`${MISSILES[e.m].name} incoming from ${nm(e.p)}!`, 'bad'); sfx.play('siren'); }
        if (mine) sfx.play('launch');
        break;
      case 'boom': if (e.m === 'nuke') sfx.play('nuke'); else if (mine || game.owner[e.i] === me || onScreen(e.i)) sfx.play('boom'); break;
      case 'intercept': if (mine || atMe) { feed(atMe ? 'Your Shield Dome stopped a missile!' : `${nm(e.t)}'s Shield Dome stopped your missile.`, atMe ? 'good' : 'bad'); sfx.play('shield'); } break;
      case 'shell': if (mine || atMe) sfx.play('shell'); break;
      case 'allyReq': if (atMe) { feed(`${nm(e.p)} wants an alliance.`, 'big', { buttons: [['Accept', () => send({ k: 'ally', t: e.p })], ['No', () => send({ k: 'decline', t: e.p })]] }); sfx.play('request'); } else if (mine) feed(`Alliance request sent to ${nm(e.t)}.`); break;
      case 'allied': feed(`${nm(e.p)} and ${nm(e.t)} are now allies.`, mine || atMe ? 'good' : ''); if (mine || atMe) sfx.play('ally'); break;
      case 'breaking': if (atMe) { feed(`${nm(e.p)} is breaking your alliance in 10 seconds!`, 'bad'); sfx.play('betray'); } break;
      case 'betrayed': feed(`${nm(e.p)} betrayed ${nm(e.t)}!`, atMe ? 'bad' : ''); if (atMe || mine) sfx.play('betray'); break;
      case 'built': if (mine) sfx.play('build'); break;
      case 'fail': if (mine) { toast(e.msg); sfx.play('error'); } break;
      case 'captured': if (mine) { feed(`Captured ${nm(e.t)}'s ${STRUCTURES[e.s].name}.`, 'good'); sfx.play('capture'); } else if (atMe) { feed(`${nm(e.p)} captured your ${STRUCTURES[e.s].name}.`, 'bad'); sfx.play('lost'); } break;
      case 'destroyed': if (mine) feed(`Your ${STRUCTURES[e.s].name} was destroyed.`, 'bad'); break;
      case 'capitalLost': if (mine) { feed('Your capital fell! Growth is 30% slower until you build a new one.', 'bad'); sfx.play('lost'); } else if (atMe) { feed(`You took ${nm(e.p)}'s capital!`, 'good'); sfx.play('capture'); } break;
      case 'spy':
        if (mine) { feed(`Sabotage worked: stole ${fmt(e.steal)} gold from ${nm(e.t)}.`, 'good'); sfx.play('spy'); }
        else if (atMe) { feed(`Your structure was sabotaged${e.caught ? ' by ' + nm(e.p) : ' by an unknown spy'}.`, 'bad'); sfx.play('spy'); }
        break;
      case 'ability': if (mine) sfx.play('ability'); break;
      case 'sunk': if (mine) { feed('One of your ships was sunk.', 'bad'); sfx.play('boom'); } break;
      case 'bot': feed(`${nm(e.p)} disconnected. An AI took over.`); break;
      case 'admin': feed(`${nm(e.p)} used admin: ${{ gold: '+50k gold', troops: '+50k troops', shield: 'entrench', kill: 'wiped out ' + nm(e.t) }[e.a]}`, 'bad'); break;
      case 'eliminated':
        feed(`${nm(e.p)} was eliminated.`, mine ? 'bad' : '');
        if (mine) { sfx.play('eliminated'); setBanner('You were eliminated', 'Spectating. Open Menu to leave.'); setTimeout(() => setBanner(null), 5000); }
        break;
      case 'over': showEnd(e.winner); break;
    }
  }
}

function onScreen(i) {
  const [x, y] = game.xy(i);
  const [sx, sy] = R.toScreen(x, y);
  return sx > 0 && sy > 0 && sx < cv.width && sy < cv.height;
}

function showEnd(winner) {
  const P = game.players[me];
  const won = winner && P && game.sideOf(me) === winner;
  const wid = winner && winner[0] === 'p' ? +winner.slice(1) : 0;
  $('endTitle').textContent = won ? 'VICTORY!' : 'DEFEAT';
  const wname = wid ? game.players[wid].name : winner ? 'Team ' + winner.slice(1) : 'Nobody';
  const st = P.stats;
  $('endStats').innerHTML = `<p>Winner: <b></b></p><table>
    <tr><td>Peak land</td><td>${fmt(st.peakTiles)} tiles</td></tr>
    <tr><td>Tiles conquered</td><td>${fmt(st.taken)}</td></tr>
    <tr><td>Troops lost</td><td>${fmt(st.lost)}</td></tr>
    <tr><td>Structures built</td><td>${st.built}</td></tr>
    <tr><td>Missiles launched</td><td>${st.missiles}</td></tr>
    <tr><td>Match length</td><td>${Math.floor(game.tick / 600)}m ${Math.floor(game.tick / 10) % 60}s</td></tr></table>`;
  $('endStats').querySelector('b').textContent = wname;
  $('end').classList.remove('hidden');
  sfx.play(won ? 'victory' : 'defeat');
  if (net && net.online) net.endMatch();
}

function leaveMatch() {
  if (net && net.online) net.leave();
  net = new LocalNet();
  $('gameMenu').classList.add('hidden');
  $('end').classList.add('hidden');
  closeCtx();
  setMode(null);
  setBanner(null);
  if (R) R.reveal = false;
  startAttract();
  showScreen('menu');
}

// ---------- input ----------
const lastPointer = { x: 0, y: 0 };
const pointers = new Map();
let drag = null, pinch = null, longPress = 0;

cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  cv.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  closeCtx();
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
    drag = null; clearTimeout(longPress);
    return;
  }
  drag = { x: e.clientX, y: e.clientY, cx: R.cam.x, cy: R.cam.y, moved: false, btn: e.button };
  if (e.pointerType === 'touch') longPress = setTimeout(() => { if (drag && !drag.moved) { drag.long = true; openCtx(R.toTile(e.clientX, e.clientY), e.clientX, e.clientY); } }, 500);
});
cv.addEventListener('pointermove', (e) => {
  lastPointer.x = e.clientX; lastPointer.y = e.clientY;
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    R.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinch.d);
    pinch.d = d;
    return;
  }
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) { drag.moved = true; clearTimeout(longPress); }
    if (drag.moved) { R.cam.x = drag.cx - (dx * R.dpr) / R.cam.z; R.cam.y = drag.cy - (dy * R.dpr) / R.cam.z; R.clampCam(); }
  }
  if (!R || game === attract) return;
  R.hover = R.toTile(e.clientX, e.clientY);
  if (mode && mode.k === 'build' && R.hover >= 0) {
    const t = mode.s;
    const rad = { bunker: 5, fortress: 8, watchtower: 18, artillery: 10, rail: 14, radar: 40, shield: 14, airbase: 70 }[t] || 0;
    R.ghost = { type: t, ok: !game.canBuild(me, t, R.hover), radius: rad };
  } else R.ghost = null;
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  clearTimeout(longPress);
  if (pinch) { if (pointers.size < 2) pinch = null; return; }
  if (!drag) return;
  const d = drag; drag = null;
  if (d.moved || d.long || game === attract) return;
  const i = R.toTile(e.clientX, e.clientY);
  if (d.btn === 2) { if (mode) setMode(null); else openCtx(i, e.clientX, e.clientY); return; }
  if (d.btn === 1) { if (i >= 0) { const [x, y] = game.xy(i); send({ k: 'ping', x, y }); } return; }
  clickTile(i);
};
cv.addEventListener('pointerup', endPointer);
cv.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); drag = null; pinch = null; });
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.shiftKey) { setRatio(+$('ratio').value + ((e.deltaY || e.deltaX) < 0 ? 5 : -5)); return; }
  R.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
}, { passive: false });
window.addEventListener('resize', () => R && R.resize());
// one send % for every troop action (attack, expand, boat, paradrop); remembered between games
function setRatio(pct) {
  pct = Math.max(5, Math.min(100, Math.round(pct / 5) * 5));
  $('ratio').value = pct;
  $('ratioV').textContent = pct + '%';
  for (const b of document.querySelectorAll('[data-r]')) b.classList.toggle('on', +b.dataset.r === pct);
  const ctxSlider = document.querySelector('#ctx .troops input');
  if (ctxSlider) ctxSlider.value = pct;
  showSendCount();
  store('pc.ratio', String(pct));
}
function showSendCount() {
  const P = game && game.players[me];
  const n = P ? fmt(P.troops * ratio()) : '';
  $('ratioN').textContent = n ? '= ' + n : '';
  const c = document.querySelector('#ctx .troops b');
  if (c) c.textContent = `${$('ratio').value}% · ${n} troops`;
}
$('ratio').oninput = () => setRatio(+$('ratio').value);
$('ratioPresets').onclick = (e) => { const b = e.target.closest('[data-r]'); if (b) { setRatio(+b.dataset.r); sfx.play('click'); } };
setRatio(+(store('pc.ratio') || 30));

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || !game || game === attract) return;
  const k = e.key.toLowerCase();
  if (k === 'escape') { if (mode) setMode(null); else if (!$('ctx').classList.contains('hidden')) closeCtx(); else $('gameMenu').classList.toggle('hidden'); return; }
  if (k === ' ') { e.preventDefault(); const P = game.players[me]; if (P && P.spawnI >= 0) { const cap = game.structs.find((s) => s.owner === me && s.type === 'capital'); R.centerOn(cap ? cap.i : P.tiles ? game.idx(Math.floor(P.sumX / P.tiles), Math.floor(P.sumY / P.tiles)) : P.spawnI, Math.max(R.cam.z, 6)); } return; }
  if (k === '[' || k === ']') { setRatio(+$('ratio').value + (k === ']' ? 10 : -10)); return; }
  if (k === 'v') { send({ k: 'retreat' }); return; }
  for (const [a, A] of Object.entries(ABILITIES)) if (A.key === k) { send({ k: 'ab', a }); return; }
  for (const s of STRUCTURE_ORDER) if (STRUCTURES[s].key === k) { setMode(mode && mode.s === s ? null : { k: 'build', s }); return; }
});

$('btnRetreat').onclick = () => send({ k: 'retreat' });
$('btnMenu').onclick = () => $('gameMenu').classList.remove('hidden');
$('btnPause').onclick = () => { paused = !paused; $('btnPause').textContent = paused ? '▶' : 'II'; setBanner(paused ? 'PAUSED' : null); };
$('gmResume').onclick = () => $('gameMenu').classList.add('hidden');
$('gmHelp').onclick = () => $('help').classList.remove('hidden');
$('gmSurrender').onclick = () => { send({ k: 'surrender' }); $('gameMenu').classList.add('hidden'); };
$('gmLeave').onclick = leaveMatch;
$('endMenu').onclick = leaveMatch;
$('endWatch').onclick = () => $('end').classList.add('hidden');

// ---------- chat (online only; travels beside the lockstep turns, never through the sim) ----------
let muted = new Set();
try { muted = new Set(JSON.parse(store('pc.muted') || '[]')); } catch { /* fresh list */ }
let chatCh = 'all', chatLast = 0;
const BAD = /(f+u+c+k+|sh+i+t+|b+i+t+c+h+|c+u+n+t+|d+i+c+k+|p+u+s+s+y+|a+s+s+h+o+l+e+|bastard|n+i+g+g+|f+a+g+|retard|whore|slut)\w*/gi;
const filterText = (t) => t.replace(BAD, (w) => w[0] + '*'.repeat(w.length - 1));

function onChat(v) {
  if (muted.has(v.u)) return;
  const inGame = game && game.netGame === net;
  let color = '#f4f4f4', slot = 0;
  if (inGame) { slot = game.players.findIndex((P) => P && P.uid === v.u); if (slot > 0) color = game.players[slot].color; }
  else { const p = net.lobby && net.lobby.players && net.lobby.players[v.u]; if (p && /^#[0-9a-f]{6}$/i.test(p.color)) color = p.color; }
  if (v.ch === 'ally' && inGame && v.u !== net.uid && !(slot > 0 && game.allied(slot, me))) return;
  const line = document.createElement('div');
  if (v.ch === 'ally') line.insertAdjacentHTML('beforeend', '<span class="tag">[ALLY]</span>');
  const b = document.createElement('b');
  b.style.color = color; b.textContent = String(v.n).slice(0, 16) + ':';
  line.appendChild(b);
  line.appendChild(document.createTextNode(filterText(v.t)));
  for (const id of ['lobbyChatLog', 'chatLog']) {
    const log = $(id);
    log.appendChild(line.cloneNode(true));
    while (log.children.length > 50) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  }
  if (v.u !== net.uid) sfx.play('emote');
}

function sendChatMsg(text, ch) {
  text = text.trim();
  if (!text || !net || !net.online) return;
  const now = performance.now();
  if (now - chatLast < 1200) { toast('Slow down a little.'); return; }
  chatLast = now;
  net.sendChat($('name').value, text, ch).catch(() => toast('Message not sent.'));
}
function setChatCh(ch) { chatCh = ch; $('chatCh').textContent = ch === 'ally' ? 'ALLIES' : 'ALL'; $('chatCh').classList.toggle('ally', ch === 'ally'); }
function openChat() { $('chat').classList.add('open'); $('chatIn').focus(); }
function closeChat() { $('chat').classList.remove('open'); $('chatIn').blur(); }

$('lobbyChatForm').onsubmit = (e) => { e.preventDefault(); sendChatMsg($('lobbyChatIn').value, 'all'); $('lobbyChatIn').value = ''; };
$('chatForm').onsubmit = (e) => { e.preventDefault(); sendChatMsg($('chatIn').value, chatCh); $('chatIn').value = ''; closeChat(); };
$('chatCh').onclick = () => { setChatCh(chatCh === 'all' ? 'ally' : 'all'); $('chatIn').focus(); };
$('chatIn').onkeydown = (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeChat(); }
  if (e.key === 'Tab') { e.preventDefault(); setChatCh(chatCh === 'all' ? 'ally' : 'all'); }
};
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !net || !net.online || $('chat').classList.contains('hidden') || document.activeElement === $('chatIn')) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  e.preventDefault();
  openChat();
});

// ---------- loop ----------
function runTick() {
  let cmds = [];
  if (game.tick % TURN_TICKS === 0) cmds = net.turnFor(game.tick / TURN_TICKS) || [];
  game.step(cmds);
  if (net.online && game.tick % 50 === 0) net.reportHash(game.tick, game.hash());
}

function loop(t) {
  const dt = Math.min(250, t - (lastT || t));
  lastT = t;
  if (game && R) {
    if (game === attract) {
      acc += dt;
      let n = 0;
      while (acc >= 100 && n++ < 3) { game.step([]); acc -= 100; }
      R.cam.x += dt * 0.004; if (R.cam.x > game.W - 60) R.cam.x = 60;
      R.clampCam();
      if (game.phase === 'over') startAttract();
    } else if (!paused) {
      acc += dt;
      if (net.online) {
        const allowed = (net.available() + 1) * TURN_TICKS;
        const behind = allowed - game.tick;
        let n = Math.floor(acc / 100);
        if (behind > 8) n = Math.max(n, Math.min(behind - 4, 10));
        while (n-- > 0 && game.tick < allowed) { runTick(); acc = Math.max(0, acc - 100); }
        if (game.tick >= allowed) acc = Math.min(acc, 100);
      } else {
        let n = 0;
        while (acc >= 100 && n++ < 4) { runTick(); acc -= 100; }
      }
    }
    handleEvents();
    R.draw(Math.min(1, acc / 100));
    if (game !== attract && t - hudAt > 100) { hudAt = t; updateHud(); }
    if (game !== attract && t - boardAt > 600) { boardAt = t; updateBoard(); }
  }
  requestAnimationFrame(loop);
}

// read-only handle for debugging in the console
window.pc = { get game() { return game; }, get R() { return R; }, get me() { return me; } };

boot().catch((e) => { console.error(e); toast('Failed to load the game: ' + e.message); });
