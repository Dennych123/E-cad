# ecad-code architecture

Goal: replace Visio completely for Denso machine electrics — schematics, flow chart, panel/box
layout, wiring — with one tool whose source files are text an engineer and an AI can both edit.

## Decisions

| question | decision | why |
|---|---|---|
| browser or desktop app | **Local web app**: Node server + browser UI. Desktop later by wrapping (Tauri/Electron), no rewrite. | Same pattern as `manufacturing_io` and `sysmac-generator`; works on factory PCs offline; a page is what the team already opens. |
| 3D engine | **three.js** (pinned, served from `node_modules`, never a CDN). | Rendering only. Z-up, mm, `Object3D.DEFAULT_UP = (0,0,1)`, same as manufacturing_io. |
| physics (Rapier) | **Not used.** | A door is one kinematic DOF (hinge angle). Cable routing is a graph problem, clearance is a bounding-box problem. Physics would add nondeterminism and nothing we need. Revisit only for cable sag/bundle simulation. |
| schematic editor | **SVG in the DOM**, not canvas. | Crisp print/PDF, DOM hit-testing, text stays text. |
| language of the model | **JavaScript `lib/`, shared by Node and browser.** `lib/` never imports three. | The editor must run numbering/templates/modules live; one implementation, no drift. |
| Python | **Importers only** (`ecad/importer`: Visio COM dump), optional STEP export later (build123d). | Visio COM needs pywin32; nothing interactive lives in Python. |
| source of truth | YAML files in `library/` and `projects/<p>/`. Generated output in `out/`. | Diffable, reviewable, AI-editable. |

## Layers

```
library/boxes, library/modules, library/parts      reusable, YAML
projects/<p>/{project.yaml, sheets/, cabinets/, boxes/, modules/}
lib/        box.js (templates: extends, =expr, generators)  modules.js  numbering.js  trace.js  route.js
server/     main.js: static files + JSON API (GET anything, PUT/POST only from this PC)
web/        index.html + app.js (shell), view3d.js (three), plate2d.js (SVG), schematic.js (SVG editor)
ecad/       Python: Visio import only
```

Coordinates: enclosure frame x = width (left->right seen from front), y = depth (front y=0 -> back),
z = height (floor/box bottom z=0). Plate/face 2D frames are bottom-left origin, y up (as in the YAML).

## Roadmap

1. 3D box viewer: enclosure, stand, door on hinge (open/close), plate, ducts, rails, components, cutouts. **(this slice)**
2. Plate layout editor: drag components on rails (snap), place modules, save cabinet YAML.
3. Schematic sheets (SVG editor) + auto numbering + cross-reference + `trace`.
4. Wire routing through ducts (graph over duct centrelines) -> lengths, fill %, 3D wires.
5. Terminal plan, wire list, labels, BOM export.
6. Flow chart sheets: reuse `sysmac-generator/scripts/flowdoc.js` symbol rules (Denso legend).
