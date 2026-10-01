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

## The drawing editor (web/editor.js)
- A sheet is a document (`lib/sheetdoc.js`): elements in draw order, SVG points, y down. Imported Visio shapes
  keep their original SVG markup (exact look) plus a `dx/dy` offset and their raw shapes; editor shapes
  (wire, line, rect, ellipse, text, symbol) carry their own geometry. `elementShapes()` turns every element
  back into raw shape records so `lib/sheetindex.js` (masks, nets, xref, ownership) runs unchanged - the
  parity test checks every imported page indexes identically as a document.
- Elements are immutable. Every edit swaps in a new array; undo/redo is a stack of arrays; `sync()` touches
  only DOM nodes whose element object changed. Never mutate an element in place.
- Documents are built from the import on first open and saved to `projects/<p>/sheets/<drawing>/<page>.json`
  (atomic write, `rev` + 409 on conflicting saves). Only this PC may write (`--lan-edit` to allow the LAN).
  Each save first copies the replaced version to `projects/<p>/history/<drawing>/<page>/<rev>.json` (30 kept).
- Inputs opened by a click (text tool) open after the press (`setTimeout`): the browser focuses the stage on
  mousedown, which would blur and close them.
- Visio markup needs `xmlns:v`, `xmlns:xlink`, `xmlns:ev` wherever it is parsed; its export also contains the
  background page with colliding shape ids (`shapeN-` / `groupN-`): only `foregroundPage` children are shapes.
- Translation is display-only: `<text>` nodes are replaced in the DOM and shrunk with a transform about their
  anchor when English runs longer; the document keeps the original text. Dictionaries: `library/i18n`
  (generic, public) + `projects/<p>/i18n` (machine-specific, private). The Denso frame footer is a raster image.
