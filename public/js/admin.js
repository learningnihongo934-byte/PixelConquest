// Admin panel. Only accounts listed under /admins in the database are admins, and the
// database rules (not this file) are what actually stop everyone else. Open it with
// pixelconquest.web.app/#admin to sign in; after that an Admin button shows on the menu.
import { loadFirebase } from './net.js';
import { firebaseConfig } from './firebase-config.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ago = (ts) => { const m = Math.round((Date.now() - (ts || 0)) / 60000); return m < 60 ? m + 'm' : m < 2880 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd'; };

let f = null, ctx = null, tab = 'overview';
export const admin = { on: false };

export async function initAdmin(context) {
  ctx = context;
  $('admClose').onclick = closeAdmin;
  $('btnAdmin').onclick = openAdmin;
  $('gmAdmin').onclick = () => { $('gameMenu').classList.add('hidden'); openAdmin(); };
  for (const b of $('admTabs').children) b.onclick = () => { tab = b.dataset.t; render(); };
  try { f = await loadFirebase(); } catch { return; }
  // the announcement banner is for everyone
  f.onValue(f.ref(f.db, 'announce'), (s) => {
    const v = s.val();
    $('announce').classList.toggle('hidden', !(v && v.t));
    $('announce').textContent = v && v.t ? v.t : '';
    if (v && v.t && Date.now() - (v.ts || 0) < 60000) ctx.feed('📣 ' + v.t, 'good');
  });
  await checkAdmin();
  if (location.hash === '#admin') openAdmin();
  addEventListener('hashchange', () => { if (location.hash === '#admin') openAdmin(); });
}

async function checkAdmin() {
  const u = f.au.currentUser;
  admin.on = !!(u && !u.isAnonymous && (await f.get(f.ref(f.db, 'admins/' + u.uid))).exists());
  $('btnAdmin').classList.toggle('hidden', !admin.on);
  $('gmAdmin').classList.toggle('hidden', !admin.on);
}

function openAdmin() { $('admin').classList.remove('hidden'); render(); }
function closeAdmin() { $('admin').classList.add('hidden'); if (location.hash === '#admin') history.replaceState(null, '', location.pathname + location.search); }

// One popup at a time: a second click while the Google window is opening used to cancel the first
// (auth/cancelled-popup-request) and show a scary error even though sign-in still worked.
let signingIn = false;
async function signIn() {
  if (signingIn) return;
  signingIn = true;
  const btn = $('admSignIn');
  if (btn) { btn.disabled = true; btn.textContent = 'Opening Google...'; }
  try {
    await f.A.signInWithPopup(f.au, new f.A.GoogleAuthProvider());
    await checkAdmin();
  } catch (e) {
    if (e.code === 'auth/popup-blocked') ctx.toast('Your browser blocked the Google window. Allow pop-ups for this site, then try again.');
    else if (e.code === 'auth/popup-closed-by-user') ctx.toast('Sign-in cancelled.');
    else if (e.code !== 'auth/cancelled-popup-request') ctx.toast('Sign-in failed: ' + e.message);
  } finally {
    signingIn = false;
    render();
  }
}

async function signOut() {
  await f.A.signOut(f.au);
  await f.A.signInAnonymously(f.au);
  await checkAdmin();
  render();
}

const ref = (p) => f.ref(f.db, p);
const val = async (p) => (await f.get(ref(p))).val();

// lobby keys only (shallow REST read), so we never download every match's turn history
async function lobbyCodes() {
  const tok = await f.au.currentUser.getIdToken();
  const r = await fetch(`${firebaseConfig.databaseURL}/lobbies.json?shallow=true&auth=${tok}`);
  return Object.keys((await r.json()) || {});
}

async function lobbyList() {
  const codes = await lobbyCodes();
  const rows = await Promise.all(codes.map(async (code) => {
    const [status, created, host, players] = await Promise.all(['status', 'created', 'host', 'players'].map((k) => val(`lobbies/${code}/${k}`)));
    return { code, status, created, host, players: players || {} };
  }));
  return rows.sort((a, b) => (b.created || 0) - (a.created || 0));
}

