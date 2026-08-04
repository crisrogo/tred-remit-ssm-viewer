// TRED / REMIT cardiac SSM viewer.
//
// Pick what to show first — the DDRTREE (ortho-tree branches) or PCA MODES. The tree is a
// single fit in a combined [PC_ED | ES-perp] feature space, and its shapes are always drawn
// in the end-systolic model, so it needs no phase choice. Modes belong to one phase's own
// PCA, so there the phase is intrinsic and the toggle appears.
//
// A branch is stored as several shapes sampled along pseudotime (proximal -> distal). Two
// quantities could vary — how far the ES template is carried towards the branch, and where
// along the branch the target sits — but only ONE is exposed at a time, chosen by the "Vary"
// toggle. Letting both move at once compounds them: the shape being morphed towards would
// itself slide as pseudotime changed, so the morph slider would not mean one fixed thing.
//   'blend' — target pinned to the branch midpoint, morph runs 0-100% from the ES template.
//   'along' — morph pinned at 100%, pseudotime runs proximal -> distal.
// Modes keep the single -SD .. mean .. +SD sweep. Each vertex is coloured by how far it moves.
import * as THREE from './vendor/three.module.js';

const DATA = './data';
const EPI_OPACITY = 0.22;
const SVG_NS = 'http://www.w3.org/2000/svg';
const TREE_PHASE = 'ES';         // the tree's shapes are always shown end-systolic
// Mesh tags as written by the SSM, spelled out for the surface list.
const TAG_NAMES = {
  LV_endo: 'Left ventricular endocardium',
  RV_FW: 'Right ventricular free wall',
  RV_septum: 'Right ventricular septum',
  epi: 'Epicardium',
  aorta_valve: 'Aortic valve',
  mitral_valve: 'Mitral valve',
  pulmonary_valve: 'Pulmonary valve',
  tricuspid_valve: 'Tricuspid valve',
};

let manifest, tree, low, high;
const phaseCache = {};
const state = { view: null, phase: null, item: null, t: 0, pt: 0, vary: 'blend' };
let scene, camera, renderer, radius = 100;
let pivot;
const spin = { vx: 0, vy: 0 };
let dragging = false;
let tagObjects = {};   // tag -> { mesh, mean:Float32Array, entry, act }
let maxDisp = 1;

init().catch(showFatal);

