import * as THREE from 'three';
import { DESTINATIONS } from '../data/destinations.js';

// The named artists standing in the crowd. Each is a distinct glowing figure
// with an aura and a floating name (the name is drawn by the HUD via 3D->2D
// projection). Returns clickable proxies for walk-to navigation + proximity.
export function buildCharacters(scene, { stageZ = -26 } = {}) {
  const list = [];

  for (const d of DESTINATIONS) {
    const color = new THREE.Color(d.accent);
    const group = new THREE.Group();
    const [x, , z] = d.pos;
    const y = d.onStage ? 1.6 : 0; // lifted onto the stage deck
    group.position.set(x, y, z);

    // body — brighter, emissive so they stand out from the dark crowd
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.34, 1.05, 6, 12),
      new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.5), emissive: color, emissiveIntensity: 0.55, roughness: 0.5 })
    );
    body.position.y = 1.05; body.castShadow = true; group.add(body);
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.26, 16, 16),
      new THREE.MeshStandardMaterial({ color: 0xf0f0f5, emissive: color, emissiveIntensity: 0.25, roughness: .4 })
    );
    head.position.y = 1.95; head.castShadow = true; group.add(head);

    // point light so they cast their colour on nearby crowd
    const pl = new THREE.PointLight(color, 6, 8, 2); pl.position.y = 1.6; group.add(pl);

    // ground aura ring
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.25, 40),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02; group.add(ring);

    // soft glow column
    const glow = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.9, 3.4, 20, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.10, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    glow.position.y = 1.7; group.add(glow);

    // invisible proxy for raycasting (big, easy to click/tap)
    const proxy = new THREE.Mesh(
      new THREE.CylinderGeometry(1.1, 1.1, 3, 8),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    proxy.position.y = 1.5; group.add(proxy);
    proxy.userData.destId = d.id;

    scene.add(group);
    list.push({ dest: d, group, ring, glow, proxy, worldPos: new THREE.Vector3(x, 1.6 + y, z) });
  }

  function update(dt, time, pulse) {
    for (const c of list) {
      c.ring.scale.setScalar(1 + pulse * 0.5 + Math.sin(time * 2 + c.worldPos.x) * 0.05);
      c.ring.material.opacity = 0.35 + pulse * 0.4;
      c.glow.material.opacity = 0.08 + pulse * 0.12;
      c.group.children[0].position.y = 1.05 + Math.abs(Math.sin(time * 2.0 + c.worldPos.x)) * (0.06 + pulse * 0.2);
    }
  }

  return { list, proxies: list.map((c) => c.proxy), update };
}
