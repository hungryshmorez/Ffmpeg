import * as THREE from 'three';
import { PALETTE } from '../data/destinations.js';

// Builds the static + animated festival world: ground, sky, main stage,
// truss, big screen, moving-head spotlights, lasers, haze. Returns an
// updater driven by the global beat `pulse` (0..1, spikes on each beat).
export function buildFestival(scene) {
  const updaters = [];

  // ---------- sky dome ----------
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(140, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: {
        top: { value: new THREE.Color(0x05050f) },
        mid: { value: new THREE.Color(0x0d0a22) },
        bot: { value: new THREE.Color(0x1a0a24) },
      },
      vertexShader: `varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
      fragmentShader: `varying vec3 vP; uniform vec3 top,mid,bot;
        void main(){ float h=normalize(vP).y; vec3 c=mix(bot,mid,smoothstep(-0.15,0.3,h)); c=mix(c,top,smoothstep(0.25,0.85,h)); gl_FragColor=vec4(c,1.0);} `,
    })
  );
  scene.add(sky);

  // ---------- stars ----------
  {
    const N = 1200, pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    const cyan = new THREE.Color(PALETTE.cyan), mag = new THREE.Color(PALETTE.magenta), w = new THREE.Color(0xcfe9ff);
    for (let i = 0; i < N; i++) {
      const r = 70 + Math.random() * 60, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = Math.abs(r * Math.cos(ph)) * 0.6 + 8;
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
      const c = Math.random() < 0.1 ? cyan : (Math.random() < 0.08 ? mag : w);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({
      size: 0.7, map: dot(), vertexColors: true, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    })));
  }

  // ---------- ground ----------
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(160, 160),
    new THREE.MeshStandardMaterial({ color: 0x080810, roughness: 1, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const grid = new THREE.GridHelper(160, 80, 0x123038, 0x0a1016);
  grid.material.transparent = true; grid.material.opacity = 0.35; grid.position.y = 0.012; scene.add(grid);

  // ---------- lights (base) ----------
  scene.add(new THREE.AmbientLight(0x223046, 0.5));
  const moon = new THREE.DirectionalLight(0x8fa8ff, 0.35);
  moon.position.set(-10, 24, 12); moon.castShadow = true;
  moon.shadow.mapSize.set(1024, 1024);
  const sc = moon.shadow.camera; sc.left = -34; sc.right = 34; sc.top = 34; sc.bottom = -34; sc.near = 1; sc.far = 80;
  scene.add(moon);

  // ---------- stage ----------
  const stageZ = -26;
  const stage = new THREE.Group(); scene.add(stage);
  const deck = new THREE.Mesh(
    new THREE.BoxGeometry(30, 1.6, 10),
    new THREE.MeshStandardMaterial({ color: 0x0a0a12, roughness: .8, metalness: .3 })
  );
  deck.position.set(0, 0.8, stageZ); deck.receiveShadow = true; deck.castShadow = true; stage.add(deck);

  // big LED screen (animated emissive shader)
  const screenMat = new THREE.ShaderMaterial({
    uniforms: { t: { value: 0 }, pulse: { value: 0 },
      cA: { value: new THREE.Color(PALETTE.cyan) }, cB: { value: new THREE.Color(PALETTE.magenta) } },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
    fragmentShader: `varying vec2 vUv; uniform float t,pulse; uniform vec3 cA,cB;
      float bar(float x,float s){ return smoothstep(0.0,0.02,abs(fract(x*s+t*0.1)-0.5)); }
      void main(){
        vec2 u=vUv; float scan=sin((u.y+t*0.3)*60.0)*0.5+0.5;
        float cols=step(0.5,fract(u.x*18.0 + sin(u.y*8.0+t)*0.3));
        vec3 c=mix(cA,cB,u.x*0.6+0.2*sin(t+u.y*6.0));
        c*= (0.4+0.6*scan)*(0.6+0.8*pulse) * (0.5+0.5*cols);
        gl_FragColor=vec4(c,1.0);
      }`,
  });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(22, 7), screenMat);
  screen.position.set(0, 6.2, stageZ - 4.9); stage.add(screen);

  // truss frame
  const truss = new THREE.MeshStandardMaterial({ color: 0x141420, roughness: .5, metalness: .7 });
  const post = (x) => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 11, 0.5), truss); m.position.set(x, 5.5, stageZ - 4.7); m.castShadow = true; stage.add(m); };
  post(-12); post(12);
  const topBar = new THREE.Mesh(new THREE.BoxGeometry(24.5, 0.5, 0.5), truss);
  topBar.position.set(0, 10.6, stageZ - 4.7); stage.add(topBar);

  // ---------- moving-head spotlights ----------
  const spots = [];
  const spotColors = [PALETTE.cyan, PALETTE.magenta, PALETTE.green, PALETTE.purple];
  for (let i = 0; i < 4; i++) {
    const s = new THREE.SpotLight(new THREE.Color(spotColors[i]), 60, 60, Math.PI / 9, 0.4, 1.2);
    s.position.set(-9 + i * 6, 10.2, stageZ - 4.4);
    s.target.position.set(-14 + i * 9, 0, 4);
    scene.add(s, s.target);
    // visible cone beam (additive)
    const beam = new THREE.Mesh(
      new THREE.ConeGeometry(2.6, 20, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: spotColors[i], transparent: true, opacity: 0.06, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    beam.position.copy(s.position); stage.add(beam);
    spots.push({ light: s, beam, phase: i * 1.7, base: new THREE.Vector3(-9 + i * 6, 10.2, stageZ - 4.4) });
  }

  // ---------- lasers ----------
  const laserGeo = new THREE.BufferGeometry();
  const LN = 14;
  const lpos = new Float32Array(LN * 2 * 3);
  for (let i = 0; i < LN; i++) {
    lpos.set([0, 10.4, stageZ - 4.4], i * 6);
    lpos.set([(i - LN / 2) * 4, 0.2, 12], i * 6 + 3);
  }
  laserGeo.setAttribute('position', new THREE.BufferAttribute(lpos, 3));
  const lasers = new THREE.LineSegments(laserGeo, new THREE.LineBasicMaterial({
    color: new THREE.Color(PALETTE.green), transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  scene.add(lasers);

  // ---------- haze near stage ----------
  scene.fog = new THREE.FogExp2(0x07071a, 0.017);

  // ---------- updater ----------
  updaters.push((dt, time, pulse) => {
    screenMat.uniforms.t.value = time;
    screenMat.uniforms.pulse.value = pulse;
    for (const sp of spots) {
      const sweep = Math.sin(time * 0.7 + sp.phase);
      sp.light.target.position.set(sweep * 18, 0, 2 + Math.cos(time * 0.5 + sp.phase) * 6);
      sp.light.intensity = 30 + pulse * 90;
      sp.beam.material.opacity = 0.04 + pulse * 0.10;
      // aim the beam mesh at the target
      sp.beam.lookAt(sp.light.target.position);
      sp.beam.rotateX(-Math.PI / 2);
    }
    lasers.material.opacity = Math.pow(pulse, 2) * 0.5;
    lasers.rotation.y = Math.sin(time * 0.4) * 0.15;
    moon.intensity = 0.3 + pulse * 0.1;
  });

  return {
    stageZ,
    update: (dt, time, pulse) => updaters.forEach((u) => u(dt, time, pulse)),
  };
}

// small round sprite texture for additive points
function dot() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const rad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  rad.addColorStop(0, 'rgba(255,255,255,1)');
  rad.addColorStop(0.4, 'rgba(255,255,255,.7)');
  rad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = rad; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
