// 3DPeek viewer: runs inside the WebView. three.js renders; occt-import-js (OpenCASCADE WASM) parses STEP in a Web Worker.
// v2: custom touch controls (no TrackballControls) so pinch-zoom is smooth and never mixes with pan/rotate.
import * as THREE from 'three';
import { analyzeFace } from './measure.js';
import { extractFeatures, planeRelation, lineAngle, linePlaneAngle } from './features.js';
import { createSection } from './section.js';
import { OCCT_FORMATS, loadMeshFormat, fcstdBrepFiles, friendlyMessage } from './formats.js';
import { objectToParts } from './meshfaces.js';

const post = (msg) => { const s = JSON.stringify(msg); if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(s); else console.log('[pc]', s); };
const $ = (id) => document.getElementById(id);

// ---------- settings (pushed from React Native) ----------
const S = { showCube: true, measure: 'off', units: 'mm', insetTop: 0, insetBottom: 0, showSize: false, rotateSpeed: 1, zoomSpeed: 1, panSpeed: 1, invertZoom: false, background: '#0E1116', displayMode: 'edges', showAxes: false, showGrid: false, rotateMode: 'turntable', upAxis: 'z', autoRotate: false, autoRotateSpeed: 1,
  photo: { on: false, keep: {}, bg: 'viewer', autoRotate: false, rotSpeed: 1 } };

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true, alpha: true, preserveDrawingBuffer: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 3));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(S.background, 1);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.01, 1e7);
camera.up.set(0, 0, 1); camera.position.set(1, -1, 0.8); // Z-up (CAD convention); front = -Y
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30343c, 1.6));
const key = new THREE.DirectionalLight(0xffffff, 1.6); camera.add(key); key.position.set(0.5, 1, 0.3);
scene.add(camera);
const target = new THREE.Vector3();
let model = null, modelR = 1, helpers = null;
const edgeMat = new THREE.LineBasicMaterial({ color: 0x0b0d10, transparent: true, opacity: 0.85 });
const wireMat = new THREE.LineBasicMaterial({ color: 0xcfd8e6 });
let dirty = true;
const section = createSection({ scene, renderer, getModel: () => model, getCamera: () => camera, onChange: (v) => { dirty = true; post({ type: 'section', ...v }); } });
const isLight = (hex) => { const c = new THREE.Color(hex); return c.r * 0.3 + c.g * 0.59 + c.b * 0.11 > 0.55; };

function updateClip() {
  const d = camera.position.distanceTo(target);
  camera.near = Math.max(d / 1000, modelR / 10000); camera.far = d + modelR * 100; camera.updateProjectionMatrix();
}
/** Bounding box of the parts that are shown (Parts panel can hide some); whole model if all hidden. */
function visBox() {
  const b = new THREE.Box3(); if (!model) return b; model.updateMatrixWorld(true);
  for (const m of model.children) if (m.visible) b.expandByObject(m);
  return b.isEmpty() ? new THREE.Box3().setFromObject(model) : b;
}
window.__pcVisBox = visBox;
// ---------- Parts: per-object visibility + selection highlight ----------
let partTree = [], partSel = [];
const SEL_EMISSIVE = new THREE.Color(0x7a3c00);
function partsTreeOCCT(result) {
  const rows = []; const ms = result.meshes; let n = 0;
  const label = (nm) => (nm && String(nm).trim()) || `Part ${++n}`;
  const all = (node) => [...(node.meshes || []), ...(node.children || []).flatMap(all)];
  const walk = (node, depth) => {
    for (const c of node.children || []) {
      const sub = all(c); if (!sub.length) continue;
      if (!(c.children || []).length && sub.length === 1) { rows.push({ name: label(c.name || ms[sub[0]].name), depth, meshes: sub }); continue; }
      rows.push({ name: label(c.name), depth, meshes: sub, group: true }); walk(c, depth + 1);
    }
    for (const i of node.meshes || []) rows.push({ name: label(ms[i].name || ((node.meshes.length === 1 && node.name) || '')), depth, meshes: [i] });
  };
  if (result.root) walk(result.root, 0); else ms.forEach((m, i) => rows.push({ name: label(m.name), depth: 0, meshes: [i] }));
  // one wrapping assembly holding everything: drop it and lift its children
  if (rows.length > 1 && rows[0].group && rows[0].meshes.length === ms.length && rows.slice(1).every((r) => r.depth >= 1)) { rows.shift(); rows.forEach((r) => r.depth--); }
  return rows;
}
function partsTreeFlat(group) { return group.children.map((m, i) => ({ name: (m.userData.name && String(m.userData.name).trim()) || `Part ${i + 1}`, depth: 0, meshes: [i] })); }
function applyPartSel() {
  if (!model) return;
  model.children.forEach((m, i) => { if (m.material && m.material.emissive) m.material.emissive.copy(partSel.includes(i) ? SEL_EMISSIVE : new THREE.Color(0)); });
  dirty = true;
}
function setParts(p) {
  if (!model) return;
  if (p.visible) { model.children.forEach((m, i) => { m.visible = p.visible[i] !== false; }); applySize(); section.rebuild(); report(); if (p.fit) fit(); }
  if (p.select) { partSel = p.select; applyPartSel(); }
  dirty = true;
}
function fitParams(dir) {
  const box = visBox();
  const r = (box.getSize(new THREE.Vector3()).length() || 1) / 2;
  const center = box.getCenter(new THREE.Vector3());
  const vf = camera.fov * Math.PI / 180, hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect);
  // leave room for the toolbar / bottom bar overlays
  const free = Math.max(0.4, 1 - (S.insetTop + S.insetBottom) / window.innerHeight);
  const dist = r / Math.sin(Math.min(vf * free, hf) / 2) * 1.05;
  return { center, dist };
}
function fit() {
  if (!model) return;
  const dir = camera.position.clone().sub(target).normalize();
  if (!isFinite(dir.x) || dir.lengthSq() === 0) dir.set(1, -1, 0.8).normalize();
  const { center, dist } = fitParams(dir);
  animateTo(dir, camera.up.clone(), center, dist, 280);
}
function fitNow() {
  const dir = new THREE.Vector3(1, -1, 0.8).normalize();
  const { center, dist } = fitParams(dir);
  target.copy(center); camera.up.set(0, 0, 1); camera.position.copy(center).addScaledVector(dir, dist); camera.lookAt(target);
  zoomPending = 0; spin = null; anim = null; updateClip(); dirty = true;
}
// ---------- smooth camera animation (view cube snaps, fit) ----------
let anim = null;
const ease = (t) => 1 - Math.pow(1 - t, 3);
function animateTo(dir, up, center, dist, ms = 420) {
  const m = new THREE.Matrix4().lookAt(dir.clone().normalize(), new THREE.Vector3(), up);
  const q1 = new THREE.Quaternion().setFromRotationMatrix(m);
  anim = { q0: camera.quaternion.clone(), q1, c0: target.clone(), c1: center.clone(), d0: camera.position.distanceTo(target), d1: dist, t0: performance.now(), ms };
  zoomPending = 0; spin = null; dirty = true;
}
function stepAnim() {
  const t = Math.min(1, (performance.now() - anim.t0) / anim.ms), k = ease(t);
  const q = anim.q0.clone().slerp(anim.q1, k);
  target.lerpVectors(anim.c0, anim.c1, k);
  const d = anim.d0 + (anim.d1 - anim.d0) * k;
  camera.quaternion.copy(q);
  camera.up.set(0, 1, 0).applyQuaternion(q);
  camera.position.copy(target).add(new THREE.Vector3(0, 0, 1).applyQuaternion(q).multiplyScalar(d));
  updateClip(); dirty = true;
  if (t >= 1) anim = null;
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight); dirty = true;
}
window.addEventListener('resize', onResize);

// ---------- camera operations ----------
const _v = new THREE.Vector3(), _right = new THREE.Vector3(), _up = new THREE.Vector3(), _q = new THREE.Quaternion();
function basis() {
  camera.updateMatrixWorld();
  _right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  _up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
}
const UP_AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const MAX_ELEV = 89.5 * Math.PI / 180;
/**
 * Orbit ("turntable") rotation like CAD apps / OrbitControls: horizontal drag spins around the world up axis (Z by default),
 * vertical drag tilts (elevation), never any roll. Elevation is clamped short of the poles so the view never flips;
 * from an exact Top/Bottom view-cube snap, tilting only moves away from the pole.
 * Modes: 'turntable' (spin + tilt), 'spin' (spin only), 'tilt' (tilt only), 'free' (trackball).
 */
