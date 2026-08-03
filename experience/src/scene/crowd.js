import * as THREE from 'three';
import { PALETTE } from '../data/destinations.js';

// A dense crowd of instanced silhouettes facing the stage, bobbing on the
// beat, each waving a glowing stick. Instanced for performance (one draw
// call for all bodies, one for all glowsticks).
export function buildCrowd(scene, { count = 380, stageZ = -26, exclude = [] } = {}) {
  // ---- bodies: a simple capsule silhouette ----
  const bodyGeo = new THREE.CapsuleGeometry(0.28, 0.9, 4, 8);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x05050a, roughness: 1, metalness: 0 });
  const bodies = new THREE.InstancedMesh(bodyGeo, bodyMat, count);
  bodies.castShadow = true;
  bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(bodies);

  // ---- glowsticks: additive points above each head ----
  const gpos = new Float32Array(count * 3);
  const gcol = new Float32Array(count * 3);
  const glowColors = [PALETTE.cyan, PALETTE.magenta, PALETTE.green, PALETTE.purple, PALETTE.orange]
    .map((h) => new THREE.Color(h));

  const agents = [];
  const dummy = new THREE.Object3D();
  const minZ = stageZ + 6, maxZ = 16, spanX = 44;

  let i = 0, guard = 0;
  while (i < count && guard < count * 40) {
    guard++;
    const x = (Math.random() - 0.5) * spanX;
    const z = minZ + Math.random() * (maxZ - minZ);
    // keep a clear aisle down the middle-front and avoid character spots
    if (Math.abs(x) < 2.2 && z < stageZ + 14) continue;
    if (exclude.some((e) => Math.hypot(x - e[0], z - e[1]) < 2.2)) continue;

    const scale = 0.9 + Math.random() * 0.4;
    agents.push({ x, z, scale, phase: Math.random() * Math.PI * 2, freq: 0.85 + Math.random() * 0.3 });

    const c = glowColors[(Math.random() * glowColors.length) | 0];
    gcol[i * 3] = c.r; gcol[i * 3 + 1] = c.g; gcol[i * 3 + 2] = c.b;
    i++;
  }
  const realCount = i;
  bodies.count = realCount;

  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute('position', new THREE.BufferAttribute(gpos.subarray(0, realCount * 3), 3));
  glowGeo.setAttribute('color', new THREE.BufferAttribute(gcol.subarray(0, realCount * 3), 3));
  const glow = new THREE.Points(glowGeo, new THREE.PointsMaterial({
    size: 0.34, map: dot(), vertexColors: true, transparent: true, opacity: 0.95,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
  }));
  scene.add(glow);

  function update(dt, time, pulse) {
    const gp = glowGeo.attributes.position.array;
    for (let k = 0; k < realCount; k++) {
      const a = agents[k];
      const bob = Math.abs(Math.sin(time * a.freq * 2.2 + a.phase)) * (0.14 + pulse * 0.5);
      dummy.position.set(a.x, 0.9 * a.scale + bob, a.z);
      dummy.rotation.y = Math.atan2(0 - a.x, stageZ - a.z) + Math.sin(time + a.phase) * 0.12;
      dummy.scale.setScalar(a.scale);
      dummy.updateMatrix();
      bodies.setMatrixAt(k, dummy.matrix);
      // glowstick hovers above the head, swaying
      const sway = Math.sin(time * 2.0 + a.phase) * 0.35;
      gp[k * 3] = a.x + sway;
      gp[k * 3 + 1] = 1.9 * a.scale + bob + Math.abs(Math.sin(time * a.freq * 2.2 + a.phase)) * 0.25;
      gp[k * 3 + 2] = a.z + Math.cos(time * 1.7 + a.phase) * 0.2;
    }
    bodies.instanceMatrix.needsUpdate = true;
    glowGeo.attributes.position.needsUpdate = true;
    glow.material.opacity = 0.7 + pulse * 0.3;
  }

  return { update, count: realCount };
}

function dot() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const rad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  rad.addColorStop(0, 'rgba(255,255,255,1)');
  rad.addColorStop(0.4, 'rgba(255,255,255,.75)');
  rad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = rad; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
