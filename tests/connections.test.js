// Wires derived from the drawings must be the wires a technician reads off the sheets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSheetIndex } from '../server/sheets.js';
import { cabinetWires } from '../server/connections.js';
import { createStore } from '../server/store.js';
import { createDocStore } from '../server/docs.js';
import { routeWires, buildDuctGraph } from '../lib/route.js';
import { buildNets } from '../lib/nets.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(root, 'projects', '6451-M014', 'raw');
let cache = null;
const data = (t) => {
  if (!fs.existsSync(RAW)) t.skip('project 6451-M014 not imported (raw/ is not in git: confidential drawings)');
  if (!cache) {
    const store = createStore(root);
    const cab = store.cabinet('6451-M014', '1CE');
    cache = { ix: buildSheetIndex(createDocStore(root), '6451-M014'), cab, box: store.box('1CE', '6451-M014') };
    cache.r = cabinetWires(cache.ix, cab);
  }
  return cache;
};
const has = (ws, a, b) => ws.some((w) => (w.from.tag === a && w.to.tag + (w.to.pin ? ':' + w.to.pin : '') === b) || (w.to.tag === a && w.from.tag + (w.from.pin ? ':' + w.from.pin : '') === b));

export default function (t) {
  t('nets: a crossing without an endpoint does not join, a T does', () => {
    const S = [[0, 0, 10, 0, 1], [5, -5, 5, 5, 2], [10, 0, 10, 10, 3]];  // + crossing at (5,0); T/corner at (10,0)
    const n = buildNets(S);
    t.ok(n[0] !== n[1], 'crossing joined');
    t.ok(n[0] === n[2], 'corner not joined');
  });

  t('PLC input rungs: contact -> input unit bit, marked with the address', (tt) => {
    const { r } = data(t);
    t.ok(has(r.wires, 'CRPB1', 'IN1:000'), 'CRPB1 -> IN1:000');
    t.ok(has(r.wires, 'CRPS1', 'IN1:001'), 'CRPS1 -> IN1:001');
    t.ok(has(r.wires, 'CRLS2A', 'IN1:010'), 'CRLS2A -> IN1:010');
    t.eq(r.wires.find((w) => w.from.tag === 'CRPB1' && w.to.tag === 'IN1').no, '0000 00');
  });

  t('the contact separates its two sides: no P24A wire lands on a PLC input', () => {
    const { r } = data(t);
    t.ok(!r.wires.some((w) => w.no === 'P24A' && (w.from.tag.startsWith('IN') || w.to.tag.startsWith('IN'))), 'P24A reached an input');
  });

  t('unit headers map addresses to units in order (CH00..02 inputs, CH03..05 outputs)', () => {
    const { r } = data(t);
    t.eq(r.units, { CH00: 'IN1', CH01: 'IN2', CH02: 'IN3', CH03: 'OUT1', CH04: 'OUT2', CH05: 'OUT3' });
  });

  t('every wire routes through the ducts', () => {
    const { r, cab, box } = data(t);
    const routes = routeWires(box, cab.components, r.wires);
    t.ok(routes.every((x) => x.ok), 'unrouted: ' + routes.filter((x) => !x.ok).map((x) => x.id));
    t.ok(buildDuctGraph(box.ducts).nodes.length > 8);
  });
}
