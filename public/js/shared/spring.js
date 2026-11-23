/**
 * Real damped harmonic spring physics for UI elements (buttons, cards, swatches, modals).
 * Gives every click, hover, and reveal physical inertia and elastic rebound.
 */

export class SpringVal {
  constructor(initial = 0, stiffness = 360, damping = 22) {
    this.value = initial;
    this.target = initial;
    this.velocity = 0;
    this.stiffness = stiffness;
    this.damping = damping;
  }

  impulse(v) {
    this.velocity += v;
  }

  step(dt) {
    const clampedDt = Math.min(0.032, dt);
    const force = -this.stiffness * (this.value - this.target);
    const damp = -this.damping * this.velocity;
    this.velocity += (force + damp) * clampedDt;
    this.value += this.velocity * clampedDt;
    return this.value;
  }

  isSettled() {
    return Math.abs(this.value - this.target) < 0.0005 && Math.abs(this.velocity) < 0.001;
  }
}

class SpringUIManager {
  constructor() {
    this.items = new Map();
    this.running = false;
    this.lastMs = 0;
    this._tick = this._tick.bind(this);
  }

  attach(el, opts = {}) {
    if (!el || this.items.has(el)) return;
    const hoverScale = opts.hoverScale ?? 1.035;
    const pressScale = opts.pressScale ?? 0.935;
    const magnetic = opts.magnetic ?? 0; // px max shift on hover
    const tilt = opts.tilt ?? 0; // deg max 3D tilt on hover
    const stiffness = opts.stiffness ?? 420;
    const damping = opts.damping ?? 24;

    const item = {
      el,
      scale: new SpringVal(1, stiffness, damping),
      tx: new SpringVal(0, 320, 22),
      ty: new SpringVal(0, 320, 22),
      rx: new SpringVal(0, 280, 22),
      ry: new SpringVal(0, 280, 22),
      hoverScale,
      pressScale,
      magnetic,
      tilt,
      hovered: false,
      pressed: false,
    };

    const wake = () => this._start();

    el.addEventListener('pointerenter', () => {
      item.hovered = true;
      item.scale.target = item.pressed ? item.pressScale : item.hoverScale;
      wake();
    });

    el.addEventListener('pointermove', (e) => {
      if (!item.hovered || (item.magnetic === 0 && item.tilt === 0)) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const nx = ((e.clientX - r.left) / r.width - 0.5) * 2; // -1..1
      const ny = ((e.clientY - r.top) / r.height - 0.5) * 2;
      item.tx.target = nx * item.magnetic;
      item.ty.target = ny * item.magnetic;
      item.rx.target = -ny * item.tilt;
      item.ry.target = nx * item.tilt;
      wake();
    });

    el.addEventListener('pointerleave', () => {
      item.hovered = false;
      item.pressed = false;
      item.scale.target = 1;
      item.tx.target = 0;
      item.ty.target = 0;
      item.rx.target = 0;
      item.ry.target = 0;
      wake();
    });

    el.addEventListener('pointerdown', () => {
      item.pressed = true;
      item.scale.target = item.pressScale;
      item.scale.impulse(-1.4);
      wake();
    });

    const release = () => {
      if (!item.pressed) return;
      item.pressed = false;
      item.scale.target = item.hovered ? item.hoverScale : 1;
      item.scale.impulse(1.85); // Crisp tactile elastic bounce on release!
      wake();
    };

    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);

    this.items.set(el, item);
  }

  /** Programmatic spring hover / bounce when driven by a wireless phone remote! */
  setRemoteHover(el, hovered, nx = 0, ny = 0) {
    const item = this.items.get(el);
    if (!item) return;
    if (hovered !== item.hovered) {
      item.hovered = hovered;
      item.scale.target = hovered ? item.hoverScale : 1;
      if (hovered) item.scale.impulse(0.65);
    }
    if (hovered) {
      item.tx.target = nx * item.magnetic;
      item.ty.target = ny * item.magnetic;
      item.rx.target = -ny * item.tilt;
      item.ry.target = nx * item.tilt;
    } else {
      item.tx.target = 0;
      item.ty.target = 0;
      item.rx.target = 0;
      item.ry.target = 0;
    }
    this._start();
  }

  pulse(el, strength = 2.2) {
    const item = this.items.get(el);
    if (!item) return;
    item.scale.value = 0.92;
    item.scale.impulse(strength);
    this._start();
  }

  _start() {
    if (this.running) return;
    this.running = true;
    this.lastMs = performance.now();
    requestAnimationFrame(this._tick);
  }

  _tick(nowMs) {
    const dt = Math.min(0.032, Math.max(0.002, (nowMs - this.lastMs) / 1000));
    this.lastMs = nowMs;

    let anyActive = false;
    for (const item of this.items.values()) {
      const s = item.scale.step(dt);
      const tx = item.tx.step(dt);
      const ty = item.ty.step(dt);
      const rx = item.rx.step(dt);
      const ry = item.ry.step(dt);

      const settled =
        item.scale.isSettled() &&
        item.tx.isSettled() &&
        item.ty.isSettled() &&
        item.rx.isSettled() &&
        item.ry.isSettled();

      if (settled) {
        if (item.scale.target === 1 && item.tx.target === 0 && item.ty.target === 0) {
          item.el.style.transform = '';
        } else {
          item.el.style.transform = `perspective(700px) translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) scale(${s.toFixed(4)})`;
        }
      } else {
        anyActive = true;
        item.el.style.transform = `perspective(700px) translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) scale(${s.toFixed(4)})`;
      }
    }

    if (anyActive) {
      requestAnimationFrame(this._tick);
    } else {
      this.running = false;
    }
  }
}

export const springUI = new SpringUIManager();

export function bindSpringButtons(root = document) {
  root.querySelectorAll('[data-spring]').forEach((el) => {
    const preset = el.dataset.spring;
    if (preset === 'card') {
      springUI.attach(el, { hoverScale: 1.022, pressScale: 0.972, magnetic: 5, tilt: 4.5, stiffness: 360, damping: 23 });
    } else if (preset === 'swatch') {
      springUI.attach(el, { hoverScale: 1.16, pressScale: 0.86, magnetic: 2, stiffness: 520, damping: 20 });
    } else {
      springUI.attach(el, { hoverScale: 1.045, pressScale: 0.93, magnetic: 3, stiffness: 460, damping: 22 });
    }
  });
}
