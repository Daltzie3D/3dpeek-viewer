// Edges, corners, circles and arcs of a triangle mesh, for snapping and one-tap edge measures.
// Pure JS (no three.js) so Node tests can check it against STEP files with known geometry.
// A "feature edge" is where two different faces meet (B-rep faces for STEP/IGES, flat/curved regions for meshes),
// or an open boundary. Feature edges are joined into chains between corners (vertices where ≠2 chains meet).
import { eigenSym3, fitCircle2D } from './measure.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const vec = { sub, add, mul, dot, cross, len, norm };

/** Classify a polyline: line, circle (closed), arc, or curve. */
export function classifyChain(pts, closed) {
  let length = 0; for (let i = 1; i < pts.length; i++) length += len(sub(pts[i], pts[i - 1]));
  if (closed) length += len(sub(pts[0], pts[pts.length - 1]));
  const out = { pts, closed, length, kind: 'curve' };
  const a = pts[0], b = pts[pts.length - 1], ab = sub(b, a), L = len(ab);
  if (!closed && L > 0) {
    const d = norm(ab); let dev = 0;
    for (const p of pts) { const v = sub(p, a); dev = Math.max(dev, len(sub(v, mul(d, dot(v, d))))); }
    if (dev <= Math.max(1e-6, L * 1e-4)) return { ...out, kind: 'line', length: L, dir: d, a, b };
  }
  const n = pts.length; if (n < (closed ? 6 : 4)) return out;
  let c = [0, 0, 0]; for (const p of pts) c = add(c, p); c = mul(c, 1 / n);
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) { const q = sub(p, c); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] += q[i] * q[j]; }
  const e = eigenSym3(M), nrm = e.vectors[0], u = e.vectors[2], v = cross(nrm, u);
  const spread = Math.sqrt(e.values[2] / n) || 1;
  if (Math.sqrt(Math.max(0, e.values[0]) / n) > spread * 2e-3) return out; // not planar
  const fit = fitCircle2D(pts.map((p) => { const q = sub(p, c); return [dot(q, u), dot(q, v)]; }));
  if (!fit || fit.maxErr > 0.01 || !isFinite(fit.r)) return out;
  const center = add(c, add(mul(u, fit.cx), mul(v, fit.cy)));
  if (closed) return { ...out, kind: 'circle', center, radius: fit.r, normal: nrm, length: 2 * Math.PI * fit.r };
  // arc: sweep from the polyline's turning
  let sweep = 0; for (let i = 1; i < n; i++) { const p0 = sub(pts[i - 1], center), p1 = sub(pts[i], center); sweep += Math.atan2(len(cross(p0, p1)), dot(p0, p1)); }
  if (sweep < 0.2) return out;
  return { ...out, kind: 'arc', center, radius: fit.r, normal: nrm, sweepDeg: sweep * 180 / Math.PI, length: fit.r * sweep };
}

/**
 * pos: flat positions, idx: flat triangle indices, faces: [{first,last}] triangle ranges (one per face/region).
 * Returns { corners: [[x,y,z]], chains: [classifyChain…] }.
 */
