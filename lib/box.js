// Box (enclosure) templates: inheritance, expressions, generators, defaults.
// Pure data in, pure data out: shared by Node and the browser, never imports three.
// Same rules as ecad/box/loader.py (kept in parity by tests/box.test.js):
//   extends: parent id    maps merge, lists replace, `key+` appends (dict value: per sub-key), null deletes
//   "=expr" values        see lib/expr.js
//   hole_grids, auto_layout  generators, expanded on resolve
import { evalTree } from './expr.js';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return structuredClone(over);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    if (k.endsWith('+')) {
      const key = k.slice(0, -1);
      if (isObj(v)) {
        const cur = (out[key] = isObj(out[key]) ? out[key] : {});
        for (const [sk, sv] of Object.entries(v)) cur[sk] = [...(cur[sk] || []), ...structuredClone(sv || [])];
      } else out[key] = [...(out[key] || []), ...structuredClone(v || [])];
    } else if (v === null) delete out[k];
    else if (k in out) out[k] = deepMerge(out[k], v);
    else out[k] = structuredClone(v);
  }
  return out;
}

/** Raw template with its extends chain merged. `raws` maps id -> parsed YAML. */
export function mergeChain(id, raws, seen = []) {
  if (seen.includes(id)) throw new Error('circular extends: ' + [...seen, id].join(' -> '));
  const raw = raws[id];
  if (!raw) throw new Error(`box template '${id}' not found`);
  if (!raw.extends) return structuredClone(raw);
  const base = mergeChain(raw.extends, raws, [...seen, id]);
  delete base.abstract;
  const out = deepMerge(base, raw);
  out.extends = raw.extends;
  if (!raw.abstract) delete out.abstract;
  return out;
}

export function chainOf(id, raws) {
  const out = [];
  for (let cur = raws[id]?.extends; cur; cur = raws[cur]?.extends) out.push(cur);
  return out;
}

const DEFAULTS = {
  enclosure: { kind: 'wall_mount', stand_height: 0, material: 'SPHC', paint: 'MUNSELL 5Y8/1', thickness: {} },
  door: { hinge: 'right', open_angle: 120, handle: null, handle_pos: null },
  plate: { thickness: 2.3, offset_x: 30, offset_y: 30, material: 'SPHC' },
  hole: { shape: 'circle' },
  rail: { part: 'PFP-100N', width: 35 },
};

function expand(t) {
  t.faces = t.faces || {};
  for (const [face, grids] of Object.entries(t.hole_grids || {})) {
    const holes = (t.faces[face] = t.faces[face] || []);
    for (const g of grids) {
      const skip = new Set((g.skip || []).map(([c, r]) => `${c},${r}`));
      const fromTop = g.from_top !== false;
      let li = 0;
      for (let r = 0; r < g.rows; r++) {
        for (let c = 0; c < g.cols; c++) {
          if (skip.has(`${c},${r}`)) continue;
          const label = (g.labels || [])[li++] ?? null;
          holes.push({ x: g.x0 + c * g.pitch_x, y: fromTop ? g.y0 - r * g.pitch_y : g.y0 + r * g.pitch_y, d: g.d, label });
        }
      }
    }
  }
  delete t.hole_grids;

  t.ducts = t.ducts || [];
  t.rails = t.rails || [];
  const a = t.auto_layout;
  if (a && t.plate && !t.ducts.length) {
    const W = t.plate.width, H = t.plate.height;
    const dw = a.duct_w ?? 40, sw = a.side_duct_w ?? 45;
    t.ducts.push({ id: 'V1', x: 0, y: 0, w: sw, h: H, size: a.side_duct_size ?? 'W45XH65' });
    t.ducts.push({ id: 'V2', x: W - sw, y: 0, w: sw, h: H, size: a.side_duct_size ?? 'W45XH65' });
    const free = H - (a.rows + 1) * dw;
    const gaps = a.gaps?.length ? a.gaps : Array(a.rows).fill(free / a.rows);
    if (Math.abs(gaps.reduce((s, g) => s + g, 0) - free) > 0.5) throw new Error(`auto_layout gaps do not sum to ${free}`);
    const letters = 'FEDCBAGHIJKL';
    let y = 0;
    for (let i = 0; i <= a.rows; i++) {
      t.ducts.push({ id: 'H' + letters[i], x: 0, y, w: W, h: dw, size: a.duct_size ?? 'W40XH60' });
      if (i < a.rows) {
        t.rails.push({ id: `R${i + 1}`, x: sw, y: y + dw + gaps[i] / 2, length: W - 2 * sw, part: a.rail_part ?? 'PFP-100N', width: 35 });
        y += dw + gaps[i];
      }
    }
  }
  delete t.auto_layout;
  return t;
}

function applyDefaults(t) {
  t.enclosure = { ...DEFAULTS.enclosure, ...t.enclosure };
  t.door = { ...DEFAULTS.door, ...(t.door || {}) };
  if (t.plate) t.plate = { ...DEFAULTS.plate, ...t.plate };
  for (const k of Object.keys(t.faces)) t.faces[k] = t.faces[k].map((h) => ({ ...DEFAULTS.hole, ...h }));
  t.rails = t.rails.map((r) => ({ ...DEFAULTS.rail, ...r }));
  for (const k of ['tags', 'source', 'components', 'accessories', 'notes', 'review']) t[k] = t[k] || [];
  t.params = t.params || {};
  return t;
}

/** Fully resolved template: chain merged, expressions evaluated, generators expanded, defaults set. */
export function resolveBox(id, raws) {
  const merged = mergeChain(id, raws);
  const abstract = !!merged.abstract;
  delete merged.abstract;
  const t = applyDefaults(expand(evalTree(merged)));
  const errs = validateBox(t);
  if (errs.length) throw new Error(`box '${id}': ` + errs.join('; '));
  t.abstract = abstract;
  t.chain = chainOf(id, raws);
  return t;
}

export function validateBox(t) {
  const e = [];
  const num = (v, name) => { if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) e.push(`${name} must be a positive number (got ${v})`); };
  if (!t.id) e.push('id missing');
  num(t.enclosure?.width, 'enclosure.width');
  num(t.enclosure?.height, 'enclosure.height');
  num(t.enclosure?.depth, 'enclosure.depth');
  if (t.plate) {
    num(t.plate.width, 'plate.width');
    num(t.plate.height, 'plate.height');
    if (t.plate.offset_x + t.plate.width > t.enclosure.width + 0.5) e.push('plate wider than enclosure');
    if (t.plate.offset_y + t.plate.height > t.enclosure.height + 0.5) e.push('plate taller than enclosure');
  }
  for (const [face, holes] of Object.entries(t.faces || {})) {
    holes.forEach((h, i) => { if (!(h.d > 0) && !(h.w > 0 && h.h > 0)) e.push(`faces.${face}[${i}] needs d or w/h`); });
  }
  if (!['left', 'right', 'top', 'none'].includes(t.door?.hinge)) e.push(`door.hinge '${t.door?.hinge}' invalid`);
  return e;
}
