# ecad

Electrical CAD in the browser, built code-first so people and AI can both read and change a project.

- **Live drawings.** Imported Visio sheets keep their exact look and become editable. You get cross-references (coil ↔ contacts by line number), lit nets, and jumps between sheets.
- **Editor.** Wires with glue and auto elbows, symbols from a library extracted from your own drawings, undo/redo, copy/paste across sheets, print/PDF at true size, and English display of Japanese drawings.
- **Electrical check.** Finds shorted supplies, joined protected branches, branch load against the circuit protector, relay contacts against relay poles, contact tables that don't match the drawn contacts, missing coils, PLC addresses wired twice, loose wire ends, duplicate tags, and panel parts missing from the schematics.
- **Panel 3D.** Enclosure with a working door, plate, ducts, rails, real maker models (STEP → GLB), and wires derived from the drawings and routed through the ducts.
- **AI port.** An MCP server gives an AI assistant read-only access to projects: check, cross-reference, nets, wire lists, catalogue.

## Start

**Windows, one click:** install [Node.js](https://nodejs.org) (LTS, 20 or newer), then double-click `ECAD.bat`. The first start installs the packages. Every start runs the server and opens the app in your browser. Close the console window to stop ECAD.

Tip: right-click `ECAD.bat` → *Send to* → *Desktop (create shortcut)*. Point the shortcut's icon at `web/ecad.ico`.

**Any OS:**

```
npm ci
npm start            # http://127.0.0.1:7670/
```

The server listens on this PC only. `--lan` serves the LAN read-only. `--lan-edit` also allows edits from the LAN.

## Projects

A project lives in `projects/<name>/`. Its drawings are imported from Visio with the Python CLI, which needs Windows with Visio installed:

```
python -m ecad.cli import-visio <folder-with-vsd> projects/<name>
node tools/extract-symbols.js <name>      # symbol library from the imported drawings
```

`projects/` is git-ignored on purpose. Customer drawings never go into this repository. `library/` holds only generic templates. Maker 3D models (`library/parts/3d/`) are ignored too, because of their licences.

## Electrical check

The **Checks** tab lists every rule with its status and every finding. Click a finding to open its sheet at the spot. Findings also appear as badges on the sheet. Press `F7` to check again and `Shift+F7` to step through the findings.

From the command line (for CI or a pre-commit hook):

```
node tools/check.js <project>                  # human-readable
node tools/check.js <project> --json           # machine-readable
node tools/check.js <project> --fail-on warning   # exit 1 on warnings too (default: errors)
```

Load estimates use `library/electrical/loads.yaml`. Each value is marked `datasheet` or `assumed`, and every result lists the assumed values it used. A project can override them in `projects/<name>/electrical.yaml`.

## AI port (MCP)

`.mcp.json` registers the server for Claude Code in this folder. For another client, run `node server/mcp.js`, which speaks JSON-RPC over stdio. The tools are:

| Tool | What it returns |
|---|---|
| `ecad_projects` | the projects on this machine |
| `ecad_check` | the electrical check: summary, checklist, findings with sheet/line |
| `ecad_rules` | what each rule measures |
| `ecad_sheets`, `ecad_sheet` | drawings and sheets; one sheet's lines, devices, supplies, PLC addresses |
| `ecad_xref` | every place an identifier appears (tag, wire number, address, line) |
| `ecad_search` | identifiers matching a substring |
| `ecad_nets` | connected wiring on a sheet, with labels and devices |
| `ecad_wires` | from–to wire list of a cabinet, routed, with lengths |
| `ecad_components`, `ecad_symbols` | parts catalogue and symbol library |

## Development

```
npm test        # unit tests, JS↔Python parity, MCP, and real-browser tests (Edge/Chrome over CDP)
```

Tests that need a confidential project skip on a fresh clone and say so.

Read `CLAUDE.md` for the working rules. Read `docs/ARCHITECTURE.md` for the design and `docs/CHECKLIST.md` for feature status.
