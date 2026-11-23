import { PLAYER_PROFILES, MODE_INFO, clamp, decodeMotionPacket, OneEuroFilter } from '../shared/protocol.js';
import { AeroAudio } from '../shared/audio.js';
import { springUI, bindSpringButtons } from '../shared/spring.js';
import { MochiCompanion } from './companion.js';
import { BladeMode } from './modes/blade.js';
import { SculptMode } from './modes/sculpt.js';
import { StrikeMode } from './modes/strike.js';
import { SketchMode } from './modes/sketch.js';

const els = {
  bootSplash: document.getElementById('bootSplash'),
  bootBarFill: document.getElementById('bootBarFill'),
  bootSub: document.getElementById('bootSub'),
  mochiWidget: document.getElementById('mochiWidget'),
  mochiCanvas: document.getElementById('mochiCanvas'),
  mochiBubble: document.getElementById('mochiBubble'),
  stageCanvas: document.getElementById('stageCanvas'),
  sculptCanvas: document.getElementById('sculptCanvas'),
  cursorCanvas: document.getElementById('cursorCanvas'),
  consoleBar: document.getElementById('consoleBar'),
  brandHome: document.getElementById('brandHome'),
  mirrorBadge: document.getElementById('mirrorBadge'),
  btnHome: document.getElementById('btnHome'),
  gameHud: document.getElementById('gameHud'),
  hudMode: document.getElementById('hudMode'),
  hudStat1Label: document.getElementById('hudStat1Label'),
  hudStat1Val: document.getElementById('hudStat1Val'),
  hudStat2Label: document.getElementById('hudStat2Label'),
  hudStat2Val: document.getElementById('hudStat2Val'),
  gameHintBar: document.getElementById('gameHintBar'),
  modeDock: document.getElementById('modeDock'),
  overlayHost: document.getElementById('overlayHost'),
  playerSlots: [...document.querySelectorAll('#playerSlots .slot-pill')],
  btnSim: document.getElementById('btnSim'),
  btnDiag: document.getElementById('btnDiag'),
  btnTips: document.getElementById('btnTips'),
  btnPairToggle: document.getElementById('btnPairToggle'),
  btnMute: document.getElementById('btnMute'),
  btnFullscreen: document.getElementById('btnFullscreen'),
  diagPanel: document.getElementById('diagPanel'),
  diagTransport: document.getElementById('diagTransport'),
  diagGraph: document.getElementById('diagGraph'),
  diagSensorHz: document.getElementById('diagSensorHz'),
  diagRecvHz: document.getElementById('diagRecvHz'),
  diagFps: document.getElementById('diagFps'),
  diagAvgGap: document.getElementById('diagAvgGap'),
  diagP95Gap: document.getElementById('diagP95Gap'),
  diagMaxGap: document.getElementById('diagMaxGap'),
  diagVerdict: document.getElementById('diagVerdict'),
  btnDiagCopy: document.getElementById('btnDiagCopy'),
  btnDiagReset: document.getElementById('btnDiagReset'),
  btnDiagClose: document.getElementById('btnDiagClose'),
  toastStack: document.getElementById('toastStack'),
  hubLayer: document.getElementById('hubLayer'),
  hubMetaPill: document.getElementById('hubMetaPill'),
  modeCards: [...document.querySelectorAll('.mode-card')],
  roomCodeBadge: document.getElementById('roomCodeBadge'),
  qrBox: document.getElementById('qrBox'),
  qrUrl: document.getElementById('qrUrl'),
  btnCopyUrl: document.getElementById('btnCopyUrl'),
  btnCopyModal: document.getElementById('btnCopyModal'),
  btnCopyWatch: document.getElementById('btnCopyWatch'),
  btnCopyWatchModal: document.getElementById('btnCopyWatchModal'),
  btnCycleIp: document.getElementById('btnCycleIp'),
  qrModal: document.getElementById('qrModal'),
  modalRoomCode: document.getElementById('modalRoomCode'),
  modalQrBox: document.getElementById('modalQrBox'),
  modalQrUrl: document.getElementById('modalQrUrl'),
  streamRateBadge: document.getElementById('streamRateBadge'),
  teleYaw: document.getElementById('teleYaw'),
  telePitch: document.getElementById('telePitch'),
  teleRoll: document.getElementById('teleRoll'),
};

const stageCtx = els.stageCanvas.getContext('2d');
const cursorCtx = els.cursorCanvas.getContext('2d');
const audio = new AeroAudio('host');

// Initialize interactive soft-shaded Mochi companion
const mochi = new MochiCompanion(els.mochiCanvas);

// Bind tactile damped spring physics to all static studio buttons & cards!
bindSpringButtons(document);

const unlockOnce = () => audio.unlock();
window.addEventListener('pointerdown', unlockOnce, { passive: true });
window.addEventListener('keydown', unlockOnce, { passive: true });

// Core State
const urlParams = new URLSearchParams(window.location.search);
let ws = null;
let roomCode = (urlParams.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
let latestJoinUrl = '';
let latestWatchUrl = '';
let isPrimaryHost = true;
let remoteViewerCount = 0;
let lastSyncPushMs = 0;
let netIps = [];
let ipIdx = 0;
let currentModeId = 'hub';
let stageW = window.innerWidth;
let stageH = window.innerHeight;
let dpr = Math.min(2, window.devicePixelRatio || 1);
let mochiBubbleTimer = null;
let hubBgDirty = true;

const MOCHI_GREETINGS = [
  'Ready to play',
  'Wave your phone to aim',
  'Try Sculpt 3D with friends',
  'Mochi approves',
  'Let’s break a record',
];

function sayMochi(text, duration = 2200) {
  els.mochiBubble.textContent = text;
  els.mochiBubble.classList.add('visible');
  clearTimeout(mochiBubbleTimer);
  mochiBubbleTimer = setTimeout(() => {
    els.mochiBubble.classList.remove('visible');
  }, duration);
}

// Animated Boot Loading Sequence (smooth 900ms spring reveal)
let bootDone = false;
const bootStartMs = performance.now();
function updateBoot(nowMs) {
  if (bootDone) return;
  const p = Math.min(1, (nowMs - bootStartMs) / 880);
  const eased = 1 - Math.pow(1 - p, 3);
  els.bootBarFill.style.transform = `scaleX(${eased.toFixed(3)})`;
  if (p >= 1) {
    bootDone = true;
    els.bootSplash.classList.add('done');
    els.mochiWidget.classList.remove('boot-center');
    setTimeout(() => {
      mochi.resize();
      mochi.react('happy');
      sayMochi('Welcome to AERO Studio', 2400);
    }, 320);
  }
}

// Click Mochi companion directly to interact!
els.mochiWidget.addEventListener('click', () => {
  audio.playChirp('happy');
  mochi.react('poke');
  const line = MOCHI_GREETINGS[Math.floor(Math.random() * MOCHI_GREETINGS.length)];
  sayMochi(line, 1900);
});

// Connected physical phones: Map<slot, PlayerState>
const phonePlayers = new Map();
let simEnabled = false;
const simPlayer = {
  slot: 99,
  isSim: true,
  profile: { slot: 0, label: 'SIM', name: 'COBALT', color: '#2563EB', glow: 'rgba(37, 99, 235, 0.35)', soft: '#93C5FD' },
  x: 0.5,
  y: 0.5,
  roll: 0,
  pitchDeg: 0,
  yawDeg: 0,
  rollDeg: 0,
  g: 0,
  swingPower: 0,
  a: 0,
  b: 0,
  lastX: 0.5,
  lastY: 0.5,
  hoveredCard: null,
  cursorTrail: [],
};

function getActivePlayers() {
  const list = [...phonePlayers.values()].sort((a, b) => a.slot - b.slot);
  if (simEnabled) {
    simPlayer.profile.color = phonePlayers.has(0) ? '#18181B' : '#2563EB';
    list.push(simPlayer);
  }
  return list;
}

function showToast(text, color = '#2563EB') {
  const el = document.createElement('div');
  el.className = 'toast';
  el.style.setProperty('--toast-color', color);
  el.innerHTML = `<span class="toast-dot"></span><span></span>`;
  el.querySelector('span:last-child').textContent = text;
  els.toastStack.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 0.22s ease, transform 0.22s ease';
    el.style.opacity = '0';
    el.style.transform = 'translateY(-8px)';
    setTimeout(() => el.remove(), 230);
  }, 2300);
}

