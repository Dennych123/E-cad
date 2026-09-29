# ecad-code

Code-first electrical CAD in the browser: live drawings (imported Visio sheets with cross-reference and
nets), 3D panel with door, wires derived from the drawings and routed through the ducts, real maker models.
Source of truth is text (YAML + the imported sheet data); drawings/wire lists/3D are generated.

Architecture decisions: `docs/ARCHITECTURE.md`. Feature checklist vs SKYCAD Electrical: `docs/CHECKLIST.md`.

## Public vs private (read first)
- This repo is PUBLIC. Customer projects are confidential and live only on the owner's PC under `projects/`
  (git-ignored): Visio dumps, renders, and everything derived from them - project box templates, modules,
  cabinets, wire lists. Never move project data into `library/`, never un-ignore `projects/`.
- `library/` holds generic templates only. Maker 3D models (`library/parts/3d/`) are ignored too (licence).
- Tests that need a project SKIP with a message on a fresh clone. A silent skip looks like a pass.

## Web app (the product)
```
npm install
npm start                      # http://127.0.0.1:7670/  ?project=&mode=2d|3d&sheet=&key=&box=&cabinet=&door=90&xray=1
npm test                       # node tests/run.js: unit, JS<->Python parity, real-browser clicks (Edge/Chrome over CDP)
node tools/step2glb.js <maker.stp> --part <P/N> --front -y --up +z    # maker STEP -> GLB at real size
```
- `lib/` is shared by Node and browser, never imports three: `box.js`/`expr.js` (templates), `nets.js`
  (connectivity), `route.js` (duct routing). A net lit on screen is exactly the net a wire list is built from.
- three.js served from `node_modules` via importmap (`/vendor/three/`), never a CDN. No Rapier: the door is a
  kinematic hinge DOF (`setDoor(deg)`).
- 3D world: mm, Z up, x = width from the front-left, y = depth (front 0), z = height from the floor.
  Every face basis in `web/view3d.js` is right-handed with `w` = outward normal (bottom is the exception).
- Server binds 127.0.0.1; API is read-only for now; static paths cannot escape their mapped folder.

## Reading Denso Visio sheets (each rule cost a wrong net once)
- The L-number margin (`L1001`, `L1002`, ...) is the line address. A margin column counts up by one;
  contact tables under coils also stack L-numbers at one x but jump around - they are references, not rows.
- A device tag is written ABOVE its symbol: it belongs to the row a bit below (`pitch * 0.35`), per column.
- A rung is ONE straight line; symbols are laid on top. White-filled closed shapes (the 1.9 mm patch between
  contact plates, lamp and coil circles) cut the line they cover. Exceptions: junction dots (tiny AND outlined)
  and ovals carrying a wire number (`DPB1`, `DM20`, `P24A`), which sit on their own wire.
- Filled 2-D outlines are symbol bodies, not wires (the NX unit is an open filled U-path through every terminal).
- Visio's SVG export contains the background page with colliding shape ids: pick only inside `foregroundPage`.
- TxtPin can sit at a text box corner; use the box centre.
- PLC mark tube = address `XXXX XX` (word + bit). Units map by their sheet headers (`CH 0000` over `INPUT UNIT`).

## Python CLI (import + legacy)
```
python -m ecad.cli import-visio <folder-with-vsd> projects/<p>     # Visio COM -> raw JSON + SVG
python -m ecad.cli stats projects/<p>                              # raw/_stats.md
python -m ecad.cli box list|show|new|render|extract|gallery
python -m ecad.cli module list|show|place
```
Requires Windows + installed Visio only for `import-visio`/`export-png`. A file open in Visio is imported
from a temp copy. Big pages fail PNG export in Visio: render the SVG with headless Edge instead.

## Layout
- `ecad/importer/` Visio COM dump; raw pages `projects/<p>/raw/<file>/pNN.json` (page mm, bottom-left origin).
- `server/sheets.js` sheet index (texts, rows, segments, device ownership); `server/connections.js` nets -> wires.
- `web/sheets.js` live 2D; `web/view3d.js` 3D; `web/app.js` shell; `tests/lib/cdp.js` browser driver.
- Templates: `library/boxes` (generic), `projects/<p>/boxes|modules` (project, private). Cabinets: `projects/<p>/cabinets`.

## YAML conventions
- Units mm. Faces and plate: origin bottom-left, y up, viewed from outside/front.
- `extends: <id>` inherits; maps merge, lists replace, `key+:` appends (dict value appends per sub-key), `null` deletes.
- `=expr` values: arithmetic, `a.b`, `a[i]`, and `min max round abs int float len str pick` only (same in
  Python and JS - no ternary). In module parts `i` = repeat index; `{n}` in a tag = next free number.
- Never use the bare key `no:` (YAML 1.1 reads it as false) - use `core`, `pos`.
- Open questions from drawings go in `review:` lists, not comments.