async function render() {
  const body = $('admBody');
  for (const b of $('admTabs').children) b.classList.toggle('on', b.dataset.t === tab);
  if (!f) { body.innerHTML = '<p>Could not reach the server.</p>'; return; }
  const u = f.au.currentUser;
  $('admTabs').classList.toggle('hidden', !admin.on);
  if (!u || u.isAnonymous) {
    body.innerHTML = '<p>Sign in with the Google account that owns this game.</p><div class="btns"><button id="admSignIn" class="big">Sign in with Google</button></div>';
    $('admSignIn').onclick = signIn;
    return;
  }
  if (!admin.on) {
    body.innerHTML = `<p>Signed in as <b>${esc(u.email)}</b>, which is not an admin.</p><p class="small muted">Account id: <code>${esc(u.uid)}</code></p><div class="btns"><button id="admOut" class="ghost">Sign out</button></div>`;
    $('admOut').onclick = signOut;
    return;
  }
  body.innerHTML = '<p class="muted">Loading...</p>';
  try { await TABS[tab](body); } catch (e) { body.innerHTML = `<p>Error: ${esc(e.message)}</p>`; }
}

async function ban(uid, name) {
  if (!confirm(`Ban ${name} from online play? They will be removed from every lobby.`)) return;
  await f.set(ref('bans/' + uid), { name: String(name).slice(0, 16), ts: Date.now() });
  for (const code of await lobbyCodes()) if (await val(`lobbies/${code}/players/${uid}/name`)) await f.remove(ref(`lobbies/${code}/players/${uid}`));
  ctx.toast(`${name} is banned.`);
  render();
}