function sendWs(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// Host API passed to all 4 modes
const modeApi = {
  audio,
  isPrimary: () => isPrimaryHost,
  getSize: () => ({ width: stageW, height: stageH }),
  getPlayers: () => getActivePlayers(),
  showToast,
  goHub: () => {
    if (isPrimaryHost) switchMode('hub');
  },
  reactCompanion(kind, color) {
    mochi.react(kind, color);
  },
  sendFeedback(slot, payload) {
    if (!isPrimaryHost || slot === 99) return;
    sendWs({ type: 'feedback', slot, ...payload });
  },
  sendToController(slot, payload) {
    if (!isPrimaryHost || slot === 99) return;
    sendWs({ ...payload, type: 'to_controller', slot });
  },
  broadcastToControllers(payload, excludeSlot = -1) {
    if (!isPrimaryHost) return;
    sendWs({ ...payload, type: 'to_controller', excludeSlot });
  },
  setDock(html) {
    els.modeDock.innerHTML = html || '';
    els.gameHintBar.classList.toggle('hidden', currentModeId === 'hub' || Boolean(html));
  },
  setOverlay(html) {
    els.overlayHost.innerHTML = html || '';
    if (html) bindSpringButtons(els.overlayHost);
  },
  setHud({ title, stat1Label, stat1Value, stat2Label, stat2Value, hint }) {
    els.hudMode.textContent = title;
    els.hudStat1Label.textContent = stat1Label;
    els.hudStat1Val.textContent = stat1Value;
    els.hudStat2Label.textContent = stat2Label;
    els.hudStat2Val.textContent = stat2Value;
    if (hint !== undefined) {
      els.gameHintBar.textContent = hint;
    }
  },
};

const modes = {
  blade: new BladeMode(modeApi),
  sculpt: new SculptMode(modeApi),
  strike: new StrikeMode(modeApi),
  sketch: new SketchMode(modeApi),
};

const TIPS_SKIP_KEY = 'aero_skip_tips_v1';
let activeTipsDismiss = null;

const MODE_TIPS = {
  hub: {
    title: 'How the Motion Remote Works',
    kicker: 'QUICK TIPS',
    items: [
      ['WRIST AIM', 'Hold your phone flat like a TV remote pointed at the screen. Turn gently from your wrist left/right and pitch up/down — small turns reach the whole screen.'],
      ['RECENTER', 'If the pointer ever drifts off-center, point at the middle of your monitor and tap Recenter on your phone.'],
      ['SENSITIVITY', 'Tap LOW / MED / HIGH in the top bar of your phone controller anytime to speed up or slow down left/right aim.'],
    ],
  },
  blade: {
    title: 'Blade Arena',
    kicker: 'BEFORE YOU START',
    items: [
      ['WHIP', 'Flick your wrist quickly across prisms to slice them cleanly in half and build combo multipliers.'],
      ['3 LIVES', 'Avoid red spike mines and don’t let target prisms drop — lose 3 ruby gems and you are eliminated.'],
      ['A / B', 'Press A for a wrist-angled Power Slash; hold B to trigger Focus Slow-Mo.'],
    ],
  },
  sculpt: {
    title: 'Sculpt 3D',
    kicker: 'BEFORE YOU START',
    items: [
      ['HOLD A', 'Hold A and wave your phone to sculpt real 3D clay, lacquer, or chrome forms (or sweep the 3D eraser).'],
      ['HOLD B', 'Hold B and tilt your phone to orbit and inspect your 3D sculpture from all 360 degrees.'],
      ['CO-OP', 'Every friend picks their own colors and eraser on their phone. Clearing asks everyone to agree first.'],
    ],
  },
  strike: {
    title: 'Strike Table',
    kicker: 'BEFORE YOU START',
    items: [
      ['DEFEND', 'Steer your striker across your half of the table using smooth wrist movement.'],
      ['PRESS A', 'Tap A right on impact (or whip fast) to fire a Power Smash shot.'],
      ['FIRST TO 7', 'Solo plays against Mochi AI; 2 phones become 1v1; 3–4 phones become 2v2.'],
    ],
  },
  sketch: {
    title: 'Air Sketch',
    kicker: 'BEFORE YOU START',
    items: [
      ['ARTIST', 'The secret word appears privately on only the artist’s phone. Hold A to draw with Pen, Brush, Fill Bucket, or Eraser.'],
      ['FILL BUCKET', 'Select the Paint Bucket icon and tap A inside any closed shape to flood-fill it with color.'],
      ['GUESSERS', 'Everyone else types guesses live from their phone (or clicks the Check icon when solved over voice chat).'],
    ],
  },
};

function showTipsModal(modeId, onStart = null) {
  const info = MODE_TIPS[modeId] || MODE_TIPS.hub;
  const skipPref = localStorage.getItem(TIPS_SKIP_KEY) === '1';

  const itemsHtml = info.items
    .map(([k, text]) => `<div class="tip-item"><span class="tip-key">${k}</span><span>${text}</span></div>`)
    .join('');

  modeApi.setOverlay(`
    <div class="studio-modal">
      <div class="modal-kicker">${info.kicker}</div>
      <h2 class="modal-title">${info.title}</h2>
      <div class="tip-diagram">
        <div class="tip-diagram-copy">
          <strong>Hold flat &amp; point top edge at screen.</strong> Steer from your wrist — a gentle <strong>±16°</strong> left/right turn covers the full width. Tap <strong>Recenter</strong> anytime.
        </div>
      </div>
      <div class="tip-list">${itemsHtml}</div>
      ${
        onStart
          ? `<label class="tip-skip"><input id="tipSkipCheck" type="checkbox" ${skipPref ? 'checked' : ''} />Don’t show tips before starting</label>`
          : ''
      }
      <div class="modal-actions">
        <button id="tipStartBtn" class="studio-btn primary" data-spring="btn" type="button">${onStart ? 'Start (or Press A)' : 'Got It'}</button>
      </div>
    </div>
  `);

  const dismiss = () => {
    const chk = document.getElementById('tipSkipCheck');
    if (chk) {
      try {
        localStorage.setItem(TIPS_SKIP_KEY, chk.checked ? '1' : '0');
      } catch (_) {}
    }
    activeTipsDismiss = null;
    modeApi.setOverlay('');
    audio.playClick(1.22);
    if (onStart) onStart();
  };

  activeTipsDismiss = dismiss;
  document.getElementById('tipStartBtn')?.addEventListener('click', dismiss);
}

function switchMode(modeId, { autoSimIfEmpty = false, bypassTips = false } = {}) {
  const nextId = modes[modeId] ? modeId : 'hub';

  // Show helpful Quick Tips briefing once before entering a mode (unless skipped)
  const skipTips = localStorage.getItem(TIPS_SKIP_KEY) === '1';
  if (nextId !== 'hub' && !bypassTips && !skipTips) {
    showTipsModal(nextId, () => switchMode(nextId, { autoSimIfEmpty, bypassTips: true }));
    return;
  }

  activeTipsDismiss = null;

  if (currentModeId !== 'hub' && modes[currentModeId]) {
    modes[currentModeId].exit();
  }

  currentModeId = nextId;
  document.body.classList.toggle('strike-active', currentModeId === 'strike');
  els.qrModal.classList.add('hidden');
  els.modeDock.innerHTML = '';
  els.overlayHost.innerHTML = '';

  if (currentModeId === 'hub') {
    hubBgDirty = true;
    els.hubLayer.classList.remove('hidden');
    els.btnHome.classList.add('hidden');
    els.gameHud.classList.add('hidden');
    els.gameHintBar.classList.add('hidden');
    els.btnPairToggle.classList.add('hidden');
    els.mochiWidget.classList.remove('compact');
    setTimeout(() => {
      cacheModeCardRects();
      mochi.resize();
    }, 60);
  } else {
    if (autoSimIfEmpty && phonePlayers.size === 0 && !simEnabled) {
      setSimEnabled(true);
    }
    els.hubLayer.classList.add('hidden');
    els.btnHome.classList.toggle('hidden', !isPrimaryHost);
    els.gameHud.classList.remove('hidden');
    els.gameHintBar.classList.remove('hidden');
    els.btnPairToggle.classList.remove('hidden');
    els.mochiWidget.classList.add('compact');
    setTimeout(() => mochi.resize(), 120);
    modes[currentModeId].enter();
  }

  audio.playClick(currentModeId === 'hub' ? 0.92 : 1.24);
  if (isPrimaryHost) {
    sendWs({
      type: 'mode_change',
      mode: currentModeId,
      hints: MODE_INFO[currentModeId] || MODE_INFO.hub,
    });
    if (remoteViewerCount > 0) {
      setTimeout(() => pushStateSync(true, performance.now()), 60);
    }
  }
}

function updateMirrorBadge() {
  if (!els.mirrorBadge) return;
  if (!isPrimaryHost) {
    els.mirrorBadge.textContent = 'SYNCED SCREEN';
    els.mirrorBadge.classList.remove('hidden', 'host-live');
    els.btnHome.classList.add('hidden');
    els.btnSim.classList.add('hidden');
  } else {
    els.btnSim.classList.remove('hidden');
    els.btnHome.classList.toggle('hidden', currentModeId === 'hub');
    if (remoteViewerCount > 0) {
      els.mirrorBadge.textContent = `+${remoteViewerCount} LIVE ${remoteViewerCount === 1 ? 'SCREEN' : 'SCREENS'}`;
      els.mirrorBadge.classList.remove('hidden');
      els.mirrorBadge.classList.add('host-live');
    } else {
      els.mirrorBadge.classList.add('hidden');
      els.mirrorBadge.classList.remove('host-live');
    }
  }
}

function pushStateSync(forceFull = false, nowMs = performance.now()) {
  if (!isPrimaryHost || remoteViewerCount <= 0 || currentModeId === 'hub') return;
  const mode = modes[currentModeId];
  if (!mode || typeof mode.getSyncState !== 'function') return;

  const intervalMs = currentModeId === 'strike' ? 33 : currentModeId === 'blade' ? 40 : 65;
  if (!forceFull && nowMs - lastSyncPushMs < intervalMs) return;
  lastSyncPushMs = nowMs;

  const state = mode.getSyncState(forceFull);
  sendWs({
    type: 'state_sync',
    mode: currentModeId,
    state,
  });
}

function updateSlotIndicators() {
  const count = phonePlayers.size;
  els.hubMetaPill.innerHTML =
    count > 0
      ? `${count} / 4 phones · <strong id="fpsBadge">${liveFps} FPS</strong>`
      : simEnabled
        ? `Mouse active · <strong id="fpsBadge">${liveFps} FPS</strong>`
        : `0 / 4 linked · <strong id="fpsBadge">${liveFps} FPS</strong>`;

  els.playerSlots.forEach((pill) => {
    const slot = Number(pill.dataset.slot);
    const p = phonePlayers.get(slot);
    const dot = pill.querySelector('.slot-dot');
    if (p) {
      pill.classList.add('connected');
      dot.style.background = p.profile.color;
    } else {
      pill.classList.remove('connected');
      dot.style.background = '#d5dae3';
    }
  });
}

function setSimEnabled(flag) {
  simEnabled = !!flag;
  els.btnSim.classList.toggle('active', simEnabled);
  els.btnSim.dataset.tip = simEnabled ? 'Mouse On (Click to disable)' : 'Mouse Control';
  els.btnSim.setAttribute('aria-label', simEnabled ? 'Mouse Control On' : 'Mouse Control Off');
  updateSlotIndicators();
}

let qrLinkMode = 'auto'; // 'auto' (Cloudflare Trusted HTTPS when ready) | 'lan'

async function refreshQr() {
  if (!roomCode) return;
  try {
    if (netIps.length === 0) {
      const infoRes = await fetch(`/api/info?room=${encodeURIComponent(roomCode)}`);
      const info = await infoRes.json();
      netIps = info.ips || [{ name: 'local', ip: info.primaryIp }];
    }
    const chosen = netIps[ipIdx % netIps.length];
    const qrRes = await fetch(
      `/api/qr?ip=${encodeURIComponent(chosen.ip)}&room=${encodeURIComponent(roomCode)}&mode=${encodeURIComponent(qrLinkMode)}`
    );
    const qrData = await qrRes.json();
    latestJoinUrl = qrData.url;
    latestWatchUrl = qrData.watchUrl || `${window.location.origin}/?room=${encodeURIComponent(roomCode)}`;

    els.roomCodeBadge.textContent = roomCode;
    els.modalRoomCode.textContent = roomCode;
    els.qrBox.innerHTML = qrData.svg;
    els.modalQrBox.innerHTML = qrData.svg;

    // Display a clean concise label for the URL (strip internal query params visually for tidiness)
    try {
      const u = new URL(qrData.url);
      const display = `${u.origin}/controller?room=${roomCode}`;
      els.qrUrl.textContent = display;
      els.modalQrUrl.textContent = display;
    } catch {
      els.qrUrl.textContent = qrData.url;
      els.modalQrUrl.textContent = qrData.url;
    }

    if (qrData.hasTunnel) {
      els.btnCycleIp.style.display = 'inline-block';
      els.btnCycleIp.textContent = qrData.sourceKind === 'trusted' ? 'Trusted HTTPS · Switch to LAN' : 'LAN · Switch to Trusted';
    } else if (!qrData.isCloud && netIps.length > 1) {
      els.btnCycleIp.style.display = 'inline-block';
      els.btnCycleIp.textContent = `IP: ${chosen.name} (${ipIdx + 1}/${netIps.length})`;
    } else {
      els.btnCycleIp.style.display = 'none';
    }
  } catch (_) {
    els.qrUrl.textContent = 'Unable to load pairing info';
  }
}

async function copyJoinLink() {
  if (!latestJoinUrl) return;
  try {
    await navigator.clipboard.writeText(latestJoinUrl);
    showToast('Phone controller link copied', '#2563EB');
    audio.playClick(1.3);
  } catch (_) {
    showToast(latestJoinUrl, '#2563EB');
  }
}

async function copyWatchLink() {
  if (!latestWatchUrl) return;
  try {
    await navigator.clipboard.writeText(latestWatchUrl);
    showToast('Remote PC Screen link copied — share with a friend abroad!', '#059669');
    audio.playClick(1.32);
  } catch (_) {
    showToast(latestWatchUrl, '#059669');
  }
}

els.btnCopyUrl.addEventListener('click', copyJoinLink);
els.btnCopyModal.addEventListener('click', copyJoinLink);
els.btnCopyWatch?.addEventListener('click', copyWatchLink);
els.btnCopyWatchModal?.addEventListener('click', copyWatchLink);
els.btnCycleIp.addEventListener('click', () => {
  if (els.btnCycleIp.textContent.includes('Trusted')) {
    qrLinkMode = qrLinkMode === 'auto' ? 'lan' : 'auto';
  } else {
    ipIdx = (ipIdx + 1) % Math.max(1, netIps.length);
  }
  refreshQr();
});

// =========================================================================
// DIRECT LAN UDP (WEBRTC) + BINARY WEBSOCKET CONNECTION
// =========================================================================
const rtcPeers = new Map(); // slot -> { pc, ready, queue }

function closeHostRtc(slot) {
  const entry = rtcPeers.get(slot);
  if (entry) {
    try { entry.pc.close(); } catch (_) {}
    rtcPeers.delete(slot);
  }
}

// =========================================================================
// LIVE MOTION & LATENCY DIAGNOSTICS TELEMETRY
// =========================================================================
const diag = {
  open: false,
  gaps: [],
  maxGapMs: 0,
  stalls60: 0,
  stalls120: 0,
  totalPkts: 0,
  winPkts: 0,
  winStartMs: performance.now(),
  recvHz: 0,
  frameMaxMs: 0,
  lastRenderMs: 0,
};

function resetDiag() {
  diag.gaps = [];
  diag.maxGapMs = 0;
  diag.stalls60 = 0;
  diag.stalls120 = 0;
  diag.totalPkts = 0;
  diag.winPkts = 0;
  diag.winStartMs = performance.now();
  diag.recvHz = 0;
  diag.frameMaxMs = 0;
}

function toggleDiag(forceState) {
  diag.open = typeof forceState === 'boolean' ? forceState : !diag.open;
  els.diagPanel?.classList.toggle('hidden', !diag.open);
  els.btnDiag?.classList.toggle('active', diag.open);
}

function buildDiagSnapshot() {
  const p0 = [...phonePlayers.values()].sort((a, b) => a.slot - b.slot)[0];
  const sorted = [...diag.gaps].sort((a, b) => a - b);
  const avg = sorted.length ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0;
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
  return {
    mode: currentModeId,
    transport: p0 ? p0.transport || 'WS' : 'NONE',
    sensorMode: p0 ? p0.sensorMode : 'none',
    sensorHz: p0 ? p0.sampleHz || 0 : 0,
    pcRecvHz: diag.recvHz,
    pcFps: liveFps,
    pcMaxFrameMs: +diag.frameMaxMs.toFixed(1),
    avgGapMs: +avg.toFixed(1),
    p95GapMs: +p95.toFixed(1),
    maxStallMs: +diag.maxGapMs.toFixed(1),
    stallsOver60ms: diag.stalls60,
    stallsOver120ms: diag.stalls120,
    totalPackets: diag.totalPkts,
    origin: window.location.origin,
    joinUrl: latestJoinUrl,
  };
}

function renderDiagHud(nowMs) {
  if (!diag.open || nowMs - diag.lastRenderMs < 140) return;
  diag.lastRenderMs = nowMs;

  const snap = buildDiagSnapshot();
  els.diagTransport.textContent = snap.transport;
  els.diagTransport.classList.toggle('ok', snap.transport === 'NATIVE' || snap.transport === 'UDP');
  els.diagTransport.classList.toggle('warn', snap.transport === 'WS');

  els.diagSensorHz.textContent = snap.sensorHz ? `${snap.sensorHz}Hz` : '--';
  els.diagRecvHz.textContent = snap.pcRecvHz ? `${snap.pcRecvHz}/s` : '--';
  els.diagFps.textContent = `${snap.pcFps} (${snap.pcMaxFrameMs}ms)`;
  els.diagAvgGap.textContent = snap.totalPackets ? `${snap.avgGapMs}ms` : '--';
  els.diagP95Gap.textContent = snap.totalPackets ? `${snap.p95GapMs}ms` : '--';
  els.diagMaxGap.textContent = snap.totalPackets ? `${snap.maxStallMs}ms` : '--';

  let verdict = 'Connect a phone and wave it for 5 seconds to diagnose motion smoothness.';
  if (snap.transport === 'NATIVE' && snap.p95GapMs <= 14 && snap.stallsOver60ms === 0) {
    verdict = `Optimal: Direct ${snap.pcRecvHz}Hz raw LAN UDP locked with zero stalls.`;
  } else if (snap.transport === 'WS' && snap.stallsOver60ms > 0) {
    verdict = `TCP Stall Detected (${snap.stallsOver60ms} pauses >60ms, max ${snap.maxStallMs}ms). Traffic is over WS TCP instead of LAN UDP — check Windows Firewall (Public profile).`;
  } else if (snap.sensorHz > 0 && snap.pcRecvHz < snap.sensorHz * 0.55) {
    verdict = `Network bottleneck: Phone IMU is ${snap.sensorHz}Hz, but PC only receives ${snap.pcRecvHz} pkt/s (Wi-Fi/Firewall/Cloudflare).`;
  } else if (snap.pcMaxFrameMs > 30) {
    verdict = `PC Render hiccup detected (max frame ${snap.pcMaxFrameMs}ms at ${snap.pcFps} FPS).`;
  } else if (snap.totalPackets > 20) {
    verdict = `Running on ${snap.transport} · ${snap.pcRecvHz} pkt/s · ${snap.stallsOver60ms} stalls >60ms.`;
  }
  els.diagVerdict.textContent = verdict;

  const canvas = els.diagGraph;
  if (!canvas) return;
  const gctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  gctx.clearRect(0, 0, w, h);
  gctx.fillStyle = '#F3F4F6';
  gctx.fillRect(0, 0, w, h);

  // 16ms (60Hz) and 60ms (stall) guide lines
  const y16 = h - (16 / 100) * h;
  const y60 = h - (60 / 100) * h;
  gctx.strokeStyle = 'rgba(17, 19, 24, 0.1)';
  gctx.lineWidth = 1;
  gctx.beginPath();
  gctx.moveTo(0, y16); gctx.lineTo(w, y16);
  gctx.moveTo(0, y60); gctx.lineTo(w, y60);
  gctx.stroke();

  const gaps = diag.gaps;
  const n = gaps.length;
  if (n > 0) {
    const barW = w / 140;
    const startIdx = Math.max(0, n - 140);
    for (let i = startIdx; i < n; i++) {
      const gap = gaps[i];
      const bh = Math.max(2, Math.min(h, (gap / 100) * h));
      const x = (i - startIdx) * barW;
      gctx.fillStyle = gap >= 60 ? '#E11D48' : gap >= 22 ? '#D97706' : '#059669';
      gctx.fillRect(x, h - bh, Math.max(1.2, barW - 0.5), bh);
    }
  }
}

function ingestBinaryMotion(buffer, forcedSlot = null, transport = 'WS') {
  const m = decodeMotionPacket(buffer);
  if (!m) return;
  const slot = forcedSlot !== null ? forcedSlot : m.slot;
  const p = phonePlayers.get(slot);
  if (!p) return;
  const now = performance.now();

  if (p.lastPacketMs > 0) {
    const rawGapMs = now - p.lastPacketMs;
    const dtMs = clamp(rawGapMs, 3, 80);
    p.avgIntervalMs = p.avgIntervalMs * 0.85 + dtMs * 0.15;

    // Record primary player's true arrival gaps for live diagnostics
    const primarySlot = Math.min(...phonePlayers.keys());
    if (slot === primarySlot) {
      diag.totalPkts++;
      diag.winPkts++;
      if (rawGapMs < 2000) {
        diag.gaps.push(rawGapMs);
        if (diag.gaps.length > 160) diag.gaps.shift();
        if (rawGapMs > diag.maxGapMs) diag.maxGapMs = rawGapMs;
        if (rawGapMs >= 60) diag.stalls60++;
        if (rawGapMs >= 120) diag.stalls120++;
      }
      if (now - diag.winStartMs >= 500) {
        diag.recvHz = Math.round((diag.winPkts * 1000) / (now - diag.winStartMs));
        diag.winPkts = 0;
        diag.winStartMs = now;
      }
    }
  }
  p.lastPacketMs = now;

  // Tune One-Euro filter tighter for native 200Hz+ raw UDP
  if (m.nativeUdp && p.filterX.minCutoff < 10) {
    p.filterX.minCutoff = 12.0;
    p.filterX.beta = 65.0;
    p.filterY.minCutoff = 12.0;
    p.filterY.beta = 65.0;
  }

  // Single-stage One-Euro filtering strictly on fast PC Host
  p.targetX = clamp(p.filterX.filter(m.x, now), 0, 1);
  p.targetY = clamp(p.filterY.filter(m.y, now), 0, 1);
  p.targetRoll = m.roll;
  p.targetYaw = m.yawDeg;
  p.targetPitch = m.pitchDeg;

  p.g = m.g;
  p.swingPower = m.sw;
  p.a = m.a;
  p.b = m.b;
  p.transport = m.nativeUdp ? 'NATIVE' : transport;
  p.sampleHz = m.hz || Math.round(1000 / Math.max(5, p.avgIntervalMs));
  p.lastUpdate = now;
}

async function handleHostRtcSignal(slot, msg) {
  if (typeof RTCPeerConnection === 'undefined') return;
  try {
    if (msg.offer) {
      closeHostRtc(slot);
      // Always include public STUN alongside fast LAN host candidates so Cloudflare-joined phones can ICE-pair too
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });
      const entry = { pc, ready: false, queue: [] };
      rtcPeers.set(slot, entry);

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          sendWs({ type: 'rtc_signal', slot, candidate: e.candidate });
        }
      };

      pc.ondatachannel = (ev) => {
        const dc = ev.channel;
        dc.binaryType = 'arraybuffer';
        dc.onmessage = (mev) => {
          if (mev.data instanceof ArrayBuffer) {
            ingestBinaryMotion(mev.data, slot, 'UDP');
          }
        };
      };

      await pc.setRemoteDescription(msg.offer);
      entry.ready = true;
      for (const c of entry.queue) {
        await pc.addIceCandidate(c).catch(() => {});
      }
      entry.queue.length = 0;

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendWs({ type: 'rtc_signal', slot, answer });
    } else if (msg.candidate) {
      const entry = rtcPeers.get(slot);
      if (!entry) return;
      if (entry.ready) await entry.pc.addIceCandidate(msg.candidate);
      else entry.queue.push(msg.candidate);
    }
  } catch (_) {}
}

