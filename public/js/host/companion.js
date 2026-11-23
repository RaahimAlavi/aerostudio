import { SpringVal } from '../shared/spring.js';

/**
 * MOCHI — Ultra-clean, minimal soft-shaded ceramic companion (2D HiDPI Canvas, zero emojis).
 * Features real damped spring squash-and-stretch, organic blinking, happy curved eyes,
 * 180Hz cursor tracking, bouncy secondary-motion ears, and crisp geometric celebration bursts.
 */
export class MochiCompanion {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = 126;
    this.h = 126;

    this.lookX = new SpringVal(0, 210, 19);
    this.lookY = new SpringVal(0, 210, 19);
    this.bounceY = new SpringVal(-55, 290, 17); // Cute drop-in on load
    this.bounceY.target = 0;
    this.squash = new SpringVal(1, 360, 17);
    this.tilt = new SpringVal(0, 240, 16);
    this.earLag = new SpringVal(0, 210, 14);

    this.mood = 'idle'; // 'idle' | 'happy' | 'gasp'
    this.moodTimer = 0;
    this.accent = '#2563EB';
    this.eyeColor = '#60A5FA';
    this.blinkTimer = 2.2;
    this.blinkAmt = 0;
    this.t = 0;
    this.particles = [];

    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(1, r.width || 126);
    this.h = Math.max(1, r.height || 126);
    this.canvas.width = Math.floor(this.w * this.dpr);
    this.canvas.height = Math.floor(this.h * this.dpr);
  }

  setLookTarget(nx, ny) {
    this.lookX.target = Math.max(-1, Math.min(1, (nx - 0.5) * 2));
    this.lookY.target = Math.max(-1, Math.min(1, (ny - 0.5) * 2));
  }

  react(kind = 'happy', accentHex = null) {
    if (accentHex) {
      this.accent = accentHex;
      this.eyeColor = accentHex;
    }
    if (kind === 'happy' || kind === 'poke' || kind === 'pair') {
      this.mood = 'happy';
      this.moodTimer = 1.25;
      this.squash.value = 0.78;
      this.squash.impulse(3.2);
      this.bounceY.impulse(kind === 'pair' ? -240 : -175);
      this.tilt.impulse((Math.random() < 0.5 ? -1 : 1) * 4.2);
      this._spawnBurst(kind === 'pair' ? 12 : 8);
    } else if (kind === 'gasp') {
      this.mood = 'gasp';
      this.moodTimer = 0.85;
      this.squash.value = 1.18;
      this.squash.impulse(-2.2);
      this.bounceY.impulse(-120);
    }
  }

  _spawnBurst(count) {
    const colors = ['#2563EB', '#F43F5E', '#10B981', '#F59E0B', '#7C3AED'];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.35;
      const spd = 55 + Math.random() * 75;
      this.particles.push({
        x: 0,
        y: -8,
        vx: Math.cos(a) * spd,
        vy: Math.sin(a) * spd - 35,
        size: 3 + Math.random() * 3,
        rot: Math.random() * Math.PI,
        vRot: (Math.random() - 0.5) * 9,
        color: colors[i % colors.length],
        life: 0.75 + Math.random() * 0.3,
        maxLife: 1.05,
        shape: i % 2 === 0 ? 'diamond' : 'dot',
      });
    }
  }

  update(dt) {
    this.t += dt;
    const lx = this.lookX.step(dt);
    const ly = this.lookY.step(dt);
    const by = this.bounceY.step(dt);
    const sq = Math.max(0.7, Math.min(1.3, this.squash.step(dt)));
    const tiltRad = this.tilt.step(dt) * 0.08 + lx * 0.07;

    this.earLag.target = -this.bounceY.velocity * 0.018;
    const earOffset = this.earLag.step(dt);

    if (this.moodTimer > 0) {
      this.moodTimer -= dt;
      if (this.moodTimer <= 0) {
        this.mood = 'idle';
        this.eyeColor = '#60A5FA';
      }
    }

    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) {
      this.blinkAmt = 1;
      this.blinkTimer = 2.6 + Math.random() * 2.8;
    }
    this.blinkAmt = Math.max(0, this.blinkAmt - dt * 8.5);

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 170 * dt;
      p.rot += p.vRot * dt;
      p.life -= dt;
      if (p.life <= 0) this.particles.splice(i, 1);
    }

    this._render(lx, ly, by, sq, tiltRad, earOffset);
  }

  _render(lx, ly, by, sq, tiltRad, earOffset) {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    const unit = Math.min(w, h) / 126;

    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, w, h);

    const cx = w * 0.5;
    const hover = Math.sin(this.t * 2.5) * 3.2 * unit;
    const cy = h * 0.54 + hover + by * unit * 0.45;

    // Soft studio contact shadow
    const heightFactor = Math.max(0.55, 1 - (-by * 0.004 + (hover / (3.2 * unit)) * 0.06));
    ctx.save();
    ctx.translate(cx, h * 0.87);
    ctx.scale(heightFactor, heightFactor);
    const shGrad = ctx.createRadialGradient(0, 0, 2, 0, 0, 32 * unit);
    shGrad.addColorStop(0, 'rgba(15, 23, 42, 0.14)');
    shGrad.addColorStop(1, 'rgba(15, 23, 42, 0)');
    ctx.fillStyle = shGrad;
    ctx.beginPath();
    ctx.ellipse(0, 0, 32 * unit, 8 * unit, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Celebration geometric sparkles
    ctx.save();
    ctx.translate(cx, cy);
    for (const p of this.particles) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.translate(p.x * unit, p.y * unit);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      const sz = p.size * unit;
      if (p.shape === 'diamond') {
        ctx.beginPath();
        ctx.moveTo(0, -sz);
        ctx.lineTo(sz * 0.72, 0);
        ctx.lineTo(0, sz);
        ctx.lineTo(-sz * 0.72, 0);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, sz * 0.55, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.restore();

    // Main Mochi pebble body with volume-preserving squash & stretch
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(tiltRad);
    const invSq = 1 / Math.sqrt(sq);
    ctx.scale(invSq, sq);

    // Cute rounded ear nubs (with subtle secondary spring lag)
    const earY = -30 * unit + earOffset * unit;
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.translate(side * 19 * unit, earY);
      ctx.rotate(side * 0.28);
      ctx.beginPath();
      ctx.roundRect(-5.5 * unit, -12 * unit, 11 * unit, 17 * unit, 5.5 * unit);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.lineWidth = 1.4 * unit;
      ctx.strokeStyle = 'rgba(17, 19, 24, 0.1)';
      ctx.stroke();

      // Tiny accent inner ear dot
      ctx.beginPath();
      ctx.arc(0, -6.5 * unit, 2.6 * unit, 0, Math.PI * 2);
      ctx.fillStyle = this.accent;
      ctx.fill();
      ctx.restore();
    }

    // Soft matte ceramic pebble body
    const bw = 72 * unit;
    const bh = 62 * unit;
    const bodyGrad = ctx.createLinearGradient(0, -bh * 0.55, 0, bh * 0.55);
    bodyGrad.addColorStop(0, '#FFFFFF');
    bodyGrad.addColorStop(0.75, '#F6F7FA');
    bodyGrad.addColorStop(1, '#E7EBF2');

    ctx.beginPath();
    ctx.roundRect(-bw * 0.5, -bh * 0.5, bw, bh, 30 * unit);
    ctx.fillStyle = bodyGrad;
    ctx.fill();
    ctx.lineWidth = 1.5 * unit;
    ctx.strokeStyle = 'rgba(17, 19, 24, 0.1)';
    ctx.stroke();

    // Subtle glossy ceramic top highlight
    ctx.beginPath();
    ctx.ellipse(0, -bh * 0.34, bw * 0.24, bh * 0.08, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.fill();

    // Sleek dark obsidian visor shifting subtly toward gaze target!
    const vx = lx * 4.5 * unit;
    const vy = ly * 3.2 * unit;
    const vw = 50 * unit;
    const vh = 30 * unit;

    ctx.save();
    ctx.translate(vx, vy + 1 * unit);

    ctx.beginPath();
    ctx.roundRect(-vw * 0.5, -vh * 0.5, vw, vh, 15 * unit);
    const visorGrad = ctx.createLinearGradient(0, -vh * 0.5, 0, vh * 0.5);
    visorGrad.addColorStop(0, '#1B2030');
    visorGrad.addColorStop(1, '#0E111A');
    ctx.fillStyle = visorGrad;
    ctx.fill();

    // Subtle glass sheen across visor
    ctx.beginPath();
    ctx.roundRect(-vw * 0.42, -vh * 0.4, vw * 0.84, vh * 0.28, 7 * unit);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.fill();

    // Expressive eyes (tracking slightly faster than visor for parallax depth!)
    const ex = lx * 2.6 * unit;
    const ey = ly * 1.8 * unit;
    const eyeSpread = 11.5 * unit;

    ctx.strokeStyle = this.eyeColor;
    ctx.fillStyle = this.eyeColor;
    ctx.lineCap = 'round';

    if (this.mood === 'happy') {
      // Adorable happy crescent arcs
      ctx.lineWidth = 3.2 * unit;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(side * eyeSpread + ex, ey + 2.5 * unit, 5.2 * unit, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
      }
    } else if (this.mood === 'gasp') {
      // Wide surprised rings
      ctx.lineWidth = 2.6 * unit;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(side * eyeSpread + ex, ey, 5.2 * unit, 0, Math.PI * 2);
        ctx.stroke();
      }
    } else if (this.blinkAmt > 0.25) {
      // Smooth closed blink line
      ctx.lineWidth = 2.8 * unit;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(side * eyeSpread - 4.5 * unit + ex, ey);
        ctx.lineTo(side * eyeSpread + 4.5 * unit + ex, ey);
        ctx.stroke();
      }
    } else {
      // Cute rounded vertical pill eyes with tiny bright catchlights
      for (const side of [-1, 1]) {
        const px = side * eyeSpread + ex;
        ctx.beginPath();
        ctx.roundRect(px - 3.6 * unit, ey - 5.4 * unit, 7.2 * unit, 10.8 * unit, 3.6 * unit);
        ctx.fill();

        ctx.beginPath();
        ctx.arc(px + 1.1 * unit, ey - 2.3 * unit, 1.4 * unit, 0, Math.PI * 2);
        ctx.fillStyle = '#FFFFFF';
        ctx.fill();
        ctx.fillStyle = this.eyeColor;
      }
    }

    // Soft rose blush cheeks beneath visor corners
    ctx.fillStyle = 'rgba(251, 113, 133, 0.38)';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(side * 19.5 * unit, 12.5 * unit, 4.4 * unit, 2.4 * unit, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
    ctx.restore();
    ctx.restore();
  }
}
