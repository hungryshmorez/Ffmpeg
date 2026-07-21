import * as THREE from 'three';

// First-person festival walk. Drag to look, WASD/arrows to move, or click a
// person / spot to auto-walk there. Keeps the camera at eye height and inside
// the field. Auto-walk is cancelled the moment you take manual control.
export class WalkControls {
  constructor(camera, { bounds = 42, eye = 1.6 } = {}) {
    this.cam = camera;
    this.bounds = bounds;
    this.eye = eye;
    this.yaw = 0;                // face -Z (the stage) on spawn
    this.pitch = -0.02;
    this.pos = new THREE.Vector3(0, eye, 8);
    this.walkTarget = null;      // THREE.Vector3 | null
    this.onArrive = null;
    this.speed = 7.2;
    this.keys = new Set();
    this._tmp = new THREE.Vector3();

    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'].includes(k)) {
        this.keys.add(k); this.walkTarget = null; // manual move cancels auto-walk
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    this._apply();
  }

  look(dx, dy) {
    this.yaw -= dx * 0.0045;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.0045, -0.6, 0.5);
  }

  walkTo(vec, onArrive = null) {
    this.walkTarget = new THREE.Vector3(vec.x, this.eye, vec.z);
    this.onArrive = onArrive;
  }

  stop() { this.walkTarget = null; }

  update(dt) {
    const k = this.keys;
    const forward = (k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0);
    const strafe = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0);
    const run = k.has('shift') ? 1.7 : 1;

    if (forward || strafe) {
      const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw);
      // forward is -Z in view space
      const fx = -sinY, fz = -cosY;
      const rx = cosY, rz = -sinY;
      const vx = (fx * forward + rx * strafe);
      const vz = (fz * forward + rz * strafe);
      const len = Math.hypot(vx, vz) || 1;
      this.pos.x += (vx / len) * this.speed * run * dt;
      this.pos.z += (vz / len) * this.speed * run * dt;
    } else if (this.walkTarget) {
      // auto-walk toward a clicked destination, turning to face it
      this._tmp.subVectors(this.walkTarget, this.pos); this._tmp.y = 0;
      const dist = this._tmp.length();
      if (dist < 2.4) {
        const cb = this.onArrive; this.walkTarget = null; this.onArrive = null;
        if (cb) cb();
      } else {
        this._tmp.normalize();
        this.pos.x += this._tmp.x * this.speed * dt;
        this.pos.z += this._tmp.z * this.speed * dt;
        // ease yaw to face travel direction
        const want = Math.atan2(-this._tmp.x, -this._tmp.z);
        this.yaw = easeAngle(this.yaw, want, 1 - Math.pow(0.001, dt));
      }
    }

    // clamp to field, never behind the stage
    this.pos.x = THREE.MathUtils.clamp(this.pos.x, -this.bounds, this.bounds);
    this.pos.z = THREE.MathUtils.clamp(this.pos.z, -18, this.bounds);
    this.pos.y = this.eye;
    this._apply();
  }

  _apply() {
    this.cam.position.copy(this.pos);
    this._tmp.set(
      this.pos.x - Math.sin(this.yaw) * Math.cos(this.pitch),
      this.pos.y + Math.sin(this.pitch),
      this.pos.z - Math.cos(this.yaw) * Math.cos(this.pitch)
    );
    this.cam.lookAt(this._tmp);
  }
}

function easeAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  return a + d * t;
}
