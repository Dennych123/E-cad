#!/usr/bin/env node
// Electrical rule check from the command line (CI, pre-commit, or an AI without MCP).
//   node tools/check.js <project> [--json] [--fail-on error|warning]
// Exit code 1 when a finding at --fail-on severity (default: error) exists.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectContext } from '../server/project.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const project = args.find((a) => !a.startsWith('--'));
const failOn = args.includes('--fail-on') ? args[args.indexOf('--fail-on') + 1] : 'error';
if (!project) { console.error('usage: node tools/check.js <project> [--json] [--fail-on error|warning]'); process.exit(2); }

const r = createProjectContext(root).check(project);
if (args.includes('--json')) console.log(JSON.stringify(r, null, 1));
else {
  const mark = { pass: '  ok ', info: ' info', warning: ' WARN', error: '  ERR' };
  console.log(`ecad check ${project}: ${r.summary.errors} error(s), ${r.summary.warnings} warning(s), ${r.summary.info} info\n`);
  for (const c of r.checklist) console.log(`${mark[c.status]}  ${c.title.padEnd(38)} ${c.count ? c.count : ''}`);
  console.log('');
  for (const f of r.findings.filter((x) => x.severity !== 'info')) {
    const at = f.where?.[0];
    console.log(`${f.severity.toUpperCase().padEnd(8)} ${f.rule.padEnd(24)} ${f.message}${at?.page ? `\n${' '.repeat(34)}at ${at.page}${at.line ? ' ' + at.line : ''}` : ''}`);
  }
  if (r.assumptions.length) console.log('\nassumed values:\n  ' + r.assumptions.join('\n  '));
}
const rank = { info: 0, warning: 1, error: 2 };
process.exit(r.findings.some((f) => rank[f.severity] >= rank[failOn]) ? 1 : 0);
