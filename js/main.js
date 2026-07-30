// TRED / REMIT cardiac SSM viewer.
// Pick a phase (ED/ES) and a view (branches or PCA modes), then morph the mean shape with a
// slider: branches go mean -> branch (0..3x), modes sweep -SD .. mean .. +SD. Each vertex is
// coloured by how far it moves. Free rotation (no pole wall), zoom, and per-surface hiding.
import * as THREE from './vendor/three.module.js';

const DATA = './data';
const EPI_OPACITY = 0.22;

let manifest, low, high;
const phaseCache = {};
const state = { phase: null, view: null, item: null, t: 0 };
let scene, camera, renderer, radius = 100;
let pivot;
const spin = { vx: 0, vy: 0 };
let dragging = false;
let tagObjects = {};   // tag -> { mesh, mean:Float32Array, act:{...} }
let maxDisp = 1;

init().catch(showFatal);

async function init() {
  manifest = await fetchJSON(`${DATA}/manifest.json`);
  document.title = manifest.title || document.title;
  [low, high] = manifest.colormap.map(hexToRgb);
  document.getElementById('cbar').style.background =
    `linear-gradient(90deg, ${manifest.colormap[0]}, ${manifest.colormap[1]})`;

  buildPhaseToggle();
  document.getElementById('item').addEventListener('change', e => selectItem(e.target.value));
  document.getElementById('reset').addEventListener('click', frameCamera);
  document.getElementById('morph').addEventListener('input', e => {
    state.t = +e.target.value; updateSliderLabel(); updateMorph();
  });

  if (!setupScene()) return;

  const hint = parseHash();   // optional deep link: #ES/modes/5 or #ED/branches/Branch_0
  const firstPhase = (hint.phase && manifest.phases[hint.phase]?.available) ? hint.phase
                   : ['ES', 'ED'].find(p => manifest.phases[p]?.available);
  await selectPhase(firstPhase, hint);
  window.__ssmReady = true;
  animate();
}

// ---- data helpers --------------------------------------------------------
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
function scaled(intArr, f) {
  const out = new Float32Array(intArr.length);
  for (let i = 0; i < intArr.length; i++) out[i] = intArr[i] * f;
  return out;
}