function orbit(dx, dy) {
  const U = UP_AXES[S.upAxis] || UP_AXES.z, k = 0.0085 * S.rotateSpeed;
  const spinA = S.rotateMode === 'tilt' ? 0 : -dx * k, tiltA = S.rotateMode === 'spin' ? 0 : dy * k;
  if (Math.abs(spinA) < 1e-7 && Math.abs(tiltA) < 1e-7) return;
  const eye = camera.position.clone().sub(target); const r = eye.length();
  const q = new THREE.Quaternion();
  if (spinA) { q.setFromAxisAngle(U, spinA); eye.applyQuaternion(q); camera.up.applyQuaternion(q); }
  if (tiltA) {
    const e0 = Math.asin(THREE.MathUtils.clamp(eye.dot(U) / r, -1, 1));
    const lo = Math.min(-MAX_ELEV, e0), hi = Math.max(MAX_ELEV, e0);
    const e1 = THREE.MathUtils.clamp(e0 + tiltA, lo, hi), d = e1 - e0;
    if (Math.abs(d) > 1e-9) {
      let A = new THREE.Vector3().crossVectors(eye, U); // rotating eye about eye×U raises it toward U
      if (A.lengthSq() < 1e-12 * r * r) { // exactly at a pole (Top/Bottom snap): tilt toward the screen's down direction
        basis(); A.copy(_right).multiplyScalar(Math.sign(eye.dot(U)) || 1);
      }
      q.setFromAxisAngle(A.normalize(), d); eye.applyQuaternion(q); camera.up.applyQuaternion(q);
    }
  }
  // no roll: keep the up axis upright on screen, except right at a pole where "up" is undefined
  if (Math.abs(eye.dot(U)) / r < Math.cos(0.25 * Math.PI / 180)) camera.up.copy(U);
  camera.position.copy(target).add(eye); camera.lookAt(target); dirty = true;
}
/** One-finger rotation. Free mode = trackball (any direction, no gimbal lock). */
function rotate(dx, dy) {
  if (S.rotateMode && S.rotateMode !== 'free') return orbit(dx, dy);
  const angle = Math.hypot(dx, dy) * 0.0085 * S.rotateSpeed;
  if (angle < 1e-6) return;
  basis();
  const move = _v.copy(_right).multiplyScalar(dx).addScaledVector(_up, -dy).normalize();
  const eye = camera.position.clone().sub(target);
  const axis = new THREE.Vector3().crossVectors(move, eye).normalize();
  _q.setFromAxisAngle(axis, angle);
  eye.applyQuaternion(_q); camera.up.applyQuaternion(_q);
  camera.position.copy(target).add(eye); camera.lookAt(target); dirty = true;
}
function pan(dx, dy) {
  basis();
  const d = camera.position.distanceTo(target);
  const perPx = 2 * d * Math.tan(camera.fov * Math.PI / 360) / window.innerHeight * S.panSpeed;
  const off = _v.copy(_right).multiplyScalar(-dx * perPx).addScaledVector(_up, dy * perPx);
  camera.position.add(off); target.add(off); dirty = true;
}
/** World point under screen (x,y), on the plane through the target facing the camera. */
function pointUnder(x, y) {
  const ndc = new THREE.Vector3((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1, 0.5).unproject(camera);
  const ray = ndc.sub(camera.position).normalize();
  const n = target.clone().sub(camera.position).normalize();
  const t = target.clone().sub(camera.position).dot(n) / ray.dot(n);
  return camera.position.clone().addScaledVector(ray, t);
}
/** Scale camera distance by f, keeping the world point under (ax,ay) fixed on screen. */
function zoomAt(f, ax, ay) {
  const d = camera.position.distanceTo(target);
  const nd = THREE.MathUtils.clamp(d * f, modelR * 0.02, modelR * 60);
  f = nd / d; if (Math.abs(f - 1) < 1e-6) return;
  const P = pointUnder(ax, ay);
  target.sub(P).multiplyScalar(f).add(P);
  camera.position.sub(P).multiplyScalar(f).add(P);
  updateClip(); dirty = true;
}
// smoothed zoom: gestures add to zoomPending (log-distance); each frame applies a fraction of it
let zoomPending = 0, zoomAnchor = [0, 0];
function queueZoom(logScale, x, y) { zoomPending += logScale; zoomAnchor = [x, y]; }
// rotation inertia after the finger lifts
let spin = null, lastMoves = [];

// ---------- view cube (top-right overlay, own scene + ortho camera, same WebGL canvas) ----------
const CUBE_PX = 104, CUBE_MARGIN = 10;
const cubeScene = new THREE.Scene();
const cubeCam = new THREE.OrthographicCamera(-1.05, 1.05, 1.05, -1.05, 0.1, 10);
cubeScene.add(new THREE.AmbientLight(0xffffff, 2.2));
const cubeLight = new THREE.DirectionalLight(0xffffff, 1.2); cubeCam.add(cubeLight); cubeLight.position.set(0.3, 0.6, 1); cubeScene.add(cubeCam);
function faceTexture(label) {
  const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
  g.fillStyle = '#f4f6f9'; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#c9ced8'; g.lineWidth = 10; g.strokeRect(5, 5, 246, 246);
  g.fillStyle = '#2a2f38'; g.font = 'bold 58px -apple-system, Helvetica, Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(label, 128, 132);
  const t = new THREE.CanvasTexture(c); t.anisotropy = 4; t.colorSpace = THREE.SRGBColorSpace; return t;
}
const FACES = [
  ['Right', [1, 0, 0], [0, 0, 1]], ['Left', [-1, 0, 0], [0, 0, 1]],
  ['Back', [0, 1, 0], [0, 0, 1]], ['Front', [0, -1, 0], [0, 0, 1]],
  ['Top', [0, 0, 1], [0, 1, 0]], ['Bottom', [0, 0, -1], [0, -1, 0]],
];
const cube = new THREE.Group();
for (const [label, n, u] of FACES) {
  const N = new THREE.Vector3(...n), U = new THREE.Vector3(...u), R = new THREE.Vector3().crossVectors(U, N);
  const p = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshLambertMaterial({ map: faceTexture(label) }));
  p.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(R, U, N));
  p.position.copy(N).multiplyScalar(0.5);
  cube.add(p);
}
cube.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0x9aa1ad })));
const cubeHit = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ visible: false }));
cube.add(cubeHit);
function axisLabel(text, color) {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  g.fillStyle = color; g.font = 'bold 48px -apple-system, Helvetica, Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 32, 34);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false })); sp.scale.set(0.32, 0.32, 1); return sp;
}
const O = new THREE.Vector3(-0.5, -0.5, -0.5);
for (const [axis, color, text] of [[[1, 0, 0], '#e5484d', 'X'], [[0, 1, 0], '#3fb950', 'Y'], [[0, 0, 1], '#4f8cff', 'Z']]) {
  const d = new THREE.Vector3(...axis);
  const end = O.clone().addScaledVector(d, 1.32);
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([O, end]), new THREE.LineBasicMaterial({ color, depthTest: false }));
  line.renderOrder = 5; cube.add(line);
  const lab = axisLabel(text, color); lab.position.copy(O).addScaledVector(d, 1.5); lab.renderOrder = 6; cube.add(lab);
}
cube.scale.setScalar(0.92);
cubeScene.add(cube);
function cubeRect() { return { x: window.innerWidth - CUBE_PX - CUBE_MARGIN, y: S.insetTop + CUBE_MARGIN, w: CUBE_PX, h: CUBE_PX }; }
function inCube(x, y) { if (!S.showCube || (S.photo.on && !(S.photo.keep || {}).cube)) return false; const r = cubeRect(); return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }
function renderCube() {
  const dir = camera.position.clone().sub(target).normalize();
  cubeCam.position.copy(dir).multiplyScalar(4); cubeCam.up.copy(camera.up); cubeCam.lookAt(0, 0, 0);
  const r = cubeRect(), H = window.innerHeight;
  renderer.setScissorTest(true);
  renderer.setScissor(r.x, H - r.y - r.h, r.w, r.h); renderer.setViewport(r.x, H - r.y - r.h, r.w, r.h);
  renderer.autoClear = false; renderer.clearDepth(); renderer.render(cubeScene, cubeCam); renderer.autoClear = true;
  renderer.setScissorTest(false); renderer.setViewport(0, 0, window.innerWidth, H);
}
/** Tap on the cube: face -> straight view, edge -> 45° view, corner -> isometric view. */
function cubeTap(x, y) {
  const r = cubeRect();
  const ndc = new THREE.Vector2(((x - r.x) / r.w) * 2 - 1, -((y - r.y) / r.h) * 2 + 1);
  const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, cubeCam);
  const hit = ray.intersectObject(cubeHit)[0]; if (!hit || !model) return false;
  const p = cube.worldToLocal(hit.point.clone()); // in [-0.5, 0.5]^3
  const dir = new THREE.Vector3(...[p.x, p.y, p.z].map((v) => (Math.abs(v) > 0.5 - 0.17 ? Math.sign(v) : 0)));
  if (dir.lengthSq() === 0) return false;
  dir.normalize();
  const up = Math.abs(dir.z) > 0.99 ? new THREE.Vector3(0, dir.z > 0 ? 1 : -1, 0) : new THREE.Vector3(0, 0, 1);
  const { center, dist } = fitParams(dir);
  animateTo(dir, up, center, dist);
  const names = []; if (dir.z > 0.1) names.push('Top'); if (dir.z < -0.1) names.push('Bottom'); if (dir.y < -0.1) names.push('Front'); if (dir.y > 0.1) names.push('Back'); if (dir.x > 0.1) names.push('Right'); if (dir.x < -0.1) names.push('Left');
  post({ type: 'snap', view: names.join(' ') });
  return true;
}

// ---------- size overlay: bounding box with X red / Y green / Z blue edges ----------
let sizeBox = null;
function applySize() {
  if (sizeBox) { scene.remove(sizeBox); sizeBox.geometry.dispose(); sizeBox = null; }
  if (!model) return;
  const b = visBox(), mn = b.min, mx = b.max;
  post({ type: 'size', x: mx.x - mn.x, y: mx.y - mn.y, z: mx.z - mn.z });
  if (!S.showSize) { dirty = true; return; }
  const pos = [], col = [];
  const C3 = [new THREE.Color('#e5484d'), new THREE.Color('#3fb950'), new THREE.Color('#4f8cff')];
  const corners = [mn, mx];
  for (let axis = 0; axis < 3; axis++) {
    const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      const p0 = [0, 0, 0], p1 = [0, 0, 0];
      p0[axis] = mn.getComponent(axis); p1[axis] = mx.getComponent(axis);
      p0[a1] = p1[a1] = corners[i].getComponent(a1); p0[a2] = p1[a2] = corners[j].getComponent(a2);
      pos.push(...p0, ...p1); col.push(...C3[axis].toArray(), ...C3[axis].toArray());
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  sizeBox = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.95 }));
  sizeBox.renderOrder = 20; scene.add(sizeBox); dirty = true;
}

