// Build a symbol library from an imported project's drawings.
//   node tools/extract-symbols.js <project>          -> projects/<p>/symbols/library.json
// A symbol = a Visio master (by name) or a masterless group that repeats (by geometry).
// Pins are taken from the drawings themselves: where wires actually end on the symbol's instances.
// Names come from the i18n dictionaries (masters) and projects/<p>/symbols/names.yaml (curated).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { buildDict, translate } from '../lib/i18n.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_SIZE = 120;            // mm: bigger groups are frames and tables, not symbols
const SKIP_MASTERS = /^(Dynamic connector|1-D single|wire 2)$/i;

const stem = (m) => m?.normalize('NFKC').replace(/\.\d+$/, '').trim() || null;
const r2 = (v) => Math.round(v * 2) / 2;
const closed = (p) => p.length > 2 && Math.hypot(p[0][0] - p.at(-1)[0], p[0][1] - p.at(-1)[1]) < 0.01;

function readYaml(f) { return fs.existsSync(f) ? yaml.load(fs.readFileSync(f, 'utf8')) || {} : {}; }

function category(name, texts, master) {
  const s = `${name} ${master || ''} ${texts.join(' ')}`;
  if (/contact|接点/i.test(s)) return 'contacts';
  if (/G7SA|G9SA|relay|LY2|MY2/i.test(s)) return 'relays';
  if (/terminal|端子|TB/i.test(s)) return 'terminals';
  if (/breaker|fuse|noise filter/i.test(s)) return 'protection';
  if (/SOL|coil|solenoid/i.test(s)) return 'coils';
  if (/lamp|^PL|selector|SS|push|PB/i.test(s)) return 'operator';
  if (/arrow|矢印|reference|connector|→/i.test(s)) return 'references';
  if (/process|decision|terminator/i.test(s)) return 'flowchart';
  if (/hex|nut|bolt|fillet|screw|washer/i.test(s)) return 'mechanical';
  if (/dimension|寸法|diameter|centerline|radius|angle|ordinate|horizontal|vertical/i.test(s)) return 'dimensions';
  return 'other';
}

