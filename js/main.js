// TRED / REMIT cardiac SSM viewer.
// Loads per-phase mesh JSON, morphs the mean shape toward a selected branch with a slider,
// colours each vertex by how far it moves, and lets you rotate / zoom and hide surfaces.
import * as THREE from './vendor/three.module.js';

const DATA = './data';
const EPI_OPACITY = 0.22;

let manifest, low, high;
const phaseCache = {};
const state = { phase: null, item: null, t: 1 };
let scene, camera, renderer, radius = 100;
let pivot;                       // all meshes live here; we rotate this, not the camera
const spin = { vx: 0, vy: 0 };   // leftover angular velocity for inertia
let dragging = false;
let tagObjects = {};   // tag -> { mesh, mean:Float32Array, delta:Float32Array, isEpi }
let maxDisp = 1;       // shared displacement scale for the current item (mm)

init().catch(showFatal);

async function init() {
  manifest = await fetchJSON(`${DATA}/manifest.json`);
  document.title = manifest.title || document.title;
  [low, high] = manifest.colormap.map(hexToRgb);
  document.getElementById('cbar').style.background =
    `linear-gradient(90deg, ${manifest.colormap[0]}, ${manifest.colormap[1]})`;

  // Build the controls FIRST, so the panel is usable even if WebGL or data fail.
  buildPhaseToggle();
  buildSlider();
  document.getElementById('item').addEventListener('change', e => selectItem(e.target.value));
  document.getElementById('reset').addEventListener('click', frameCamera);

  if (!setupScene()) return;  // WebGL check; shows a message if unavailable

  const firstPhase = ['ES', 'ED'].find(p => manifest.phases[p]?.available);
  await selectPhase(firstPhase);
  window.__ssmReady = true;
  animate();
}

async function fetchJSON(url) {
  let r;
  try { r = await fetch(url); }
  catch (e) { throw new Error(`Cannot fetch ${url}. Open the page over http(s), not a file:// path.`); }
  if (!r.ok) throw new Error(`${url} returned HTTP ${r.status}`);
  return r.json();
}

function showFatal(err) {
  console.error(err);
  const n = document.getElementById('note');
  if (n) { n.textContent = 'Error: ' + (err && err.message || err); n.style.color = '#e08080'; }
}

// ---- scene ---------------------------------------------------------------
function setupScene() {
  const view = document.getElementById('view');
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch (e) {
    showFatal(new Error('WebGL is not available in this browser or session. Try a recent Chrome/Firefox with hardware acceleration on.'));
    return false;
  }
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14161b);

  camera = new THREE.PerspectiveCamera(35, view.clientWidth / view.clientHeight, 0.1, 5000);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(view.clientWidth, view.clientHeight);
  view.appendChild(renderer.domElement);

  pivot = new THREE.Group();
  scene.add(pivot);
  installControls(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.0));
  const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(1, 1, 2); scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.5); fill.position.set(-1, -1, -1); scene.add(fill);

  window.addEventListener('resize', onResize);
  return true;
}

function onResize() {
  const view = document.getElementById('view');
  camera.aspect = view.clientWidth / view.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(view.clientWidth, view.clientHeight);
}

// Custom controller: rotate the mesh group about screen axes with no limit, so dragging
// up keeps tumbling the heart over the apex/base indefinitely. A flick leaves inertia.
function installControls(dom) {
  const ROT = 0.007;                 // radians per pixel dragged
  dom.style.touchAction = 'none';
  let lx = 0, ly = 0;
  dom.addEventListener('pointerdown', e => {
    dragging = true; lx = e.clientX; ly = e.clientY; spin.vx = spin.vy = 0;
    dom.setPointerCapture(e.pointerId);
  });
  const end = e => { dragging = false; try { dom.releasePointerCapture(e.pointerId); } catch (_) {} };
  dom.addEventListener('pointerup', end);
  dom.addEventListener('pointercancel', end);
  dom.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = (e.clientX - lx) * ROT, dy = (e.clientY - ly) * ROT;
    lx = e.clientX; ly = e.clientY;
    rotatePivot(dx, dy);
    spin.vx = dx; spin.vy = dy;      // remember last motion for release inertia
  });
  dom.addEventListener('wheel', e => {
    e.preventDefault();
    camera.position.multiplyScalar(Math.exp(e.deltaY * 0.001));
    const d = camera.position.length();
    if (d < radius * 1.2) camera.position.setLength(radius * 1.2);
    if (d > radius * 15) camera.position.setLength(radius * 15);
  }, { passive: false });
}

const _qy = new THREE.Quaternion(), _qx = new THREE.Quaternion();
const _AX = new THREE.Vector3(1, 0, 0), _AY = new THREE.Vector3(0, 1, 0);
function rotatePivot(dx, dy) {
  _qy.setFromAxisAngle(_AY, dx);      // horizontal drag -> spin about world Y
  _qx.setFromAxisAngle(_AX, dy);      // vertical drag   -> tumble about world X
  pivot.quaternion.premultiply(_qy).premultiply(_qx);  // world-axis => screen-relative, unbounded
}

function animate() {
  requestAnimationFrame(animate);
  if (!dragging && (Math.abs(spin.vx) > 1e-4 || Math.abs(spin.vy) > 1e-4)) {
    rotatePivot(spin.vx, spin.vy);
    spin.vx *= 0.94; spin.vy *= 0.94;
  }
  renderer.render(scene, camera);
}

function frameCamera() {
  camera.position.set(0, 0, radius * 3.1);
  camera.near = radius / 100; camera.far = radius * 20; camera.updateProjectionMatrix();
  camera.lookAt(0, 0, 0);
  if (pivot) pivot.quaternion.identity();
  spin.vx = spin.vy = 0;
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
  for (const t in tagObjects) pivot.remove(tagObjects[t].mesh);
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
  pivot.add(mesh);
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
