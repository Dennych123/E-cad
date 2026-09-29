// Index of the imported Visio sheets: texts, line-number rows (Denso "L1005" margin), wire segments,
// and a project-wide cross-reference by normalised token. Built from raw/<file>/pNN.json.
// Coordinates returned in SVG user units of Visio's own export (points, y down), so the browser can
// overlay highlights directly on the original drawing.
import fs from 'node:fs';
import path from 'node:path';

const PT = 72 / 25.4;
const LINE_RE = /^L\d{3,6}$/;
// identifiers worth cross-referencing: a letter and a digit, short, no spaces after normalising
const KEY_RE = /^(?=.*[A-Z])(?=.*\d)[A-Z0-9][A-Z0-9_./\-]{1,15}$/;

const ROLE = [
  [/Ａ接点|A接点/, 'NO contact'], [/Ｂ接点|B接点/, 'NC contact'], [/G7SA|G9SA|LY2|MY2|RELAY/i, 'relay'],
  [/BREAKER/i, 'breaker'], [/SOL/i, 'solenoid'], [/ＳＳ|^SS/, 'selector'], [/端子|^TB/, 'terminal'],
  [/Off-page|On-page/i, 'reference'], [/矢印|→線|arrow/i, 'arrow'], [/Noise Filter/i, 'noise filter'],
];

export const normKey = (s) => s.toUpperCase().replace(/[\s　]+/g, '');

function roleOf(masters) {
  for (const m of masters) for (const [re, r] of ROLE) if (m && re.test(m)) return r;
  return null;
}

