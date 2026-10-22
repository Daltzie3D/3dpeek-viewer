// Section view: one clipping plane on the model + stencil-buffer caps so the cut looks solid,
// a translucent plane outline and an on-screen arrow handle to drag the plane along its normal.
import * as THREE from 'three';

export const CAP_COLOR = 0xF08A24;
const CUT = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
export const clipPlanes = [CUT];
const AX = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const AX_COL = { x: 0xE5484D, y: 0x3FB950, z: 0x4F8CFF };

/**
 * state: { on, axis: 'x'|'y'|'z'|'custom', normal (custom), t: 0..1 position through the model, flip }
 * The kept side is the one *behind* the plane's normal (n·p <= offset); flip keeps the other side.
 */
export function createSection({ scene, renderer, getModel, getCamera, onChange }) {
  renderer.localClippingEnabled = true;
  const st = { on: false, axis: 'x', normal: new THREE.Vector3(1, 0, 0), t: 0.5, flip: false };
  let capGroup = null, deco = null, range = [0, 1], center = new THREE.Vector3(), size = 1, offset = 0;

  const dirN = () => (st.axis === 'custom' ? st.normal.clone() : AX[st.axis].clone());

  function setMaterialsClip(on) {
    const m = getModel(); if (!m) return;
    m.traverse((n) => {
      if (!n.material || n.userData.isSectionPart) return;
      n.material.clippingPlanes = on ? clipPlanes : null; n.material.needsUpdate = true;
    });
  }
  function disposeCaps() {
    for (const g of [capGroup, deco]) if (g) { scene.remove(g); g.traverse((n) => { if (n.isMesh || n.isLine) { if (!n.userData.sharedGeo) n.geometry.dispose(); n.material.dispose(); } }); }
    capGroup = deco = null;
  }
  function buildCaps() {
    disposeCaps();
    const m = getModel(); if (!m || !st.on) return;
    capGroup = new THREE.Group(); capGroup.name = 'section-caps';
    // stencil: back faces +1, front faces -1 -> non-zero exactly where the plane cuts through a solid
    const base = { depthWrite: false, depthTest: false, colorWrite: false, stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, clippingPlanes: clipPlanes };
    const back = new THREE.MeshBasicMaterial({ ...base, side: THREE.BackSide, stencilFail: THREE.IncrementWrapStencilOp, stencilZFail: THREE.IncrementWrapStencilOp, stencilZPass: THREE.IncrementWrapStencilOp });
    const front = new THREE.MeshBasicMaterial({ ...base, side: THREE.FrontSide, stencilFail: THREE.DecrementWrapStencilOp, stencilZFail: THREE.DecrementWrapStencilOp, stencilZPass: THREE.DecrementWrapStencilOp });
    m.updateMatrixWorld(true);
    m.traverse((n) => {
      if (!n.isMesh || n.userData.isSectionPart || !n.visible || (n.parent && !n.parent.visible)) return;
      for (const mat of [back, front]) {
        const s = new THREE.Mesh(n.geometry, mat); s.matrixAutoUpdate = false; s.matrix.copy(n.matrixWorld);
        s.renderOrder = 1; s.userData.isSectionPart = true; s.userData.sharedGeo = true; capGroup.add(s);
      }
    });
    const capMat = new THREE.MeshStandardMaterial({ color: CAP_COLOR, emissive: CAP_COLOR, emissiveIntensity: 0.55, metalness: 0, roughness: 0.8, side: THREE.DoubleSide,
      stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp });
    const cap = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), capMat);
    cap.name = 'cap'; cap.renderOrder = 2; cap.userData.isSectionPart = true;
    cap.onAfterRender = (r) => r.clearStencil();
    capGroup.add(cap);
    scene.add(capGroup);
    // decoration: translucent plane + outline + arrow handle (not clipped)
    deco = new THREE.Group(); deco.name = 'section-deco';
    const col = st.axis === 'custom' ? 0xF08A24 : AX_COL[st.axis];
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.10, side: THREE.DoubleSide, depthWrite: false }));
    quad.renderOrder = 3; quad.userData.isSectionPart = true;
    const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([[-.5, -.5], [.5, -.5], [.5, .5], [-.5, .5]].map(([x, y]) => new THREE.Vector3(x, y, 0))),
      new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.8, depthTest: false }));
    outline.renderOrder = 4; outline.userData.isSectionPart = true;
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 1, col, 0.3, 0.18);
    arrow.traverse((n) => { if (n.material) { n.material.depthTest = false; n.material.transparent = true; } n.renderOrder = 5; n.userData.isSectionPart = true; });
    arrow.name = 'arrow';
    deco.add(quad, outline, arrow); deco.userData.parts = { quad, outline, arrow, cap };
    scene.add(deco);
    place();
  }
  function measureRange() {
    const m = getModel(); if (!m) return;
    const box = window.__pcVisBox ? window.__pcVisBox() : new THREE.Box3().setFromObject(m); center = box.getCenter(new THREE.Vector3()); size = box.getSize(new THREE.Vector3()).length() || 1;
    const n = dirN(); let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 8; i++) { const p = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z); const d = n.dot(p); lo = Math.min(lo, d); hi = Math.max(hi, d); }
    range = [lo, hi];
  }
  function place() {
    const n = dirN();
    offset = range[0] + (range[1] - range[0]) * st.t;
    // keep n·p <= offset (or >= when flipped):  plane.normal·p + constant >= 0 is kept
    if (st.flip) CUT.set(n.clone(), -offset); else CUT.set(n.clone().negate(), offset);
    if (deco) {
      const { quad, outline, arrow, cap } = deco.userData.parts;
      const origin = n.clone().multiplyScalar(offset).add(center.clone().sub(n.clone().multiplyScalar(n.dot(center))));
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      for (const o of [quad, outline, cap]) { o.position.copy(origin); o.quaternion.copy(q); o.scale.setScalar(o === cap ? size * 4 : size * 1.05); }
      const showDir = st.flip ? n : n.clone().negate(); // arrow points at the removed side
      arrow.position.copy(origin); arrow.setDirection(showDir.clone().negate()); arrow.setLength(size * 0.28, size * 0.08, size * 0.05);
    }
    onChange && onChange({ offset, t: st.t, axis: st.axis, flip: st.flip, on: st.on });
  }
  function apply(p = {}) {
    const prevOn = st.on, prevAxis = st.axis;
    if (p.normal) st.normal.fromArray(p.normal).normalize();
    for (const k of ['on', 'axis', 't', 'flip']) if (p[k] !== undefined) st[k] = p[k];
    st.t = Math.min(1, Math.max(0, st.t));
    setMaterialsClip(st.on);
    if (!st.on) { disposeCaps(); onChange && onChange({ on: false }); return; }
    measureRange();
    // like CAD apps: when turning on / changing axis, cut away the half that faces the viewer (unless flip was given)
    if ((p.on && !prevOn || (p.axis && p.axis !== prevAxis) || p.normal) && p.flip === undefined && getCamera) {
      const toCam = getCamera().position.clone().sub(center); st.flip = dirN().dot(toCam) < 0;
    }
    if (!capGroup || prevOn !== st.on || prevAxis !== st.axis || p.normal || p.rebuild) buildCaps(); else place();
  }
  /** keep only hits on the visible side of the cut */
  function kept(point) { return !st.on || CUT.distanceToPoint(point) >= -1e-6 * size; }
  /** screen-space arrow handle */
  function handleScreen(toScreen) {
    if (!st.on || !deco) return null;
    const { arrow } = deco.userData.parts;
    const a = toScreen(arrow.position.clone()), b = toScreen(arrow.position.clone().add(dirN().multiplyScalar(size * 0.28 * (st.flip ? 1 : -1))));
    return { a, b };
  }
  /** drag: move by the screen-projected component along the normal */
  function dragBy(dxPx, dyPx, toScreen) {
    const h = handleScreen(toScreen); if (!h) return;
    // screen vector for +t (normal direction)
    const p0 = toScreen(deco.userData.parts.arrow.position.clone()), p1 = toScreen(deco.userData.parts.arrow.position.clone().add(dirN().multiplyScalar(size * 0.1)));
    const vx = p1[0] - p0[0], vy = p1[1] - p0[1], L2 = vx * vx + vy * vy; if (L2 < 1) return;
    const worldPerPx = (size * 0.1) / Math.sqrt(L2);
    const dWorld = ((dxPx * vx + dyPx * vy) / Math.sqrt(L2)) * worldPerPx;
    const span = (range[1] - range[0]) || 1;
    st.t = Math.min(1, Math.max(0, st.t + dWorld / span)); place();
  }
  return { setDeco: (v) => { if (deco) deco.visible = v; }, apply, kept, handleScreen, dragBy, state: st, get offset() { return offset; }, rebuild: () => st.on && apply({ rebuild: true }), dirN };
}
