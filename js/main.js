// TRED / REMIT cardiac SSM viewer.
// Loads per-phase mesh JSON, morphs the mean shape toward a selected branch with a slider,
// colours each vertex by how far it moves, and lets you rotate / zoom and hide surfaces.
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

const DATA = './data';
const EPI_OPACITY = 0.22;

let manifest, low, high;
const phaseCache = {};
const state = { phase: null, item: null, t: 1 };
let scene, camera, renderer, controls, radius = 100;
let tagObjects = {};   // tag -> { mesh, mean:Float32Array, delta:Float32Array, isEpi }
let maxDisp = 1;       // shared displacement scale for the current item (mm)

init();

async function init() {
  manifest = await (await fetch(`${DATA}/manifest.json`)).json();
  document.title = manifest.title || document.title;
  [low, high] = manifest.colormap.map(hexToRgb);
  document.getElementById('cbar').style.background =
    `linear-gradient(90deg, ${manifest.colormap[0]}, ${manifest.colormap[1]})`;

  setupScene();
  buildPhaseToggle();
  buildSlider();
  document.getElementById('item').addEventListener('change', e => selectItem(e.target.value));
  document.getElementById('reset').addEventListener('click', frameCamera);

  const firstPhase = ['ES', 'ED'].find(p => manifest.phases[p]?.available);
  await selectPhase(firstPhase);
  animate();
}

// ---- scene ---------------------------------------------------------------
function setupScene() {
  const view = document.getElementById('view');
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14161b);

  camera = new THREE.PerspectiveCamera(35, view.clientWidth / view.clientHeight, 0.1, 5000);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(view.clientWidth, view.clientHeight);
  view.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.0));
  const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(1, 1, 2); scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.5); fill.position.set(-1, -1, -1); scene.add(fill);

  window.addEventListener('resize', onResize);
}

function onResize() {
  const view = document.getElementById('view');
  camera.aspect = view.clientWidth / view.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(view.clientWidth, view.clientHeight);
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

function frameCamera() {
  camera.position.set(0, 0, radius * 3.1);
  camera.near = radius / 100; camera.far = radius * 20; camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.update();
}

// ---- panel ---------------------------------------------------------------
function buildPhaseToggle() {
  const box = document.getElementById('phase-toggle');
  box.innerHTML = '';
  for (const p of ['ED', 'ES']) {
    const b = document.createElement('button');
    b.textContent = p;
    const avail = manifest.phases[p]?.available;
    b.disabled = !avail;
    b.title = avail ? `${p} SSM` : `${p}: shoot meshes to populate`;
    b.addEventListener('click', () => selectPhase(p));
    b.dataset.phase = p;
    box.appendChild(b);
  }
}

function buildSlider() {
  const s = document.getElementById('morph');
  const cfg = manifest.slider || { min: 0, max: 3, step: 0.05, default: 1 };
  s.min = cfg.min; s.max = cfg.max; s.step = cfg.step; s.value = cfg.default;
  state.t = +cfg.default;
  s.addEventListener('input', () => { state.t = +s.value; updateMorph(); updateSliderLabel(); });
  updateSliderLabel();
}

function updateSliderLabel() {
  document.getElementById('morph-val').textContent = state.t.toFixed(2) + '×';
}

function buildTagCheckboxes(tags) {
  const box = document.getElementById('tags');
  box.innerHTML = '';
  for (const tag of tags) {
    const id = `tag-${tag}`;
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = true; cb.id = id;
    cb.addEventListener('change', () => {
      if (tagObjects[tag]) tagObjects[tag].mesh.visible = cb.checked;
    });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(' ' + tag.replace(/_/g, ' ')));
    box.appendChild(lab);
  }
}

function setActivePhaseButton(phase) {
  document.querySelectorAll('#phase-toggle button')
    .forEach(b => b.classList.toggle('active', b.dataset.phase === phase));
}

