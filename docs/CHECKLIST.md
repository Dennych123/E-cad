# Feature checklist — parity with SKYCAD Electrical + Denso extras

Reference: SKYCAD Electrical feature page (Standard free / Advanced / Pro) and its tutorial list,
read 2026-09-29 (skycad.ca/features-pricing, skycad.ca/forums/all-tutorials).
Status: `[x]` done · `[~]` partial / data only, no UI · `[ ]` not started.

## 0. Visio parity (the drawing editor) — updated 2026-10-01
Imported sheets open as editable documents that look exactly like the Visio export (same markup),
and index exactly like the import (tested on all 27 pages).

| Visio feature | Status | Where |
|---|---|---|
| Multi-page drawings, page tree, open/switch pages | [x] | Sheets tab; unsaved-change guard on switch |
| Background page (frame + title block) | [x] shown, locked; toggle | toolbar "Title block" |
| Zoom (wheel, +/-, fit, presets, 100 % = true size), pan (Space / middle / H) | [x] | toolbar, `Ctrl+0`, `Ctrl+1` |
| Select, Shift-toggle, marquee, select all | [x] | V, `Ctrl+A` |
| Move with grid snap (2.5 mm), nudge (arrows, Shift ×10) | [x] | |
| Undo / redo (300 steps, labelled) | [x] | `Ctrl+Z` / `Ctrl+Y` |
| Cut / copy / paste (also across sheets), duplicate, delete | [x] | `Ctrl+X/C/V/D`, Del |
| Draw lines, rectangles, ellipses, text | [x] | L, B, E, T |
| Connectors: orthogonal wires with auto elbow, snap to pins / wire ends / onto a wire (T + dot) | [x] | W |
| **Glue**: wire ends follow a moved shape's pins | [x] | |
| Stencils: drag & drop library symbols, place mode with rotate (R) and auto tag | [x] | Symbols tab (122 from this project) |
| Custom stencils: save any selection as a symbol | [x] | right-click → Save as symbol |
| Rotate 90°, flip horizontal | [x] symbols & drawn shapes · imported shapes keep orientation | `Ctrl+R`, `Shift+H` |
| Bring to front / send to back | [x] | `Ctrl+]` / `Ctrl+[` |
| Align left/centre/right/top/middle/bottom | [x] | multi-selection |
| Edit text in place (double-click, F2), incl. imported text | [x] | |
| Shape data: tag, part number (catalogue suggestions), size, position in mm | [x] | Inspector |
| Right-click context menu | [x] | |
| Find | [x] tags / wires / addresses across the project | `Ctrl+F`, `/` |
| Hyperlinks between pages | [x] L-number references follow on double-click | |
| New page (same frame), rename page, delete page | [x] | Sheets tab `+`, Inspector |
| Print / PDF at true page size, export SVG | [x] | `Ctrl+P` |
| Language: Japanese drawings shown in English (164/164 strings), switch back to JA | [x] | `Alt+L` |
| Resize handles, vertex editing of wires/lines | [ ] | |
| Group / ungroup | [ ] | |
| Layers panel (show/lock per layer) | [ ] background only | |
| Line style editor (dash, arrowheads, colour), fill colour, font | [~] weight only | |
| Format painter | [ ] | |
| Rulers and guides | [ ] (grid only) | |
| Connector re-routing around shapes | [ ] | |
| Page reorder, page size/orientation setup, duplicate page | [ ] | |
| Insert image, tables | [ ] | |
| Round-trip to .vsdx (export back to Visio) | [ ] (import only) | |
| Comments / review, version history UI | [ ] (saves carry rev + conflict check) | |
| Find & replace text, spell check | [ ] | |

## 1. Schematic fundamentals (SKYCAD Standard)
- [x] Sheets with title block (imported frame; new sheets copy the frame)
- [x] Symbol library from the example project: 122 symbols, 14 categories, English names, pins from how wires meet them (`tools/extract-symbols.js`)
- [~] Symbol editor: save a selection as a symbol (pins detected); no dedicated pin editor yet
- [x] Place / move / rotate symbols, draw wires, snap to connection points
- [ ] Multi-symbol devices (coil + contacts of one relay on different sheets)
- [~] Off-page / on-page references: masters are in the library; L-number references navigate
- [x] Navigation: jump to cross-referenced position, highlight connected elements (live Visio SVG)
- [~] Print / export PDF (true size via browser print); no clickable cross-references inside the PDF yet
- [ ] Import DWG/DXF · [x] **Import Visio .vsd** (geometry, text, topology, editable)

