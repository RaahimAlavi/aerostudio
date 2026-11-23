// Pure Web Audio API procedural sound synthesizer for both PC Host & Phone Wii-Speaker

const LYDIAN_FREQS = [
  261.63, // C4
  293.66, // D4
  329.63, // E4
  369.99, // F#4
  392.00, // G4
  440.00, // A4
  493.88, // B4
  523.25, // C5
  587.33, // D5
  659.25, // E5
  739.99, // F#5
  783.99, // G5
  880.00, // A5
  987.77, // B5
  1046.50, // C6
];

export class AeroAudio {
  constructor(mode = 'host') {
    this.mode = mode; // 'host' | 'phone'
    this.ctx = null;
    this.master = null;
    this.delay = null;
    this.noiseBuffer = null;
    this.muted = false;
    this.lastAetherTime = 0;
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();

      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.mode === 'phone' ? 0.55 : 0.72;

      if (this.mode === 'phone') {
        // Ultra-lightweight direct audio path on mobile phones (zero continuous DSP overhead!)
        this.master.connect(this.ctx.destination);
      } else {
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.knee.value = 18;
        comp.ratio.value = 6;
        comp.attack.value = 0.004;
        comp.release.value = 0.14;

        // Lush console spatial stereo delay tail
        this.delay = this.ctx.createDelay(0.6);
        this.delay.delayTime.value = 0.19;
        const fb = this.ctx.createGain();
        fb.gain.value = 0.24;
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 3400;
        const wet = this.ctx.createGain();
        wet.gain.value = 0.22;

        this.delay.connect(lp);
        lp.connect(fb);
        fb.connect(this.delay);
        lp.connect(wet);
        wet.connect(comp);

        this.master.connect(comp);
        comp.connect(this.ctx.destination);
      }

      this._createNoiseBuffer();
    }

    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return true;
  }

  setMuted(flag) {
    this.muted = !!flag;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(
        this.muted ? 0 : this.mode === 'phone' ? 0.65 : 0.72,
        this.ctx.currentTime,
        0.02
      );
    }
  }

  _createNoiseBuffer() {
    const sr = this.ctx.sampleRate;
    const len = sr * 1.2;
    const buf = this.ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noiseBuffer = buf;
  }

  _ready() {
    if (this.muted) return false;
    if (!this.ctx) this.unlock();
    if (!this.ctx || this.ctx.state !== 'running') return false;
    return true;
  }

  _out(node, sendWet = 0) {
    node.connect(this.master);
    if (sendWet > 0 && this.delay) {
      const g = this.ctx.createGain();
      g.gain.value = sendWet;
      node.connect(g);
      g.connect(this.delay);
    }
  }

  // Iconic warm Wii-inspired 3-note crystalline link chime
  playConnect(slot = 0) {
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    const baseShift = Math.pow(2, (slot * 2) / 12);
    const notes = [523.25, 659.25, 1046.5]; // C5 - E5 - C6

    notes.forEach((f, idx) => {
      const t = now + idx * 0.075;
      const osc = this.ctx.createOscillator();
      const osc2 = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sine';
      osc2.type = 'triangle';
      osc.frequency.setValueAtTime(f * baseShift, t);
      osc2.frequency.setValueAtTime(f * baseShift * 2, t);

      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);

      const g2 = this.ctx.createGain();
      g2.gain.value = 0.04;
      osc.connect(g);
      osc2.connect(g2);
      g2.connect(g);
      this._out(g, 0.55);

      osc.start(t);
      osc2.start(t);
      osc.stop(t + 0.45);
      osc2.stop(t + 0.45);
    });
  }

  playHover() {
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(920, now);
    osc.frequency.exponentialRampToValueAtTime(1240, now + 0.035);
    g.gain.setValueAtTime(0.045, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.045);
    osc.connect(g);
    this._out(g, 0.1);
    osc.start(now);
    osc.stop(now + 0.05);
  }

  playClick(pitch = 1.0) {
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(680 * pitch, now);
    osc.frequency.exponentialRampToValueAtTime(280 * pitch, now + 0.05);
    g.gain.setValueAtTime(0.14, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.055);
    osc.connect(g);
    this._out(g, 0.15);
    osc.start(now);
    osc.stop(now + 0.06);
  }

  playWhoosh(speed = 1.0) {
    if (!this._ready() || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 3.2;
    const startF = 420 + Math.min(800, speed * 260);
    filter.frequency.setValueAtTime(startF, now);
    filter.frequency.exponentialRampToValueAtTime(startF * 2.8, now + 0.07);
    filter.frequency.exponentialRampToValueAtTime(220, now + 0.18);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(Math.min(0.24, 0.09 + speed * 0.06), now + 0.035);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.19);

    src.connect(filter);
    filter.connect(g);
    this._out(g, 0.2);
    src.start(now);
    src.stop(now + 0.21);
  }

  playSlice(combo = 1) {
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    this.playWhoosh(1.2);

    // Rising crystalline katana shimmer
    const idx = Math.min(LYDIAN_FREQS.length - 1, Math.max(0, combo + 3));
    const freq = LYDIAN_FREQS[idx];
    const osc = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'triangle';
    osc2.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 1.02, now + 0.26);
    osc2.frequency.setValueAtTime(freq * 2, now);

    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.22, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);

    osc.connect(g);
    osc2.connect(g);
    this._out(g, 0.5);
    osc.start(now);
    osc2.start(now);
    osc.stop(now + 0.36);
    osc2.stop(now + 0.36);
  }

  playMine() {
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(160, now);
    osc.frequency.exponentialRampToValueAtTime(36, now + 0.45);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, now);
    lp.frequency.exponentialRampToValueAtTime(120, now + 0.45);

    g.gain.setValueAtTime(0.32, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.48);

    osc.connect(lp);
    lp.connect(g);
    this._out(g, 0.25);
    osc.start(now);
    osc.stop(now + 0.5);

    if (this.noiseBuffer) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const ng = this.ctx.createGain();
      ng.gain.setValueAtTime(0.24, now);
      ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
      const nlp = this.ctx.createBiquadFilter();
      nlp.type = 'lowpass';
      nlp.frequency.value = 600;
      src.connect(nlp);
      nlp.connect(ng);
      this._out(ng, 0.15);
      src.start(now);
      src.stop(now + 0.35);
    }
  }

  playGrab() {
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(520, now + 0.11);
    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(0.16, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
    osc.connect(g);
    this._out(g, 0.35);
    osc.start(now);
    osc.stop(now + 0.16);
  }

  playFling(speed = 1) {
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    this.playWhoosh(Math.max(0.9, speed));
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(420, now);
    osc.frequency.exponentialRampToValueAtTime(160, now + 0.14);
    g.gain.setValueAtTime(0.14, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
    osc.connect(g);
    this._out(g, 0.25);
    osc.start(now);
    osc.stop(now + 0.16);
  }

  playImpact(intensity = 0.6, seed = 0) {
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    const vol = Math.min(0.22, Math.max(0.03, intensity * 0.2));
    const freq = LYDIAN_FREQS[Math.abs(Math.floor(seed)) % 10] * 0.75;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.92, now + 0.12);
    g.gain.setValueAtTime(vol, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    osc.connect(g);
    this._out(g, 0.3);
    osc.start(now);
    osc.stop(now + 0.17);
  }

  playShockwave() {
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(240, now);
    osc.frequency.exponentialRampToValueAtTime(42, now + 0.55);
    g.gain.setValueAtTime(0.35, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.58);
    osc.connect(g);
    this._out(g, 0.4);
    osc.start(now);
    osc.stop(now + 0.6);

    // Harmonic shimmer halo
    const osc2 = this.ctx.createOscillator();
    const g2 = this.ctx.createGain();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(523.25, now);
    osc2.frequency.exponentialRampToValueAtTime(1046.5, now + 0.35);
    g2.gain.setValueAtTime(0.11, now);
    g2.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
    osc2.connect(g2);
    this._out(g2, 0.6);
    osc2.start(now);
    osc2.stop(now + 0.44);
  }

  playBlaster() {
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(1180, now);
    osc.frequency.exponentialRampToValueAtTime(155, now + 0.11);

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3200, now);
    lp.frequency.exponentialRampToValueAtTime(420, now + 0.11);

    g.gain.setValueAtTime(0.2, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);

    osc.connect(lp);
    lp.connect(g);
    this._out(g, 0.18);
    osc.start(now);
    osc.stop(now + 0.13);
  }

  playTargetHit(bullseye = false, combo = 1) {
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    const baseIdx = Math.min(LYDIAN_FREQS.length - 1, 4 + (combo % 10));
    const freq = LYDIAN_FREQS[baseIdx];
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);
    g.gain.setValueAtTime(0.2, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    osc.connect(g);
    this._out(g, 0.45);
    osc.start(now);
    osc.stop(now + 0.3);

    if (bullseye) {
      const osc2 = this.ctx.createOscillator();
      const g2 = this.ctx.createGain();
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(freq * 1.5, now + 0.04);
      g2.gain.setValueAtTime(0.18, now + 0.04);
      g2.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
      osc2.connect(g2);
      this._out(g2, 0.55);
      osc2.start(now + 0.04);
      osc2.stop(now + 0.36);
    }
  }

  playReload() {
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    // Crisp 2-stage mechanical bolt rack
    [0, 0.09].forEach((offset, i) => {
      const t = now + offset;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(i === 0 ? 480 : 860, t);
      osc.frequency.exponentialRampToValueAtTime(i === 0 ? 640 : 1280, t + 0.045);
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1600;
      g.gain.setValueAtTime(0.14, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      osc.connect(bp);
      bp.connect(g);
      this._out(g, 0.15);
      osc.start(t);
      osc.stop(t + 0.07);
    });
  }

  playEmpty() {
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(240, now);
    osc.frequency.exponentialRampToValueAtTime(140, now + 0.04);
    g.gain.setValueAtTime(0.09, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.045);
    osc.connect(g);
    this._out(g, 0);
    osc.start(now);
    osc.stop(now + 0.05);
  }

  playAetherNote(normY = 0.5, velocity = 0.6, roll = 0) {
    if (!this._ready()) return;
    const nowMs = performance.now();
    if (nowMs - this.lastAetherTime < 85) return;
    this.lastAetherTime = nowMs;

    const now = this.ctx.currentTime;
    const invY = Math.max(0, Math.min(1, 1 - normY));
    const idx = Math.floor(invY * (LYDIAN_FREQS.length - 1));
    const freq = LYDIAN_FREQS[idx];

    const osc = this.ctx.createOscillator();
    const oscSub = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const g = this.ctx.createGain();

    osc.type = 'triangle';
    oscSub.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);
    oscSub.frequency.setValueAtTime(freq * 0.5, now);

    filter.type = 'lowpass';
    const shimmer = 900 + Math.abs(roll) * 1400 + velocity * 1800;
    filter.frequency.setValueAtTime(Math.min(6000, shimmer), now);
    filter.Q.value = 3.5;

    const peak = Math.min(0.16, 0.045 + velocity * 0.09);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(peak, now + 0.025);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.68);

    osc.connect(filter);
    oscSub.connect(filter);
    filter.connect(g);
    this._out(g, 0.75);

    osc.start(now);
    oscSub.start(now);
    osc.stop(now + 0.72);
    oscSub.stop(now + 0.72);
  }

  // Cute musical companion chirp (Mochi!)
  playChirp(mood = 'happy') {
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    const notes = mood === 'happy' ? [784, 1046.5, 1318.5] : mood === 'gasp' ? [620, 420] : [660, 880];
    notes.forEach((f, idx) => {
      const t = now + idx * 0.055;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.exponentialRampToValueAtTime(f * (mood === 'gasp' ? 0.88 : 1.08), t + 0.09);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.11, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      osc.connect(g);
      this._out(g, 0.35);
      osc.start(t);
      osc.stop(t + 0.16);
    });
  }

  // Crisp air-hockey puck clack
  playPuckHit(intensity = 0.7) {
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'triangle';
    const base = 360 + intensity * 380;
    osc.frequency.setValueAtTime(base, now);
    osc.frequency.exponentialRampToValueAtTime(140, now + 0.065);
    g.gain.setValueAtTime(Math.min(0.24, 0.07 + intensity * 0.16), now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.075);
    osc.connect(g);
    this._out(g, 0.2);
    osc.start(now);
    osc.stop(now + 0.085);
  }

  // Celebratory goal / round solved fanfare
  playGoal() {
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, idx) => {
      const t = now + idx * 0.065;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(f, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.18, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      osc.connect(g);
      this._out(g, 0.55);
      osc.start(t);
      osc.stop(t + 0.45);
    });
  }

  // Soft powdery 3D erase puff
  playErase() {
    if (!this._ready() || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1400, now);
    bp.frequency.exponentialRampToValueAtTime(520, now + 0.11);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.08, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    src.connect(bp);
    bp.connect(g);
    this._out(g, 0.15);
    src.start(now);
    src.stop(now + 0.13);
  }

  playEliminated() {
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    [392, 311.13, 233.08].forEach((f, idx) => {
      const t = now + idx * 0.11;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f, t);
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      g.gain.setValueAtTime(0.16, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
      osc.connect(lp);
      lp.connect(g);
      this._out(g, 0.3);
      osc.start(t);
      osc.stop(t + 0.26);
    });
  }

  // Triggered on the Phone Controller when the Host sends Wii-Remote speaker feedback
  playFeedback(sfx, pitch = 1.0) {
    switch (sfx) {
      case 'connect':
        this.playConnect(0);
        break;
      case 'slice':
        this.playSlice(Math.round(pitch * 4));
        break;
      case 'mine':
        this.playMine();
        break;
      case 'puck':
        this.playPuckHit(pitch);
        break;
      case 'goal':
        this.playGoal();
        break;
      case 'erase':
        this.playErase();
        break;
      case 'ko':
        this.playEliminated();
        break;
      case 'chirp':
        this.playChirp('happy');
        break;
      case 'chime':
        this.playAetherNote(0.3, 0.7, 0.3);
        break;
      case 'hover':
        this.playHover();
        break;
      default:
        this.playClick(pitch);
    }
  }
}