function connectHostSocket() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const qs = new URLSearchParams({ role: 'host' });
  if (roomCode) qs.set('room', roomCode);
  ws = new WebSocket(`${proto}//${window.location.host}/ws?${qs.toString()}`);
  ws.binaryType = 'arraybuffer';

  ws.addEventListener('message', (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      ingestBinaryMotion(ev.data, null, 'WS');
      return;
    }

    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (msg.type === 'host_welcome') {
      roomCode = msg.roomCode;
      isPrimaryHost = msg.isPrimaryHost !== false;
      remoteViewerCount = msg.viewerCount || 0;
      updateMirrorBadge();
      refreshQr();
      if (Array.isArray(msg.players)) {
        for (const p of msg.players) addPhonePlayer(p, false);
      }
      updateSlotIndicators();
      if (!isPrimaryHost) {
        showToast(`Synced to Room ${roomCode} — scan QR with your phone to join!`, '#059669');
        if (msg.mode && msg.mode !== 'hub') {
          switchMode(msg.mode, { bypassTips: true });
        }
      }
    } else if (msg.type === 'host_role') {
      isPrimaryHost = msg.isPrimaryHost !== false;
      remoteViewerCount = msg.viewerCount || 0;
      updateMirrorBadge();
      if (isPrimaryHost) showToast('Promoted to Primary Host', '#2563EB');
    } else if (msg.type === 'viewers_changed') {
      const prev = remoteViewerCount;
      remoteViewerCount = msg.viewerCount || 0;
      updateMirrorBadge();
      if (remoteViewerCount > prev) {
        showToast(`Remote PC Screen synced (${remoteViewerCount} live)`, '#059669');
        mochi.react('happy');
      }
    } else if (msg.type === 'sync_request') {
      if (isPrimaryHost && currentModeId !== 'hub') {
        sendWs({ type: 'mode_change', mode: currentModeId, hints: MODE_INFO[currentModeId] || MODE_INFO.hub });
        pushStateSync(true, performance.now());
      }
    } else if (msg.type === 'mode_sync') {
      if (!isPrimaryHost && msg.mode !== currentModeId) {
        switchMode(msg.mode, { bypassTips: true });
      }
    } else if (msg.type === 'state_sync') {
      if (!isPrimaryHost && msg.mode) {
        if (msg.mode !== currentModeId) {
          switchMode(msg.mode, { bypassTips: true });
        }
        modes[msg.mode]?.applySyncState?.(msg.state);
      }
    } else if (msg.type === 'player_joined') {
      addPhonePlayer(msg.player, true);
      updateSlotIndicators();
    } else if (msg.type === 'player_left') {
      closeHostRtc(msg.slot);
      const removed = phonePlayers.get(msg.slot);
      phonePlayers.delete(msg.slot);
      updateSlotIndicators();
      if (removed) showToast(`${removed.profile.label} left`, '#5C6474');
    } else if (msg.type === 'tunnel_ready') {
      refreshQr();
      showToast('Trusted HTTPS ready — QR upgraded for 60–120Hz & global play', '#059669');
    } else if (msg.type === 'rtc_signal') {
      if (isPrimaryHost) handleHostRtcSignal(msg.slot, msg);
    } else if (msg.type === 'player_status') {
      const p = phonePlayers.get(msg.slot);
      if (p) p.sensorMode = msg.sensorMode;
    } else if (msg.type === 'action') {
      if (!isPrimaryHost) return;
      const p = phonePlayers.get(msg.slot);
      if (!p) return;
      handlePlayerAction(p, msg.name);
    } else if (msg.type === 'gesture') {
      if (!isPrimaryHost) return;
      const p = phonePlayers.get(msg.slot);
      if (!p) return;
      if (currentModeId !== 'hub' && modes[currentModeId]) {
        modes[currentModeId].onGesture(p, msg);
      }
    } else {
      if (!isPrimaryHost) return;
      const p = phonePlayers.get(msg.slot);
      if (p && currentModeId !== 'hub' && modes[currentModeId]?.onCustomMessage) {
        modes[currentModeId].onCustomMessage(p, msg);
      }
    }
  });

  ws.addEventListener('close', () => {
    setTimeout(connectHostSocket, 1500);
  });
}

