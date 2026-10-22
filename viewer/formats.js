// File-format support for the viewer. Everything is bundled (offline); 3DM and IFC need big WASM libraries that are
// loaded on demand (see needLib in viewer.js).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { AMFLoader } from 'three/examples/jsm/loaders/AMFLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { VRMLLoader } from 'three/examples/jsm/loaders/VRMLLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { unzipSync, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js';
import { parse3MF, Friendly3MFError } from './threemf.js';

/** Error with a message meant for people; `detail` keeps the technical reason for logs. */
export class FriendlyError extends Error { constructor(msg, cause) { super(msg); this.friendly = true; this.detail = cause ? String(cause && cause.message || cause) : ''; } }
export function friendlyMessage(ext, e) {
  if (e && (e.friendly || e instanceof Friendly3MFError)) return { message: e.message, detail: e.detail || '' };
  const raw = String(e && e.message || e);
  if (/^(This|No |Could not|Unsupported)/.test(raw)) return { message: raw, detail: '' }; // already written for people
  const E = (ext || '').toUpperCase();
  let message = `This ${E} file uses a feature I can't read yet, or it is damaged.`;
  if (/memory|allocation|RangeError|Invalid array length/i.test(raw)) message = `This ${E} file is too big for the phone's memory.`;
  else if (/JSON|Unexpected token/i.test(raw)) message = `This ${E} file isn't valid (it could not be read as text data).`;
  return { message, detail: raw };
}
export const OCCT_FORMATS = { step: 'step', stp: 'step', iges: 'iges', igs: 'iges', brep: 'brep', brp: 'brep' };
export const ALL_EXTS = ['step', 'stp', 'iges', 'igs', 'brep', 'brp', 'fcstd', 'obj', 'stl', 'gltf', 'glb', 'fbx', '3dm', '3ds', 'amf', '3mf', 'bim', 'dae', 'ifc', 'off', 'ply', 'wrl', 'vrml'];

// No external files exist next to a picked file: answer every texture/resource request with a 1x1 pixel.
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const manager = new THREE.LoadingManager();
manager.setURLModifier((url) => (url.startsWith('data:') || url.startsWith('blob:') ? url : PIXEL));

const text = (b) => new TextDecoder().decode(b);
const buf = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const meshOf = (geometry, color = 0x9aa7b8) => new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color }));

/** Parse a mesh-type file into a three.js object. Returns { object, scale (file units -> mm), unitNote }. */
const yUp = (o) => { const g = new THREE.Group(); g.add(o); g.rotation.x = Math.PI / 2; return g; }; // Y-up file -> Z-up viewer
export async function loadMeshFormat(ext, bytes) {
  const M = (s) => ({ scale: 1000, unitNote: s || 'file units are metres' });
  const MM = { scale: 1, unitNote: 'file has no units, assumed mm' };
  switch (ext) {
    case 'stl': return { object: meshOf(new STLLoader(manager).parse(buf(bytes))), ...MM };
    case 'ply': return { object: meshOf(new PLYLoader(manager).parse(buf(bytes))), ...MM };
    case 'obj': return { object: yUp(new OBJLoader(manager).parse(text(bytes))), unitNote: 'OBJ has no units, assumed mm (Y-up)', scale: 1 };
    case 'off': return { object: meshOf(parseOff(text(bytes))), ...MM };
    case '3ds': return { object: new TDSLoader(manager).parse(buf(bytes), ''), ...MM };
    case 'fbx': return { object: yUp(new FBXLoader(manager).parse(buf(bytes), '')), scale: 10, unitNote: 'FBX units are cm' };
    case 'amf': return { object: new AMFLoader(manager).parse(buf(bytes)), scale: 1, unitNote: 'AMF, mm' };
    case '3mf': {
      try { return parse3MF(bytes); }
      catch (e) {
        console.warn('[3mf] own parser failed, trying three.js 3MFLoader:', e);
        try { return { object: new ThreeMFLoader(manager).parse(buf(bytes)), scale: 1, unitNote: '3MF (fallback reader), assumed mm' }; }
        catch (e2) { console.warn('[3mf] 3MFLoader failed too:', e2); throw e instanceof Friendly3MFError ? e : new FriendlyError("This 3MF uses a feature I can't read yet.", e); }
      }
    }
    case 'dae': return { object: yUp(new ColladaLoader(manager).parse(text(bytes), '').scene), ...M('Collada, converted from metres') };
    case 'wrl': case 'vrml': return { object: yUp(new VRMLLoader(manager).parse(text(bytes), '')), ...M('VRML units are metres') };
    case 'gltf': case 'glb': {
      const loader = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);
      const data = ext === 'glb' || (bytes[0] === 0x67 && bytes[1] === 0x6c) ? buf(bytes) : text(bytes);
      if (typeof data === 'string') {
        const j = JSON.parse(data);
        const ext = [...(j.buffers || []), ...(j.images || [])].filter((x) => x.uri && !x.uri.startsWith('data:'));
        if ((j.buffers || []).some((x) => x.uri && !x.uri.startsWith('data:')))
          throw new Error(`This .gltf keeps its data in separate files (${ext.map((x) => x.uri).slice(0, 2).join(', ')}). Only one file can be opened on the phone — export as .glb or "glTF embedded" instead.`);
      }
      const gltf = await new Promise((res, rej) => loader.parse(data, '', res, rej));
      // glTF is Y-up; the viewer is Z-up
      const g = new THREE.Group(); g.add(gltf.scene); g.rotation.x = Math.PI / 2;
      return { object: g, ...M('glTF units are metres') };
    }
    case 'bim': return { object: parseBim(text(bytes)), ...M('dotbim units are metres') };
  }
  throw new Error(`Unsupported format .${ext}`);
}