// ---------- measuring ----------
// Overlay DOM (dots, grips, labels, loupe) has pointer-events:none; all hit-testing happens here.
const ACCENT = '#4F9CFF';
const css = document.createElement('style');
css.textContent = `.pc-dot{position:absolute;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;background:${ACCENT};border:2.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5);pointer-events:none}
.pc-grip{position:absolute;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:2px solid rgba(255,255,255,.85);background:rgba(79,156,255,.28);pointer-events:none}
.pc-stem{position:absolute;width:2px;margin-left:-1px;background:rgba(255,255,255,.7);pointer-events:none}
.pc-lbl{position:absolute;transform:translate(-50%,-130%);padding:4px 8px;border-radius:8px;background:rgba(15,18,24,.88);color:#fff;font:600 14px -apple-system,Helvetica,Arial;white-space:nowrap;pointer-events:none;border:1px solid rgba(255,255,255,.15)}
.pc-loupe{position:absolute;width:128px;height:128px;border-radius:50%;overflow:hidden;border:3px solid #fff;box-shadow:0 4px 16px rgba(0,0,0,.55);pointer-events:none;display:none;background:#000}
.pc-loupe canvas{width:128px;height:128px;display:block}
.pc-cross{position:absolute;left:0;top:0;width:128px;height:128px;pointer-events:none}
.pc-cross:before,.pc-cross:after{content:'';position:absolute;background:var(--c,${ACCENT})}
.pc-ltag{position:absolute;left:50%;bottom:6px;transform:translateX(-50%);padding:1px 6px;border-radius:6px;color:#000;font:700 11px -apple-system,Helvetica,Arial}
.pc-snap{position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;border:3px solid #FFD23F;pointer-events:none;box-sizing:border-box}
.pc-snap[data-k=corner]{border-radius:3px}.pc-snap[data-k=centre]{border-radius:50%}.pc-snap[data-k=edge]{transform:rotate(45deg);width:18px;height:18px;margin:-9px 0 0 -9px}
.pc-stag{position:absolute;transform:translate(14px,-26px);padding:1px 6px;border-radius:6px;color:#000;font:700 11px -apple-system,Helvetica,Arial;pointer-events:none;white-space:nowrap}
.pc-mlbl{transform:translate(-50%,-150%);border-color:rgba(255,122,26,.7)}
.pc-cross:before{left:63px;top:34px;width:2px;height:60px}.pc-cross:after{top:63px;left:34px;height:2px;width:60px}`;
document.head.appendChild(css);
const overlay = document.createElement('div'); overlay.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:hidden';
document.body.appendChild(overlay);
const mk = (cls) => { const d = document.createElement('div'); d.className = cls; d.style.display = 'none'; overlay.appendChild(d); return d; };
const GRIP = 64; // grip sits this many px below its dot: drag the grip, the finger never hides the point
const pts = [null, null];
const dotEls = [mk('pc-dot'), mk('pc-dot')], gripEls = [mk('pc-grip'), mk('pc-grip')], stemEls = [mk('pc-stem'), mk('pc-stem')];
const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
svg.setAttribute('style', 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:visible');
const mkLine = (stroke, w) => { const l = document.createElementNS('http://www.w3.org/2000/svg', 'line'); l.setAttribute('stroke', stroke); l.setAttribute('stroke-width', w); l.setAttribute('stroke-linecap', 'round'); svg.appendChild(l); return l; };
const lineBack = mkLine('rgba(0,0,0,0.55)', 5), lineFront = mkLine(ACCENT, 2.5);
overlay.insertBefore(svg, overlay.firstChild);
const distLabel = mk('pc-lbl');
const loupe = document.createElement('div'); loupe.className = 'pc-loupe';
const loupeCanvas = document.createElement('canvas'); const LP = 128, LZ = 3, LDPR = Math.min(window.devicePixelRatio || 1, 2);
loupeCanvas.width = loupeCanvas.height = LP * LDPR; loupe.appendChild(loupeCanvas);
const cross = document.createElement('div'); cross.className = 'pc-cross'; loupe.appendChild(cross);
overlay.appendChild(loupe);
const loupeRT = new THREE.WebGLRenderTarget(LP * LDPR, LP * LDPR, { samples: 4 }); loupeRT.texture.colorSpace = THREE.SRGBColorSpace;
const loupeBuf = new Uint8Array(LP * LDPR * LP * LDPR * 4);
const loupeImg = loupeCanvas.getContext('2d').createImageData(LP * LDPR, LP * LDPR);
const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
const measLine = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: ACCENT, depthTest: false, transparent: true }));
measLine.renderOrder = 30; measLine.visible = false; scene.add(measLine);
let faceHL = null, drag = null, lastSnapKey = '';

const fmt = (mm) => { if (S.units === 'inch') { const v = mm / 25.4; return `${v.toFixed(v >= 100 ? 1 : 3)} in`; } return `${mm.toFixed(mm >= 1000 ? 1 : mm >= 100 ? 2 : 3)} mm`; };
function toScreen(v) { const p = v.clone().project(camera); return [(p.x + 1) / 2 * window.innerWidth, (1 - p.y) / 2 * window.innerHeight, p.z < 1]; }
const raycaster = new THREE.Raycaster();
function pick(x, y) {
  if (!model) return null;
  raycaster.setFromCamera(new THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1), camera);
  const hits = raycaster.intersectObjects(model.children.filter((m) => m.isMesh && m.visible && m.material.visible !== false || S.displayMode === 'wireframe'), false);
  return hits.find((h) => h.object.isMesh && section.kept(h.point)) || null;
}
// ---------- features (edges, corners, circle centres) for snapping and one-tap measures ----------
function featOf(mesh) { const ud = mesh.userData; if (!ud.feat) ud.feat = extractFeatures(ud.pos, ud.idx, ud.faces); return ud.feat; }
const visMeshes = () => (model ? model.children.filter((m) => m.isMesh && m.visible) : []);
/** is a 3D point visible from the camera (not behind another surface, not cut away)? */
function seen(p) {
  if (!section.kept(p)) return false;
  const v = new THREE.Vector3(...p), d = camera.position.distanceTo(v);
  raycaster.set(camera.position, v.clone().sub(camera.position).normalize()); raycaster.near = 0; raycaster.far = d;
  const hits = raycaster.intersectObjects(visMeshes(), false).filter((h) => section.kept(h.point));
  raycaster.far = Infinity;
  return !hits.length || hits[0].distance >= d - Math.max(1e-6, modelR * 2e-3);
}
const scr = (p) => toScreen(new THREE.Vector3(p[0], p[1], p[2]));
/** nearest chain (edge) on screen within px; returns { mesh, chain, p (closest 3D point) } */
function edgeAt(x, y, px = 14, filter) {
  let best = null, bd = px;
  for (const m of visMeshes()) for (const c of featOf(m).chains) {
    if (filter && !filter(c)) continue;
    const P = c.pts, n = P.length, S2 = P.map(scr);
    for (let i = 0; i < (c.closed ? n : n - 1); i++) {
      const A = S2[i], B = S2[(i + 1) % n]; if (!A[2] || !B[2]) continue;
      const vx = B[0] - A[0], vy = B[1] - A[1], L2 = vx * vx + vy * vy || 1, k = Math.max(0, Math.min(1, ((x - A[0]) * vx + (y - A[1]) * vy) / L2));
      const d = Math.hypot(x - A[0] - k * vx, y - A[1] - k * vy); if (d >= bd) continue;
      const a = P[i], b = P[(i + 1) % n], q = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
      if (!seen(q)) continue; bd = d; best = { mesh: m, chain: c, p: q };
    }
  }
  return best;
}
/** Snap: corner > hole/arc centre > edge > surface. Returns { p: Vector3, kind, mesh } */
function snapAt(x, y) {
  let best = null, bd = 18;
  for (const m of visMeshes()) {
    const f = featOf(m);
    for (const c of f.corners) { const [sx, sy, fr] = scr(c); const d = Math.hypot(sx - x, sy - y); if (fr && d < bd && seen(c)) { bd = d; best = { p: c, kind: 'corner', mesh: m }; } }
    for (const c of f.chains) if (c.center) { const [sx, sy, fr] = scr(c.center); const d = Math.hypot(sx - x, sy - y); if (fr && d < bd - 2 && section.kept(c.center)) { bd = d; best = { p: c.center, kind: 'centre', mesh: m }; } }
  }
  if (!best) { const e = edgeAt(x, y, 12); if (e) best = { p: e.p, kind: 'edge', mesh: e.mesh }; }
  if (!best) { const h = pick(x, y); if (!h) return null; return { p: h.point.clone(), kind: 'face', mesh: h.object }; }
  return { ...best, p: new THREE.Vector3(...best.p) };
}
/** Hit point with snapping (old name kept for the drag code) */
function pickPoint(x, y) { const r = snapAt(x, y); return r && { p: r.p, snapped: r.kind !== 'face', kind: r.kind, mesh: r.mesh }; }

// ---------- kept measurements ----------
// Each: { id, n, kind, meshes:[model child idx], group (3D marks), anchor (Vector3), el (label), data }
const items = []; let nextId = 1, nextN = 1, activeId = null, pend = null, pendMark = null;
const SNAP_COL = { corner: '#FFD23F', centre: '#3FE0C5', edge: '#FF7AE6', face: ACCENT };
const markMat = (col) => new THREE.LineBasicMaterial({ color: col, depthTest: false, transparent: true });
function chainLine(c, col = '#FF7A1A') {
  const g = new THREE.BufferGeometry().setFromPoints(c.pts.map((p) => new THREE.Vector3(...p)));
  const l = c.closed ? new THREE.LineLoop(g, markMat(col)) : new THREE.Line(g, markMat(col)); l.renderOrder = 31; return l;
}
function faceMark(mesh, face, col = '#FF7A1A') {
  const ud = mesh.userData, g = new THREE.BufferGeometry(), tp = new Float32Array((face.last - face.first + 1) * 9);
  for (let k = face.first * 3, o = 0; k <= face.last * 3 + 2; k++) { const vi = ud.idx[k]; tp[o++] = ud.pos[3 * vi]; tp[o++] = ud.pos[3 * vi + 1]; tp[o++] = ud.pos[3 * vi + 2]; }
  g.setAttribute('position', new THREE.BufferAttribute(tp, 3));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.38, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  m.renderOrder = 15; return m;
}
function segLine(a, b, col = ACCENT) { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), markMat(col)); l.renderOrder = 30; return l; }
function dotMark(p, col = ACCENT) { const g = new THREE.BufferGeometry().setFromPoints([p]); const d = new THREE.Points(g, new THREE.PointsMaterial({ color: col, size: 9, sizeAttenuation: false, depthTest: false })); d.renderOrder = 32; return d; }
function disposeGroup(g) { if (!g) return; scene.remove(g); g.traverse((n) => { if (n.geometry) n.geometry.dispose(); if (n.material) n.material.dispose(); }); }
const idxOf = (mesh) => model.children.indexOf(mesh);
function addItem(kind, data, marks, anchor, meshes, id) {
  let it = id && items.find((i) => i.id === id);
  if (it) { disposeGroup(it.group); } else { it = { id: nextId++, n: nextN++, el: mk('pc-lbl pc-mlbl') }; items.push(it); }
  const g = new THREE.Group(); marks.forEach((m) => g.add(m)); scene.add(g);
  Object.assign(it, { kind, data, group: g, anchor, meshes: [...new Set(meshes.map(idxOf))] });
  report(); dirty = true; return it;
}
function itemVisible(it) { return it.meshes.every((i) => model && model.children[i] && model.children[i].visible); }
function report() {
  post({ type: 'measures', items: items.map((it) => ({ ...it.data, id: it.id, n: it.n, kind: it.kind, hidden: !itemVisible(it) })), pending: pend ? pend.type : null, active: activeId });
}
function deleteItem(id) {
  const i = items.findIndex((it) => it.id === id); if (i < 0) return;
  const it = items[i]; disposeGroup(it.group); it.el.remove(); items.splice(i, 1);
  if (activeId === id) { activeId = null; pts[0] = pts[1] = null; }
  report(); dirty = true;
}
function clearPending() { disposeGroup(pendMark); pendMark = null; pend = null; }
const fmtDeg = (d) => `${d.toFixed(d < 10 ? 2 : 1)}°`;
function itemText(it) {
  const d = it.data;
  switch (it.kind) {
    case 'dist': return fmt(d.distance);
    case 'edge': return d.diameter !== undefined ? `⌀ ${fmt(d.diameter)}` : fmt(d.length);
    case 'angle': return fmtDeg(d.angle);
    case 'f2f': return d.distance !== undefined ? `↔ ${fmt(d.distance)}` : fmtDeg(d.angle);
    case 'face': return d.kind2 === 'cylinder' ? `⌀ ${d.approx ? '≈' : ''}${fmt(d.diameter)}` : `${d.areaExact ? '' : '≈'}${fmtA(d.area)}`;
  }
  return '';
}
const fmtA = (mm2) => (S.units === 'inch' ? `${(mm2 / 645.16).toFixed(3)} in²` : `${mm2 >= 100 ? mm2.toFixed(1) : mm2.toFixed(3)} mm²`);

