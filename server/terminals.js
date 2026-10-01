// Terminal plan and wire marking labels of a cabinet, from what the project already knows:
// the cabinet's terminal strips (position -> wire number on the up / down side, read from the layout),
// the wire list derived from the drawings (which device each wire runs to) and the module cables
// (which core carries which wire to which box).

const key = (t) => String(t || '').toUpperCase();

/** wire ends landing on a strip terminal, as "TB12:5" -> [{ wire, to }] */
function wireEnds(wires) {
  const at = new Map();
  const add = (end, other, w) => {
    if (!end?.tag || end.pin == null) return;
    const k = `${key(end.tag)}:${end.pin}`;
    if (!at.has(k)) at.set(k, []);
    at.get(k).push({ wire: w.no || null, to: `${other.tag}${other.pin != null ? ':' + other.pin : ''}`, line: w.line || null });
  };
  for (const w of wires) { add(w.from, w.to, w); add(w.to, w.from, w); }
  return at;
}

/** cable cores by wire number: "X0105" -> [{ cable, core, from, to, signal }] */
function coresByWire(modules) {
  const m = new Map();
  for (const mod of modules) for (const c of mod.cables || []) for (const core of c.cores || []) {
    if (!core.wire) continue;
    const k = key(core.wire);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push({ cable: c.tag, core: core.core, from: c.from, to: c.to, signal: core.signal || '' });
  }
  return m;
}

/**
 * Terminal plan: per strip and position, the wire numbers on the up / down side (layout), whether the next
 * terminal carries the same wire (bridge), and what the terminal connects to - wire-list wires ending on it
 * and cable cores carrying one of its wires. The wire list does not know the side, so `links` is per terminal.
 */
export function terminalPlan({ cabinet, wires = [], modules = [] }) {
  const ends = wireEnds(wires), cores = coresByWire(modules);
  const strips = Object.entries(cabinet.terminal_strips || {}).map(([tag, s]) => {
    const list = (s.terminals || []).slice().sort((a, b) => a.pos - b.pos);
    const coreDone = new Set();                     // a cable core lands once: on the first terminal carrying its wire
    const terminals = list.map((t, i) => {
      const next = list[i + 1];
      const bridge = (side) => !!(t[side] && next && next.pos === t.pos + 1 && key(next[side]) === key(t[side]));
      const links = [];
      for (const e of ends.get(`${key(tag)}:${t.pos}`) || []) links.push({ wire: e.wire, to: e.to, via: 'wire', line: e.line });
      for (const w of new Set([t.up, t.down].filter(Boolean).map(key))) for (const c of cores.get(w) || []) {
        const k = `${c.cable}#${c.core}`;
        if (coreDone.has(k)) continue;
        coreDone.add(k);
        links.push({ wire: w, to: `${c.cable} core ${c.core} (${c.from} → ${c.to})`, via: 'cable' });
      }
      const seen = new Set();
      return { pos: t.pos, up: t.up || null, down: t.down || null, bridgeUp: bridge('up'), bridgeDown: bridge('down'),
        links: links.filter((l) => { const k = `${l.wire}|${l.to}`; if (seen.has(k)) return false; seen.add(k); return true; }) };
    });
    return { tag, part: s.part || null, terminals };
  });
  return { cabinet: cabinet.id, strips };
}

/**
 * Marking labels: one per wire end. Wires of the wire list give two each (from end, to end); strip
 * terminals give one for every side whose wire the list does not already end there; cable cores give one
 * per core end. `mark` is the text to print (the wire number; PLC wires carry the address "0000 00").
 */
export function wireLabels({ cabinet, wires = [], modules = [], plan = null }) {
  const out = [];
  const push = (mark, at, wire, source) => { if (mark) out.push({ mark, at, wire: wire || mark, source }); };
  const endTxt = (e) => `${e.tag}${e.pin != null ? ':' + e.pin : ''}`;
  // every wire of the list has two ends; remember the ends that land on a strip terminal
  const covered = new Map();
  for (const w of wires) {
    if (!w.no) continue;
    // a wire the drawing gives no number is named after its line (L00063): say so on the label list
    const src = /^L\d{3,6}$/.test(w.no) ? 'wire list (no wire number: named after its line)' : 'wire list';
    for (const e of [w.from, w.to]) {
      push(w.no, endTxt(e), w.no, src);
      const k = `${key(w.no)}@${key(endTxt(e))}`;
      covered.set(k, (covered.get(k) || 0) + 1);
    }
  }
  // strip terminals: one label per wired side, unless a wire-list end already accounts for it
  for (const s of (plan || terminalPlan({ cabinet, wires, modules })).strips) {
    for (const t of s.terminals) for (const side of ['up', 'down']) {
      if (!t[side]) continue;
      const k = `${key(t[side])}@${key(`${s.tag}:${t.pos}`)}`;
      if (covered.get(k) > 0) { covered.set(k, covered.get(k) - 1); continue; }
      push(t[side], `${s.tag}:${t.pos} ${side}`, t[side], 'terminal strip');
    }
  }
  for (const mod of modules) for (const c of mod.cables || []) {
    if (c.from !== cabinet.id && c.to !== cabinet.id) continue;
    for (const core of c.cores || []) if (core.wire) {
      push(core.wire, `${c.tag} core ${core.core} @${c.from}`, core.wire, 'cable');
      push(core.wire, `${c.tag} core ${core.core} @${c.to}`, core.wire, 'cable');
    }
  }
  const unnumbered = wires.filter((w) => !w.no).map((w) => `${endTxt(w.from)} → ${endTxt(w.to)}`);
  return { cabinet: cabinet.id, labels: out.sort((a, b) => a.mark.localeCompare(b.mark, 'en', { numeric: true }) || a.at.localeCompare(b.at)), unnumbered };
}

export function terminalSheets(plan, { project = '' } = {}) {
  const rows = [];
  for (const s of plan.strips) for (const t of s.terminals) {
    rows.push([s.tag, t.pos, t.up || '', t.bridgeUp ? `${t.pos}-${t.pos + 1}` : '', t.down || '', t.bridgeDown ? `${t.pos}-${t.pos + 1}` : '',
      t.links.map((l) => `${l.wire ? l.wire + ' → ' : ''}${l.to}`).join('; ')]);
  }
  return [{ name: `Terminals ${plan.cabinet}`, columns: [{ header: 'Strip', width: 8 }, { header: 'Pos', width: 5 }, { header: 'Up wire', width: 10 }, { header: 'Up bridge', width: 9 },
    { header: 'Down wire', width: 10 }, { header: 'Down bridge', width: 10 }, { header: 'Connects to (wire → device / cable core)', width: 60 }], rows },
  { name: 'About', columns: [{ header: 'Field', width: 18 }, { header: 'Value', width: 80 }], rows: [
    ['Project', project], ['Cabinet', plan.cabinet], ['Generated', new Date().toISOString().slice(0, 16).replace('T', ' ')],
    ['Wires', 'Up/down wire numbers from the cabinet layout; "goes to" from the wire list derived from the drawings and from module cable cores.'],
    ['Bridge', 'The next terminal carries the same wire on that side: fit a jumper.']] }];
}

/** CSV for tube / label printers: one line per label (UTF-8 with BOM so Excel keeps the characters) */
export function labelsCsv(labels) {
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  return '﻿' + ['Mark;Position;Wire;Source', ...labels.labels.map((l) => [l.mark, l.at, l.wire, l.source].map(q).join(';'))].join('\r\n') + '\r\n';
}
