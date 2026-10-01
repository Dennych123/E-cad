// Reports: the .xlsx writer and the bill of materials.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { xlsx, crc32, colName, zipStore, unzipStore } from '../lib/xlsx.js';
import { buildBom } from '../server/bom.js';
import { partsOfText } from '../server/components.js';
import { terminalPlan, wireLabels, labelsCsv } from '../server/terminals.js';
import { createProjectContext } from '../server/project.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dec = new TextDecoder();
const sample = () => xlsx([
  { name: 'Parts [A/B]', columns: [{ header: 'Part', width: 20 }, { header: 'Qty' }], rows: [['G7SA-3A1B', 4], ['<&> "q"\u0007', 2.5], ['', null]] },
  { name: 'About', columns: [{ header: 'Field' }, { header: 'Value' }], rows: [['multi', 'line 1\nline 2']] },
]);

export default function (t) {
  t('xlsx: CRC-32 check value, column names, stored ZIP round trip', () => {
    t.eq(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
    t.eq([0, 25, 26, 51, 701, 702].map(colName), ['A', 'Z', 'AA', 'AZ', 'ZZ', 'AAA']);
    const z = unzipStore(zipStore([{ name: 'a.txt', data: new TextEncoder().encode('hello') }, { name: 'dir/b.xml', data: new Uint8Array([1, 2, 3]) }]));
    t.eq(dec.decode(z.get('a.txt')), 'hello');
    t.eq([...z.get('dir/b.xml')], [1, 2, 3]);
  });

  t('xlsx: the package parts are there; text is escaped, numbers stay numbers, bad sheet-name characters go', () => {
    const z = unzipStore(sample());
    for (const n of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) t.ok(z.has(n), 'missing ' + n);
    const wb = dec.decode(z.get('xl/workbook.xml')), s1 = dec.decode(z.get('xl/worksheets/sheet1.xml'));
    t.ok(wb.includes('name="Parts  A B "') || wb.includes('name="Parts  A B"'), wb);
    t.ok(s1.includes('<c r="B2"><v>4</v></c>') && s1.includes('<v>2.5</v>'), 'numbers');
    t.ok(s1.includes('&lt;&amp;&gt; &quot;q&quot;') && !s1.includes('\u0007'), 'escaping');
    t.ok(s1.includes('<autoFilter ref="A1:B4"/>') && s1.includes('state="frozen"'), 'header frozen + filter');
    t.ok(!/<c r="A4"/.test(s1), 'empty cells are left out');
  });

  t('xlsx: openpyxl reads the workbook back (when Python with openpyxl is on this PC)', () => {
    const py = spawnSync('python', ['-c', 'import openpyxl'], { encoding: 'utf8' });
    if (py.status !== 0) t.skip('python with openpyxl not available');
    const f = path.join(os.tmpdir(), `ecad-xlsx-${process.pid}.xlsx`);
    fs.writeFileSync(f, sample());
    try {
      const r = spawnSync('python', ['-c', `import openpyxl,json,sys\nwb=openpyxl.load_workbook(sys.argv[1])\nprint(json.dumps([[ws.title,[[c.value for c in row] for row in ws.iter_rows()],ws.freeze_panes,ws['A1'].font.b] for ws in wb.worksheets]))`, f], { encoding: 'utf8' });
      t.eq(r.status, 0, r.stderr);
      const [s1, s2] = JSON.parse(r.stdout);
      t.eq(s1[1].slice(0, 3), [['Part', 'Qty'], ['G7SA-3A1B', 4], ['<&> "q"', 2.5]]);
      t.eq([s1[2], s1[3]], ['A2', true]);
      t.eq(s2[1][1], ['multi', 'line 1\nline 2']);
    } finally { fs.rmSync(f, { force: true }); }
  });

  t('parts on drawings: a part number broken after a hyphen is joined; amp prefixes go', () => {
    t.eq(partsOfText('PS1\nS8VK-\nG24024\n(OMRON)'), ['S8VK-G24024']);
    t.eq(partsOfText('(5A) CP30FM-1P005W'), ['CP30FM-1P005W']);
    t.eq(partsOfText('CRPB1\nL1005'), []);
  });

  t('bom: quantity = listed devices; labels only count when nothing is listed; more labels than devices says check', () => {
    const page = (texts) => ({ id: 's/p01', texts: texts.map(([text, at], i) => ({ id: i + 1, text, at, keys: [String(text).replace(/\s/g, '').toUpperCase()] })) });
    const index = { pages: new Map([['s/p01', page([
      ['CR1', [100, 100]], ['G7SA-3A1B', [100, 120]],          // a label next to a listed relay
      ['CR9', [400, 100]], ['G7SA-3A1B', [400, 120]],          // a relay the layout does not list
      ['LY2N-DC24', [700, 300]], ['LY2N-DC24', [800, 300]],     // only on the drawings
    ])]]) };
    const modules = [{ id: 'm', box: '2PB', parts: [{ tag: 'CR1', part: 'G7SA-3A1B' }, { tag: 'CR2', part: 'G7SA-3A1B' }, { tag: 'PB1', part: 'AH165-TGFW11' }] }];
    const cabinets = [{ id: '1CE', components: [{ tag: 'CR2', part: 'G7SA-3A1B', w: 10, h: 10 }, { tag: 'CP9', part: 'CP-1P-TBD', w: 10, h: 10 }] }];
    const docs = [{ elements: [{ kind: 'symbol', tag: 'PB2', part: 'AH165-TGFW11' }, { kind: 'symbol', part: 'AH165-TGFW11' }] }];
    const bom = new Map(buildBom({ modules, cabinets, index, docs }).map((r) => [r.part, r]));
    const g7 = bom.get('G7SA-3A1B');
    t.eq([g7.qty, g7.tags], [2, ['CR1', 'CR2']]);
    t.ok(!g7.check, 'two labels, two listed devices: no check');
    t.eq(g7.drawingTags, ['CR9'], 'the unlisted relay is shown next to its label');
    t.eq(g7.locations.map((l) => [l.at, l.n]), [['2PB', 1], ['1CE', 1]].sort((a, b) => b[1] - a[1] || 0));
    t.eq([bom.get('LY2N-DC24').qty, bom.get('LY2N-DC24').basis], [2, 'labels on drawings']);
    t.eq(bom.get('AH165-TGFW11').qty, 3, 'module device + tagged symbol + untagged symbol');
    t.eq([bom.get('CP-1P-TBD').category, bom.get('CP-1P-TBD').basis], ['To be decided', 'part number to be decided']);
    for (const r of bom.values()) t.eq(r.locations.reduce((a, l) => a + l.n, 0), r.qty, `locations add up for ${r.part}`);
  });

  t('terminal plan: wires per side, bridges, what each terminal connects to; a cable core lands once', () => {
    const cabinet = { id: 'C1', terminal_strips: { TB1: { part: 'BN-X', terminals: [
      { pos: 1, up: 'P24A', down: 'P24A' }, { pos: 2, up: 'P24A', down: 'P24A' }, { pos: 3, up: 'X1', down: 'X2' }, { pos: 5, up: 'X1', down: 'X1' },
    ] } } };
    const wires = [{ no: 'P24A', from: { tag: 'TB1', pin: '1' }, to: { tag: 'CP1', pin: null }, line: 'L1' }, { no: 'X1', from: { tag: 'TB1', pin: '3' }, to: { tag: 'IN1', pin: '000' } }];
    const modules = [{ id: 'm', cables: [{ tag: 'W1', from: 'PB', to: 'C1', cores: [{ core: 1, wire: 'X2' }, { core: 2, wire: 'P24A' }] }] }];
    const [s] = terminalPlan({ cabinet, wires, modules }).strips;
    t.eq(s.terminals.map((x) => [x.pos, x.bridgeUp, x.bridgeDown]), [[1, true, true], [2, false, false], [3, false, false], [5, false, false]], 'pos 3 -> 5 is not adjacent');
    t.eq(s.terminals[0].links.map((l) => `${l.wire}>${l.to}`), ['P24A>CP1', 'P24A>W1 core 2 (PB → C1)']);
    t.eq(s.terminals[1].links, [], 'the cable core is not repeated on the bridged neighbour');
    t.eq(s.terminals[2].links.map((l) => `${l.wire}>${l.to}`), ['X1>IN1:000', 'X2>W1 core 1 (PB → C1)']);
    const L = wireLabels({ cabinet, wires, modules });
    const n = (src) => L.labels.filter((l) => l.source.startsWith(src)).length;
    t.eq(n('wire list'), 4, 'two ends per wire');
    t.eq(n('terminal strip'), 8 - 2, 'every wired side, minus the two the wire list already ends on');
    t.eq(n('cable'), 4, 'two ends per core');
    t.ok(labelsCsv(L).startsWith('﻿Mark;Position;Wire;Source\r\n"P24A";'), 'CSV with BOM and header');
  });

  t('bom of the example project: locations add up, Excel export opens', () => {
    if (!fs.existsSync(path.join(root, 'projects', '6451-M014', 'raw'))) t.skip('project 6451-M014 not on this PC (confidential, not in git)');
    const ctx = createProjectContext(root), bom = ctx.bom('6451-M014');
    t.ok(bom.length > 20);
    for (const r of bom) { t.ok(r.qty >= 1 && r.basis, r.part); t.eq(r.locations.reduce((a, l) => a + l.n, 0), r.qty, r.part); }
    const z = unzipStore(ctx.bomXlsx('6451-M014'));
    t.ok(dec.decode(z.get('xl/worksheets/sheet1.xml')).includes('<autoFilter'));
  });
}
