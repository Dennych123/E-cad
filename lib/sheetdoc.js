// Editable sheet document. Pure data + functions (Node and browser).
//
// A sheet is a list of elements in drawing order, in SVG points (y down), on a page of `width` x
// `height` points. Kinds:
//   visio    an imported Visio shape: its original SVG markup (exact look) + `dx/dy` move offset +
//            its raw shapes (mm, y up) so the indexer still sees its geometry and text
//   wire     electrical connection, polyline `pts`
//   line     graphic polyline, NOT electrical (frames, leaders)
//   rect, ellipse, text    graphics
//   symbol   a library symbol instance: paths/pins copied from the library (self-contained), placed at
//            `x/y` (the symbol's local origin = bottom-left of its box), rotated by `rot` (0/90/180/270)
//
// elementShapes() turns any element into the importer's raw shape records, so lib/sheetindex.js
// (masks, nets, device ownership, cross-reference) runs unchanged on edited sheets.
import { PT } from './sheetindex.js';

export { PT };
export const GRID_MM = 2.5;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f2 = (v) => +(+v).toFixed(2);

// ---- symbol transforms --------------------------------------------------------------------------
/** local symbol point (mm, y up, origin bottom-left) -> page point (pt, y down) */
export function symPoint(el, [x, y]) {
  let u = x, v = y;
  if (el.flip) u = el.size[0] - u;
  const r = ((el.rot || 0) % 360 + 360) % 360;
  if (r === 90) [u, v] = [-v, u];
  else if (r === 180) [u, v] = [-u, -v];
  else if (r === 270) [u, v] = [v, -u];
  return [f2(el.x + u * PT), f2(el.y - v * PT)];
}

// ---- bounding boxes (pt) --------------------------------------------------------------------------
function boxOf(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return x0 === Infinity ? [0, 0, 0, 0] : [x0, y0, x1 - x0, y1 - y0];
}

export function elementBox(el, doc) {
  switch (el.kind) {
    case 'visio': {
      const H = doc.heightMm;
      const pts = [];
      for (const s of el.shapes || []) if (s.bbox) pts.push([s.bbox[0] * PT, (H - s.bbox[3]) * PT], [s.bbox[2] * PT, (H - s.bbox[1]) * PT]);
      const [x, y, w, h] = boxOf(pts);
      return [x + (el.dx || 0), y + (el.dy || 0), w, h];
    }
    case 'wire': case 'line': return boxOf(el.pts);
    case 'rect': return [el.x, el.y, el.w, el.h];
    case 'ellipse': return [el.cx - el.rx, el.cy - el.ry, 2 * el.rx, 2 * el.ry];
    case 'text': {
      const lines = String(el.text).split('\n'), w = Math.max(...lines.map((l) => l.length)) * el.size * 0.6, h = lines.length * el.size * 1.2;
      const x = el.anchor === 'middle' ? el.x - w / 2 : el.x;
      return [x, el.y - el.size, w, h];
    }
    case 'symbol': return boxOf([[0, 0], [el.size[0], 0], [0, el.size[1]], [el.size[0], el.size[1]]].map((p) => symPoint(el, p)));
    default: return [0, 0, 0, 0];
  }
}

/** points a wire can snap to (pt): symbol pins, wire/line ends */
export function snapPoints(el) {
  if (el.kind === 'symbol') return (el.pins || []).map((p) => symPoint(el, p.at || p));
  if (el.kind === 'wire') return [el.pts[0], el.pts.at(-1)];
  return [];
}

// ---- move / rotate ----------------------------------------------------------------------------------
export function moved(el, dx, dy) {
  const e = structuredClone(el);
  switch (e.kind) {
    case 'visio': e.dx = f2((e.dx || 0) + dx); e.dy = f2((e.dy || 0) + dy); break;
    case 'wire': case 'line': e.pts = e.pts.map(([x, y]) => [f2(x + dx), f2(y + dy)]); break;
    case 'rect': case 'text': case 'symbol': e.x = f2(e.x + dx); e.y = f2(e.y + dy); break;
    case 'ellipse': e.cx = f2(e.cx + dx); e.cy = f2(e.cy + dy); break;
  }
  return e;
}