async function init() {
  [manifest, tree] = await Promise.all([
    fetchJSON(`${DATA}/manifest.json`),
    fetchJSON(`${DATA}/tree.json`).catch(() => null),
  ]);
  document.title = manifest.title || document.title;
  [low, high] = manifest.colormap.map(hexToRgb);
  document.getElementById('cbar').style.background =
    `linear-gradient(90deg, ${manifest.colormap[0]}, ${manifest.colormap[1]})`;

  buildViewToggle();
  buildPhaseToggle();
  document.getElementById('item').addEventListener('change', e => selectItem(e.target.value));
  document.getElementById('reset').addEventListener('click', frameCamera);
  document.getElementById('morph').addEventListener('input', e => {
    state.t = +e.target.value; updateSliderLabel(); updateMorph(); writeHash();
  });
  document.getElementById('ptime').addEventListener('input', e => {
    state.pt = +e.target.value; updatePtimeLabel(); drawMarker(); updateMorph(); writeHash();
  });
  buildVaryToggle();

  if (!setupScene()) {
    document.querySelectorAll('#view-toggle button, #phase-toggle button')
      .forEach(b => (b.disabled = true));
    return;
  }
  if (tree) buildMinimap();

  const hint = parseHash();
  const phases = ['ES', 'ED'].filter(p => manifest.phases[p]?.available);
  state.phase = phases.includes(hint.phase) ? hint.phase : phases[0];
  state.view = (hint.view === 'modes' || hint.view === 'branches') ? hint.view
             : (hasItems(TREE_PHASE, 'branches') ? 'branches' : 'modes');
  if (state.view === 'branches') state.phase = TREE_PHASE;   // the tree is always ES
  await selectPhase(state.phase, hint);
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
function hasItems(phase, view) {
  return ((manifest.phases[phase] || {})[view] || []).length > 0;
}

// ---- scene ---------------------------------------------------------------
function setupScene() {
  const view = document.getElementById('view');
  // Probe WebGL first so we can report WHY it failed (context null vs exception),
  // and allow a software context (failIfMajorPerformanceCaveat: false) for machines
  // whose GPU is blocklisted or where hardware acceleration is off.
  const probe = probeWebGL();
  if (!probe.ok) {
    showFatal(new Error(
      `WebGL could not start (${probe.reason}). Enable hardware acceleration or GPU access, ` +
      `then reload. In Chrome: Settings > System > "Use graphics acceleration when available" ` +
      `(and check chrome://gpu). In Firefox: about:config > webgl.disabled = false.`));
    return false;
  }
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true, alpha: false, powerPreference: 'default',
      failIfMajorPerformanceCaveat: false,
    });
  } catch (e) {
    showFatal(new Error('WebGL renderer failed to initialise: ' + (e && e.message || e)));
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
function probeWebGL() {
  const c = document.createElement('canvas');
  let gl = null;
  try {
    gl = c.getContext('webgl2', { failIfMajorPerformanceCaveat: false })
      || c.getContext('webgl', { failIfMajorPerformanceCaveat: false })
      || c.getContext('experimental-webgl', { failIfMajorPerformanceCaveat: false });
  } catch (e) {
    return { ok: false, reason: 'getContext threw: ' + (e && e.message || e) };
  }
  if (!gl) return { ok: false, reason: 'no WebGL context (GPU blocked or acceleration off)' };
  return { ok: true };
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
  // Fit the bounding sphere in BOTH directions: the control panel eats horizontal room, so
  // on a narrow window the horizontal field is the binding one and a distance chosen from
  // the vertical field alone clips the epicardium left and right.
  const vFov = camera.fov * Math.PI / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  camera.position.set(0, 0, 1.15 * radius / Math.sin(Math.min(vFov, hFov) / 2));
  camera.near = radius / 100; camera.far = radius * 40; camera.updateProjectionMatrix();
  camera.lookAt(0, 0, 0);
  if (pivot) pivot.quaternion.identity();
  spin.vx = spin.vy = 0;
}

// ---- panel ---------------------------------------------------------------
function buildViewToggle() {
  const box = document.getElementById('view-toggle');
  box.innerHTML = '';
  for (const [key, label] of [['branches', 'DDRTree'], ['modes', 'Modes']]) {
    const b = document.createElement('button');
    b.textContent = label; b.dataset.view = key;
    b.addEventListener('click', () => selectView(key));
    box.appendChild(b);
  }
}
function buildVaryToggle() {
  const box = document.getElementById('vary-toggle');
  box.innerHTML = '';
  for (const [key, label, tip] of [
    ['blend', 'Towards branch', 'Morph the ES template 0-100% towards the branch midpoint'],
    ['along', 'Along branch', 'Walk the branch proximal to distal at the full branch shape'],
  ]) {
    const b = document.createElement('button');
    b.textContent = label; b.dataset.vary = key; b.title = tip;
    b.addEventListener('click', () => selectVary(key));
    box.appendChild(b);
  }
}
function selectVary(vary) {
  if (vary === state.vary) return;
  state.vary = vary;
  setActive('#vary-toggle button', 'vary', vary);
  updateBranchControls();
  updateSliderConfig();
  drawMarker();
  updateMorph();
  writeHash();
}
function buildPhaseToggle() {
  const box = document.getElementById('phase-toggle');
  box.innerHTML = '';
  for (const p of ['ED', 'ES']) {
    const b = document.createElement('button');
    b.textContent = p; b.dataset.phase = p;
    b.addEventListener('click', () => selectPhase(p));
    box.appendChild(b);
  }
}
// A phase button is usable only if that phase actually has modes; the whole group is hidden
// in the tree view, where the phase is fixed to ES.
function refreshPhaseToggle() {
  for (const b of document.querySelectorAll('#phase-toggle button')) {
    const p = b.dataset.phase;
    const ok = manifest.phases[p]?.available && hasItems(p, 'modes');
    b.disabled = !ok;
    b.title = ok ? `${p} SSM` : `${p}: no modes built yet`;
  }
  for (const el of document.querySelectorAll('.mode-view')) el.hidden = state.view !== 'modes';
  for (const el of document.querySelectorAll('.tree-view')) el.hidden = state.view !== 'branches';
}
function setActive(sel, attr, val) {
  document.querySelectorAll(sel).forEach(b => b.classList.toggle('active', b.dataset[attr] === val));
}
function populateItems() {
  const sel = document.getElementById('item');
  const list = manifest.phases[state.phase][state.view] || [];
  sel.innerHTML = '';
  for (const it of list) {
    const o = document.createElement('option');
    o.value = String(it);
    o.textContent = state.view === 'modes' ? `Mode ${it}` : prettyItem(it);
    sel.appendChild(o);
  }
  if (!list.map(String).includes(String(state.item))) state.item = String(list[0]);
  sel.value = state.item;
  document.getElementById('item-label').textContent =
    state.view === 'modes' ? 'Mode' : 'Branch';
}
function buildTagCheckboxes(tags) {
  const box = document.getElementById('tags');
  box.innerHTML = '';
  // List chambers, then epicardium, then valves (the TAG_NAMES order) rather than the
  // alphabetical tag order, which interleaves them once the names are spelled out.
  const rank = Object.keys(TAG_NAMES);
  const ordered = [...tags].sort((a, b) =>
    (rank.indexOf(a) + 1 || 99) - (rank.indexOf(b) + 1 || 99) || a.localeCompare(b));
  for (const tag of ordered) {
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = true;
    cb.addEventListener('change', () => { if (tagObjects[tag]) tagObjects[tag].mesh.visible = cb.checked; });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(' ' + (TAG_NAMES[tag] || tag.replace(/_/g, ' '))));
    box.appendChild(lab);
  }
}
// The morph slider means different things in the two views, so it is relabelled wholesale.
// In the tree view it is a blend fraction: 0 leaves the ES template untouched, 100% puts
// every vertex exactly on the branch's shape at the midpoint of its pseudotime.
function updateSliderConfig(keepValue = false) {
  const s = document.getElementById('morph');
  const ticks = document.getElementById('morph-ticks');
  const lab = document.getElementById('morph-label');
  const hint = document.getElementById('morph-hint');
  if (state.view === 'modes') {
    const nsd = phaseCache[state.phase].n_sd || 3;
    s.min = -nsd; s.max = nsd; s.step = 0.05;
    if (!keepValue) { state.t = 0; }
    s.value = state.t;
    lab.innerHTML = 'Deviation: <span id="morph-val"></span>';
    ticks.innerHTML = `<span>-${nsd} SD</span><span>mean</span><span>+${nsd} SD</span>`;
    hint.textContent = `How far this mode is pushed from the ${state.phase} mean shape, ` +
      `in standard deviations of its own score across the cohort.`;
  } else {
    s.min = 0; s.max = 1; s.step = 0.01;
    if (!keepValue) { state.t = 1; }
    state.t = Math.min(1, Math.max(0, state.t));
    s.value = state.t;
    lab.innerHTML = 'Morph: <span id="morph-val"></span>';
    ticks.innerHTML = `<span>ES template</span><span></span><span>branch</span>`;
    hint.textContent = activeKnots()
      ? '0% is the ES template (the SSM mean shape); 100% is this branch at the middle of ' +
        'its pseudotime. In between, every vertex moves that fraction of the way.'
      : '0% is the ES template (the SSM mean shape); 100% is this shape.';
  }
  updateSliderLabel();
}
function updateSliderLabel() {
  const el = document.getElementById('morph-val');
  el.textContent = state.view === 'modes'
    ? `${state.t >= 0 ? '+' : ''}${state.t.toFixed(2)} SD`
    : `${(state.t * 100).toFixed(0)}%`;
}
function updatePtimeLabel() {
  document.getElementById('ptime-val').textContent = state.pt.toFixed(3);
}
// Expose exactly one slider. The "Vary" toggle only appears when the active item really was
// sampled along pseudotime — the cohort mean is a single shape, with nowhere to walk to.
function updateBranchControls(keepPt = false) {
  const knots = activeKnots();
  const walkable = state.view === 'branches' && knots && knots.length > 1;
  const along = walkable && state.vary === 'along';
  for (const el of document.querySelectorAll('.branch-only')) el.hidden = !walkable;
  document.getElementById('map-group').hidden = !(state.view === 'branches' && tree);
  document.getElementById('ptime-group').hidden = !along;
  document.getElementById('morph-group').hidden = along;
  setActive('#vary-toggle button', 'vary', state.vary);
  if (!walkable) {
    if (knots) state.pt = knots[0];
    return;
  }
  const mid = knots[(knots.length - 1) >> 1];
  const s = document.getElementById('ptime');
  s.min = knots[0]; s.max = knots[knots.length - 1];
  s.step = (knots[knots.length - 1] - knots[0]) / 200;
  // Whichever quantity is not being varied is pinned: the target sits at the branch
  // midpoint while blending, and the blend sits at 100% while walking the branch.
  if (along) {
    state.t = 1;
    document.getElementById('morph').value = 1;
    updateSliderLabel();
    if (!keepPt) state.pt = mid;
  } else {
    state.pt = mid;
  }
  state.pt = Math.min(+s.max, Math.max(+s.min, state.pt));
  s.value = state.pt;
  updatePtimeLabel();
}
function activeKnots() {
  const o = tagObjects[Object.keys(tagObjects)[0]];
  return o && o.act && o.act.kind === 'branch' ? o.act.pt : null;
}

