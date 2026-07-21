import * as THREE from 'three';

// 2D overlay driven by the 3D scene: floating name tags above each artist
// (projected each frame), a "walk closer" prompt, and the destination panel
// that opens when you reach someone.
export class Hud {
  constructor(root, camera, characters) {
    this.cam = camera;
    this.characters = characters;
    this._v = new THREE.Vector3();
    this.activeId = null;

    // name tags
    this.tags = new Map();
    for (const c of characters) {
      const el = document.createElement('div');
      el.className = 'tag';
      el.style.setProperty('--c', c.dest.accent);
      el.innerHTML = `<b>${c.dest.name}</b><span>${c.dest.tag}</span>`;
      root.appendChild(el);
      this.tags.set(c.dest.id, el);
    }

    // panel
    this.panel = document.getElementById('panel');
    this.pTitle = document.getElementById('pTitle');
    this.pRole = document.getElementById('pRole');
    this.pBody = document.getElementById('pBody');
    this.pCta = document.getElementById('pCta');
    document.getElementById('pClose').onclick = () => this.close();
    this.pCta.onclick = () => {
      const t = this.pCta.textContent;
      this.pCta.textContent = '// wired to the real EPK on build';
      setTimeout(() => (this.pCta.textContent = t), 1500);
    };

    this.prompt = document.getElementById('prompt');
  }

  open(c) {
    this.activeId = c.dest.id;
    this.panel.style.setProperty('--c', c.dest.accent);
    this.pTitle.textContent = c.dest.name;
    this.pRole.textContent = c.dest.role;
    this.pBody.textContent = c.dest.blurb;
    this.pCta.textContent = c.dest.cta;
    this.panel.classList.add('on');
  }
  close() { this.panel.classList.remove('on'); this.activeId = null; }

  update(playerPos) {
    const W = innerWidth, H = innerHeight;
    let near = null, nearD = Infinity;
    for (const c of this.characters) {
      const el = this.tags.get(c.dest.id);
      this._v.copy(c.worldPos); this._v.y += 0.9;
      this._v.project(this.cam);
      const behind = this._v.z > 1;
      if (behind) { el.style.opacity = '0'; }
      else {
        const x = (this._v.x * 0.5 + 0.5) * W;
        const y = (-this._v.y * 0.5 + 0.5) * H;
        const d = playerPos.distanceTo(c.worldPos);
        const fade = THREE.MathUtils.clamp(1 - (d - 6) / 26, 0.15, 1);
        el.style.transform = `translate(-50%,-100%) translate(${x}px,${y}px)`;
        el.style.opacity = String(fade);
        el.classList.toggle('close', d < 4.5);
        if (d < nearD) { nearD = d; near = c; }
      }
    }

    // proximity: auto-open the nearest destination when you arrive
    if (near && nearD < 4.2) {
      if (this.activeId !== near.dest.id) this.open(near);
      this.prompt.classList.remove('on');
    } else {
      if (this.activeId) this.close();
      // hint when someone is moderately close but not reached
      if (near && nearD < 9) { this.prompt.textContent = `walk up to ${near.dest.name}`; this.prompt.classList.add('on'); }
      else this.prompt.classList.remove('on');
    }
  }
}
