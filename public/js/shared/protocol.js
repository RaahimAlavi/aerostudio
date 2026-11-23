export const PLAYER_PROFILES = [
  { slot: 0, label: 'P1', name: 'COBALT', color: '#2563EB', glow: 'rgba(37, 99, 235, 0.35)', soft: '#93C5FD' },
  { slot: 1, label: 'P2', name: 'CORAL', color: '#E11D48', glow: 'rgba(225, 29, 72, 0.35)', soft: '#FDA4AF' },
  { slot: 2, label: 'P3', name: 'EMERALD', color: '#059669', glow: 'rgba(5, 150, 105, 0.35)', soft: '#6EE7B7' },
  { slot: 3, label: 'P4', name: 'AMBER', color: '#D97706', glow: 'rgba(217, 119, 6, 0.35)', soft: '#FCD34D' },
];

export const SCULPT_PALETTE = [
  { id: 'cobalt', name: 'Cobalt', hex: '#2563EB' },
  { id: 'coral', name: 'Coral', hex: '#F43F5E' },
  { id: 'emerald', name: 'Mint', hex: '#10B981' },
  { id: 'amber', name: 'Saffron', hex: '#F59E0B' },
  { id: 'violet', name: 'Iris', hex: '#7C3AED' },
  { id: 'rose', name: 'Blush', hex: '#EC4899' },
  { id: 'obsidian', name: 'Ink', hex: '#18181B' },
  { id: 'pearl', name: 'Porcelain', hex: '#F8FAFC' },
];

export const MODE_INFO = {
  hub: {
    id: 'hub',
    title: 'AERO STUDIO',
    aLabel: 'SELECT',
    bLabel: 'BOOST',
    gestureHint: 'POINT AT AN EXPERIENCE AND PRESS A',
  },
  blade: {
    id: 'blade',
    title: 'BLADE ARENA',
    aLabel: 'POWER SLASH',
    bLabel: 'SLOW-MO',
    gestureHint: 'WHIP TO SLICE · 3 LIVES · AVOID SPIKE MINES',
  },
  sculpt: {
    id: 'sculpt',
    title: 'SCULPT 3D',
    aLabel: 'SCULPT / ERASE',
    bLabel: 'ORBIT SPIN',
    gestureHint: 'HOLD A TO SCULPT · PICK COLORS & ERASER BELOW',
  },
  strike: {
    id: 'strike',
    title: 'STRIKE TABLE',
    aLabel: 'POWER SMASH',
    bLabel: 'BOOST',
    gestureHint: 'SLIDE PHONE TO DEFEND & SMASH · FIRST TO 7',
  },
  sketch: {
    id: 'sketch',
    title: 'AIR SKETCH',
    aLabel: 'HOLD TO DRAW',
    bLabel: 'UNDO',
    gestureHint: 'DRAW THE SECRET WORD OR GUESS LIVE',
  },
};

export const PKT_MOTION = 0x01;
export const MOTION_PACKET_BYTES = 18;

export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function encodeMotionPacket(view, { x, y, roll, yawDeg, pitchDeg, g, sw, a, b, hz = 60, highRate = false }) {
  view.setUint8(0, PKT_MOTION);
  view.setUint8(1, 0);
  view.setUint8(2, (a ? 1 : 0) | (b ? 2 : 0) | (highRate ? 4 : 0));
  view.setUint8(3, clamp(Math.round(hz), 0, 255));
  view.setUint16(4, Math.round(clamp(x, 0, 1) * 65535), true);
  view.setUint16(6, Math.round(clamp(y, 0, 1) * 65535), true);
  view.setInt16(8, Math.round(clamp(roll, -Math.PI, Math.PI) * 10000), true);
  view.setInt16(10, Math.round(clamp(yawDeg, -180, 180) * 100), true);
  view.setInt16(12, Math.round(clamp(pitchDeg, -180, 180) * 100), true);
  view.setUint16(14, Math.round(clamp(g, 0, 10) * 1000), true);
  view.setUint16(16, Math.round(clamp(sw, 0, 10) * 1000), true);
}

export function decodeMotionPacket(buffer) {
  if (!buffer || buffer.byteLength < MOTION_PACKET_BYTES) return null;
  const view = new DataView(buffer);
  if (view.getUint8(0) !== PKT_MOTION) return null;
  const flags = view.getUint8(2);
  const roll = view.getInt16(8, true) / 10000;
  return {
    slot: view.getUint8(1),
    a: (flags & 1) !== 0 ? 1 : 0,
    b: (flags & 2) !== 0 ? 1 : 0,
    highRate: (flags & 4) !== 0,
    nativeUdp: (flags & 8) !== 0,
    hz: view.getUint8(3),
    x: view.getUint16(4, true) / 65535,
    y: view.getUint16(6, true) / 65535,
    roll,
    rollDeg: (roll * 180) / Math.PI,
    yawDeg: view.getInt16(10, true) / 100,
    pitchDeg: view.getInt16(12, true) / 100,
    g: view.getUint16(14, true) / 1000,
    sw: view.getUint16(16, true) / 1000,
  };
}

/**
 * High-responsiveness One-Euro Filter for normalized [0..1] coords.
 * Eliminates micro-tremor at rest while snapping instantly during movement.
 */
export class OneEuroFilter {
  constructor(minCutoff = 6.5, beta = 42.0, dCutoff = 2.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }

  reset(value = null) {
    this.xPrev = value;
    this.dxPrev = 0;
    this.tPrev = null;
  }

  _alpha(cutoff, dt) {
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / dt);
  }

  filter(x, tMs) {
    if (this.xPrev === null || this.tPrev === null) {
      this.xPrev = x;
      this.dxPrev = 0;
      this.tPrev = tMs;
      return x;
    }

    const dt = Math.max(0.002, Math.min(0.1, (tMs - this.tPrev) / 1000));
    this.tPrev = tMs;

    const dx = (x - this.xPrev) / dt;
    const aD = this._alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;

    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const aX = this._alpha(cutoff, dt);
    const xHat = aX * x + (1 - aX) * this.xPrev;

    this.xPrev = xHat;
    this.dxPrev = dxHat;
    return xHat;
  }
}
