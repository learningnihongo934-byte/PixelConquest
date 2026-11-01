// Canvas renderer: one pixel per tile for terrain + territory, Pixeter icons for everything on top.
import { TERRAIN, STRUCTURES, ICON, MISSILES } from './data.js';

const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const ICON_PX = 16;

export class Renderer {
  constructor(canvas, game, me, icons) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.g = game;
    this.me = me;
    this.icons = icons;
    const { W, H } = game;
    this.map = document.createElement('canvas');
    this.map.width = W; this.map.height = H;
    this.mctx = this.map.getContext('2d');
    this.img = this.mctx.createImageData(W, H);
    this.base = new Uint8ClampedArray(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      const t = game.terrain[i], [r, g, b] = TERRAIN[t].rgb;
      let h = (i * 2654435761) >>> 0; h = ((h ^ (h >>> 15)) * 2246822519) >>> 0;
      const v = ((h & 15) - 8) * (t === 7 || t === 4 ? 1.6 : 0.8);
      this.base[i * 3] = r + v; this.base[i * 3 + 1] = g + v; this.base[i * 3 + 2] = b + v;
    }
    this.pcol = game.players.map((P) => (P ? hexRgb(P.color) : [0, 0, 0]));
    this.cam = { x: W / 2, y: H / 2, z: 2 };
    this.fx = [];
    this.bubbles = [];
    this.visible = [];
    this.visAt = -99;
    this.hover = -1;
    this.ghost = null;
    this.frame = 0;
    for (let i = 0; i < W * H; i++) this.paint(i);
    this.mctx.putImageData(this.img, 0, 0);
    this.resize();
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dpr = dpr;
    this.cv.width = Math.floor(this.cv.clientWidth * dpr);
    this.cv.height = Math.floor(this.cv.clientHeight * dpr);
    const minZ = Math.max(this.cv.width / this.g.W, this.cv.height / this.g.H) * 0.9;
    this.minZ = minZ;
    if (this.cam.z < minZ) this.cam.z = minZ;
  }

  paint(i) {
    const g = this.g, d = this.img.data, o = g.owner[i], k = i * 4, b = i * 3;
    let r = this.base[b], gg = this.base[b + 1], bb = this.base[b + 2];
    if (g.falloutUntil[i] > g.tick) { r = (r + 150) >> 1; gg = (gg + 190) >> 1; bb = bb >> 1; }
    if (o) {
      const [pr, pg, pb] = this.pcol[o];
      if (g.players[o].border.has(i)) {
        const dark = o === this.me ? 0.85 : 0.6;
        r = pr * dark; gg = pg * dark; bb = pb * dark;
      } else { r = r * 0.45 + pr * 0.55; gg = gg * 0.45 + pg * 0.55; bb = bb * 0.45 + pb * 0.55; }
    }
    d[k] = r; d[k + 1] = gg; d[k + 2] = bb; d[k + 3] = 255;
  }

  flushDirty() {
    const g = this.g, W = g.W;
    if (!g.dirty.length) return;
    let x0 = W, y0 = g.H, x1 = -1, y1 = -1;
    const seen = new Set();
    for (const i of g.dirty) {
      for (const j of [i, i - 1, i + 1, i - W, i + W]) {
        if (j < 0 || j >= g.N || seen.has(j)) continue;
        seen.add(j);
        this.paint(j);
        const x = j % W, y = (j / W) | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    g.dirty.length = 0;
    this.mctx.putImageData(this.img, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  }

  // camera helpers
  toScreen(tx, ty) { const c = this.cam; return [(tx - c.x) * c.z + this.cv.width / 2, (ty - c.y) * c.z + this.cv.height / 2]; }
  toTile(sx, sy) {
    const c = this.cam;
    const x = Math.floor((sx * this.dpr - this.cv.width / 2) / c.z + c.x), y = Math.floor((sy * this.dpr - this.cv.height / 2) / c.z + c.y);
    return this.g.inMap(x, y) ? this.g.idx(x, y) : -1;
  }
  clampCam() {
    const c = this.cam, g = this.g;
    c.z = Math.max(this.minZ, Math.min(40, c.z));
    const hw = this.cv.width / 2 / c.z, hh = this.cv.height / 2 / c.z;
    c.x = Math.max(Math.min(hw, g.W / 2), Math.min(g.W - Math.min(hw, g.W / 2), c.x));
    c.y = Math.max(Math.min(hh, g.H / 2), Math.min(g.H - Math.min(hh, g.H / 2), c.y));
  }
  zoomAt(sx, sy, f) {
    const c = this.cam, px = sx * this.dpr, py = sy * this.dpr;
    const tx = (px - this.cv.width / 2) / c.z + c.x, ty = (py - this.cv.height / 2) / c.z + c.y;
    c.z = Math.max(this.minZ, Math.min(40, c.z * f));
    c.x = tx - (px - this.cv.width / 2) / c.z; c.y = ty - (py - this.cv.height / 2) / c.z;
    this.clampCam();
  }
  centerOn(i, z) { const [x, y] = this.g.xy(i); this.cam.x = x + 0.5; this.cam.y = y + 0.5; if (z) this.cam.z = z; this.clampCam(); }

  visionSources() {
    const g = this.g, me = this.me, out = [];
    for (const v of g.structs) {
      if (v.disabledUntil > g.tick || !(v.owner === me || g.allied(v.owner, me))) continue;
      const r = v.type === 'radar' ? 40 : v.type === 'watchtower' ? 18 : 0;
      if (r) out.push({ x: v.x, y: v.y, r2: r * r });
    }
    return out;
  }
  canSee(s, src) {
    const g = this.g, me = this.me;
    if (!me || !g.players[me].alive || s.owner === me || g.allied(s.owner, me)) return true;
    if (g.near(src || this.visionSources(), s.x, s.y)) return true;
    for (let dy = -6; dy <= 6; dy += 2) for (let dx = -6; dx <= 6; dx += 2) {
      const x = s.x + dx, y = s.y + dy;
      if (g.inMap(x, y)) { const o = g.owner[g.idx(x, y)]; if (o === me || (o && g.allied(o, me))) return true; }
    }
    return false;
  }

  icon(n, x, y, size, rot) {
    const c = this.ctx;
    const sx = (n % 16) * ICON_PX, sy = Math.floor(n / 16) * ICON_PX;
    if (rot) { c.save(); c.translate(x, y); c.rotate(rot); c.drawImage(this.icons, sx, sy, ICON_PX, ICON_PX, -size / 2, -size / 2, size, size); c.restore(); }
    else c.drawImage(this.icons, sx, sy, ICON_PX, ICON_PX, Math.round(x - size / 2), Math.round(y - size / 2), size, size);
  }

  addFx(e) {
    const g = this.g;
    if (e.type === 'boom') this.fx.push({ k: 'boom', i: e.i, r: e.r, t: 0, life: e.m === 'nuke' ? 90 : 40, nuke: e.m === 'nuke', emp: e.m === 'emp' });
    if (e.type === 'intercept') this.fx.push({ k: 'boom', i: e.i, r: 3, t: 0, life: 30, shield: true });
    if (e.type === 'shell') { const [tx, ty] = g.xy(e.i); this.fx.push({ k: 'shell', sx: e.sx, sy: e.sy, tx, ty, t: 0, life: 18 }); }
    if (e.type === 'ping') this.fx.push({ k: 'ping', i: e.i, t: 0, life: 90, col: g.players[e.p].color });
    if (e.type === 'sunk' || e.type === 'destroyed' || e.type === 'landing') this.fx.push({ k: 'boom', i: e.i, r: 2, t: 0, life: 24 });
    if (e.type === 'emote') this.bubbles.push({ p: e.p, text: e.text, t: 0, life: 200 });
  }

  draw(alpha) {
    const g = this.g, c = this.ctx, cv = this.cv, cam = this.cam, z = cam.z;
    this.frame++;
    this.flushDirty();
    c.imageSmoothingEnabled = false;
    c.fillStyle = '#1e345c';
    c.fillRect(0, 0, cv.width, cv.height);
    const [ox, oy] = this.toScreen(0, 0);
    c.drawImage(this.map, ox, oy, g.W * z, g.H * z);
    if (z >= 14) { // tile grid when zoomed in close
      c.strokeStyle = 'rgba(0,0,0,0.08)'; c.lineWidth = 1; c.beginPath();
      const x0 = Math.max(0, Math.floor(cam.x - cv.width / 2 / z)), x1 = Math.min(g.W, Math.ceil(cam.x + cv.width / 2 / z));
      const y0 = Math.max(0, Math.floor(cam.y - cv.height / 2 / z)), y1 = Math.min(g.H, Math.ceil(cam.y + cv.height / 2 / z));
      for (let x = x0; x <= x1; x++) { const [sx] = this.toScreen(x, 0); c.moveTo(sx, oy + y0 * z); c.lineTo(sx, oy + y1 * z); }
      for (let y = y0; y <= y1; y++) { const [, sy] = this.toScreen(0, y); c.moveTo(ox + x0 * z, sy); c.lineTo(ox + x1 * z, sy); }
      c.stroke();
    }

    // hover + build ghost
    if (this.hover >= 0) {
      const [hx, hy] = g.xy(this.hover);
      const [sx, sy] = this.toScreen(hx, hy);
      if (this.ghost) {
        const sz = Math.max(16, Math.min(36, z * 3));
        c.globalAlpha = 0.75;
        this.icon(STRUCTURES[this.ghost.type].icon, sx + z / 2, sy + z / 2, sz);
        c.globalAlpha = 1;
        c.strokeStyle = this.ghost.ok ? '#7dff7d' : '#ff5a5a';
        c.lineWidth = 2;
        c.strokeRect(sx + z / 2 - sz / 2 - 2, sy + z / 2 - sz / 2 - 2, sz + 4, sz + 4);
        if (this.ghost.radius) {
          c.beginPath(); c.arc(sx + z / 2, sy + z / 2, this.ghost.radius * z, 0, Math.PI * 2);
          c.setLineDash([6, 6]); c.stroke(); c.setLineDash([]);
        }
      } else {
        c.strokeStyle = 'rgba(255,255,255,0.8)'; c.lineWidth = Math.max(1, z / 8);
        c.strokeRect(sx, sy, z, z);
      }
    }

    // nation names
    c.textAlign = 'center';
    for (const P of g.players) {
      if (!P || !P.alive || P.tiles < 1) continue;
      const fs = Math.min(30, Math.sqrt(P.tiles) * z * 0.32);
      if (fs < 7 && P.id !== this.me) continue;
      const cx = P.sumX / P.tiles + 0.5, cy = P.sumY / P.tiles + 0.5;
      const [sx, sy] = this.toScreen(cx, cy);
      if (sx < -200 || sx > cv.width + 200 || sy < -50 || sy > cv.height + 50) continue;
      const f2 = Math.max(9, fs);
      this.label(P.name + (P.ai ? '' : ' ★'), sx, sy, f2, '#fff');
      this.label(this.troopText(P), sx, sy + f2, f2 * 0.8, '#ffe9a0');
      const bub = this.bubbles.find((b) => b.p === P.id);
      if (bub) this.bubble(bub.text, sx, sy - f2 * 1.3);
    }
    // structures (only what you can see)
    if (this.frame - this.visAt > 15) { const src = this.visionSources(); this.visible = g.structs.filter((s) => this.canSee(s, src)); this.visAt = this.frame; }
    const sz = Math.max(10, Math.min(36, Math.round(z * 3)));
    for (const s of this.visible) {
      if (!g.structAt.has(s.i)) continue;
      const [sx, sy] = this.toScreen(s.x + 0.5, s.y + 0.5);
      if (sx < -40 || sy < -40 || sx > cv.width + 40 || sy > cv.height + 40) continue;
      if (z < 1.6 && s.type !== 'capital') continue;
      c.fillStyle = g.players[s.owner].color;
      c.strokeStyle = '#14121f'; c.lineWidth = 2;
      c.beginPath(); c.arc(sx, sy, sz * 0.62, 0, Math.PI * 2); c.fill(); c.stroke();
      this.icon(STRUCTURES[s.type].icon, sx, sy, sz);
      if (s.disabledUntil > g.tick) {
        c.fillStyle = 'rgba(20,18,31,0.55)';
        c.beginPath(); c.arc(sx, sy, sz * 0.62, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#58c8f0'; c.font = `bold ${Math.max(9, sz / 2.6)}px monospace`; c.textAlign = 'center';
        c.fillText('OFF', sx, sy + sz / 8);
      }
      if (s.type === 'shield' && z >= 3) {
        for (let k = 0; k < 3; k++) { c.fillStyle = k < s.charges ? '#58c8f0' : '#4a5060'; c.fillRect(sx - 7 + k * 5, sy + sz * 0.55, 4, 4); }
      }
    }

    // my attack fronts
    for (const a of g.attacks) {
      if (a.p !== this.me) continue;
      const [sx, sy] = this.toScreen(a.fx + 0.5, a.fy + 0.5);
      c.strokeStyle = '#fff'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(sx - 6, sy - 6); c.lineTo(sx + 6, sy + 6); c.moveTo(sx + 6, sy - 6); c.lineTo(sx - 6, sy + 6); c.stroke();
      this.label(a.t ? Math.round(a.troops).toLocaleString() : 'EXPANDING', sx, sy - 10, a.t ? 12 : 10, a.t ? '#fff' : '#cfe8a0');
    }

    // ships, planes, missiles (interpolated between ticks by alpha)
    const us = Math.max(12, Math.min(30, z * 2.6));
    for (const b of g.boats) {
      const k = Math.min(b.path.length - 1, b.k), k2 = Math.min(b.path.length - 1, b.k + 2);
      const [x1, y1] = g.xy(b.path[k]), [x2, y2] = g.xy(b.path[k2]);
      const [sx, sy] = this.toScreen(x1 + (x2 - x1) * alpha * 0.5 + 0.5, y1 + (y2 - y1) * alpha * 0.5 + 0.5);
      this.icon(ICON.transport, sx, sy, us);
      this.dot(sx, sy - us / 2, g.players[b.p].color);
      if (b.p === this.me || z > 4) this.label(Math.round(b.troops).toLocaleString(), sx, sy + us * 0.7, 10, '#fff');
    }
    for (const w of g.warships) {
      const [sx, sy] = this.toScreen(w.x + 0.5, w.y + 0.5);
      if (!this.visibleUnit(w.x, w.y, w.owner)) continue;
      this.icon(ICON.warship, sx, sy, us);
      this.dot(sx, sy - us / 2, g.players[w.owner].color);
      if (w.stunUntil > g.tick) this.label('zz', sx, sy - us * 0.6, 10, '#58c8f0');
    }
    for (const p of g.planes) {
      const f = Math.min(1, (p.t + alpha) / p.total);
      const x = p.sx + (p.tx - p.sx) * f, y = p.sy + (p.ty - p.sy) * f;
      const [sx, sy] = this.toScreen(x + 0.5, y + 0.5);
      this.icon(ICON.plane, sx, sy, us, Math.atan2(p.ty - p.sy, p.tx - p.sx) + Math.PI / 2);
    }
    for (const m of g.missiles) {
      const f = Math.min(1, (m.t + alpha) / m.total);
      const dist = Math.hypot(m.tx - m.sx, m.ty - m.sy);
      const arc = Math.sin(Math.PI * f) * Math.min(40, dist * 0.3);
      const x = m.sx + (m.tx - m.sx) * f, y = m.sy + (m.ty - m.sy) * f - arc;
      const [sx, sy] = this.toScreen(x + 0.5, y + 0.5);
      const [tx, ty] = this.toScreen(m.tx + 0.5, m.ty + 0.5);
      c.strokeStyle = 'rgba(255,90,90,0.5)'; c.setLineDash([4, 4]); c.lineWidth = 1.5;
      c.beginPath(); c.arc(tx, ty, MISSILES[m.m].radius * z, 0, Math.PI * 2); c.stroke(); c.setLineDash([]);
      const f2 = Math.min(1, f + 0.02), arc2 = Math.sin(Math.PI * f2) * Math.min(40, dist * 0.3);
      const ang = Math.atan2((m.ty - m.sy) * 0.02 - (arc2 - arc), (m.tx - m.sx) * 0.02);
      this.icon(m.m === 'nuke' ? ICON.nuke : ICON.missile, sx, sy, us * (m.m === 'nuke' ? 1.4 : 1.1), ang);
    }

    // effects
    this.fx = this.fx.filter((e) => {
      e.t++;
      const f = e.t / e.life;
      if (e.k === 'boom') {
        const [x, y] = g.xy(e.i);
        const [sx, sy] = this.toScreen(x + 0.5, y + 0.5);
        const R = Math.max(8, e.r * z) * (0.4 + f * 0.8);
        c.globalAlpha = 1 - f;
        c.fillStyle = e.shield ? '#58c8f0' : e.emp ? '#9ad8ff' : e.nuke ? '#fff3b0' : '#f08a30';
        c.beginPath(); c.arc(sx, sy, R, 0, Math.PI * 2); c.fill();
        if (e.nuke) { c.strokeStyle = '#fff'; c.lineWidth = 4; c.beginPath(); c.arc(sx, sy, R * 1.6, 0, Math.PI * 2); c.stroke(); }
        c.globalAlpha = 1;
        if (f < 0.5) this.icon(ICON.explosion, sx, sy, Math.max(16, R));
      } else if (e.k === 'shell') {
        const x = e.sx + (e.tx - e.sx) * f, y = e.sy + (e.ty - e.sy) * f - Math.sin(Math.PI * f) * 4;
        const [sx, sy] = this.toScreen(x + 0.5, y + 0.5);
        c.fillStyle = '#ffdd66'; c.fillRect(sx - 2, sy - 2, 4, 4);
        if (e.t === e.life - 1) this.fx.push({ k: 'boom', i: g.idx(e.tx, e.ty), r: 1, t: 0, life: 14 });
      } else if (e.k === 'ping') {
        const [x, y] = g.xy(e.i);
        const [sx, sy] = this.toScreen(x + 0.5, y + 0.5);
        c.strokeStyle = e.col; c.lineWidth = 3; c.globalAlpha = 1 - f;
        c.beginPath(); c.arc(sx, sy, 6 + (e.t % 30), 0, Math.PI * 2); c.stroke(); c.globalAlpha = 1;
      }
      return e.t < e.life;
    });

    this.bubbles = this.bubbles.filter((b) => ++b.t < b.life);
  }

  troopText(P) {
    const g = this.g, me = this.me;
    const exact = P.id === me || !me || !g.players[me].alive || g.allied(P.id, me) || (P.revealedTo.get(me) || 0) > g.tick || (g.players[me].act.radar || 0) > 0;
    const n = Math.round(P.troops);
    if (exact) return fmt(n);
    const mag = Math.pow(10, Math.max(0, Math.floor(Math.log10(Math.max(1, n))) - 1));
    return '~' + fmt(Math.round(n / mag) * mag);
  }

  visibleUnit(x, y, owner) {
    const g = this.g, me = this.me;
    if (!me || owner === me || g.allied(owner, me) || !g.players[me].alive) return true;
    for (let dy = -8; dy <= 8; dy += 4) for (let dx = -8; dx <= 8; dx += 4) {
      if (g.inMap(x + dx, y + dy) && g.owner[g.idx(x + dx, y + dy)] === me) return true;
    }
    return false;
  }

  dot(x, y, col) { const c = this.ctx; c.fillStyle = col; c.strokeStyle = '#14121f'; c.lineWidth = 1.5; c.beginPath(); c.arc(x, y, 3.5, 0, Math.PI * 2); c.fill(); c.stroke(); }
  label(t, x, y, size, col) {
    const c = this.ctx;
    c.font = `bold ${Math.round(size)}px "Press Start 2P", monospace`;
    c.textAlign = 'center';
    c.lineWidth = Math.max(2, size / 4); c.strokeStyle = 'rgba(10,10,20,0.85)';
    c.strokeText(t, x, y); c.fillStyle = col; c.fillText(t, x, y);
  }
  bubble(t, x, y) {
    const c = this.ctx;
    c.font = 'bold 13px "Press Start 2P", monospace';
    const w = c.measureText(t).width + 14;
    c.fillStyle = '#f4f4f4'; c.strokeStyle = '#14121f'; c.lineWidth = 2;
    c.fillRect(x - w / 2, y - 22, w, 22); c.strokeRect(x - w / 2, y - 22, w, 22);
    c.fillStyle = '#14121f'; c.fillText(t, x, y - 6);
  }
}

export function fmt(n) {
  n = Math.round(n);
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(0) + 'k';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
