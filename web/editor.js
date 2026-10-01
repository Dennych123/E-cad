// Sheet editor: the drawing surface. Owns one open sheet document, its history, selection and tools.
// Rendering is plain SVG in the DOM (crisp print, real text, DOM hit-testing). Every committed edit
// swaps in a new elements array (elements are never mutated), so undo/redo is a stack of arrays and
// re-rendering touches only the elements whose object changed.
import {
  PT, GRID_MM, elementBox, snapPoints, moved, rotated, renderElement, symbolElement, docToRawPage, nextId, symPoint, elementShapes,
} from '/lib/sheetdoc.js';
import { indexPage } from '/lib/sheetindex.js';
import { buildNets, distSeg, labelsOfNet } from '/lib/nets.js';
import { translate, hasJapanese } from '/lib/i18n.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const GRID = GRID_MM * PT;                               // 2.5 mm in points
const f2 = (v) => +(+v).toFixed(2);
const JP_W = 1.0, LATIN_W = 0.58;                        // average glyph widths (em) for fit-to-width

export function createEditor(stage, { api, project, onChange, onSelect, onCursor, onNet, onTool, onNavigate, toast }) {
  let doc = null, els = [], saved = null, past = [], future = [];
  let svg = null, fgLayer = null, bgLayer = null, ovl = null, gridLayer = null;
  const nodes = new Map();                               // element id -> DOM node
  let shapeOwner = new Map();                            // raw shape id -> element id
  let sel = new Set(), tool = 'select', vb = [0, 0, 100, 100];
  let pageIx = null, nets = null, reindexTimer = null;
  let dict = new Map(), english = true, showGrid = false, snapOn = true, bgLocked = true;
  let clipboard = null, placing = null, draft = null, spaceDown = false;
  let symbolsById = new Map();

  // ------------------------------------------------------------------ load / render
  async function open(id) {
    const d = await api(`/api/doc/${encodeURIComponent(project())}/${encodeURIComponent(id)}`);
    doc = d; els = d.elements; saved = els; past = []; future = []; sel = new Set(); issues = []; marks = []; netHi = null;
    build();
    fit();
    reindex(true);
    emitChange(); emitSelect();
    return doc;
  }

  function build() {
    const html = `<svg xmlns="${SVGNS}" xmlns:v="http://schemas.microsoft.com/visio/2003/SVGExtensions/" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:ev="http://www.w3.org/2001/xml-events" class="sheet ${doc.rootClass || ''}" viewBox="0 0 ${doc.width} ${doc.height}" preserveAspectRatio="xMidYMid meet">`
      + `<style>${doc.css || ''}</style>${doc.defs || ''}`
      + `<rect class="paper" x="0" y="0" width="${doc.width}" height="${doc.height}"/>`
      + `<g id="ec-bg" class="${bgLocked ? 'bg-locked' : ''}">${doc.background || ''}</g><g id="ec-grid" class="grid"></g><g id="ec-fg"></g><g id="ec-ovl" pointer-events="none"></g></svg>`;
    const parsed = new DOMParser().parseFromString(html, 'image/svg+xml');
    const err = parsed.querySelector('parsererror');
    if (err) throw new Error('sheet SVG did not parse: ' + err.textContent.slice(0, 120));
    svg = document.importNode(parsed.documentElement, true);
    stage.querySelector('svg.sheet')?.remove();
    stage.prepend(svg);
    fgLayer = svg.querySelector('#ec-fg'); bgLayer = svg.querySelector('#ec-bg'); ovl = svg.querySelector('#ec-ovl'); gridLayer = svg.querySelector('#ec-grid');
    nodes.clear();
    const frag = document.createDocumentFragment();
    for (const el of els) { const n = nodeOf(el); frag.append(n); }
    fgLayer.append(frag);
    translateTree(bgLayer);
    drawGrid();
    rebuildOwner();
  }

  // parse element markup in the sheet's namespace context (Visio markup uses v: and xlink: prefixes)
  const NS_WRAP = `xmlns="${SVGNS}" xmlns:v="http://schemas.microsoft.com/visio/2003/SVGExtensions/" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:ev="http://www.w3.org/2001/xml-events"`;
  function nodeOf(el) {
    const markup = renderElement(el, { translateText: english ? (t) => translate(t, dict) : null });
    const parsed = new DOMParser().parseFromString(`<svg ${NS_WRAP}>${markup}</svg>`, 'image/svg+xml');
    const n = document.importNode(parsed.documentElement.firstElementChild, true);
    n.__el = el;
    nodes.set(el.id, n);
    if (el.kind === 'visio') translateTree(n);
    return n;
  }

  /** swap the rendered elements to match `next`, touching only what changed */
  function sync(next) {
    const keep = new Set(next.map((e) => e.id));
    for (const [id, n] of nodes) if (!keep.has(id)) { n.remove(); nodes.delete(id); }
    let prev = null;
    for (const el of next) {
      let n = nodes.get(el.id);
      if (!n || n.__el !== el) { const fresh = nodeOf(el); if (n) n.replaceWith(fresh); n = fresh; }
      const want = prev ? prev.nextSibling : fgLayer.firstChild;
      if (n !== want) fgLayer.insertBefore(n, want);
      prev = n;
    }
    els = next;
    rebuildOwner();
  }

  function rebuildOwner() {
    shapeOwner = new Map();
    for (const el of els) {
      if (el.kind === 'visio') for (const s of el.shapes || []) shapeOwner.set(s.id, el.id);
      else { shapeOwner.set(el.id, el.id); if (el.kind === 'symbol') for (let k = 1; k <= (el.paths?.length || 0); k++) shapeOwner.set(el.id * 1000 + k, el.id); shapeOwner.set(el.id * 1000 + 999, el.id); }
    }
  }

  // ------------------------------------------------------------------ language
  // Visio text nodes are translated in place; the original children are kept to switch back.
  const originals = new WeakMap();
  function translateTree(root) {
    for (const t of root.querySelectorAll('text')) {
      if (!originals.has(t)) {
        const src = t.textContent;
        if (!hasJapanese(src) && !/[！-～・※]/.test(src)) continue;
        originals.set(t, { nodes: [...t.childNodes].map((c) => c.cloneNode(true)), text: src, transform: t.getAttribute('transform') });
      }
      const o = originals.get(t);
      const restoreTransform = () => { if (o.transform) t.setAttribute('transform', o.transform); else t.removeAttribute('transform'); };
      if (!english) { t.replaceChildren(...o.nodes.map((c) => c.cloneNode(true))); restoreTransform(); continue; }
      const en = translate(o.text, dict);
      if (!en) continue;
      const lines = en.split('\n');
      const x = t.getAttribute('x') || '0';
      t.replaceChildren(...lines.map((l, i) => { const s = document.createElementNS(SVGNS, 'tspan'); s.setAttribute('x', x); if (i) s.setAttribute('dy', '1.2em'); s.textContent = l; return s; }));
      // English runs longer than Japanese: shrink to the width the original occupied
      const jpW = Math.max(...o.text.split(/\n/).map((l) => [...l.trim()].reduce((a, ch) => a + (/[　-鿿＀-￯]/.test(ch) ? JP_W : LATIN_W), 0)));
      const enW = Math.max(...lines.map((l) => l.length * LATIN_W));
      const scale = enW > jpW * 1.08 ? Math.max(0.55, (jpW * 1.08) / enW) : 1;
      restoreTransform();
      if (scale < 1) {
        // scale about the text's own anchor: font sizes come from Visio's em-based classes, so a
        // transform is the one change that does not depend on them
        const ax = parseFloat(t.getAttribute('x')) || 0, ay = parseFloat(t.getAttribute('y')) || 0;
        t.setAttribute('transform', `${o.transform ? o.transform + ' ' : ''}translate(${ax} ${ay}) scale(${scale.toFixed(3)}) translate(${-ax} ${-ay})`);
      }
    }
  }
  function setLanguage(en) { english = en; if (!svg) return; translateTree(bgLayer); for (const n of nodes.values()) if (n.__el.kind === 'visio') translateTree(n); else { const f = nodeOf(n.__el); n.replaceWith(f); } }

  // ------------------------------------------------------------------ view box
  const setVB = () => { svg?.setAttribute('viewBox', vb.map(f2).join(' ')); drawGrid(); drawOverlay(); };
  function fit() { if (!doc) return; const pad = doc.width * 0.02; vb = [-pad, -pad, doc.width + 2 * pad, doc.height + 2 * pad]; setVB(); }
  function zoomBy(k, cx, cy) {
    const r = stage.getBoundingClientRect();
    const p = cx === undefined ? { x: vb[0] + vb[2] / 2, y: vb[1] + vb[3] / 2 } : toSvg(cx, cy);
    const w = Math.min(doc.width * 4, Math.max(doc.width / 200, vb[2] * k)), s = w / vb[2];
    vb = [p.x - (p.x - vb[0]) * s, p.y - (p.y - vb[1]) * s, w, vb[3] * s];
    setVB();
    void r;
  }
  function zoomTo(x, y, w) { const h = w * vb[3] / vb[2]; vb = [x - w / 2, y - h / 2, w, h]; setVB(); }
  // 100 % = true size: one point is 96/72 CSS pixels
  const zoomPct = () => { if (!svg || !doc) return 100; const r = stage.getBoundingClientRect(); return Math.round(Math.min(r.width / vb[2], r.height / vb[3]) / (96 / 72) * 100); };
  function zoomToPct(pct) {
    const r = stage.getBoundingClientRect(), pxPerPt = (pct / 100) * (96 / 72);
    const cx = vb[0] + vb[2] / 2, cy = vb[1] + vb[3] / 2;
    const w = r.width / pxPerPt, h = r.height / pxPerPt;
    vb = [cx - w / 2, cy - h / 2, w, h]; setVB();
  }
  function toSvg(cx, cy) {
    const pt = svg.createSVGPoint(); pt.x = cx; pt.y = cy;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }
  function toScreen(x, y) {
    const pt = svg.createSVGPoint(); pt.x = x; pt.y = y;
    const q = pt.matrixTransform(svg.getScreenCTM());
    const r = stage.getBoundingClientRect();
    return [q.x - r.left, q.y - r.top];
  }
  const pxToPt = (px) => px * vb[2] / stage.getBoundingClientRect().width;

  function drawGrid() {
    if (!gridLayer) return;
    gridLayer.replaceChildren();
    if (!showGrid) return;
    const step = pxToPt(1) * 8 > GRID ? GRID * 4 : GRID;
    const x0 = Math.max(0, Math.floor(vb[0] / step) * step), x1 = Math.min(doc.width, vb[0] + vb[2]);
    const y0 = Math.max(0, Math.floor(vb[1] / step) * step), y1 = Math.min(doc.height, vb[1] + vb[3]);
    let html = '';
    let n = 0;
    for (let x = x0; x <= x1 && n < 600; x += step, n++) html += `<line x1="${f2(x)}" y1="${f2(y0)}" x2="${f2(x)}" y2="${f2(y1)}" class="${Math.round(x / GRID) % 4 === 0 ? 'major' : ''}"/>`;
    for (let y = y0; y <= y1 && n < 1200; y += step, n++) html += `<line x1="${f2(x0)}" y1="${f2(y)}" x2="${f2(x1)}" y2="${f2(y)}" class="${Math.round(y / GRID) % 4 === 0 ? 'major' : ''}"/>`;
    gridLayer.innerHTML = html;
  }

  // ------------------------------------------------------------------ history
  function commit(next, label = 'Edit') {
    if (next === els) return;
    past.push({ els, label, sel: [...sel] });
    if (past.length > 300) past.shift();
    future = [];
    sync(next);
    reindex(); emitChange(); drawOverlay();
  }
  function undo() {
    const h = past.pop(); if (!h) return;
    future.push({ els, label: h.label, sel: [...sel] });
    sync(h.els); sel = new Set(h.sel.filter((id) => nodes.has(id)));
    reindex(); emitChange(); emitSelect(); drawOverlay();
    toast?.(`Undo: ${h.label}`, { kind: 'info', duration: 1400 });
  }
  function redo() {
    const h = future.pop(); if (!h) return;
    past.push({ els, label: h.label, sel: [...sel] });
    sync(h.els); sel = new Set(h.sel.filter((id) => nodes.has(id)));
    reindex(); emitChange(); emitSelect(); drawOverlay();
  }
  const emitChange = () => onChange?.({ dirty: els !== saved, canUndo: past.length > 0, canRedo: future.length > 0, undoLabel: past.at(-1)?.label, count: els.length });

  // ------------------------------------------------------------------ live index (nets, xref of this sheet)
  function reindex(now = false) {
    clearTimeout(reindexTimer);
    const run = () => { pageIx = indexPage(docToRawPage({ ...doc, elements: els })); nets = null; onNet?.(null); emitSelect(); };
    if (now) run(); else reindexTimer = setTimeout(run, 120);
  }
  const netsNow = () => (nets ||= buildNets(pageIx.segs));

  // ------------------------------------------------------------------ selection
  const byId = (id) => els.find((e) => e.id === id);
  const selected = () => els.filter((e) => sel.has(e.id));
  function select(ids, { add = false } = {}) {
    if (!add) sel = new Set();
    for (const id of ids) { if (add && sel.has(id)) sel.delete(id); else sel.add(id); }
    emitSelect(); drawOverlay();
  }
  function emitSelect() {
    const list = selected();
    onSelect?.({ elements: list, texts: textsOf(list), doc });
    if (list.length === 1) showElementNet(list[0]); else clearNet();
  }
  function textsOf(list) {
    if (!pageIx) return [];
    const ids = new Set(list.map((e) => e.id));
    return pageIx.texts.filter((t) => ids.has(shapeOwner.get(t.id)));
  }
  function boxOf(ids) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of ids) { const e = byId(id); if (!e) continue; const [x, y, w, h] = elementBox(e, doc); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h); }
    return x0 === Infinity ? null : [x0, y0, x1 - x0, y1 - y0];
  }

  // ------------------------------------------------------------------ overlay
  let hoverId = null, netHi = null, marks = [], issues = [];
  // electrical-check findings on this sheet: a dashed box round the text plus a badge, constant on screen
  function issuesSvg() {
    if (!issues.length || !pageIx) return '';
    const r = pxToPt(6.5), pad = pxToPt(2);
    return issues.map((i) => {
      const t = pageIx.texts.find((q) => q.id === i.shape) || (i.key && pageIx.texts.find((q) => q.keys.includes(i.key)));
      if (!t) return '';
      const [x, y, w] = t.box;
      return `<g class="issue ${i.severity}">${rectSvg(t.box, pad, '')}<circle cx="${f2(x + w + pad)}" cy="${f2(y - pad)}" r="${f2(r)}"/><text x="${f2(x + w + pad)}" y="${f2(y - pad)}" font-size="${f2(r * 1.5)}">!</text></g>`;
    }).join('');
  }
  function drawOverlay(extra = '') {
    if (!ovl) return;
    const pad = pxToPt(3);
    let h = '';
    if (hoverId && !sel.has(hoverId) && tool === 'select') { const b = boxOf([hoverId]); if (b) h += rectSvg(b, pad, 'hover-box'); }
    for (const id of sel) { const b = boxOf([id]); if (b) h += rectSvg(b, pad, 'sel-box'); }
    if (sel.size > 1) { const b = boxOf(sel); if (b) h += rectSvg(b, pad * 2, 'sel-all'); }
    if (sel.size === 1) { const e = byId([...sel][0]); if (e) for (const [x, y] of snapPoints(e)) h += `<circle class="pin" cx="${x}" cy="${y}" r="${f2(pxToPt(3))}"/>`; }
    if (netHi) h += netHi.map((s) => `<line class="net-hi" x1="${s[0]}" y1="${s[1]}" x2="${s[2]}" y2="${s[3]}"/>`).join('');
    for (const m of marks) h += m.kind === 'band' ? `<rect class="band" x="${m.x}" y="${m.y}" width="${m.w}" height="${m.h}"/>` : rectSvg(m.box, 2.5, m.kind);
    ovl.innerHTML = issuesSvg() + h + extra;
  }
  const rectSvg = ([x, y, w, h], p, cls) => `<rect class="${cls}" x="${f2(x - p)}" y="${f2(y - p)}" width="${f2(w + 2 * p)}" height="${f2(h + 2 * p)}" rx="1.5"/>`;

  // ------------------------------------------------------------------ nets
  function showElementNet(el) {
    if (!pageIx) return;
    const mine = new Set(), n = netsNow();
    pageIx.segs.forEach((s, i) => { if (shapeOwner.get(s[4]) === el.id && (el.kind === 'wire' || el.kind === 'visio')) mine.add(n[i]); });
    // a Visio element that is a symbol owns many tiny nets; only show nets for wire-like elements
    const isWire = el.kind === 'wire' || (el.kind === 'visio' && (el.shapes || []).length === 1 && el.shapes[0].oneD);
    if (!isWire || !mine.size) { clearNet(); return; }
    const segs = pageIx.segs.filter((_, i) => mine.has(n[i]));
    const labels = [...new Set([...mine].flatMap((id) => labelsOfNet(pageIx.texts, pageIx.segs, n, id)).flatMap((t) => t.keys))];
    netHi = segs;
    onNet?.({ segments: segs.length, labels, devices: [...new Set(segs.map((s) => pageIx.owner[s[4]]).filter(Boolean))] });
    drawOverlay();
  }
  function clearNet() { if (netHi) { netHi = null; drawOverlay(); } onNet?.(null); }

  // ------------------------------------------------------------------ hit testing
  function elementAt(cx, cy) {
    const hit = document.elementFromPoint(cx, cy);
    if (hit && svg.contains(hit)) {
      const g = hit.closest('[data-el]');
      if (g && fgLayer.contains(g)) return Number(g.dataset.el);
    }
    // thin lines are hard to hit: nearest segment within 5 px
    if (!pageIx) return null;
    const p = toSvg(cx, cy), tol = pxToPt(5);
    let best = null, bd = tol;
    for (const s of pageIx.segs) { const d = distSeg(p.x, p.y, s); if (d < bd) { bd = d; best = s; } }
    return best ? shapeOwner.get(best[4]) ?? null : null;
  }

  // ------------------------------------------------------------------ snapping
  function snapTargets() {
    const pts = [];
    for (const e of els) pts.push(...snapPoints(e));
    if (pageIx) for (const s of pageIx.segs) pts.push([s[0], s[1]], [s[2], s[3]]);
    return pts;
  }
  /** snap a point: pins / wire ends first, then onto a wire (T), then the grid */
  function snapPoint(p, { targets = null, allowT = true } = {}) {
    if (!snapOn) return { x: p.x, y: p.y, kind: 'free' };
    const tol = pxToPt(9);
    let best = null, bd = tol;
    for (const [x, y] of targets || snapTargets()) { const d = Math.hypot(x - p.x, y - p.y); if (d < bd) { bd = d; best = { x, y, kind: 'pin' }; } }
    if (best) return best;
    if (allowT && pageIx) {
      for (const s of pageIx.segs) {
        const d = distSeg(p.x, p.y, s);
        if (d < pxToPt(6)) {
          const [x1, y1, x2, y2] = s, dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy, u = L ? Math.max(0, Math.min(1, ((p.x - x1) * dx + (p.y - y1) * dy) / L)) : 0;
          return { x: f2(x1 + u * dx), y: f2(y1 + u * dy), kind: 'wire' };
        }
      }
    }
    return { x: f2(Math.round(p.x / GRID) * GRID), y: f2(Math.round(p.y / GRID) * GRID), kind: 'grid' };
  }
  const snapDelta = (d) => (snapOn ? Math.round(d / GRID) * GRID : d);

  // ------------------------------------------------------------------ pointer
  let drag = null;
  function onDown(e) {
    if (!doc || e.button === 2) return;
    stage.focus({ preventScroll: true });
    const p = toSvg(e.clientX, e.clientY);
    if (e.button === 1 || tool === 'pan' || spaceDown) { drag = { kind: 'pan', x: e.clientX, y: e.clientY, vb: [...vb] }; stage.classList.add('dragging'); stage.setPointerCapture(e.pointerId); return; }
    if (tool === 'place' && placing) { placeAt(p); return; }
    if (tool === 'wire' || tool === 'line') { wireClick(p, e); return; }
    if (tool === 'rect' || tool === 'ellipse') { const s = snapPoint(p, { allowT: false }); drag = { kind: 'shape', x0: s.x, y0: s.y, x1: s.x, y1: s.y }; stage.setPointerCapture(e.pointerId); return; }
    if (tool === 'text') { const s = snapPoint(p, { allowT: false }); newText(s.x, s.y); return; }
    // select tool
    const id = elementAt(e.clientX, e.clientY);
    if (id != null) {
      if (e.shiftKey) { select([id], { add: true }); return; }
      if (!sel.has(id)) select([id]);
      drag = { kind: 'move', x: p.x, y: p.y, dx: 0, dy: 0, ids: [...sel], moved: false };
    } else {
      if (!e.shiftKey) select([]);
      drag = { kind: 'marquee', x0: p.x, y0: p.y, x1: p.x, y1: p.y, add: e.shiftKey };
    }
    stage.setPointerCapture(e.pointerId);
  }
  function onMove(e) {
    if (!doc) return;
    const p = toSvg(e.clientX, e.clientY);
    onCursor?.({ x: f2(p.x / PT), y: f2((doc.height - p.y) / PT) });
    if (!drag) {
      if (tool === 'select' && !spaceDown) { const id = elementAt(e.clientX, e.clientY); if (id !== hoverId) { hoverId = id; drawOverlay(); } }
      if (tool === 'place' && placing) ghostAt(p);
      if ((tool === 'wire' || tool === 'line') && draft) drawDraft(p, e);
      else if (tool === 'wire' || tool === 'line') { const s = snapPoint(p); drawOverlay(s.kind !== 'grid' ? snapMark(s) : ''); }
      return;
    }
    if (drag.kind === 'pan') {
      const r = stage.getBoundingClientRect(), s = Math.max(drag.vb[2] / r.width, drag.vb[3] / r.height);
      vb = [drag.vb[0] - (e.clientX - drag.x) * s, drag.vb[1] - (e.clientY - drag.y) * s, drag.vb[2], drag.vb[3]];
      setVB();
    } else if (drag.kind === 'move') {
      const dx = snapDelta(p.x - drag.x), dy = snapDelta(p.y - drag.y);
      if (!drag.moved && Math.hypot(p.x - drag.x, p.y - drag.y) < pxToPt(3)) return;
      drag.moved = true; drag.dx = dx; drag.dy = dy;
      for (const id of drag.ids) {
        const n = nodes.get(id), el = byId(id);
        if (!n || !el) continue;
        n.setAttribute('transform', el.kind === 'visio' ? `translate(${(el.dx || 0) + dx} ${(el.dy || 0) + dy})` : `translate(${dx} ${dy})`);
      }
      const b = boxOf(drag.ids);
      if (b) drawOverlay(rectSvg([b[0] + dx, b[1] + dy, b[2], b[3]], pxToPt(3), 'sel-all'));
    } else if (drag.kind === 'marquee') {
      drag.x1 = p.x; drag.y1 = p.y;
      const [x, y, w, h] = norm(drag);
      drawOverlay(`<rect class="marquee" x="${x}" y="${y}" width="${w}" height="${h}"/>`);
    } else if (drag.kind === 'shape') {
      const s = snapPoint(p, { allowT: false }); drag.x1 = s.x; drag.y1 = s.y;
      const [x, y, w, h] = norm(drag);
      drawOverlay(tool === 'rect' ? `<rect class="draft" x="${x}" y="${y}" width="${w}" height="${h}"/>` : `<ellipse class="draft" cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}"/>`);
    }
  }
  /** Visio-style glue: wires whose end sits on a pin of a moved shape follow it, staying orthogonal */
  function withGlue(next, ids, dx, dy) {
    const pins = [];
    for (const el of els) if (ids.has(el.id)) for (const p of snapPoints(el)) pins.push(p);
    if (!pins.length) return next;
    const on = (q) => pins.some(([x, y]) => Math.abs(x - q[0]) < 0.6 && Math.abs(y - q[1]) < 0.6);
    return next.map((el) => {
      if (el.kind !== 'wire' || ids.has(el.id)) return el;
      let pts = el.pts.map((q) => [...q]), changed = false;
      for (const end of [0, pts.length - 1]) {
        if (!on(pts[end])) continue;
        const nb = end === 0 ? 1 : pts.length - 2;
        const [ex, ey] = pts[end], [nx, ny] = pts[nb];
        const moved_ = [f2(ex + dx), f2(ey + dy)];
        const horiz = Math.abs(ny - ey) < 0.01, vert = Math.abs(nx - ex) < 0.01;
        const elbow = horiz ? [moved_[0], ny] : vert ? [nx, moved_[1]] : null;
        const ins = elbow && (elbow[0] !== moved_[0] || elbow[1] !== moved_[1]) ? [elbow, moved_] : [moved_];
        if (end === 0) pts = [...ins.reverse(), ...pts.slice(1)]; else pts = [...pts.slice(0, -1), ...ins];
        changed = true;
      }
      if (!changed) return el;
      // drop repeated and collinear points
      const clean = [];
      for (const q of pts) {
        if (clean.length && clean.at(-1)[0] === q[0] && clean.at(-1)[1] === q[1]) continue;
        if (clean.length >= 2) { const [a, b] = clean.slice(-2); if ((a[0] === b[0] && b[0] === q[0]) || (a[1] === b[1] && b[1] === q[1])) clean.pop(); }
        clean.push(q);
      }
      return { ...el, pts: clean };
    });
  }

  function onUp(e) {
    const d = drag; drag = null; stage.classList.remove('dragging');
    if (!d) return;
    if (d.kind === 'move') {
      if (d.moved && (d.dx || d.dy)) {
        const ids = new Set(d.ids);
        commit(withGlue(els.map((el) => (ids.has(el.id) ? moved(el, d.dx, d.dy) : el)), ids, d.dx, d.dy), d.ids.length > 1 ? `Move ${d.ids.length} shapes` : 'Move');
      } else for (const id of d.ids) { const n = nodes.get(id); const el = byId(id); if (n && el) n.setAttribute('transform', el.kind === 'visio' ? `translate(${el.dx || 0} ${el.dy || 0})` : ''); }
      drawOverlay();
    } else if (d.kind === 'marquee') {
      const [x, y, w, h] = norm(d);
      if (w > pxToPt(3) || h > pxToPt(3)) {
        const inside = els.filter((el) => { const [bx, by, bw, bh] = elementBox(el, doc); return bw + bh > 0 && bx >= x && by >= y && bx + bw <= x + w && by + bh <= y + h; }).map((el) => el.id);
        select(inside, { add: d.add });
      }
      drawOverlay();
    } else if (d.kind === 'shape') {
      const [x, y, w, h] = norm(d);
      if (w > 1 && h > 1) {
        const id = nextId({ elements: els });
        const el = tool === 'rect' ? { id, kind: 'rect', x, y, w, h, stroke: '#000', width: 0.72 } : { id, kind: 'ellipse', cx: f2(x + w / 2), cy: f2(y + h / 2), rx: f2(w / 2), ry: f2(h / 2), stroke: '#000', width: 0.72 };
        commit([...els, el], tool === 'rect' ? 'Draw rectangle' : 'Draw ellipse');
        select([id]);
      }
      drawOverlay();
    }
    void e;
  }
  const norm = (d) => [f2(Math.min(d.x0, d.x1)), f2(Math.min(d.y0, d.y1)), f2(Math.abs(d.x1 - d.x0)), f2(Math.abs(d.y1 - d.y0))];

  // ------------------------------------------------------------------ wire / line tool
  const snapMark = (s) => `<circle class="snap-mark" cx="${s.x}" cy="${s.y}" r="${f2(pxToPt(s.kind === 'wire' ? 4 : 6))}"/>`;
  function orthoPoint(from, p, free) {
    if (free) return p;
    return Math.abs(p.x - from[0]) >= Math.abs(p.y - from[1]) ? { ...p, y: from[1] } : { ...p, x: from[0] };
  }
  function wireClick(p, e) {
    const s = snapPoint(p);
    if (!draft) { draft = { pts: [[s.x, s.y]], startT: s.kind === 'wire' ? [s.x, s.y] : null }; drawDraft(p, e); return; }
    const last = draft.pts.at(-1);
    const q = s.kind === 'pin' || s.kind === 'wire' ? s : orthoPoint(last, s, e.shiftKey || tool === 'line');
    // an L-bend when the target is off-axis and snapped: horizontal first, then vertical
    if (!e.shiftKey && tool === 'wire' && q.x !== last[0] && q.y !== last[1]) draft.pts.push([q.x, last[1]]);
    draft.pts.push([f2(q.x), f2(q.y)]);
    if (s.kind === 'pin' || s.kind === 'wire') { draft.endT = s.kind === 'wire' ? [s.x, s.y] : null; finishDraft(); }
    else drawDraft(p, e);
  }
  function drawDraft(p, e) {
    const s = snapPoint(p);
    const last = draft.pts.at(-1);
    const q = s.kind === 'pin' || s.kind === 'wire' ? s : orthoPoint(last, s, e?.shiftKey || tool === 'line');
    const pts = [...draft.pts];
    if (tool === 'wire' && !e?.shiftKey && q.x !== last[0] && q.y !== last[1]) pts.push([q.x, last[1]]);
    pts.push([q.x, q.y]);
    drawOverlay(`<polyline class="draft" points="${pts.map((a) => a.join(',')).join(' ')}"/>${s.kind !== 'grid' ? snapMark(s) : ''}`);
  }
  function finishDraft() {
    if (!draft) return;
    const pts = draft.pts.filter((q, i, a) => !i || q[0] !== a[i - 1][0] || q[1] !== a[i - 1][1]);
    if (pts.length >= 2) {
      const id = nextId({ elements: els });
      const dots = [draft.startT, draft.endT].filter(Boolean);
      const el = tool === 'wire' ? { id, kind: 'wire', pts, stroke: '#000', width: 0.72, ...(dots.length ? { dots } : {}) } : { id, kind: 'line', pts, stroke: '#000', width: 0.72 };
      commit([...els, el], tool === 'wire' ? 'Draw wire' : 'Draw line');
    }
    draft = null; drawOverlay();
  }
  function cancelDraft() { draft = null; drawOverlay(); }

  // ------------------------------------------------------------------ text
  function newText(x, y) {
    editTextAt(x, y, '', (text) => {
      if (!text.trim()) return;
      const id = nextId({ elements: els });
      commit([...els, { id, kind: 'text', x, y, text, size: 9, anchor: 'start' }], 'Add text');
      select([id]);
    });
  }
  function editTextAt(x, y, value, done, size = 9) {
    const [sx, sy] = toScreen(x, y);
    const ta = document.createElement('textarea');
    ta.className = 'inline-text';
    ta.value = value;
    const scale = stage.getBoundingClientRect().width / vb[2];
    ta.style.left = sx + 'px'; ta.style.top = (sy - size * scale) + 'px';
    ta.style.fontSize = Math.max(11, size * scale) + 'px';
    ta.rows = Math.max(1, value.split('\n').length);
    stage.append(ta);
    ta.focus(); ta.select();
    let closed = false;
    const end = (ok) => { if (closed) return; closed = true; const v = ta.value; ta.remove(); if (ok) done(v); stage.focus({ preventScroll: true }); };
    ta.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); end(false); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); end(true); }
    };
    ta.oninput = () => { ta.rows = Math.max(1, ta.value.split('\n').length); };
    ta.onblur = () => end(true);
  }
  function editSelectedText() {
    const [el] = selected();
    if (!el) return false;
    if (el.kind === 'text') { editTextAt(el.x, el.y, el.text, (v) => update(el.id, { text: v }, 'Edit text'), el.size); return true; }
    if (el.kind === 'symbol') { const [x, y, w] = elementBox(el, doc); editTextAt(x + w / 2 - 20, y - 2, el.tag || '', (v) => update(el.id, { tag: v.trim() }, 'Edit tag'), 8); return true; }
    if (el.kind === 'visio') {
      const withText = (el.shapes || []).filter((s) => s.text);
      if (withText.length !== 1) return false;
      const s = withText[0], t = pageIx?.texts.find((q) => q.id === s.id);
      const [x, y] = t ? [t.box[0], t.box[1] + t.box[3]] : elementBox(el, doc);
      editTextAt(x + (el.dx || 0), y + (el.dy || 0), s.text, (v) => setVisioText(el, s.id, v));
      return true;
    }
    return false;
  }
  function setVisioText(el, shapeId, text) {
    const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const lines = text.split('\n');
    const svgNew = el.svg.replace(/(<text\b[^>]*>)([\s\S]*?)(<\/text>)/, (m, a, _b, c) => {
      const x = /\bx="([^"]+)"/.exec(a)?.[1] || '0';
      return a + lines.map((l, i) => `<tspan x="${x}"${i ? ' dy="1.2em"' : ''}>${esc(l)}</tspan>`).join('') + c;
    });
    const next = { ...el, svg: svgNew, shapes: el.shapes.map((s) => (s.id === shapeId ? { ...s, text } : s)) };
    commit(els.map((e) => (e.id === el.id ? next : e)), 'Edit text');
  }

  // ------------------------------------------------------------------ symbols
  function setSymbols(list) { symbolsById = new Map(list.map((s) => [s.id, s])); }
  function startPlace(sym, { tag = null } = {}) {
    placing = { sym, rot: 0, tag };
    setTool('place');
  }
  function ghostEl(p) {
    const el = symbolElement(placing.sym, -1, 0, 0, { rot: placing.rot, tag: placing.tag || nextTag(placing.sym) });
    // anchor on the first pin so pins land on the grid / on the pointed wire
    const pin = el.pins?.[0] ? symPoint(el, el.pins[0].at) : [0, 0];
    const s = snapPoint(p);
    return moved(el, s.x - pin[0], s.y - pin[1]);
  }
  function ghostAt(p) {
    const g = ghostEl(p);
    drawOverlay(`<g class="ghost">${renderElement(g)}</g>`);
  }
  function placeAt(p) {
    const g = ghostEl(p);
    const id = nextId({ elements: els });
    commit([...els, { ...g, id }], `Place ${placing.sym.name}`);
    placing.tag = null;                                      // next one numbers itself
    return id;
  }
  /** drag-and-drop from the library: place once at the drop point, then back to select */
  function dropSymbol(sym, clientX, clientY) {
    placing = { sym, rot: 0, tag: null };
    const id = placeAt(toSvg(clientX, clientY));
    placing = null;
    setTool('select');
    select([id]);
  }
  const PREFIX = { contacts: 'CR', relays: 'CR', coils: 'SOL', operator: 'PB', protection: 'CP', terminals: 'TB', sensors: 'SN' };
  function nextTag(sym) {
    const pre = /lamp/i.test(sym.name) ? 'PL' : /selector/i.test(sym.name) ? 'SS' : /buzzer/i.test(sym.name) ? 'BZ' : PREFIX[sym.category];
    if (!pre) return '';
    const used = new Set([...(pageIx?.texts || []).flatMap((t) => t.keys), ...els.filter((e) => e.tag).map((e) => e.tag.toUpperCase())]);
    let n = 1; while (used.has(pre + n)) n++;
    return pre + n;
  }

  // ------------------------------------------------------------------ edit operations
  function update(id, patch, label = 'Edit') {
    commit(els.map((e) => (e.id === id ? { ...structuredClone(e), ...patch } : e)), label);
  }
  function deleteSel() {
    if (!sel.size) return;
    const n = sel.size;
    commit(els.filter((e) => !sel.has(e.id)), n > 1 ? `Delete ${n} shapes` : 'Delete');
    sel = new Set(); emitSelect(); drawOverlay();
  }
  function rotateSel() {
    const b = boxOf(sel); if (!b) return;
    const cx = snapDelta(b[0] + b[2] / 2), cy = snapDelta(b[1] + b[3] / 2);
    const skipped = selected().filter((e) => e.kind === 'visio').length;
    commit(els.map((e) => (sel.has(e.id) && e.kind !== 'visio' ? rotated(e, cx, cy) : e)), 'Rotate');
    if (skipped) toast?.(`${skipped} imported shape(s) keep their orientation`, { kind: 'info' });
  }
  function reorder(front) {
    const picked = els.filter((e) => sel.has(e.id)), rest = els.filter((e) => !sel.has(e.id));
    commit(front ? [...rest, ...picked] : [...picked, ...rest], front ? 'Bring to front' : 'Send to back');
  }
  function align(kind) {
    const list = selected(); if (list.length < 2) return;
    const b = boxOf(sel);
    commit(els.map((e) => {
      if (!sel.has(e.id)) return e;
      const [x, y, w, h] = elementBox(e, doc);
      const dx = kind === 'left' ? b[0] - x : kind === 'right' ? b[0] + b[2] - (x + w) : kind === 'center' ? b[0] + b[2] / 2 - (x + w / 2) : 0;
      const dy = kind === 'top' ? b[1] - y : kind === 'bottom' ? b[1] + b[3] - (y + h) : kind === 'middle' ? b[1] + b[3] / 2 - (y + h / 2) : 0;
      return dx || dy ? moved(e, f2(dx), f2(dy)) : e;
    }), 'Align ' + kind);
  }
  function flipSel() {
    const n = selected().filter((e) => e.kind === 'symbol').length;
    if (!n) { toast?.('Flip works on placed symbols', { kind: 'info' }); return; }
    commit(els.map((e) => {
      if (!sel.has(e.id) || e.kind !== 'symbol') return e;
      // mirror in place: keep the box where it is
      const [bx0] = elementBox(e, doc);
      const f = { ...structuredClone(e), flip: !e.flip };
      const [bx1] = elementBox(f, doc);
      return moved(f, f2(bx0 - bx1), 0);
    }), 'Flip');
  }
  function zoomToSelection() {
    const b = boxOf(sel); if (!b) return;
    const w = Math.max(b[2], b[3] * (vb[2] / vb[3])) * 1.6 + pxToPt(40);
    zoomTo(b[0] + b[2] / 2, b[1] + b[3] / 2, Math.max(w, doc.width / 40));
  }
  /** selection -> library symbol: geometry in mm relative to its box, pins where open strokes meet the box */
  function selectionAsSymbol() {
    const list = selected(); if (!list.length) return null;
    const shapes = list.flatMap((e) => elementShapes(e, doc));
    const paths = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of shapes) for (const p of s.paths || []) {
      if (s.line_pattern === 0 && !s.fill_pattern) continue;
      for (const [x, y] of p) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      const closed = p.length > 2 && Math.hypot(p[0][0] - p.at(-1)[0], p[0][1] - p.at(-1)[1]) < 0.01;
      paths.push({ pts: p, closed, fill: closed && s.fill_pattern > 0, stroke: s.line_pattern !== 0, weight: s.line_weight_pt || 0.72 });
    }
    if (!paths.length) return null;
    for (const p of paths) p.pts = p.pts.map(([x, y]) => [f2(x - x0), f2(y - y0)]);
    const w = f2(x1 - x0), h = f2(y1 - y0), pins = [];
    for (const p of paths) if (!p.closed) for (const q of [p.pts[0], p.pts.at(-1)]) {
      if ((Math.abs(q[0]) < 0.3 || Math.abs(q[0] - w) < 0.3 || Math.abs(q[1]) < 0.3 || Math.abs(q[1] - h) < 0.3) && !pins.some((z) => Math.hypot(z[0] - q[0], z[1] - q[1]) < 0.5)) pins.push(q);
    }
    return { size: [w, h], paths, pins: pins.map((at, i) => ({ id: String(i + 1), at })) };
  }

  function nudge(dx, dy) { if (!sel.size) return; commit(withGlue(els.map((e) => (sel.has(e.id) ? moved(e, dx, dy) : e)), sel, dx, dy), 'Nudge'); }

  // clipboard: ids are remapped on paste so copies never collide (imported shapes included)
  function copy() {
    if (!sel.size) return;
    clipboard = structuredClone(selected());
    try { navigator.clipboard?.writeText(JSON.stringify({ ecad: 1, elements: clipboard })); } catch { /* clipboard permission */ }
    toast?.(`Copied ${clipboard.length} shape${clipboard.length > 1 ? 's' : ''}`, { kind: 'info', duration: 1400 });
  }
  function cut() { copy(); deleteSel(); }
  async function paste() {
    let list = clipboard;
    try { const t = await navigator.clipboard?.readText(); const j = t && JSON.parse(t); if (j?.ecad === 1) list = j.elements; } catch { /* not ours */ }
    if (!list?.length) return;
    let id = nextId({ elements: els });
    const off = GRID * 2;
    const fresh = list.map((e) => {
      const n = moved(structuredClone(e), off, off);
      const nid = id++;
      if (n.kind === 'visio') {
        const map = new Map(n.shapes.map((s, k) => [s.id, nid * 1000 + k]));
        map.set(n.id, nid);
        n.shapes = n.shapes.map((s) => ({ ...s, id: map.get(s.id), parent: s.parent == null ? null : map.get(s.parent) ?? null }));
        n.svg = n.svg.replace(/\bid="(shape|group)\d+-/, `id="$1${nid}-`);
      }
      n.id = nid;
      return n;
    });
    commit([...els, ...fresh], `Paste ${fresh.length}`);
    select(fresh.map((e) => e.id));
    clipboard = structuredClone(fresh);
  }
  function duplicate() { if (!sel.size) return; copy(); paste(); }
  function selectAll() { select(els.map((e) => e.id)); }

  // ------------------------------------------------------------------ tools
  function setTool(t) {
    if (draft) finishDraft();
    if (t !== 'place') placing = null;
    tool = t;
    stage.className = stage.className.replace(/\btool-\S+/g, '').trim() + ' tool-' + t;
    hoverId = null;
    drawOverlay();
    onTool?.(t, placing?.sym || null);
  }
  function escape() {
    if (draft) { cancelDraft(); return true; }
    if (tool !== 'select') { setTool('select'); return true; }
    if (sel.size) { select([]); return true; }
    if (marks.length) { marks = []; drawOverlay(); return true; }
    return false;
  }

  // ------------------------------------------------------------------ navigation (cross-reference)
  function focusShape(shapeId, key) {
    if (!pageIx) return;
    const hits = pageIx.texts.filter((t) => key && t.keys.includes(key));
    const t = pageIx.texts.find((q) => q.id === shapeId) || hits[0];
    marks = [...hits.map((h) => ({ kind: 'hit', box: h.box })), ...(t ? [{ kind: 'focus', box: t.box }] : [])];
    const owner = t && shapeOwner.get(t.id);
    sel = new Set(owner != null ? [owner] : []);
    emitSelect();
    if (t) zoomTo(t.at[0], t.at[1], Math.max(doc.width / 4, vb[2] < doc.width / 3 ? vb[2] : doc.width / 3.2)); else drawOverlay();
  }
  function gotoRow(ref) {
    if (!pageIx) return;
    const cols = [...new Set(pageIx.rows.map((r) => Math.round(r.x)))].sort((a, b) => a - b);
    const next = cols.find((c) => c > ref.x + 5);
    marks = [{ kind: 'band', x: f2(ref.x - 20), y: f2(ref.y - 12), w: f2((next ?? doc.width) - ref.x - 5), h: 24 }];
    zoomTo(Math.min(doc.width - doc.width / 4.4, Math.max(doc.width / 4.4, ref.x + doc.width / 4.4)), ref.y, doc.width / 2.2);
  }

  // ------------------------------------------------------------------ save / export
  async function save() {
    if (!doc) return null;
    const out = { ...doc, elements: els };
    delete out.saved;
    const r = await fetch(`/api/doc/${encodeURIComponent(project())}/${encodeURIComponent(doc.id)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doc: out, baseRev: doc.rev ?? null }),
    });
    const j = await r.json();
    if (!r.ok) throw Object.assign(new Error(j.error || 'save failed'), { status: r.status });
    doc.rev = j.rev; doc.saved = true; saved = els;
    emitChange();
    return j;
  }
  function exportSvg() {
    const clone = svg.cloneNode(true);
    clone.querySelector('#ec-ovl')?.remove(); clone.querySelector('#ec-grid')?.remove();
    clone.setAttribute('viewBox', `0 0 ${doc.width} ${doc.height}`);
    clone.setAttribute('width', `${doc.widthMm}mm`); clone.setAttribute('height', `${doc.heightMm}mm`);
    clone.querySelector('.paper')?.removeAttribute('class');
    return new XMLSerializer().serializeToString(clone);
  }

  // ------------------------------------------------------------------ wiring of DOM events
  stage.tabIndex = 0;
  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', onUp);
  stage.addEventListener('pointerleave', () => { if (hoverId) { hoverId = null; drawOverlay(); } });
  stage.addEventListener('dblclick', (e) => {
    if (tool === 'wire' || tool === 'line') { finishDraft(); return; }
    if (tool === 'select') {
      const id = elementAt(e.clientX, e.clientY);
      // references (L-number arrows) follow on double-click, like a cross-reference in an ECAD tool;
      // everything else edits its text (F2 edits a reference's text)
      if (id != null) { select([id]); if (!navigateFrom(id)) editSelectedText(); }
    }
  });
  stage.addEventListener('wheel', (e) => { if (!doc) return; e.preventDefault(); zoomBy(Math.exp(e.deltaY * 0.0015), e.clientX, e.clientY); }, { passive: false });
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.target.closest('input,textarea,select')) { if (!spaceDown) { spaceDown = true; stage.classList.add('panning'); } if (e.target === stage || e.target === document.body) e.preventDefault(); } });
  addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceDown = false; stage.classList.remove('panning'); } });
  new ResizeObserver(() => drawOverlay()).observe(stage);

  /** double-click on an L-number arrow / reference: follow it */
  function navigateFrom(id) {
    const t = textsOf([byId(id)]).find((q) => q.key && /^L\d{3,6}$/.test(q.key) && !q.row);
    if (t) onNavigate?.({ line: t.key });
    return !!t;
  }

  return {
    open, save, fit, zoomBy, zoomTo, zoomPct, zoomToPct, exportSvg, setTool, escape, undo, redo,
    deleteSel, rotateSel, flipSel, zoomToSelection, selectionAsSymbol, reorder, align, nudge, copy, cut, paste, duplicate, selectAll, select, update, editSelectedText,
    startPlace, dropSymbol, setSymbols, setLanguage, focusShape, gotoRow, finishDraft,
    async rename(name) { if (!doc) return; doc.name = name; saved = null; emitChange(); return save(); },
    setDict(d) { dict = d; },
    /** findings of the electrical check on this sheet: [{ shape, key, severity }] */
    setIssues(list) { issues = list || []; drawOverlay(); },
    get doc() { return doc ? { ...doc, elements: els } : null; },
    get dirty() { return !!doc && els !== saved; },
    get tool() { return tool; },
    get selection() { return selected(); },
    get index() { return pageIx; },
    get placing() { return placing; },
    set grid(v) { showGrid = v; drawGrid(); }, get grid() { return showGrid; },
    set snap(v) { snapOn = v; }, get snap() { return snapOn; },
    // the background page (frame + title block) is never editable here; this only hides it
    set background(v) { bgLocked = v; if (bgLayer) bgLayer.style.display = v ? '' : 'none'; }, get background() { return bgLocked; },
    rotateGhost() { if (placing) { placing.rot = (placing.rot + 90) % 360; } },
    elementOfShape: (sid) => shapeOwner.get(sid),
    /** right-click: select what is under the pointer unless it is already part of the selection */
    pickAt(cx, cy) { const id = elementAt(cx, cy); if (id != null && !sel.has(id)) select([id]); if (id == null && sel.size) select([]); return id; },
  };
}
