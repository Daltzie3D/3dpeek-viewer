# 3DPeek viewer

The offline 3D viewer used inside **3DPeek**, an iPhone app for viewing STEP and other CAD / 3D files.
The app shows this viewer in a WebView and sends it the file's bytes. Everything runs on the phone; nothing is uploaded.

This repository is published so that the LGPL-licensed CAD reader inside it (OpenCASCADE, via occt-import-js) can be
inspected, rebuilt and replaced, as the LGPL-2.1 requires. It contains the viewer only, not the iPhone app.

## What is here

| Path | What |
|---|---|
| `viewer/viewer.js` | The viewer: three.js scene, touch controls, view cube, section view, measuring, Parts, Photo Mode, file loading |
| `viewer/formats.js`, `viewer/threemf.js`, `viewer/meshfaces.js` | Mesh formats (STL, OBJ, glTF, FBX, 3DS, DAE, PLY, AMF, 3MF, VRML, OFF, dotbim) and the 3MF reader |
| `viewer/measure.js`, `viewer/features.js` | Measuring geometry: faces, circles, edges, corners, angles |
| `viewer/section.js` | Section (clipping) view with capped cut faces |
| `scripts/build-viewer.js` | Builds `dist/viewer.html` (plus `dist/lib-rhino.txt`, `dist/lib-ifc.txt`) exactly as shipped in the app |
| `third_party/occt-import-js-0.0.23/dist/` | The **unmodified** `occt-import-js.js` + `occt-import-js.wasm` shipped in the app |
| `third_party/licenses/`, `THIRD_PARTY.md` | Licences, versions and source locations of all third-party code |
| `samples/sample-assembly.stp`, `scripts/make-sample.py` | The app's sample model (our own, generated with OpenCASCADE) |
| `tests/` | Geometry tests (edges, circles, angles) against STEP files with known sizes |

## How it is built

Requirements: Node.js 18+.

```sh
npm install
npm run build        # -> dist/viewer.html (~11 MB, fully offline), dist/lib-rhino.txt, dist/lib-ifc.txt
npm test             # geometry tests (uses occt-import-js from node_modules)
```

`dist/viewer.html` is one self-contained file. It holds the bundled viewer code (esbuild, minified), three.js, and
occt-import-js's JavaScript and WebAssembly (as base64) in separate `<script>` blocks:
`#occt-js`, `#occt-wasm`. When the first CAD file opens, the viewer loads occt-import-js from those blocks into a Web
Worker. The library is a separate, unmodified component that the viewer calls through its public API
(`ReadStepFile`, `ReadIgesFile`, `ReadBrepFile`).

The app talks to the page through `window.pc` (`begin`, `chunk`, `end` to send a file, plus `setSettings`, `section`,
`parts`, …) and gets results back via `window.ReactNativeWebView.postMessage`. In a normal browser the messages go to
the console.

## Replacing / relinking the LGPL library (OpenCASCADE / occt-import-js)

1. Get the source:
   - occt-import-js 0.0.23: https://github.com/kovacsv/occt-import-js/tree/0.0.23
   - The OpenCASCADE version it pins: commit `d2abb6d844231cb8f29be6894440874a4700e4a5` of https://git.dev.opencascade.org/repos/occt.git
2. Change it if you like, and build it with Emscripten as described in occt-import-js's README. This gives you
   `occt-import-js.js` and `occt-import-js.wasm`.
3. Build the viewer with your library instead of the shipped one:
   ```sh
   OCCT_DIR=/path/to/your/occt-import-js/dist npm run build
   ```
4. The resulting `dist/viewer.html` is the viewer of the app with your library linked in. In the app it is the file
   `assets/viewer/viewer.html`. Any build of the app (for example a development build you sign yourself) can use your
   `viewer.html` in its place. The interface between the viewer and the library is only the JS API listed above.

The library is used unmodified. A copy of the exact source is also available on request for at least three years:
**daltzieai@gmail.com**.

## Licence

The viewer's own code is under the MIT licence (see `LICENSE`). Third-party components keep their own licences:
OCCT and occt-import-js are LGPL-2.1 (OCCT with the Open CASCADE exception), three.js and rhino3dm are MIT, web-ifc
is MPL-2.0. See `THIRD_PARTY.md`.