// ---------- what a tap refers to (Angle / Face modes) ----------
/** faceRef: plane/cylinder face under the finger */
function faceRef(x, y) {
  const h = pick(x, y); if (!h) return null;
  const ud = h.object.userData, tri = h.faceIndex;
  const face = ud.faces.find((f) => tri >= f.first && tri <= f.last) || { first: tri, last: tri };
  const info = analyzeFace(ud.pos, ud.nrm, ud.idx, face.first, face.last);
  return { type: 'face', mesh: h.object, face, info, p: h.point.toArray(), normal: info.normal || h.face.normal.toArray(), axis: info.axis };
}
/** Angle mode: a straight edge if one is close, else a face (flat = its normal, cylinder = its axis) */
function angleRef(x, y) {
  const e = edgeAt(x, y, 10, (c) => c.kind === 'line');
  if (e) return { type: 'edge', mesh: e.mesh, chain: e.chain, dir: e.chain.dir, p: e.p };
  const f = faceRef(x, y); if (!f) return null;
  if (f.info.kind === 'plane') return f;
  if (f.info.kind === 'cylinder' && f.axis) return { ...f, type: 'axis', dir: f.axis };
  return { ...f, type: 'curved' };
}
const refMark = (r, col = '#FF7A1A') => (r.type === 'edge' ? chainLine(r.chain, col) : faceMark(r.mesh, r.face, col));
function angleBetween(a, b) {
  const V = (q) => new THREE.Vector3(...q);
  if (a.type === 'face' && b.type === 'face') { const r = planeRelation(a.normal, a.p, b.normal, b.p); return { angle: r.parallel ? 0 : 180 - r.normalsDeg, normalsDeg: r.normalsDeg, parallel: r.parallel, distance: r.distance }; }
  if (a.type !== 'face' && b.type !== 'face') {
    // two edges meeting at a corner: the real angle at that corner (0..180), else the angle between the lines
    if (a.type === 'edge' && b.type === 'edge') {
      const A = [a.chain.a, a.chain.b], B = [b.chain.a, b.chain.b];
      for (const pa of A) for (const pb of B) if (V(pa).distanceTo(V(pb)) < modelR * 1e-6) {
        const qa = A.find((q) => q !== pa), qb = B.find((q) => q !== pb);
        return { angle: V(qa).sub(V(pa)).angleTo(V(qb).sub(V(pb))) * 180 / Math.PI, corner: true };
      }
    }
    return { angle: lineAngle(a.dir, b.dir) };
  }
  const f = a.type === 'face' ? a : b, l = a.type === 'face' ? b : a; return { angle: linePlaneAngle(l.dir, f.normal) };
}
function measureReport() {
  if (S.measure !== 'distance') return;
  const [a, b] = pts;
  if (a && b) {
    const d = b.clone().sub(a);
    const data = { distance: d.length(), dx: Math.abs(d.x), dy: Math.abs(d.y), dz: Math.abs(d.z), snapA: pts.kinds[0], snapB: pts.kinds[1] };
    const it = addItem('dist', data, [segLine(a, b), dotMark(a), dotMark(b)], a.clone().add(b).multiplyScalar(0.5), pts.meshes.filter(Boolean), activeId);
    activeId = it.id;
    post({ type: 'measure', kind: 'distance', ...data });
  } else post({ type: 'measure', kind: 'distance', placed: a ? 1 : 0 });
}
function clearMeasure() {
  pts[0] = pts[1] = null; activeId = null; clearPending();
  for (const it of items.splice(0)) { disposeGroup(it.group); it.el.remove(); }
  if (faceHL) { scene.remove(faceHL); faceHL.geometry.dispose(); faceHL = null; }
  report(); dirty = true; post({ type: 'measure', kind: S.measure, cleared: true });
}
pts.kinds = [null, null]; pts.meshes = [null, null];
let snapShow = null; // { p, kind } shown with the indicator
function measureTap(x, y) {
  const M = S.measure;
  if (M === 'distance') {
    const r = pickPoint(x, y); if (!r) return;
    if (!pts[0] || (pts[0] && pts[1])) { pts[0] = r.p; pts[1] = null; activeId = null; pts.kinds = [r.kind, null]; pts.meshes = [r.mesh, null]; } else { pts[1] = r.p; pts.kinds[1] = r.kind; pts.meshes[1] = r.mesh; }
    snapShow = { p: r.p, kind: r.kind };
    post({ type: 'tick', snapped: r.snapped }); measureReport(); report(); dirty = true;
  } else if (M === 'edge') {
    const e = edgeAt(x, y, 18);
    if (!e) { post({ type: 'measureMiss', what: 'edge' }); return; }
    const c = e.chain, round = c.kind === 'circle' || c.kind === 'arc';
    const data = round ? { diameter: 2 * c.radius, radius: c.radius, full: c.kind === 'circle' || !!c.full, sweepDeg: c.sweepDeg, length: c.kind === 'circle' ? c.length : c.length, edgeKind: c.kind }
      : { length: c.length, edgeKind: c.kind };
    const marks = [chainLine(c)]; if (round) marks.push(dotMark(new THREE.Vector3(...c.center), SNAP_COL.centre));
    const anc = round ? new THREE.Vector3(...c.pts[0]) : new THREE.Vector3(...e.p);
    addItem('edge', { ...data, approx: !!e.mesh.userData.mesh }, marks, anc, [e.mesh]); post({ type: 'tick', snapped: true });
  } else if (M === 'angle') {
    const r = angleRef(x, y);
    if (!r || r.type === 'curved') { post({ type: 'measureMiss', what: r ? 'curved' : 'angle' }); return; }
    if (!pend) { pend = r; pendMark = new THREE.Group(); pendMark.add(refMark(r, '#FFD23F')); scene.add(pendMark); report(); post({ type: 'tick' }); dirty = true; return; }
    const a = pend; clearPending();
    const res = angleBetween(a, r);
    addItem('angle', { ...res, a: a.type, b: r.type }, [refMark(a), refMark(r)], new THREE.Vector3(...r.p), [a.mesh, r.mesh]); post({ type: 'tick', snapped: true });
  } else if (M === 'face') {
    const r = faceRef(x, y);
    if (!r) { clearPending(); report(); return; }
    if (pend && !(pend.mesh === r.mesh && pend.face.first === r.face.first)) {
      const a = pend; clearPending();
      if (a.info.kind === 'plane' && r.info.kind === 'plane') {
        const rel = planeRelation(a.normal, a.p, r.normal, r.p);
        const data = rel.parallel ? { distance: rel.distance, parallel: true } : { angle: 180 - rel.normalsDeg, normalsDeg: rel.normalsDeg, parallel: false };
        const marks = [refMark(a), refMark(r)];
        let anc = new THREE.Vector3(...r.p);
        if (rel.parallel) { const n = new THREE.Vector3(...a.normal).normalize(), pb = new THREE.Vector3(...r.p), foot = pb.clone().addScaledVector(n, -n.dot(pb.clone().sub(new THREE.Vector3(...a.p)))); marks.push(segLine(foot, pb), dotMark(foot), dotMark(pb)); anc = foot.clone().add(pb).multiplyScalar(0.5); }
        addItem('f2f', data, marks, anc, [a.mesh, r.mesh]); post({ type: 'tick', snapped: true });
      } else { post({ type: 'measureMiss', what: 'f2f' }); report(); }
      return;
    }
    clearPending();
    const info = r.info;
    const it = addItem('face', { ...info, kind: undefined, kind2: info.kind, plane: info.kind === 'plane', normal: undefined, axis: undefined, part: r.mesh.userData.name }, [faceMark(r.mesh, r.face)], new THREE.Vector3(...r.p), [r.mesh]);
    if (info.kind === 'plane') { pend = r; pendMark = new THREE.Group(); scene.add(pendMark); }
    report();
    post({ type: 'measure', kind: 'face', part: r.mesh.userData.name, face: { ...info, normal: undefined, axis: undefined } });
    post({ type: 'tick' }); dirty = true; void it;
  }
}
/** Touch near a dot or its grip? -> index */
function hitHandle(x, y) {
  if (S.measure !== 'distance') return -1;
  for (let i = 1; i >= 0; i--) {
    if (!pts[i]) continue;
    const [sx, sy] = toScreen(pts[i]);
    if (Math.hypot(x - sx, y - sy) < 26 || Math.hypot(x - sx, y - (sy + GRIP)) < 30) return i;
  }
  return -1;
}
// the point only moves once the finger really moves: a plain tap near a dot still places a new point
function startDrag(i, x, y) { const [sx, sy] = toScreen(pts[i]); drag = { i, ox: sx - x, oy: Math.min(sy - y, -GRIP * 0.6), x0: x, y0: y, live: false }; lastSnapKey = ''; }
function moveDrag(x, y) {
  if (!drag.live) { if (Math.hypot(x - drag.x0, y - drag.y0) < 8) return; drag.live = true; }
  const sx = x + drag.ox, sy = y + drag.oy; // the point is always ABOVE the finger
  const r = pickPoint(sx, sy);
  if (r) {
    pts[drag.i] = r.p; pts.kinds[drag.i] = r.kind; pts.meshes[drag.i] = r.mesh; snapShow = { p: r.p, kind: r.kind };
    const k = r.snapped ? r.kind + r.p.toArray().join() : ''; if (k && k !== lastSnapKey) post({ type: 'tick', snapped: true }); lastSnapKey = k;
  }
  drag.sx = sx; drag.sy = sy; dirty = true; measureReport();
}
function renderLoupe() {
  const W = window.innerWidth, H = window.innerHeight, [sx, sy] = toScreen(pts[drag.i]);
  const w = LP / LZ;
  camera.setViewOffset(W, H, sx - w / 2, sy - w / 2, w, w);
  renderer.setRenderTarget(loupeRT); renderer.render(scene, camera); renderer.setRenderTarget(null);
  camera.clearViewOffset();
  renderer.readRenderTargetPixels(loupeRT, 0, 0, LP * LDPR, LP * LDPR, loupeBuf);
  const n = LP * LDPR, d = loupeImg.data, row = n * 4;
  for (let yy = 0; yy < n; yy++) d.set(loupeBuf.subarray((n - 1 - yy) * row, (n - yy) * row), yy * row);
  loupeCanvas.getContext('2d').putImageData(loupeImg, 0, 0);
  // snap indicator inside the loupe: crosshair colour + name
  const kind = pts.kinds[drag.i] || 'face';
  cross.style.setProperty('--c', SNAP_COL[kind]); loupeTag.textContent = SNAP_NAME[kind]; loupeTag.style.background = SNAP_COL[kind];
  let lx = sx - LP / 2, ly = sy - LP - 70;
  if (ly < S.insetTop + 8) ly = sy + GRIP + 50;
  lx = Math.max(8, Math.min(W - LP - 8, lx));
  loupe.style.left = lx + 'px'; loupe.style.top = ly + 'px'; loupe.style.display = 'block';
}
const SNAP_NAME = { corner: 'Corner', centre: 'Centre', edge: 'Edge', face: 'Surface' };
const loupeTag = document.createElement('div'); loupeTag.className = 'pc-ltag'; loupe.appendChild(loupeTag);
const snapEl = mk('pc-snap'), snapTag = mk('pc-stag');
function place(el, x, y, show = true) { el.style.display = show ? 'block' : 'none'; if (show) { el.style.left = x + 'px'; el.style.top = y + 'px'; } }
function updateOverlay() {
  const on = S.measure === 'distance';
  for (let i = 0; i < 2; i++) {
    const p = on && pts[i] && (!activeId || items.some((it) => it.id === activeId && itemVisible(it)) || !pts[1]) && pts[i];
    if (!p) { dotEls[i].style.display = gripEls[i].style.display = stemEls[i].style.display = 'none'; continue; }
    const [x, y, front] = toScreen(p);
    place(dotEls[i], x, y, front); place(gripEls[i], x, y + GRIP, front);
    place(stemEls[i], x, y + 8, front); stemEls[i].style.height = (GRIP - 25) + 'px';
    dotEls[i].style.background = SNAP_COL[pts.kinds[i] || 'face'];
  }
  svg.style.display = 'none'; distLabel.style.display = 'none';
  // snap indicator at the latest snapped point (Point mode)
  if (on && snapShow && snapShow.kind !== 'face') {
    const [x, y, f] = toScreen(snapShow.p); place(snapEl, x, y, f); place(snapTag, x, y, f);
    snapEl.dataset.k = snapShow.kind; snapEl.style.borderColor = SNAP_COL[snapShow.kind]; snapTag.textContent = SNAP_NAME[snapShow.kind]; snapTag.style.background = SNAP_COL[snapShow.kind];
  } else { snapEl.style.display = snapTag.style.display = 'none'; }
  // labels of kept measurements
  const placed = []; // simple de-clutter: labels that would overlap move down a row
  for (const it of items) {
    const vis = itemVisible(it) && S.measure !== 'off';
    it.group.visible = vis;
    if (!vis) { it.el.style.display = 'none'; continue; }
    const [x, y, f] = toScreen(it.anchor); const t = `${it.n}  ${itemText(it)}`;
    if (it.el.textContent !== t) it.el.textContent = t;
    let yy = y; const w = 8 + t.length * 8;
    for (let k = 0; k < 6 && placed.some((q) => Math.abs(q[0] - x) < (q[2] + w) / 2 && Math.abs(q[1] - yy) < 26); k++) yy += 27;
    placed.push([x, yy, w]); place(it.el, x, yy, f);
  }
  if (pendMark) pendMark.visible = !pend || (pend.mesh && pend.mesh.visible);
  if (drag && drag.live && pts[drag.i]) renderLoupe(); else loupe.style.display = 'none';
}