const TABS = {
  async overview(body) {
    const rows = await lobbyList();
    const live = rows.filter((r) => r.status === 'playing'), waiting = rows.filter((r) => r.status === 'lobby');
    const online = rows.filter((r) => r.status !== 'ended').reduce((n, r) => n + Object.values(r.players).filter((p) => p.online !== false).length, 0);
    const bans = Object.keys((await val('bans')) || {}).length;
    const P = ctx.game && ctx.game.players[ctx.me];
    body.innerHTML = `<div class="adm-stats">
      <div><b>${online}</b><small>players online</small></div><div><b>${live.length}</b><small>matches playing</small></div>
      <div><b>${waiting.length}</b><small>lobbies waiting</small></div><div><b>${rows.length}</b><small>lobbies stored</small></div><div><b>${bans}</b><small>bans</small></div></div>
      <p class="small muted">Signed in as ${esc(f.au.currentUser.email)}. <a href="#" id="admOut">Sign out</a></p>
      <h3>In this match</h3>
      ${P && ctx.inMatch() ? (P.admin ? `<div class="btns wrap">
        <button data-c="gold">+50k gold</button><button data-c="troops">+50k troops</button><button data-c="shield">Entrench 2 min</button>
        <button id="admReveal" class="ghost">${ctx.R.reveal ? 'Hide' : 'Reveal'} fog of war</button></div>
        <p class="small muted">Right-click any nation for "Admin: wipe out". Everyone in the match sees when you use admin powers.</p>`
        : '<p class="small muted">This match started before you were an admin, so cheats are off. They work in your next match.</p>') : '<p class="small muted">Start a match to use cheats (+gold, +troops, reveal map, wipe out a nation).</p>'}`;
    $('admOut').onclick = (e) => { e.preventDefault(); signOut(); };
    body.querySelectorAll('[data-c]').forEach((b) => { b.onclick = () => { ctx.send({ k: 'adm', a: b.dataset.c }); ctx.toast('Done.'); }; });
    if ($('admReveal')) $('admReveal').onclick = () => { ctx.R.reveal = !ctx.R.reveal; render(); };
  },

  async lobbies(body) {
    const rows = await lobbyList();
    body.innerHTML = `<div class="btns"><button id="admClean" class="ghost">Delete ended and stale lobbies</button></div><div class="adm-list"></div>`;
    const list = body.querySelector('.adm-list');
    if (!rows.length) list.innerHTML = '<p class="muted">No lobbies.</p>';
    for (const r of rows) {
      const d = document.createElement('div');
      d.className = 'adm-row';
      const ps = Object.entries(r.players);
      d.innerHTML = `<div><b>${esc(r.code)}</b> <span class="tagx ${esc(r.status)}">${esc(r.status || '?')}</span> <small class="muted">${ago(r.created)} ago · ${ps.length} players</small>
        <button class="ghost sm" data-del>Delete</button></div>
        <div class="adm-players">${ps.map(([uid, p]) => `<span>${esc(p.name)}${uid === r.host ? ' (host)' : ''}${p.online === false ? ' (off)' : ''}
          <button class="ghost sm" data-kick="${esc(uid)}">Kick</button><button class="ghost sm" data-ban="${esc(uid)}" data-name="${esc(p.name)}">Ban</button></span>`).join('')}</div>`;
      d.querySelector('[data-del]').onclick = async () => { await f.remove(ref('lobbies/' + r.code)); await f.remove(ref('open/' + r.code)); render(); };
      d.querySelectorAll('[data-kick]').forEach((b) => { b.onclick = async () => { await f.remove(ref(`lobbies/${r.code}/players/${b.dataset.kick}`)); render(); }; });
      d.querySelectorAll('[data-ban]').forEach((b) => { b.onclick = () => ban(b.dataset.ban, b.dataset.name); });
      list.appendChild(d);
    }
    $('admClean').onclick = async () => {
      const old = rows.filter((r) => r.status === 'ended' || Date.now() - (r.created || 0) > 3 * 3600e3 || !Object.values(r.players).some((p) => p.online !== false));
      if (!confirm(`Delete ${old.length} ended, empty or 3h+ old lobbies?`)) return;
      for (const r of old) { await f.remove(ref('lobbies/' + r.code)); await f.remove(ref('open/' + r.code)); }
      ctx.toast(`Deleted ${old.length} lobbies.`);
      render();
    };
  },

  async chat(body) {
    const codes = (await lobbyList()).slice(0, 30).map((r) => r.code);
    const msgs = [];
    await Promise.all(codes.map(async (code) => {
      const snap = await f.get(f.query(ref(`lobbies/${code}/chat`), f.limitToLast(20)));
      snap.forEach((c) => { const v = c.val(); if (v) msgs.push({ code, id: c.key, ...v }); });
    }));
    msgs.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    body.innerHTML = '<div class="adm-list"></div>';
    const list = body.querySelector('.adm-list');
    if (!msgs.length) list.innerHTML = '<p class="muted">No chat messages.</p>';
    for (const m of msgs.slice(0, 150)) {
      const d = document.createElement('div');
      d.className = 'adm-row chatline';
      d.innerHTML = `<small class="muted">${esc(m.code)} · ${ago(m.ts)}${m.ch === 'ally' ? ' · ally' : ''}</small> <b>${esc(m.n)}:</b> <span>${esc(m.t)}</span>
        <button class="ghost sm" data-del>Delete</button><button class="ghost sm" data-ban>Ban</button>`;
      d.querySelector('[data-del]').onclick = async () => { await f.remove(ref(`lobbies/${m.code}/chat/${m.id}`)); d.remove(); };
      d.querySelector('[data-ban]').onclick = () => ban(m.u, m.n);
      list.appendChild(d);
    }
  },

  async bans(body) {
    const bans = Object.entries((await val('bans')) || {}).sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
    body.innerHTML = '<div class="adm-list"></div>';
    const list = body.querySelector('.adm-list');
    if (!bans.length) list.innerHTML = '<p class="muted">Nobody is banned.</p>';
    for (const [uid, b] of bans) {
      const d = document.createElement('div');
      d.className = 'adm-row';
      d.innerHTML = `<b>${esc(b.name)}</b> <small class="muted">${ago(b.ts)} ago · ${esc(uid.slice(0, 8))}</small> <button class="ghost sm">Unban</button>`;
      d.querySelector('button').onclick = async () => { await f.remove(ref('bans/' + uid)); render(); };
      list.appendChild(d);
    }
  },

  async announce(body) {
    const cur = await val('announce');
    body.innerHTML = `<p class="small muted">Shown at the top of the main menu for everyone, and in the feed of anyone in a match.</p>
      <textarea id="admAnn" maxlength="200" rows="3" placeholder="e.g. New update: free expansion!">${esc(cur && cur.t)}</textarea>
      <div class="btns"><button id="admPost">Post</button><button id="admClear" class="ghost">Clear</button></div>`;
    $('admPost').onclick = async () => { const t = $('admAnn').value.trim().slice(0, 200); if (!t) return; await f.set(ref('announce'), { t, ts: Date.now() }); ctx.toast('Announcement posted.'); };
    $('admClear').onclick = async () => { await f.remove(ref('announce')); $('admAnn').value = ''; ctx.toast('Announcement cleared.'); };
  },
};