function addPhonePlayer(info, announce = true) {
  const profile = info.profile || PLAYER_PROFILES[info.slot] || PLAYER_PROFILES[0];
  const now = performance.now();
  phonePlayers.set(info.slot, {
    slot: info.slot,
    id: info.id,
    profile,
    sensorMode: info.sensorMode || 'gyro',
    x: 0.5,
    y: 0.5,
    vx: 0,
    vy: 0,
    targetX: 0.5,
    targetY: 0.5,
    lastX: 0.5,
    lastY: 0.5,
    roll: 0,
    targetRoll: 0,
    pitchDeg: 0,
    targetPitch: 0,
    yawDeg: 0,
    targetYaw: 0,
    rollDeg: 0,
    g: 0,
    swingPower: 0,
    sampleHz: 60,
    avgIntervalMs: 16.7,
    filterX: new OneEuroFilter(5.2, 34.0, 2.0),
    filterY: new OneEuroFilter(5.2, 34.0, 2.0),
    a: 0,
    b: 0,
    hoveredCard: null,
    cursorTrail: [],
    lastPacketMs: 0,
    lastUpdate: now,
  });
  if (announce) {
    audio.playConnect(info.slot);
    mochi.react('pair', profile.color);
    sayMochi(`${profile.label} joined!`, 2200);
    showToast(`${profile.label} ${profile.name} connected`, profile.color);
  }
}