// ---------- section view helpers ----------
function hitSectionHandle(x, y) {
  const h = section.handleScreen(toScreen); if (!h) return false;
  // distance from finger to the arrow segment on screen
  const [ax, ay] = h.a, [bx, by] = h.b, vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy || 1;
  const k = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / L2));
  return Math.hypot(x - (ax + k * vx), y - (ay + k * vy)) < 30;
}
function alignSectionAt(x, y) {
  const h = pick(x, y); if (!h) { post({ type: 'sectionAlign', ok: false }); return; }
  const n = h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize();
  section.apply({ on: true, axis: 'custom', normal: n.toArray(), t: 0, flip: false });
  // put the plane exactly through the tapped point: t from the point's position along n, nudged just inside
  const st = section.state; const box = visBox(); let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 8; i++) { const p = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z); const d = n.dot(p); lo = Math.min(lo, d); hi = Math.max(hi, d); }
  const tt = (n.dot(h.point) - (hi - lo) * 0.002 - lo) / ((hi - lo) || 1);
  section.apply({ t: tt });
  S.sectionAlign = false; post({ type: 'sectionAlign', ok: true, normal: n.toArray() }); dirty = true;
}

// ---------- touch handling with locked gesture modes ----------
// mode: 'none' | 'rotate' | 'two' (pinch decided as 'zoom' or 'pan' after a few px) | 'done' (fingers lifting after 2-finger gesture)
let mode = 'none', two = null, last = null;
let lastTap = 0, tapStart = 0, tapMoved = false, tapXY = [0, 0];
const el = renderer.domElement;
const mid = (t) => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2];
const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

el.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const t = e.touches;
  if (S.photo.on) post({ type: 'photoTouch' });
  if (S.toolsOpen) { S.toolsOpen = false; post({ type: 'touch' }); }
  spin = null; anim = null;
  const hh = t.length === 1 && mode !== 'done' ? hitHandle(t[0].clientX, t[0].clientY) : -1;
  if (hh < 0 && t.length === 1 && mode !== 'done' && hitSectionHandle(t[0].clientX, t[0].clientY)) { mode = 'section'; last = [t[0].clientX, t[0].clientY]; }
  else if (hh >= 0) { mode = 'handle'; startDrag(hh, t[0].clientX, t[0].clientY); }
  else if (t.length === 1 && mode !== 'done' && inCube(t[0].clientX, t[0].clientY)) {
    mode = 'cube'; last = [t[0].clientX, t[0].clientY]; tapXY = last; tapMoved = false; lastMoves = [];
  } else if (t.length === 1 && mode !== 'done') {
    mode = 'rotate'; last = [t[0].clientX, t[0].clientY]; lastMoves = [];
    tapStart = Date.now(); tapMoved = false; tapXY = last;
  } else if (t.length >= 2) {
    tapMoved = true;
    const m = mid(t), d = dist(t);
    mode = 'two'; two = { sub: null, d0: d, m0: m, pd: d, pm: m };
  }
}, { passive: false });

el.addEventListener('touchmove', (e) => {
  e.preventDefault();
  const t = e.touches;
  if (mode === 'handle') { if (t.length === 1) moveDrag(t[0].clientX, t[0].clientY); return; }
  if (mode === 'section') { if (t.length === 1) { section.dragBy(t[0].clientX - last[0], t[0].clientY - last[1], toScreen); last = [t[0].clientX, t[0].clientY]; } return; }
  if (mode === 'cube' && t.length === 1) { // dragging the cube rotates the model
    const x = t[0].clientX, y = t[0].clientY;
    if (Math.hypot(x - tapXY[0], y - tapXY[1]) > 6) tapMoved = true;
    if (tapMoved) { rotate(x - last[0], y - last[1]); lastMoves.push({ dx: x - last[0], dy: y - last[1], t: performance.now() }); if (lastMoves.length > 5) lastMoves.shift(); }
    last = [x, y];
  } else if (mode === 'rotate' && t.length === 1) {
    const x = t[0].clientX, y = t[0].clientY;
    if (Math.hypot(x - tapXY[0], y - tapXY[1]) > 10) tapMoved = true;
    if (!tapMoved) return;
    const dx = x - last[0], dy = y - last[1]; last = [x, y];
    rotate(dx, dy);
    lastMoves.push({ dx, dy, t: performance.now() }); if (lastMoves.length > 5) lastMoves.shift();
  } else if (mode === 'two' && t.length >= 2) {
    const m = mid(t), d = dist(t);
    if (!two.sub) { // decide once, then stay locked until fingers lift
      const dd = Math.abs(d - two.d0), dm = Math.hypot(m[0] - two.m0[0], m[1] - two.m0[1]);
      if (Math.max(dd, dm) < 12) return;
      two.sub = dd >= dm * 0.6 ? 'zoom' : 'pan';
      two.pd = d; two.pm = m;
      post({ type: 'gesture', mode: two.sub });
      return;
    }
    if (two.sub === 'zoom') {
      const ratio = two.pd / d; // fingers apart -> ratio < 1 -> closer
      let s = Math.log(ratio) * S.zoomSpeed * (S.invertZoom ? -1 : 1);
      queueZoom(s, m[0], m[1]);
    } else {
      const dx = m[0] - two.pm[0], dy = m[1] - two.pm[1];
      if (Math.hypot(dx, dy) > 0.5) pan(dx, dy); // ignore sub-pixel jitter
    }
    two.pd = d; two.pm = m;
  }
}, { passive: false });

