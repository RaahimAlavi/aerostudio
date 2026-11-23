// MODE 3: STRIKE TABLE — 1v1 / 2v2 / vs Mochi AI Kinetic Air Hockey (First to 7 Goals)

const WIN_GOALS = 7;

export class StrikeMode {
  constructor(api) {
    this.api = api;
    this.puck = { x: 0, y: 0, vx: 0, vy: 0, r: 22, trail: [] };
    this.mallets = new Map(); // key -> { x, y, vx, vy, r, side, color, label, boost, isAI }
    this.sparks = [];
    this.rings = [];
    this.scoreLeft = 0;
    this.scoreRight = 0;
    this.phase = 'playing'; // 'playing' | 'goal_pause' | 'gameover'
    this.pauseTimer = 0;
    this.lastScorerSide = null;
    this.shake = 0;
    this.table = { x: 60, y: 90, w: 1000, h: 600, goalH: 190 };
    this.rematchCooldown = 0;
  }

  enter() {
    this.scoreLeft = 0;
    this.scoreRight = 0;
    this.phase = 'playing';
    this.sparks = [];
    this.rings = [];
    this.mallets.clear();
    this.shake = 0;
    this.rematchCooldown = 0;
    this.api.setOverlay('');
    this._computeTable();
    this._resetPuck(0);
    this._updateHud();
  }

  exit() {
    this.api.setOverlay('');
  }

  _computeTable() {
    const { width, height } = this.api.getSize();
    const padX = Math.max(16, Math.min(64, width * 0.05));
    const topY = height < 620 ? 72 : 84;
    const botPad = height < 620 ? 44 : 56;
    const w = Math.max(260, width - padX * 2);
    const h = Math.max(220, height - topY - botPad);
    this.table = {
      x: (width - w) * 0.5,
      y: topY,
      w,
      h,
      goalH: Math.min(220, h * 0.38),
    };
  }

  _resetPuck(serveDir = 0) {
    const t = this.table;
    this.puck.x = t.x + t.w * 0.5 + serveDir * 60;
    this.puck.y = t.y + t.h * 0.5;
    this.puck.vx = serveDir * 160;
    this.puck.vy = (Math.random() - 0.5) * 140;
    this.puck.trail = [];
  }

  onAction(player, actionName) {
    if (this.phase === 'gameover') {
      if (actionName === 'btn_a_down' && this.rematchCooldown <= 0) {
        this.api.audio.playConnect(0);
        this.enter();
      }
      return;
    }

    if (actionName === 'btn_a_down') {
      const m = this.mallets.get(player.slot);
      if (m) {
        m.boost = 1.0;
        this.rings.push({ x: m.x, y: m.y, r: m.r, maxR: m.r * 2.4, color: m.color, life: 1 });
        this.api.audio.playWhoosh(1.25);

        // If puck is within smash proximity, launch a crisp kinetic power shot!
        const dx = this.puck.x - m.x;
        const dy = this.puck.y - m.y;
        const dist = Math.hypot(dx, dy) || 1;
        if (dist < m.r + this.puck.r + 48) {
          const boostSpeed = 1280;
          this.puck.vx = (dx / dist) * boostSpeed;
          this.puck.vy = (dy / dist) * boostSpeed;
          this.shake = 10;
          this._spawnSparks(this.puck.x, this.puck.y, m.color, 18, 420);
          this.api.audio.playPuckHit(1.0);
          this.api.sendFeedback(player.slot, { sfx: 'puck', vibrate: [30], pitch: 1.0 });
        }
      }
    }
  }

  onGesture(player, gesture) {
    if (gesture.kind === 'slash') {
      this.onAction(player, 'btn_a_down');
    }
  }

