// Electrical rule check: synthetic cases for each rule, plus the known state of the example project.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks } from '../server/checks.js';
import { createProjectContext } from '../server/project.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// a tiny index: one schematic page with L-number rows and whatever texts/segments a case needs
function page(id, texts, segs = []) {
  const rows = Array.from({ length: 6 }, (_, i) => ({ label: `L10${String(i + 1).padStart(2, '0')}`, x: 20, y: 100 + i * 30 }));
  const rowTexts = rows.map((r, i) => ({ id: 900 + i, text: r.label, key: r.label, keys: [r.label], box: [r.x - 10, r.y - 4, 20, 8], at: [r.x, r.y], line: r.label, row: true }));
  const T = texts.map((t, i) => ({ id: t.id ?? i + 1, text: t.text, key: t.text.replace(/\s/g, ''), keys: [t.text.replace(/\s/g, '')], box: [t.at[0] - 5, t.at[1] - 4, 10, 8], at: t.at, line: t.line, role: null }));
  return { id, rows, texts: [...rowTexts, ...T], segs, owner: {} };
}
function index(pages) {
  const xref = new Map(), lineIndex = new Map();
  for (const p of pages) for (const t of p.texts) for (const k of t.keys) { if (!xref.has(k)) xref.set(k, []); xref.get(k).push({ page: p.id, id: t.id, line: t.line, role: null, text: t.text, row: !!t.row }); }
  return { pages: new Map(pages.map((p) => [p.id, p])), xref, lineIndex, drawings: [] };
}
const loads = { relay_coil: [{ match: '^G7SA-(2A2B|3A1B)', amps: 0.015, source: 'datasheet' }], lineup: { G7SA: ['2A2B', '3A1B', '3A3B', '4A2B', '5A1B'] } };
const rulesHit = (r) => r.findings.map((f) => f.rule);

export default function (t) {
  t('relay: coil is the tag beside its part label; too many contacts is an error', () => {
    const p = page('s/p01', [
      { text: 'CR1', at: [400, 100], line: 'L1001' }, { text: 'G7SA-3A1B', at: [430, 100], line: 'L1001' },     // coil (30 pt away)
      ...['L1002', 'L1003', 'L1004', 'L1005', 'L1006'].map((l, i) => ({ text: 'CR1', at: [100, 130 + i * 30], line: l })), // 5 contacts on a 4-pole relay
    ]);
    const r = runChecks({ index: index([p]), loads });
    t.ok(rulesHit(r).includes('relay.contacts-over'), JSON.stringify(r.findings));
    t.ok(!rulesHit(r).includes('relay.coil-twice'));
    t.eq(r.checklist.find((c) => c.id === 'relay.contacts-over').status, 'error');
  });

  t('relay: contact table must list exactly the lines of the contacts', () => {
    const p = page('s/p01', [
      { text: 'CR2', at: [400, 100], line: 'L1001' }, { text: 'G7SA-3A1B', at: [430, 100], line: 'L1001' },
      { text: 'L1002', at: [500, 100], line: 'L1001' }, { text: 'L1004', at: [530, 100], line: 'L1001' },            // table says L1002, L1004
      { text: 'CR2', at: [100, 130], line: 'L1002' }, { text: 'CR2', at: [100, 160], line: 'L1003' },               // contacts on L1002, L1003
    ]);
    const f = runChecks({ index: index([p]), loads }).findings.find((x) => x.rule === 'relay.table-mismatch');
    t.ok(f && /not listed: L1003/.test(f.message) && /listed, no contact: L1004/.test(f.message), f?.message);
  });

  t('relay: a contact far from any part label is never taken for a coil; CRx-1 counts as CRx', () => {
    const p = page('s/p01', [
      { text: 'CR3', at: [400, 100], line: 'L1001' }, { text: 'G7SA-3A1B', at: [430, 100], line: 'L1001' },
      { text: 'CR3', at: [100, 100], line: 'L1001' },                       // same line as the coil, 300 pt away: a contact
      { text: 'CR3-1', at: [100, 160], line: 'L1003' },
    ]);
    const r = runChecks({ index: index([p]), loads });
    t.ok(!rulesHit(r).includes('relay.coil-twice'), JSON.stringify(r.findings));
    t.ok(!rulesHit(r).includes('relay.no-coil'));
  });

  t('supplies: P24 and Z24 on one net is a short; P24A with P24B is a bypass; Z24A with Z24B is info', () => {
    const fake = (keys) => ({ index: index([page('s/p01', [])]), loads, nets: keys });
    void fake;
    const p = page('s/p01', [{ text: 'P24A', at: [50, 50], line: 'L1001' }, { text: 'Z24A', at: [60, 50], line: 'L1001' }],
      [[40, 55, 80, 55, 1]]);
    const r = runChecks({ index: index([p]), loads });
    t.ok(rulesHit(r).includes('supply.short'), JSON.stringify(r.findings));
    const p2 = page('s/p01', [{ text: 'P24A', at: [50, 50], line: 'L1001' }, { text: 'P24B', at: [60, 50], line: 'L1001' }], [[40, 55, 80, 55, 1]]);
    t.eq(runChecks({ index: index([p2]), loads }).findings.find((f) => f.rule === 'supply.merged')?.severity, 'warning');
    const p3 = page('s/p01', [{ text: 'Z24A', at: [50, 50], line: 'L1001' }, { text: 'Z24B', at: [60, 50], line: 'L1001' }], [[40, 55, 80, 55, 1]]);
    t.eq(runChecks({ index: index([p3]), loads }).findings.find((f) => f.rule === 'supply.merged')?.severity, 'info');
  });

  t('editor drawings: loose wire ends and duplicate tags', () => {
    const p = page('s/p01', [], [[100, 100, 200, 100, 1000001]]);
    const docs = [{ id: 's/p01', elements: [
      { id: 1000001, kind: 'wire', pts: [[100, 100], [200, 100]] },
      { id: 1000002, kind: 'symbol', tag: 'CR9' }, { id: 1000003, kind: 'symbol', tag: 'cr9' },
    ] }];
    const r = runChecks({ index: index([p]), docs, loads });
    t.eq(r.findings.filter((f) => f.rule === 'drawing.dangling').length, 2);
    t.ok(rulesHit(r).includes('drawing.duplicate-tag'));
  });

  // what the example drawings contain stays in the private project; here only properties that must hold
  t('example project: no false coil/short errors; real table mismatches found; budgets computed', () => {
    if (!fs.existsSync(path.join(root, 'projects', '6451-M014', 'raw'))) t.skip('project 6451-M014 not on this PC (confidential, not in git)');
    const r = createProjectContext(root).check('6451-M014');
    t.eq(r.findings.filter((f) => f.rule === 'relay.coil-twice' || f.rule === 'supply.short'), [], 'false positives');
    t.ok(r.findings.some((f) => f.rule === 'relay.table-mismatch'), 'the drawings have known contact-table mismatches');
    t.ok(!r.findings.some((f) => /^CRPB1:/.test(f.message)), 'CRPB1 is consistent (L1013, L1018, L11002)');
    const budgets = r.findings.filter((f) => f.rule === 'power.budget' && f.data?.rating);
    t.ok(budgets.length > 0 && budgets.every((f) => f.data.percent >= 0 && f.data.amps > 0), JSON.stringify(budgets.map((f) => f.message)));
  });
}