function handlePlayerAction(player, actionName) {
  if (actionName === 'home') {
    if (currentModeId !== 'hub') {
      switchMode('hub');
      showToast(`${player.profile.label} returned to Studio`, player.profile.color);
    }
    return;
  }

  if (actionName === 'recenter') {
    if (player.filterX) player.filterX.reset(0.5);
    if (player.filterY) player.filterY.reset(0.5);
    player.targetX = 0.5;
    player.targetY = 0.5;
    player.x = 0.5;
    player.y = 0.5;
    player.vx = 0;
    player.vy = 0;
    showToast(`${player.profile.label} recentered`, player.profile.color);
    return;
  }

  if (actionName === 'btn_a_down') player.a = 1;
  if (actionName === 'btn_a_up') player.a = 0;
  if (actionName === 'btn_b_down') player.b = 1;
  if (actionName === 'btn_b_up') player.b = 0;

  if (actionName === 'btn_a_down') {
    // Allow dismissing the Pre-Game Quick Tips briefing straight from your phone!
    if (activeTipsDismiss) {
      modeApi.sendFeedback(player.slot, { sfx: 'click', vibrate: [16] });
      activeTipsDismiss();
      return;
    }

    // Allow poking Mochi with the wireless phone!
    const mr = els.mochiWidget.getBoundingClientRect();
    const px = player.x * stageW;
    const py = player.y * stageH;
    if (px >= mr.left && px <= mr.right && py >= mr.top && py <= mr.bottom) {
      audio.playChirp('happy');
      mochi.react('poke', player.profile.color);
      modeApi.sendFeedback(player.slot, { sfx: 'chirp', vibrate: [16, 20, 18] });
      sayMochi(`Hi ${player.profile.label}!`, 1800);
      return;
    }
  }

  if (currentModeId === 'hub') {
    if (actionName === 'btn_a_down') {
      const hitMode = hitTestModeCards(player.x * stageW, player.y * stageH);
      if (hitMode) {
        const cardEl = els.modeCards.find((c) => c.dataset.mode === hitMode);
        if (cardEl) springUI.pulse(cardEl, 2.4);
        modeApi.sendFeedback(player.slot, { sfx: 'connect', vibrate: [22, 18, 30] });
        switchMode(hitMode);
      }
    }
    return;
  }

  if (modes[currentModeId]) {
    modes[currentModeId].onAction(player, actionName);
  }
}

