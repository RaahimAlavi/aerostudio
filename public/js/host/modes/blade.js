// MODE 1: BLADE ARENA — Competitive Survival & High-Score Katana Duel (3 Lives, KO, Podium, High Scores)

const PRISM_PALETTE = [
  { fill: '#2563EB', edge: '#93C5FD', core: '#1E3A8A', sides: 6, pts: 100 },
  { fill: '#059669', edge: '#6EE7B7', core: '#064E3B', sides: 5, pts: 120 },
  { fill: '#D97706', edge: '#FDE68A', core: '#78350F', sides: 8, pts: 140 },
  { fill: '#7C3AED', edge: '#DDD6FE', core: '#4C1D95', sides: 4, pts: 130 },
  { fill: '#EAB308', edge: '#FEF9C3', core: '#854D0E', sides: 7, pts: 300, bonus: true },
];

const HIGHSCORE_KEY = 'aero_blade_highscore_v2';

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 0.0001) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export class BladeMode {
  constructor(api) {
    this.api = api;
    this.targets = [];
    this.halves = [];
    this.sparks = [];
    this.slashLines = [];
    this.popups = [];
    this.trails = new Map();
    this.roster = new Map(); // slot -> { slot, profile, score, lives, alive, combo, bestCombo, comboTimer, slices }
    this.phase = 'playing'; // 'playing' | 'gameover'
    this.spawnTimer = 0.65;
    this.waveCount = 0;
    this.hitstop = 0;
    this.shake = 0;
    this.damageFlash = 0;
    this.highScore = this._loadHighScore();
    this.isNewRecord = false;
    this.rematchCooldown = 0;
  }

  _loadHighScore() {
    try {
      const raw = JSON.parse(localStorage.getItem(HIGHSCORE_KEY) || 'null');
      return raw && typeof raw.score === 'number' ? raw : { score: 0, holder: '---' };
    } catch {
      return { score: 0, holder: '---' };
    }
  }

  _saveHighScore(score, holder) {
    this.highScore = { score, holder };
    try {
      localStorage.setItem(HIGHSCORE_KEY, JSON.stringify(this.highScore));
    } catch (_) {}
  }

  enter() {
    this.targets = [];
    this.halves = [];
    this.sparks = [];
    this.slashLines = [];
    this.popups = [];
    this.trails.clear();
    this.roster.clear();
    this.phase = 'playing';
    this.spawnTimer = 0.5;
    this.waveCount = 0;
    this.hitstop = 0;
    this.shake = 0;
    this.damageFlash = 0;
    this.isNewRecord = false;
    this.rematchCooldown = 0;

    for (const p of this.api.getPlayers()) {
      this._ensureEntry(p);
    }
    this._syncOverlay();
    this._updateHud();
  }

  exit() {
    this.trails.clear();
    this.api.setOverlay('');
  }

  _ensureEntry(p) {
    if (!this.roster.has(p.slot)) {
      this.roster.set(p.slot, {
        slot: p.slot,
        profile: p.profile,
        score: 0,
        lives: 3,
        alive: true,
        combo: 0,
        bestCombo: 0,
        comboTimer: 0,
        slices: 0,
      });
    }
    return this.roster.get(p.slot);
  }

  onAction(player, actionName) {
    if (this.phase === 'gameover') {
      if (actionName === 'btn_a_down' && this.rematchCooldown <= 0) {
        this.api.audio.playConnect(0);
        this.enter();
      }
      return;
    }

    const entry = this._ensureEntry(player);
    if (!entry.alive) return;

    if (actionName === 'btn_a_down') {
      const { width, height } = this.api.getSize();
      const px = player.x * width;
      const py = player.y * height;
      const angle = player.roll || -0.35;
      const len = 175;
      const x1 = px - Math.cos(angle) * len;
      const y1 = py - Math.sin(angle) * len;
      const x2 = px + Math.cos(angle) * len;
      const y2 = py + Math.sin(angle) * len;

      this.slashLines.push({ x1, y1, x2, y2, life: 1, color: player.profile.color, width: 6.5 });
      this.api.audio.playWhoosh(1.55);
      this._checkCutSegment(player, x1, y1, x2, y2, angle, 2.2);
    }
  }

  onGesture(player, gesture) {
    if (this.phase !== 'playing') return;
    const entry = this._ensureEntry(player);
    if (!entry.alive) return;
    if (gesture.kind === 'slash' || gesture.kind === 'shake') {
      this.api.audio.playWhoosh(Math.min(2, gesture.power || 1.2));
    }
  }

  _damagePlayer(entry, reason, fxX, fxY) {
    if (!entry || !entry.alive || this.phase !== 'playing') return;
    entry.lives = Math.max(0, entry.lives - 1);
    entry.combo = 0;
    this.shake = 18;
    this.damageFlash = 0.55;
    this.api.reactCompanion('gasp', '#E11D48');

    if (entry.lives <= 0) {
      entry.alive = false;
      this.api.audio.playEliminated();
      this.api.sendFeedback(entry.slot, { sfx: 'ko', vibrate: [110, 45, 130] });
      this.popups.push({
        x: fxX,
        y: fxY,
        text: `${entry.profile.label} ELIMINATED`,
        color: '#E11D48',
        life: 1.6,
        scale: 1.45,
      });
      this._checkMatchEnd();
    } else {
      this.api.audio.playMine();
      this.api.sendFeedback(entry.slot, { sfx: 'mine', vibrate: [75, 30, 85] });
      this.popups.push({
        x: fxX,
        y: fxY,
        text: `${entry.profile.label} ${reason} (-1 LIFE)`,
        color: '#E11D48',
        life: 1.25,
        scale: 1.2,
      });
    }
    this._updateHud();
  }

  _checkMatchEnd() {
    const entries = [...this.roster.values()];
    if (entries.length === 0) return;

    const alive = entries.filter((e) => e.alive);
    const shouldEnd = entries.length === 1 ? alive.length === 0 : alive.length <= 1;

    if (shouldEnd) {
      this.phase = 'gameover';
      this.rematchCooldown = 0.7;

      const ranked = [...entries].sort((a, b) => {
        if (entries.length > 1 && a.alive !== b.alive) return a.alive ? -1 : 1;
        return b.score - a.score;
      });

      const top = ranked[0];
      if (top && top.score > this.highScore.score) {
        this.isNewRecord = true;
        this._saveHighScore(top.score, top.profile.label);
      }

      this.api.audio.playGoal();
      this.api.reactCompanion('pair', top?.profile.color || '#2563EB');
      this._syncOverlay(ranked);
      this._updateHud();
    }
  }

  _syncOverlay(ranked = null) {
    if (this.phase !== 'gameover' || !ranked) {
      this.api.setOverlay('');
      return;
    }

    const winner = ranked[0];
    const rowsHtml = ranked
      .map(
        (r, i) => `
      <div class="podium-row ${i === 0 ? 'winner' : ''}">
        <div class="podium-rank">#${i + 1}</div>
        <div class="podium-player">
          <span class="podium-dot" style="background:${r.profile.color}"></span>
          <span>${r.profile.label} ${r.profile.name}</span>
          ${r.alive && ranked.length > 1 ? '<span class="podium-tag">SURVIVOR</span>' : !r.alive ? '<span class="podium-tag ko">KO</span>' : ''}
        </div>
        <div class="podium-meta">${r.slices} cuts · ${r.bestCombo}x</div>
        <div class="podium-score">${r.score.toLocaleString()}</div>
      </div>`
      )
      .join('');

    this.api.setOverlay(`
      <div class="studio-modal">
        <div class="modal-kicker">${this.isNewRecord ? 'NEW ALL-TIME RECORD' : 'ROUND COMPLETE'}</div>
        <h2 class="modal-title">${ranked.length > 1 ? `${winner.profile.label} ${winner.profile.name} Wins` : `Final Score ${winner.score.toLocaleString()}`}</h2>
        <div class="modal-sub">All-Time Best: <span class="mono">${this.highScore.score.toLocaleString()}</span> (${this.highScore.holder})</div>
        <div class="podium-list">${rowsHtml}</div>
        <div class="modal-actions">
          <button id="bladeRematchBtn" class="studio-btn primary" data-spring="btn" type="button">Play Again (or Press A)</button>
          <button id="bladeHubBtn" class="studio-btn" data-spring="btn" type="button">Back to Studio</button>
        </div>
      </div>
    `);

    const rematchBtn = document.getElementById('bladeRematchBtn');
    const hubBtn = document.getElementById('bladeHubBtn');
    if (rematchBtn) rematchBtn.addEventListener('click', () => this.enter());
    if (hubBtn) hubBtn.addEventListener('click', () => this.api.goHub());
  }

  _spawnWave() {
    const { width, height } = this.api.getSize();
    this.waveCount++;

    const aliveEntries = [...this.roster.values()].filter((e) => e.alive);
    const isMulti = this.roster.size > 1;
    const difficulty = Math.min(1, this.waveCount / 18);
    const count = Math.min(5, 1 + Math.floor(Math.random() * 2) + (this.waveCount % 3 === 0 ? 2 : 1));

    for (let i = 0; i < count; i++) {
      const isMine = this.waveCount > 1 && Math.random() < 0.16 + difficulty * 0.11;

      // In multiplayer, periodically spawn a player-owned target prism that costs them a life if missed!
      let ownerSlot = null;
      let style = PRISM_PALETTE[Math.random() < 0.13 ? 4 : Math.floor(Math.random() * 4)];
      if (!isMine && isMulti && aliveEntries.length > 0 && i === 0 && this.waveCount % 2 === 0) {
        const chosen = aliveEntries[Math.floor(Math.random() * aliveEntries.length)];
        ownerSlot = chosen.slot;
        style = {
          fill: chosen.profile.color,
          edge: chosen.profile.soft,
          core: '#111318',
          sides: 6,
          pts: 180,
          ownerLabel: chosen.profile.label,
        };
      }

      const margin = width * 0.16;
      const x = margin + Math.random() * (width - margin * 2);
      const y = height + 42 + i * 26;
      const targetCenter = width * (0.28 + Math.random() * 0.44);
      const vx = (targetCenter - x) * (0.45 + Math.random() * 0.35);
      const vy = -(height * (0.98 + Math.random() * 0.22));

      this.targets.push({
        id: Math.random(),
        x,
        y,
        vx,
        vy,
        r: isMine ? 32 : style.bonus ? 34 : 36 + Math.random() * 10,
        rot: Math.random() * Math.PI * 2,
        vRot: (Math.random() - 0.5) * 4.2,
        isMine,
        ownerSlot,
        style,
        pulse: Math.random() * Math.PI * 2,
      });
    }
  }

  _checkCutSegment(player, x1, y1, x2, y2, cutAngle, speedFactor = 1) {
    const entry = this._ensureEntry(player);
    if (!entry.alive) return;

    let hitThisStroke = 0;

    for (let i = this.targets.length - 1; i >= 0; i--) {
      const t = this.targets[i];
      const d = distToSegment(t.x, t.y, x1, y1, x2, y2);
      if (d <= t.r + 14) {
        this.targets.splice(i, 1);

        if (t.isMine) {
          this.hitstop = 0.055;
          this._spawnSparks(t.x, t.y, '#E11D48', 36, 520);
          this._damagePlayer(entry, 'MINE HIT', t.x, t.y);
          continue;
        }

        hitThisStroke++;
        entry.slices++;
        entry.combo++;
        entry.comboTimer = 1.75;
        if (entry.combo > entry.bestCombo) entry.bestCombo = entry.combo;

        const mult = Math.min(8, 1 + Math.floor(entry.combo / 3));
        const earned = t.style.pts * mult;
        entry.score += earned;

        if (entry.combo === 5 || t.style.bonus) {
          this.api.reactCompanion('happy', player.profile.color);
        }

        this.hitstop = t.style.bonus || entry.combo >= 4 ? 0.036 : 0.015;
        this.shake = Math.min(12, 4 + entry.combo * 0.8);

        const nx = -Math.sin(cutAngle);
        const ny = Math.cos(cutAngle);
        const sep = 170 + speedFactor * 42;
        for (const side of [-1, 1]) {
          this.halves.push({
            x: t.x + nx * side * 8,
            y: t.y + ny * side * 8,
            vx: t.vx * 0.62 + nx * side * sep,
            vy: t.vy * 0.62 + ny * side * sep - 55,
            r: t.r,
            rot: t.rot,
            cutAngle,
            side,
            vRot: side * (3.2 + Math.random() * 3.2),
            style: t.style,
            life: 1.0,
          });
        }

        const flashLen = t.r * 3.0;
        this.slashLines.push({
          x1: t.x - Math.cos(cutAngle) * flashLen,
          y1: t.y - Math.sin(cutAngle) * flashLen,
          x2: t.x + Math.cos(cutAngle) * flashLen,
          y2: t.y + Math.sin(cutAngle) * flashLen,
          life: 1,
          color: player.profile.color,
          width: 4.5,
        });

        this._spawnSparks(t.x, t.y, t.style.fill, t.style.bonus ? 30 : 18, 420);
        this.popups.push({
          x: t.x,
          y: t.y - 14,
          text: mult > 1 ? `+${earned}  ×${mult}` : `+${earned}`,
          color: t.style.bonus ? '#B45309' : player.profile.color,
          life: 1.0,
          scale: t.style.bonus ? 1.3 : 1.0 + Math.min(0.35, entry.combo * 0.05),
        });

        this.api.audio.playSlice(entry.combo);
        this.api.sendFeedback(player.slot, {
          sfx: 'slice',
          vibrate: t.style.bonus ? [25, 22, 36] : [20],
          pitch: Math.min(2.2, 0.8 + entry.combo * 0.14),
        });
        this._updateHud();
      }
    }

    if (hitThisStroke >= 2) {
      this.popups.push({
        x: (x1 + x2) * 0.5,
        y: (y1 + y2) * 0.5 - 44,
        text: `${hitThisStroke}× MULTI-SLICE`,
        color: '#111318',
        life: 1.25,
        scale: 1.35,
      });
    }
  }

  _spawnSparks(x, y, color, count, speedMax) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 85 + Math.random() * speedMax;
      this.sparks.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        size: 2.2 + Math.random() * 3.8,
        color: i % 5 === 0 ? '#111318' : color,
        life: 0.5 + Math.random() * 0.45,
        maxLife: 0.95,
      });
    }
  }

  _updateHud() {
    const entries = [...this.roster.values()].sort((a, b) => b.score - a.score);
    const leader = entries[0];
    this.api.setHud({
      title: 'BLADE ARENA',
      stat1Label: leader ? `${leader.profile.label} LEAD` : 'SCORE',
      stat1Value: leader ? leader.score.toLocaleString() : '0',
      stat2Label: 'RECORD',
      stat2Value: this.highScore.score.toLocaleString(),
      hint: 'Whip to slice prisms · Avoid red spike mines · Don’t let targets fall · Hold B for Slow-Mo',
    });
  }

  update(rawDt, players) {
    const { width, height } = this.api.getSize();

    for (const p of players) this._ensureEntry(p);

    if (this.phase === 'gameover') {
      this.rematchCooldown = Math.max(0, this.rematchCooldown - rawDt);
      return;
    }

    const slowMo = players.some((p) => p.b && this.roster.get(p.slot)?.alive);
    if (this.hitstop > 0) {
      this.hitstop -= rawDt;
      return;
    }

    const dt = rawDt * (slowMo ? 0.38 : 1.0);
    const gravity = height * 0.94;

    this.shake *= Math.pow(0.001, rawDt);
    this.damageFlash = Math.max(0, this.damageFlash - rawDt * 1.9);

    for (const entry of this.roster.values()) {
      if (entry.comboTimer > 0) {
        entry.comboTimer -= rawDt;
        if (entry.comboTimer <= 0) entry.combo = 0;
      }
    }

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this._spawnWave();
      const pace = Math.max(0.85, 1.55 - this.waveCount * 0.025);
      this.spawnTimer = pace + Math.random() * 0.65;
    }

    const activeSlots = new Set();
    for (const p of players) {
      const entry = this._ensureEntry(p);
      if (!entry.alive) continue;
      activeSlots.add(p.slot);
      const px = p.x * width;
      const py = p.y * height;

      let trail = this.trails.get(p.slot);
      if (!trail) {
        trail = [];
        this.trails.set(p.slot, trail);
      }

      const prev = trail.length > 0 ? trail[trail.length - 1] : null;
      if (!prev || Math.hypot(px - prev.x, py - prev.y) > 2.0) {
        trail.push({ x: px, y: py, life: 1.0 });
        if (trail.length > 36) trail.shift();
      }

      if (prev) {
        const dx = px - prev.x;
        const dy = py - prev.y;
        const dist = Math.hypot(dx, dy);
        const speedPxPerSec = dist / Math.max(0.004, rawDt);
        if (speedPxPerSec > 380 || p.swingPower > 0.85) {
          const cutAngle = Math.atan2(dy, dx);
          this._checkCutSegment(p, prev.x, prev.y, px, py, cutAngle, speedPxPerSec / 900);
        }
      }
    }

    for (const [slot, trail] of this.trails.entries()) {
      for (const pt of trail) pt.life -= rawDt * 5.8;
      while (trail.length && trail[0].life <= 0) trail.shift();
      if (!activeSlots.has(slot) && trail.length === 0) this.trails.delete(slot);
    }

    // Update airborne prisms & check missed drops!
    for (let i = this.targets.length - 1; i >= 0; i--) {
      const t = this.targets[i];
      t.x += t.vx * dt;
      t.y += t.vy * dt;
      t.vy += gravity * dt;
      t.rot += t.vRot * dt;
      t.pulse += dt * 7;

      if (t.x < t.r && t.vx < 0) t.vx = -t.vx * 0.7;
      if (t.x > width - t.r && t.vx > 0) t.vx = -t.vx * 0.7;

      if (t.y > height + 90 && t.vy > 0) {
        this.targets.splice(i, 1);
        if (!t.isMine && !t.style.bonus) {
          if (this.roster.size === 1) {
            const solo = this.roster.values().next().value;
            this._damagePlayer(solo, 'MISSED', Math.max(120, Math.min(width - 120, t.x)), height - 90);
          } else if (t.ownerSlot !== null) {
            const owner = this.roster.get(t.ownerSlot);
            this._damagePlayer(owner, 'MISSED TARGET', Math.max(120, Math.min(width - 120, t.x)), height - 90);
          }
        }
      }
    }

    for (let i = this.halves.length - 1; i >= 0; i--) {
      const h = this.halves[i];
      h.x += h.vx * dt;
      h.y += h.vy * dt;
      h.vy += gravity * 1.05 * dt;
      h.rot += h.vRot * dt;
      h.life -= dt * 0.9;
      if (h.life <= 0 || h.y > height + 130) this.halves.splice(i, 1);
    }

    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy += gravity * 0.45 * dt;
      s.vx *= Math.pow(0.25, dt);
      s.life -= rawDt;
      if (s.life <= 0) this.sparks.splice(i, 1);
    }

    for (let i = this.slashLines.length - 1; i >= 0; i--) {
      this.slashLines[i].life -= rawDt * 4.8;
      if (this.slashLines[i].life <= 0) this.slashLines.splice(i, 1);
    }

    for (let i = this.popups.length - 1; i >= 0; i--) {
      const pop = this.popups[i];
      pop.y -= 52 * rawDt;
      pop.life -= rawDt * 1.1;
      if (pop.life <= 0) this.popups.splice(i, 1);
    }
  }

  _drawPolygon(ctx, sides, r) {
    ctx.beginPath();
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  _drawLifeGem(ctx, x, y, filled, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.moveTo(0, -6.5);
    ctx.lineTo(5.5, 0);
    ctx.lineTo(0, 6.5);
    ctx.lineTo(-5.5, 0);
    ctx.closePath();
    if (filled) {
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(17, 19, 24, 0.1)';
      ctx.fill();
    }
    ctx.restore();
  }

  render(ctx, width, height, players) {
    ctx.save();
    if (this.shake > 0.3) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
    }

    // Minimal warm ceramic studio dojo background
    ctx.fillStyle = '#F3F4F6';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(17, 19, 24, 0.045)';
    ctx.lineWidth = 1;
    const step = 64;
    for (let x = (width % step) * 0.5; x < width; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = (height % step) * 0.5; y < height; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // Slow-mo subtle cool edge tint
    if (players.some((p) => p.b && this.roster.get(p.slot)?.alive)) {
      const grad = ctx.createRadialGradient(width / 2, height / 2, height * 0.25, width / 2, height / 2, width * 0.72);
      grad.addColorStop(0, 'rgba(37, 99, 235, 0)');
      grad.addColorStop(1, 'rgba(37, 99, 235, 0.12)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);
    }

    // Split prism halves
    for (const h of this.halves) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, h.life);
      ctx.translate(h.x, h.y);
      ctx.rotate(h.cutAngle);
      ctx.beginPath();
      if (h.side > 0) ctx.rect(-h.r * 2, 0, h.r * 4, h.r * 2);
      else ctx.rect(-h.r * 2, -h.r * 2, h.r * 4, h.r * 2);
      ctx.clip();

      ctx.rotate(h.rot - h.cutAngle);
      this._drawPolygon(ctx, h.style.sides, h.r);
      ctx.fillStyle = h.style.fill;
      ctx.fill();
      ctx.strokeStyle = h.style.core;
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.rotate(-(h.rot - h.cutAngle));
      ctx.beginPath();
      ctx.moveTo(-h.r, 0);
      ctx.lineTo(h.r, 0);
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
    }

    // Airborne targets
    for (const t of this.targets) {
      ctx.save();
      ctx.translate(t.x, t.y);

      if (t.isMine) {
        const pulseR = t.r + Math.sin(t.pulse) * 3.5;
        ctx.beginPath();
        ctx.arc(0, 0, pulseR, 0, Math.PI * 2);
        ctx.fillStyle = '#18181B';
        ctx.fill();
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = '#E11D48';
        ctx.stroke();

        ctx.rotate(t.rot);
        for (let k = 0; k < 8; k++) {
          ctx.rotate(Math.PI / 4);
          ctx.beginPath();
          ctx.moveTo(pulseR - 2, -4);
          ctx.lineTo(pulseR + 10, 0);
          ctx.lineTo(pulseR - 2, 4);
          ctx.closePath();
          ctx.fillStyle = '#E11D48';
          ctx.fill();
        }
        ctx.beginPath();
        ctx.moveTo(-8, -8);
        ctx.lineTo(8, 8);
        ctx.moveTo(8, -8);
        ctx.lineTo(-8, 8);
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2.6;
        ctx.stroke();
      } else {
        // Soft drop shadow
        ctx.save();
        ctx.translate(0, 8);
        ctx.rotate(t.rot);
        this._drawPolygon(ctx, t.style.sides, t.r);
        ctx.fillStyle = 'rgba(15, 23, 42, 0.1)';
        ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.rotate(t.rot);
        this._drawPolygon(ctx, t.style.sides, t.r);
        const grad = ctx.createLinearGradient(-t.r, -t.r, t.r, t.r);
        grad.addColorStop(0, t.style.edge);
        grad.addColorStop(0.5, t.style.fill);
        grad.addColorStop(1, t.style.core);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#FFFFFF';
        ctx.stroke();

        this._drawPolygon(ctx, t.style.sides, t.r * 0.45);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
        ctx.fill();
        ctx.restore();

        if (t.style.ownerLabel) {
          ctx.font = '800 12px "JetBrains Mono", monospace';
          ctx.fillStyle = '#FFFFFF';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(t.style.ownerLabel, 0, 1);
        }
      }
      ctx.restore();
    }

    // Slash streaks
    for (const s of this.slashLines) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, s.life);
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width * s.life;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = Math.max(1.2, s.width * 0.4 * s.life);
      ctx.stroke();
      ctx.restore();
    }

    // Crisp fast katana ribbons
    for (const p of players) {
      const trail = this.trails.get(p.slot);
      if (!trail || trail.length < 2) continue;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let i = 1; i < trail.length; i++) {
        const a = trail[i - 1];
        const b = trail[i];
        const ratio = i / trail.length;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = p.profile.color;
        ctx.globalAlpha = Math.max(0, b.life * ratio * 0.26);
        ctx.lineWidth = 6 + ratio * 20;
        ctx.stroke();
        ctx.globalAlpha = Math.max(0, b.life * ratio * 0.9);
        ctx.lineWidth = 2 + ratio * 9;
        ctx.stroke();
        ctx.strokeStyle = '#FFFFFF';
        ctx.globalAlpha = Math.max(0, b.life * ratio * 0.92);
        ctx.lineWidth = Math.max(1, ratio * 3.5);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Sparks
    for (const s of this.sparks) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, s.life / s.maxLife);
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Score popups
    for (const pop of this.popups) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, pop.life * 1.4);
      ctx.font = `800 ${Math.round(20 * pop.scale)}px "Plus Jakarta Sans", sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = pop.color;
      ctx.fillText(pop.text, pop.x, pop.y);
      ctx.restore();
    }

    // Per-Player Live Survival Scoreboard Cards (Top-Left cleanly below header)
    const entries = [...this.roster.values()].sort((a, b) => a.slot - b.slot);
    entries.forEach((e, idx) => {
      const bx = 24 + idx * 174;
      const by = 78;
      ctx.save();
      ctx.globalAlpha = e.alive ? 1 : 0.48;
      ctx.beginPath();
      ctx.roundRect(bx, by, 162, 54, 14);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.fill();
      ctx.strokeStyle = e.alive ? 'rgba(17, 19, 24, 0.09)' : 'rgba(225, 29, 72, 0.3)';
      ctx.lineWidth = 1.2;
      ctx.stroke();

      // Player color bar
      ctx.fillStyle = e.profile.color;
      ctx.beginPath();
      ctx.roundRect(bx + 10, by + 11, 4, 32, 2);
      ctx.fill();

      // Label + Score
      ctx.font = '700 11px "JetBrains Mono", monospace';
      ctx.fillStyle = '#5C6474';
      ctx.fillText(e.alive ? e.profile.label : `${e.profile.label} KO`, bx + 22, by + 22);

      ctx.font = '800 16px "JetBrains Mono", monospace';
      ctx.fillStyle = '#111318';
      ctx.fillText(e.score.toLocaleString(), bx + 22, by + 42);

      // 3 Faceted Ruby Life Gems (zero emojis!)
      for (let g = 0; g < 3; g++) {
        this._drawLifeGem(ctx, bx + 118 + g * 15, by + 18, g < e.lives, '#E11D48');
      }
      ctx.restore();
    });

    if (this.damageFlash > 0.01) {
      ctx.fillStyle = `rgba(225, 29, 72, ${this.damageFlash * 0.24})`;
      ctx.fillRect(0, 0, width, height);
    }

    ctx.restore();
  }

  getSyncState() {
    const { width, height } = this.api.getSize();
    const invW = 1 / Math.max(1, width);
    const invH = 1 / Math.max(1, height);
    return {
      phase: this.phase,
      highScore: this.highScore,
      isNewRecord: this.isNewRecord,
      shake: +this.shake.toFixed(1),
      damageFlash: +this.damageFlash.toFixed(2),
      roster: [...this.roster.values()],
      targets: this.targets.map((t) => ({
        id: t.id,
        nx: +(t.x * invW).toFixed(4),
        ny: +(t.y * invH).toFixed(4),
        nvx: +(t.vx * invW).toFixed(3),
        nvy: +(t.vy * invH).toFixed(3),
        nr: +(t.r * invH).toFixed(4),
        rot: +t.rot.toFixed(2),
        vRot: +t.vRot.toFixed(2),
        isMine: t.isMine,
        ownerSlot: t.ownerSlot,
        style: t.style,
      })),
      halves: this.halves.slice(-18).map((h) => ({
        nx: +(h.x * invW).toFixed(4),
        ny: +(h.y * invH).toFixed(4),
        nvx: +(h.vx * invW).toFixed(3),
        nvy: +(h.vy * invH).toFixed(3),
        nr: +(h.r * invH).toFixed(4),
        rot: +h.rot.toFixed(2),
        vRot: +h.vRot.toFixed(2),
        life: +h.life.toFixed(2),
        side: h.side,
        style: h.style,
      })),
      slashes: this.slashLines.slice(-8).map((l) => ({
        x1: +(l.x1 * invW).toFixed(4),
        y1: +(l.y1 * invH).toFixed(4),
        x2: +(l.x2 * invW).toFixed(4),
        y2: +(l.y2 * invH).toFixed(4),
        life: +l.life.toFixed(2),
        color: l.color,
        width: l.width,
      })),
      popups: this.popups.slice(-10).map((p) => ({
        nx: +(p.x * invW).toFixed(4),
        ny: +(p.y * invH).toFixed(4),
        text: p.text,
        color: p.color,
        life: +p.life.toFixed(2),
        scale: p.scale,
      })),
    };
  }

  applySyncState(s) {
    if (!s) return;
    const { width, height } = this.api.getSize();
    const prevHalves = this.halves.length;

    this.highScore = s.highScore || this.highScore;
    this.isNewRecord = Boolean(s.isNewRecord);
    this.shake = Math.max(this.shake, s.shake || 0);
    this.damageFlash = Math.max(this.damageFlash, s.damageFlash || 0);

    this.roster.clear();
    for (const r of s.roster || []) {
      this.roster.set(r.slot, r);
    }

    this.targets = (s.targets || []).map((t) => ({
      id: t.id,
      x: t.nx * width,
      y: t.ny * height,
      vx: t.nvx * width,
      vy: t.nvy * height,
      r: Math.max(18, t.nr * height),
      rot: t.rot,
      vRot: t.vRot,
      isMine: t.isMine,
      ownerSlot: t.ownerSlot,
      style: t.style,
      pulse: performance.now() * 0.007,
    }));

    this.halves = (s.halves || []).map((h) => ({
      x: h.nx * width,
      y: h.ny * height,
      vx: h.nvx * width,
      vy: h.nvy * height,
      r: Math.max(16, h.nr * height),
      rot: h.rot,
      vRot: h.vRot,
      life: h.life,
      side: h.side,
      style: h.style,
    }));

    if (this.halves.length > prevHalves) {
      this.api.audio.playSlice(1.1);
    }

    this.slashLines = (s.slashes || []).map((l) => ({
      x1: l.x1 * width,
      y1: l.y1 * height,
      x2: l.x2 * width,
      y2: l.y2 * height,
      life: l.life,
      color: l.color,
      width: l.width,
    }));

    this.popups = (s.popups || []).map((p) => ({
      x: p.nx * width,
      y: p.ny * height,
      text: p.text,
      color: p.color,
      life: p.life,
      scale: p.scale,
    }));

    if (s.phase === 'gameover' && this.phase !== 'gameover') {
      const entries = [...this.roster.values()];
      const ranked = [...entries].sort((a, b) => {
        if (entries.length > 1 && a.alive !== b.alive) return a.alive ? -1 : 1;
        return b.score - a.score;
      });
      this.phase = 'gameover';
      this._syncOverlay(ranked);
    } else if (s.phase !== 'gameover' && this.phase === 'gameover') {
      this.phase = s.phase;
      this.api.setOverlay('');
    } else {
      this.phase = s.phase;
    }

    this._updateHud();
  }

  updateMirror(dt, players) {
    const { width, height } = this.api.getSize();
    const gravity = height * 1.16;
    this.shake *= Math.pow(0.0008, dt);
    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.8);

    // Live local katana trails from 60-180Hz player streams
    const activeSlots = new Set();
    for (const p of players) {
      const entry = this.roster.get(p.slot);
      if (entry && !entry.alive) continue;
      activeSlots.add(p.slot);
      const px = p.x * width;
      const py = p.y * height;
      let trail = this.trails.get(p.slot);
      if (!trail) {
        trail = [];
        this.trails.set(p.slot, trail);
      }
      const prev = trail[trail.length - 1];
      if (!prev || Math.hypot(px - prev.x, py - prev.y) > 2.0) {
        trail.push({ x: px, y: py, life: 1.0 });
        if (trail.length > 34) trail.shift();
      }
    }
    for (const [slot, trail] of this.trails.entries()) {
      for (const pt of trail) pt.life -= dt * 5.8;
      while (trail.length && trail[0].life <= 0) trail.shift();
      if (!activeSlots.has(slot) && trail.length === 0) this.trails.delete(slot);
    }

    for (const t of this.targets) {
      t.x += t.vx * dt;
      t.y += t.vy * dt;
      t.vy += gravity * dt;
      t.rot += t.vRot * dt;
      t.pulse += dt * 7;
    }
    for (let i = this.halves.length - 1; i >= 0; i--) {
      const h = this.halves[i];
      h.x += h.vx * dt;
      h.y += h.vy * dt;
      h.vy += gravity * 1.05 * dt;
      h.rot += h.vRot * dt;
      h.life -= dt * 0.9;
      if (h.life <= 0) this.halves.splice(i, 1);
    }
    for (let i = this.slashLines.length - 1; i >= 0; i--) {
      this.slashLines[i].life -= dt * 4.8;
      if (this.slashLines[i].life <= 0) this.slashLines.splice(i, 1);
    }
    for (let i = this.popups.length - 1; i >= 0; i--) {
      this.popups[i].y -= 52 * dt;
      this.popups[i].life -= dt * 1.1;
      if (this.popups[i].life <= 0) this.popups.splice(i, 1);
    }
  }
}