- Double-click: L-number references follow; everything else edits text (F2 edits a reference's text);
  on a selected wire/line's corner it removes the point.
- Handles: one selected rect/ellipse resizes; one selected wire/line edits points (`lib/sheetdoc.js`
  dragWireVertex/End/Segment keep wires orthogonal and never move a wire end off its pin - unit-tested).
- Groups are a shared `group` number on flat elements (no nesting); paste gives copies new group numbers.
- Style keys per kind live in `STYLE_KEYS`; defaults are not stored (`dash: solid`, `font: mono`...).
- Wire numbers made by `numberWires` are text elements with `auto: 'wireno'`; a net counts as numbered when
  a free or imported text belongs to it (a symbol tag beside the wire does not). Only nets with editor wires.
- The 3D panel shares the inspector element: its listeners must check `active`.

## UI rules (Emil Kowalski's design-engineering skill, github.com/emilkowalski/skills)
- Nothing keyboard-driven animates (command palette, tool switches). Transitions < 250 ms, `--ease-out`
  cubic-bezier(0.23,1,0.32,1); on-screen movement `--ease-in-out`. Never `transition: all`, never scale(0).
- Pressables scale(.97) on :active; hover styles only under `(hover: hover) and (pointer: fine)`.
- Menus/tooltips grow from their trigger (`--origin`); tooltips wait 500 ms once, then open instantly.
- Toasts: transitions (interruptible), exit faster than enter, pause on hover and when the tab is hidden.
- Honour `prefers-reduced-motion`. One accent (signal orange) for selection/active; teal only for nets.
- Fonts: IBM Plex Sans / Plex Mono served from node_modules (offline). Tags, addresses, coordinates in mono.

## Web app (the product)
```
ECAD.bat                       # one click on Windows: installs packages once, starts the server, opens the browser
npm install
npm start                      # http://127.0.0.1:7670/  ?project=&mode=2d|3d&sheet=&key=&box=&cabinet=&door=90&xray=1
npm test                       # node tests/run.js: unit, JS<->Python parity, real-browser clicks (Edge/Chrome over CDP)
node tools/check.js <project> [--json] [--fail-on error|warning]   # electrical check; exit 1 on findings (CI)
node tools/export.js <project> bom | wires|terminals|labels <cabinet> [--out f] [--json]   # reports (default projects/<p>/out/)
node server/mcp.js             # MCP server (AI port), registered for Claude Code by .mcp.json
node tools/step2glb.js <maker.stp> --part <P/N> --front -y --up +z    # maker STEP -> GLB at real size
node tools/extract-symbols.js <project>     # symbol library from the imported drawings (+ symbols/names.yaml curation)
node tools/make-icon.js        # web/ecad.ico from the app mark (desktop shortcut)
```
- `server/project.js` is the one project context behind the HTTP API (`server/main.js`), the MCP server and
  the CLI tools: index, xref, nets, wires, catalogue, check. Add a capability there, then expose it in each.
- `--open` opens the browser once listening; when ecad already runs on the port it only opens the browser.
- `lib/` is shared by Node and browser, never imports three: `box.js`/`expr.js` (templates), `nets.js`
  (connectivity), `route.js` (duct routing). A net lit on screen is exactly the net a wire list is built from.
- three.js served from `node_modules` via importmap (`/vendor/three/`), never a CDN. No Rapier: the door is a
  kinematic hinge DOF (`setDoor(deg)`).
- 3D world: mm, Z up, x = width from the front-left, y = depth (front 0), z = height from the floor.
  Every face basis in `web/view3d.js` is right-handed with `w` = outward normal (bottom is the exception).
- Server binds 127.0.0.1 (`--lan` for the LAN); writes only from this PC unless `--lan-edit`; static paths
  cannot escape their mapped folder.

## Reports (server/bom.js, lib/xlsx.js)
- BOM quantity = devices listed for the part (cabinets, modules, placed symbols with a part number, module
  cables); labels on the drawings count only when nothing is listed; more labels than devices = "check".
  Tags found next to labels are shown for orientation and never change a quantity.
- `lib/xlsx.js` writes .xlsx with no dependency (stored ZIP); tests read it back with openpyxl when present.
- Terminal plan / labels (`server/terminals.js`): strip positions come from the cabinet's `terminal_strips`;
  the wire list does not know the side, so connections are listed per terminal; a cable core lands on the
  first terminal carrying its wire. Labels: 2 per wire-list wire, 1 per wired terminal side not already an end
  of a listed wire, 2 per cable core. Wire numbers: address > supply label > the strip's wire number > label.

## Electrical check (server/checks.js) and the AI port (server/mcp.js)
- Rules are data: `RULES` = `{ id, title, severity, help }`; `runChecks()` returns `summary`, a `checklist`
  (one row per rule: pass/info/warning/error) and `findings` with `where: [{ page, shape, line, key } | { cabinet, key }]`.
  The web Checks tab, the sheet badges, the CLI and MCP all read this one result - keep its shape stable.
- A coil is the relay tag within 70 pt of a relay part label (`G7SA-3A1B`, `LY2N`, `MY4N`); every other
  occurrence of the tag is a contact. Never decide coil vs contact by "same line" - contacts share lines.
  `CRx-1` counts as `CRx`. A G9SA/G9SX text near a tag makes it a safety unit, not a relay.
- Loads in `library/electrical/loads.yaml` carry `source: datasheet | assumed`; budget findings list the
  assumed values. Never present an estimate as a measured current.
- Every new rule gets a synthetic case in `tests/checks.test.js`, and the project test must stay free of
  false errors (a false error teaches users to ignore the checker).
- MCP: JSON-RPC 2.0 over stdio, one message per line; stdout carries protocol only (logs to stderr); tools
  are read-only; project names must match `NAME_RE` in `server/store.js` (no paths).

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
- `web/editor.js` 2D editor; `web/view3d.js` + `web/panel3d.js` 3D; `web/app.js` shell (tabs: sheets, symbols,
  parts, checks); `web/ui.js` menus/dialogs/toasts/palette; `tests/lib/cdp.js` browser driver.
- Templates: `library/boxes` (generic), `projects/<p>/boxes|modules` (project, private). Cabinets: `projects/<p>/cabinets`.

## YAML conventions
- Units mm. Faces and plate: origin bottom-left, y up, viewed from outside/front.
- `extends: <id>` inherits; maps merge, lists replace, `key+:` appends (dict value appends per sub-key), `null` deletes.
- `=expr` values: arithmetic, `a.b`, `a[i]`, and `min max round abs int float len str pick` only (same in
  Python and JS - no ternary). In module parts `i` = repeat index; `{n}` in a tag = next free number.
- Never use the bare key `no:` (YAML 1.1 reads it as false) - use `core`, `pos`.
- Open questions from drawings go in `review:` lists, not comments.
