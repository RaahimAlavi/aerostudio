import { clamp } from '../shared/protocol.js';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/**
 * Mobile-Optimized Zero-Allocation Motion Sensor Engine
 * - Zero per-frame array/object allocations (no mobile GC stutters!)
 * - Clean single-source orientation (RelativeOrientationSensor 60Hz -> DeviceOrientation fallback)
 * - Streams raw unfiltered coordinates straight to the fast PC Host for 180Hz spring reconstruction
 * - Lightweight scalar devicemotion gesture detection (slash, flick-up, shake)
 */
export class MotionSensorEngine {
  constructor({ onGesture, onStatusChange, onSample } = {}) {
    this.onGesture = onGesture || (() => {});
    this.onStatusChange = onStatusChange || (() => {});
    this.onSample = onSample || (() => {});

    this.mode = 'pending'; // 'gyro' | 'touch' | 'pending'
    this.highRateSensor = false;
    this.active = false;
    this.hasOrientation = false;
    this.calibrated = false;

    this.relSensor = null;
    this.usingRelSensor = false;

    // Horizon-aligned virtual screen frame (flat scalars — zero array allocations!)
    this.fx = 0; this.fy = 1; this.fz = 0; // fwdScreen
    this.rx = 1; this.ry = 0; this.rz = 0; // rightScreen
    this.ux = 0; this.uy = 0; this.uz = 1; // upScreen

    // Pure ground-plane horizontal heading basis (cancels cos(pitch) horizontal slowdown!)
    this.hfx = 0; this.hfy = 1;
    this.hrx = 1; this.hry = 0;
    this.calPitchRad = 0;

    // Latest phone basis (flat scalars)
    this.lrx = 1; this.lry = 0; this.lrz = 0; // phone right (+X)
    this.ltx = 0; this.lty = 1; this.ltz = 0; // phone top (+Y barrel)

    this.sensitivity = 1.0;
    // Ergonomic Wii-style wrist range: ±16.5° horizontal, ±13° vertical reaches full widescreen edge-to-edge!
    this.baseHalfFovX = 16.5 * DEG2RAD;
    this.baseHalfFovY = 13.0 * DEG2RAD;

    this.state = {
      x: 0.5,
      y: 0.5,
      roll: 0,
      pitchDeg: 0,
      yawDeg: 0,
      rollDeg: 0,
      gForce: 0,
      swingPower: 0,
      sampleHz: 0,
      highRate: false,
    };

    // High-pass gravity fallback
    this.gx = 0; this.gy = 0; this.gz = 9.81;

    this._sampleCount = 0;
    this._rateWindowStart = performance.now();
    this._lastEmitMs = 0;

    this.lastSlashMs = 0;
    this.lastFlickUpMs = 0;
    this.lastShakeMs = 0;
    this._shakeCount = 0;
    this._shakeWindowMs = 0;

    this._boundOrientation = this._handleOrientation.bind(this);
    this._boundMotion = this._handleMotion.bind(this);
    this._fallbackTimer = null;
  }

  setSensitivity(mult) {
    this.sensitivity = clamp(mult, 0.6, 1.8);
  }

