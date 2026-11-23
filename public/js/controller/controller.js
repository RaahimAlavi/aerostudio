import { MODE_INFO, SCULPT_PALETTE, MOTION_PACKET_BYTES, encodeMotionPacket } from '../shared/protocol.js';
import { AeroAudio } from '../shared/audio.js';
import { MotionSensorEngine } from './sensor.js';

const params = new URLSearchParams(window.location.search);
const roomParam = (params.get('room') || '').toUpperCase();
const lanParam = params.get('lan') || '';
const portParam = params.get('port') || '3000';
const udpParam = params.get('udp') || '41234';

const els = {
  pairGate: document.getElementById('pairGate'),
  btnLink: document.getElementById('btnLink'),
  httpWarn: document.getElementById('httpWarn'),
  httpsSwitchLink: document.getElementById('httpsSwitchLink'),
  playerDot: document.getElementById('playerDot'),
  playerLabel: document.getElementById('playerLabel'),
  btnSens: document.getElementById('btnSens'),
  btnSpeaker: document.getElementById('btnSpeaker'),
  pingBadge: document.getElementById('pingBadge'),
  speakerGrille: document.getElementById('speakerGrille'),
  modeName: document.getElementById('modeName'),
  modeHint: document.getElementById('modeHint'),
  voteBanner: document.getElementById('voteBanner'),
  voteText: document.getElementById('voteText'),
  btnVoteYes: document.getElementById('btnVoteYes'),
  btnVoteNo: document.getElementById('btnVoteNo'),
  contextDrawer: document.getElementById('contextDrawer'),
  radarPanel: document.getElementById('radarPanel'),
  radarCrosshair: document.getElementById('radarCrosshair'),
  radarMeta: document.getElementById('radarMeta'),
  touchBadge: document.getElementById('touchBadge'),
  gLabel: document.getElementById('gLabel'),
  gBarFill: document.getElementById('gBarFill'),
  btnA: document.getElementById('btnA'),
  btnASub: document.getElementById('btnASub'),
  btnB: document.getElementById('btnB'),
  btnBLabel: document.getElementById('btnBLabel'),
  btnRecenter: document.getElementById('btnRecenter'),
  btnHome: document.getElementById('btnHome'),
  leds: [...document.querySelectorAll('.led')],
};

const audio = new AeroAudio('phone');
let ws = null;
let wakeLock = null;
let linked = false;
let currentMode = 'hub';
let btnAHeld = false;
let btnBHeld = false;
let speakerTimer = null;
let reconnectTimer = null;
let pingTimer = null;

// Per-phone Sculpt / Sketch local UI state
let selectedColor = SCULPT_PALETTE[0].hex;
let selectedTool = 'pen'; // 'sculpt' | 'pen' | 'brush' | 'fill' | 'erase'
const PHONE_SIZES = [
  { id: 'sm', dot: 5 },
  { id: 'md', dot: 8 },
  { id: 'lg', dot: 12 },
  { id: 'xl', dot: 16 },
];
let selectedSizeIdx = 1;
let sketchState = { role: 'none', word: '', length: 0 };

function phIcon(name) {
  return `<span class="ph-icon" style="-webkit-mask-image:url('/vendor/icons/${name}-bold.svg');mask-image:url('/vendor/icons/${name}-bold.svg')"></span>`;
}

const motionBuf = new ArrayBuffer(MOTION_PACKET_BYTES);
const motionView = new DataView(motionBuf);

let radarW = 300;
let radarH = 86;
function measureRadar() {
  const r = els.radarPanel.getBoundingClientRect();
  if (r.width > 0 && r.height > 0) {
    radarW = r.width;
    radarH = r.height;
  }
}
window.addEventListener('resize', measureRadar);

const SENS_LEVELS = [
  { label: 'LOW', mult: 0.72 },
  { label: 'MED', mult: 1.0 },
  { label: 'HIGH', mult: 1.38 },
];
let sensIdx = 1;

if (!window.isSecureContext && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
  els.httpWarn.classList.add('visible');
  els.httpsSwitchLink.href = `https://${window.location.hostname}:3443${window.location.pathname}${window.location.search}`;
}

