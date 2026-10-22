// Pure geometry helpers for measuring (no three.js), shared by the viewer and Node tests.
// Model coordinates are millimetres (OpenCASCADE / occt-import-js output).

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Symmetric 3x3 eigen-decomposition (Jacobi). Returns { values, vectors } sorted ascending; vectors[i] is a unit vector. */
export function eigenSym3(m) {
  const a = m.map((r) => r.slice()), v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let it = 0; it < 50; it++) {
    let p = 0, q = 1, max = Math.abs(a[0][1]);
    if (Math.abs(a[0][2]) > max) { p = 0; q = 2; max = Math.abs(a[0][2]); }
    if (Math.abs(a[1][2]) > max) { p = 1; q = 2; max = Math.abs(a[1][2]); }
    if (max < 1e-12) break;
    const th = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]), c = Math.cos(th), s = Math.sin(th);
    for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
    for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
    for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
  }
  const out = [0, 1, 2].map((i) => ({ value: a[i][i], vector: norm([v[0][i], v[1][i], v[2][i]]) }));
  out.sort((x, y) => x.value - y.value);
  return { values: out.map((o) => o.value), vectors: out.map((o) => o.vector) };
}

/** Least-squares circle through 2D points (Kåsa). Returns { cx, cy, r, maxErr } (maxErr relative to r). */
export function fitCircle2D(pts) {
  let sx = 0, sy = 0; for (const [x, y] of pts) { sx += x; sy += y; }
  const mx = sx / pts.length, my = sy / pts.length;
  let Suu = 0, Svv = 0, Suv = 0, Suuu = 0, Svvv = 0, Suvv = 0, Svuu = 0;
  for (const [x, y] of pts) { const u = x - mx, v = y - my; Suu += u * u; Svv += v * v; Suv += u * v; Suuu += u * u * u; Svvv += v * v * v; Suvv += u * v * v; Svuu += v * u * u; }
  const det = Suu * Svv - Suv * Suv;
  if (Math.abs(det) < 1e-18) return null;
  const b1 = 0.5 * (Suuu + Suvv), b2 = 0.5 * (Svvv + Svuu);
  const uc = (b1 * Svv - b2 * Suv) / det, vc = (Suu * b2 - Suv * b1) / det;
  const cx = uc + mx, cy = vc + my, r = Math.sqrt(uc * uc + vc * vc + (Suu + Svv) / pts.length);
  let maxErr = 0; for (const [x, y] of pts) maxErr = Math.max(maxErr, Math.abs(Math.hypot(x - cx, y - cy) - r));
  // angular coverage (to tell full circles from arcs)
  const ang = [...new Set(pts.map(([x, y]) => Math.round(Math.atan2(y - cy, x - cx) * 1e6) / 1e6))].sort((p, q) => p - q);
  let gap = 2 * Math.PI - (ang[ang.length - 1] - ang[0]);
  for (let i = 1; i < ang.length; i++) gap = Math.max(gap, ang[i] - ang[i - 1]);
  // a closed circle: the largest gap is just one tessellation step
  const full = ang.length >= 6 && gap < 1.6 * (2 * Math.PI / ang.length);
  return { cx, cy, r, maxErr: maxErr / r, coverageDeg: full ? 360 : (2 * Math.PI - gap) * 180 / Math.PI, full, segments: ang.length };
}

function planeBasis(n) {
  const a = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = norm(cross(n, a)), v = cross(n, u);
  return { u, v };
}

/**
 * Analyse one B-rep face given as triangle range [first, last] (inclusive, triangle indices) of a mesh.
 * pos/nrm: flat Float32 arrays; idx: flat index array.
 */