  _spawnSparks(x, y, color, count, maxSpd) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 70 + Math.random() * maxSpd;
      this.sparks.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        size: 2.2 + Math.random() * 3.5,
        color: i % 4 === 0 ? '#111318' : color,
        life: 0.45 + Math.random() * 0.4,
      });
    }
  }

  _scoreGoal(scoringSide) {
    if (scoringSide === 'left') this.scoreLeft++;
    else this.scoreRight++;

    this.lastScorerSide = scoringSide;
    this.shake = 18;
    const gx = scoringSide === 'left' ? this.table.x + this.table.w : this.table.x;
    const gy = this.table.y + this.table.h * 0.5;
    const color = scoringSide === 'left' ? '#2563EB' : '#E11D48';

    this._spawnSparks(gx, gy, color, 40, 560);
    this.rings.push({ x: gx, y: gy, r: 24, maxR: 260, color, life: 1 });
    this.api.audio.playGoal();
    this.api.reactCompanion('pair', color);

    for (const p of this.api.getPlayers()) {
      this.api.sendFeedback(p.slot, { sfx: 'goal', vibrate: [35, 30, 50] });
    }

    if (this.scoreLeft >= WIN_GOALS || this.scoreRight >= WIN_GOALS) {
      this.phase = 'gameover';
      this.rematchCooldown = 0.7;
      const winLabel = this.scoreLeft >= WIN_GOALS ? 'Left Side Wins' : this.mallets.has('ai') ? 'Mochi AI Wins' : 'Right Side Wins';
      this.api.setOverlay(`
        <div class="studio-modal compact">
          <div class="modal-kicker">MATCH COMPLETE</div>
          <h2 class="modal-title">${winLabel}</h2>
          <div class="modal-sub">Final Score <span class="mono">${this.scoreLeft} – ${this.scoreRight}</span></div>
          <div class="modal-actions">
            <button id="strikeRematchBtn" class="studio-btn primary" data-spring="btn" type="button">Rematch (or Press A)</button>
            <button id="strikeHubBtn" class="studio-btn" data-spring="btn" type="button">Back to Studio</button>
          </div>
        </div>
      `);
      document.getElementById('strikeRematchBtn')?.addEventListener('click', () => this.enter());
      document.getElementById('strikeHubBtn')?.addEventListener('click', () => this.api.goHub());
    } else {
      this.phase = 'goal_pause';
      this.pauseTimer = 1.05;
    }

    this._updateHud();
  }

  _updateHud() {
    const players = this.api.getPlayers();
    const vsLabel = players.length <= 1 ? 'VS MOCHI AI' : players.length === 2 ? '1V1 DUEL' : '2V2 CLASH';
    this.api.setHud({
      title: 'STRIKE TABLE',
      stat1Label: 'SCORE',
      stat1Value: `${this.scoreLeft} – ${this.scoreRight}`,
      stat2Label: 'FORMAT',
      stat2Value: vsLabel,
      hint: 'Move phone to control your striker · Press A on impact for Power Smash · First to 7 goals wins',
    });
  }

  update(dt, players) {
    this._computeTable();
    const t = this.table;
    this.shake *= Math.pow(0.0008, dt);

    if (this.phase === 'gameover') {
      this.rematchCooldown = Math.max(0, this.rematchCooldown - dt);
      return;
    }

    if (this.phase === 'goal_pause') {
      this.pauseTimer -= dt;
      if (this.pauseTimer <= 0) {
        this.phase = 'playing';
        this._resetPuck(this.lastScorerSide === 'left' ? 1 : -1);
      }
    }

    const malletR = Math.max(26, Math.min(36, t.h * 0.062));
    this.puck.r = malletR * 0.68;

    // Assign active players to Left (even index) and Right (odd index)
    const activeKeys = new Set();
    players.forEach((p, idx) => {
      const side = idx % 2 === 0 ? 'left' : 'right';
      activeKeys.add(p.slot);

      const minX = side === 'left' ? t.x + malletR + 6 : t.x + t.w * 0.5 + malletR + 4;
      const maxX = side === 'left' ? t.x + t.w * 0.5 - malletR - 4 : t.x + t.w - malletR - 6;
      const minY = t.y + malletR + 6;
      const maxY = t.y + t.h - malletR - 6;

      // Map player's comfortable full-width phone aim cleanly onto their table half!
      const mappedX = side === 'left' ? minX + p.x * (maxX - minX) : minX + p.x * (maxX - minX);
      const mappedY = minY + p.y * (maxY - minY);

      let m = this.mallets.get(p.slot);
      if (!m) {
        m = {
          x: mappedX,
          y: mappedY,
          vx: 0,
          vy: 0,
          r: malletR,
          side,
          color: side === 'left' ? '#2563EB' : '#E11D48',
          label: p.profile.label,
          boost: 0,
          isAI: false,
          slot: p.slot,
        };
        this.mallets.set(p.slot, m);
      }

      const prevX = m.x;
      const prevY = m.y;
      m.x = mappedX;
      m.y = mappedY;
      m.r = malletR;
      m.vx = (m.x - prevX) / Math.max(0.004, dt);
      m.vy = (m.y - prevY) / Math.max(0.004, dt);
      m.boost = Math.max(0, m.boost - dt * 3.5);
    });

    // If only 1 human player, spawn Mochi AI on the Right side!
    if (players.length <= 1) {
      activeKeys.add('ai');
      let ai = this.mallets.get('ai');
      const homeX = t.x + t.w * 0.84;
      const homeY = t.y + t.h * 0.5;
      if (!ai) {
        ai = {
          x: homeX,
          y: homeY,
          vx: 0,
          vy: 0,
          r: malletR,
          side: 'right',
          color: '#E11D48',
          label: 'MOCHI',
          boost: 0,
          isAI: true,
          slot: -1,
        };
        this.mallets.set('ai', ai);
      }

      const puckOnRight = this.puck.x > t.x + t.w * 0.48;
      let targetX = homeX;
      let targetY = homeY;

      if (puckOnRight) {
        // Attack puck while staying behind it so AI doesn't own-goal
        targetX = Math.max(t.x + t.w * 0.53 + malletR, Math.min(t.x + t.w - malletR - 14, this.puck.x + 14));
        targetY = this.puck.y;
      } else {
        // Track defensively near goal line
        targetX = t.x + t.w * 0.87;
        targetY = t.y + t.h * 0.5 + (this.puck.y - (t.y + t.h * 0.5)) * 0.58;
      }

      const prevX = ai.x;
      const prevY = ai.y;
      const maxSpd = 610;
      const dx = targetX - ai.x;
      const dy = targetY - ai.y;
      const dist = Math.hypot(dx, dy) || 1;
      const step = Math.min(dist, maxSpd * dt);
      ai.x += (dx / dist) * step;
      ai.y += (dy / dist) * step;
      ai.r = malletR;
      ai.vx = (ai.x - prevX) / Math.max(0.004, dt);
      ai.vy = (ai.y - prevY) / Math.max(0.004, dt);
    }

    for (const key of [...this.mallets.keys()]) {
      if (!activeKeys.has(key)) this.mallets.delete(key);
    }

    // 4x Sub-stepped crisp puck collision physics (zero tunneling even at blazing smash speeds!)
    if (this.phase === 'playing') {
      const subSteps = 4;
      const subDt = dt / subSteps;
      const goalTop = t.y + (t.h - t.goalH) * 0.5;
      const goalBot = goalTop + t.goalH;

      for (let s = 0; s < subSteps; s++) {
        this.puck.x += this.puck.vx * subDt;
        this.puck.y += this.puck.vy * subDt;

        // Subtle air-cushion friction
        const drag = Math.pow(0.86, subDt);
        this.puck.vx *= drag;
        this.puck.vy *= drag;

        // Top & bottom rails
        if (this.puck.y - this.puck.r < t.y) {
          this.puck.y = t.y + this.puck.r;
          this.puck.vy = Math.abs(this.puck.vy) * 0.94;
          this.api.audio.playPuckHit(Math.min(0.7, Math.abs(this.puck.vy) / 900));
        } else if (this.puck.y + this.puck.r > t.y + t.h) {
          this.puck.y = t.y + t.h - this.puck.r;
          this.puck.vy = -Math.abs(this.puck.vy) * 0.94;
          this.api.audio.playPuckHit(Math.min(0.7, Math.abs(this.puck.vy) / 900));
        }

        const inGoalY = this.puck.y > goalTop + this.puck.r * 0.35 && this.puck.y < goalBot - this.puck.r * 0.35;

        // Left & right walls or Goals!
        if (this.puck.x - this.puck.r < t.x) {
          if (inGoalY) {
            this._scoreGoal('right');
            break;
          } else {
            this.puck.x = t.x + this.puck.r;
            this.puck.vx = Math.abs(this.puck.vx) * 0.94;
            this.api.audio.playPuckHit(0.5);
          }
        } else if (this.puck.x + this.puck.r > t.x + t.w) {
          if (inGoalY) {
            this._scoreGoal('left');
            break;
          } else {
            this.puck.x = t.x + t.w - this.puck.r;
            this.puck.vx = -Math.abs(this.puck.vx) * 0.94;
            this.api.audio.playPuckHit(0.5);
          }
        }

        // Mallet collisions
        for (const m of this.mallets.values()) {
          const dx = this.puck.x - m.x;
          const dy = this.puck.y - m.y;
          const minDist = this.puck.r + m.r;
          const distSq = dx * dx + dy * dy;
          if (distSq < minDist * minDist && distSq > 0.0001) {
            const dist = Math.sqrt(distSq);
            const nx = dx / dist;
            const ny = dy / dist;

            // Push puck outside mallet
            this.puck.x = m.x + nx * (minDist + 1);
            this.puck.y = m.y + ny * (minDist + 1);

            const relVx = this.puck.vx - m.vx;
            const relVy = this.puck.vy - m.vy;
            const vn = relVx * nx + relVy * ny;

            const strikeSpeed = Math.hypot(m.vx, m.vy);
            if (vn < 0) {
              const restitution = 0.92;
              this.puck.vx -= (1 + restitution) * vn * nx;
              this.puck.vy -= (1 + restitution) * vn * ny;
            }
            // Add mallet carry impulse
            const boostMul = m.boost > 0 ? 1.45 : 1.0;
            this.puck.vx += nx * Math.min(720, strikeSpeed * 0.55) * boostMul;
            this.puck.vy += ny * Math.min(720, strikeSpeed * 0.55) * boostMul;

            // Cap max puck speed
            const curSpd = Math.hypot(this.puck.vx, this.puck.vy);
            if (curSpd > 1450) {
              this.puck.vx = (this.puck.vx / curSpd) * 1450;
              this.puck.vy = (this.puck.vy / curSpd) * 1450;
            }

            const power = Math.min(1, curSpd / 1100);
            if (s === 0) {
              this.shake = Math.min(10, power * 8);
              this._spawnSparks(this.puck.x - nx * this.puck.r, this.puck.y - ny * this.puck.r, m.color, Math.round(6 + power * 12), 340 * power);
              this.api.audio.playPuckHit(power);
              if (!m.isAI) {
                this.api.sendFeedback(m.slot, { sfx: 'puck', vibrate: [Math.round(14 + power * 24)], pitch: 0.6 + power * 0.6 });
              }
            }
          }
        }
      }

      // Puck velocity trail
      this.puck.trail.push({ x: this.puck.x, y: this.puck.y, life: 1 });
      if (this.puck.trail.length > 22) this.puck.trail.shift();
    }

    for (const pt of this.puck.trail) pt.life -= dt * 7.5;
    while (this.puck.trail.length && this.puck.trail[0].life <= 0) this.puck.trail.shift();

    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const sp = this.sparks[i];
      sp.x += sp.vx * dt;
      sp.y += sp.vy * dt;
      sp.vx *= Math.pow(0.18, dt);
      sp.vy *= Math.pow(0.18, dt);
      sp.life -= dt;
      if (sp.life <= 0) this.sparks.splice(i, 1);
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.r += (r.maxR - r.r) * Math.min(1, dt * 9);
      r.life -= dt * 2.8;
      if (r.life <= 0) this.rings.splice(i, 1);
    }
  }

  render(ctx, width, height) {
    ctx.save();
    if (this.shake > 0.2) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
    }

    // Minimal studio backdrop
    ctx.fillStyle = '#F3F4F6';
    ctx.fillRect(0, 0, width, height);

    const t = this.table;
    const goalTop = t.y + (t.h - t.goalH) * 0.5;

    // Tactile matte porcelain table deck
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(t.x, t.y, t.w, t.h, 28);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#18181B';
    ctx.stroke();

    // Subtle court markings
    ctx.strokeStyle = 'rgba(17, 19, 24, 0.08)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(t.x + t.w * 0.5, t.y + 4);
    ctx.lineTo(t.x + t.w * 0.5, t.y + t.h - 4);
    ctx.stroke();

    // Center face-off circle
    ctx.beginPath();
    ctx.arc(t.x + t.w * 0.5, t.y + t.h * 0.5, Math.min(92, t.h * 0.16), 0, Math.PI * 2);
    ctx.stroke();

    // Goal semi-circles
    ctx.beginPath();
    ctx.arc(t.x, t.y + t.h * 0.5, t.goalH * 0.55, -Math.PI * 0.5, Math.PI * 0.5);
    ctx.strokeStyle = 'rgba(37, 99, 235, 0.18)';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(t.x + t.w, t.y + t.h * 0.5, t.goalH * 0.55, Math.PI * 0.5, Math.PI * 1.5);
    ctx.strokeStyle = 'rgba(225, 29, 72, 0.18)';
    ctx.stroke();

    // Big crisp watermark scoreboard painted right into the table surface!
    ctx.font = '800 84px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(37, 99, 235, 0.09)';
    ctx.fillText(String(this.scoreLeft), t.x + t.w * 0.25, t.y + t.h * 0.5);
    ctx.fillStyle = 'rgba(225, 29, 72, 0.09)';
    ctx.fillText(String(this.scoreRight), t.x + t.w * 0.75, t.y + t.h * 0.5);

    // Goal pocket cutouts
    ctx.fillStyle = '#2563EB';
    ctx.fillRect(t.x - 4, goalTop, 8, t.goalH);
    ctx.fillStyle = '#E11D48';
    ctx.fillRect(t.x + t.w - 4, goalTop, 8, t.goalH);
    ctx.restore();

    // Shock rings
    for (const r of this.rings) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, r.life * 0.55);
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 3 * r.life;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Puck velocity ribbon
    if (this.puck.trail.length > 2) {
      ctx.save();
      ctx.lineCap = 'round';
      for (let i = 1; i < this.puck.trail.length; i++) {
        const a = this.puck.trail[i - 1];
        const b = this.puck.trail[i];
        const ratio = i / this.puck.trail.length;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = '#18181B';
        ctx.globalAlpha = Math.max(0, b.life * ratio * 0.22);
        ctx.lineWidth = ratio * this.puck.r * 1.4;
        ctx.stroke();
      }
      ctx.restore();
    }

    // Puck (glossy obsidian ceramic disc)
    ctx.save();
    ctx.translate(this.puck.x, this.puck.y);
    ctx.beginPath();
    ctx.arc(0, 5, this.puck.r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.14)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(0, 0, this.puck.r, 0, Math.PI * 2);
    ctx.fillStyle = '#18181B';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#FFFFFF';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, this.puck.r * 0.42, 0, Math.PI * 2);
    ctx.fillStyle = '#F59E0B';
    ctx.fill();
    ctx.restore();

    // Player & Mochi AI Mallets
    for (const m of this.mallets.values()) {
      ctx.save();
      ctx.translate(m.x, m.y);

      ctx.beginPath();
      ctx.arc(0, 6, m.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.14)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(0, 0, m.r, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = m.color;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(0, 0, m.r * 0.46, 0, Math.PI * 2);
      ctx.fillStyle = m.color;
      ctx.fill();

      ctx.font = '800 9px "JetBrains Mono", monospace';
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(m.label, 0, 0.5);
      ctx.restore();
    }

    // Sparks
    for (const s of this.sparks) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, s.life * 1.8);
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  }

  getSyncState() {
    this._computeTable();
    const t = this.table;
    const invW = 1 / Math.max(1, t.w);
    const invH = 1 / Math.max(1, t.h);
    const mallets = [];
    for (const [k, m] of this.mallets.entries()) {
      mallets.push({
        k,
        nx: +((m.x - t.x) * invW).toFixed(4),
        ny: +((m.y - t.y) * invH).toFixed(4),
        side: m.side,
        color: m.color,
        label: m.label,
        boost: +m.boost.toFixed(2),
        isAI: Boolean(m.isAI),
        slot: m.slot,
      });
    }
    return {
      px: +((this.puck.x - t.x) * invW).toFixed(4),
      py: +((this.puck.y - t.y) * invH).toFixed(4),
      pvx: +(this.puck.vx * invW).toFixed(3),
      pvy: +(this.puck.vy * invH).toFixed(3),
      scoreLeft: this.scoreLeft,
      scoreRight: this.scoreRight,
      phase: this.phase,
      lastScorerSide: this.lastScorerSide,
      shake: +this.shake.toFixed(1),
      mallets,
    };
  }

  applySyncState(s) {
    if (!s) return;
    this._computeTable();
    const t = this.table;
    const malletR = Math.max(26, Math.min(36, t.h * 0.062));
    this.puck.r = malletR * 0.68;

    const scored = s.scoreLeft !== this.scoreLeft || s.scoreRight !== this.scoreRight;
    if (scored) {
      const side = s.scoreLeft > this.scoreLeft ? 'left' : 'right';
      const gx = side === 'left' ? t.x + t.w : t.x;
      const gy = t.y + t.h * 0.5;
      const color = side === 'left' ? '#2563EB' : '#E11D48';
      this._spawnSparks(gx, gy, color, 34, 520);
      this.rings.push({ x: gx, y: gy, r: 24, maxR: 240, color, life: 1 });
      this.api.audio.playGoal();
      this.api.reactCompanion('pair', color);
    }

    this.scoreLeft = s.scoreLeft;
    this.scoreRight = s.scoreRight;
    this.lastScorerSide = s.lastScorerSide;
    this.shake = Math.max(this.shake, s.shake || 0);

    const targetX = t.x + s.px * t.w;
    const targetY = t.y + s.py * t.h;
    if (!this._mirrorInit || Math.hypot(targetX - this.puck.x, targetY - this.puck.y) > t.w * 0.35) {
      this.puck.x = targetX;
      this.puck.y = targetY;
      this._mirrorInit = true;
    }
    this._syncPuckX = targetX;
    this._syncPuckY = targetY;
    this.puck.vx = s.pvx * t.w;
    this.puck.vy = s.pvy * t.h;

    // Sync mallets (AI + remote/sim mallets)
    const seen = new Set();
    for (const sm of s.mallets || []) {
      seen.add(sm.k);
      const mx = t.x + sm.nx * t.w;
      const my = t.y + sm.ny * t.h;
      let m = this.mallets.get(sm.k);
      if (!m) {
        m = { x: mx, y: my, vx: 0, vy: 0, r: malletR, side: sm.side, color: sm.color, label: sm.label, boost: sm.boost, isAI: sm.isAI, slot: sm.slot };
        this.mallets.set(sm.k, m);
      } else {
        m.r = malletR;
        m.color = sm.color;
        m.label = sm.label;
        m.boost = sm.boost;
        m.side = sm.side;
        m.isAI = sm.isAI;
        m._syncX = mx;
        m._syncY = my;
      }
    }
    for (const k of [...this.mallets.keys()]) {
      if (!seen.has(k)) this.mallets.delete(k);
    }

    if (s.phase === 'gameover' && this.phase !== 'gameover') {
      const winLabel = this.scoreLeft >= WIN_GOALS ? 'Left Side Wins' : this.mallets.has('ai') ? 'Mochi AI Wins' : 'Right Side Wins';
      this.api.setOverlay(`
        <div class="studio-modal compact">
          <div class="modal-kicker">MATCH COMPLETE</div>
          <h2 class="modal-title">${winLabel}</h2>
          <div class="modal-sub">Final Score <span class="mono">${this.scoreLeft} – ${this.scoreRight}</span> · Host controls rematch</div>
        </div>
      `);
    } else if (s.phase !== 'gameover' && this.phase === 'gameover') {
      this.api.setOverlay('');
    }
    this.phase = s.phase;
    this._updateHud();
  }

  updateMirror(dt, players) {
    this._computeTable();
    const t = this.table;
    const malletR = Math.max(26, Math.min(36, t.h * 0.062));
    this.puck.r = malletR * 0.68;
    this.shake *= Math.pow(0.0008, dt);

    if (this.phase === 'playing') {
      this.puck.x += this.puck.vx * dt;
      this.puck.y += this.puck.vy * dt;
      if (typeof this._syncPuckX === 'number') {
        const snap = 1 - Math.exp(-dt * 28);
        this.puck.x += (this._syncPuckX - this.puck.x) * snap;
        this.puck.y += (this._syncPuckY - this.puck.y) * snap;
      }
      this.puck.trail.push({ x: this.puck.x, y: this.puck.y, life: 1 });
      if (this.puck.trail.length > 22) this.puck.trail.shift();
    }

    // Drive human phone mallets directly at native monitor Hz while smoothly lerping AI/sim mallets!
    const liveBySlot = new Map(players.map((p) => [p.slot, p]));
    for (const m of this.mallets.values()) {
      m.r = malletR;
      const lp = !m.isAI ? liveBySlot.get(m.slot) : null;
      if (lp) {
        const minX = m.side === 'left' ? t.x + malletR + 6 : t.x + t.w * 0.5 + malletR + 4;
        const maxX = m.side === 'left' ? t.x + t.w * 0.5 - malletR - 4 : t.x + t.w - malletR - 6;
        const minY = t.y + malletR + 6;
        const maxY = t.y + t.h - malletR - 6;
        m.x = minX + lp.x * (maxX - minX);
        m.y = minY + lp.y * (maxY - minY);
      } else if (typeof m._syncX === 'number') {
        const a = 1 - Math.exp(-dt * 26);
        m.x += (m._syncX - m.x) * a;
        m.y += (m._syncY - m.y) * a;
      }
    }

    for (const pt of this.puck.trail) pt.life -= dt * 7.5;
    while (this.puck.trail.length && this.puck.trail[0].life <= 0) this.puck.trail.shift();
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const sp = this.sparks[i];
      sp.x += sp.vx * dt;
      sp.y += sp.vy * dt;
      sp.vx *= Math.pow(0.18, dt);
      sp.vy *= Math.pow(0.18, dt);
      sp.life -= dt;
      if (sp.life <= 0) this.sparks.splice(i, 1);
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.r += (r.maxR - r.r) * Math.min(1, dt * 9);
      r.life -= dt * 2.8;
      if (r.life <= 0) this.rings.splice(i, 1);
    }
  }
}
