// MODE 2: SCULPT 3D — True Three.js Collaborative 3D Clay & Light Studio
// Per-player colors, Clay/Gloss/Chrome materials, Brush Sizes, 3D Eraser, Undo, 360° Orbit, and Co-op Consensus Clear Vote!

import * as THREE from '/vendor/three/three.module.js';
import { SCULPT_PALETTE } from '../../shared/protocol.js';
import { bindSpringButtons } from '../../shared/spring.js';

const BRUSH_RADII = { sm: 0.09, md: 0.16, lg: 0.27 };

export class SculptMode {
  constructor(api) {
    this.api = api;
    this.canvas = document.getElementById('sculptCanvas');
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.worldGroup = null;

    this.strokes = []; // { id, ownerSlot, color, material, radius, points: THREE.Vector3[], group, tubeMesh, startCap, endCap, matObj }
    this.activeStrokes = new Map(); // slot -> stroke
    this.toolBySlot = new Map(); // slot -> { color, material, size, tool: 'sculpt'|'erase' }
    this.eraserSpheres = new Map(); // slot -> THREE.Mesh
    this.brushPreviews = new Map(); // slot -> THREE.Mesh
    this.capSphereGeo = null;
    this.dust = [];

    this.autoOrbit = true;
    this.rotY = 0;
    this.rotX = 0.22;
    this.targetRotX = 0.22;
    this.lastPos = new Map();

    // Co-op consensus clear vote state
    this.clearVote = null; // { requesterSlot, requesterLabel, votes: Map<slot, boolean>, expiresAt }
    this._mounted = false;
    this._syncSeq = 0;
    this._lastSentSeq = -1;
  }

