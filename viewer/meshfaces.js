// Turns arbitrary three.js meshes (from STL/OBJ/glTF/… loaders) into viewer parts with approximate "faces":
// triangles are grouped into flat regions (coplanar, < 0.5°) and smooth curved regions (facets < 20° apart),
// so Face measure works on plain meshes too (results marked ≈).
import * as THREE from 'three';
import { mergeVertices, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export function objectToParts(object, scale = 1) {
  object.updateMatrixWorld(true);
  const S = new THREE.Matrix4().makeScale(scale, scale, scale);
  const parts = [];
  object.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    const src = o.geometry.attributes.position, n = src.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[3 * i] = src.getX(i); arr[3 * i + 1] = src.getY(i); arr[3 * i + 2] = src.getZ(i); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    if (o.geometry.index) g.setIndex(Array.from(o.geometry.index.array));
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(S, o.matrixWorld));
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    const color = mat && mat.color ? mat.color.clone() : new THREE.Color(0x9aa7b8);
    if (color.r + color.g + color.b < 0.25) color.setRGB(0.32, 0.35, 0.4); // near-black would vanish on dark backgrounds
    const p = buildPart(g, color, o.name || (o.parent && o.parent.name) || '');
    if (p) parts.push(p);
  });
  return parts;
}

function buildPart(geometry, color, name) {
  const g = mergeVertices(geometry, 1e-4);
  const pos = g.attributes.position.array, nV = g.attributes.position.count;
  const index = g.index ? g.index.array : null; if (!index || index.length < 3) return null;
  const nT = index.length / 3;
  const nrm = new Float32Array(nT * 3), dd = new Float64Array(nT);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (let t = 0; t < nT; t++) {
    a.fromArray(pos, 3 * index[3 * t]); b.fromArray(pos, 3 * index[3 * t + 1]); c.fromArray(pos, 3 * index[3 * t + 2]);
    e1.subVectors(b, a); e2.subVectors(c, a); e1.cross(e2); const l = e1.length();
    if (l > 0) e1.divideScalar(l);
    nrm[3 * t] = e1.x; nrm[3 * t + 1] = e1.y; nrm[3 * t + 2] = e1.z; dd[t] = e1.dot(a);
  }
  // union-find over triangles
  const parent = new Int32Array(nT); for (let t = 0; t < nT; t++) parent[t] = t;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (x, y) => { x = find(x); y = find(y); if (x !== y) parent[y] = x; };
  const edges = new Map(); // edge key -> first triangle
  const pairs = [];
  for (let t = 0; t < nT; t++) for (let k = 0; k < 3; k++) {
    const i = index[3 * t + k], j = index[3 * t + (k + 1) % 3];
    const key = i < j ? i * nV + j : j * nV + i;
    const o = edges.get(key);
    if (o === undefined) edges.set(key, t); else pairs.push(o, t);
  }
  const dot = (s, t) => nrm[3 * s] * nrm[3 * t] + nrm[3 * s + 1] * nrm[3 * t + 1] + nrm[3 * s + 2] * nrm[3 * t + 2];
  const box = new THREE.Box3().setFromBufferAttribute(g.attributes.position); const tol = (box.getSize(new THREE.Vector3()).length() || 1) * 1e-5;
  // pass 1: flat regions
  for (let k = 0; k < pairs.length; k += 2) { const s = pairs[k], t = pairs[k + 1]; if (dot(s, t) > 0.99996 && Math.abs(dd[s] - dd[t]) < tol) union(s, t); }
  const size = new Int32Array(nT); for (let t = 0; t < nT; t++) size[find(t)]++;
  const small = new Uint8Array(nT); for (let t = 0; t < nT; t++) small[t] = size[find(t)] <= 2 ? 1 : 0;
  // pass 2: smooth curved regions out of small facets (cylinders, fillets, spheres)
  for (let k = 0; k < pairs.length; k += 2) { const s = pairs[k], t = pairs[k + 1]; if (small[s] && small[t] && dot(s, t) > 0.94) union(s, t); }
  // order triangles by region so each region is a contiguous [first, last] range
  const groups = new Map();
  for (let t = 0; t < nT; t++) { const r = find(t); (groups.get(r) || groups.set(r, []).get(r)).push(t); }
  const idx = new Uint32Array(nT * 3), faces = []; let o = 0;
  for (const tris of groups.values()) {
    const first = o / 3;
    for (const t of tris) { idx[o++] = index[3 * t]; idx[o++] = index[3 * t + 1]; idx[o++] = index[3 * t + 2]; }
    faces.push({ first, last: o / 3 - 1 });
  }
  const ordered = new THREE.BufferGeometry(); ordered.setAttribute('position', g.attributes.position); ordered.setIndex(new THREE.BufferAttribute(idx, 1));
  const renderGeo = toCreasedNormals(ordered, Math.PI / 6); // non-indexed, same triangle order
  return { renderGeo, pos, idx, nrm: null, faces, color, name, mesh: true, tris: nT };
}
