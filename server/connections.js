// From-to connections derived from the drawings' nets, resolved against a cabinet's components.
//  net -> {devices (symbol groups touching it), labels (wire numbers, PLC addresses)}
//  device tag       -> component with the same tag           (CRPB1 contact -> CRPB1 relay)
//  PLC address      -> I/O unit, by the unit headers on the IO sheets ("CH 0000" over "INPUT UNIT")
//  wire number      -> terminal-strip positions carrying it   (P24A -> TB12 1/2)
import { buildNets, labelsOfNet } from '../lib/nets.js';

const ADDR_RE = /^CH(\d\d)\.(\d{3})$/;

/** "CH00" -> "IN1" etc., read from the sheets: unit type text and "CH 00xx" header in the same column */
export function unitMap(ix) {
  const units = [];
  for (const p of ix.pages.values()) {
    const heads = p.texts.filter((t) => /^CH\s?\d{4}$/.test(t.text.trim()));
    for (const h of heads) {
      const kind = p.texts.find((t) => /(INPUT|OUTPUT) UNIT/.test(t.text) && Math.abs(t.box[0] - h.box[0]) < 8);
      if (kind) units.push({ ch: Number(h.text.replace(/\D/g, '')), dir: /INPUT/.test(kind.text) ? 'IN' : 'OUT' });
    }
  }
  units.sort((a, b) => a.ch - b.ch);
  const map = new Map(), count = { IN: 0, OUT: 0 };
  for (const u of units) if (!map.has(u.ch)) map.set(u.ch, `${u.dir}${++count[u.dir]}`);
  return map;
}

export function sheetNets(ix) {
  const out = [];
  for (const p of ix.pages.values()) {
    // only schematics: they carry the L-number margin. Layouts and block diagrams draw boxes, not nets.
    if (!p.segs.length || p.rows.length < 5) continue;
    const nets = buildNets(p.segs);
    const groups = new Map();
    p.segs.forEach((s, i) => { if (!groups.has(nets[i])) groups.set(nets[i], []); groups.get(nets[i]).push(i); });
    for (const [id, idx] of groups) {
      const devices = [...new Set(idx.map((i) => p.owner[p.segs[i][4]]).filter(Boolean))];
      const labels = labelsOfNet(p.texts, p.segs, nets, id);
      const keys = [...new Set(labels.flatMap((t) => t.keys))];
      if (!devices.length && !keys.length) continue;
      const line = labels.find((t) => t.line)?.line || null;
      out.push({ page: p.id, net: id, segments: idx.length, devices, keys, line });
    }
  }
  return out;
}

/** Wires for one cabinet: nets whose ends resolve to >= 2 components in it. */
export function cabinetWires(ix, cabinet) {
  const comps = new Map((cabinet.components || []).map((c) => [c.tag.toUpperCase(), c]));
  const units = unitMap(ix);
  const strips = cabinet.terminal_strips || {};
  const wires = [], unresolved = [];
  for (const n of sheetNets(ix)) {
    const ends = [];
    const add = (tag, pin, why) => { if (comps.has(tag) && !ends.some((e) => e.tag === tag && e.pin === pin)) ends.push({ tag, pin, why }); };
    for (const d of n.devices) add(d.toUpperCase(), null, 'device');
    const wireNos = [];
    for (const k of n.keys) {
      const m = ADDR_RE.exec(k);
      if (m) { const u = units.get(Number(m[1])); if (u) add(u, m[2], 'address ' + k); continue; }
      if (comps.has(k)) { add(k, null, 'label'); continue; }
      let onStrip = false;
      for (const [strip, st] of Object.entries(strips)) {
        const pos = (st.terminals || []).find((t) => t.up === k || t.down === k);
        if (pos) { add(strip.toUpperCase(), String(pos.pos), 'terminal ' + k); onStrip = true; break; }
      }
      if (!onStrip || /^[PZ]\d/.test(k)) wireNos.push(k);
    }
    if (ends.length < 2) { if (ends.length === 1 || n.devices.length) unresolved.push({ ...n, ends }); continue; }
    // daisy-chain: start at a terminal strip if there is one, then nearest neighbour on the plate
    const pos = (e) => { const c = comps.get(e.tag); return [c.x + c.w / 2, c.y + c.h / 2]; };
    const rest = [...ends];
    const start = rest.findIndex((e) => e.why.startsWith('terminal'));
    const chain = [rest.splice(start >= 0 ? start : 0, 1)[0]];
    while (rest.length) {
      const [x, y] = pos(chain.at(-1));
      let bi = 0, bd = Infinity;
      rest.forEach((e, i) => { const [a, b] = pos(e); const d = Math.hypot(a - x, b - y); if (d < bd) { bd = d; bi = i; } });
      chain.push(rest.splice(bi, 1)[0]);
    }
    // Denso mark tube on PLC wires is the address, "XXXX XX" = word + bit (remark box on the IO sheets)
    const addr = n.keys.map((k) => ADDR_RE.exec(k)).find(Boolean);
    const no = addr ? `00${addr[1]} ${addr[2].slice(1)}` : wireNos.find((k) => /^[PZ]\d/.test(k)) || wireNos[0] || n.line || null;
    for (let i = 1; i < chain.length; i++) {
      wires.push({ id: `${n.page}#${n.net}#${i}`, no, from: chain[i - 1], to: chain[i], page: n.page, line: n.line, keys: n.keys });
    }
  }
  return { wires, unresolved, units: Object.fromEntries([...units].map(([k, v]) => ['CH' + String(k).padStart(2, '0'), v])) };
}