// ---- scene ---------------------------------------------------------------
function setupScene() {
  const view = document.getElementById('view');
  try { renderer = new THREE.WebGLRenderer({ antialias: true }); }
  catch (e) {
    showFatal(new Error('WebGL is not available in this browser/session.'));
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

// Custom controller: unlimited rotation of the mesh group + inertia + wheel zoom.
function installControls(dom) {
  const ROT = 0.007;
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
    rotatePivot(dx, dy); spin.vx = dx; spin.vy = dy;
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
  _qy.setFromAxisAngle(_AY, dx); _qx.setFromAxisAngle(_AX, dy);
  pivot.quaternion.premultiply(_qy).premultiply(_qx);
}
function animate() {
  requestAnimationFrame(animate);
  if (!dragging && (Math.abs(spin.vx) > 1e-4 || Math.abs(spin.vy) > 1e-4)) {
    rotatePivot(spin.vx, spin.vy); spin.vx *= 0.94; spin.vy *= 0.94;
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
    b.textContent = p; b.dataset.phase = p;
    const avail = manifest.phases[p]?.available;
    b.disabled = !avail;
    b.title = avail ? `${p} SSM` : `${p}: shoot meshes to populate`;
    b.addEventListener('click', () => selectPhase(p));
    box.appendChild(b);
  }
}
function buildViewToggle() {
  const box = document.getElementById('view-toggle');
  box.innerHTML = '';
  const ph = manifest.phases[state.phase] || {};
  const opts = [['branches', 'Branches', (ph.branches || []).length],
                ['modes', 'Modes', (ph.modes || []).length]];
  for (const [key, label, n] of opts) {
    const b = document.createElement('button');
    b.textContent = label; b.dataset.view = key;
    b.disabled = n === 0;
    b.classList.toggle('active', key === state.view);
    b.addEventListener('click', () => selectView(key));
    box.appendChild(b);
  }
}
function setActive(sel, attr, val) {
  document.querySelectorAll(sel).forEach(b => b.classList.toggle('active', b.dataset[attr] === val));
}
function updateSliderConfig() {
  const s = document.getElementById('morph');
  const lab = document.getElementById('item-label');
  const ticks = document.getElementById('morph-ticks');
  if (state.view === 'modes') {
    const nsd = phaseCache[state.phase].n_sd || 3;
    s.min = -nsd; s.max = nsd; s.step = 0.05; s.value = 0; state.t = 0;
    lab.textContent = 'Mode';
    ticks.innerHTML = `<span>-${nsd} SD</span><span>mean</span><span>+${nsd} SD</span>`;
  } else {
    s.min = 0; s.max = 3; s.step = 0.05; s.value = 1; state.t = 1;
    lab.textContent = 'Branch';
    ticks.innerHTML = `<span>mean</span><span>shape</span><span>exaggerated</span>`;
  }
  updateSliderLabel();
}
function updateSliderLabel() {
  const el = document.getElementById('morph-val');
  el.textContent = state.view === 'modes' ? `${state.t >= 0 ? '+' : ''}${state.t.toFixed(2)} SD`
                                          : `${state.t.toFixed(2)}×`;
}
function buildTagCheckboxes(tags) {
  const box = document.getElementById('tags');
  box.innerHTML = '';
  for (const tag of tags) {
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = true;
    cb.addEventListener('change', () => { if (tagObjects[tag]) tagObjects[tag].mesh.visible = cb.checked; });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(' ' + tag.replace(/_/g, ' ')));
    box.appendChild(lab);
  }
}
function populateItems() {
  const sel = document.getElementById('item');
  const ph = manifest.phases[state.phase];
  sel.innerHTML = '';
  const list = state.view === 'modes' ? ph.modes : ph.branches;
  for (const it of list) {
    const o = document.createElement('option');
    o.value = String(it);
    o.textContent = state.view === 'modes' ? `Mode ${it}` : prettyItem(it);
    sel.appendChild(o);
  }
  state.item = String(list[0]);
  sel.value = state.item;
}

// ---- data + meshes -------------------------------------------------------
async function selectPhase(phase, hint = {}) {
  if (!phase || !manifest.phases[phase]?.available) return;
  document.getElementById('note').textContent = 'Loading…';
  if (!phaseCache[phase]) phaseCache[phase] = await fetchJSON(`${DATA}/${phase}.json`);
  const data = phaseCache[phase];
  state.phase = phase;
  radius = data.radius || 100;
  setActive('#phase-toggle button', 'phase', phase);

  for (const t in tagObjects) pivot.remove(tagObjects[t].mesh);
  tagObjects = {};
  const tags = Object.keys(data.tags);
  for (const tag of tags) buildTagMesh(tag, data.tags[tag], data.scale);
  buildTagCheckboxes(tags);

  const ph = manifest.phases[phase];
  state.view = (hint.view && (ph[hint.view] || []).length) ? hint.view
             : ((ph.branches && ph.branches.length) ? 'branches' : 'modes');
  buildViewToggle();
  populateItems();
  if (hint.item) {
    const sel = document.getElementById('item');
    if ([...sel.options].some(o => o.value === String(hint.item))) {
      state.item = String(hint.item); sel.value = state.item;
    }
  }
  updateSliderConfig();
  frameCamera();
  selectItem(state.item);
  if (hint.t !== undefined && hint.t !== '' && !Number.isNaN(parseFloat(hint.t))) {
    const s = document.getElementById('morph');
    s.value = parseFloat(hint.t); state.t = parseFloat(hint.t);
    updateSliderLabel(); updateMorph();
  }
  document.getElementById('note').textContent =
    `${(ph.branches || []).length} branches, ${(ph.modes || []).length} modes, ${tags.length} surfaces. Drag to rotate.`;
}
function selectView(view) {
  if (view === state.view) return;
  state.view = view;
  setActive('#view-toggle button', 'view', view);
  populateItems();
  updateSliderConfig();
  selectItem(state.item);
}
function buildTagMesh(tag, entry, scale) {
  const mean = new Float32Array(entry.mean);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(mean.slice(), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(mean.length), 3));
  geo.setIndex(entry.faces);
  const isEpi = /epi/i.test(tag);
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide,
    transparent: isEpi, opacity: isEpi ? EPI_OPACITY : 1.0, depthWrite: !isEpi,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = isEpi ? 1 : 0;
  pivot.add(mesh);
  tagObjects[tag] = { mesh, mean, entry, act: null };
}
function selectItem(item) {
  state.item = item;
  const data = phaseCache[state.phase];
  const f = 1 / data.scale;
  maxDisp = 1e-6;
  for (const tag in tagObjects) {
    const o = tagObjects[tag];
    if (state.view === 'branches') {
      const d = o.entry.branches[item];
      o.act = { kind: 'branch', d: scaled(d, f) };
      accumulateMax(o.act.d);
    } else {
      const md = o.entry.modes[item];
      o.act = { kind: 'mode', minus: scaled(md.minus, f), plus: scaled(md.plus, f) };
      accumulateMax(o.act.minus); accumulateMax(o.act.plus);
    }
  }
  document.getElementById('cbar-max').textContent = maxDisp.toFixed(1) + ' mm';
  updateMorph();
}
function accumulateMax(d) {
  for (let i = 0; i < d.length; i += 3) {
    const m = Math.hypot(d[i], d[i + 1], d[i + 2]);
    if (m > maxDisp) maxDisp = m;
  }
}
function updateMorph() {
  const t = state.t;
  const nsd = phaseCache[state.phase].n_sd || 3;
  for (const tag in tagObjects) {
    const o = tagObjects[tag];
    if (!o.act) continue;
    const pos = o.mesh.geometry.attributes.position.array;
    const col = o.mesh.geometry.attributes.color.array;
    const mean = o.mean;
    let d, f;
    if (o.act.kind === 'branch') { d = o.act.d; f = t; }
    else { f = Math.abs(t) / nsd; d = t >= 0 ? o.act.plus : o.act.minus; }
    for (let i = 0; i < mean.length; i += 3) {
      const dx = d[i] * f, dy = d[i + 1] * f, dz = d[i + 2] * f;
      pos[i] = mean[i] + dx; pos[i + 1] = mean[i + 1] + dy; pos[i + 2] = mean[i + 2] + dz;
      const g = Math.min(1, Math.hypot(dx, dy, dz) / maxDisp);
      col[i] = low[0] + (high[0] - low[0]) * g;
      col[i + 1] = low[1] + (high[1] - low[1]) * g;
      col[i + 2] = low[2] + (high[2] - low[2]) * g;
    }
    o.mesh.geometry.attributes.position.needsUpdate = true;
    o.mesh.geometry.attributes.color.needsUpdate = true;
    o.mesh.geometry.computeVertexNormals();
  }
}

// ---- helpers -------------------------------------------------------------
function hexToRgb(h) {
  const n = parseInt(h.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function parseHash() {
  const h = decodeURIComponent(location.hash.replace(/^#/, ''));
  const [phase, view, item, t] = h.split('/');
  return { phase, view, item, t };
}
function prettyItem(it) {
  if (String(it).startsWith('Branch_')) return 'Branch ' + String(it).split('_')[1];
  if (String(it).startsWith('cohort_mean')) return 'Cohort mean';
  return String(it);
}