export function extractSymbols(project) {
  const raw = path.join(root, 'projects', project, 'raw');
  const dict = buildDict(readYaml(path.join(root, 'library', 'i18n', 'ja-en.yaml')), readYaml(path.join(root, 'projects', project, 'i18n', 'ja-en.yaml')));
  const curated = readYaml(path.join(root, 'projects', project, 'symbols', 'names.yaml'));
  const found = new Map();

  for (const f of fs.readdirSync(raw).sort()) {
    const dir = path.join(raw, f);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const pf of fs.readdirSync(dir).filter((x) => /^p\d+\.json$/.test(x)).sort()) {
      const pg = JSON.parse(fs.readFileSync(path.join(dir, pf), 'utf8'));
      const kids = new Map();
      for (const s of pg.shapes) { if (!kids.has(s.parent)) kids.set(s.parent, []); kids.get(s.parent).push(s); }
      const desc = (s) => { const out = [], st = [s]; while (st.length) { const c = st.pop(); out.push(c); st.push(...(kids.get(c.id) || [])); } return out; };
      const byId = new Map(pg.shapes.map((s) => [s.id, s]));
      const masterAbove = (s) => { for (let c = byId.get(s.parent); c; c = byId.get(c.parent)) if (c.master) return true; return false; };
      // a symbol is a master instance (at any depth, unless inside another master) or a top-level group
      // (background pages contribute their masters - off/on-page references - but not their title-block groups)
      const cands = pg.shapes.filter((s) => (s.master ? !masterAbove(s) : !pg.background && s.depth === 0 && s.type === 'group') && !SKIP_MASTERS.test(stem(s.master) || ''));
      // free-standing wire segments on this page (open strokes that are not part of a symbol)
      const wires = [];
      for (const s of pg.shapes) if (s.depth === 0 && s.type !== 'group' && !s.master && s.paths && s.line_pattern !== 0)
        for (const p of s.paths) if (!closed(p)) for (let i = 1; i < p.length; i++) wires.push([p[i - 1], p[i]]);

      for (const s of cands) {
        const [x0, y0, x1, y1] = s.bbox;
        if (x1 - x0 > MAX_SIZE || y1 - y0 > MAX_SIZE || (x1 - x0) + (y1 - y0) < 2) continue;
        // Off-page shapes are the drafter's private stencil (masters parked beside the sheet): keep them
        // as library items, but they carry no wiring evidence, so they cast no pin votes.
        const offPage = x1 < 0 || y1 < 0 || x0 > pg.width_mm || y0 > pg.height_mm;
        const all = desc(s);
        const geo = all.filter((c) => c.paths && (c.line_pattern !== 0 || c.fill_pattern > 0));
        if (!geo.length) continue;
        const sigGeo = geo.flatMap((c) => c.paths.map((p) => p.map(([x, y]) => `${r2(x - x0)},${r2(y - y0)}`).join(' '))).sort().join(';');
        const master = stem(s.master);
        const key = master ? 'M:' + master : 'G:' + sigGeo;
        const texts = all.filter((c) => c.text).map((c) => c.text);
        if (!found.has(key)) {
          found.set(key, {
            key, master, count: 0, instances: [], pinVotes: new Map(),
            w: +(x1 - x0).toFixed(2), h: +(y1 - y0).toFixed(2),
            paths: geo.flatMap((c) => c.paths.map((p) => ({
              pts: p.map(([x, y]) => [+(x - x0).toFixed(2), +(y - y0).toFixed(2)]),
              closed: closed(p), fill: c.fill_pattern > 0 && closed(p), stroke: c.line_pattern !== 0,
              weight: c.line_weight_pt || 0.72,
            }))),
            texts: all.filter((c) => c.text && c.text_pos).map((c) => ({
              text: c.text, at: [+(c.text_pos[0] - x0).toFixed(2), +(c.text_pos[1] - y0).toFixed(2)], size: c.text_size_pt || 8,
              role: /^\(\d+\)$/.test(c.text.trim()) ? 'pin-number' : /^[A-Z][A-Z0-9]*\d/.test(c.text.trim().replace(/\s+/g, '')) ? 'tag' : 'label',
            })),
            sampleTexts: new Set(),
          });
        }
        const e = found.get(key);
        e.count++;
        if (e.instances.length < 12) e.instances.push({ page: `${f}/${pf.slice(0, -5)}`, id: s.id });
        for (const t of texts) if (e.sampleTexts.size < 8) e.sampleTexts.add(t.replace(/\s+/g, ' ').trim());
        // Pins, voted over every instance. Three kinds of evidence:
        //  - a wire ends inside the symbol's box (classic Visio glue)
        //  - a wire runs THROUGH the box (Denso: straight rung, symbol laid on top) -> where it crosses the edge
        //  - the symbol's own lead ends on its box edge
        const vote = (x, y) => { const k = `${r2(x - x0)},${r2(y - y0)}`; e.pinVotes.set(k, (e.pinVotes.get(k) || 0) + 1); };
        const T = 0.6, inBox = (x, y) => x >= x0 - T && x <= x1 + T && y >= y0 - T && y <= y1 + T;
        const seen = new Set(), once = (x, y) => { const k = `${r2(x)},${r2(y)}`; if (!seen.has(k)) { seen.add(k); vote(x, y); } };
        for (const [a, b] of offPage ? [] : wires) {
          const ina = inBox(...a), inb = inBox(...b);
          if (ina && !inb) once(...a); else if (inb && !ina) once(...b);
          else if (!ina && !inb) {
            // crossing: intersect with the box edges
            const hits = [];
            for (const [ex, ey, fx, fy] of [[x0, y0, x0, y1], [x1, y0, x1, y1], [x0, y0, x1, y0], [x0, y1, x1, y1]]) {
              const d = (b[0] - a[0]) * (fy - ey) - (b[1] - a[1]) * (fx - ex);
              if (Math.abs(d) < 1e-9) continue;
              const t = ((ex - a[0]) * (fy - ey) - (ey - a[1]) * (fx - ex)) / d, u = ((ex - a[0]) * (b[1] - a[1]) - (ey - a[1]) * (b[0] - a[0])) / d;
              if (t >= 0 && t <= 1 && u >= 0 && u <= 1) hits.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
            }
            if (hits.length === 2) for (const h of hits) once(...h);
          }
        }
        for (const c of geo) for (const p of c.paths) if (!closed(p)) for (const q of [p[0], p.at(-1)])
          if (Math.abs(q[0] - x0) < 0.3 || Math.abs(q[0] - x1) < 0.3 || Math.abs(q[1] - y0) < 0.3 || Math.abs(q[1] - y1) < 0.3) once(...q);
      }
    }
  }

  const symbols = [], ids = new Set();
  for (const e of found.values()) {
    if (!e.master && e.count < 2) continue;                     // one-off drawings are not stencil items
    const auto = e.master ? (translate(e.master, dict) || e.master) : null;
    let id = (e.master ? 'm-' + (auto || e.master) : `g-${e.w}x${e.h}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    for (let k = 2; ids.has(id); k++) id = id.replace(/--\d+$/, '') + '--' + k;   // same size, different drawing
    ids.add(id);
    const cur = curated[id] || {};
    const minVotes = Math.max(1, Math.ceil(e.count * 0.3));
    let pinPts = [...e.pinVotes].filter(([, v]) => v >= minVotes).map(([k]) => k.split(',').map(Number));
    // curated pin rules for symbols where the drawings' evidence is noisy
    const allPts = e.paths.flatMap((p) => p.pts);
    const ext = (axis, pick) => allPts.reduce((b, q) => (b === null || pick(q[axis], b[axis]) ? q : b), null);
    if (cur.pins === 'none') pinPts = [];
    else if (cur.pins === 'ends-h') pinPts = [ext(0, (a, b) => a < b), ext(0, (a, b) => a > b)];
    else if (cur.pins === 'ends-v') pinPts = [ext(1, (a, b) => a > b), ext(1, (a, b) => a < b)];
    else if (Array.isArray(cur.pins)) pinPts = cur.pins;
    const pins = pinPts.filter(Boolean).map(([x, y]) => [r2(x), r2(y)]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .map(([x, y], i) => ({ id: String(i + 1), at: [x, y] }));
    const name = cur.name || auto || `Symbol ${e.w}×${e.h}`;
    symbols.push({
      id, name, category: cur.category || category(name, [...e.sampleTexts], e.master),
      master: e.master, masterEn: auto, count: e.count, size: [e.w, e.h],
      paths: e.paths, texts: e.texts.map((t) => ({ ...t, en: translate(t.text, dict) })), pins,
      samples: [...e.sampleTexts], instances: e.instances,
      description: cur.description || null, hidden: !!cur.hidden,
    });
  }
  symbols.sort((a, b) => a.category.localeCompare(b.category) || b.count - a.count);
  return symbols;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const project = process.argv[2];
  if (!project) { console.error('usage: node tools/extract-symbols.js <project>'); process.exit(2); }
  const syms = extractSymbols(project);
  const out = path.join(root, 'projects', project, 'symbols', 'library.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ project, generated: new Date().toISOString(), symbols: syms }, null, 1));
  const by = {};
  for (const s of syms) by[s.category] = (by[s.category] || 0) + 1;
  console.log(`${syms.length} symbols -> ${out}`);
  console.log(Object.entries(by).map(([k, v]) => `${k}: ${v}`).join(', '));
}