// Show Native 240Hz Android App card automatically on Android phones (hidden on iOS Safari)
const isAndroid = /Android/i.test(navigator.userAgent || '') || params.get('android') === '1';
const androidCard = document.getElementById('androidAppCard');
const btnOpenApp = document.getElementById('btnOpenApp');
if (btnOpenApp) {
  const pairQs = new URLSearchParams();
  if (lanParam) {
    pairQs.set('host', lanParam);
    pairQs.set('port', portParam);
    pairQs.set('udp', udpParam);
  }
  if (roomParam) pairQs.set('room', roomParam);
  pairQs.set('origin', window.location.origin);
  btnOpenApp.href = `aero://pair?${pairQs.toString()}`;
}
if (isAndroid && androidCard) {
  androidCard.classList.add('visible');
}

function vibrate(pattern) {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(pattern);
    } catch (_) {}
  }
}

function pulseSpeaker() {
  els.speakerGrille.classList.add('pulsing');
  clearTimeout(speakerTimer);
  speakerTimer = setTimeout(() => els.speakerGrille.classList.remove('pulsing'), 180);
}

function sendJson(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// Direct LAN UDP WebRTC DataChannel (zero TCP head-of-line stalling!)
let rtcPc = null;
let rtcDc = null;
let rtcRemoteReady = false;
let rtcIceQueue = [];
let udpOpen = false;
let mySlot = 0;

function closeRtc() {
  udpOpen = false;
  rtcRemoteReady = false;
  rtcIceQueue = [];
  if (rtcDc) {
    try { rtcDc.close(); } catch (_) {}
    rtcDc = null;
  }
  if (rtcPc) {
    try { rtcPc.close(); } catch (_) {}
    rtcPc = null;
  }
}

function getRtcConfig() {
  const h = window.location.hostname;
  const isLan = h === 'localhost' || h === '127.0.0.1' || /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  return { iceServers: isLan ? [] : [{ urls: 'stun:stun.l.google.com:19302' }] };
}

async function startRtcUdpUpgrade() {
  if (typeof RTCPeerConnection === 'undefined') return;
  closeRtc();
  try {
    rtcPc = new RTCPeerConnection(getRtcConfig());
    rtcDc = rtcPc.createDataChannel('aero-udp', {
      ordered: false,
      maxRetransmits: 0,
    });
    rtcDc.binaryType = 'arraybuffer';
    rtcDc.onopen = () => {
      udpOpen = true;
    };
    rtcDc.onclose = () => {
      udpOpen = false;
    };
    rtcPc.onicecandidate = (e) => {
      if (e.candidate) {
        sendJson({ type: 'rtc_signal', candidate: e.candidate });
      }
    };
    const offer = await rtcPc.createOffer();
    await rtcPc.setLocalDescription(offer);
    sendJson({ type: 'rtc_signal', offer });
  } catch (_) {
    closeRtc();
  }
}

async function handleRtcSignal(msg) {
  if (!rtcPc) return;
  try {
    if (msg.answer) {
      await rtcPc.setRemoteDescription(msg.answer);
      rtcRemoteReady = true;
      for (const c of rtcIceQueue) {
        await rtcPc.addIceCandidate(c).catch(() => {});
      }
      rtcIceQueue = [];
    } else if (msg.candidate) {
      if (rtcRemoteReady) await rtcPc.addIceCandidate(msg.candidate);
      else rtcIceQueue.push(msg.candidate);
    }
  } catch (_) {}
}

function sendBinaryMotion(s) {
  if (!linked) return;
  encodeMotionPacket(motionView, {
    x: s.x,
    y: s.y,
    roll: s.roll,
    yawDeg: s.yawDeg,
    pitchDeg: s.pitchDeg,
    g: s.gForce,
    sw: s.swingPower,
    a: btnAHeld,
    b: btnBHeld,
    hz: s.sampleHz || 60,
    highRate: s.highRate,
  });
  motionView.setUint8(1, mySlot);

  // Fast Path 1: Direct Peer-to-Peer LAN UDP (zero TCP stalls, zero server hop!)
  if (udpOpen && rtcDc && rtcDc.readyState === 'open') {
    if (rtcDc.bufferedAmount < 512) {
      try {
        rtcDc.send(motionBuf);
        return;
      } catch (_) {}
    }
  }

  // Fallback Path 2: Binary WebSocket
  if (ws && ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= 512) {
    ws.send(motionBuf);
  }
}

function applyPlayerProfile(profile, roomCode) {
  if (!profile) return;
  selectedColor = profile.color;
  document.documentElement.style.setProperty('--accent', profile.color);
  els.playerLabel.textContent = `${profile.label} · ${roomCode || 'LIVE'}`;
  els.leds.forEach((led) => {
    const slot = Number(led.dataset.slot);
    led.classList.toggle('lit', slot === profile.slot);
  });
}

function renderContextDrawer() {
  if (currentMode === 'sculpt') {
    const isErase = selectedTool === 'erase';
    const swatches = SCULPT_PALETTE.map(
      (c) =>
        `<button class="ph-swatch ${selectedColor.toLowerCase() === c.hex.toLowerCase() && !isErase ? 'active' : ''}"
          data-color="${c.hex}" style="--sw:${c.hex}" type="button"></button>`
    ).join('');

    els.contextDrawer.innerHTML = `
      <div class="swatch-row">${swatches}</div>
      <div class="drawer-tools">
        <button class="drawer-pill ${!isErase ? 'active' : ''}" data-tool="sculpt" title="Sculpt" aria-label="Sculpt" type="button">${phIcon('paint-brush')}</button>
        <button class="drawer-pill ${isErase ? 'active' : ''}" data-tool="erase" title="Eraser" aria-label="Eraser" type="button">${phIcon('eraser')}</button>
        <button class="drawer-pill" data-cmd="undo" title="Undo" aria-label="Undo" type="button">${phIcon('arrow-u-up-left')}</button>
        <button class="drawer-pill danger" data-cmd="clear" title="Clear" aria-label="Clear" type="button">${phIcon('trash')}</button>
      </div>
    `;
    els.contextDrawer.classList.add('visible');

    els.contextDrawer.querySelectorAll('[data-color]').forEach((b) => {
      b.addEventListener('click', () => {
        selectedColor = b.dataset.color;
        selectedTool = 'sculpt';
        vibrate(10);
        audio.playClick(1.22);
        sendJson({ type: 'sculpt_tool', color: selectedColor, tool: 'sculpt' });
        renderContextDrawer();
      });
    });
    els.contextDrawer.querySelectorAll('[data-tool]').forEach((b) => {
      b.addEventListener('click', () => {
        selectedTool = b.dataset.tool;
        vibrate(10);
        audio.playClick(1.1);
        sendJson({ type: 'sculpt_tool', tool: selectedTool });
        renderContextDrawer();
      });
    });
    els.contextDrawer.querySelectorAll('[data-cmd]').forEach((b) => {
      b.addEventListener('click', () => {
        vibrate(14);
        audio.playClick(1.15);
        sendJson({ type: 'sculpt_tool', cmd: b.dataset.cmd });
      });
    });
    setTimeout(measureRadar, 30);
    return;
  }

  if (currentMode === 'sketch') {
    if (sketchState.role === 'guesser') {
      els.contextDrawer.innerHTML = `
        <form id="guessForm" class="guess-form">
          <input id="guessInput" class="guess-input" type="text" placeholder="Type your guess..." autocomplete="off" />
          <button class="guess-send" type="submit">Send</button>
        </form>
      `;
      els.contextDrawer.classList.add('visible');
      const form = document.getElementById('guessForm');
      const input = document.getElementById('guessInput');
      form?.addEventListener('submit', (e) => {
        e.preventDefault();
        const val = (input?.value || '').trim();
        if (!val) return;
        sendJson({ type: 'sketch_guess', text: val });
        input.value = '';
        vibrate(12);
      });
    } else {
      const activeTool = ['pen', 'brush', 'fill', 'erase'].includes(selectedTool) ? selectedTool : 'pen';
      const curSize = PHONE_SIZES[selectedSizeIdx % PHONE_SIZES.length];
      const swatches = SCULPT_PALETTE.slice(0, 7)
        .map(
          (c) =>
            `<button class="ph-swatch ${selectedColor.toLowerCase() === c.hex.toLowerCase() && activeTool !== 'erase' ? 'active' : ''}"
              data-color="${c.hex}" style="--sw:${c.hex}" type="button"></button>`
        )
        .join('');
      const wordHtml = sketchState.word
        ? `<div class="secret-word-box"><span class="secret-label">SECRET WORD</span><span class="secret-val">${sketchState.word}</span></div>`
        : '';

      els.contextDrawer.innerHTML = `
        ${wordHtml}
        <div class="swatch-row">${swatches}</div>
        <div class="drawer-tools">
          <button class="drawer-pill ${activeTool === 'pen' ? 'active' : ''}" data-tool="pen" title="Pen" aria-label="Pen" type="button">${phIcon('pencil-simple')}</button>
          <button class="drawer-pill ${activeTool === 'brush' ? 'active' : ''}" data-tool="brush" title="Brush" aria-label="Brush" type="button">${phIcon('paint-brush')}</button>
          <button class="drawer-pill ${activeTool === 'fill' ? 'active' : ''}" data-tool="fill" title="Fill" aria-label="Color Fill" type="button">${phIcon('paint-bucket')}</button>
          <button class="drawer-pill ${activeTool === 'erase' ? 'active' : ''}" data-tool="erase" title="Eraser" aria-label="Eraser" type="button">${phIcon('eraser')}</button>
          <button class="drawer-pill" data-cycle-size="1" title="Stroke Size" aria-label="Stroke Size" type="button"><span class="ph-size-dot" style="width:${curSize.dot}px;height:${curSize.dot}px"></span></button>
          <button class="drawer-pill" data-cmd="undo" title="Undo" aria-label="Undo" type="button">${phIcon('arrow-u-up-left')}</button>
          <button class="drawer-pill" data-skcmd="skip" title="Skip" aria-label="Next Word" type="button">${phIcon('skip-forward')}</button>
        </div>
      `;
      els.contextDrawer.classList.add('visible');

      els.contextDrawer.querySelectorAll('[data-color]').forEach((b) => {
        b.addEventListener('click', () => {
          selectedColor = b.dataset.color;
          if (selectedTool === 'erase') selectedTool = 'pen';
          vibrate(10);
          audio.playClick(1.22);
          sendJson({ type: 'sketch_tool', color: selectedColor, tool: selectedTool === 'sculpt' ? 'pen' : selectedTool });
          renderContextDrawer();
        });
      });
      els.contextDrawer.querySelectorAll('[data-tool]').forEach((b) => {
        b.addEventListener('click', () => {
          selectedTool = b.dataset.tool;
          vibrate(10);
          audio.playClick(1.12);
          sendJson({ type: 'sketch_tool', tool: selectedTool });
          renderContextDrawer();
        });
      });
      els.contextDrawer.querySelectorAll('[data-cycle-size]').forEach((b) => {
        b.addEventListener('click', () => {
          selectedSizeIdx = (selectedSizeIdx + 1) % PHONE_SIZES.length;
          vibrate(10);
          audio.playClick(1.18);
          sendJson({ type: 'sketch_tool', size: PHONE_SIZES[selectedSizeIdx].id });
          renderContextDrawer();
        });
      });
      els.contextDrawer.querySelectorAll('[data-cmd]').forEach((b) => {
        b.addEventListener('click', () => {
          vibrate(12);
          sendJson({ type: 'sketch_tool', cmd: b.dataset.cmd });
        });
      });
      els.contextDrawer.querySelectorAll('[data-skcmd]').forEach((b) => {
        b.addEventListener('click', () => {
          vibrate(14);
          sendJson({ type: 'sketch_cmd', cmd: b.dataset.skcmd });
        });
      });
    }
    setTimeout(measureRadar, 30);
    return;
  }

  els.contextDrawer.innerHTML = '';
  els.contextDrawer.classList.remove('visible');
  setTimeout(measureRadar, 30);
}

function applyModeUI(modeId) {
  currentMode = modeId || 'hub';
  const info = MODE_INFO[currentMode] || MODE_INFO.hub;
  els.modeName.textContent = info.title;
  els.modeHint.textContent = info.gestureHint;
  els.btnASub.textContent = info.aLabel;
  els.btnBLabel.textContent = info.bLabel;
  els.voteBanner.classList.remove('visible');
  renderContextDrawer();
}

els.btnVoteYes.addEventListener('click', () => {
  sendJson({ type: 'clear_vote_reply', approved: true });
  els.voteBanner.classList.remove('visible');
  vibrate(18);
  audio.playClick(1.3);
});

els.btnVoteNo.addEventListener('click', () => {
  sendJson({ type: 'clear_vote_reply', approved: false });
  els.voteBanner.classList.remove('visible');
  vibrate(14);
  audio.playClick(0.85);
});

const sensor = new MotionSensorEngine({
  onSample(state) {
    sendBinaryMotion(state);
  },
  onGesture(gesture) {
    if (!linked) return;
    sendJson({ type: 'gesture', ...gesture });
    if (gesture.kind === 'flick_up') vibrate([14, 24, 18]);
    else if (gesture.kind === 'shake') vibrate([22, 22, 22]);
  },
  onStatusChange(mode) {
    sendJson({ type: 'sensor_status', sensorMode: mode });
    if (mode === 'gyro') {
      els.touchBadge.classList.remove('visible');
      els.radarPanel.classList.add('gyro-compact');
      els.radarMeta.textContent = 'GYRO LIVE · POINT AT SCREEN';
    } else {
      els.radarPanel.classList.remove('gyro-compact');
      els.touchBadge.classList.add('visible');
      els.radarMeta.textContent = 'DRAG HERE TO AIM';
      measureRadar();
    }
  },
});

async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch (_) {}
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && linked) requestWakeLock();
});

