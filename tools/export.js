#!/usr/bin/env node
// Reports from the command line, as Excel (or JSON):
//   node tools/export.js <project> bom [--out file.xlsx] [--json]
//   node tools/export.js <project> wires <cabinet> [--out file.xlsx] [--json]
// Default output: projects/<project>/out/ (git-ignored with the project).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectContext } from '../server/project.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const [project, what, cabinet] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
const usage = 'usage: node tools/export.js <project> bom | wires <cabinet>  [--out file.xlsx] [--json]';
if (!project || !['bom', 'wires'].includes(what) || (what === 'wires' && !cabinet)) { console.error(usage); process.exit(2); }

const ctx = createProjectContext(root);
try {
  if (flag('--json')) {
    console.log(JSON.stringify(what === 'bom' ? ctx.bom(project) : ctx.wires(project, cabinet), null, 1));
  } else {
    const data = what === 'bom' ? ctx.bomXlsx(project) : ctx.wiresXlsx(project, cabinet);
    const out = path.resolve(opt('--out') || path.join(root, 'projects', project, 'out', what === 'bom' ? `${project} BOM.xlsx` : `${project} wires ${cabinet}.xlsx`));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
    if (what === 'bom') {
      const bom = ctx.bom(project), check = bom.filter((r) => r.check);
      console.log(`${out}\n${bom.length} part numbers, ${bom.reduce((a, r) => a + r.qty, 0)} pieces${check.length ? `; ${check.length} to check: ${check.map((r) => r.part).join(', ')}` : ''}`);
    } else console.log(`${out}\n${ctx.wires(project, cabinet).wires.length} wires`);
  }
} catch (e) { console.error('error: ' + e.message); process.exit(1); }