/** rotate 90 deg clockwise about point (cx, cy) - symbols turn their own frame, geometry kinds rotate points */
export function rotated(el, cx, cy) {
  const e = structuredClone(el);
  const rp = ([x, y]) => [f2(cx - (y - cy)), f2(cy + (x - cx))];     // screen coords: clockwise
  switch (e.kind) {
    case 'symbol': { const [nx, ny] = rp([e.x, e.y]); e.x = nx; e.y = ny; e.rot = ((e.rot || 0) + 270) % 360; break; }
    case 'wire': case 'line': e.pts = e.pts.map(rp); break;
    case 'rect': { const [x, y] = rp([e.x, e.y + e.h]); [e.x, e.y, e.w, e.h] = [x, y, e.h, e.w]; break; }
    case 'ellipse': { [e.cx, e.cy] = rp([e.cx, e.cy]); [e.rx, e.ry] = [e.ry, e.rx]; break; }
    case 'text': { [e.x, e.y] = rp([e.x, e.y]); break; }
    default: break;                                                    // imported Visio shapes keep their orientation
  }
  return e;
}

// ---- rendering (SVG markup) -------------------------------------------------------------------------
const pl = (pts) => pts.map(([x, y]) => `${f2(x)},${f2(y)}`).join(' ');

export function renderElement(el, { translateText = null } = {}) {
  const attrs = `id="shape${el.id}-e" data-el="${el.id}"`;
  const stroke = el.stroke || '#000', w = el.width ?? 0.72;
  switch (el.kind) {
    case 'visio': return `<g ${attrs} transform="translate(${el.dx || 0} ${el.dy || 0})">${el.svg}</g>`;
    case 'wire': return `<g ${attrs}><polyline points="${pl(el.pts)}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>${(el.dots || []).map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.6" fill="${stroke}"/>`).join('')}</g>`;
    case 'line': return `<g ${attrs}><polyline points="${pl(el.pts)}" fill="none" stroke="${stroke}" stroke-width="${w}"${el.dash ? ` stroke-dasharray="${el.dash}"` : ''}/></g>`;
    case 'rect': return `<g ${attrs}><rect x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" fill="${el.fill || 'none'}" stroke="${stroke}" stroke-width="${w}"/></g>`;
    case 'ellipse': return `<g ${attrs}><ellipse cx="${el.cx}" cy="${el.cy}" rx="${el.rx}" ry="${el.ry}" fill="${el.fill || 'none'}" stroke="${stroke}" stroke-width="${w}"/></g>`;
    case 'text': {
      const t = translateText ? (translateText(el.text) ?? el.text) : el.text;
      const lines = String(t).split('\n');
      return `<g ${attrs}><text x="${el.x}" y="${el.y}" font-size="${el.size}" font-family="${esc(el.font || 'IBM Plex Mono, MS Gothic, monospace')}" fill="${el.color || '#000'}" text-anchor="${el.anchor || 'start'}">${lines.map((l, i) => `<tspan x="${el.x}" dy="${i ? '1.2em' : 0}">${esc(l)}</tspan>`).join('')}</text></g>`;
    }
    case 'symbol': {
      const body = (el.paths || []).map((p) => {
        const pts = pl(p.pts.map((q) => symPoint(el, q)));
        const sw = Math.max(0.3, (p.weight || 0.72));
        return p.closed
          ? `<polygon points="${pts}" fill="${p.fill ? '#fff' : 'none'}" stroke="${p.stroke === false ? 'none' : stroke}" stroke-width="${sw}"/>`
          : `<polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`;
      }).join('');
      let tag = '';
      if (el.tag) {
        const [bx, by, bw] = elementBox(el);
        tag = `<text x="${f2(bx + bw / 2)}" y="${f2(by - 2)}" font-size="${el.tagSize || 8}" text-anchor="middle" font-family="IBM Plex Mono, MS Gothic, monospace">${esc(el.tag)}</text>`;
      }
      return `<g ${attrs}>${body}${tag}</g>`;
    }
    default: return `<g ${attrs}/>`;
  }
}