function connectSocket() {
  clearTimeout(reconnectTimer);
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const qs = new URLSearchParams({ role: 'controller' });
  if (roomParam) qs.set('room', roomParam);

  ws = new WebSocket(`${proto}//${window.location.host}/ws?${qs.toString()}`);

  ws.addEventListener('open', () => {
    els.playerLabel.textContent = 'LINKING...';
    clearInterval(pingTimer);
    pingTimer = setInterval(() => sendJson({ type: 'ping', t: performance.now() }), 2000);
    sendJson({ type: 'ping', t: performance.now() });
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (msg.type === 'controller_welcome') {
      mySlot = msg.slot || 0;
      applyPlayerProfile(msg.profile, msg.roomCode);
      applyModeUI(msg.mode || 'hub');
      audio.playConnect(mySlot);
      pulseSpeaker();
      vibrate([20, 35, 30]);
      measureRadar();
      if (sensor.mode !== 'pending') sendJson({ type: 'sensor_status', sensorMode: sensor.mode });
      sendBinaryMotion(sensor.state);
      startRtcUdpUpgrade();
    } else if (msg.type === 'rtc_signal') {
      handleRtcSignal(msg);
    } else if (msg.type === 'mode') {
      applyModeUI(msg.mode);
      audio.playClick(1.15);
      pulseSpeaker();
      vibrate(14);
    } else if (msg.type === 'to_controller') {
      if (msg.kind === 'clear_vote_prompt') {
        els.voteText.textContent = `${msg.requester || 'A player'} wants to clear the 3D canvas`;
        els.voteBanner.classList.add('visible');
        vibrate([25, 25, 25]);
        audio.playClick(1.25);
        pulseSpeaker();
      } else if (msg.kind === 'clear_vote_closed') {
        els.voteBanner.classList.remove('visible');
      } else if (msg.kind === 'sketch_role') {
        sketchState = { role: msg.role || 'none', word: msg.word || '', length: msg.length || 0 };
        if (currentMode === 'sketch') renderContextDrawer();
      }
    } else if (msg.type === 'feedback') {
      if (msg.vibrate) vibrate(msg.vibrate);
      if (msg.sfx) {
        audio.playFeedback(msg.sfx, msg.pitch || 1.0);
        pulseSpeaker();
      }
    } else if (msg.type === 'pong') {
      const rtt = Math.max(1, Math.round((performance.now() - msg.t) / 2));
      els.pingBadge.textContent = `${rtt} ms`;
    } else if (msg.type === 'error') {
      els.playerLabel.textContent = msg.code || 'ERROR';
    }
  });

  ws.addEventListener('close', () => {
    clearInterval(pingTimer);
    closeRtc();
    els.playerLabel.textContent = 'RECONNECTING...';
    els.pingBadge.textContent = '-- ms';
    if (linked) reconnectTimer = setTimeout(connectSocket, 1400);
  });
}

