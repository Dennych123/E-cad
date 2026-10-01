// Component catalogue of a project: every part number the project knows, merged from its modules,
// its cabinets and the part numbers written on its drawings. Each entry says what it is, who makes
// it, where it is used, and which library symbol draws it.
import { hasJapanese } from '../lib/i18n.js';

export const PART_RE = /^(?=.*\d)(?=.*[A-Z])[A-Z][A-Z0-9]{1,6}-[A-Z0-9][A-Z0-9()\-/.]{1,22}$/;
/** a part number written on a drawing line, e.g. "(3A) CP30FM-1P003WA" -> "CP30FM-1P003WA" */
export const partOfLine = (line) => { const s = String(line).trim().replace(/^\(\d+A\)\s*/, ''); return PART_RE.test(s) && !hasJapanese(s) ? s : null; };
/** part numbers in a text block; a number broken after a hyphen continues on the next line ("S8VK-" / "G24024") */
export function partsOfText(text) {
  const lines = String(text).split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean), out = [];
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    while (l.endsWith('-') && i + 1 < lines.length) l += lines[++i];
    const p = partOfLine(l);
    if (p) out.push(p);
  }
  return out;
}

// part-number prefix -> [maker, category]
const FAMILY = [
  [/^NX\d|^NX-/, 'Omron', 'PLC & I/O'], [/^CJ\d|^CJ1W/, 'Omron', 'PLC & I/O'], [/^S8V/, 'Omron', 'Power supply'],
  [/^G7SA|^G9SA/, 'Omron', 'Safety relay'], [/^LY\d|^MY\d|^G2R|^G6D/, 'Omron', 'Relay'], [/^DRT2|^SRT2/, 'Omron', 'Remote I/O'],
  [/^E3|^EE-|^E2E|^F3SG/, 'Omron', 'Sensor'], [/^NS\d|^NB\d/, 'Omron', 'HMI'],
  [/^AH165|^AR22|^DR22/, 'Fuji Electric', 'Operator device'], [/^CP30|^CP31/, 'Fuji Electric', 'Circuit protector'],
  [/^BW|^EW|^SA\d/, 'Fuji Electric', 'Breaker'], [/^SC-|^SK\d/, 'Fuji Electric', 'Contactor'],
  [/^XW1E|^XA1E|^HW/, 'IDEC', 'Operator device'], [/^JXC|^LE[A-Z]/, 'SMC', 'Actuator controller'],
  [/^RSEN|^RSAN/, 'TDK-Lambda', 'Noise filter'], [/^VCTF|^GRNM/, 'Misumi', 'Cable / harness'],
  [/^BN[DHL]|^BDR/, 'Toyogiken', 'Terminal block'], [/^LME|^LR\d|^L2R/, 'Patlite', 'Signal tower'],
  [/^T-MU/, 'Nitto Kogyo', 'Fan'], [/^A475/, 'Takigen', 'Hardware'], [/^AZD|^AR/, 'Oriental Motor', 'Motor driver'],
];
// category -> library symbol ids that draw it (first = default)
const SYMBOLS = {
  'Relay': ['g-24-53x10-03', 'm-no-contact-a'], 'Safety relay': ['g-24-53x10-03', 'm-g7sa-3a1b'],
  'Circuit protector': ['m-breaker-3'], 'Breaker': ['m-breaker-2'], 'Noise filter': ['m-noise-filter'],
  'Terminal block': ['m-tb', 'm-terminal-a'], 'Operator device': ['g-30x8-98', 'm-ss', 'g-20x8'],
  'Sensor': ['g-24-35x7-28'], 'Signal tower': ['g-30x8-98'],
};

function family(part) {
  for (const [re, maker, cat] of FAMILY) if (re.test(part)) return { maker, category: cat };
  return { maker: null, category: 'Other' };
}

export function buildCatalog({ modules = [], cabinets = [], index = null }) {
  const cat = new Map();
  const get = (part) => {
    const k = part.toUpperCase().trim();
    if (!cat.has(k)) cat.set(k, { part: k, name: null, ...family(k), footprint: null, tags: new Set(), modules: new Set(), sheets: new Map(), sources: new Set() });
    return cat.get(k);
  };
  for (const m of modules) for (const p of m.parts || []) {
    if (!p.part || /TBD/i.test(p.part) || p.part.includes('{')) continue;
    const e = get(p.part);
    e.name ||= p.name || null;
    if (p.maker) e.maker = p.maker;
    if (p.w && p.h) e.footprint ||= [p.w, p.h];
    if (p.tag && !p.tag.includes('{')) e.tags.add(p.tag);
    e.modules.add(m.id); e.sources.add('module');
  }
  for (const c of cabinets) for (const x of c.components || []) {
    if (!x.part) continue;
    const e = get(x.part);
    e.footprint ||= [x.w, x.h];
    e.tags.add(x.tag); e.sources.add('cabinet ' + c.id);
  }
  if (index) for (const pg of index.pages.values()) for (const t of pg.texts) {
    for (const s of partsOfText(t.text)) {
      const e = get(s);
      e.sheets.set(pg.id, (e.sheets.get(pg.id) || 0) + 1);
      e.sources.add('drawing');
    }
  }
  return [...cat.values()].map((e) => ({
    part: e.part, name: e.name, maker: e.maker, category: e.category, footprint: e.footprint,
    tags: [...e.tags].sort(), modules: [...e.modules], sheets: [...e.sheets].map(([page, n]) => ({ page, n })),
    sources: [...e.sources], symbols: SYMBOLS[e.category] || [],
  })).sort((a, b) => a.category.localeCompare(b.category) || a.part.localeCompare(b.part));
}
