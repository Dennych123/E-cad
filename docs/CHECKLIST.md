# Feature checklist — parity with SKYCAD Electrical + Denso extras

Reference: SKYCAD Electrical feature page (Standard free / Advanced / Pro) and its tutorial list,
read 2026-09-29 (skycad.ca/features-pricing, skycad.ca/forums/all-tutorials).
Status: `[x]` done · `[~]` partial / data only, no UI · `[ ]` not started.

## 1. Schematic fundamentals (SKYCAD Standard)
- [ ] Sheets with title block, grid columns/rows (change title block per sheet)
- [ ] Symbol library IEC 60617 (+ Denso style from existing drawings: A接点, B接点, G7SA, BREAKER, SOL, SS, TB)
- [ ] Symbol editor: connection points, port types, port graphics, pin-out attributes
- [ ] Place / move / rotate symbols, draw wires, snap to connection points
- [ ] Multi-symbol devices (coil + contacts of one relay on different sheets)
- [ ] Off-page / on-page references (Visio masters `Off-page reference`, `On-page reference` exist)
- [x] Navigation: jump to cross-referenced position, highlight connected elements (live Visio SVG)
- [ ] Print / export PDF (A3/A2), intelligent PDF with clickable cross-references
- [ ] Import DWG/DXF · [~] **Import Visio .vsd** (raw geometry + text done, topology not yet)

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
- [ ] Parts catalogue (maker, P/N, description, price, dimensions, 3D, terminal count)
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
- [ ] AI-editable source: YAML + JSON schema + `CLAUDE.md`, `ecad check` rules
- [ ] Denso standards checks (prgstd): alarm categories, naming of CR/LB/DM signals
- [ ] Desktop wrapper (Tauri/Electron) — only after the web app is complete

## Use cases to test end-to-end (acceptance)
1. Redraw PLC IO sheet `09` from YAML; PDF matches Visio side by side.
2. Change one wire number → every cross-reference, label and terminal plan updates.
3. `trace X0105` shows 2PB SS2 → cable W2PB core 4 → 1CE TB12 → IN1 CH00.05.
4. Place `relay_bank` count 4 → tags, BOM, plate layout and 3D all update.
5. `box new` 800-wide from 1CE → drawing + 3D + door swing clearance.
6. Import I/O list Excel → PLC sheets generated.
7. Release rev A, change, compare rev A vs working copy.
