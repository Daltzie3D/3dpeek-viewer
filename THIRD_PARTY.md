# Third-party components

| Component | Version | Licence | Where | Source |
|---|---|---|---|---|
| Open CASCADE Technology (OCCT) | commit `d2abb6d844231cb8f29be6894440874a4700e4a5` (as pinned by occt-import-js 0.0.23) | LGPL-2.1 + Open CASCADE exception 1.0 | compiled into `occt-import-js.wasm` | https://git.dev.opencascade.org/repos/occt.git · mirror https://github.com/Open-Cascade-SAS/OCCT |
| occt-import-js | 0.0.23 (git tag `0.0.23`, commit `c2148e54b456b571238d35cac037d304053d64b2`) | LGPL-2.1 | `third_party/occt-import-js-0.0.23/dist/` (unmodified) | https://github.com/kovacsv/occt-import-js/tree/0.0.23 |
| three.js (+ its bundled fflate, meshoptimizer decoder, Chevrotain) | 0.170.0 | MIT (fflate MIT, meshoptimizer MIT, Chevrotain Apache-2.0) | npm, bundled into `dist/viewer.html` | https://github.com/mrdoob/three.js |
| rhino3dm | 8.35.0 | MIT | npm, `dist/lib-rhino.txt` | https://github.com/mcneel/rhino3dm |
| web-ifc | 0.0.78 | MPL-2.0 | npm, `dist/lib-ifc.txt` (unmodified) | https://github.com/ThatOpen/engine_web-ifc |

Full licence texts: `third_party/licenses/`.

SHA-256 of the shipped occt-import-js files (same as in the npm package `occt-import-js@0.0.23`):

```
3fb44ce11d00611f9b3f3c5775d520ebab48930c1f08279b7b1316f05f0d3379  occt-import-js.js
33391fc9d94ea5c869a6718488bf0a9a464222bac9bdc764dfe1690cef281952  occt-import-js.wasm
```
