// lib/box.js must resolve every template exactly as ecad/box/loader.py does (until Python's copy is retired).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../server/store.js';
import { deepMerge, resolveBox } from '../lib/box.js';
import { evalTree } from '../lib/expr.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = createStore(root);
// The pilot project is confidential and not in git; its tests skip on a fresh clone.
const PROJECT = '6451-M014';
const needProject = (t) => { if (!fs.existsSync(path.join(root, 'projects', PROJECT, 'boxes', '1CE.yaml'))) t.skip(`project ${PROJECT} not on this PC (confidential, not in git)`); };

export default function (t) {
  t('deepMerge: lists replace, key+ appends, null deletes, dict+ appends per key', () => {
    const m = deepMerge({ a: [1], b: { x: 1, y: 2 }, f: { front: [1] } }, { a: [2], 'c+': [3], b: { y: null }, 'f+': { front: [2], back: [9] } });
    t.eq(m, { a: [2], b: { x: 1 }, f: { front: [1, 2], back: [9] }, c: [3] });
  });

  t('expressions: depend on each other across passes, unresolved never concatenates', () => {
    t.eq(evalTree({ p: { m: 30 }, e: { w: 700 }, pl: { w: '=e.w - 2 * p.m', x: '=pl.w + 1' } }).pl, { w: 640, x: 641 });
    t.eq(evalTree({ a: { s: "=pick(n, 5, 'CR{n}')" }, n: [1] }).a.s, 'CR{n}');
    t.throws(() => evalTree({ a: '=b.c', b: {} }), /unresolved/);
    t.throws(() => evalTree({ a: '=process.exit(1)' }), /not allowed/);
  });

  t('every library template resolves', () => {
    const boxes = store.boxes(null);
    t.ok(boxes.length >= 3, 'library/boxes is empty');
    for (const b of boxes) t.ok(!b.error, `${b.id}: ${b.error}`);
  });

  t('generic templates are parametric: plate and rails follow the enclosure', () => {
    const a = store.box('WM-400x500'), b = store.box('WM-600x800');
    t.eq([a.plate.width, a.plate.height, a.rails.length], [350, 450, 3]);
    t.eq([b.plate.width, b.plate.height, b.rails.length], [550, 750, 5]);
    t.eq(store.box('PB-3x2').faces.front.length, 4 + 6);
  });

  t('every project template resolves', () => {
    needProject(t);
    for (const b of store.boxes(PROJECT)) t.ok(!b.error, `${b.id}: ${b.error}`);
  });

  t('1CE: measured ducts stretch with the enclosure (1CE-B)', () => {
    needProject(t);
    const a = store.box('1CE', PROJECT), b = store.box('1CE-B', PROJECT);
    t.eq([a.plate.width, a.plate.height], [640, 940]);
    t.eq(a.ducts.find((d) => d.id === 'V2').x, 594.8);
    t.eq(b.ducts.find((d) => d.id === 'V2').x, 694.8);
    t.near(b.rails[0].length, 649.8, 1e-9);
  });

  t('2PB: grid holes carry the device labels', () => {
    needProject(t);
    const f = store.box('2PB', PROJECT).faces.front;
    t.eq(f.filter((h) => h.label).map((h) => h.label), ['PB5', 'SS2', 'PB/PL7', 'PL9', 'PB/PL6', 'PB8', 'PB11', 'PB/PL10', 'KS2']);
    t.eq(f.find((h) => h.label === 'KS2'), { shape: 'circle', x: 90, y: 28, d: 16, label: 'KS2' });
  });

  t('parity with Python loader', () => {
    let py;
    try {
      py = JSON.parse(execFileSync('python', ['-c', `
import json, sys
from pathlib import Path
from ecad.box.loader import load, list_boxes
out = {}
for b in list_boxes(Path("projects/${PROJECT}")):
    out[b["id"]] = load(b["id"], Path("projects/${PROJECT}")).model_dump(mode="json")
print(json.dumps(out))`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch (e) { return t.skip('python/pydantic not available: ' + String(e.message).split('\n')[0]); }
    const key = (t_) => ({
      enc: [t_.enclosure.width, t_.enclosure.height, t_.enclosure.depth, t_.enclosure.stand_height],
      plate: t_.plate ? [t_.plate.width, t_.plate.height, t_.plate.offset_x, t_.plate.offset_y] : null,
      ducts: t_.ducts.map((d) => [d.id, d.x, d.y, d.w, d.h]),
      rails: t_.rails.map((r) => [r.id, r.x, +r.y.toFixed(6), +r.length.toFixed(6)]),
      faces: Object.fromEntries(Object.entries(t_.faces).map(([k, v]) => [k, v.map((h) => [h.x, h.y, h.d ?? null, h.label ?? null])])),
      handle: t_.door.handle_pos ?? null,
    });
    for (const id of Object.keys(py)) t.eq(key(store.box(id, PROJECT)), key(py[id]), id);
  });
}