/** one page -> {texts, rows, segs} in SVG points */
function indexPage(d) {
  const Hpt = d.height_mm * PT;
  const P = (x, y) => [+(x * PT).toFixed(2), +(Hpt - y * PT).toFixed(2)];
  const byId = new Map(d.shapes.map((s) => [s.id, s]));
  const mastersOf = (s) => { const out = []; for (let c = s; c; c = byId.get(c.parent)) out.push(c.master); return out; };
  const onPage = (b) => b[2] > 0 && b[3] > 0 && b[0] < d.width_mm && b[1] < d.height_mm;

  const texts = [];
  for (const s of d.shapes) {
    if (!s.text || !onPage(s.bbox)) continue;
    const [x0, y1] = P(s.bbox[0], s.bbox[1]), [x1, y0] = P(s.bbox[2], s.bbox[3]);
    // the box centre, not TxtPin: some Denso masters pin their text at a corner
    const [tx, ty] = [+((x0 + x1) / 2).toFixed(2), +((y0 + y1) / 2).toFixed(2)];
    const key = normKey(s.text);
    const lines = s.text.split(/[\r\n]+/).map((l) => normKey(l)).filter(Boolean);
    texts.push({ id: s.id, text: s.text, key: KEY_RE.test(key) ? key : null,
      keys: [...new Set([key, ...lines].filter((k) => KEY_RE.test(k)))],
      box: [x0, y0, x1 - x0, y1 - y0], at: [tx, ty], role: roleOf(mastersOf(s)) });
  }

  // row-label columns: L-numbers stacked at (nearly) the same x, at least 5 of them
  const cols = new Map();
  for (const t of texts) if (LINE_RE.test(t.key || '')) {
    const bin = Math.round(t.at[0] / 12);
    if (!cols.has(bin)) cols.set(bin, []);
    cols.get(bin).push(t);
  }
  // A real margin column counts up by one down the page (L1001, L1002, ...). Contact tables under
  // coils also stack L-numbers at one x, but those jump around, so they fail this test.
  const rows = [];
  for (const list of cols.values()) {
    if (list.length < 5) continue;
    list.sort((a, b) => a.at[1] - b.at[1]);
    const n = list.map((t) => Number(t.key.slice(1)));
    let seq = 0;
    for (let i = 1; i < n.length; i++) if (n[i] === n[i - 1] + 1) seq++;
    if (seq / (n.length - 1) < 0.8) continue;
    for (const t of list) { t.row = true; rows.push({ label: t.key, x: t.at[0], y: t.at[1] }); }
  }
  rows.sort((a, b) => a.x - b.x || a.y - b.y);
  const colXs = [...new Set(rows.map((r) => Math.round(r.x)))].sort((a, b) => a - b);

  // row pitch measured inside each column (sheets with two columns interleave their y values)
  const gaps = [];
  for (const cx of new Set(rows.map((r) => Math.round(r.x)))) {
    const ys = rows.filter((r) => Math.round(r.x) === cx).map((r) => r.y).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) gaps.push(ys[i] - ys[i - 1]);
  }
  gaps.sort((a, b) => a - b);
  const pitch = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 30;
  // Denso sheets write a device tag ABOVE its symbol, so a text belongs to the row a little below it
  const lineAt = (x, y0) => {
    const y = y0 + pitch * 0.35;
    const cx = colXs.filter((c) => c <= x + 2).pop() ?? colXs[0];
    if (cx === undefined) return null;
    let best = null;
    for (const r of rows) if (Math.round(r.x) === cx && (!best || Math.abs(r.y - y) < Math.abs(best.y - y))) best = r;
    return best && Math.abs(best.y - y) < pitch * 1.2 ? best.label : null;
  };
  for (const t of texts) t.line = t.row ? t.key : lineAt(t.at[0], t.at[1]);

  // Wires. Denso sheets draw a rung as ONE straight line and lay the contact symbol on top of it; a
  // small white-filled, unstroked box between the contact plates hides the line there. So:
  //  - masks (filled, no outline, small, closed) cut every segment they cover - what the eye sees;
  //  - closed outlines (unit boxes, terminal circles, frames) are not wires, or every rung ending on
  //    a PLC unit's edge would join through it.
  //  - symbol bodies are masks too: a lamp or a coil is a white-filled circle laid over a straight rung,
  //    and electrically it separates its two sides. Exceptions: junction dots (tiny) and the ovals that
  //    carry a wire number (DPB1, DM20, P24A) - those sit ON the wire they name.
  const closed = (p) => p.length > 2 && Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) < 0.01;
  const WIRE_LABEL = /^(D[A-Z0-9]+|[PZN]\d{1,3}[A-Z]?|L\d{3,6}|CH\d\d\.\d{3})$/;
  const masks = [];
  for (const s of d.shapes) {
    if (s.fill_pattern > 0 && !s.oneD && s.paths?.some(closed) && !WIRE_LABEL.test(normKey(s.text || ''))) {
      const [bx0, by0, bx1, by1] = s.bbox;
      // tiny + outlined = junction dot (keeps the bus whole); tiny + no outline = the 1.9 mm white
      // patch between contact plates (must cut)
      const tiny = Math.max(bx1 - bx0, by1 - by0) < 2.5;
      if ((!tiny || s.line_pattern === 0) && bx1 - bx0 < 25 && by1 - by0 < 25) {
        const [x0, y1] = P(bx0, by0), [x1, y0] = P(bx1, by1);
        masks.push([x0, y0, x1, y1]);
      }
    }
  }
  const cut = (seg) => {
    let parts = [seg];
    for (const [mx0, my0, mx1, my1] of masks) {
      const next = [];
      for (const q of parts) {
        const [x1, y1, x2, y2] = q, dx = x2 - x1, dy = y2 - y1;
        // Liang-Barsky: parameter interval of q inside the mask box
        let t0 = 0, t1 = 1, inside = true;
        for (const [p, qq] of [[-dx, x1 - mx0], [dx, mx1 - x1], [-dy, y1 - my0], [dy, my1 - y1]]) {
          if (p === 0) { if (qq < 0) { inside = false; break; } continue; }
          const r = qq / p;
          if (p < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r);
          if (t0 > t1) { inside = false; break; }
        }
        if (!inside || t1 - t0 < 1e-6) { next.push(q); continue; }
        const at_ = (t) => [+(x1 + dx * t).toFixed(2), +(y1 + dy * t).toFixed(2)];
        if (t0 > 1e-6) next.push([x1, y1, ...at_(t0), q[4]]);
        if (t1 < 1 - 1e-6) next.push([...at_(t1), x2, y2, q[4]]);
      }
      parts = next;
    }
    return parts;
  };
  // A filled 2-D shape is a symbol body (the NX unit outline is an OPEN filled U-path whose edge runs
  // through every terminal: taken as a wire it merged P24A and Z24A through the unit). 1-D lines are
  // wires whatever their fill says (Visio gives them fill 1 by default).
  const segs = [];
  for (const s of d.shapes) {
    if (!s.paths || s.line_pattern === 0 || !onPage(s.bbox)) continue;
    if (!s.oneD && s.fill_pattern > 0) continue;
    for (const path_ of s.paths) {
      if (closed(path_)) continue;
      for (let i = 1; i < path_.length; i++) {
        const a = P(...path_[i - 1]), b = P(...path_[i]);
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.5) continue;
        for (const piece of cut([...a, ...b, s.id])) if (Math.hypot(piece[2] - piece[0], piece[3] - piece[1]) >= 0.3) segs.push(piece);
      }
    }
  }
  // device ownership: a segment drawn inside a symbol group belongs to that group's device tag
  // (a contact's two leads are two nets; the tag text is a child of the same group)
  const rootOf = (id) => { let s = byId.get(id); while (s && s.parent != null && byId.has(s.parent)) s = byId.get(s.parent); return s?.id ?? id; };
  const DEVICE_RE = /^(CR|MC|PB|PL|SS|KS|LS|PS|SOL|SV|CP|CB|FU|TB|BZ|EMG|X\d|Y\d|SW|PH|PX|AS)[A-Z0-9/\-]*\d/;
  const devTag = new Map();
  for (const t of texts) {
    const r = rootOf(t.id);
    if (r === t.id || !t.key || !DEVICE_RE.test(t.key)) continue;     // the text itself must sit inside a symbol group
    if (!devTag.has(r)) devTag.set(r, t.key);
  }
  const owner = {};
  for (const s of segs) { const r = rootOf(s[4]); if (devTag.has(r)) owner[s[4]] = devTag.get(r); }
  return { width: +(d.width_mm * PT).toFixed(2), height: +Hpt.toFixed(2), texts, rows, segs, owner };
}