  async requestPermissionsAndStart() {
    let permissionError = null;

    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== 'granted') permissionError = 'Motion sensor permission denied';
      } catch (err) {
        permissionError = err.message || 'Permission request failed';
      }
    }

    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        await DeviceMotionEvent.requestPermission();
      } catch (_) {}
    }

    this.active = true;
    this._tryStartRelSensor();
    window.addEventListener('deviceorientation', this._boundOrientation, true);
    window.addEventListener('devicemotion', this._boundMotion, true);

    clearTimeout(this._fallbackTimer);
    this._fallbackTimer = setTimeout(() => {
      if (!this.hasOrientation) {
        this.mode = 'touch';
        this.onStatusChange(this.mode, permissionError);
      }
    }, 1300);

    return { ok: !permissionError, error: permissionError };
  }

  _tryStartRelSensor() {
    if (typeof window.RelativeOrientationSensor !== 'function') return;
    try {
      // 60Hz is universally accepted by Android Chrome without SecurityError or Wi-Fi saturation
      const sensor = new window.RelativeOrientationSensor({ frequency: 60, referenceFrame: 'device' });
      sensor.addEventListener('reading', () => {
        if (!this.active || !sensor.quaternion) return;
        if (!this.usingRelSensor) {
          this.usingRelSensor = true;
          this.highRateSensor = true;
          this.state.highRate = true;
          window.removeEventListener('deviceorientation', this._boundOrientation, true);
        }
        const q = sensor.quaternion;
        const x = q[0], y = q[1], z = q[2], w = q[3];
        const xx = x * x, yy = y * y, zz = z * z;
        const xy = x * y, xz = x * z, yz = y * z;
        const wx = w * x, wy = w * y, wz = w * z;

        this._ingestVectors(
          1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), // phone right (+X)
          2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx)  // phone top (+Y)
        );
      });
      sensor.addEventListener('error', () => {
        this.usingRelSensor = false;
        this.highRateSensor = false;
      });
      sensor.start();
      this.relSensor = sensor;
    } catch (_) {
      this.relSensor = null;
    }
  }

  stop() {
    this.active = false;
    clearTimeout(this._fallbackTimer);
    window.removeEventListener('deviceorientation', this._boundOrientation, true);
    window.removeEventListener('devicemotion', this._boundMotion, true);
    if (this.relSensor) {
      try {
        this.relSensor.stop();
      } catch (_) {}
      this.relSensor = null;
    }
  }

  recenter() {
    if (this.hasOrientation) {
      this._calibrateCurrent();
      this.state.x = 0.5;
      this.state.y = 0.5;
      this.onSample(this.state);
      return true;
    }
    this.state.x = 0.5;
    this.state.y = 0.5;
    this.state.roll = 0;
    this.state.pitchDeg = 0;
    this.state.yawDeg = 0;
    this.state.rollDeg = 0;
    this.onSample(this.state);
    return false;
  }

  _calibrateCurrent() {
    // Normalize current pointing ray (phone top +Y)
    const flen = Math.hypot(this.ltx, this.lty, this.ltz) || 1;
    this.fx = this.ltx / flen;
    this.fy = this.lty / flen;
    this.fz = this.ltz / flen;

    // Ground-plane horizontal heading (immune to upward phone tilt foreshortening!)
    const hlen = Math.hypot(this.ltx, this.lty);
    if (hlen >= 0.25) {
      this.hfx = this.ltx / hlen;
      this.hfy = this.lty / hlen;
    } else {
      // Phone held nearly vertical during calibration: derive forward from horizontal right rotated CCW 90°
      const rlen2 = Math.hypot(this.lrx, this.lry) || 1;
      const rx2 = this.lrx / rlen2;
      const ry2 = this.lry / rlen2;
      this.hfx = -ry2;
      this.hfy = rx2;
    }
    this.hrx = this.hfy;
    this.hry = -this.hfx;
    this.calPitchRad = Math.asin(clamp(this.fz, -1, 1));

    // Orthogonal screen basis for roll projection
    this.rx = this.hrx;
    this.ry = this.hry;
    this.rz = 0;

    const ux = this.ry * this.fz - this.rz * this.fy;
    const uy = this.rz * this.fx - this.rx * this.fz;
    const uz = this.rx * this.fy - this.ry * this.fx;
    const ulen = Math.hypot(ux, uy, uz) || 1;
    this.ux = ux / ulen;
    this.uy = uy / ulen;
    this.uz = uz / ulen;
    this.calibrated = true;
  }

  _handleOrientation(e) {
    if (this.usingRelSensor) return;
    if (e.alpha === null && e.beta === null && e.gamma === null) return;

    const a = (e.alpha || 0) * DEG2RAD;
    const b = (e.beta || 0) * DEG2RAD;
    const g = (e.gamma || 0) * DEG2RAD;

    const cZ = Math.cos(a), sZ = Math.sin(a);
    const cX = Math.cos(b), sX = Math.sin(b);
    const cY = Math.cos(g), sY = Math.sin(g);

    // Flat scalar computation — zero temporary arrays or objects!
    this._ingestVectors(
      cZ * cY - sZ * sX * sY, sZ * cY + cZ * sX * sY, -cX * sY,
      -sZ * cX, cZ * cX, sX
    );
  }

  _ingestVectors(prx, pry, prz, ptx, pty, ptz) {
    const now = performance.now();
    this.lrx = prx; this.lry = pry; this.lrz = prz;
    this.ltx = ptx; this.lty = pty; this.ltz = ptz;

    this._sampleCount++;
    const elapsed = now - this._rateWindowStart;
    if (elapsed >= 750) {
      this.state.sampleHz = Math.round((this._sampleCount * 1000) / elapsed);
      this._sampleCount = 0;
      this._rateWindowStart = now;
    }

    if (!this.hasOrientation) {
      this.hasOrientation = true;
      clearTimeout(this._fallbackTimer);
      this.mode = 'gyro';
      this._calibrateCurrent();
      this.onStatusChange('gyro', null);
    } else if (!this.calibrated) {
      this._calibrateCurrent();
    }

    // True ground-plane horizontal azimuth yaw (cos(pitch) cancels completely -> identical crisp left/right speed at ANY tilt!)
    const hLen = Math.hypot(ptx, pty);
    let yawRad;
    if (hLen >= 0.3) {
      const hx = ptx * this.hrx + pty * this.hry;
      const hz = ptx * this.hfx + pty * this.hfy;
      yawRad = Math.atan2(hx, hz);
    } else {
      // Seamless vertical-wand fallback using horizontal phone-right vector
      const hx = -(prx * this.hfx + pry * this.hfy);
      const hz = prx * this.hrx + pry * this.hry;
      yawRad = Math.atan2(hx, hz);
    }

    // Relative vertical pitch from calibrated rest elevation
    const pitchRad = Math.asin(clamp(ptz, -1, 1)) - this.calPitchRad;

    const rDotUp = prx * this.ux + pry * this.uy + prz * this.uz;
    const rDotRight = prx * this.rx + pry * this.ry + prz * this.rz;
    const rollRad = Math.atan2(-rDotUp, rDotRight);

    const halfFovX = this.baseHalfFovX / this.sensitivity;
    const halfFovY = this.baseHalfFovY / this.sensitivity;

    this.state.x = clamp(0.5 + yawRad / (2 * halfFovX), 0, 1);
    this.state.y = clamp(0.5 - pitchRad / (2 * halfFovY), 0, 1);
    this.state.roll = rollRad;
    this.state.yawDeg = yawRad * RAD2DEG;
    this.state.pitchDeg = pitchRad * RAD2DEG;
    this.state.rollDeg = rollRad * RAD2DEG;

    // Clean ~120Hz max send rate (8ms spacing) — direct UDP DataChannel handles it effortlessly!
    if (now - this._lastEmitMs >= 8.0) {
      this._lastEmitMs = now;
      this.onSample(this.state);
    }
  }

  _handleMotion(e) {
    // Strictly lightweight scalar gesture impulse detector (never fights orientation!)
    let ax = 0, ay = 0, az = 0;
    const acc = e.acceleration;
    if (acc && acc.x !== null) {
      ax = acc.x || 0;
      ay = acc.y || 0;
      az = acc.z || 0;
    } else {
      const ag = e.accelerationIncludingGravity;
      if (!ag || ag.x === null) return;
      const gx = ag.x || 0, gy = ag.y || 0, gz = ag.z || 0;
      this.gx = 0.82 * this.gx + 0.18 * gx;
      this.gy = 0.82 * this.gy + 0.18 * gy;
      this.gz = 0.82 * this.gz + 0.18 * gz;
      ax = gx - this.gx;
      ay = gy - this.gy;
      az = gz - this.gz;
    }

    const rr = e.rotationRate;
    const rAlpha = rr ? rr.alpha || 0 : 0;
    const rBeta = rr ? rr.beta || 0 : 0;
    const rGamma = rr ? rr.gamma || 0 : 0;

    const accelMag = Math.hypot(ax, ay, az);
    const rotMag = Math.hypot(rAlpha, rBeta, rGamma);
    const swingPower = Math.max(accelMag / 14, rotMag / 260);

    this.state.gForce = accelMag / 9.81;
    this.state.swingPower = swingPower;

    if (swingPower < 0.95 && accelMag < 14.5) return;

    const now = performance.now();
    if (swingPower > 1.05 && now - this.lastSlashMs > 190) {
      this.lastSlashMs = now;
      this.onGesture({ kind: 'slash', power: Math.min(3.0, swingPower) });
    }

    if (accelMag > 15.0) {
      if (now - this._shakeWindowMs > 380) {
        this._shakeWindowMs = now;
        this._shakeCount = 1;
      } else {
        this._shakeCount++;
        if (this._shakeCount >= 3 && now - this.lastShakeMs > 680) {
          this.lastShakeMs = now;
          this._shakeCount = 0;
          this.onGesture({ kind: 'shake', power: Math.min(3.0, accelMag / 14) });
        }
      }
    }
  }

  applyTouchAim(nx, ny, vx = 0, vy = 0) {
    const now = performance.now();
    this.state.x = clamp(nx, 0, 1);
    this.state.y = clamp(ny, 0, 1);
    this.state.yawDeg = (this.state.x - 0.5) * 54;
    this.state.pitchDeg = (0.5 - this.state.y) * 36;
    const speed = Math.hypot(vx, vy);
    this.state.swingPower = Math.min(2.5, speed * 1.4);
    this.state.gForce = Math.min(3, speed * 1.2);
    this.state.sampleHz = 60;
    if (speed > 1.3 && now - this.lastSlashMs > 200) {
      this.lastSlashMs = now;
      this.onGesture({ kind: 'slash', power: Math.min(2.5, speed) });
    }
    this.onSample(this.state);
  }
}
