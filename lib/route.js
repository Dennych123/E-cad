// Wire routing on the back plate through the wiring ducts. Pure data, plate coordinates (mm,
// origin bottom-left of the plate, y up). Shared by server (lengths for the wire list) and browser.
//
// Graph: the centreline of every duct; nodes at duct ends, at duct crossings, and where a
// component drops into its duct. A component leaves through the nearest horizontal duct straight
// above or below it (how panels are wired: out of the device, into the duct over its rail row).

const EPS = 1;

function centreline(d) {
  return d.w >= d.h
    ? { dir: 'h', a: [d.x, d.y + d.h / 2], b: [d.x + d.w, d.y + d.h / 2], d }
    : { dir: 'v', a: [d.x + d.w / 2, d.y], b: [d.x + d.w / 2, d.y + d.h], d };
}

export function buildDuctGraph(ducts) {
  const lines = ducts.map(centreline);
  const pts = lines.map(() => []);               // points on each centreline
  const nodes = [], key = new Map(), adj = [];
  const node = (x, y) => {
    const k = `${Math.round(x * 10)},${Math.round(y * 10)}`;
    if (!key.has(k)) { key.set(k, nodes.length); nodes.push([x, y]); adj.push([]); }
    return key.get(k);
  };
  const extra = [];                              // links not along one centreline (duct end -> side of another)
  lines.forEach((l, i) => { pts[i].push(node(...l.a), node(...l.b)); });
  // crossings / touches between a horizontal and a vertical duct
  for (let i = 0; i < lines.length; i++) for (let j = 0; j < lines.length; j++) {
    const h = lines[i], v = lines[j];
    if (h.dir !== 'h' || v.dir !== 'v') continue;
    const x = v.a[0], y = h.a[1];
    const hx0 = h.a[0] - EPS, hx1 = h.b[0] + EPS;
    const reach = x >= hx0 && x <= hx1;
    // a horizontal duct that ENDS against a vertical duct (edge to edge) still joins it
    const touches = !reach && (Math.abs(h.b[0] - v.d.x) <= EPS || Math.abs(h.a[0] - (v.d.x + v.d.w)) <= EPS);
    if ((reach || touches) && y >= v.a[1] - EPS && y <= v.b[1] + EPS) {
      const n = node(x, y);
      pts[j].push(n);
      if (reach) pts[i].push(n);
      else extra.push([Math.abs(h.b[0] - v.d.x) <= EPS ? node(...h.b) : node(...h.a), n]);
    }
  }
  const link = (a, b) => {
    const w = Math.hypot(nodes[a][0] - nodes[b][0], nodes[a][1] - nodes[b][1]);
    adj[a].push([b, w]); adj[b].push([a, w]);
  };
  const g = { nodes, adj, lines, pts, node };
  /** (re)link every centreline through its sorted points; call after adding attach points */
  g.rebuild = () => {
    for (const a of adj) a.length = 0;
    lines.forEach((l, i) => {
      const along = l.dir === 'h' ? 0 : 1;
      const ps = [...new Set(pts[i])].sort((p, q) => nodes[p][along] - nodes[q][along]);
      for (let k = 1; k < ps.length; k++) link(ps[k - 1], ps[k]);
    });
    for (const [a, b] of extra) link(a, b);
  };
  g.rebuild();
  return g;
}

/** Where a component meets the duct system: the nearest horizontal duct straight above or below it. */
export function attach(g, c) {
  const cx = c.x + c.w / 2;
  let best = null;
  g.lines.forEach((l, i) => {
    if (l.dir !== 'h' || cx < l.a[0] || cx > l.b[0]) return;
    const y = l.a[1];
    const gap = y >= c.y + c.h ? y - (c.y + c.h) : y <= c.y ? c.y - y : Infinity;   // must be outside the part
    if (gap < (best?.gap ?? Infinity)) best = { i, y, gap, exit: y > c.y ? [cx, c.y + c.h] : [cx, c.y] };
  });
  if (!best) {                                   // no duct above/below: nearest point on any centreline
    let bd = Infinity;
    g.lines.forEach((l, i) => {
      const t = l.dir === 'h' ? Math.max(l.a[0], Math.min(l.b[0], cx)) : Math.max(l.a[1], Math.min(l.b[1], c.y + c.h / 2));
      const p = l.dir === 'h' ? [t, l.a[1]] : [l.a[0], t];
      const d = Math.hypot(p[0] - cx, p[1] - (c.y + c.h / 2));
      if (d < bd) { bd = d; best = { i, y: p[1], x: p[0], gap: d, exit: [cx, c.y + c.h / 2] }; }
    });
  }
  const n = g.node(best.x ?? cx, best.y);
  g.pts[best.i].push(n);
  return { node: n, exit: best.exit };
}

function dijkstra(g, s, t) {
  const dist = new Map([[s, 0]]), prev = new Map(), done = new Set();
  const open = [[0, s]];
  while (open.length) {
    open.sort((a, b) => a[0] - b[0]);
    const [d, u] = open.shift();
    if (done.has(u)) continue;
    done.add(u);
    if (u === t) break;
    for (const [v, w] of g.adj[u]) {
      const nd = d + w;
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u); open.push([nd, v]); }
    }
  }
  if (!dist.has(t)) return null;
  const path = [t];
  while (path[0] !== s) path.unshift(prev.get(path[0]));
  return path;
}

/** Route every wire. Returns [{id, points:[[x,y],...], length, ok}] with length incl. `slack` mm. */
export function routeWires(box, components, wires, { slack = 150 } = {}) {
  const g = buildDuctGraph(box.ducts || []);
  const comp = new Map(components.map((c) => [c.tag.toUpperCase(), c]));
  const at = new Map();
  for (const w of wires) for (const e of [w.from, w.to]) {
    const c = comp.get(e.tag.toUpperCase());
    if (c && !at.has(e.tag)) at.set(e.tag, attach(g, c));
  }
  g.rebuild();
  return wires.map((w) => {
    const A = at.get(w.from.tag), B = at.get(w.to.tag);
    if (!A || !B) return { id: w.id, ok: false, points: [], length: 0 };
    const path = A.node === B.node ? [A.node] : dijkstra(g, A.node, B.node);
    if (!path) return { id: w.id, ok: false, points: [A.exit, B.exit], length: 0 };
    const points = [A.exit, ...path.map((n) => g.nodes[n]), B.exit];
    let L = 0;
    for (let i = 1; i < points.length; i++) L += Math.abs(points[i][0] - points[i - 1][0]) + Math.abs(points[i][1] - points[i - 1][1]);
    return { id: w.id, ok: true, points, length: Math.round(L + slack) };
  });
}
