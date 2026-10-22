// npm run test-features — edges/circles/angles from real STEP geometry with known sizes.
import fs from 'fs';
import { createRequire } from 'module';
import { extractFeatures, planeRelation, lineAngle, linePlaneAngle } from '../viewer/features.js';
import { analyzeFace } from '../viewer/measure.js';
const occt = await createRequire(import.meta.url)('occt-import-js')();
let fail = 0;
const ok = (label, pass, info = '') => { if (!pass) fail++; console.log(`${pass ? 'PASS' : 'FAIL'} ${label} ${info}`); };
const near = (a, b, t = 1e-6) => Math.abs(a - b) <= t;
const r = occt.ReadStepFile(new Uint8Array(fs.readFileSync(new URL('./fixtures/test-plate.step', import.meta.url))), null);
const m = r.meshes[0], pos = m.attributes.position.array, idx = m.index.array;
const t0 = performance.now(); const F = extractFeatures(pos, idx, m.brep_faces); const ms = performance.now() - t0;
const circles = F.chains.filter((c) => c.kind === 'circle'), lines = F.chains.filter((c) => c.kind === 'line');
console.log(`  test plate: ${F.chains.length} edges (${lines.length} straight, ${circles.length} circles, ${F.chains.filter((c) => c.kind === 'arc').length} arcs), ${F.corners.length} corners, ${ms.toFixed(1)} ms`);
// plate 100×60×10, hole ⌀20 through, boss ⌀30 × 15 high (tests/make-fixture.py)
const dia = circles.map((c) => +(2 * c.radius).toFixed(6)).sort((a, b) => a - b);
ok('hole ⌀20: both rims found as circles, exact', dia.filter((d) => near(d, 20, 1e-6)).length === 2, JSON.stringify(dia));
ok('boss ⌀30: both rims found as circles, exact', dia.filter((d) => near(d, 30, 1e-6)).length >= 1, '');
const L = lines.map((l) => +l.length.toFixed(6));
ok('plate edges 100 / 60 / 10 long are straight edges, exact', [100, 60, 10].every((v) => L.some((x) => near(x, v, 1e-9))), JSON.stringify([...new Set(L)].sort((a, b) => a - b)));
ok('12 plate edges + boss/hole lines', lines.filter((l) => [100, 60, 10].some((v) => near(l.length, v, 1e-9))).length === 12, '');
ok('8 plate corners found', [[0, 0, 0], [100, 0, 0], [0, 60, 0], [100, 60, 0], [0, 0, 10], [100, 60, 10]].every((p) => F.corners.some((c) => near(c[0], p[0]) && near(c[1], p[1]) && near(c[2], p[2]))), `${F.corners.length} corners`);
const hc = circles.find((c) => near(2 * c.radius, 20, 1e-6));
ok('hole centre on the hole axis', hc && Math.abs(Math.abs(hc.normal[2]) - 1) < 1e-9, hc && hc.center.map((v) => v.toFixed(4)).join(','));
// faces: top vs bottom = parallel 10 apart; top vs side = 90°
const fa = m.brep_faces.map((f) => ({ ...analyzeFace(pos, m.attributes.normal.array, idx, f.first, f.last), f }));
const planes = fa.filter((f) => f.kind === 'plane');
const P = (f) => [pos[3 * idx[3 * f.f.first]], pos[3 * idx[3 * f.f.first] + 1], pos[3 * idx[3 * f.f.first] + 2]];
const top = planes.find((f) => near(P(f)[2], 10, 1e-9) && Math.abs(f.normal[2]) > 0.99), bot = planes.find((f) => near(P(f)[2], 0, 1e-9) && Math.abs(f.normal[2]) > 0.99 && near(f.area, 100 * 60 - Math.PI * 100, 1e-3));
const side = planes.find((f) => Math.abs(f.normal[0]) > 0.99);
const tb = planeRelation(top.normal, P(top), bot.normal, P(bot));
ok('face to face: top ∥ bottom, 10 mm apart', tb.parallel && near(tb.distance, 10, 1e-9), `${tb.distance}`);
const ts = planeRelation(top.normal, P(top), side.normal, P(side));
ok('angle top vs side face = 90°', !ts.parallel && near(ts.angle, 90, 1e-6), `${ts.angle}`);
ok('angle edge X vs edge Y = 90°, X vs X = 0°', near(lineAngle([1, 0, 0], [0, 1, 0]), 90) && near(lineAngle([1, 0, 0], [-2, 0, 0]), 0), '');
ok('45° edge vs face', near(linePlaneAngle([1, 0, 1], [0, 0, 1]), 45, 1e-9), '');
// bundled sample assembly: runs fast and finds bolt/nut circles
const s = occt.ReadStepFile(new Uint8Array(fs.readFileSync(new URL('../samples/sample-assembly.stp', import.meta.url))), null);
let n = 0, nc = 0; const t1 = performance.now();
for (const mm of s.meshes) { const f = extractFeatures(mm.attributes.position.array, mm.index.array, mm.brep_faces); n += f.chains.length; nc += f.chains.filter((c) => c.kind === 'circle' || (c.kind === 'arc' && c.full)).length; }
ok('sample assembly: edges + circles found quickly', n > 50 && nc > 10 && performance.now() - t1 < 3000, `${n} edges, ${nc} circles, ${(performance.now() - t1).toFixed(0)} ms`);
if (fail) { console.log(`${fail} FAILED`); process.exit(1); } else console.log('features OK');