export function analyzeFace(pos, nrm, idx, first, last, opts = {}) {
  const P = (i) => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
  const N = (i) => [nrm[3 * i], nrm[3 * i + 1], nrm[3 * i + 2]];
  let area = 0;
  const verts = new Set();
  // vertices keyed by position so duplicated vertices still join edges
  const key = (i) => `${Math.round(pos[3 * i] * 1e4)},${Math.round(pos[3 * i + 1] * 1e4)},${Math.round(pos[3 * i + 2] * 1e4)}`;
  const edgeCount = new Map(), keyPos = new Map();
  for (let t = first; t <= last; t++) {
    const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
    area += len(cross(sub(P(b), P(a)), sub(P(c), P(a)))) / 2;
    verts.add(a); verts.add(b); verts.add(c);
    const ks = [key(a), key(b), key(c)];
    [a, b, c].forEach((i, j) => keyPos.set(ks[j], P(i)));
    for (const [x, y] of [[ks[0], ks[1]], [ks[1], ks[2]], [ks[2], ks[0]]]) {
      if (x === y) continue;
      const e = x < y ? `${x}|${y}` : `${y}|${x}`;
      edgeCount.set(e, (edgeCount.get(e) || 0) + 1);
    }
  }
  const vs = [...verts];
  const result = { area, kind: 'other', triangles: last - first + 1, approx: !nrm };
  if (vs.length < 3) return result;
  // normals to test: B-rep vertex normals, or (plain meshes) one normal per triangle
  let normals;
  if (nrm) normals = vs.map((i) => norm(N(i)));
  else { normals = []; for (let t = first; t <= last; t++) { const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2]; const n = cross(sub(P(b), P(a)), sub(P(c), P(a))); if (len(n) > 0) normals.push(norm(n)); } }
  if (!normals.length) return result;

  // --- plane? all normals (nearly) equal
  let mean = [0, 0, 0]; for (const n of normals) mean = [mean[0] + n[0], mean[1] + n[1], mean[2] + n[2]];
  const n0 = norm(mean);
  let minDot = 1; for (const n of normals) minDot = Math.min(minDot, dot(n, n0));
  if (minDot > 0.9995) {
    result.kind = 'plane'; result.normal = n0;
    // boundary loops -> circular edges (holes / round outlines)
    const adj = new Map();
    for (const [e, c] of edgeCount) if (c === 1) { const [x, y] = e.split('|'); (adj.get(x) || adj.set(x, []).get(x)).push(y); (adj.get(y) || adj.set(y, []).get(y)).push(x); }
    const seen = new Set(), loops = [];
    for (const start of adj.keys()) {
      if (seen.has(start)) continue;
      const loop = []; const stack = [start];
      while (stack.length) { const k = stack.pop(); if (seen.has(k)) continue; seen.add(k); loop.push(k); for (const nb of adj.get(k) || []) if (!seen.has(nb)) stack.push(nb); }
      loops.push(loop);
    }
    const { u, v } = planeBasis(n0);
    const circles = [];
    // the outer boundary is the loop with the biggest extent; the others are holes
    const ext = loops.map((loop) => { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity; for (const k of loop) { const p = keyPos.get(k); const x = dot(p, u), y = dot(p, v); a = Math.min(a, x); b = Math.max(b, x); c = Math.min(c, y); d = Math.max(d, y); } return Math.hypot(b - a, d - c); });
    const outer = ext.indexOf(Math.max(...ext));
    let exactArea = area;
    for (const [li, loop] of loops.entries()) {
      if (loop.length < 8) continue;
      const pts = loop.map((k) => { const p = keyPos.get(k); return [dot(p, u), dot(p, v)]; });
      const c = fitCircle2D(pts);
      if (!(c && c.maxErr < 0.005 && c.full)) continue;
      // the mesh uses an inscribed polygon; correct to the true circle (outer: add, hole: subtract)
      const n = loop.length, corr = Math.PI * c.r * c.r - 0.5 * n * c.r * c.r * Math.sin(2 * Math.PI / n);
      if (nrm) exactArea += li === outer ? corr : -corr;
      circles.push({ diameter: 2 * c.r, points: loop.length, hole: li !== outer, center: [0, 1, 2].map((j) => u[j] * c.cx + v[j] * c.cy + n0[j] * dot(keyPos.get(loop[0]), n0)) });
    }
    circles.sort((a, b) => b.diameter - a.diameter);
    result.meshArea = area; result.area = exactArea; result.areaExact = !!nrm;
    result.circles = circles;
    return result;
  }

  // --- cylinder? normals all perpendicular to one axis, points at constant distance from it
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const n of normals) { for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) M[r][c] += n[r] * n[c]; }
  const { values, vectors } = eigenSym3(M);
  const axis = vectors[0];
  let maxAx = 0; for (const n of normals) maxAx = Math.max(maxAx, Math.abs(dot(n, axis)));
  if (maxAx < 0.02 && values[1] > 1e-9) {
    const { u, v } = planeBasis(axis);
    const pts = vs.map((i) => { const p = P(i); return [dot(p, u), dot(p, v)]; });
    const c = fitCircle2D(pts);
    if (c && c.maxErr < 0.01) {
      let hmin = Infinity, hmax = -Infinity; for (const i of vs) { const h = dot(P(i), axis); hmin = Math.min(hmin, h); hmax = Math.max(hmax, h); }
      const span = c.coverageDeg * Math.PI / 180;
      result.meshArea = area; if (nrm) { result.area = c.r * span * (hmax - hmin); result.areaExact = true; }
      Object.assign(result, { kind: 'cylinder', full: c.full, diameter: 2 * c.r, radius: c.r, axis, length: hmax - hmin, coverageDeg: c.coverageDeg, fitError: c.maxErr });
    }
  }
  return result;
}

export const distance = (a, b) => len(sub(b, a));