let cachedCardRects = [];
function cacheModeCardRects() {
  cachedCardRects = els.modeCards.map((card) => ({
    el: card,
    mode: card.dataset.mode,
    rect: card.getBoundingClientRect(),
  }));
}

function hitTestModeCards(px, py) {
  if (cachedCardRects.length === 0) cacheModeCardRects();
  for (const item of cachedCardRects) {
    const r = item.rect;
    if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) {
      return item.mode;
    }
  }
  return null;
}

// Button Bindings
els.brandHome.addEventListener('click', () => switchMode('hub'));
els.btnHome.addEventListener('click', () => switchMode('hub'));
els.btnSim.addEventListener('click', () => {
  audio.playClick(1.15);
  setSimEnabled(!simEnabled);
});
els.btnDiag?.addEventListener('click', () => {
  audio.playClick(1.12);
  toggleDiag();
});
els.btnDiagClose?.addEventListener('click', () => toggleDiag(false));
els.btnDiagReset?.addEventListener('click', () => {
  resetDiag();
  showToast('Diagnostics counters reset', '#2563EB');
});
els.btnDiagCopy?.addEventListener('click', async () => {
  const report = JSON.stringify(buildDiagSnapshot(), null, 2);
  try {
    await navigator.clipboard.writeText(report);
    showToast('Diagnostics report copied — paste it in chat!', '#059669');
  } catch (_) {
    showToast('Unable to copy automatically', '#D97706');
  }
});
els.btnTips.addEventListener('click', () => {
  audio.playClick(1.12);
  showTipsModal(currentModeId, null);
});
els.btnPairToggle.addEventListener('click', () => {
  audio.playClick(1.1);
  els.qrModal.classList.toggle('hidden');
});
function setMaskIcon(el, iconName) {
  if (!el) return;
  const url = `url('/vendor/icons/${iconName}-bold.svg')`;
  el.style.webkitMaskImage = url;
  el.style.maskImage = url;
}