els.btnLink.addEventListener('click', async () => {
  audio.unlock();
  const permPromise = sensor.requestPermissionsAndStart();

  vibrate([18, 28, 24]);
  linked = true;
  els.pairGate.classList.add('hidden');
  measureRadar();
  requestWakeLock();
  connectSocket();

  await permPromise;
});

function bindHoldButton(el, name, onChange) {
  let activePointer = null;

  const down = (e) => {
    e.preventDefault();
    if (activePointer !== null) return;
    activePointer = e.pointerId;
    try {
      el.setPointerCapture(e.pointerId);
    } catch (_) {}
    el.classList.add('pressed');
    onChange(true);
    vibrate(14);
    audio.playClick(name === 'a' ? 1.15 : 0.85);
    pulseSpeaker();
    sendJson({ type: 'action', name: `btn_${name}_down` });
    sendBinaryMotion(sensor.state);
  };

  const up = (e) => {
    if (activePointer !== e.pointerId) return;
    activePointer = null;
    el.classList.remove('pressed');
    onChange(false);
    sendJson({ type: 'action', name: `btn_${name}_up` });
    sendBinaryMotion(sensor.state);
  };

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

bindHoldButton(els.btnA, 'a', (v) => (btnAHeld = v));
bindHoldButton(els.btnB, 'b', (v) => (btnBHeld = v));

els.btnRecenter.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  sensor.recenter();
  vibrate([15, 22, 15]);
  audio.playClick(1.42);
  pulseSpeaker();
  sendJson({ type: 'action', name: 'recenter' });
});