/** OFF: "OFF / nv nf ne / vertices / faces (n i0 i1 ...)" — polygons are fanned into triangles. */
export function parseOff(src) {
  // line-based: each face line is "n i0 … i(n-1) [colour]"; anything after the indices (colours) is ignored
  const lines = src.split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  let li = 0; let head = lines[li++].split(/\s+/);
  if (!/OFF$/i.test(head[0])) throw new Error('Not an OFF file');
  const hasColor = /^C/i.test(head[0]);
  let counts = head.length > 1 ? head.slice(1) : lines[li++].split(/\s+/);
  const nv = +counts[0], nf = +counts[1];
  const pos = new Float32Array(nv * 3);
  for (let v = 0; v < nv; v++) { const t = lines[li++].split(/\s+/); pos[3 * v] = +t[0]; pos[3 * v + 1] = +t[1]; pos[3 * v + 2] = +t[2]; }
  void hasColor;
  const idx = [];
  for (let f = 0; f < nf && li < lines.length; f++) {
    const t = lines[li++].split(/\s+/).map(Number); const n = t[0];
    for (let k = 2; k < n; k++) idx.push(t[1], t[k], t[k + 1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(idx);
  return g;
}

/** dotbim (.bim): JSON with shared meshes and placed elements. https://dotbim.net */
export function parseBim(src) {
  const j = JSON.parse(src); const group = new THREE.Group();
  const meshes = new Map(j.meshes.map((m) => [m.mesh_id, m]));
  for (const e of j.elements) {
    const m = meshes.get(e.mesh_id); if (!m) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(m.coordinates, 3)); g.setIndex(m.indices);
    const c = e.color ? new THREE.Color(e.color.r / 255, e.color.g / 255, e.color.b / 255) : new THREE.Color(0x9aa7b8);
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: c }));
    if (e.rotation) mesh.quaternion.set(e.rotation.qx, e.rotation.qy, e.rotation.qz, e.rotation.qw);
    if (e.vector) mesh.position.set(e.vector.x, e.vector.y, e.vector.z);
    mesh.name = e.type || ''; group.add(mesh);
  }
  return group;
}

/** FreeCAD .FCStd: a zip with Document.xml (objects -> BRep file names) and GuiDocument.xml (visibility). */
export function fcstdBrepFiles(bytes) {
  const z = unzipSync(bytes);
  const doc = new DOMParser().parseFromString(strFromU8(z['Document.xml']), 'text/xml');
  const gui = z['GuiDocument.xml'] ? new DOMParser().parseFromString(strFromU8(z['GuiDocument.xml']), 'text/xml') : null;
  const visible = new Map();
  if (gui) for (const vp of gui.querySelectorAll('ViewProvider')) {
    const p = [...vp.querySelectorAll('Property')].find((q) => q.getAttribute('name') === 'Visibility');
    const b = p && p.querySelector('Bool'); if (b) visible.set(vp.getAttribute('name'), b.getAttribute('value') === 'true');
  }
  const out = [];
  for (const o of doc.querySelectorAll('ObjectData > Object')) {
    const name = o.getAttribute('name');
    if (gui && visible.get(name) === false) continue;
    const shape = [...o.querySelectorAll('Property')].find((q) => q.getAttribute('name') === 'Shape' && /PartShape/.test(q.getAttribute('type') || ''));
    const part = shape && shape.querySelector('Part'); const file = part && part.getAttribute('file');
    if (file && z[file] && z[file].length) out.push({ name, bytes: z[file] });
  }
  if (!out.length) for (const [k, v] of Object.entries(z)) if (/\.brp$/i.test(k) && v.length) out.push({ name: k, bytes: v });
  return out;
}
