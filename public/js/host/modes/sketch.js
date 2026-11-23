// MODE 4: AIR SKETCH — Secret-Prompt Party Draw & Guess
// Pro-grade Hi-Res (1600x1000) Dual-Layer Raster Engine:
// - Unified Quadratic Bezier Pen (razor smooth, zero kinks)
// - True Variable-Width Tapered Calligraphic Brush Ribbon (zero overlap dots!)
// - Fast Scanline Flood-Fill Color Bucket with anti-aliased edge sealing
// - Smooth Eraser, 4 visual stroke sizes, 24-step Undo, Phosphor Pro Icons.

import { SCULPT_PALETTE } from '../../shared/protocol.js';
import { bindSpringButtons } from '../../shared/spring.js';

const WORD_BANK = [
  'ROCKET', 'OCTOPUS', 'PENGUIN', 'PIZZA', 'GUITAR', 'FLAMINGO',
  'CASTLE', 'CACTUS', 'CROWN', 'VOLCANO', 'DONUT', 'ROBOT',
  'SUBMARINE', 'BUTTERFLY', 'SKATEBOARD', 'HEADPHONES', 'LIGHTHOUSE', 'DINOSAUR',
  'UMBRELLA', 'ASTRONAUT', 'TORNADO', 'BANANA', 'BICYCLE', 'DRAGON',
  'SNOWMAN', 'HAMBURGER', 'TELESCOPE', 'ANCHOR', 'BALLOON', 'SUNGLASSES',
  'WATERMELON', 'CAMPFIRE', 'HELICOPTER', 'MUSHROOM', 'DIAMOND', 'SAILBOAT',
  'CAMERA', 'TROPHY', 'JELLYFISH', 'PYRAMID', 'SPACESHIP', 'CUPCAKE',
];

const STROKE_SIZES = [
  { id: 'sm', px: 5, dot: 5, label: 'Fine stroke' },
  { id: 'md', px: 12, dot: 8, label: 'Medium stroke' },
  { id: 'lg', px: 24, dot: 12, label: 'Bold stroke' },
  { id: 'xl', px: 42, dot: 16, label: 'Heavy stroke' },
];

const ROUND_SECONDS = 65;
const PAINT_W = 1600;
const PAINT_H = 1000;