els.btnHome.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  vibrate(18);
  audio.playClick(0.95);
  pulseSpeaker();
  sendJson({ type: 'action', name: 'home' });
});

els.btnSens.addEventListener('click', () => {
  sensIdx = (sensIdx + 1) % SENS_LEVELS.length;
  const preset = SENS_LEVELS[sensIdx];
  sensor.setSensitivity(preset.mult);
  els.btnSens.textContent = preset.label;
  vibrate(10);
  audio.playClick(1.2);
});

els.btnSpeaker.addEventListener('click', () => {
  const nextMuted = !audio.muted;
  audio.setMuted(nextMuted);
  els.btnSpeaker.textContent = nextMuted ? 'MUTE' : 'SPK';
  els.btnSpeaker.classList.toggle('active', !nextMuted);
  if (!nextMuted) {
    audio.playClick(1.3);
    pulseSpeaker();
  }
});

// Touchpad Aim Fallback
let padPointer = null;
let lastPadPos = null;
let lastPadTime = 0;

function updateTouchCrosshair(nx, ny) {
  els.radarCrosshair.style.transform = `translate3d(${(nx * radarW).toFixed(1)}px, ${(ny * radarH).toFixed(1)}px, 0)`;
}

els.radarPanel.addEventListener('pointerdown', (e) => {
  if (sensor.mode === 'gyro') return;
  e.preventDefault();
  padPointer = e.pointerId;
  try {
    els.radarPanel.setPointerCapture(e.pointerId);
  } catch (_) {}
  const rect = els.radarPanel.getBoundingClientRect();
  const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
  lastPadPos = { nx, ny };
  lastPadTime = performance.now();
  updateTouchCrosshair(nx, ny);
  sensor.applyTouchAim(nx, ny, 0, 0);
});