  _initThree() {
    if (this.renderer) return;
    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    this.camera.position.set(0, 0.7, 9.2);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;

    // Bright Scandinavian ceramic studio three-point lighting
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xd8e0ec, 1.35));

    const key = new THREE.DirectionalLight(0xffffff, 1.55);
    key.position.set(5, 8, 7);
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x93c5fd, 0.85);
    rim.position.set(-6, 4, -5);
    this.scene.add(rim);

    const warmFill = new THREE.DirectionalLight(0xfef3c7, 0.5);
    warmFill.position.set(4, -4, 3);
    this.scene.add(warmFill);

    this.worldGroup = new THREE.Group();
    this.scene.add(this.worldGroup);

    // Minimal 3D studio turntable pedestal ring
    const ringGeo = new THREE.RingGeometry(3.3, 3.36, 64);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x111318,
      transparent: true,
      opacity: 0.1,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -2.35;
    this.worldGroup.add(ring);

    const innerDisc = new THREE.Mesh(
      new THREE.CircleGeometry(3.3, 64),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
    );
    innerDisc.rotation.x = -Math.PI / 2;
    innerDisc.position.y = -2.36;
    this.worldGroup.add(innerDisc);

    // Subtle radial turntable axis ticks
    const tickMat = new THREE.LineBasicMaterial({ color: 0x111318, transparent: true, opacity: 0.08 });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI;
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(Math.cos(a) * -3.3, -2.34, Math.sin(a) * -3.3),
        new THREE.Vector3(Math.cos(a) * 3.3, -2.34, Math.sin(a) * 3.3),
      ]);
      this.worldGroup.add(new THREE.Line(geo, tickMat));
    }
  }

  enter() {
    this._initThree();
    this._mounted = true;
    this.canvas.classList.add('active');
    this.resize();
    this.activeStrokes.clear();
    this.clearVote = null;
    this.autoOrbit = true;
    this.rotY = 0;
    this.rotX = 0.22;

    for (const p of this.api.getPlayers()) {
      this._getTool(p);
    }

    if (this.api.isPrimary()) this._renderToolbar();
    else this.api.setDock('');
    this._updateHud();
  }

  exit() {
    this._mounted = false;
    this.canvas.classList.remove('active');
    this.activeStrokes.clear();
    this.clearVote = null;
    this.api.setDock('');
    this.api.setOverlay('');
  }

  resize() {
    if (!this.renderer) return;
    const { width, height } = this.api.getSize();
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  _getTool(player) {
    if (!this.toolBySlot.has(player.slot)) {
      this.toolBySlot.set(player.slot, {
        color: player.profile.color,
        material: 'gloss', // 'clay' | 'gloss' | 'chrome'
        size: 'md', // 'sm' | 'md' | 'lg'
        tool: 'sculpt', // 'sculpt' | 'erase'
      });
    }
    return this.toolBySlot.get(player.slot);
  }

  _getPrimarySlot() {
    const players = this.api.getPlayers();
    return players.length > 0 ? players[0].slot : 99;
  }

  _makeMaterial(colorHex, matKind) {
    if (matKind === 'chrome') {
      return new THREE.MeshPhysicalMaterial({
        color: colorHex,
        roughness: 0.08,
        metalness: 0.88,
        clearcoat: 1.0,
        clearcoatRoughness: 0.05,
      });
    }
    if (matKind === 'clay') {
      return new THREE.MeshStandardMaterial({
        color: colorHex,
        roughness: 0.78,
        metalness: 0.02,
      });
    }
    // Glossy ceramic vinyl default
    return new THREE.MeshPhysicalMaterial({
      color: colorHex,
      roughness: 0.2,
      metalness: 0.06,
      clearcoat: 0.9,
      clearcoatRoughness: 0.12,
    });
  }

  _screenToWorld3D(nx, ny, depthOffset = 0) {
    const ndcX = nx * 2 - 1;
    const ndcY = -(ny * 2 - 1);
    const vec = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(this.camera);
    const dir = vec.sub(this.camera.position).normalize();
    const dist = (0 - this.camera.position.z) / dir.z;
    const worldPt = this.camera.position.clone().add(dir.multiplyScalar(dist + depthOffset));
    // Transform into turntable local space so strokes rotate with the sculpture!
    return this.worldGroup.worldToLocal(worldPt);
  }

  _smoothPoints(pts) {
    if (pts.length <= 2) return pts;
    const out = [pts[0].clone()];
    for (let i = 1; i < pts.length - 1; i++) {
      const prev = pts[i - 1];
      const cur = pts[i];
      const next = pts[i + 1];
      out.push(
        new THREE.Vector3(
          prev.x * 0.22 + cur.x * 0.56 + next.x * 0.22,
          prev.y * 0.22 + cur.y * 0.56 + next.y * 0.22,
          prev.z * 0.22 + cur.z * 0.56 + next.z * 0.22
        )
      );
    }
    out.push(pts[pts.length - 1].clone());
    return out;
  }

  _rebuildStrokeMesh(stroke) {
    if (stroke.points.length === 0) return;

    if (!this.capSphereGeo) {
      this.capSphereGeo = new THREE.SphereGeometry(1, 22, 16);
    }
    if (!stroke.matObj) {
      stroke.matObj = this._makeMaterial(stroke.color, stroke.material);
    }
    if (!stroke.group) {
      stroke.group = new THREE.Group();
      this.worldGroup.add(stroke.group);
    }

    // Smooth rounded hemispherical Start Cap (always visible from the very first tap!)
    const pStart = stroke.points[0];
    if (!stroke.startCap) {
      stroke.startCap = new THREE.Mesh(this.capSphereGeo, stroke.matObj);
      stroke.startCap.scale.setScalar(stroke.radius);
      stroke.group.add(stroke.startCap);
    }
    stroke.startCap.position.copy(pStart);

    // Smooth rounded hemispherical End Cap (seals the tip seamlessly — zero open/sharp edges!)
    const pEnd = stroke.points[stroke.points.length - 1];
    if (stroke.points.length >= 2) {
      if (!stroke.endCap) {
        stroke.endCap = new THREE.Mesh(this.capSphereGeo, stroke.matObj);
        stroke.endCap.scale.setScalar(stroke.radius);
        stroke.group.add(stroke.endCap);
      }
      stroke.endCap.position.copy(pEnd);

      // Rebuild silky 20-segment smooth TubeGeometry connecting start -> end
      if (stroke.tubeMesh) {
        stroke.group.remove(stroke.tubeMesh);
        stroke.tubeMesh.geometry.dispose();
      }
      const smoothed = this._smoothPoints(stroke.points);
      const curve = new THREE.CatmullRomCurve3(smoothed, false, 'centripetal', 0.5);
      const tubularSegs = Math.min(300, Math.max(12, smoothed.length * 4));
      const geo = new THREE.TubeGeometry(curve, tubularSegs, stroke.radius, 20, false);
      stroke.tubeMesh = new THREE.Mesh(geo, stroke.matObj);
      stroke.group.add(stroke.tubeMesh);
    }
    this._syncSeq++;
  }

  _removeStroke(stroke) {
    if (stroke.tubeMesh) {
      stroke.tubeMesh.geometry.dispose();
      stroke.tubeMesh = null;
    }
    if (stroke.group) {
      this.worldGroup.remove(stroke.group);
      stroke.group = null;
    }
    if (stroke.matObj) {
      stroke.matObj.dispose();
      stroke.matObj = null;
    }
    const idx = this.strokes.indexOf(stroke);
    if (idx !== -1) this.strokes.splice(idx, 1);
    this._syncSeq++;
  }

  _undoForSlot(slot) {
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      if (this.strokes[i].ownerSlot === slot || slot === null) {
        this._removeStroke(this.strokes[i]);
        this.api.audio.playErase();
        this._updateHud();
        return true;
      }
    }
    return false;
  }

  _performClearAll() {
    for (const s of [...this.strokes]) this._removeStroke(s);
    this.strokes = [];
    this.activeStrokes.clear();
    this.clearVote = null;
    this.api.setOverlay('');
    this.api.audio.playChirp('happy');
    this.api.reactCompanion('happy');
    this.api.broadcastToControllers({ type: 'to_controller', kind: 'clear_vote_closed', cleared: true });
    this.api.showToast('3D Canvas Cleared', '#2563EB');
    this._updateHud();
  }

  requestClear(requesterPlayer) {
    const players = this.api.getPlayers();
    const otherPlayers = players.filter((p) => p.slot !== requesterPlayer.slot);

    // Solo play: instant clear!
    if (otherPlayers.length === 0) {
      this._performClearAll();
      return;
    }

    // Co-op mode: ask every other connected player to approve before wiping their 3D sculpture!
    const votes = new Map();
    votes.set(requesterPlayer.slot, true);
    for (const op of otherPlayers) votes.set(op.slot, null);

    this.clearVote = {
      requesterSlot: requesterPlayer.slot,
      requesterLabel: `${requesterPlayer.profile.label} ${requesterPlayer.profile.name}`,
      votes,
      expiresAt: performance.now() + 15000,
    };

    this.api.audio.playClick(1.2);
    this.api.broadcastToControllers(
      {
        type: 'to_controller',
        kind: 'clear_vote_prompt',
        requester: this.clearVote.requesterLabel,
      },
      requesterPlayer.slot
    );
    this._renderClearVoteOverlay();
  }

  handleClearVoteReply(slot, approved) {
    if (!this.clearVote) return;
    if (!approved) {
      const decliner = this.api.getPlayers().find((p) => p.slot === slot);
      this.clearVote = null;
      this.api.setOverlay('');
      this.api.broadcastToControllers({ type: 'to_controller', kind: 'clear_vote_closed', cleared: false });
      this.api.showToast(`${decliner ? decliner.profile.label : 'A player'} kept the sculpture`, '#5C6474');
      this.api.audio.playClick(0.8);
      return;
    }

    this.clearVote.votes.set(slot, true);
    const allApproved = [...this.clearVote.votes.values()].every((v) => v === true);
    if (allApproved) {
      this._performClearAll();
    } else {
      this._renderClearVoteOverlay();
    }
  }

  _renderClearVoteOverlay() {
    if (!this.clearVote) {
      this.api.setOverlay('');
      return;
    }
    const players = this.api.getPlayers();
    const badges = players
      .map((p) => {
        const v = this.clearVote.votes.get(p.slot);
        const status = v === true ? 'AGREED' : 'WAITING';
        return `<div class="vote-chip ${v === true ? 'ok' : ''}">
          <span class="podium-dot" style="background:${p.profile.color}"></span>
          <span>${p.profile.label}</span>
          <span class="vote-state">${status}</span>
        </div>`;
      })
      .join('');

    this.api.setOverlay(`
      <div class="studio-modal compact">
        <div class="modal-kicker">CO-OP CANVAS RESET</div>
        <h3 class="modal-title">${this.clearVote.requesterLabel} wants to clear the 3D canvas</h3>
        <div class="modal-sub">All connected players must agree on their phone or here.</div>
        <div class="vote-row">${badges}</div>
        <div class="modal-actions">
          <button id="voteAgreeBtn" class="studio-btn primary" data-spring="btn" type="button">Approve Clear</button>
          <button id="voteDeclineBtn" class="studio-btn" data-spring="btn" type="button">Keep Art</button>
        </div>
      </div>
    `);

    const agree = document.getElementById('voteAgreeBtn');
    const decline = document.getElementById('voteDeclineBtn');
    if (agree) {
      agree.addEventListener('click', () => {
        for (const k of this.clearVote.votes.keys()) this.clearVote.votes.set(k, true);
        this._performClearAll();
      });
    }
    if (decline) {
      decline.addEventListener('click', () => this.handleClearVoteReply(this._getPrimarySlot(), false));
    }
  }

  // Handle tool changes sent directly from any player's smartphone!
  onCustomMessage(player, msg) {
    if (msg.type === 'sculpt_tool') {
      const st = this._getTool(player);
      if (msg.color) st.color = msg.color;
      if (msg.material) st.material = msg.material;
      if (msg.size) st.size = msg.size;
      if (msg.tool) st.tool = msg.tool;
      if (msg.cmd === 'undo') this._undoForSlot(player.slot);
      if (msg.cmd === 'clear') this.requestClear(player);
      if (msg.cmd === 'orbit') this.autoOrbit = !this.autoOrbit;
      this.api.audio.playClick(1.18);
      this._renderToolbar();
      return true;
    }
    if (msg.type === 'clear_vote_reply') {
      this.handleClearVoteReply(player.slot, !!msg.approved);
      return true;
    }
    return false;
  }

  _renderToolbar() {
    if (!this._mounted) return;
    const players = this.api.getPlayers();
    const activePlayer = players.find((p) => p.isSim) || players[0] || { slot: 99, profile: { color: '#2563EB' } };
    const st = this._getTool(activePlayer);

    const swatches = SCULPT_PALETTE.map(
      (c) =>
        `<button class="swatch-btn ${st.color.toLowerCase() === c.hex.toLowerCase() && st.tool === 'sculpt' ? 'active' : ''}"
          data-color="${c.hex}" data-spring="swatch" title="${c.name}"
          style="--sw:${c.hex}" type="button"></button>`
    ).join('');

    const icon = (name) =>
      `<span class="ph-icon" style="-webkit-mask-image:url('/vendor/icons/${name}-bold.svg');mask-image:url('/vendor/icons/${name}-bold.svg')"></span>`;

    this.api.setDock(`
      <div class="sculpt-dock">
        <div class="dock-group swatches">${swatches}</div>
        <span class="dock-sep"></span>
        <div class="dock-group">
          <button class="dock-pill icon-only ${st.tool === 'sculpt' ? 'active' : ''}" data-tool="sculpt" data-spring="btn" title="Sculpt" aria-label="Sculpt" type="button">${icon('paint-brush')}</button>
          <button class="dock-pill icon-only ${st.tool === 'erase' ? 'active' : ''}" data-tool="erase" data-spring="btn" title="3D Eraser" aria-label="Eraser" type="button">${icon('eraser')}</button>
        </div>
        <span class="dock-sep"></span>
        <div class="dock-group">
          <button class="dock-pill ${st.material === 'clay' ? 'active' : ''}" data-mat="clay" data-spring="btn" type="button">Clay</button>
          <button class="dock-pill ${st.material === 'gloss' ? 'active' : ''}" data-mat="gloss" data-spring="btn" type="button">Gloss</button>
          <button class="dock-pill ${st.material === 'chrome' ? 'active' : ''}" data-mat="chrome" data-spring="btn" type="button">Chrome</button>
        </div>
        <span class="dock-sep"></span>
        <div class="dock-group">
          <button class="size-dot-btn ${st.size === 'sm' ? 'active' : ''}" data-size="sm" data-spring="btn" title="Fine" aria-label="Fine" type="button"><span style="width:6px;height:6px"></span></button>
          <button class="size-dot-btn ${st.size === 'md' ? 'active' : ''}" data-size="md" data-spring="btn" title="Medium" aria-label="Medium" type="button"><span style="width:10px;height:10px"></span></button>
          <button class="size-dot-btn ${st.size === 'lg' ? 'active' : ''}" data-size="lg" data-spring="btn" title="Thick" aria-label="Thick" type="button"><span style="width:15px;height:15px"></span></button>
        </div>
        <span class="dock-sep"></span>
        <div class="dock-group">
          <button class="dock-pill icon-only ${this.autoOrbit ? 'active' : ''}" data-cmd="orbit" data-spring="btn" title="${this.autoOrbit ? 'Orbit On' : 'Orbit Off'}" aria-label="Toggle Orbit" type="button">${icon('arrows-clockwise')}</button>
          <button class="dock-pill icon-only" data-cmd="undo" data-spring="btn" title="Undo" aria-label="Undo" type="button">${icon('arrow-u-up-left')}</button>
          <button class="dock-pill icon-only danger" data-cmd="clear" data-spring="btn" title="Clear Canvas" aria-label="Clear Canvas" type="button">${icon('trash')}</button>
        </div>
      </div>
    `);

    const dockEl = document.getElementById('modeDock');
    if (!dockEl) return;
    bindSpringButtons(dockEl);

    dockEl.querySelectorAll('[data-color]').forEach((btn) => {
      btn.addEventListener('click', () => {
        st.color = btn.dataset.color;
        st.tool = 'sculpt';
        this.api.audio.playClick(1.22);
        this._renderToolbar();
      });
    });
    dockEl.querySelectorAll('[data-tool]').forEach((btn) => {
      btn.addEventListener('click', () => {
        st.tool = btn.dataset.tool;
        this.api.audio.playClick(1.1);
        this._renderToolbar();
      });
    });
    dockEl.querySelectorAll('[data-mat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        st.material = btn.dataset.mat;
        this.api.audio.playClick(1.15);
        this._renderToolbar();
      });
    });
    dockEl.querySelectorAll('[data-size]').forEach((btn) => {
      btn.addEventListener('click', () => {
        st.size = btn.dataset.size;
        this.api.audio.playClick(1.2);
        this._renderToolbar();
      });
    });
    dockEl.querySelectorAll('[data-cmd]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cmd = btn.dataset.cmd;
        if (cmd === 'orbit') {
          this.autoOrbit = !this.autoOrbit;
          this.api.audio.playClick(1.15);
          this._renderToolbar();
        } else if (cmd === 'undo') {
          this._undoForSlot(activePlayer.slot);
        } else if (cmd === 'clear') {
          this.requestClear(activePlayer);
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
    const buttons = dockEl.querySelectorAll('button');
    for (const btn of buttons) {
      const r = btn.getBoundingClientRect();
      if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) {
        const st = this._getTool(player);
        if (btn.dataset.color) {
          st.color = btn.dataset.color;
          st.tool = 'sculpt';
        } else if (btn.dataset.tool) {
          st.tool = btn.dataset.tool;
        } else if (btn.dataset.mat) {
          st.material = btn.dataset.mat;
        } else if (btn.dataset.size) {
          st.size = btn.dataset.size;
        } else if (btn.dataset.cmd === 'orbit') {
          this.autoOrbit = !this.autoOrbit;
        } else if (btn.dataset.cmd === 'undo') {
          this._undoForSlot(player.slot);
        } else if (btn.dataset.cmd === 'clear') {
          this.requestClear(player);
        }
        this.api.audio.playClick(1.25);
        this.api.sendFeedback(player.slot, { sfx: 'click', vibrate: [14] });
        this._renderToolbar();
        return true;
      }
    }
    return false;
  }

  onAction(player, actionName) {
    if (actionName === 'btn_a_down') {
      if (this._tryClickDockByRemote(player)) return;
      const st = this._getTool(player);
      if (st.tool === 'sculpt') {
        const depthOffset = Math.sin(performance.now() * 0.0018 + player.slot * 1.7) * 0.75 + (player.roll || 0) * 0.45;
        const localPt = this._screenToWorld3D(player.x, player.y, depthOffset);
        const stroke = {
          id: Math.random(),
          ownerSlot: player.slot,
          color: st.color,
          material: st.material,
          radius: BRUSH_RADII[st.size] || 0.16,
          points: [localPt.clone()],
          group: null,
          tubeMesh: null,
          startCap: null,
          endCap: null,
          matObj: null,
        };
        this.strokes.push(stroke);
        if (this.strokes.length > 48) this._removeStroke(this.strokes[0]);
        this.activeStrokes.set(player.slot, stroke);
        this._rebuildStrokeMesh(stroke);
        this._updateHud();
      }
    } else if (actionName === 'btn_a_up') {
      this.activeStrokes.delete(player.slot);
    }
  }

  onGesture(player, gesture) {
    if (gesture.kind === 'shake') {
      // Gentle artistic burst swirl
      this.autoOrbit = !this.autoOrbit;
      this._renderToolbar();
    }
  }

  _eraseAt(player, worldLocalPt) {
    const eraseRadius = 0.62;
    let erasedAny = false;

    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const s = this.strokes[i];
      if (this.activeStrokes.get(player.slot) === s) continue;
      let hit = false;
      for (const pt of s.points) {
        if (pt.distanceTo(worldLocalPt) < eraseRadius + s.radius) {
          hit = true;
          break;
        }
      }
      if (hit) {
        this._spawnDust(worldLocalPt, s.color);
        this._removeStroke(s);
        erasedAny = true;
      }
    }

    if (erasedAny) {
      this.api.audio.playErase();
      this.api.sendFeedback(player.slot, { sfx: 'erase', vibrate: [16] });
      this._updateHud();
    }
  }

  _spawnDust(pt, color) {
    const geo = new THREE.SphereGeometry(0.06, 8, 8);
    for (let i = 0; i < 6; i++) {
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.4 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(pt);
      this.worldGroup.add(mesh);
      this.dust.push({
        mesh,
        vx: (Math.random() - 0.5) * 2.5,
        vy: Math.random() * 2.0,
        vz: (Math.random() - 0.5) * 2.5,
        life: 0.65,
      });
    }
  }

  _updateHud() {
    this.api.setHud({
      title: 'SCULPT 3D',
      stat1Label: 'STROKES',
      stat1Value: `${this.strokes.length}`,
      stat2Label: 'CO-OP',
      stat2Value: `${Math.max(1, this.api.getPlayers().length)} ACTIVE`,
      hint: 'Hold A to sculpt or erase in 3D · Hold B to spin camera · Pick colors & materials below or on your phone',
    });
  }

  update(dt, players) {
    if (!this.renderer) return;

    if (this.clearVote && performance.now() > this.clearVote.expiresAt) {
      this.clearVote = null;
      this.api.setOverlay('');
      this.api.broadcastToControllers({ type: 'to_controller', kind: 'clear_vote_closed', cleared: false });
      this.api.showToast('Clear request timed out', '#5C6474');
    }

    const anyoneSculpting = players.some((p) => p.a && this._getTool(p).tool === 'sculpt');
    const spinningPlayer = players.find((p) => p.b);

    if (spinningPlayer) {
      this.rotY += (spinningPlayer.x - 0.5) * dt * 2.8;
      this.targetRotX = (spinningPlayer.y - 0.5) * 1.1;
    } else if (this.autoOrbit) {
      this.rotY += dt * (anyoneSculpting ? 0.34 : 0.24);
      this.targetRotX = 0.22;
    }

    this.rotX += (this.targetRotX - this.rotX) * Math.min(1, dt * 4.5);
    this.worldGroup.rotation.y = this.rotY;
    this.worldGroup.rotation.x = this.rotX;

    const activeEraserSlots = new Set();
    const activePreviewSlots = new Set();

    for (const p of players) {
      const st = this._getTool(p);
      const prev = this.lastPos.get(p.slot) || { x: p.x, y: p.y };
      const moveDist = Math.hypot(p.x - prev.x, p.y - prev.y);
      this.lastPos.set(p.slot, { x: p.x, y: p.y });

      const depthOffset = Math.sin(performance.now() * 0.0018 + p.slot * 1.7) * 0.75 + (p.roll || 0) * 0.45;
      const localPt = this._screenToWorld3D(p.x, p.y, depthOffset);

      // Show floating 3D translucent eraser sphere OR glossy 3D brush tip preview!
      if (st.tool === 'erase') {
        activeEraserSlots.add(p.slot);
        let sphere = this.eraserSpheres.get(p.slot);
        if (!sphere) {
          sphere = new THREE.Mesh(
            new THREE.SphereGeometry(0.45, 20, 16),
            new THREE.MeshBasicMaterial({ color: 0xe11d48, wireframe: true, transparent: true, opacity: 0.5 })
          );
          this.worldGroup.add(sphere);
          this.eraserSpheres.set(p.slot, sphere);
        }
        sphere.position.copy(localPt);
        sphere.scale.setScalar(p.a ? 1.25 : 0.9);
      } else if (!p.a) {
        activePreviewSlots.add(p.slot);
        let preview = this.brushPreviews.get(p.slot);
        if (!preview) {
          if (!this.capSphereGeo) this.capSphereGeo = new THREE.SphereGeometry(1, 22, 16);
          preview = new THREE.Mesh(
            this.capSphereGeo,
            new THREE.MeshPhysicalMaterial({
              color: st.color,
              roughness: 0.2,
              clearcoat: 0.8,
              transparent: true,
              opacity: 0.55,
            })
          );
          this.worldGroup.add(preview);
          this.brushPreviews.set(p.slot, preview);
        }
        preview.material.color.set(st.color);
        preview.position.copy(localPt);
        preview.scale.setScalar(BRUSH_RADII[st.size] || 0.16);
      }

      if (p.a) {
        if (st.tool === 'erase') {
          this._eraseAt(p, localPt);
        } else {
          let stroke = this.activeStrokes.get(p.slot);
          if (!stroke) {
            stroke = {
              id: Math.random(),
              ownerSlot: p.slot,
              color: st.color,
              material: st.material,
              radius: BRUSH_RADII[st.size] || 0.16,
              points: [],
              group: null,
              tubeMesh: null,
              startCap: null,
              endCap: null,
              matObj: null,
            };
            this.strokes.push(stroke);
            if (this.strokes.length > 48) this._removeStroke(this.strokes[0]);
            this.activeStrokes.set(p.slot, stroke);
          }

          const last3 = stroke.points[stroke.points.length - 1];
          if (!last3 || last3.distanceTo(localPt) > 0.085) {
            stroke.points.push(localPt.clone());
            if (stroke.points.length > 150) stroke.points.shift();
            // Rebuild immediately from point #1 so the rounded start cap appears instantly!
            this._rebuildStrokeMesh(stroke);
            this._updateHud();
            if (moveDist > 0.015) {
              this.api.audio.playAetherNote(p.y, Math.min(1.2, moveDist * 30), p.roll || 0);
            }
          }
        }
      } else if (this.activeStrokes.has(p.slot)) {
        this.activeStrokes.delete(p.slot);
      }
    }

    // Remove unused eraser spheres & brush previews
    for (const [slot, sphere] of this.eraserSpheres.entries()) {
      if (!activeEraserSlots.has(slot)) {
        this.worldGroup.remove(sphere);
        sphere.geometry.dispose();
        sphere.material.dispose();
        this.eraserSpheres.delete(slot);
      }
    }
    for (const [slot, prevMesh] of this.brushPreviews.entries()) {
      if (!activePreviewSlots.has(slot)) {
        this.worldGroup.remove(prevMesh);
        prevMesh.material.dispose();
        this.brushPreviews.delete(slot);
      }
    }

    // Update erase dust particles
    for (let i = this.dust.length - 1; i >= 0; i--) {
      const d = this.dust[i];
      d.mesh.position.x += d.vx * dt;
      d.mesh.position.y += d.vy * dt;
      d.mesh.position.z += d.vz * dt;
      d.vy -= 4.2 * dt;
      d.life -= dt;
      d.mesh.scale.setScalar(Math.max(0.01, d.life));
      if (d.life <= 0) {
        this.worldGroup.remove(d.mesh);
        d.mesh.material.dispose();
        this.dust.splice(i, 1);
      }
    }
  }

  render(ctx, width, height) {
    // Clean minimal ceramic studio gradient behind Three.js WebGL layer
    const bg = ctx.createRadialGradient(width * 0.5, height * 0.45, 40, width * 0.5, height * 0.5, width * 0.72);
    bg.addColorStop(0, '#FFFFFF');
    bg.addColorStop(1, '#E8ECF2');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    if (this.renderer) {
      this.renderer.render(this.scene, this.camera);
    }
  }

  getSyncState(forceFull = false) {
    const out = {
      rotY: +this.rotY.toFixed(4),
      rotX: +this.rotX.toFixed(4),
      autoOrbit: this.autoOrbit,
      seq: this._syncSeq,
    };
    if (forceFull || this._syncSeq !== this._lastSentSeq) {
      this._lastSentSeq = this._syncSeq;
      out.strokes = this.strokes.map((s) => ({
        id: s.id,
        ownerSlot: s.ownerSlot,
        color: s.color,
        material: s.material,
        radius: s.radius,
        pts: s.points.map((p) => [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)]),
      }));
    }
    return out;
  }

  applySyncState(s) {
    if (!s || !this.worldGroup) return;
    this._targetSyncRotY = s.rotY;
    this._targetSyncRotX = s.rotX;
    this.autoOrbit = Boolean(s.autoOrbit);

    if (Array.isArray(s.strokes)) {
      const incomingIds = new Set(s.strokes.map((st) => st.id));
      for (let i = this.strokes.length - 1; i >= 0; i--) {
        if (!incomingIds.has(this.strokes[i].id)) {
          this._removeStroke(this.strokes[i]);
        }
      }

      const byId = new Map(this.strokes.map((st) => [st.id, st]));
      for (const st of s.strokes) {
        let local = byId.get(st.id);
        if (!local) {
          local = {
            id: st.id,
            ownerSlot: st.ownerSlot,
            color: st.color,
            material: st.material,
            radius: st.radius,
            points: st.pts.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
            group: null,
            tubeMesh: null,
            startCap: null,
            endCap: null,
            matObj: null,
          };
          this.strokes.push(local);
          this._rebuildStrokeMesh(local);
        } else if (local.points.length !== st.pts.length) {
          local.points = st.pts.map(([x, y, z]) => new THREE.Vector3(x, y, z));
          this._rebuildStrokeMesh(local);
        }
      }
      this._updateHud();
    }
  }

  updateMirror(dt) {
    if (!this.worldGroup) return;
    if (typeof this._targetSyncRotY === 'number') {
      const a = 1 - Math.exp(-dt * 18);
      this.rotY += (this._targetSyncRotY - this.rotY) * a;
      this.rotX += (this._targetSyncRotX - this.rotX) * a;
    }
    this.worldGroup.rotation.y = this.rotY;
    this.worldGroup.rotation.x = this.rotX;
  }
}