// ---- raw shapes for the indexer (mm, y up) -----------------------------------------------------------------
export function elementShapes(el, doc) {
  const H = doc.heightMm;
  const mm = ([x, y]) => [f2(x / PT), f2(H - y / PT)];
  const bboxMm = (b) => { const [x, y, w, h] = b; return [f2(x / PT), f2(H - (y + h) / PT), f2((x + w) / PT), f2(H - y / PT)]; };
  const base = { parent: null, depth: 0, master: null, type: 'shape', oneD: false, text: '', layers: [], line_pattern: 1, fill_pattern: 0 };
  switch (el.kind) {
    case 'visio': {
      if (!el.dx && !el.dy) return el.shapes;
      const mx = el.dx / PT, my = -el.dy / PT;
      const tr = ([x, y]) => [f2(x + mx), f2(y + my)];
      return el.shapes.map((s) => ({ ...s,
        bbox: [f2(s.bbox[0] + mx), f2(s.bbox[1] + my), f2(s.bbox[2] + mx), f2(s.bbox[3] + my)],
        ...(s.text_pos ? { text_pos: tr(s.text_pos) } : {}),
        ...(s.paths ? { paths: s.paths.map((p) => p.map(tr)) } : {}),
        ...(s.begin ? { begin: tr(s.begin), end: tr(s.end) } : {}) }));
    }
    case 'wire': return [{ ...base, id: el.id, oneD: true, paths: [el.pts.map(mm)], bbox: bboxMm(elementBox(el, doc)) }];
    case 'text': return [{ ...base, id: el.id, line_pattern: 0, text: el.text, bbox: bboxMm(elementBox(el, doc)), text_pos: mm([el.x, el.y]) }];
    case 'symbol': {
      const kids = (el.paths || []).map((p, k) => ({ ...base, id: el.id * 1000 + k + 1, parent: el.id, depth: 1,
        oneD: !p.closed, fill_pattern: p.fill ? 1 : 0, line_pattern: p.stroke === false ? 0 : 1,
        paths: [p.pts.map((q) => mm(symPoint(el, q)))], bbox: bboxMm(boxOf(p.pts.map((q) => symPoint(el, q)))) }));
      const out = [{ ...base, id: el.id, type: 'group', master: 'sym:' + (el.name || el.symbolId), bbox: bboxMm(elementBox(el, doc)) }, ...kids];
      if (el.tag) {
        const [bx, by, bw] = elementBox(el, doc);
        out.push({ ...base, id: el.id * 1000 + 999, parent: el.id, depth: 1, line_pattern: 0, text: el.tag,
          bbox: bboxMm([bx + bw / 2 - el.tag.length * 2.4, by - 10, el.tag.length * 4.8, 8]), text_pos: mm([bx + bw / 2, by - 4]) });
      }
      return out;
    }
    default: return [];                                  // line / rect / ellipse: graphics, not electrical
  }
}

/** the whole sheet in the importer's raw page format, for lib/sheetindex.js */
export function docToRawPage(doc) {
  return { name: doc.name, width_mm: doc.widthMm, height_mm: doc.heightMm, background: false,
    shapes: doc.elements.flatMap((el) => elementShapes(el, doc)) };
}

// ---- library symbol -> element ---------------------------------------------------------------------------
export function symbolElement(sym, id, x, y, { rot = 0, tag = '' } = {}) {
  return { id, kind: 'symbol', symbolId: sym.id, name: sym.name, x: f2(x), y: f2(y), rot, flip: false, tag,
    size: sym.size, pins: sym.pins, paths: sym.paths.map((p) => ({ pts: p.pts, closed: p.closed, fill: p.fill, stroke: p.stroke, weight: p.weight })) };
}

export const snap = (v, stepPt) => Math.round(v / stepPt) * stepPt;

/** next free numeric element id (editor ids live above imported Visio shape ids) */
export function nextId(doc) {
  let m = 1000000;
  for (const e of doc.elements) if (e.id >= m) m = e.id + 1;
  return m;
}
