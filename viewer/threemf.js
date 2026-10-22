// Own 3MF reader: core spec + production extension (components in other .model files via p:path, nested
// components, build-item transforms), base materials / colour groups for colours; other extensions
// (Bambu/Prusa metadata, slices, beam lattices, paint data) are ignored.
import * as THREE from 'three';
import { unzipSync, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js';

const UNIT_MM = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };
const PROD_NS = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const norm = (p) => p.replace(/^\/+/, '').replace(/\\/g, '/');
const kids = (el, name) => [...el.children].filter((c) => c.localName === name);
const kid = (el, name) => [...el.children].find((c) => c.localName === name);
const pAttr = (el, name) => el.getAttributeNS(PROD_NS, name) || el.getAttribute('p:' + name) || '';

/** "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32" (row vectors: p' = p·M) -> THREE.Matrix4 */
function matrix(t) {
  const m = new THREE.Matrix4();
  if (!t) return m;
  const v = t.trim().split(/\s+/).map(Number);
  if (v.length !== 12 || v.some((x) => !isFinite(x))) return m;
  m.set(v[0], v[3], v[6], v[9], v[1], v[4], v[7], v[10], v[2], v[5], v[8], v[11], 0, 0, 0, 1);
  return m;
}
function hexColor(s) {
  const m = /^#?([0-9a-f]{6})/i.exec(s || ''); return m ? new THREE.Color('#' + m[1]) : null;
}

export class Friendly3MFError extends Error {}

export function parse3MF(bytes) {
  let zip;
  try { zip = unzipSync(bytes); } catch (e) { throw new Friendly3MFError('This 3MF file is damaged (it is not a valid zip).'); }
  const files = {}; for (const k of Object.keys(zip)) files[norm(k)] = zip[k];
  // root model from _rels/.rels, else the usual location, else any .model file
  let root = '3D/3dmodel.model';
  if (files['_rels/.rels']) {
    const rels = new DOMParser().parseFromString(strFromU8(files['_rels/.rels']), 'application/xml');
    for (const r of rels.getElementsByTagName('Relationship')) if (/3dmodel$/.test(r.getAttribute('Type') || '')) root = norm(r.getAttribute('Target') || root);
  }
  if (!files[root]) root = Object.keys(files).find((k) => /\.model$/i.test(k));
  if (!root) throw new Friendly3MFError('This 3MF file has no 3D model inside.');

  const models = new Map();
  const model = (path) => {
    path = norm(path);
    if (models.has(path)) return models.get(path);
    if (!files[path]) throw new Friendly3MFError(`This 3MF refers to a part file that is missing (${path}).`);
    const doc = new DOMParser().parseFromString(strFromU8(files[path]), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Friendly3MFError(`This 3MF has a damaged part file (${path}).`);
    const el = doc.documentElement;
    const objects = new Map(), colors = new Map();
    const res = kid(el, 'resources');
    if (res) for (const r of res.children) {
      if (r.localName === 'basematerials') colors.set(r.getAttribute('id'), kids(r, 'base').map((b) => hexColor(b.getAttribute('displaycolor'))));
      else if (r.localName === 'colorgroup') colors.set(r.getAttribute('id'), kids(r, 'color').map((c) => hexColor(c.getAttribute('color'))));
      else if (r.localName === 'object') objects.set(r.getAttribute('id'), r);
    }
    const m = { path, el, objects, colors, unit: el.getAttribute('unit') || 'millimeter' };
    models.set(path, m); return m;
  };

  const rootModel = model(root);
  const scale = UNIT_MM[rootModel.unit] ?? 1;
  const group = new THREE.Group();
  let triangles = 0;
  const meshCache = new Map();

  function meshGeometry(m, obj) {
    const key = m.path + '#' + obj.getAttribute('id');
    if (meshCache.has(key)) return meshCache.get(key);
    const mesh = kid(obj, 'mesh');
    const vs = mesh && kid(mesh, 'vertices'), ts = mesh && kid(mesh, 'triangles');
    if (!vs || !ts) return null;
    const vEls = vs.children, tEls = ts.children;
    const pos = new Float32Array(vEls.length * 3);
    for (let i = 0; i < vEls.length; i++) { const v = vEls[i]; pos[3 * i] = +v.getAttribute('x'); pos[3 * i + 1] = +v.getAttribute('y'); pos[3 * i + 2] = +v.getAttribute('z'); }
    const idx = new Uint32Array(tEls.length * 3); let n = 0;
    for (let i = 0; i < tEls.length; i++) {
      const t = tEls[i]; const a = +t.getAttribute('v1'), b = +t.getAttribute('v2'), c = +t.getAttribute('v3');
      if (a < vEls.length && b < vEls.length && c < vEls.length) { idx[n++] = a; idx[n++] = b; idx[n++] = c; }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(new THREE.BufferAttribute(idx.subarray(0, n), 1));
    meshCache.set(key, g); return g;
  }
  function objColor(m, obj) {
    const pid = obj.getAttribute('pid'); const list = pid && m.colors.get(pid);
    return (list && list[+(obj.getAttribute('pindex') || 0)]) || null;
  }
  function place(m, id, mat, depth, inherited) {
    if (depth > 32) throw new Friendly3MFError('This 3MF has components nested too deeply (or in a loop).');
    const obj = m.objects.get(id);
    if (!obj) throw new Friendly3MFError(`This 3MF refers to an object that does not exist (id ${id} in ${m.path}).`);
    const type = obj.getAttribute('type') || 'model';
    if (type === 'support' || type === 'solidsupport' || type === 'other') return; // not part of the printed model
    const color = objColor(m, obj) || inherited;
    const g = meshGeometry(m, obj);
    if (g) {
      const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: color || 0x9aa7b8 }));
      mesh.applyMatrix4(mat); mesh.name = obj.getAttribute('name') || ''; group.add(mesh);
      triangles += g.index.count / 3;
    }
    const comps = kid(obj, 'components');
    if (comps) for (const c of kids(comps, 'component')) {
      const path = pAttr(c, 'path');
      const cm = path ? model(path) : m;
      place(cm, c.getAttribute('objectid'), mat.clone().multiply(matrix(c.getAttribute('transform'))), depth + 1, color);
    }
  }
  const build = kid(rootModel.el, 'build');
  if (!build) throw new Friendly3MFError('This 3MF has no build plate items.');
  for (const item of kids(build, 'item')) {
    const path = pAttr(item, 'path');
    place(path ? model(path) : rootModel, item.getAttribute('objectid'), matrix(item.getAttribute('transform')), 0, null);
  }
  if (!group.children.length) throw new Friendly3MFError('This 3MF contains no printable meshes.');
  const unitNames = { micron: 'µm', millimeter: 'mm', centimeter: 'cm', inch: 'inches', foot: 'feet', meter: 'metres' };
  return { object: group, scale, triangles, unitNote: `3MF units: ${unitNames[rootModel.unit] || rootModel.unit}` };
}
