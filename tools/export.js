#!/usr/bin/env node
// Reports from the command line (Excel / CSV, or JSON with --json):
//   node tools/export.js <project> bom
//   node tools/export.js <project> wires <cabinet>
//   node tools/export.js <project> terminals <cabinet>
//   node tools/export.js <project> labels <cabinet>        (CSV for tube / label printers)
// Options: --out <file>, --json. Default output: projects/<project>/out/ (git-ignored with the project).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectContext } from '../server/project.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const [project, what, cabinet] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
const KINDS = {
  bom: { json: (c) => c.bom(project), file: (c) => c.bomXlsx(project), name: `${project} BOM.xlsx`, cabinet: false },
  wires: { json: (c) => c.wires(project, cabinet), file: (c) => c.wiresXlsx(project, cabinet), name: `${project} wires ${cabinet}.xlsx`, cabinet: true },
  terminals: { json: (c) => c.terminals(project, cabinet), file: (c) => c.terminalsXlsx(project, cabinet), name: `${project} terminals ${cabinet}.xlsx`, cabinet: true },
  labels: { json: (c) => c.labels(project, cabinet), file: (c) => c.labelsCsv(project, cabinet), name: `${project} labels ${cabinet}.csv`, cabinet: true },
};
const k = KINDS[what];
if (!project || !k || (k.cabinet && !cabinet)) { console.error('usage: node tools/export.js <project> bom | wires|terminals|labels <cabinet>  [--out file] [--json]'); process.exit(2); }

const ctx = createProjectContext(root);
try {
  if (args.includes('--json')) { console.log(JSON.stringify(k.json(ctx), null, 1)); process.exit(0); }
  const out = path.resolve(opt('--out') || path.join(root, 'projects', project, 'out', k.name));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, k.file(ctx));
  const j = k.json(ctx);
  const summary = {
    bom: () => { const check = j.filter((r) => r.check); return `${j.length} part numbers, ${j.reduce((a, r) => a + r.qty, 0)} pieces${check.length ? `; ${check.length} to check: ${check.map((r) => r.part).join(', ')}` : ''}`; },
    wires: () => `${j.wires.length} wires`,
    terminals: () => j.strips.map((s) => `${s.tag}: ${s.terminals.length} terminals, ${s.terminals.filter((t) => t.bridgeUp || t.bridgeDown).length} bridges`).join('; ') || 'no terminal strips in this cabinet',
    labels: () => `${j.labels.length} labels${j.unnumbered.length ? `; wires without a number: ${j.unnumbered.join(', ')}` : ''}`,
  }[what]();
  console.log(`${out}\n${summary}`);
} catch (e) { console.error('error: ' + e.message); process.exit(1); }