// ---- data + meshes -------------------------------------------------------
async function selectPhase(phase, hint = {}) {
  if (!manifest.phases[phase]?.available) return;
  if (!pivot) return;   // scene never initialised (e.g. WebGL unavailable)
  document.getElementById('note').textContent = 'Loading…';
  if (!phaseCache[phase]) phaseCache[phase] = await fetchJSON(`${DATA}/${phase}.json`);
  const data = phaseCache[phase];
  state.phase = phase;
  radius = data.radius || 100;
  setActive('#phase-toggle button', 'phase', phase);
  setActive('#view-toggle button', 'view', state.view);
  refreshPhaseToggle();

  for (const t in tagObjects) pivot.remove(tagObjects[t].mesh);
  tagObjects = {};
  const tags = Object.keys(data.tags);
  for (const tag of tags) buildTagMesh(tag, data.tags[tag]);
  buildTagCheckboxes(tags);

  populateItems();
  if (hint.item) {
    const sel = document.getElementById('item');
    if ([...sel.options].some(o => o.value === String(hint.item))) {
      state.item = String(hint.item); sel.value = state.item;
    }
  }
  updateSliderConfig();
  frameCamera();
  selectItem(state.item, hint);
  const ph = manifest.phases[phase];
  const src = ph.branch_source === 'linearised'
    ? ' Branch shapes are the linearised stand-in, not geodesic shootings.' : '';
  const nBranch = (ph.branches || []).filter(b => String(b).startsWith('Branch_')).length;
  document.getElementById('note').textContent =
    `${nBranch} branches, ${(ph.modes || []).length} modes, ` +
    `${tags.length} surfaces. Drag to rotate.${src}`;
}
function selectView(view) {
  if (view === state.view) return;
  state.view = view;
  setActive('#view-toggle button', 'view', view);
  refreshPhaseToggle();
  // The tree is always drawn end-systolic, so entering it switches the loaded phase; leaving
  // it keeps whichever phase you were in, as long as that phase has modes.
  const want = view === 'branches' ? TREE_PHASE : state.phase;
  if (want !== state.phase || !hasItems(want, view)) {
    const alt = hasItems(want, view) ? want
      : ['ES', 'ED'].find(p => manifest.phases[p]?.available && hasItems(p, view));
    if (alt) { selectPhase(alt); return; }
  }
  populateItems();
  updateSliderConfig();
  selectItem(state.item);
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
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = isEpi ? 1 : 0;
  pivot.add(mesh);
  tagObjects[tag] = { mesh, mean, entry, act: null };
}
function selectItem(item, hint = {}) {
  state.item = item;
  const data = phaseCache[state.phase];
  const f = 1 / data.scale;
  maxDisp = 1e-6;
  for (const tag in tagObjects) {
    const o = tagObjects[tag];
    if (state.view === 'branches') {
      const b = o.entry.branches[item];
      // Branch entries are {pt, d:[knot fields]}; a plain array is the older
      // one-shape-per-branch export.
      const fields = Array.isArray(b) ? [b] : b.d;
      o.act = { kind: 'branch', pt: Array.isArray(b) ? null : b.pt,
                d: fields.map(x => scaled(x, f)) };
      // One colour scale for the whole branch, so sliding towards the distal end visibly
      // moves further rather than just recolouring to the same maximum.
      o.act.d.forEach(accumulateMax);
    } else {
      const md = o.entry.modes[item];
      o.act = { kind: 'mode', minus: scaled(md.minus, f), plus: scaled(md.plus, f) };
      accumulateMax(o.act.minus); accumulateMax(o.act.plus);
    }
  }
  document.getElementById('cbar-max').textContent = maxDisp.toFixed(1) + ' mm';
  // A tree deep link carries its mode and that mode's one value: #.../along/1.102 or
  // #.../blend/0.60. A mode deep link carries just the deviation in SD.
  const val = parseFloat(hint.val);
  if (state.view === 'branches' && (hint.vary === 'blend' || hint.vary === 'along')) {
    state.vary = hint.vary;
  }
  const linked = state.view === 'branches' && !Number.isNaN(val);
  if (linked) {
    if (state.vary === 'along') state.pt = val; else state.t = val;
  }
  updateBranchControls(linked);   // otherwise a new branch opens at its own midpoint
  if (state.view === 'branches') updateSliderConfig(true);
  else if (!Number.isNaN(val)) { state.t = val; updateSliderConfig(true); }
  drawMarker();
  updateMorph();
  writeHash();
}
function accumulateMax(d) {
  for (let i = 0; i < d.length; i += 3) {
    const m = Math.hypot(d[i], d[i + 1], d[i + 2]);
    if (m > maxDisp) maxDisp = m;
  }
}
// Which two knot fields bracket the current pseudotime, and how far between them.
function bracket(act, pt) {
  const K = act.pt;
  if (!K || K.length < 2) return { a: act.d[0], b: null, w: 0 };
  if (pt <= K[0]) return { a: act.d[0], b: null, w: 0 };
  if (pt >= K[K.length - 1]) return { a: act.d[K.length - 1], b: null, w: 0 };
  let i = 0;
  while (i < K.length - 2 && pt > K[i + 1]) i++;
  return { a: act.d[i], b: act.d[i + 1], w: (pt - K[i]) / (K[i + 1] - K[i]) };
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
    let a, b, w, f;
    if (o.act.kind === 'branch') {
      ({ a, b, w } = bracket(o.act, state.pt)); f = t;
    } else {
      a = t >= 0 ? o.act.plus : o.act.minus; b = null; w = 0; f = Math.abs(t) / nsd;
    }
    for (let i = 0; i < mean.length; i += 3) {
      const ax = b ? a[i] + (b[i] - a[i]) * w : a[i];
      const ay = b ? a[i + 1] + (b[i + 1] - a[i + 1]) * w : a[i + 1];
      const az = b ? a[i + 2] + (b[i + 2] - a[i + 2]) * w : a[i + 2];
      const dx = ax * f, dy = ay * f, dz = az * f;
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

// ---- tree minimap --------------------------------------------------------
// The DDRTree skeleton in its 2D embedding: the grey graph underneath, each branch drawn
// over it in its own colour, and a marker at the pseudotime the viewer is showing.
const map = { svg: null, paths: {}, dots: {}, head: null, box: null };
function buildMinimap() {
  const host = document.getElementById('minimap');
  const N = tree.nodes;
  const xs = N.map(n => n[0]).concat(tree.samples.map(s => s[0]));
  const ys = N.map(n => n[1]).concat(tree.samples.map(s => s[1]));
  const pad = 0.06 * Math.max(Math.max(...xs) - Math.min(...xs),
                              Math.max(...ys) - Math.min(...ys));
  const box = { x0: Math.min(...xs) - pad, x1: Math.max(...xs) + pad,
                y0: Math.min(...ys) - pad, y1: Math.max(...ys) + pad };
  map.box = box;
  const W = 240, H = Math.round(W * (box.y1 - box.y0) / (box.x1 - box.x0));
  const X = x => (x - box.x0) / (box.x1 - box.x0) * W;
  const Y = y => (box.y1 - y) / (box.y1 - box.y0) * H;   // SVG y grows downwards
  map.X = X; map.Y = Y;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const add = (tagName, attrs, cls) => {
    const el = document.createElementNS(SVG_NS, tagName);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (cls) el.setAttribute('class', cls);
    svg.appendChild(el);
    return el;
  };

  for (const [u, v] of tree.edges) {
    add('line', { x1: X(N[u][0]), y1: Y(N[u][1]), x2: X(N[v][0]), y2: Y(N[v][1]) }, 'skel');
  }
  // Samples carry their branch colour, so the map reads as six phenotypes rather than one
  // grey cloud; the active branch's members then brighten with it.
  for (const s of tree.samples) {
    const br = tree.branches[`Branch_${s[2]}`];
    const el = add('circle', { cx: X(s[0]), cy: Y(s[1]), r: 1.6,
                               fill: br ? br.color : '#7f8797' }, 'smp');
    el.dataset.branch = `Branch_${s[2]}`;
    (map.dots[`Branch_${s[2]}`] ||= []).push(el);
  }
  for (const name in tree.branches) {
    const br = tree.branches[name];
    const pts = br.path.map(i => `${X(N[i][0])},${Y(N[i][1])}`).join(' ');
    const el = add('polyline', { points: pts, stroke: br.color }, 'brx');
    el.dataset.branch = name;
    map.paths[name] = el;
  }
  const r0 = tree.nodes[tree.root];
  add('circle', { cx: X(r0[0]), cy: Y(r0[1]), r: 3.5 }, 'root');
  map.head = add('circle', { cx: -99, cy: -99, r: 5, fill: '#fff' }, 'head');

  host.appendChild(svg);
  map.svg = svg;
  installMapControls(svg);
}
// Click or drag anywhere on the map: jump to the nearest point of any branch, which sets
// both the branch and how far along it we are.
function installMapControls(svg) {
  let down = false;
  const pick = e => {
    const r = svg.getBoundingClientRect();
    const W = svg.viewBox.baseVal.width, H = svg.viewBox.baseVal.height;
    const px = (e.clientX - r.left) / r.width * W, py = (e.clientY - r.top) / r.height * H;
    let best = null;
    for (const name in tree.branches) {
      for (const i of tree.branches[name].path) {
        const n = tree.nodes[i];
        const d = Math.hypot(map.X(n[0]) - px, map.Y(n[1]) - py);
        if (!best || d < best.d) best = { d, name, pt: n[2] };
      }
    }
    if (!best) return;
    const sel = document.getElementById('item');
    if (best.name !== state.item && [...sel.options].some(o => o.value === best.name)) {
      sel.value = best.name;
      selectItem(best.name);
    }
    // Dragging along the map only moves pseudotime when pseudotime is the live quantity;
    // while blending, the map is a branch picker and the marker stays on the midpoint.
    if (document.getElementById('ptime-group').hidden) return;
    const s = document.getElementById('ptime');
    state.pt = Math.min(+s.max, Math.max(+s.min, best.pt));
    s.value = state.pt; updatePtimeLabel(); drawMarker(); updateMorph(); writeHash();
  };
  svg.addEventListener('pointerdown', e => {
    down = true; svg.setPointerCapture(e.pointerId); pick(e);
  });
  svg.addEventListener('pointermove', e => { if (down) pick(e); });
  const up = e => { down = false; try { svg.releasePointerCapture(e.pointerId); } catch (_) {} };
  svg.addEventListener('pointerup', up);
  svg.addEventListener('pointercancel', up);
}
function drawMarker() {
  if (!map.svg) return;
  const active = state.view === 'branches' ? state.item : null;
  for (const name in map.paths) map.paths[name].classList.toggle('on', name === active);
  for (const name in map.dots) {
    for (const el of map.dots[name]) el.classList.toggle('on', name === active);
  }
  const br = active && tree.branches[active];
  if (!br) { map.head.setAttribute('cx', -99); map.head.setAttribute('cy', -99); return; }
  const [x, y] = pointAt(br, state.pt);
  map.head.setAttribute('cx', map.X(x));
  map.head.setAttribute('cy', map.Y(y));
  map.head.setAttribute('fill', br.color);
}
// Where a pseudotime lands on a branch: the path nodes are ordered by pseudotime, so walk
// to the bracketing pair and interpolate between their coordinates.
function pointAt(br, pt) {
  const P = br.path, N = tree.nodes;
  if (pt <= N[P[0]][2]) return [N[P[0]][0], N[P[0]][1]];
  for (let i = 0; i < P.length - 1; i++) {
    const a = N[P[i]], b = N[P[i + 1]];
    if (pt <= b[2]) {
      const w = b[2] > a[2] ? (pt - a[2]) / (b[2] - a[2]) : 0;
      return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
    }
  }
  const last = N[P[P.length - 1]];
  return [last[0], last[1]];
}

// ---- helpers -------------------------------------------------------------
function hexToRgb(h) {
  const n = parseInt(h.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
// #<view>/<phase>/<item>/<morph>[/<pseudotime>]  e.g. #branches/ES/Branch_3/1.00/1.10
// Tree:  #branches/<phase>/<item>/<vary>/<value>   e.g. #branches/ES/Branch_3/along/1.102
//                                                       #branches/ES/Branch_3/blend/0.60
// Modes: #modes/<phase>/<mode>/<sd>                e.g. #modes/ES/5/2
// Only the quantity the "Vary" toggle exposes goes in the link; the other one is pinned, so
// writing it down would suggest it could be set independently.
function parseHash() {
  const h = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (!h) return {};
  const [view, phase, item, a, b] = h.split('/');
  return view === 'branches' ? { view, phase, item, vary: a, val: b }
                             : { view, phase, item, val: a };
}
function writeHash() {
  const parts = [state.view, state.phase, state.item];
  if (state.view === 'branches') {
    // An item with no pseudotime (the cohort mean) is always a blend, whatever the toggle
    // was last left on, so the link should say so.
    const along = state.vary === 'along' && activeKnots();
    parts.push(along ? 'along' : 'blend',
               along ? state.pt.toFixed(3) : state.t.toFixed(2));
  } else {
    parts.push(state.t.toFixed(2));
  }
  history.replaceState(null, '', '#' + parts.join('/'));
}
function prettyItem(it) {
  if (String(it).startsWith('Branch_')) return 'Branch ' + String(it).split('_')[1];
  if (String(it).startsWith('cohort_mean')) return 'Cohort mean (all 233)';
  return String(it);
}
