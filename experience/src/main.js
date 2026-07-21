import * as THREE from 'three';
import { DESTINATIONS } from './data/destinations.js';
import { buildFestival } from './scene/festival.js';
import { buildCrowd } from './scene/crowd.js';
import { buildCharacters } from './scene/characters.js';
import { WalkControls } from './player/controls.js';
import { Hud } from './ui/hud.js';

const canvas = document.getElementById('scene');
const body = document.body;

// ---- reduced motion ----
let reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const setRM = (v) => { reduceMotion = v; body.classList.toggle('rm', v); };
setRM(reduceMotion);
document.getElementById('rmbtn').onclick = () => setRM(!reduceMotion);

// ---- renderer ----
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setClearColor(0x05050e, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 320);

// ---- world ----
const festival = buildFestival(scene);
const characters = buildCharacters(scene, { stageZ: festival.stageZ });
const crowd = buildCrowd(scene, {
  count: 380,
  stageZ: festival.stageZ,
  exclude: DESTINATIONS.map((d) => [d.pos[0], d.pos[2]]),
});
const controls = new WalkControls(camera, { bounds: 42, eye: 1.6 });
const hud = new Hud(document.getElementById('tags'), camera, characters.list);

// ---- input: drag to look, click/tap a person to walk over ----
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let down = null, dragged = false;

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  down = { x: e.clientX, y: e.clientY, id: e.pointerId };
  dragged = false;
  canvas.classList.add('drag');
});
canvas.addEventListener('pointermove', (e) => {
  if (!down || e.pointerId !== down.id) return;
  const dx = e.clientX - down.x, dy = e.clientY - down.y;
  if (Math.abs(dx) > 5 || Math.abs(dy) > 5) dragged = true;
  controls.look(e.movementX || dx * 0.2, e.movementY || dy * 0.2);
  down.x = e.clientX; down.y = e.clientY;
});
canvas.addEventListener('pointerup', (e) => {
  canvas.classList.remove('drag');
  if (down && !dragged) handleTap(e.clientX, e.clientY);
  down = null;
});
canvas.addEventListener('pointercancel', () => { down = null; canvas.classList.remove('drag'); });

function handleTap(sx, sy) {
  ndc.x = (sx / innerWidth) * 2 - 1;
  ndc.y = -(sy / innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  // characters first
  const hitC = raycaster.intersectObjects(characters.proxies, false)[0];
  if (hitC) {
    const c = characters.list.find((x) => x.proxy === hitC.object);
    if (c) { controls.walkTo(c.worldPos); return; }
  }
  // otherwise walk to the point on the ground
  const groundHit = raycaster.ray.intersectPlane(GROUND, new THREE.Vector3());
  if (groundHit) controls.walkTo(groundHit);
}
const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

// ---- resize ----
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
renderer.setSize(innerWidth, innerHeight);

// ---- beat clock (128 BPM) → pulse spikes on each beat ----
const BPM = 128;
const clock = new THREE.Clock();
let running = false;

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;
  const beat = time * (BPM / 60);
  const pulse = reduceMotion ? 0.35 : Math.pow(1 - (beat % 1), 2.2); // sharp on-beat, decays

  controls.update(dt);
  festival.update(dt, time, pulse);
  crowd.update(dt, time, pulse);
  characters.update(dt, time, pulse);
  hud.update(controls.pos);

  renderer.render(scene, camera);
}

// ---- start ----
document.getElementById('enterBtn').onclick = () => {
  document.getElementById('start').classList.add('gone');
  if (!running) { running = true; clock.start(); frame(); }
};
document.addEventListener('visibilitychange', () => { if (!document.hidden) clock.getDelta(); });

// render one frame behind the start overlay so it isn't black
renderer.render(scene, camera);