el.addEventListener('touchend', (e) => {
  e.preventDefault();
  const t = e.touches;
  if (mode === 'handle') { if (!t.length) { const d = drag; drag = null; mode = 'none'; dirty = true; if (d && !d.live) measureTap(d.x0, d.y0); else post({ type: 'tick' }); } return; }
  if (mode === 'section') { if (!t.length) { mode = 'none'; post({ type: 'tick' }); } return; }
  if (mode === 'cube') {
    if (!t.length) { if (!tapMoved) cubeTap(tapXY[0], tapXY[1]); mode = 'none'; } else mode = 'done';
  } else if (mode === 'rotate' && t.length === 0) {
    const now = performance.now();
    const recent = lastMoves.filter((m) => now - m.t < 80);
    if (tapMoved && recent.length) {
      const dx = recent.reduce((a, m) => a + m.dx, 0) / recent.length, dy = recent.reduce((a, m) => a + m.dy, 0) / recent.length;
      if (Math.hypot(dx, dy) > 1.5) spin = { dx, dy };
    }
    if (!tapMoved && Date.now() - tapStart < 300 && S.photo.on) post({ type: 'photoTap' });
    else if (!tapMoved && Date.now() - tapStart < 300 && S.sectionAlign) alignSectionAt(tapXY[0], tapXY[1]);
    else if (!tapMoved && Date.now() - tapStart < 300 && S.measure !== 'off') measureTap(tapXY[0], tapXY[1]);
    else if (!tapMoved && Date.now() - tapStart < 300) {
      if (S.partsPick) { const h = pick(tapXY[0], tapXY[1]); post({ type: 'partTap', mesh: h ? model.children.indexOf(h.object) : -1 }); }
      const n = Date.now(); if (n - lastTap < 320) { fit(); post({ type: 'fit' }); lastTap = 0; } else lastTap = n;
    }
    mode = 'none';
  } else if (mode === 'two' || mode === 'done') {
    mode = t.length ? 'done' : 'none'; // stay locked until every finger is up: no rotate jump when one finger lifts first
  } else if (!t.length) mode = 'none';
}, { passive: false });
el.addEventListener('touchcancel', () => { mode = 'none'; spin = null; drag = null; dirty = true; });
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());

// mouse (desktop testing): left drag rotate, right/shift drag pan, wheel zoom at cursor, dblclick fit
let mouse = null;
el.addEventListener('mousedown', (e) => { if (inCube(e.clientX, e.clientY)) { mouse = null; cubeTap(e.clientX, e.clientY); return; } const hh = hitHandle(e.clientX, e.clientY); if (hh >= 0) { mouse = { handle: true }; startDrag(hh, e.clientX, e.clientY); return; }
  mouse = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, pan: e.button !== 0 || e.shiftKey }; spin = null; });
window.addEventListener('mousemove', (e) => { if (!mouse) return; if (mouse.handle) { moveDrag(e.clientX, e.clientY); return; } const dx = e.clientX - mouse.x, dy = e.clientY - mouse.y; mouse.x = e.clientX; mouse.y = e.clientY; mouse.pan ? pan(dx, dy) : rotate(dx, dy); });
window.addEventListener('mouseup', (e) => { if (mouse && mouse.handle) { drag = null; dirty = true; } else if (mouse && S.measure !== 'off' && Math.hypot(e.clientX - mouse.x0, e.clientY - mouse.y0) < 4) measureTap(e.clientX, e.clientY); mouse = null; });
el.addEventListener('contextmenu', (e) => e.preventDefault());
el.addEventListener('wheel', (e) => { e.preventDefault(); queueZoom(e.deltaY * 0.0015 * S.zoomSpeed * (S.invertZoom ? -1 : 1), e.clientX, e.clientY); }, { passive: false });
el.addEventListener('dblclick', (e) => { if (!inCube(e.clientX, e.clientY)) fit(); });

(function loop() {
  requestAnimationFrame(loop);
  if (Math.abs(zoomPending) > 1e-4) { const step = zoomPending * 0.35; zoomPending -= step; zoomAt(Math.exp(step), zoomAnchor[0], zoomAnchor[1]); }
  else zoomPending = 0;
  if (spin && mode === 'none') { rotate(spin.dx, spin.dy); spin.dx *= 0.92; spin.dy *= 0.92; if (Math.hypot(spin.dx, spin.dy) < 0.15) spin = null; }
  if (anim) stepAnim();
  // auto-rotate: Photo Mode uses its own on/speed setting, the normal view uses the rotation-menu setting
  if ((S.photo.on ? S.photo.autoRotate : S.autoRotate) && model && mode === 'none' && !spin && !anim) autoSpin(); else lastSpinT = 0;
  if (dirty) { photoRender(); dirty = false; }
})();

// ---------- Photo Mode: only the model (plus whatever the user chose to keep) ----------
let lastSpinT = 0;
function autoSpin() {
  const now = performance.now(), dt = Math.min(0.05, (now - (lastSpinT || now)) / 1000); lastSpinT = now;
  const U = UP_AXES[S.upAxis] || UP_AXES.z, q = new THREE.Quaternion().setFromAxisAngle(U, dt * 0.35 * (S.photo.on ? S.photo.rotSpeed : S.autoRotateSpeed));
  const eye = camera.position.clone().sub(target).applyQuaternion(q); camera.up.applyQuaternion(q);
  camera.position.copy(target).add(eye); camera.lookAt(target); dirty = true;
}
/** objects to hide in Photo Mode given the keep options */
function photoHidden() {
  const k = S.photo.keep || {}, out = [];
  if (helpers) helpers.children.forEach((h) => { if (!(h.userData.helper === 'grid' ? k.grid : k.axes)) out.push(h); });
  if (sizeBox && !k.size) out.push(sizeBox);
  if (!k.measure) { out.push(measLine); if (faceHL) out.push(faceHL); items.forEach((it) => out.push(it.group)); if (pendMark) out.push(pendMark); }
  if (!k.section) { const d = scene.getObjectByName('section-deco'); if (d) out.push(d); }
  return out.filter((o) => o.visible);
}
const PHOTO_BG = { black: '#000000', white: '#FFFFFF' };
function applyPhotoBg() {
  const ph = S.photo.on ? S.photo.bg : 'viewer';
  if (ph === 'gradient') { renderer.setClearColor(0x000000, 0); document.body.style.background = 'linear-gradient(180deg,#3B4A63 0%,#141A24 70%,#0B0E14 100%)'; }
  else { const c = PHOTO_BG[ph] || S.background; renderer.setClearColor(c, 1); document.body.style.background = c; }
  overlay.style.display = S.photo.on && !(S.photo.keep || {}).measure ? 'none' : '';
  dirty = true;
}
function photoRender(transparent) {
  const hide = S.photo.on || transparent ? photoHidden() : [];
  hide.forEach((o) => { o.visible = false; });
  renderer.render(scene, camera);
  hide.forEach((o) => { o.visible = true; });
  if (model && S.showCube && !(S.photo.on && !(S.photo.keep || {}).cube) && !transparent) renderCube();
  if (!S.photo.on || (S.photo.keep || {}).measure) updateOverlay();
}
/** Clean high-res picture of the model: scale x screen resolution (capped ~16 MP for iOS), optional transparency + watermark. */
function capturePhoto({ scale = 2, transparent = false, watermark = false } = {}) {
  const W = window.innerWidth, H = window.innerHeight, base = renderer.getPixelRatio();
  const pr = Math.min(base * scale, Math.sqrt(16e6 / (W * H)));
  const prevAlpha = renderer.getClearAlpha(), prevCol = renderer.getClearColor(new THREE.Color());
  try {
    renderer.setPixelRatio(pr); renderer.setSize(W, H);
    const bgMode = transparent ? 'transparent' : S.photo.bg;
    if (bgMode === 'transparent' || bgMode === 'gradient') renderer.setClearColor(0x000000, 0);
    else renderer.setClearColor(PHOTO_BG[bgMode] || S.background, 1);
    const wasOn = S.photo.on; S.photo.on = true; const keepCube = S.photo.keep.cube; S.photo.keep.cube = false;
    photoRender(true);
    S.photo.on = wasOn; S.photo.keep.cube = keepCube;
    const c = document.createElement('canvas'); c.width = renderer.domElement.width; c.height = renderer.domElement.height;
    const g = c.getContext('2d');
    if (bgMode === 'gradient') { const gr = g.createLinearGradient(0, 0, 0, c.height); gr.addColorStop(0, '#3B4A63'); gr.addColorStop(0.7, '#141A24'); gr.addColorStop(1, '#0B0E14'); g.fillStyle = gr; g.fillRect(0, 0, c.width, c.height); }
    g.drawImage(renderer.domElement, 0, 0);
    if (watermark) {
      const fs = Math.round(c.width * 0.035); g.font = `600 ${fs}px -apple-system, Helvetica, Arial, sans-serif`; g.textAlign = 'right';
      g.fillStyle = isLight(PHOTO_BG[bgMode] || S.background) && bgMode !== 'gradient' ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.55)';
      g.fillText('3DPeek', c.width - fs, c.height - fs);
    }
    return { data: c.toDataURL('image/png'), width: c.width, height: c.height };
  } finally {
    renderer.setPixelRatio(base); renderer.setSize(W, H); renderer.setClearColor(prevCol, prevAlpha); applyPhotoBg(); dirty = true;
  }
}

// ---------- display mode, helpers, background ----------
function applyDisplay() {
  const m = S.displayMode;
  wireMat.color.set(isLight(S.background) ? 0x1c2330 : 0xd5deea);
  if (model) model.traverse((n) => {
    if (n.isMesh) n.material.visible = m !== 'wireframe';
    if (n.userData.isEdges) { n.visible = m !== 'shaded'; n.material = m === 'wireframe' ? wireMat : edgeMat; }
  });
  dirty = true;
}
function applyHelpers() {
  if (helpers) { scene.remove(helpers); helpers.traverse((n) => { n.geometry && n.geometry.dispose(); }); helpers = null; }
  if (!model || (!S.showAxes && !S.showGrid)) { dirty = true; return; }
  helpers = new THREE.Group();
  const box = new THREE.Box3().setFromObject(model);
  if (S.showGrid) {
    const size = Math.max(box.max.x - box.min.x, box.max.y - box.min.y) * 1.6 || 1;
    const step = Math.pow(10, Math.floor(Math.log10(size / 10)));
    const divs = Math.min(200, Math.ceil(size / step));
    const light = isLight(S.background);
    const g = new THREE.GridHelper(divs * step, divs, light ? 0x8890a0 : 0x4a5568, light ? 0xc4cad4 : 0x262d38);
    g.rotation.x = Math.PI / 2; // GridHelper is XZ; Z-up wants XY
    g.position.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.min.z);
    g.userData.helper = 'grid'; helpers.add(g);
  }
  if (S.showAxes) { const a = new THREE.AxesHelper(modelR * 0.6); a.material.depthTest = false; a.renderOrder = 10; a.userData.helper = 'axes'; helpers.add(a); }
  scene.add(helpers); dirty = true;
}
function applySettings(p) {
  const prevMeasure = S.measure;
  Object.assign(S, p);
  // switching measure mode keeps the saved measurements; only the half-done one is dropped
  if (p.measure !== undefined && p.measure !== prevMeasure) { pts[0] = pts[1] = null; activeId = null; snapShow = null; clearPending(); if (faceHL) { scene.remove(faceHL); faceHL.geometry.dispose(); faceHL = null; } report(); }
  applyPhotoBg();
  applyDisplay(); applyHelpers(); applySize();
}