export function buildSheetIndex(rawDir) {
  const drawings = [];
  const pages = new Map();                 // "file/pNN" -> page index (lazy fields filled)
  const xref = new Map();                  // key -> [{page, id, line, role, text}]
  const lineIndex = new Map();             // "L1005" -> {page, y}
  if (!fs.existsSync(rawDir)) return { drawings, pages, xref, lineIndex };
  for (const file of fs.readdirSync(rawDir).sort()) {
    const dir = path.join(rawDir, file);
    if (!fs.statSync(dir).isDirectory()) continue;
    const dr = { file, title: file.replace(/^\d+_/, '').replace(/_OK$/, '').replace(/_/g, ' '), pages: [] };
    for (const f of fs.readdirSync(dir).filter((f) => /^p\d+\.json$/.test(f)).sort()) {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (d.background) continue;
      const pid = `${file}/${f.slice(0, -5)}`;
      const ix = indexPage(d);
      ix.id = pid; ix.name = d.name; ix.file = file; ix.svg = `${file}/${f.slice(0, -5)}.svg`;
      pages.set(pid, ix);
      dr.pages.push({ id: pid, name: d.name, texts: ix.texts.length });
      for (const t of ix.texts) {
        for (const k of t.keys) {
          if (!xref.has(k)) xref.set(k, []);
          xref.get(k).push({ page: pid, id: t.id, line: t.line, role: t.role, text: t.text, row: !!t.row });
        }
        if (t.row) lineIndex.set(t.key, { page: pid, y: t.at[1], x: t.at[0] });
      }
    }
    if (dr.pages.length) drawings.push(dr);
  }
  return { drawings, pages, xref, lineIndex };
}
