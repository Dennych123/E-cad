// Live 2D sheets: the original Visio drawing (its own SVG export), made clickable.
//  - click a tag / wire number / address -> cross-reference across every sheet
//  - click an L-number reference          -> jump to that line
//  - click a wire                          -> highlight its whole connected net (endpoint + T-junction joins)
import { buildNets as netsOf, distSeg, labelsOfNet } from '/lib/nets.js';

const SVGNS = 'http://www.w3.org/2000/svg';

export function createSheetView(el, { api, project, onKey, onNet }) {
  let page = null, svg = null, vb = null, ovl = null, nets = null;
  const cache = new Map(), svgCache = new Map();

  el.innerHTML = '<div class="sheet-empty">pick a sheet</div>';

  async function load(pageId) {
    if (page?.id === pageId) return page;
    const [p, text] = await Promise.all([
      cache.get(pageId) || api(`/api/sheet/${encodeURIComponent(project())}/${encodeURIComponent(pageId)}`),
      svgCache.get(pageId) || fetch(`/raw/${encodeURIComponent(project())}/${pageId.split('/').map(encodeURIComponent).join('/')}.svg`).then((r) => r.text()),
    ]);
    cache.set(pageId, p); svgCache.set(pageId, text);
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    svg = document.importNode(doc.documentElement, true);
    svg.removeAttribute('width'); svg.removeAttribute('height');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    el.replaceChildren(svg);
    ovl = document.createElementNS(SVGNS, 'g');
    ovl.setAttribute('pointer-events', 'none');
    svg.appendChild(ovl);
    page = p;
    page.byId = new Map(p.texts.map((t) => [t.id, t]));
    nets = null;
    fit();
    return page;
  }

  // ---- view box pan / zoom ------------------------------------------------
  const setVB = () => svg.setAttribute('viewBox', vb.map((v) => v.toFixed(2)).join(' '));
  function fit() { vb = [0, 0, page.width, page.height]; setVB(); }
  function toSvg(cx, cy) {
    const pt = svg.createSVGPoint(); pt.x = cx; pt.y = cy;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }
  function zoomTo(x, y, w) {
    const h = w * page.height / page.width;
    vb = [x - w / 2, y - h / 2, w, h]; setVB();
  }
  el.addEventListener('wheel', (e) => {
    if (!svg) return;
    e.preventDefault();
    const p = toSvg(e.clientX, e.clientY), k = Math.exp(e.deltaY * 0.0015);
    const w = Math.min(page.width * 2, Math.max(page.width / 60, vb[2] * k)), s = w / vb[2];
    vb = [p.x - (p.x - vb[0]) * s, p.y - (p.y - vb[1]) * s, w, vb[3] * s]; setVB();
  }, { passive: false });
  let drag = null;
  el.addEventListener('pointerdown', (e) => { if (svg) { drag = { x: e.clientX, y: e.clientY, vb: [...vb], moved: false }; el.setPointerCapture(e.pointerId); } });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    const r = el.getBoundingClientRect(), s = Math.max(drag.vb[2] / r.width, drag.vb[3] / r.height);
    vb = [drag.vb[0] - dx * s, drag.vb[1] - dy * s, drag.vb[2], drag.vb[3]]; setVB();
  });
  el.addEventListener('pointerup', (e) => {
    const d = drag; drag = null;
    if (!d || d.moved || !svg) return;
    click(e);
  });
  el.addEventListener('dblclick', () => svg && fit());

  // ---- picking -------------------------------------------------------------
  // Visio's export holds the background page (title block) too, with shape ids that collide with the
  // foreground page's: only groups inside the foreground page are this page's shapes.
  let fg = null;
  function textAt(target) {
    fg = fg && svg.contains(fg) ? fg : [...svg.children].find((c) => c.getAttribute('v:groupContext') === 'foregroundPage') || svg;
    if (!target || !fg.contains(target)) return null;
    for (let g = target; g && g !== fg; g = g.parentNode) {
      const m = /^shape(\d+)-/.exec(g.id || '');
      if (m && page.byId.has(Number(m[1]))) return page.byId.get(Number(m[1]));
    }
    return null;
  }
  function click(e) {
    // pointer capture retargets the event to `el`, so ask what is really under the cursor
    const t = textAt(document.elementFromPoint(e.clientX, e.clientY));
    if (t && t.keys.length) {
      const key = t.keys.includes(t.key) ? t.key : t.keys[0];
      mark([t]);
      return onKey(key, { page: page.id, text: t });
    }
    const p = toSvg(e.clientX, e.clientY);
    const tol = 6 * vb[2] / el.getBoundingClientRect().width;
    const seg = nearestSeg(p.x, p.y, tol);
    if (seg >= 0) return showNet(seg);
    clear();
    onKey(null);
  }

  function nearestSeg(x, y, tol) {
    let best = -1, bd = tol;
    page.segs.forEach((s, i) => { const d = distSeg(x, y, s); if (d < bd) { bd = d; best = i; } });
    return best;
  }

  function showNet(i) {
    if (!nets) nets = netsOf(page.segs);
    const id = nets[i];
    const segs = page.segs.filter((_, k) => nets[k] === id);
    clear();
    for (const s of segs) {
      const l = document.createElementNS(SVGNS, 'line');
      l.setAttribute('x1', s[0]); l.setAttribute('y1', s[1]); l.setAttribute('x2', s[2]); l.setAttribute('y2', s[3]);
      l.setAttribute('class', 'ecad-net');
      ovl.appendChild(l);
    }
    // labels sitting on the net: wire numbers, tags right next to a highlighted segment
    const near = labelsOfNet(page.texts, page.segs, nets, id);
    mark(near, 'ecad-netlabel');
    onNet({ page: page.id, segments: segs.length, labels: [...new Set(near.flatMap((t) => t.keys))] });
  }

  function mark(texts, cls = 'ecad-hit', keep = false) {
    if (!keep) for (const n of [...ovl.querySelectorAll('.' + cls)]) n.remove();
    for (const t of texts) {
      const r = document.createElementNS(SVGNS, 'rect');
      const pad = 2.5;
      r.setAttribute('x', t.box[0] - pad); r.setAttribute('y', t.box[1] - pad);
      r.setAttribute('width', t.box[2] + 2 * pad); r.setAttribute('height', t.box[3] + 2 * pad);
      r.setAttribute('rx', 2); r.setAttribute('class', cls);
      ovl.appendChild(r);
    }
  }
  function clear() { if (ovl) ovl.replaceChildren(); }

  function band(y, x) {
    const row = page.rows.find((r) => Math.abs(r.y - y) < 1 && (x === undefined || Math.abs(r.x - x) < 1));
    const cols = [...new Set(page.rows.map((r) => Math.round(r.x)))].sort((a, b) => a - b);
    const x0 = row ? row.x - 20 : 0, next = cols.find((c) => c > (row?.x ?? 0) + 5);
    const r = document.createElementNS(SVGNS, 'rect');
    r.setAttribute('x', x0); r.setAttribute('y', y - 12);
    r.setAttribute('width', (next ?? page.width) - x0 - 25); r.setAttribute('height', 24);
    r.setAttribute('class', 'ecad-band');
    ovl.appendChild(r);
  }

  return {
    load, fit,
    get page() { return page; },
    /** show one occurrence: load its page, frame it, highlight all hits of `key` on that page */
    async focus(pageId, textId, key) {
      await load(pageId);
      clear();
      const hits = page.texts.filter((t) => key && t.keys.includes(key));
      mark(hits);
      const t = page.byId.get(textId) || hits[0];
      if (t) { mark([t], 'ecad-focus', true); zoomTo(t.at[0], t.at[1], page.width / 3.2); }
    },
    async gotoLine(ref) {
      await load(ref.page);
      clear();
      band(ref.y, ref.x);
      zoomTo(page.width / 4 + (ref.x > page.width / 2 ? page.width / 2 : 0), ref.y, page.width / 2.2);
    },
  };
}