## 2. Automated numbering & cross-reference (SKYCAD Standard)
- [ ] Wire numbering: per potential, sheet-column (`104-3`), sequential; Denso styles (`L3018`, `P24A/Z24A`, `DM90`)
- [ ] Component numbering (tags), renumber with orientation rule, keep manual tags
- [x] Tag auto-numbering when placing modules (`CR{n}` → next free) — `module place`
- [ ] Sheet / project numbering
- [x] Cross-reference on the imported Visio sheets: coil ↔ contacts by Denso L-line numbers (CRPB1 → L1005, L1013, L1018, L11002), click to jump
- [~] **Trace a signal**: click a wire → whole net lit (masks/symbol bodies respected), click an L-number arrow → jumps to its line; cable/terminal hops not yet
- [ ] As-built lock: flag project as built, renumber only new items (SKYCAD Advanced)

## 3. PLC & drives (SKYCAD Standard/Advanced)
- [ ] Block generator: component + terminal list → schematic block(s) (drives, PLC units)
- [ ] PLC modules / expansion modules / channels; split PLC over sheets
- [ ] I/O list import from Excel → generate PLC sheets automatically
- [~] PLC unit data: NX102 + NX-ID5142-1 / NX-OD5256-1 footprints (`plc_nx102` module)
- [ ] Link to our PLC tools: IO list → CX-Programmer symbols / Sysmac variables (sysmac-generator)

## 4. Terminals (SKYCAD Standard)
- [~] Terminal strip data (TB12 UP/DOWN extracted from layout)
- [ ] Link terminal symbols to terminals, numbering, sorting, jumpers
- [ ] Automatic terminal strip layout drawing

## 5. Parts, catalogue, BOM (SKYCAD Standard)
- [~] Parts catalogue: 58 part numbers merged from modules, cabinets and the drawings, with maker, category, footprint, tags, symbols (Components tab); no prices yet
- [~] Parts known per module (Fuji AH165-*, IDEC XW1E, Omron NX/S8VK, SMC JXC, Misumi cable)
- [ ] BOM / parts list real-time, grouped by P/N and by location (1CE, 2PB), Excel export
- [ ] Accessories from box templates into BOM (handle, fan, plates) — data exists

## 6. Panel layout (SKYCAD Advanced)
- [x] Enclosure templates with inheritance + parametric sizes (`library/boxes`, extends, `=expr`)
- [x] Custom box from existing: `box new X --from 1CE --set enclosure.width=800`
- [x] Template gallery (HTML) for picking
- [x] Back plate: ducts, DIN rails, components; 2D drawing (SVG, A3)
- [x] Cut-out / drilling drawing with hole table (door, sides, bottom, PB plate)
- [~] Assembly layout from schematic parts (placement only via modules/extract, no link to schematic yet)
- [ ] Interactive drag & drop on rails with snap, collision check
- [ ] Enclosure resize UI (tutorial "Changing the size of an enclosure")

## 7. Wires & cables (SKYCAD Advanced)
- [ ] Wire processing: colour, gauge (0.5mm² BLUE, 2.5mm² G/Y…), part number per wire
- [~] From–to wire list derived from the drawings' nets (24 wires for 1CE: PLC input rungs, P24A chain, power), mark = PLC address `0000 00`
- [ ] Wire labels (marking sleeves) CSV + printable PDF
- [~] Cable schedule: 2PB cable VCTF23NX-0.5-20-5 cores 1–20 (module data)
- [ ] Shield management, cable list report

## 8. Harness (SKYCAD Pro)
- [ ] Harness diagram, connectors, splices, sleeving
- [ ] Wire length from routing · pin-outs · harness BOM

## 9. Reuse & variants (SKYCAD Pro)
- [x] Design-by-system: functional modules stored in catalogue, reused with params (`library/modules`)
- [ ] Modules carry schematic fragments (today: parts + footprint + cable only)
- [ ] Configuration management: options tree (e.g. remote panel yes/no, starter type) → apply modules
- [ ] Project templates (`ecad new --template denso-transfer`)