// ---------- build three.js meshes ----------
function makeMesh(g, color, userData) {
  if (!g.attributes.normal) g.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color, metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const mesh = new THREE.Mesh(g, mat);
  mesh.userData = userData;
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g, 25), S.displayMode === 'wireframe' ? wireMat : edgeMat);
  edges.userData.isEdges = true;
  mesh.add(edges);
  return mesh;
}
/** occt-import-js result (B-rep, exact faces) -> group */
function buildModel(result) {
  const group = new THREE.Group();
  let tris = 0;
  for (const m of result.meshes) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(m.attributes.position.array, 3));
    if (m.attributes.normal) g.setAttribute('normal', new THREE.Float32BufferAttribute(m.attributes.normal.array, 3));
    const idx = m.index.array; tris += idx.length / 3;
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
    const c = m.color ? new THREE.Color(m.color[0], m.color[1], m.color[2]) : new THREE.Color(0x9aa7b8);
    group.add(makeMesh(g, c, { pos: m.attributes.position.array, nrm: m.attributes.normal ? m.attributes.normal.array : null, idx, faces: m.brep_faces || [], name: m.name || '' }));
  }
  return { group, tris, count: result.meshes.length };
}
/** plain mesh parts (objectToParts) -> group; faces are approximate regions */
function buildMeshModel(parts) {
  const group = new THREE.Group(); let tris = 0;
  for (const p of parts) { tris += p.tris; group.add(makeMesh(p.renderGeo, p.color, { pos: p.pos, nrm: null, idx: p.idx, faces: p.faces, name: p.name, mesh: true })); }
  return { group, tris, count: parts.length };
}

// ---------- lazily loaded libraries (3DM, IFC): React Native sends the JS (with WASM inside) on request ----------
const libs = {}, libWait = {}, libBuf = {};
function needLib(name) {
  if (libs[name]) return Promise.resolve(libs[name]);
  if (!libWait[name]) {
    post({ type: 'stage', stage: 'library' });
    post({ type: 'needLib', name });
    libWait[name] = new Promise((res, rej) => {
      const t = setInterval(() => {
        if (libs[name]) { clearInterval(t); res(libs[name]); }
        else if (libs[name + ':error']) { clearInterval(t); const m = libs[name + ':error']; delete libs[name + ':error']; libWait[name] = null; rej(new Error(m)); }
      }, 30);
    });
  }
  return libWait[name];
}
const b64ToBytes = (b64) => { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
const UNIT_TO_MM = { 1: 1e-3, 2: 1, 3: 10, 4: 1000, 5: 1e6, 6: 1e-3 * 25.4 / 1000, 7: 25.4e-3, 8: 25.4, 9: 304.8, 10: 1609344, 12: 1e-6, 13: 1e-3 * 1e-3 };
async function load3dm(bytes) {
  const rhino = await needLib('rhino');
  const doc = rhino.File3dm.fromByteArray(bytes);
  if (!doc) throw new Error('Could not read this 3DM file.');
  const us = doc.settings().modelUnitSystem; const code = us && us.value !== undefined ? us.value : us;
  const scale = UNIT_TO_MM[code] || 1;
  const loader = new THREE.BufferGeometryLoader(); const group = new THREE.Group();
  const objs = doc.objects();
  for (let i = 0; i < objs.count; i++) {
    const o = objs.get(i), geo = o.geometry(), attr = o.attributes();
    if (attr && attr.visible === false) continue;
    const meshes = [];
    const t = geo.objectType && geo.objectType.constructor ? geo.objectType.value : geo.objectType;
    if (geo instanceof rhino.Mesh) meshes.push(geo);
    else if (geo instanceof rhino.Brep) { const fs = geo.faces(); for (let k = 0; k < fs.count; k++) { const m = fs.get(k).getMesh(rhino.MeshType.Any); if (m) meshes.push(m); } }
    else if (geo instanceof rhino.Extrusion) { const m = geo.getMesh(rhino.MeshType.Any); if (m) meshes.push(m); }
    else if (rhino.SubD && geo instanceof rhino.SubD) { try { meshes.push(rhino.Mesh.createFromSubDControlNet(geo, true)); } catch (e) {} }
    void t;
    let color = 0x9aa7b8;
    try { const c = attr.drawColor(doc); if (c) color = new THREE.Color(c.r / 255, c.g / 255, c.b / 255); } catch (e) {}
    for (const m of meshes) {
      try { const g = loader.parse(m.toThreejsJSON()); group.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color }))); } catch (e) {}
    }
  }
  if (!group.children.length) throw new Error('This 3DM file has no meshable objects (only render meshes, breps, extrusions and meshes are shown).');
  const names = { 1: 'µm', 2: 'mm', 3: 'cm', 4: 'm', 8: 'in', 9: 'ft' };
  return { object: group, scale, unitNote: `3DM units: ${names[code] || 'unknown (assumed mm)'}` };
}
async function loadIfc(bytes) {
  const WebIFC = await needLib('ifc');
  const api = new WebIFC.IfcAPI();
  await api.Init(() => libs.ifcWasmUrl, true);
  const id = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: true });
  const group = new THREE.Group();
  const flat = api.LoadAllGeometry(id);
  for (let i = 0; i < flat.size(); i++) {
    const fm = flat.get(i); const pgs = fm.geometries;
    for (let j = 0; j < pgs.size(); j++) {
      const pg = pgs.get(j); const geom = api.GetGeometry(id, pg.geometryExpressID);
      const v = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const ix = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      const p = new Float32Array(v.length / 2);
      for (let k = 0, o = 0; k < v.length; k += 6) { p[o++] = v[k]; p[o++] = v[k + 1]; p[o++] = v[k + 2]; }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3)); g.setIndex(Array.from(ix));
      const m = new THREE.Matrix4().fromArray(pg.flatTransformation); g.applyMatrix4(m);
      const c = pg.color; if (c.w < 0.15) { geom.delete && geom.delete(); continue; } // skip glass/space volumes
      group.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: new THREE.Color(c.x, c.y, c.z) })));
      geom.delete && geom.delete();
    }
  }
  api.CloseModel(id);
  // IFC is Y-up in web-ifc output; viewer is Z-up
  const wrap = new THREE.Group(); wrap.add(group); wrap.rotation.x = Math.PI / 2;
  return { object: wrap, scale: 1000, unitNote: 'IFC, converted from metres' };
}

// ---------- parser worker ----------
let wasmBytes = null;
function getWasm() {
  if (!wasmBytes) {
    const b64 = $('occt-wasm').textContent.trim();
    const bin = atob(b64); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    wasmBytes = u8;
  }
  return wasmBytes;
}
let worker = null, workerReady = null, occtMain = null;
function makeWorker() {
  const src = $('occt-js').textContent + `
;let occtP=null;
onmessage=async(ev)=>{const d=ev.data;
 if(d.type==='init'){occtP=occtimportjs({wasmBinary:d.wasm});await occtP;postMessage({type:'inited'});return;}
 try{const o=await occtP;const t=performance.now();const f=d.format||'step';const r=f==='iges'?o.ReadIgesFile(d.bytes,null):f==='brep'?o.ReadBrepFile(d.bytes,null):o.ReadStepFile(d.bytes,null);postMessage({type:'result',result:r,ms:performance.now()-t});}
 catch(e){postMessage({type:'error',message:String(e&&e.message||e)});}};`;
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  workerReady = new Promise((res, rej) => {
    w.onmessage = (ev) => { if (ev.data.type === 'inited') res(); };
    w.onerror = (e) => rej(new Error('worker: ' + (e.message || 'failed')));
  });
  w.postMessage({ type: 'init', wasm: getWasm().slice().buffer });
  return w;
}
async function parseInWorker(bytes, format) {
  if (!worker) worker = makeWorker();
  await workerReady;
  return new Promise((res, rej) => {
    worker.onmessage = (ev) => { if (ev.data.type === 'result') res(ev.data); else if (ev.data.type === 'error') rej(new Error(ev.data.message)); };
    worker.postMessage({ type: 'parse', bytes, format }, [bytes.buffer]);
  });
}
async function parseOnMain(bytes, format) { // fallback if Workers are unavailable
  if (!occtMain) { (0, eval)($('occt-js').textContent); occtMain = await window.occtimportjs({ wasmBinary: getWasm() }); }
  const t = performance.now(); const result = format === 'iges' ? occtMain.ReadIgesFile(bytes, null) : format === 'brep' ? occtMain.ReadBrepFile(bytes, null) : occtMain.ReadStepFile(bytes, null); return { result, ms: performance.now() - t };
}

