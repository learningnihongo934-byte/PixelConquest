// Sound effects and music, synthesized with Web Audio (no audio files to host or license).
const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } };

export class Sfx {
  constructor() {
    this.ctx = null;
    this.sfxOn = store('pc.sfx') !== '0';
    this.musicOn = store('pc.music') !== '0';
    this.last = {};
    this.mood = 'calm';
  }
  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.out = this.ctx.createGain(); this.out.gain.value = 0.5; this.out.connect(this.ctx.destination);
    this.musicBus = this.ctx.createGain(); this.musicBus.gain.value = this.musicOn ? 0.22 : 0; this.musicBus.connect(this.out);
    const len = this.ctx.sampleRate;
    this.noiseBuf = this.ctx.createBuffer(1, len, len);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.startMusic();
  }
  setSfx(on) { this.sfxOn = on; store('pc.sfx', on ? '1' : '0'); }
  setMusic(on) { this.musicOn = on; store('pc.music', on ? '1' : '0'); if (this.musicBus) this.musicBus.gain.value = on ? 0.22 : 0; }

  tone(f, dur, { type = 'square', vol = 0.15, to = 0, at = 0, bus } = {}) {
    const c = this.ctx, t = c.currentTime + at;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t);
    if (to) o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(bus || this.out);
    o.start(t); o.stop(t + dur + 0.05);
  }
  noise(dur, { vol = 0.3, freq = 1200, to = 0, at = 0, q = 0.7 } = {}) {
    const c = this.ctx, t = c.currentTime + at;
    const s = c.createBufferSource(); s.buffer = this.noiseBuf;
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = q; f.frequency.setValueAtTime(freq, t);
    if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.out);
    s.start(t); s.stop(t + dur + 0.05);
  }

  // name -> short synthesized effect; rate-limited so a busy war doesn't turn into noise
  play(name) {
    if (!this.sfxOn) return;
    this.ensure();
    if (!this.ctx) return;
    const now = performance.now();
    if (now - (this.last[name] || 0) < 90) return;
    this.last[name] = now;
    switch (name) {
      case 'click': this.tone(660, 0.05, { vol: 0.06 }); break;
      case 'hover': this.tone(880, 0.03, { vol: 0.025, type: 'triangle' }); break;
      case 'build': this.tone(220, 0.08, { vol: 0.12 }); this.tone(330, 0.08, { vol: 0.12, at: 0.07 }); this.noise(0.12, { vol: 0.15, freq: 900, at: 0.02 }); break;
      case 'spawn': [262, 330, 392, 523].forEach((f, k) => this.tone(f, 0.15, { vol: 0.1, at: k * 0.07, type: 'triangle' })); break;
      case 'attack': this.noise(0.25, { vol: 0.25, freq: 400, to: 120 }); this.tone(110, 0.2, { vol: 0.15, to: 60 }); break;
      case 'expand': this.tone(520, 0.06, { vol: 0.05, type: 'triangle', to: 700 }); break;
      case 'underAttack': this.tone(440, 0.12, { vol: 0.1 }); this.tone(330, 0.18, { vol: 0.1, at: 0.13 }); break;
      case 'boat': this.tone(147, 0.5, { vol: 0.12, type: 'sawtooth' }); this.tone(110, 0.6, { vol: 0.08, type: 'sawtooth', at: 0.05 }); break;
      case 'plane': this.noise(0.8, { vol: 0.12, freq: 2000, to: 300 }); break;
      case 'launch': this.noise(0.9, { vol: 0.25, freq: 300, to: 3000, q: 2 }); this.tone(80, 0.5, { vol: 0.15, to: 300, type: 'sawtooth' }); break;
      case 'boom': this.noise(0.7, { vol: 0.5, freq: 900, to: 60 }); this.tone(70, 0.5, { vol: 0.3, to: 30, type: 'sine' }); break;
      case 'nuke':
        this.noise(2.5, { vol: 0.8, freq: 600, to: 30 }); this.tone(45, 2.2, { vol: 0.4, to: 20, type: 'sine' });
        this.tone(30, 2.8, { vol: 0.3, type: 'triangle', at: 0.1 }); break;
      case 'siren': for (let k = 0; k < 3; k++) this.tone(520, 0.45, { vol: 0.09, to: 820, at: k * 0.5, type: 'sawtooth' }); break;
      case 'shield': this.tone(1200, 0.25, { vol: 0.1, to: 400, type: 'sine' }); this.tone(1800, 0.2, { vol: 0.06, to: 600, type: 'sine', at: 0.04 }); break;
      case 'shell': this.noise(0.18, { vol: 0.18, freq: 700, to: 150 }); break;
      case 'ally': [523, 659, 784].forEach((f, k) => this.tone(f, 0.25, { vol: 0.09, at: k * 0.09, type: 'triangle' })); break;
      case 'request': this.tone(784, 0.1, { vol: 0.08, type: 'triangle' }); this.tone(988, 0.15, { vol: 0.08, type: 'triangle', at: 0.1 }); break;
      case 'betray': [392, 370, 277].forEach((f, k) => this.tone(f, 0.3, { vol: 0.1, at: k * 0.15, type: 'sawtooth' })); break;
      case 'tier': [392, 523, 659, 784, 1047].forEach((f, k) => this.tone(f, 0.18, { vol: 0.08, at: k * 0.06, type: 'square' })); break;
      case 'ability': this.tone(300, 0.3, { vol: 0.12, to: 900 }); this.noise(0.3, { vol: 0.1, freq: 3000 }); break;
      case 'spy': this.tone(196, 0.12, { vol: 0.08, type: 'triangle' }); this.tone(233, 0.12, { vol: 0.08, type: 'triangle', at: 0.14 }); break;
      case 'error': this.tone(160, 0.15, { vol: 0.1, type: 'square' }); break;
      case 'emote': this.tone(1046, 0.06, { vol: 0.06, type: 'triangle' }); this.tone(1318, 0.08, { vol: 0.06, type: 'triangle', at: 0.06 }); break;
      case 'capture': this.tone(392, 0.1, { vol: 0.1 }); this.tone(587, 0.15, { vol: 0.1, at: 0.08 }); break;
      case 'lost': this.tone(330, 0.2, { vol: 0.1, type: 'sawtooth', to: 200 }); break;
      case 'eliminated': this.tone(220, 0.6, { vol: 0.12, type: 'sawtooth', to: 80 }); break;
      case 'victory': [523, 523, 523, 659, 784, 1047].forEach((f, k) => this.tone(f, k === 5 ? 0.7 : 0.16, { vol: 0.12, at: [0, 0.15, 0.3, 0.45, 0.65, 0.85][k] })); break;
      case 'defeat': [392, 349, 311, 262].forEach((f, k) => this.tone(f, 0.4, { vol: 0.1, at: k * 0.3, type: 'triangle' })); break;
    }
  }

  // tiny generative soundtrack: soft pentatonic arps, bass gets busier when you're at war
  startMusic() {
    const c = this.ctx;
    const scale = [0, 2, 4, 7, 9, 12, 14, 16];
    let step = 0;
    const roots = [146.8, 130.8, 110, 123.5];
    const tick = () => {
      const war = this.mood === 'war';
      const root = roots[Math.floor(step / 16) % roots.length];
      if (step % 4 === 0) this.tone(root / 2, war ? 0.3 : 0.9, { type: 'triangle', vol: war ? 0.35 : 0.25, bus: this.musicBus });
      if (war && step % 2 === 1) this.tone(root / 2, 0.12, { type: 'square', vol: 0.08, bus: this.musicBus });
      if (Math.random() < (war ? 0.55 : 0.4)) {
        const n = scale[Math.floor(Math.random() * scale.length)];
        this.tone(root * 2 * Math.pow(2, n / 12), 0.4, { type: 'triangle', vol: 0.09, bus: this.musicBus });
      }
      step++;
      setTimeout(tick, war ? 190 : 260);
    };
    if (c) tick();
  }
}