els.btnMute.addEventListener('click', () => {
  const next = !audio.muted;
  audio.setMuted(next);
  els.btnMute.classList.toggle('muted', next);
  els.btnMute.dataset.tip = next ? 'Unmute Sound' : 'Mute Sound';
  els.btnMute.setAttribute('aria-label', next ? 'Unmute Sound' : 'Mute Sound');
  setMaskIcon(document.getElementById('muteIcon'), next ? 'speaker-slash' : 'speaker-high');
  if (!next) audio.playClick(1.2);
});
els.btnFullscreen.addEventListener('click', () => {
  audio.playClick(1.1);
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  else document.exitFullscreen?.().catch(() => {});
});
document.addEventListener('fullscreenchange', () => {
  const isFs = Boolean(document.fullscreenElement);
  els.btnFullscreen.dataset.tip = isFs ? 'Exit Fullscreen' : 'Fullscreen';
  setMaskIcon(document.getElementById('fsIcon'), isFs ? 'corners-in' : 'corners-out');
});

els.modeCards.forEach((card) => {
  card.addEventListener('click', () => {
    if (!isPrimaryHost) {
      showToast('Synced Screen — host controls mode selection', '#059669');
      return;
    }
    switchMode(card.dataset.mode, { autoSimIfEmpty: true });
  });
  card.addEventListener('pointerenter', () => {
    audio.playHover();
  });
});

// Desktop Mouse / Trackpad Simulator
let lastMouseMoveMs = performance.now();

window.addEventListener('mousemove', (e) => {
  const nx = clamp(e.clientX / stageW, 0, 1);
  const ny = clamp(e.clientY / stageH, 0, 1);
  if (phonePlayers.size === 0) {
    mochi.setLookTarget(nx, ny);
  }
  if (!simEnabled) return;

  const now = performance.now();
  const dt = Math.max(0.004, (now - lastMouseMoveMs) / 1000);
  lastMouseMoveMs = now;

  const speed = Math.hypot(nx - simPlayer.x, ny - simPlayer.y) / dt;
  simPlayer.lastX = simPlayer.x;
  simPlayer.lastY = simPlayer.y;
  simPlayer.x = nx;
  simPlayer.y = ny;
  simPlayer.yawDeg = (nx - 0.5) * 56;
  simPlayer.pitchDeg = (0.5 - ny) * 38;
  simPlayer.swingPower = Math.min(2.6, speed * 0.75);
  simPlayer.g = Math.min(3.5, speed * 0.85);
});

window.addEventListener('mousedown', (e) => {
  if (!simEnabled) return;
  if (e.target.closest('.console-bar, .qr-modal, .hub-rail, .mode-dock, .overlay-host, .mochi-widget')) return;
  if (currentModeId === 'hub' && e.target.closest('.mode-card')) return;
  if (e.button === 0) handlePlayerAction(simPlayer, 'btn_a_down');
  else if (e.button === 2) handlePlayerAction(simPlayer, 'btn_b_down');
});

window.addEventListener('mouseup', (e) => {
  if (!simEnabled) return;
  if (e.button === 0 && simPlayer.a) handlePlayerAction(simPlayer, 'btn_a_up');
  if (e.button === 2 && simPlayer.b) handlePlayerAction(simPlayer, 'btn_b_up');
});

window.addEventListener('contextmenu', (e) => {
  if (simEnabled && currentModeId !== 'hub') e.preventDefault();
});

window.addEventListener(
  'wheel',
  (e) => {
    if (!simEnabled) return;
    simPlayer.roll += e.deltaY * 0.0022;
    simPlayer.rollDeg = (simPlayer.roll * 180) / Math.PI;
  },
  { passive: true }
);

window.addEventListener('keydown', (e) => {
  if ((e.key === 'd' || e.key === 'D') && !e.repeat && !e.target.closest('input, textarea')) {
    toggleDiag();
    return;
  }
  if (e.key === 'Escape' && currentModeId !== 'hub') {
    switchMode('hub');
    return;
  }
  if (!simEnabled) return;
  if (e.code === 'Space' && !e.repeat) {
    e.preventDefault();
    handlePlayerAction(simPlayer, 'btn_b_down');
  } else if ((e.key === 'f' || e.key === 'F') && !e.repeat) {
    if (currentModeId !== 'hub' && modes[currentModeId]) {
      modes[currentModeId].onGesture(simPlayer, { kind: 'shake', power: 1.6 });
    }
  }
});

window.addEventListener('keyup', (e) => {
  if (!simEnabled) return;
  if (e.code === 'Space') handlePlayerAction(simPlayer, 'btn_b_up');
});

function resizeCanvases() {
  stageW = window.innerWidth;
  stageH = window.innerHeight;
  dpr = Math.min(2, window.devicePixelRatio || 1);

  for (const c of [els.stageCanvas, els.cursorCanvas]) {
    c.width = Math.floor(stageW * dpr);
    c.height = Math.floor(stageH * dpr);
  }
  hubBgDirty = true;
  mochi.resize();
  if (modes.sculpt.resize) modes.sculpt.resize();
  cacheModeCardRects();
}

window.addEventListener('resize', resizeCanvases);
resizeCanvases();

// =========================================================================
// ZERO-BUFFER CRITICALLY-DAMPED 180Hz MOTION TRACKER
// Exact analytical critically-damped spring (zeta = 1.0): 0ms buffer wait,
// mathematically impossible to overshoot on Wi-Fi packet bursts, silky C1
// continuous motion across every 180Hz/240Hz frame even from 30Hz phones!
// =========================================================================
function unwrapAngleDelta(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function stepCriticallyDamped(val, vel, target, omega, dt) {
  const e = Math.exp(-omega * dt);
  const dx = val - target;
  const c = vel + omega * dx;
  return [
    target + (dx + c * dt) * e,
    (vel - c * omega * dt) * e,
  ];
}

function reconstructPhonePlayers(dt) {
  // Adaptive omega: slightly softer on 30Hz phones to stay silk-continuous, tighter on 60-120Hz phones!
  for (const p of phonePlayers.values()) {
    p.lastX = p.x;
    p.lastY = p.y;

    const omega = p.transport === 'NATIVE' ? 120 : p.avgIntervalMs > 25 ? 28 : 48;
    const [nx, nvx] = stepCriticallyDamped(p.x, p.vx, p.targetX, omega, dt);
    const [ny, nvy] = stepCriticallyDamped(p.y, p.vy, p.targetY, omega, dt);

    p.x = clamp(nx, 0, 1);
    p.y = clamp(ny, 0, 1);
    p.vx = nvx;
    p.vy = nvy;

    const rotAlpha = 1 - Math.exp(-dt * 38);
    p.roll += unwrapAngleDelta(p.roll, p.targetRoll) * rotAlpha;
    p.rollDeg = (p.roll * 180) / Math.PI;
    p.yawDeg += (p.targetYaw - p.yawDeg) * rotAlpha;
    p.pitchDeg += (p.targetPitch - p.pitchDeg) * rotAlpha;
  }
}

// =========================================================================
// HUB AMBIENT BACKGROUND, CARD HOVER PHYSICS & 180Hz CURSORS
// =========================================================================
function renderHubBackground() {
  if (!hubBgDirty) return;
  hubBgDirty = false;
  const ctx = stageCtx;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#F3F4F6';
  ctx.fillRect(0, 0, stageW, stageH);
  ctx.restore();
}

function updateHubCardHover(players) {
  const hoveredSet = new Set();

  for (const p of players) {
    const px = p.x * stageW;
    const py = p.y * stageH;
    let found = null;
    for (const item of cachedCardRects) {
      const r = item.rect;
      if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) {
        found = item;
        break;
      }
    }

    if (found) {
      hoveredSet.add(found.mode);
      const nx = ((px - found.rect.left) / found.rect.width - 0.5) * 2;
      const ny = ((py - found.rect.top) / found.rect.height - 0.5) * 2;
      springUI.setRemoteHover(found.el, true, nx, ny);
    }

    const modeId = found ? found.mode : null;
    if (modeId !== p.hoveredCard) {
      p.hoveredCard = modeId;
      if (modeId) {
        audio.playHover();
        modeApi.sendFeedback(p.slot, { sfx: 'hover', vibrate: [8] });
      }
    }
  }

  for (const item of cachedCardRects) {
    const isHov = hoveredSet.has(item.mode);
    item.el.classList.toggle('remote-hover', isHov);
    if (!isHov && players.length > 0) {
      springUI.setRemoteHover(item.el, false);
    }
  }
}

