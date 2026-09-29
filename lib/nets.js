// Electrical connectivity of a drawn sheet. Shared by the server (connection extraction) and the
// browser (net highlight), so a net lit on screen is exactly the net a wire list is built from.
// Segments: [x1, y1, x2, y2, shapeId] in sheet units.

export const JOIN_TOL = 0.9;   // points: endpoint-to-segment distance that counts as touching

export function distSeg(px, py, s) {
  const [x1, y1, x2, y2] = s, dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy;
  const u = L ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / L)) : 0;
  return Math.hypot(px - (x1 + u * dx), py - (y1 + u * dy));
}

/** net id per segment. Shared endpoints and endpoints landing on another segment (T) join;
 *  a crossing without an endpoint does not - that is what a crossing without a dot means. */
export function buildNets(S, tol = JOIN_TOL) {
  const n = S.length, par = Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (par[i] !== i) i = par[i] = par[par[i]]; return i; };
  // bucket by grid cell so large sheets stay fast
  const CELL = 40, grid = new Map();
  const cells = (s) => {
    const out = [];
    for (let gx = Math.floor((Math.min(s[0], s[2]) - tol) / CELL); gx <= Math.floor((Math.max(s[0], s[2]) + tol) / CELL); gx++)
      for (let gy = Math.floor((Math.min(s[1], s[3]) - tol) / CELL); gy <= Math.floor((Math.max(s[1], s[3]) + tol) / CELL); gy++) out.push(gx + ',' + gy);
    return out;
  };
  S.forEach((s, i) => { for (const c of cells(s)) { if (!grid.has(c)) grid.set(c, []); grid.get(c).push(i); } });
  for (let i = 0; i < n; i++) {
    const a = S[i];
    for (const [px, py] of [[a[0], a[1]], [a[2], a[3]]]) {
      const c = Math.floor(px / CELL) + ',' + Math.floor(py / CELL);
      for (const j of grid.get(c) || []) {
        if (j !== i && distSeg(px, py, S[j]) < tol) {
          const ra = find(i), rb = find(j);
          if (ra !== rb) par[ra] = rb;
        }
      }
    }
  }
  return S.map((_, i) => find(i));
}

/** Keyed texts that belong to a net: a label belongs to the net whose wire is NEAREST to it
 *  (P24A and Z24A labels sit side by side over their two buses). */
export function labelsOfNet(texts, S, nets, id, pad = 6) {
  return texts.filter((t) => {
    if (!t.keys?.length || t.row) return false;
    const cx = t.box[0] + t.box[2] / 2, cy = t.box[1] + t.box[3] / 2;
    let best = -1, bd = Math.max(t.box[2], t.box[3]) / 2 + pad;
    S.forEach((s, k) => { const d = distSeg(cx, cy, s); if (d < bd) { bd = d; best = k; } });
    return best >= 0 && nets[best] === id;
  });
}