// ---------- file transfer from React Native ----------
let chunks = [], meta = null;
window.pc = {
  begin(m) { meta = m; chunks = []; meta.t0 = performance.now(); },
  chunk(b64) { chunks.push(b64); },
  libBegin(name) { libBuf[name] = []; },
  libChunk(name, str) { libBuf[name].push(str); },
  libEnd(name) {
    try {
      window.__pcLib = null;
      (0, eval)(libBuf[name].join('')); delete libBuf[name];
      const L = window.__pcLib; // { kind, wasm (base64) }
      if (name === 'rhino') L.factory({ wasmBinary: b64ToBytes(L.wasm) }).then((r) => { libs.rhino = r; }).catch((e) => { libs['rhino:error'] = String(e); });
      else if (name === 'ifc') { libs.ifcWasmUrl = URL.createObjectURL(new Blob([b64ToBytes(L.wasm)], { type: 'application/wasm' })); libs.ifc = L.lib; }
    } catch (e) { libs[name + ':error'] = String(e && e.message || e); }
  },
  libError(name, msg) { libs[name + ':error'] = msg; },
  async end() {
    const tRecv = performance.now() - meta.t0;
    try {
      const parts = chunks.map((c) => { const s = atob(c); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; });
      chunks = [];
      const total = parts.reduce((a, p) => a + p.length, 0); const bytes = new Uint8Array(total);
      let o = 0; for (const p of parts) { bytes.set(p, o); o += p.length; }
      post({ type: 'stage', stage: 'parsing' });
      const ext = (meta.ext || (meta.name.match(/\.([^.]+)$/) || [])[1] || 'step').toLowerCase();
      let out, mode = 'worker', built, unitNote = 'mm (from CAD file)';
      const occt = async (b, format) => {
        let o; try { o = await parseInWorker(b.slice(), format); } catch (e) { mode = 'main'; worker = null; o = await parseOnMain(b, format); }
        if (!o.result.success) throw new Error(`Could not read this ${format.toUpperCase()} file.`);
        return o;
      };
      const t1 = performance.now();
      if (OCCT_FORMATS[ext]) {
        out = await occt(bytes, OCCT_FORMATS[ext]);
        if (!out.result.meshes.length) throw new Error('No shapes found in this file.');
      } else if (ext === 'fcstd') {
        const files = fcstdBrepFiles(bytes);
        if (!files.length) throw new Error('No visible shapes found in this FreeCAD file.');
        const all = { success: true, meshes: [] };
        for (const f of files) { const o = await occt(f.bytes, 'brep'); for (const m of o.result.meshes) { m.name = m.name || f.name; all.meshes.push(m); } }
        out = { result: all, ms: performance.now() - t1 };
      } else {
        mode = 'main';
        const r = ext === '3dm' ? await load3dm(bytes) : ext === 'ifc' ? await loadIfc(bytes) : await loadMeshFormat(ext, bytes);
        unitNote = r.unitNote;
        const parts = objectToParts(r.object, r.scale);
        if (!parts.length) throw new Error('No triangle meshes found in this file.');
        built = buildMeshModel(parts);
        out = { ms: performance.now() - t1 };
      }
      post({ type: 'stage', stage: 'building' });
      const tb = performance.now();
      if (model) { scene.remove(model); model.traverse((n) => { n.geometry && n.geometry.dispose(); }); }
      const { group, tris, count } = built || buildModel(out.result);
      clearMeasure(); model = group; scene.add(model); partSel = [];
      partTree = built ? partsTreeFlat(group) : partsTreeOCCT(out.result);
      modelR = (new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3()).length() || 1) / 2;
      fitNow();
      applyDisplay(); applyHelpers(); applySize(); section.rebuild();
      post({ type: 'loaded', name: meta.name, size: total, receiveMs: Math.round(tRecv), parseMs: Math.round(out.ms),
        buildMs: Math.round(performance.now() - tb), totalMs: Math.round(performance.now() - meta.t0), parts: partTree, meshes: count, triangles: tris, mode, ext, unitNote, exactFaces: !built });
    } catch (e) {
      const ext = (meta.ext || (meta.name.match(/\.([^.]+)$/) || [])[1] || '').toLowerCase();
      const f = friendlyMessage(ext, e);
      console.error('[load]', meta.name, e);
      post({ type: 'error', message: f.message, detail: f.detail || String(e && e.stack || '').split('\n').slice(0, 2).join(' ') });
    }
  },
  fit,
  /** Parts panel: {visible: bool[] per mesh, select: mesh idx[], fit} */
  parts: setParts,
  _parts: () => ({ tree: partTree, visible: model ? model.children.map((m) => m.visible) : [], sel: partSel, box: (() => { const b = visBox(); return [b.min.toArray(), b.max.toArray()]; })() }),
  /** Where the view cube is, for the Guide overlay */
  guideInfo() { post({ type: 'guideInfo', cube: model && S.showCube ? cubeRect() : null }); },
  /** Save-photo: posts {type:'photo', data, width, height} */
  capture(opts) { try { post({ type: 'photo', ...capturePhoto(opts || {}) }); } catch (e) { post({ type: 'photoError', message: String(e && e.message || e) }); } },
  /** Section view control from RN: {on, axis, t, flip, align} */
  section(p) { if (p.flipToggle) { p.flip = !section.state.flip; delete p.flipToggle; } if (p.align !== undefined) { S.sectionAlign = !!p.align; delete p.align; } if (Object.keys(p).length) section.apply(p); dirty = true; },
  /** Back to exactly how the model opened: iso angle, Z up, centred, initial zoom, pan cleared (smooth glide). */
  resetView() {
    if (!model) return;
    const dir = new THREE.Vector3(1, -1, 0.8).normalize();
    const { center, dist } = fitParams(dir);
    animateTo(dir, new THREE.Vector3(0, 0, 1), center, dist, 450);
    post({ type: 'reset' });
  },
  /** ~256px iso thumbnail of the model -> {type:'thumb', data:'data:image/png;base64,…'} */
  snapshot(px = 256) {
    if (!model) return;
    try {
      const hidden = [];
      scene.children.forEach((c) => { if (c !== model && !c.isLight && c.visible) { c.visible = false; hidden.push(c); } });
      const cam = camera.clone(); const W = window.innerWidth, H = window.innerHeight;
      const box = new THREE.Box3().setFromObject(model); const r = (box.getSize(new THREE.Vector3()).length() || 1) / 2;
      const c = box.getCenter(new THREE.Vector3()), dir = new THREE.Vector3(1, -1, 0.8).normalize();
      const vf = cam.fov * Math.PI / 180, half = Math.min(W, H) / H * Math.tan(vf / 2);
      cam.up.set(0, 0, 1); cam.position.copy(c).addScaledVector(dir, r / Math.sin(Math.atan(half)) * 1.02); cam.lookAt(c);
      cam.near = r / 100; cam.far = r * 100; cam.updateProjectionMatrix();
      renderer.setScissorTest(false); renderer.setViewport(0, 0, W, H);
      renderer.render(scene, cam);
      const out = document.createElement('canvas'); out.width = out.height = px;
      const k = renderer.domElement.width / W, side = Math.min(W, H) * k;
      out.getContext('2d').drawImage(renderer.domElement, (renderer.domElement.width - side) / 2, (renderer.domElement.height - side) / 2, side, side, 0, 0, px, px);
      hidden.forEach((h) => { h.visible = true; }); dirty = true;
      post({ type: 'thumb', data: out.toDataURL('image/png') });
    } catch (e) { console.warn('[thumb]', e); }
  },
  setSettings: applySettings,
  clearMeasure,
  /** delete one kept measurement */
  measureDelete(id) { deleteItem(id); },
  _test: { frame: () => { // render as on screen, then count: red (size box X edges), pixels differing from clear colour in the cube box
    photoRender(); const g = renderer.getContext(), k = renderer.getPixelRatio(), w = g.drawingBufferWidth, h = g.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4); g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px);
    const cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha(); const hx = cc.getHex(), cr = (hx >> 16) & 255, cg = (hx >> 8) & 255, cb = hx & 255;
    const r = cubeRect(); let red = 0, cube = 0, corner = Array.from(px.slice((h - 1) * w * 4, (h - 1) * w * 4 + 4));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4;
      if (px[i] > 200 && px[i + 1] < 110 && px[i + 2] < 110) red++;
      const sx = x / k, sy = (h - 1 - y) / k; if (sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h && (Math.abs(px[i] - cr) > 12 || Math.abs(px[i + 1] - cg) > 12 || Math.abs(px[i + 2] - cb) > 12)) cube++; }
    return { red, cube, corner, clearAlpha: ca, overlay: overlay.style.display }; }, sectionDeco: (v) => section.setDeco(v), section: () => ({ ...section.state, offset: section.offset, normal: section.state.normal.toArray(), handle: section.handleScreen(toScreen) }), pixel: (x, y) => { renderer.render(scene, camera); const g = renderer.getContext(); const px = new Uint8Array(4); const k = renderer.getPixelRatio(); g.readPixels(Math.round(x * k), Math.round(g.drawingBufferHeight - y * k), 1, 1, g.RGBA, g.UNSIGNED_BYTE, px); return Array.from(px); }, place: (dir, up) => { const d = camera.position.distanceTo(target); camera.up.set(...up); camera.position.copy(target).addScaledVector(new THREE.Vector3(...dir).normalize(), d); camera.lookAt(target); spin = null; dirty = true; }, up: () => camera.up.toArray(), rotate: (dx, dy) => rotate(dx, dy), quat: () => camera.quaternion.toArray(), hl: () => scene.children.filter((c) => c.renderOrder === 15).map((c) => c.geometry.attributes.position.count), emissive: () => model.children.map((m) => m.material.emissive ? m.material.emissive.r : 0), capCount: () => { const g = scene.getObjectByName('section-caps'); let n = 0; if (g) g.traverse((c) => { if (c.isMesh && c.material && c.material.stencilWrite && !c.material.colorWrite) n++; }); return n; }, measureTap, hitHandle, toScreen: (a) => toScreen(new THREE.Vector3(...a)), pts, items: () => items.map((it) => ({ ...it.data, id: it.id, n: it.n, kind: it.kind, visible: itemVisible(it), text: itemText(it), shown: it.group.visible && it.el.style.display !== 'none' })), snapAt: (x, y) => { const r = snapAt(x, y); return r && { kind: r.kind, p: r.p.toArray() }; }, features: (i) => { const f = featOf(model.children[i]); return { corners: f.corners, chains: f.chains.map((c) => ({ kind: c.kind, length: c.length, radius: c.radius, center: c.center, a: c.a, b: c.b, mid: c.pts[Math.floor(c.pts.length / 2)], full: c.full })) }; }, snapUI: () => ({ shown: snapEl.style.display !== 'none', kind: snapEl.dataset.k, tag: snapTag.textContent, loupeTag: loupeTag.textContent, loupe: loupe.style.display }), pending: () => pend && pend.type },
  setDisplayMode(m) { S.displayMode = m; applyDisplay(); },
  debug() { return { d: camera.position.distanceTo(target), target: target.toArray(), cam: camera.position.toArray() }; },
};

// warm up the parser right away so the first model opens faster
setTimeout(() => { try { worker = makeWorker(); workerReady.then(() => post({ type: 'parserReady' })).catch(() => { worker = null; }); } catch (e) { worker = null; } }, 0);
post({ type: 'ready' });
