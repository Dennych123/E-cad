// The editable sheet document: geometry transforms, what the indexer sees, and parity with the import.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { symPoint, moved, rotated, elementShapes, elementBox, docToRawPage, symbolElement, PT } from '../lib/sheetdoc.js';
import { indexPage } from '../lib/sheetindex.js';
import { buildDict, translate } from '../lib/i18n.js';
import { createDocStore, splitVisioSvg } from '../server/docs.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = '6451-M014';
const haveProject = () => fs.existsSync(path.join(root, 'projects', PROJECT, 'raw'));

const SYM = { id: 's', name: 'NO contact', size: [20, 5], pins: [{ id: '1', at: [0, 2.5] }, { id: '2', at: [20, 2.5] }],
  paths: [{ pts: [[0, 2.5], [9, 2.5]], closed: false }, { pts: [[11, 2.5], [20, 2.5]], closed: false }, { pts: [[9, 1], [9, 4]], closed: false }, { pts: [[11, 1], [11, 4]], closed: false }] };
const doc = { widthMm: 420, heightMm: 297, width: 420 * PT, height: 297 * PT, elements: [] };

export default function (t) {
  t('symbol frame: rotation turns about the insertion point, pins follow', () => {
    const e = symbolElement(SYM, 1000000, 100, 200, { tag: 'CR1' });
    t.eq(symPoint(e, [0, 0]), [100, 200]);
    t.eq(symPoint(e, [20, 0]).map(Math.round), [157, 200]);            // +x is right
    t.eq(symPoint(e, [0, 5]).map(Math.round), [100, 186]);             // +y (mm, up) is up on screen
    const r = rotated(e, 100, 200);                                    // 90 deg clockwise on screen
    t.eq(r.rot, 270);
    t.eq(symPoint(r, [20, 0]).map(Math.round), [100, 257]);           // right -> down
  });

  t('move keeps kinds: symbol/text move their anchor, wires every point, imported shapes an offset', () => {
    t.eq(moved({ kind: 'wire', pts: [[0, 0], [10, 0]] }, 5, 7).pts, [[5, 7], [15, 7]]);
    const v = moved({ kind: 'visio', dx: 1, dy: 2, shapes: [] }, 3, 4);
    t.eq([v.dx, v.dy], [4, 6]);
  });

  t('a placed symbol reaches the indexer as a group with its tag inside (device ownership works)', () => {
    const e = symbolElement(SYM, 1000000, 100, 200, { tag: 'CR7' });
    const shapes = elementShapes(e, doc);
    t.eq(shapes[0].type, 'group');
    t.ok(shapes.some((s) => s.parent === e.id && s.text === 'CR7'), 'tag text missing');
    const wire = { id: 1000001, kind: 'wire', pts: [symPoint(e, [20, 2.5]), [symPoint(e, [20, 2.5])[0] + 60, symPoint(e, [20, 2.5])[1]]] };
    const ix = indexPage(docToRawPage({ ...doc, elements: [e, wire] }));
    t.ok(ix.texts.some((x) => x.keys.includes('CR7')), 'indexer did not see the tag');
    t.eq(ix.owner[e.id * 1000 + 2], 'CR7');                            // the right lead belongs to CR7
    const [x, y, w, h] = elementBox(e, doc);
    t.ok(w > 50 && h > 10 && x === 100 && y < 200, `box ${[x, y, w, h]}`);
  });

  t('i18n: whitespace/width-insensitive, master suffixes, punctuation', () => {
    const d = buildDict({ '承認 APPROVED': 'APPROVED', 'B接点': 'NC contact (b)' });
    t.eq(translate('承認\n APPROVED', d), 'APPROVED');
    t.eq(translate('B接点.8', d), 'NC contact (b).8');
    t.eq(translate('２', d), '2');
    t.eq(translate('AUTO・IND', d), 'AUTO / IND');
    t.eq(translate('未知の文字', d), null);
    t.eq(translate('plain', d), null);
  });

  t('Visio SVG splits into css, background and one part per top-level shape', () => {
    const svg = `<svg viewBox="0 0 100 50" class="st9"><style><![CDATA[.st1{fill:none}]]></style><defs id="m"><marker id="a"/></defs>
      <g v:groupContext="backgroundPage"><g id="shape9-1"><text>BG</text></g></g>
      <g v:groupContext="foregroundPage"><title>P1</title><v:pageProperties/><g id="shape1-1"><g id="shape2-2"/></g><g id="group3-5"><path d="M0 0"/></g></g></svg>`;
    const s = splitVisioSvg(svg);
    t.eq([s.width, s.height, s.rootClass, s.css], [100, 50, 'st9', '.st1{fill:none}']);
    t.ok(s.defs.includes('marker') && s.background.includes('BG'));
    t.eq(s.parts.length, 2);
    t.ok(s.parts[1].startsWith('<g id="group3-5"'));
  });

  t('every imported page converts to a document that indexes exactly like the import', () => {
    if (!haveProject()) t.skip(`project ${PROJECT} not on this PC (confidential, not in git)`);
    const docs = createDocStore(root);
    let n = 0;
    for (const dr of docs.list(PROJECT)) for (const pg of dr.pages) {
      const raw = docs.rawPage(PROJECT, pg.id);
      if (!raw) continue;                                              // edited sheet: nothing to compare
      const a = indexPage(raw), b = indexPage(docToRawPage(docs.get(PROJECT, pg.id)));
      t.eq([b.segs.length, b.texts.length, b.rows.length], [a.segs.length, a.texts.length, a.rows.length], pg.id);
      n++;
    }
    t.ok(n > 20, 'expected the imported pages');
  });
}