function phIcon(name) {
  return `<span class="ph-icon" style="-webkit-mask-image:url('/vendor/icons/${name}-bold.svg');mask-image:url('/vendor/icons/${name}-bold.svg')"></span>`;
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const n = parseInt(clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Smooth interior points slightly so hand tremor becomes clean pro curves */
function smoothStrokePoints(rawPts) {
  if (rawPts.length <= 2) return rawPts;
  const out = [rawPts[0]];
  for (let i = 1; i < rawPts.length - 1; i++) {
    const a = rawPts[i - 1];
    const b = rawPts[i];
    const c = rawPts[i + 1];
    out.push({
      x: a.x * 0.22 + b.x * 0.56 + c.x * 0.22,
      y: a.y * 0.22 + b.y * 0.56 + c.y * 0.22,
      r: a.r * 0.25 + b.r * 0.5 + c.r * 0.25,
    });
  }
  out.push(rawPts[rawPts.length - 1]);
  return out;
}

/** Subdivide quadratic spline into dense evenly curved samples for buttery variable-width ribbons */
function sampleSmoothSpline(pts) {
  if (pts.length <= 1) return pts;
  if (pts.length === 2) {
    const res = [];
    const steps = 6;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      res.push({
        x: pts[0].x + (pts[1].x - pts[0].x) * t,
        y: pts[0].y + (pts[1].y - pts[0].y) * t,
        r: pts[0].r + (pts[1].r - pts[0].r) * t,
      });
    }
    return res;
  }

  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = i === 0 ? pts[0] : { x: (pts[i - 1].x + pts[i].x) * 0.5, y: (pts[i - 1].y + pts[i].y) * 0.5, r: (pts[i - 1].r + pts[i].r) * 0.5 };
    const p1 = pts[i];
    const p2 = i === pts.length - 2 ? pts[pts.length - 1] : { x: (pts[i].x + pts[i + 1].x) * 0.5, y: (pts[i].y + pts[i + 1].y) * 0.5, r: (pts[i].r + pts[i + 1].r) * 0.5 };

    const segLen = Math.hypot(p2.x - p0.x, p2.y - p0.y);
    const steps = Math.max(2, Math.min(10, Math.ceil(segLen / 7)));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const omt = 1 - t;
      out.push({
        x: omt * omt * p0.x + 2 * omt * t * p1.x + t * t * p2.x,
        y: omt * omt * p0.y + 2 * omt * t * p1.y + t * t * p2.y,
        r: omt * omt * p0.r + 2 * omt * t * p1.r + t * t * p2.r,
      });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

export class SketchMode {
  constructor(api) {
    this.api = api;

    // Layer 1: Committed Hi-Res Raster Canvas (1600x1000)
    this.paintCanvas = document.createElement('canvas');
    this.paintCanvas.width = PAINT_W;
    this.paintCanvas.height = PAINT_H;
    this.paintCtx = this.paintCanvas.getContext('2d', { willReadFrequently: true });

    // Layer 2: Live Active Stroke Canvas (renders active stroke cleanly as ONE unified path -> zero overlap beads!)
    this.liveCanvas = document.createElement('canvas');
    this.liveCanvas.width = PAINT_W;
    this.liveCanvas.height = PAINT_H;
    this.liveCtx = this.liveCanvas.getContext('2d');

    this.history = [];
    this.opLog = [];
    this._lastSentOpCount = -1;
    this._mirrorRound = -1;
    this._mirrorOpCount = 0;
    this._mirrorWordLen = 0;
    this.activeStroke = null; // { tool, color, width, points: [{x,y,r}], lastTimeMs, smoothR }

    this.artistIndex = 0;
    this.artistSlot = null;
    this.secretWord = '';
    this.revealed = false;
    this.timeLeft = ROUND_SECONDS;
    this.roundNum = 0;
    this.scores = new Map();
    this.guesses = [];
    this.usedWords = new Set();

    this.color = '#18181B';
    this.tool = 'pen'; // 'pen' | 'brush' | 'fill' | 'erase'
    this.sizeId = 'md';
    this.brushWidth = 12;
    this.phase = 'drawing';
    this.revealTimer = 0;
    this.board = { x: 40, y: 80, w: 920, h: 520, feedX: 978, feedW: 246 };
  }

  enter() {
    this.scores.clear();
    this.usedWords.clear();
    this.roundNum = 0;
    this.artistIndex = 0;
    this.color = '#18181B';
    this.tool = 'pen';
    this.sizeId = 'md';
    this.brushWidth = 12;
    this.opLog = [];
    this._lastSentOpCount = -1;
    this._mirrorRound = -1;
    this._mirrorOpCount = 0;
    this._computeBoard();
    if (this.api.isPrimary()) {
      this._startNextRound();
    } else {
      this._clearBoard(false);
      this.api.setDock('');
      this._updateHud();
    }
  }

  exit() {
    this.activeStroke = null;
    this.liveCtx.clearRect(0, 0, PAINT_W, PAINT_H);
    this.api.setDock('');
    this.api.setOverlay('');
    this.api.broadcastToControllers({ type: 'to_controller', kind: 'sketch_role', role: 'none' });
  }

  _clearBoard(saveUndo = false) {
    if (saveUndo) {
      this._pushHistory();
      this.opLog.push({ op: 'clear' });
    }
    this.activeStroke = null;
    this.liveCtx.clearRect(0, 0, PAINT_W, PAINT_H);
    this.paintCtx.save();
    this.paintCtx.fillStyle = '#FFFFFF';
    this.paintCtx.fillRect(0, 0, PAINT_W, PAINT_H);
    this.paintCtx.restore();
  }

  _pushHistory() {
    const snap = this.paintCtx.getImageData(0, 0, PAINT_W, PAINT_H);
    this.history.push(snap);
    if (this.history.length > 22) this.history.shift();
  }

  _undo() {
    const prev = this.history.pop();
    if (!prev) return false;
    this.activeStroke = null;
    this.liveCtx.clearRect(0, 0, PAINT_W, PAINT_H);
    this.paintCtx.putImageData(prev, 0, 0);
    this.opLog.push({ op: 'undo' });
    this.api.audio.playErase();
    return true;
  }

  /** Renders one complete stroke cleanly (zero overlapping alpha dots, razor-smooth curves!) */
  _renderUnifiedStroke(ctx, stroke) {
    const pts = smoothStrokePoints(stroke.points);
    if (pts.length === 0) return;

    ctx.save();

    if (stroke.tool === 'brush') {
      // TRUE VARIABLE-WIDTH CALLIGRAPHIC / PAINTERLY RIBBON POLYGON
      const samples = sampleSmoothSpline(pts);
      ctx.fillStyle = stroke.color;
      ctx.shadowColor = stroke.color;
      ctx.shadowBlur = Math.max(2, stroke.width * 0.14);

      if (samples.length === 1) {
        ctx.beginPath();
        ctx.arc(samples[0].x, samples[0].y, samples[0].r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        return;
      }

      const leftSide = [];
      const rightSide = [];
      const n = samples.length;

      for (let i = 0; i < n; i++) {
        const cur = samples[i];
        const prev = samples[Math.max(0, i - 1)];
        const next = samples[Math.min(n - 1, i + 1)];
        let tx = next.x - prev.x;
        let ty = next.y - prev.y;
        const len = Math.hypot(tx, ty) || 1;
        tx /= len;
        ty /= len;
        const nx = -ty;
        const ny = tx;

        // Subtle organic entry/exit brush tip taper!
        const endTaper = n > 6 ? Math.min(1, 0.58 + (i / 4) * 0.42, 0.58 + ((n - 1 - i) / 4) * 0.42) : 1;
        const rad = Math.max(1.5, cur.r * endTaper);

        leftSide.push({ x: cur.x + nx * rad, y: cur.y + ny * rad });
        rightSide.push({ x: cur.x - nx * rad, y: cur.y - ny * rad });
      }

      // Build single closed ribbon contour
      ctx.beginPath();
      ctx.moveTo(leftSide[0].x, leftSide[0].y);
      for (let i = 1; i < n; i++) ctx.lineTo(leftSide[i].x, leftSide[i].y);
      for (let i = n - 1; i >= 0; i--) ctx.lineTo(rightSide[i].x, rightSide[i].y);
      ctx.closePath();
      ctx.fill();

      // Seamless rounded start & end tip caps
      const first = samples[0];
      const last = samples[n - 1];
      const capScale = n > 6 ? 0.58 : 1;
      ctx.beginPath();
      ctx.arc(first.x, first.y, Math.max(1.5, first.r * capScale), 0, Math.PI * 2);
      ctx.arc(last.x, last.y, Math.max(1.5, last.r * capScale), 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
      return;
    }

    // PEN or ERASER: Single silky unified Quadratic Bezier spline!
    const isErase = stroke.tool === 'erase';
    ctx.strokeStyle = isErase ? '#FFFFFF' : stroke.color;
    ctx.fillStyle = isErase ? '#FFFFFF' : stroke.color;
    ctx.lineWidth = isErase ? Math.max(20, stroke.width * 2.1) : stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, ctx.lineWidth * 0.5, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) * 0.5;
        const my = (pts[i].y + pts[i + 1].y) * 0.5;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    }

    ctx.restore();
  }

  _redrawLiveStroke() {
    this.liveCtx.clearRect(0, 0, PAINT_W, PAINT_H);
    if (this.activeStroke) {
      this._renderUnifiedStroke(this.liveCtx, this.activeStroke);
    }
  }

  _commitActiveStroke() {
    if (!this.activeStroke) return;
    this._pushHistory();
    this._renderUnifiedStroke(this.paintCtx, this.activeStroke);
    this.opLog.push({
      op: 'stroke',
      tool: this.activeStroke.tool,
      color: this.activeStroke.color,
      width: this.activeStroke.width,
      pts: this.activeStroke.points.map((p) => [Math.round(p.x), Math.round(p.y), +p.r.toFixed(1)]),
    });
    this.activeStroke = null;
    this.liveCtx.clearRect(0, 0, PAINT_W, PAINT_H);
  }

  /** Fast Scanline Queue Flood-Fill on Hi-Res 1600x1000 buffer */
  _floodFill(nx, ny, fillHex) {
    const sx = Math.max(0, Math.min(PAINT_W - 1, Math.floor(nx * PAINT_W)));
    const sy = Math.max(0, Math.min(PAINT_H - 1, Math.floor(ny * PAINT_H)));

    const img = this.paintCtx.getImageData(0, 0, PAINT_W, PAINT_H);
    const data = img.data;
    const startIdx = (sy * PAINT_W + sx) * 4;
    const tr = data[startIdx];
    const tg = data[startIdx + 1];
    const tb = data[startIdx + 2];

    const [fr, fg, fb] = hexToRgb(fillHex);
    if (Math.abs(tr - fr) + Math.abs(tg - fg) + Math.abs(tb - fb) <= 14) {
      return false;
    }

    this._pushHistory();

    const tol = 86;
    const total = PAINT_W * PAINT_H;
    const visited = new Uint8Array(total);
    const stack = new Int32Array(total);
    let sp = 0;

    const matches = (pIdx) => {
      const o = pIdx * 4;
      return Math.abs(data[o] - tr) + Math.abs(data[o + 1] - tg) + Math.abs(data[o + 2] - tb) <= tol;
    };

    const startP = sy * PAINT_W + sx;
    stack[sp++] = startP;
    visited[startP] = 1;

    while (sp > 0) {
      const p = stack[--sp];
      const y = (p / PAINT_W) | 0;
      const rowBase = y * PAINT_W;
      let lx = p - rowBase;
      let rx = lx;

      while (lx > 0 && !visited[rowBase + lx - 1] && matches(rowBase + lx - 1)) {
        lx--;
        visited[rowBase + lx] = 1;
      }
      while (rx < PAINT_W - 1 && !visited[rowBase + rx + 1] && matches(rowBase + rx + 1)) {
        rx++;
        visited[rowBase + rx] = 1;
      }

      for (let x = lx; x <= rx; x++) {
        const o = (rowBase + x) * 4;
        data[o] = fr;
        data[o + 1] = fg;
        data[o + 2] = fb;
        data[o + 3] = 255;

        if (y > 0) {
          const up = rowBase - PAINT_W + x;
          if (!visited[up] && matches(up)) {
            visited[up] = 1;
            stack[sp++] = up;
          }
        }
        if (y < PAINT_H - 1) {
          const dn = rowBase + PAINT_W + x;
          if (!visited[dn] && matches(dn)) {
            visited[dn] = 1;
            stack[sp++] = dn;
          }
        }
      }
    }

    this.paintCtx.putImageData(img, 0, 0);
    return true;
  }

  _computeBoard() {
    const { width, height } = this.api.getSize();
    const rightPanelW = 246;
    const padX = 28;
    const topY = 80;
    const botH = 88;
    const w = Math.max(360, width - padX * 2 - rightPanelW - 18);
    const h = Math.max(260, height - topY - botH);
    this.board = { x: padX, y: topY, w, h, feedX: padX + w + 18, feedW: rightPanelW };
  }

  _pickWord() {
    const avail = WORD_BANK.filter((w) => !this.usedWords.has(w));
    const pool = avail.length > 0 ? avail : WORD_BANK;
    if (avail.length === 0) this.usedWords.clear();
    const word = pool[Math.floor(Math.random() * pool.length)];
    this.usedWords.add(word);
    return word;
  }

  _startNextRound() {
    const players = this.api.getPlayers();
    this.roundNum++;
    this.history = [];
    this.opLog = [];
    this._lastSentOpCount = -1;
    this._clearBoard(false);
    this.guesses = [];
    this.timeLeft = ROUND_SECONDS;
    this.revealed = false;
    this.phase = 'drawing';
    this.secretWord = this._pickWord();

    if (players.length > 0) {
      const artist = players[this.artistIndex % players.length];
      this.artistSlot = artist.slot;
      this.artistIndex++;

      for (const p of players) {
        if (p.isSim) continue;
        if (p.slot === this.artistSlot) {
          this.api.sendToController(p.slot, {
            type: 'to_controller',
            kind: 'sketch_role',
            role: 'artist',
            word: this.secretWord,
          });
        } else {
          this.api.sendToController(p.slot, {
            type: 'to_controller',
            kind: 'sketch_role',
            role: 'guesser',
            length: this.secretWord.length,
          });
        }
      }
    } else {
      this.artistSlot = 99;
    }

    this._renderDock();
    this._updateHud();
  }

  _endRound(winnerPlayer = null) {
    this._commitActiveStroke();
    this.phase = 'reveal';
    this.revealed = true;
    this.revealTimer = 3.2;

    if (winnerPlayer) {
      const bonus = Math.max(100, Math.round(this.timeLeft * 8));
      this.scores.set(winnerPlayer.slot, (this.scores.get(winnerPlayer.slot) || 0) + bonus);
      if (this.artistSlot !== null && this.artistSlot !== winnerPlayer.slot) {
        this.scores.set(this.artistSlot, (this.scores.get(this.artistSlot) || 0) + Math.round(bonus * 0.7));
      }
      this.api.audio.playGoal();
      this.api.reactCompanion('pair', winnerPlayer.profile.color);
      this.api.showToast(`${winnerPlayer.profile.label} guessed "${this.secretWord}" (+${bonus})`, winnerPlayer.profile.color);
    } else {
      this.api.audio.playClick(0.75);
      this.api.showToast(`Time up — Word was "${this.secretWord}"`, '#5C6474');
    }

    this._updateHud();
  }

  _setSize(sizeId) {
    const found = STROKE_SIZES.find((s) => s.id === sizeId) || STROKE_SIZES[1];
    this.sizeId = found.id;
    this.brushWidth = found.px;
  }

  onCustomMessage(player, msg) {
    if (msg.type === 'sketch_guess' && this.phase === 'drawing') {
      const clean = String(msg.text || '').trim().toUpperCase().slice(0, 28);
      if (!clean) return true;
      const isCorrect = clean === this.secretWord;
      this.guesses.push({
        label: player.profile.label,
        color: player.profile.color,
        text: isCorrect ? 'GUESSED IT!' : clean,
        correct: isCorrect,
      });
      if (this.guesses.length > 10) this.guesses.shift();

      if (isCorrect) {
        this.api.sendFeedback(player.slot, { sfx: 'goal', vibrate: [30, 25, 45] });
        this._endRound(player);
      } else {
        this.api.audio.playClick(0.92);
        this.api.sendFeedback(player.slot, { sfx: 'click', vibrate: [10] });
      }
      return true;
    }

    if (msg.type === 'sculpt_tool' || msg.type === 'sketch_tool') {
      if (msg.color) {
        this.color = msg.color;
        if (this.tool === 'erase') this.tool = 'pen';
      }
      if (msg.tool) {
        this.tool = ['pen', 'brush', 'fill', 'erase'].includes(msg.tool) ? msg.tool : 'pen';
      }
      if (msg.size) this._setSize(msg.size);
      if (msg.cmd === 'undo') this._undo();
      if (msg.cmd === 'clear') {
        this._clearBoard(true);
        this.api.audio.playErase();
      }
      this._renderDock();
      return true;
    }

    if (msg.type === 'sketch_cmd') {
      if (msg.cmd === 'skip') this._startNextRound();
      if (msg.cmd === 'solved') this._endRound(player);
      return true;
    }
    return false;
  }

  _renderDock() {
    const swatches = SCULPT_PALETTE.slice(0, 7)
      .map(
        (c) =>
          `<button class="swatch-btn ${this.color.toLowerCase() === c.hex.toLowerCase() && this.tool !== 'erase' ? 'active' : ''}"
            data-color="${c.hex}" data-spring="swatch" title="${c.name}" style="--sw:${c.hex}" type="button"></button>`
      )
      .join('');

    const sizeDots = STROKE_SIZES.map(
      (s) =>
        `<button class="size-dot-btn ${this.sizeId === s.id ? 'active' : ''}"
          data-size="${s.id}" data-spring="btn" title="${s.label}" aria-label="${s.label}" type="button">
          <span style="width:${s.dot}px;height:${s.dot}px"></span>
        </button>`
    ).join('');

    this.api.setDock(`
      <div class="sculpt-dock">
        <div class="dock-group swatches">${swatches}</div>
        <span class="dock-sep"></span>
        <div class="dock-group">
          <button class="dock-pill icon-only ${this.tool === 'pen' ? 'active' : ''}" data-tool="pen" data-spring="btn" title="Pen" aria-label="Pen" type="button">${phIcon('pencil-simple')}</button>
          <button class="dock-pill icon-only ${this.tool === 'brush' ? 'active' : ''}" data-tool="brush" data-spring="btn" title="Brush Stroke" aria-label="Brush Stroke" type="button">${phIcon('paint-brush')}</button>
          <button class="dock-pill icon-only ${this.tool === 'fill' ? 'active' : ''}" data-tool="fill" data-spring="btn" title="Color Fill Bucket" aria-label="Color Fill" type="button">${phIcon('paint-bucket')}</button>
          <button class="dock-pill icon-only ${this.tool === 'erase' ? 'active' : ''}" data-tool="erase" data-spring="btn" title="Eraser" aria-label="Eraser" type="button">${phIcon('eraser')}</button>
        </div>
        <span class="dock-sep"></span>
        <div class="dock-group">${sizeDots}</div>
        <span class="dock-sep"></span>
        <div class="dock-group">
          <button class="dock-pill icon-only" data-cmd="undo" data-spring="btn" title="Undo" aria-label="Undo" type="button">${phIcon('arrow-u-up-left')}</button>
          <button class="dock-pill icon-only danger" data-cmd="clear" data-spring="btn" title="Clear Board" aria-label="Clear Board" type="button">${phIcon('trash')}</button>
        </div>
        <span class="dock-sep"></span>
        <div class="dock-group">
          <button class="dock-pill icon-only ${this.revealed ? 'active' : ''}" data-cmd="peek" data-spring="btn" title="${this.revealed ? 'Hide Word' : 'Peek Word'}" aria-label="Peek Word" type="button">${phIcon(this.revealed ? 'eye-slash' : 'eye')}</button>
          <button class="dock-pill icon-only success" data-cmd="solved" data-spring="btn" title="Mark Solved" aria-label="Mark Solved" type="button">${phIcon('check')}</button>
          <button class="dock-pill icon-only" data-cmd="skip" data-spring="btn" title="Next Word" aria-label="Next Word" type="button">${phIcon('skip-forward')}</button>
        </div>
      </div>
    `);

    const dockEl = document.getElementById('modeDock');
    if (!dockEl) return;
    bindSpringButtons(dockEl);

    dockEl.querySelectorAll('[data-color]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.color = btn.dataset.color;
        if (this.tool === 'erase') this.tool = 'pen';
        this.api.audio.playClick(1.22);
        this._renderDock();
      });
    });
    dockEl.querySelectorAll('[data-tool]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.tool = btn.dataset.tool;
        this.api.audio.playClick(1.12);
        this._renderDock();
      });
    });
    dockEl.querySelectorAll('[data-size]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this._setSize(btn.dataset.size);
        this.api.audio.playClick(1.18);
        this._renderDock();
      });
    });
    dockEl.querySelectorAll('[data-cmd]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cmd = btn.dataset.cmd;
        this.api.audio.playClick(1.15);
        if (cmd === 'undo') this._undo();
        else if (cmd === 'clear') {
          this._clearBoard(true);
          this.api.audio.playErase();
        } else if (cmd === 'peek') {
          this.revealed = !this.revealed;
          this._updateHud();
          this._renderDock();
        } else if (cmd === 'solved') {
          const guesser = this.api.getPlayers().find((p) => p.slot !== this.artistSlot) || this.api.getPlayers()[0];
          this._endRound(guesser || null);
        } else if (cmd === 'skip') {
          this._startNextRound();
        }
      });
    });
  }

  _tryClickDockByRemote(player) {
    const { width, height } = this.api.getSize();
    const px = player.x * width;
    const py = player.y * height;
    const dockEl = document.getElementById('modeDock');
    if (!dockEl) return false;
    for (const btn of dockEl.querySelectorAll('button')) {
      const r = btn.getBoundingClientRect();
      if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) {
        btn.click();
        this.api.sendFeedback(player.slot, { sfx: 'click', vibrate: [12] });
        return true;
      }
    }
    return false;
  }

  onAction(player, actionName) {
    if (this.phase !== 'drawing') return;
    const isArtist = player.slot === this.artistSlot || this.api.getPlayers().length <= 1;
    if (!isArtist) return;

    if (actionName === 'btn_a_down') {
      if (this._tryClickDockByRemote(player)) return;

      const { width, height } = this.api.getSize();
      const px = player.x * width;
      const py = player.y * height;
      const b = this.board;
      if (px < b.x || px > b.x + b.w || py < b.y || py > b.y + b.h) return;

      const nx = (px - b.x) / b.w;
      const ny = (py - b.y) / b.h;

      if (this.tool === 'fill') {
        const filled = this._floodFill(nx, ny, this.color);
        if (filled) {
          this.opLog.push({ op: 'fill', nx: +nx.toFixed(4), ny: +ny.toFixed(4), color: this.color });
          this.api.audio.playChirp('happy');
          this.api.sendFeedback(player.slot, { sfx: 'click', vibrate: [18] });
        }
        return;
      }

      const baseR = this.tool === 'brush' ? this.brushWidth * 0.65 : this.brushWidth * 0.5;
      this.activeStroke = {
        tool: this.tool,
        color: this.color,
        width: this.brushWidth,
        smoothR: baseR,
        lastTimeMs: performance.now(),
        points: [{ x: nx * PAINT_W, y: ny * PAINT_H, r: baseR }],
      };
      this._redrawLiveStroke();
    } else if (actionName === 'btn_a_up') {
      this._commitActiveStroke();
    } else if (actionName === 'btn_b_down') {
      this._undo();
    }
  }

  onGesture() {}

  _updateHud() {
    const artist = this.api.getPlayers().find((p) => p.slot === this.artistSlot);
    const masked = this.revealed
      ? this.secretWord
      : this.secretWord
        ? this.secretWord
            .split('')
            .map((ch) => (ch === ' ' || ch === '-' ? ch : '_'))
            .join(' ')
        : '_ '.repeat(Math.max(0, this._mirrorWordLen || 0)).trim() || '...';
    this.api.setHud({
      title: 'AIR SKETCH',
      stat1Label: artist ? `${artist.profile.label} DRAWS` : 'WORD',
      stat1Value: masked,
      stat2Label: 'TIME',
      stat2Value: `${Math.ceil(this.timeLeft)}s`,
      hint: this.api.isPrimary()
        ? 'Pen, Brush, Fill Bucket & Eraser below or on your phone'
        : 'Synced Live Canvas — guess directly from your phone!',
    });
  }

  update(dt, players) {
    this._computeBoard();

    if (this.phase === 'reveal') {
      this.revealTimer -= dt;
      if (this.revealTimer <= 0) this._startNextRound();
      return;
    }

    this.timeLeft = Math.max(0, this.timeLeft - dt);
    if (this.timeLeft <= 0) {
      this._endRound(null);
      return;
    }

    if (Math.ceil(this.timeLeft) !== Math.ceil(this.timeLeft + dt)) {
      this._updateHud();
    }

    const artist = players.find((p) => p.slot === this.artistSlot) || players[0];
    if (artist && artist.a && this.activeStroke) {
      const { width, height } = this.api.getSize();
      const px = artist.x * width;
      const py = artist.y * height;
      const b = this.board;
      const cx = Math.max(0, Math.min(PAINT_W, ((px - b.x) / b.w) * PAINT_W));
      const cy = Math.max(0, Math.min(PAINT_H, ((py - b.y) / b.h) * PAINT_H));

      const pts = this.activeStroke.points;
      const last = pts[pts.length - 1];
      const dist = Math.hypot(cx - last.x, cy - last.y);

      if (dist >= 4.0) {
        const now = performance.now();
        const elapsed = Math.max(4, now - this.activeStroke.lastTimeMs);
        this.activeStroke.lastTimeMs = now;
        const speedPxPerMs = dist / elapsed;

        // Expressive smooth calligraphy width modulation (thick when slow, graceful taper when sweeping fast!)
        const baseR = this.activeStroke.width * 0.68;
        const targetR = baseR * Math.max(0.38, Math.min(1.25, 1.18 - speedPxPerMs * 0.32));
        this.activeStroke.smoothR += (targetR - this.activeStroke.smoothR) * 0.28;

        pts.push({ x: cx, y: cy, r: this.activeStroke.smoothR });
        this._redrawLiveStroke();
      }
    } else if (this.activeStroke && !artist?.a) {
      this._commitActiveStroke();
    }
  }

  render(ctx, width, height, players) {
    ctx.save();
    ctx.fillStyle = '#F3F4F6';
    ctx.fillRect(0, 0, width, height);

    const b = this.board;

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(b.x, b.y, b.w, b.h, 22);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(17, 19, 24, 0.08)';
    ctx.stroke();
    ctx.clip();

    // High-quality smooth scaling of both committed raster & crisp live stroke layer
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.paintCanvas, b.x, b.y, b.w, b.h);
    if (this.activeStroke) {
      ctx.drawImage(this.liveCanvas, b.x, b.y, b.w, b.h);
    }

    // Subtle faint editorial dot grid
    ctx.fillStyle = 'rgba(17, 19, 24, 0.04)';
    for (let gx = b.x + 28; gx < b.x + b.w; gx += 36) {
      for (let gy = b.y + 28; gy < b.y + b.h; gy += 36) {
        ctx.fillRect(gx, gy, 1.5, 1.5);
      }
    }

    if (this.phase === 'reveal') {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.fillRect(b.x, b.y + b.h * 0.5 - 46, b.w, 92);
      ctx.font = '800 32px "Plus Jakarta Sans", sans-serif';
      ctx.fillStyle = '#111318';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.secretWord, b.x + b.w * 0.5, b.y + b.h * 0.5);
    }
    ctx.restore();

    // Right Sidebar: Live Guess Feed + Scoreboard
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(b.feedX, b.y, b.feedW, b.h, 22);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(17, 19, 24, 0.08)';
    ctx.stroke();

    ctx.font = '700 11px "JetBrains Mono", monospace';
    ctx.fillStyle = '#646B7A';
    ctx.fillText('LIVE GUESSES', b.feedX + 18, b.y + 28);

    let sy = b.y + 50;
    players.forEach((p) => {
      const sc = this.scores.get(p.slot) || 0;
      const isArt = p.slot === this.artistSlot;
      ctx.fillStyle = p.profile.color;
      ctx.beginPath();
      ctx.arc(b.feedX + 22, sy, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '700 12px "Plus Jakarta Sans", sans-serif';
      ctx.fillStyle = '#111318';
      ctx.fillText(`${p.profile.label}${isArt ? ' (Artist)' : ''}`, b.feedX + 34, sy + 4);
      ctx.font = '700 12px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(String(sc), b.feedX + b.feedW - 18, sy + 4);
      ctx.textAlign = 'left';
      sy += 24;
    });

    sy += 6;
    ctx.strokeStyle = 'rgba(17, 19, 24, 0.07)';
    ctx.beginPath();
    ctx.moveTo(b.feedX + 16, sy);
    ctx.lineTo(b.feedX + b.feedW - 16, sy);
    ctx.stroke();
    sy += 22;

    if (this.guesses.length === 0) {
      ctx.font = '500 12px "Plus Jakarta Sans", sans-serif';
      ctx.fillStyle = '#94A3B8';
      ctx.fillText('Waiting for guesses...', b.feedX + 18, sy);
    } else {
      for (const g of this.guesses) {
        if (sy > b.y + b.h - 20) break;
        ctx.font = '700 11px "JetBrains Mono", monospace';
        ctx.fillStyle = g.color;
        ctx.fillText(g.label, b.feedX + 18, sy);
        ctx.font = '600 13px "Plus Jakarta Sans", sans-serif';
        ctx.fillStyle = g.correct ? '#059669' : '#111318';
        ctx.fillText(g.text, b.feedX + 46, sy);
        sy += 28;
      }
    }
    ctx.restore();

    ctx.restore();
  }

  getSyncState(forceFull = false) {
    const needOps = forceFull || this.opLog.length !== this._lastSentOpCount;
    if (needOps) this._lastSentOpCount = this.opLog.length;
    return {
      roundNum: this.roundNum,
      artistSlot: this.artistSlot,
      wordLen: this.secretWord.length,
      revealed: this.revealed,
      // Never leak the secret word to remote viewer screens until round reveal!
      secretWord: this.revealed ? this.secretWord : '',
      timeLeft: +this.timeLeft.toFixed(1),
      phase: this.phase,
      guesses: this.guesses.slice(0, 10),
      scores: [...this.scores.entries()],
      opCount: this.opLog.length,
      ops: needOps ? this.opLog : null,
      activeStroke: this.activeStroke
        ? {
            tool: this.activeStroke.tool,
            color: this.activeStroke.color,
            width: this.activeStroke.width,
            pts: this.activeStroke.points.map((p) => [Math.round(p.x), Math.round(p.y), +p.r.toFixed(1)]),
          }
        : null,
    };
  }

  _applyOpOnMirror(item) {
    if (item.op === 'stroke') {
      this._pushHistory();
      this._renderUnifiedStroke(this.paintCtx, {
        tool: item.tool,
        color: item.color,
        width: item.width,
        points: item.pts.map(([x, y, r]) => ({ x, y, r })),
      });
    } else if (item.op === 'fill') {
      this._floodFill(item.nx, item.ny, item.color);
    } else if (item.op === 'undo') {
      const prev = this.history.pop();
      if (prev) this.paintCtx.putImageData(prev, 0, 0);
    } else if (item.op === 'clear') {
      this._pushHistory();
      this.paintCtx.fillStyle = '#FFFFFF';
      this.paintCtx.fillRect(0, 0, PAINT_W, PAINT_H);
    }
  }

  applySyncState(s) {
    if (!s) return;
    this._computeBoard();

    const roundChanged = s.roundNum !== this._mirrorRound;
    if (roundChanged) {
      this._mirrorRound = s.roundNum;
      this._mirrorOpCount = 0;
      this.history = [];
      this._clearBoard(false);
    }

    this.roundNum = s.roundNum;
    this.artistSlot = s.artistSlot;
    this._mirrorWordLen = s.wordLen || 0;
    this.revealed = Boolean(s.revealed);
    this.secretWord = s.revealed ? s.secretWord || '' : '';
    this.timeLeft = s.timeLeft;
    this.phase = s.phase;
    this.guesses = s.guesses || [];
    this.scores = new Map(s.scores || []);

    if (Array.isArray(s.ops)) {
      if (s.ops.length < this._mirrorOpCount || roundChanged) {
        this.history = [];
        this._clearBoard(false);
        this._mirrorOpCount = 0;
      }
      for (let i = this._mirrorOpCount; i < s.ops.length; i++) {
        this._applyOpOnMirror(s.ops[i]);
      }
      this._mirrorOpCount = s.ops.length;
    }

    // Live active stroke preview while artist draws
    this.liveCtx.clearRect(0, 0, PAINT_W, PAINT_H);
    if (s.activeStroke && s.activeStroke.pts && s.activeStroke.pts.length > 0) {
      this._renderUnifiedStroke(this.liveCtx, {
        tool: s.activeStroke.tool,
        color: s.activeStroke.color,
        width: s.activeStroke.width,
        points: s.activeStroke.pts.map(([x, y, r]) => ({ x, y, r })),
      });
    }

    this._updateHud();
  }

  updateMirror() {
    this._computeBoard();
  }
}
