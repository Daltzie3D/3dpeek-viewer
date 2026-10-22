// Builds dist/viewer.html: one self-contained offline file with the viewer code, three.js, and occt-import-js (JS + WASM
// as base64) inlined, exactly as shipped inside the 3DPeek iPhone app. Also builds the two lazy libraries
// (dist/lib-rhino.txt, dist/lib-ifc.txt) that the app injects only when a 3DM / IFC file is opened.
//
// Replacing / relinking the LGPL library: set OCCT_DIR to a folder containing your own build of
//   occt-import-js.js + occt-import-js.wasm  (same API as occt-import-js 0.0.23)
// e.g.  OCCT_DIR=/path/to/my/occt-import-js/dist npm run build
// Default: the unmodified files shipped in the app, kept in third_party/occt-import-js-0.0.23/dist
// (identical to the npm package occt-import-js@0.0.23).
const fs = require('fs'), path = require('path'), esbuild = require('esbuild');
const root = path.join(__dirname, '..'), out = path.join(root, 'dist');
const js0 = esbuild.buildSync({ entryPoints: [path.join(root, 'viewer/viewer.js')], bundle: true, minify: true, format: 'iife', write: false, target: 'safari15' }).outputFiles[0].text;
// The app's tsconfig has "strict", which makes esbuild emit "use strict"; do the same here so the output is byte-identical.
const js = '"use strict";' + js0;
const occtDir = process.env.OCCT_DIR ? path.resolve(process.env.OCCT_DIR) : path.join(root, 'third_party/occt-import-js-0.0.23/dist');
const occtJs = fs.readFileSync(path.join(occtDir, 'occt-import-js.js'), 'utf8');
const wasm = fs.readFileSync(path.join(occtDir, 'occt-import-js.wasm')).toString('base64');
console.log('occt-import-js from', path.relative(root, occtDir) || occtDir);
const esc = (s) => s.replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#0e1116;touch-action:none;-webkit-user-select:none;user-select:none}canvas{display:block}</style></head><body>
<script id="occt-js" type="text/plain">${esc(occtJs)}</script>
<script id="occt-wasm" type="text/plain">${wasm}</script>
<script>${esc(js)}</script></body></html>`;
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'viewer.html'), html);
console.log('dist/viewer.html', (html.length / 1048576).toFixed(1), 'MB');
const nm = (p) => path.join(root, 'node_modules', p);
const libs = {
  rhino: `window.__pcLib={factory:(function(){${fs.readFileSync(nm('rhino3dm/rhino3dm.min.js'), 'utf8').replace(/export\s*default\s*rhino3dm;?\s*$/, '')};return rhino3dm;})(),wasm:"${fs.readFileSync(nm('rhino3dm/rhino3dm.wasm')).toString('base64')}"};`,
  ifc: `window.__pcLib={lib:(function(){${esbuild.transformSync(fs.readFileSync(nm('web-ifc/web-ifc-api-iife.js'), 'utf8'), { minify: true, target: 'safari15' }).code};return WebIFC;})(),wasm:"${fs.readFileSync(nm('web-ifc/web-ifc.wasm')).toString('base64')}"};`,
};
for (const [k, v] of Object.entries(libs)) { fs.writeFileSync(path.join(out, `lib-${k}.txt`), v); console.log(`dist/lib-${k}.txt`, (v.length / 1048576).toFixed(1), 'MB'); }