export function extractFeatures(pos, idx, faces, tol = 1e-4) {
  const nT = idx.length / 3, fid = new Int32Array(nT).fill(-1);
  (faces || []).forEach((f, k) => { for (let t = f.first; t <= f.last; t++) fid[t] = k; });
  for (let t = 0; t < nT; t++) if (fid[t] < 0) fid[t] = -2 - t; // triangles without a face: each its own
  // weld vertices by position
  const keyOf = new Map(), kp = [], vk = new Int32Array(pos.length / 3);
  const q = 1 / tol;
  for (let i = 0; i < vk.length; i++) {
    const k = `${Math.round(pos[3 * i] * q)},${Math.round(pos[3 * i + 1] * q)},${Math.round(pos[3 * i + 2] * q)}`;
    let id = keyOf.get(k); if (id === undefined) { id = kp.length; keyOf.set(k, id); kp.push([pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]]); }
    vk[i] = id;
  }
  const edges = new Map(); // "a|b" -> [faceIdA, faceIdB?, count]
  for (let t = 0; t < nT; t++) {
    const v = [vk[idx[3 * t]], vk[idx[3 * t + 1]], vk[idx[3 * t + 2]]];
    for (let j = 0; j < 3; j++) {
      let a = v[j], b = v[(j + 1) % 3]; if (a === b) continue; if (a > b) [a, b] = [b, a];
      const k = a * 4294967296 + b; const e = edges.get(k);
      if (!e) edges.set(k, { a, b, f: [fid[t]], n: 1 }); else { e.n++; if (!e.f.includes(fid[t])) e.f.push(fid[t]); }
    }
  }
  const adj = new Map(); const addAdj = (a, b) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); };
  for (const e of edges.values()) if (e.f.length > 1 || e.n === 1) { addAdj(e.a, e.b); addAdj(e.b, e.a); }
  const used = new Set(), ek = (a, b) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);
  const corners = [...adj.keys()].filter((v) => adj.get(v).length !== 2);
  const chains = [];
  const walk = (start, next) => {
    const path = [start]; let prev = start, cur = next; used.add(ek(start, next));
    while (true) {
      path.push(cur); if (adj.get(cur).length !== 2 || cur === start) break;
      const nx = adj.get(cur).find((w) => w !== prev && !used.has(ek(cur, w)));
      if (nx === undefined) break; used.add(ek(cur, nx)); prev = cur; cur = nx;
    }
    return path;
  };
  for (const c of corners) for (const n of adj.get(c)) if (!used.has(ek(c, n))) chains.push({ ids: walk(c, n), closed: false });
  for (const v of adj.keys()) for (const n of adj.get(v)) if (!used.has(ek(v, n))) { const ids = walk(v, n); if (ids[ids.length - 1] === ids[0]) ids.pop(); chains.push({ ids, closed: true }); }
  const out = [];
  for (const ch of chains) { const pts = ch.ids.map((i) => kp[i]); if (pts.length >= 2) out.push(classifyChain(pts, ch.closed)); }
  // arcs on the same circle (CAD splits round edges at the seam): mark them as a full circle when they add up to 360°
  const arcs = out.filter((c) => c.kind === 'arc');
  for (const c of arcs) {
    if (c.full !== undefined) continue;
    const grp = arcs.filter((d) => len(sub(d.center, c.center)) < c.radius * 1e-3 && Math.abs(d.radius - c.radius) < c.radius * 1e-3 && Math.abs(dot(d.normal, c.normal)) > 0.9999);
    const sum = grp.reduce((t, d) => t + d.sweepDeg, 0);
    for (const d of grp) d.full = sum > 355;
  }
  // corners also where a chain turns sharply (open boundary of a single face etc.) — chain ends are corners
  const cs = new Map(); for (const c of out) if (!c.closed) for (const p of [c.pts[0], c.pts[c.pts.length - 1]]) cs.set(p.join(), p);
  return { corners: [...cs.values()], chains: out };
}

/** Angle in degrees between two directions/normals, as lines (0..90) */
export const lineAngle = (d1, d2) => Math.acos(Math.min(1, Math.abs(dot(norm(d1), norm(d2))))) * 180 / Math.PI;
/** Angle between two planes given by normals: 0..90 (and the face-to-face angle 180 - between normals is reported by the caller) */
export function planeRelation(n1, p1, n2, p2) {
  const c = dot(norm(n1), norm(n2));
  const parallel = Math.abs(c) > Math.cos(0.05 * Math.PI / 180);
  return { parallel, distance: parallel ? Math.abs(dot(norm(n1), sub(p2, p1))) : null, angle: lineAngle(n1, n2), normalsDeg: Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI };
}
/** line vs plane: angle between the edge and the face (0 = lying in it, 90 = square to it) */
export const linePlaneAngle = (d, n) => 90 - lineAngle(d, n);