## 10. Revisions & collaboration (SKYCAD Pro / Standard)
- [~] Revision control: files are text → git history/diff (no UI yet)
- [ ] Lock a released version, compare two versions visually
- [ ] Revision table in title block filled from releases
- [ ] Multi-user on LAN (server read for all, write from this PC — manufacturing_io rule)

## 11. Beyond SKYCAD (Denso / our goals)
- [x] **3D box in browser** (`npm start`, three.js): enclosure with real cut-outs, stand, **door on hinge (animated, 0–open_angle)**, plate, ducts, rails, components with labels, door devices (PB/PL/SS/KS/EMG, breaker knob, fan), x-ray, click-to-select
- [ ] 3D: door-swing clearance check against door-mounted devices / neighbouring parts
- [x] 3D wire routing through ducts (Dijkstra on duct centrelines) → lengths; [ ] duct fill %, clearance
- [~] Maker STEP → GLB at real size (`tools/step2glb.js`, OpenCASCADE wasm), loaded per part number; needs the STEP files downloaded by hand (Omron blocks scripts); [ ] STEP export of the assembly
- [ ] Flow chart sheets (Denso legend) — reuse `sysmac-generator/scripts/flowdoc.js`; compare against Visio `03 FLOW CHART`
- [ ] Sensor layout sheet (Visio `02`) and system block diagram (`01`)
- [~] AI-editable source: YAML + `CLAUDE.md` + **AI port (MCP, `server/mcp.js`, 11 read-only tools)**; [ ] JSON schema, AI write tools
- [ ] Denso standards checks (prgstd): alarm categories, naming of CR/LB/DM signals
- [x] One-click start: `ECAD.bat` (installs once, starts, opens the browser; second click only opens a tab) + desktop shortcut icon
- [ ] Desktop wrapper (Tauri/Electron) — only after the web app is complete

## 12. Electrical check (ERC) — added 2026-10-01
Rules in `server/checks.js` (`RULES`), loads in `library/electrical/loads.yaml` (datasheet vs assumed).
One result feeds the Checks tab, sheet badges, status bar, `tools/check.js` (CI exit code) and MCP `ecad_check`.
- [x] Supply shorted: P24 with Z24 (or two voltages) on one net — error
- [x] Protected branches joined (P24A with P24B) — warning; common 0 V (Z24A with Z24B) — info
- [x] Branch load vs circuit protector (CP rating from part code or "(3A)"), > 80 % warning, > 100 % error
- [x] Relay contacts over the relay's poles (G7SA-3A1B = 4) — error; part outside the maker lineup — info
- [x] Contact table beside the coil vs the lines where contacts are drawn — warning
- [x] Contact without a coil (safety units G9SA/G9SX excluded) — warning; coil drawn twice — error
- [x] PLC address wired twice (I/O unit sheets) — warning
- [x] Editor sheets: loose wire ends — warning; duplicate tags — error
- [x] Panel devices missing from every schematic — warning
- [x] Untranslated drawing text — info
- [x] Web: Checks tab (summary, checklist, findings → jump to the spot), sheet badges, status bar count, re-check after save, `F7` / `Shift+F7`
- [ ] Wire gauge vs protector rating (needs wire data), voltage drop on long runs
- [ ] Output point current vs load (NX-OD 0.5 A/point) per PLC output
- [ ] Terminal strip overfill, duct fill % from routed wires
- [ ] Quick-fix actions (e.g. add a missing contact-table entry)

## Use cases to test end-to-end (acceptance)
1. Redraw PLC IO sheet `09` from YAML; PDF matches Visio side by side.
2. Change one wire number → every cross-reference, label and terminal plan updates.
3. `trace X0105` shows 2PB SS2 → cable W2PB core 4 → 1CE TB12 → IN1 CH00.05.
4. Place `relay_bank` count 4 → tags, BOM, plate layout and 3D all update.
5. `box new` 800-wide from 1CE → drawing + 3D + door swing clearance.
6. Import I/O list Excel → PLC sheets generated.
7. Release rev A, change, compare rev A vs working copy.