function renderCursors(dt, players) {
  const ctx = cursorCtx;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, stageW, stageH);

  // Hide the floating pointer reticle during Strike Table gameplay (mallets already show your exact hand position!)
  if (currentModeId === 'strike' && els.overlayHost.childElementCount === 0) {
    ctx.restore();
    return;
  }

  for (const p of players) {
    const px = p.x * stageW;
    const py = p.y * stageH;

    const lastPt = p.cursorTrail[p.cursorTrail.length - 1];
    if (!lastPt || Math.hypot(px - lastPt.x, py - lastPt.y) > 1.5) {
      p.cursorTrail.push({ x: px, y: py, life: 1.0 });
      if (p.cursorTrail.length > 24) p.cursorTrail.shift();
    }
    for (let i = p.cursorTrail.length - 1; i >= 0; i--) {
      p.cursorTrail[i].life -= dt * 7.5;
      if (p.cursorTrail[i].life <= 0) p.cursorTrail.splice(i, 1);
    }

    if (currentModeId === 'hub' && p.cursorTrail.length > 2) {
      ctx.save();
      ctx.lineCap = 'round';
      for (let i = 1; i < p.cursorTrail.length; i++) {
        const a = p.cursorTrail[i - 1];
        const b = p.cursorTrail[i];
        const ratio = i / p.cursorTrail.length;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = p.profile.color;
        ctx.globalAlpha = Math.max(0, b.life * ratio * 0.25);
        ctx.lineWidth = ratio * 6;
        ctx.stroke();
      }
      ctx.restore();
    }

    // Crisp Tactile Studio Reticle (high contrast on light ceramic background)
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(p.roll || 0);

    const active = p.a || p.b;
    const outerR = active ? 20 : 16;

    // Soft ceramic shadow backing
    ctx.beginPath();
    ctx.arc(0, 1.5, outerR + 1.5, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 4.5;
    ctx.stroke();

    // Segmented ring
    ctx.strokeStyle = p.profile.color;
    ctx.lineWidth = active ? 3 : 2.2;
    for (let k = 0; k < 4; k++) {
      const a0 = k * (Math.PI / 2) + 0.3;
      const a1 = (k + 1) * (Math.PI / 2) - 0.3;
      ctx.beginPath();
      ctx.arc(0, 0, outerR, a0, a1);
      ctx.stroke();
    }

    // Top directional pointer triangle
    ctx.beginPath();
    ctx.moveTo(0, -outerR - 7);
    ctx.lineTo(-4, -outerR - 1);
    ctx.lineTo(4, -outerR - 1);
    ctx.closePath();
    ctx.fillStyle = p.profile.color;
    ctx.fill();

    // Center dot
    ctx.beginPath();
    ctx.arc(0, 0, active ? 4.2 : 3, 0, Math.PI * 2);
    ctx.fillStyle = '#111318';
    ctx.fill();
    ctx.restore();

    // Minimal Player Tag Pill
    ctx.save();
    ctx.font = '700 10px "JetBrains Mono", monospace';
    const label = p.profile.label;
    const tw = ctx.measureText(label).width + 12;
    ctx.beginPath();
    ctx.roundRect(px - tw * 0.5, py + 23, tw, 17, 6);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.strokeStyle = p.profile.color;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.fillStyle = p.profile.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, px, py + 32);
    ctx.restore();
  }

  ctx.restore();
}

// =========================================================================
// MASTER 180Hz / 240Hz STUDIO LOOP
// =========================================================================
let lastFrameMs = performance.now();
let fpsFrames = 0;
let fpsWindowStart = performance.now();
let liveFps = 60;
let lastTeleUpdateMs = 0;

function frame(nowMs) {
  const rawFrameMs = nowMs - lastFrameMs;
  // Ignore boot-splash initial layout frames (< 2.5s) and tab-hidden jumps (> 500ms)
  if (nowMs - bootStartMs > 2500 && rawFrameMs > diag.frameMaxMs && rawFrameMs < 500) {
    diag.frameMaxMs = rawFrameMs;
  }
  const dt = Math.min(0.05, Math.max(0.001, rawFrameMs / 1000));
  lastFrameMs = nowMs;

  updateBoot(nowMs);

  fpsFrames++;
  if (nowMs - fpsWindowStart >= 500) {
    liveFps = Math.round((fpsFrames * 1000) / (nowMs - fpsWindowStart));
    fpsFrames = 0;
    fpsWindowStart = nowMs;
    const badge = document.getElementById('fpsBadge');
    if (badge) badge.textContent = `${liveFps} FPS`;
  }

  reconstructPhonePlayers(dt, nowMs);

  if (simEnabled && nowMs - lastMouseMoveMs > 45) {
    simPlayer.swingPower *= Math.pow(0.005, dt);
    simPlayer.g *= Math.pow(0.005, dt);
  }

  const players = getActivePlayers();

  // Mochi tracks primary player's pointer continuously in 3D!
  if (players.length > 0) {
    const p0 = players[0];
    mochi.setLookTarget(p0.x, p0.y);
  }
  mochi.update(dt);

  if (currentModeId === 'hub') {
    renderHubBackground();
    updateHubCardHover(players);

    // Update Hub Telemetry card at 10Hz
    if (nowMs - lastTeleUpdateMs > 100) {
      lastTeleUpdateMs = nowMs;
      const p0 = players[0];
      if (p0) {
        els.streamRateBadge.textContent = p0.isSim
          ? `SIM · ${liveFps}FPS`
          : `${p0.profile.label} · ${p0.transport || 'WS'} · ${p0.sampleHz || 60}HZ`;
        els.teleYaw.textContent = `${Math.round(p0.yawDeg || 0)}°`;
        els.telePitch.textContent = `${Math.round(p0.pitchDeg || 0)}°`;
        els.teleRoll.textContent = `${Math.round(p0.rollDeg || 0)}°`;
      } else {
        els.streamRateBadge.textContent = 'IDLE';
      }
    }
  } else {
    const activeMode = modes[currentModeId];
    if (isPrimaryHost) {
      activeMode.update(dt, players);
      pushStateSync(false, nowMs);
    } else if (activeMode.updateMirror) {
      activeMode.updateMirror(dt, players);
    }
    stageCtx.save();
    stageCtx.scale(dpr, dpr);
    stageCtx.clearRect(0, 0, stageW, stageH);
    activeMode.render(stageCtx, stageW, stageH, players);
    stageCtx.restore();
  }

  renderCursors(dt, players);
  renderDiagHud(nowMs);
  requestAnimationFrame(frame);
}

connectHostSocket();
requestAnimationFrame(frame);