els.radarPanel.addEventListener('pointermove', (e) => {
  if (padPointer !== e.pointerId) return;
  e.preventDefault();
  const rect = els.radarPanel.getBoundingClientRect();
  const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
  const now = performance.now();
  const dt = Math.max(0.008, (now - lastPadTime) / 1000);
  const vx = lastPadPos ? (nx - lastPadPos.nx) / dt : 0;
  const vy = lastPadPos ? (ny - lastPadPos.ny) / dt : 0;
  lastPadPos = { nx, ny };
  lastPadTime = now;
  updateTouchCrosshair(nx, ny);
  sensor.applyTouchAim(nx, ny, vx, vy);
});

const endPad = (e) => {
  if (padPointer === e.pointerId) {
    padPointer = null;
    lastPadPos = null;
  }
};
els.radarPanel.addEventListener('pointerup', endPad);
els.radarPanel.addEventListener('pointercancel', endPad);

// ZERO requestAnimationFrame UI loop on the phone!
// Gently refresh the 1-line Hz readout once per second so 100% of phone CPU stays on IMU + WebSocket.
setInterval(() => {
  if (!linked || sensor.mode !== 'gyro') return;
  const hz = sensor.state.sampleHz;
  const link = udpOpen ? 'UDP' : 'WS';
  els.radarMeta.textContent = hz > 0 ? `GYRO ${link} · ${hz}HZ · POINT AT SCREEN` : `GYRO ${link} · POINT AT SCREEN`;
}, 1000);