// ---- data + meshes -------------------------------------------------------
async function selectPhase(phase) {
  if (!phase || !manifest.phases[phase]?.available) return;
  document.getElementById('note').textContent = 'Loading…';
  if (!phaseCache[phase]) phaseCache[phase] = await (await fetch(`${DATA}/${phase}.json`)).json();
  const data = phaseCache[phase];
  state.phase = phase;
  radius = data.radius || 100;
  setActivePhaseButton(phase);

  // clear previous meshes
  for (const t in tagObjects) scene.remove(tagObjects[t].mesh);
  tagObjects = {};

  const tags = Object.keys(data.tags);
  for (const tag of tags) buildTagMesh(tag, data.tags[tag]);
  buildTagCheckboxes(tags);

  // item dropdown
  const sel = document.getElementById('item');
  sel.innerHTML = '';
  for (const it of data.items) {
    const o = document.createElement('option'); o.value = it; o.textContent = prettyItem(it);
    sel.appendChild(o);
  }
  state.item = data.items[0]; sel.value = state.item;

  frameCamera();
  selectItem(state.item);
  document.getElementById('note').textContent =
    `${data.items.length} branches, ${tags.length} surfaces. Drag to rotate, scroll to zoom.`;
}

function buildTagMesh(tag, entry) {
  const mean = new Float32Array(entry.mean);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(mean.slice(), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(mean.length), 3));
  geo.setIndex(entry.faces);
  const isEpi = /epi/i.test(tag);
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide,
    transparent: isEpi, opacity: isEpi ? EPI_OPACITY : 1.0, depthWrite: !isEpi,
    flatShading: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = isEpi ? 1 : 0;
  scene.add(mesh);
  tagObjects[tag] = { mesh, mean, delta: new Float32Array(mean.length), isEpi };
}

function selectItem(item) {
  state.item = item;
  const data = phaseCache[state.phase];
  maxDisp = 1e-6;
  for (const tag in tagObjects) {
    const obj = tagObjects[tag];
    const target = data.tags[tag].items[item];
    for (let i = 0; i < obj.mean.length; i++) obj.delta[i] = target[i] - obj.mean[i];
    // shared max displacement over the whole heart (mm), matching the static renders
    for (let i = 0; i < obj.mean.length; i += 3) {
      const d = Math.hypot(obj.delta[i], obj.delta[i + 1], obj.delta[i + 2]);
      if (d > maxDisp) maxDisp = d;
    }
  }
  document.getElementById('cbar-max').textContent = maxDisp.toFixed(1) + ' mm';
  updateMorph();
}

function updateMorph() {
  const t = state.t;
  for (const tag in tagObjects) {
    const obj = tagObjects[tag];
    const pos = obj.mesh.geometry.attributes.position.array;
    const col = obj.mesh.geometry.attributes.color.array;
    for (let i = 0; i < obj.mean.length; i += 3) {
      const dx = obj.delta[i] * t, dy = obj.delta[i + 1] * t, dz = obj.delta[i + 2] * t;
      pos[i] = obj.mean[i] + dx; pos[i + 1] = obj.mean[i + 1] + dy; pos[i + 2] = obj.mean[i + 2] + dz;
      const f = Math.min(1, Math.hypot(dx, dy, dz) / maxDisp);
      col[i] = low[0] + (high[0] - low[0]) * f;
      col[i + 1] = low[1] + (high[1] - low[1]) * f;
      col[i + 2] = low[2] + (high[2] - low[2]) * f;
    }
    obj.mesh.geometry.attributes.position.needsUpdate = true;
    obj.mesh.geometry.attributes.color.needsUpdate = true;
    obj.mesh.geometry.computeVertexNormals();
  }
}

// ---- helpers -------------------------------------------------------------
function hexToRgb(h) {
  const n = parseInt(h.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function prettyItem(it) {
  if (it.startsWith('Branch_')) return 'Branch ' + it.split('_')[1];
  if (it.startsWith('cohort_mean')) return 'Cohort mean';
  return it;
}
