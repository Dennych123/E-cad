// Electrical rule check (ERC) for a project: reads the same index the editor and the cross-reference
// use, and reports findings with a location on the drawing. Every rule says what it measured; rules
// that estimate (power budget) list the assumptions they used.
//
// finding: { rule, severity: 'error'|'warning'|'info', message, where: [{page, shape?, line?, key?}], data? }
import { sheetNets } from './connections.js';
import { hasJapanese, translate } from '../lib/i18n.js';

export const RULES = [
  { id: 'supply.short', title: 'Supply shorted', severity: 'error', help: 'A net carries a supply and its return (P24 with Z24), or two different voltages. Powering it trips the protector or damages the supply.' },
  { id: 'supply.merged', title: 'Protected branches joined', severity: 'warning', help: 'Two branches of the same supply (P24A and P24B) meet on one net, so the circuit protector that separates them is bypassed. Joined 0 V returns are reported as info.' },
  { id: 'power.budget', title: 'Branch load within its protector', severity: 'warning', help: 'Estimated current on each protected 24 V branch against its circuit protector: >100 % error, >80 % warning. Estimate: coils, PLC inputs, lamps and solenoids drawn on the sheets whose bus is that branch.' },
  { id: 'relay.contacts-over', title: 'Relay contacts within the relay', severity: 'error', help: 'More contacts of a relay are drawn than the relay has poles (e.g. G7SA-3A1B = 4).' },
  { id: 'relay.table-mismatch', title: 'Contact table matches the contacts', severity: 'warning', help: 'The L-numbers in the table beside a coil must be exactly the lines where its contacts are drawn.' },
  { id: 'relay.no-coil', title: 'Every contact has a coil', severity: 'warning', help: 'Contacts of a relay are drawn but its coil is not (on any sheet).' },
  { id: 'relay.coil-twice', title: 'Each coil drawn once', severity: 'error', help: 'The same relay coil appears on more than one line.' },
  { id: 'relay.part-unknown', title: 'Relay part in the maker lineup', severity: 'info', help: 'A coil is labelled with a relay part that is not in the known lineup: check the part number.' },
  { id: 'plc.address-reuse', title: 'PLC address used once', severity: 'warning', help: 'The same PLC I/O address is wired on more than one rung.' },
  { id: 'drawing.dangling', title: 'No loose wire ends', severity: 'warning', help: 'A wire drawn in the editor ends on nothing (no pin, no other wire).' },
  { id: 'drawing.duplicate-tag', title: 'Placed symbols have unique tags', severity: 'error', help: 'Two symbols placed in the editor carry the same tag.' },
  { id: 'cabinet.not-in-drawing', title: 'Panel parts are on the drawings', severity: 'warning', help: 'A device placed in a cabinet does not appear on any sheet.' },
  { id: 'cabinet.overlap', title: 'Panel parts do not overlap', severity: 'warning', help: 'Two parts on the mounting plate, or a part and a wiring duct, take the same place.' },
  { id: 'cabinet.outside', title: 'Panel parts fit on the plate', severity: 'warning', help: 'A part reaches past the edge of the mounting plate.' },
  { id: 'duct.fill', title: 'Wiring ducts not overfilled', severity: 'warning', help: 'Estimated fill of each duct from the routed wires: >70 % warning (no room for changes), >100 % error. Wire diameter from loads.yaml (wire_od_mm).' },
  { id: 'drawing.untranslated', title: 'Drawing text readable in English', severity: 'info', help: 'Japanese text with no English translation yet (add it to the i18n dictionary).' },
];

// relay parts whose label sits beside a coil (G9SA is a safety controller, not a coil label)
const RELAY_PART = /^(G7SA-(\d)A(\d)B|LY(\d)N?|MY(\d)N?)/;
const COIL_NEAR = 70;          // pt: a coil's tag is ~39 pt from its part label; contacts are >= 120 pt away
const SUPPLY = /^([PZ])(\d{2,3})([A-Z]\d?)?$/;
const DEVICE = /^(CR|MC|PB|PL|SS|KS|LS|PS|SOL|SV|CP|CB|FU|BZ|EMG|SW|PH|PX|NF|CV)[A-Z0-9]*\d/;

function pick(table, part) {
  for (const r of table || []) if (new RegExp(r.match).test(part || '')) return r;
  return null;
}

export function runChecks({ index, cabinets = [], docs = [], dict = new Map(), loads = {}, layouts = [] }) {
  const findings = [];
  const add = (rule, severity, message, where = [], data = undefined) => findings.push({ rule, severity, message, where, ...(data ? { data } : {}) });
  const schematic = new Set([...index.pages.values()].filter((p) => p.rows.length >= 5).map((p) => p.id));
  const nets = sheetNets(index);

  // ---------------------------------------------------------------- supplies
  for (const n of nets) {
    const sup = [...new Set(n.keys.filter((k) => SUPPLY.test(k)))].map((k) => { const [, pol, v, br] = SUPPLY.exec(k); return { k, pol, v, br: br || '' }; });
    if (sup.length < 2) continue;
    const where = [{ page: n.page, line: n.line, key: sup[0].k }];
    const byV = new Set(sup.map((s) => s.v)), byPol = new Set(sup.map((s) => s.pol));
    if (byPol.size > 1 && [...byV].some((v) => sup.filter((s) => s.v === v).length > 1 && new Set(sup.filter((s) => s.v === v).map((s) => s.pol)).size > 1))
      add('supply.short', 'error', `${sup.map((s) => s.k).join(' and ')} are on the same net: supply shorted to its return`, where);
    else if (byV.size > 1 && byPol.size === 1 && sup[0].pol === 'P')
      add('supply.short', 'error', `${sup.map((s) => s.k).join(' and ')} (different voltages) are on the same net`, where);
    else if (byPol.size === 1) {
      const zero = sup[0].pol === 'Z';
      add('supply.merged', zero ? 'info' : 'warning', zero ? `0 V returns ${sup.map((s) => s.k).join(', ')} are joined (common 0 V)` : `${sup.map((s) => s.k).join(' and ')} are joined: the protector between them is bypassed`, where);
    }
  }

  // ---------------------------------------------------------------- relays
  // Denso sheets: a coil is the tag drawn right beside its relay part label (G7SA-3A1B); everything else
  // with that tag is a contact. Contacts may carry a contact number: CR5A-1, CR5A-3 are CR5A.
  const textById = new Map(), partsOn = new Map(), lrefsOn = new Map();
  for (const p of index.pages.values()) {
    if (!schematic.has(p.id)) continue;
    for (const t of p.texts) {
      textById.set(`${p.id}|${t.id}`, t);
      const m = RELAY_PART.exec(String(t.text).trim());
      if (m) { if (!partsOn.has(p.id)) partsOn.set(p.id, []); partsOn.get(p.id).push({ part: m[0], at: t.at }); }
      if (t.key && /^L\d{3,6}$/.test(t.key) && !t.row && t.line) { const k = `${p.id}|${t.line}`; if (!lrefsOn.has(k)) lrefsOn.set(k, []); lrefsOn.get(k).push(t); }
    }
  }
  const coilPart = (o) => {
    const t = textById.get(`${o.page}|${o.id}`); if (!t) return null;
    let best = null, bd = COIL_NEAR;
    for (const q of partsOn.get(o.page) || []) { const d = Math.hypot(q.at[0] - t.at[0], q.at[1] - t.at[1]); if (d < bd) { bd = d; best = q.part; } }
    return best;
  };
  const relayTags = new Map();           // base tag -> occurrences (incl. suffixed contact keys)
  for (const [key, occ] of index.xref) {
    const m = /^(CR[A-Z0-9]+?)(-\d{1,2})?$/.exec(key);
    if (!m) continue;
    if (!relayTags.has(m[1])) relayTags.set(m[1], []);
    relayTags.get(m[1]).push(...occ);
  }
  // safety units (G9SA/G9SX) carry a CR-style name on their box and switch outputs, not a coil
  const unitNear = (o) => {
    const t = textById.get(`${o.page}|${o.id}`); if (!t) return false;
    const p = index.pages.get(o.page);
    return p.texts.some((q) => /^G9S[AX]-/.test(String(q.text).trim()) && Math.hypot(q.at[0] - t.at[0], q.at[1] - t.at[1]) < 300);
  };
  for (const [key, occ] of relayTags) {
    const sch = occ.filter((o) => schematic.has(o.page) && o.line);
    if (!sch.length) continue;
    const coils = sch.filter((o) => coilPart(o)), contacts = sch.filter((o) => !coilPart(o));
    const at = (o) => ({ page: o.page, shape: o.id, line: o.line, key });
    if (!coils.length) {
      if (contacts.length && !sch.some(unitNear)) add('relay.no-coil', 'warning', `${key}: ${contacts.length} contact(s) drawn (${contacts.map((o) => o.line).join(', ')}) but its coil is on no sheet of this project`, contacts.map(at));
      continue;
    }
    const coilLines = [...new Set(coils.map((o) => `${o.page}|${o.line}`))];
    if (coilLines.length > 1) add('relay.coil-twice', 'error', `${key}: coil drawn on ${coilLines.length} lines (${coils.map((o) => o.line).join(', ')})`, coils.map(at));
    const c = coils[0], part = coilPart(c);
    const m = /^G7SA-(\d)A(\d)B/.exec(part);
    const lineupG7 = loads.lineup?.G7SA || [];
    if (m && lineupG7.length && !lineupG7.includes(`${m[1]}A${m[2]}B`)) add('relay.part-unknown', 'info', `${key}: coil labelled ${part}, not in the G7SA lineup (${lineupG7.join(', ')})`, [at(c)]);
    const poles = m ? Number(m[1]) + Number(m[2]) : /^(LY|MY)(\d)/.test(part) ? Number(/^(LY|MY)(\d)/.exec(part)[2]) : null;
    const contactLines = [...new Set(contacts.map((o) => o.line))];
    if (poles && contactLines.length > poles) add('relay.contacts-over', 'error', `${key}: ${contactLines.length} contacts drawn, ${part} has ${poles} poles`, contacts.map(at), { part, poles, contacts: contactLines });
    // the contact table: L-numbers on the coil's line, to the right of the coil
    const ct = textById.get(`${c.page}|${c.id}`);
    const table = new Set((lrefsOn.get(`${c.page}|${c.line}`) || []).filter((t) => t.at[0] > ct.at[0]).map((t) => t.key));
    if (table.size) {
      const missing = contactLines.filter((l) => !table.has(l)), extra = [...table].filter((l) => !contactLines.includes(l));
      if (missing.length || extra.length) add('relay.table-mismatch', 'warning',
        `${key}: contact table lists ${[...table].join(', ')}; contacts are on ${contactLines.join(', ') || 'no line'}${missing.length ? ` (not listed: ${missing.join(', ')})` : ''}${extra.length ? ` (listed, no contact: ${extra.join(', ')})` : ''}`, [at(c)]);
    }
  }

  // ---------------------------------------------------------------- PLC addresses
  // Only the I/O sheets wire an address to a unit terminal; a sensor sheet that names the address it
  // goes to is a reference, not a second connection.
  const ioPages = new Set([...index.pages.values()].filter((p) => p.texts.some((t) => /(INPUT|OUTPUT) UNIT/.test(t.text))).map((p) => p.id));
  for (const [key, occ] of index.xref) {
    if (!/^CH\d\d\.\d{3}$/.test(key)) continue;
    const lines = [...new Set(occ.filter((o) => ioPages.has(o.page) && o.line).map((o) => `${o.page}|${o.line}`))];
    if (lines.length > 1) add('plc.address-reuse', 'warning', `${key} is wired on ${lines.length} rungs`, occ.map((o) => ({ page: o.page, shape: o.id, line: o.line, key })));
  }

  // ---------------------------------------------------------------- power budget per protected branch
  const assumptions = new Set();
  const current = (table, part, n = 1) => { const r = pick(loads[table], part); if (!r) return 0; if (r.source !== 'datasheet') assumptions.add(`${table.replace('_', ' ')} ${r.amps * 1000} mA (${r.ref})`); return r.amps * n; };
  // the supply of a schematic page = the positive label on its biggest net (the bus)
  const pageSupply = new Map();
  const byPage = new Map();
  for (const n of nets) { if (!byPage.has(n.page)) byPage.set(n.page, []); byPage.get(n.page).push(n); }
  for (const [pid, list] of byPage) {
    const pos = list.filter((n) => n.keys.some((k) => /^P\d{2}[A-Z]?$/.test(k))).sort((a, b) => b.segments - a.segments)[0];
    if (pos) pageSupply.set(pid, pos.keys.find((k) => /^P\d{2}[A-Z]?$/.test(k)));
  }
  const loadBy = new Map();              // supply -> {amps, items[]}
  for (const p of index.pages.values()) {
    const sup = pageSupply.get(p.id); if (!sup || !schematic.has(p.id)) continue;
    const L = loadBy.get(sup) || { amps: 0, items: [], pages: new Set() };
    L.pages.add(p.id);
    const coilKeys = new Set();
    const isIo = ioPages.has(p.id);
    for (const t of p.texts) {
      const cp_ = t.key && /^CR[A-Z0-9]+$/.test(t.key) ? coilPart({ page: p.id, id: t.id }) : null;
      if (cp_ && !coilKeys.has(t.key)) { coilKeys.add(t.key); const a = current('relay_coil', cp_); L.amps += a; L.items.push(`${t.key} coil ${(a * 1000).toFixed(1)} mA`); }
      else if (isIo && t.key && /^CH\d\d\.\d{3}$/.test(t.key)) { const a = current('plc_input_point', 'NX-ID'); L.amps += a; L.items.push(`${t.key} input`); }
      else if (t.key && /^SOL\d/.test(t.key)) { const a = current('solenoid', ''); L.amps += a; L.items.push(`${t.key} solenoid`); }
      else if (t.key && /^PL\d/.test(t.key)) { const a = current('pilot_lamp', ''); L.amps += a; L.items.push(`${t.key} lamp`); }
      else if (t.key && /^BZ\d/.test(t.key)) { const a = current('buzzer', ''); L.amps += a; L.items.push(`${t.key} buzzer`); }
    }
    loadBy.set(sup, L);
  }
  // protector of a branch: a CP device on a net that carries the branch label; rating from its part text
  const cpRating = new Map();
  for (const p of index.pages.values()) for (const t of p.texts) {
    const m = /\((\d+(?:\.\d+)?)A\)\s*CP|CP\d{2}[A-Z]{2}-\dP(\d{3})/.exec(String(t.text).replace(/\s+/g, ' '));
    if (!m) continue;
    const amps = m[1] ? Number(m[1]) : Number(m[2]);
    // nearest CP tag on the same sheet
    let best = null, bd = Infinity;
    for (const q of p.texts) if (q.key && /^CP\d+$/.test(q.key)) { const d = Math.hypot(q.at[0] - t.at[0], q.at[1] - t.at[1]); if (d < bd) { bd = d; best = q.key; } }
    if (best && bd < 60 && !cpRating.has(best)) cpRating.set(best, { amps, page: p.id, shape: t.id });
  }
  const branchCp = new Map();
  for (const n of nets) {
    const sup = n.keys.find((k) => /^P\d{2}[A-Z]?$/.test(k));
    const cp = n.devices.find((d) => /^CP\d+$/.test(d)) || n.keys.find((k) => /^CP\d+$/.test(k));
    if (sup && cp && cpRating.has(cp) && !branchCp.has(sup)) branchCp.set(sup, cp);
  }
  for (const [sup, L] of loadBy) {
    const cp = branchCp.get(sup), r = cp && cpRating.get(cp);
    const where = [...L.pages].map((page) => ({ page, key: sup }));
    const amps = +L.amps.toFixed(3);
    if (!L.items.length) { add('power.budget', 'info', `${sup}: no loads recognised on its sheets${r ? ` (protector ${cp}, ${r.amps} A)` : ''}`, where); continue; }
    if (!r) { add('power.budget', 'info', `${sup}: estimated ${(amps * 1000).toFixed(0)} mA from ${L.items.length} loads; no circuit protector found for this branch`, where, { amps, items: L.items }); continue; }
    const pct = Math.round((amps / r.amps) * 100);
    const sev = pct > 100 ? 'error' : pct > 80 ? 'warning' : 'info';
    add('power.budget', sev, `${sup} via ${cp} (${r.amps} A): estimated ${amps.toFixed(2)} A = ${pct} %`, [{ page: r.page, shape: r.shape, key: cp }, ...where], { amps, rating: r.amps, percent: pct, items: L.items });
  }

  // ---------------------------------------------------------------- editor drawings
  const tags = new Map();
  for (const d of docs) for (const e of d.elements || []) {
    if (e.kind === 'symbol' && e.tag) { const k = e.tag.toUpperCase(); if (!tags.has(k)) tags.set(k, []); tags.get(k).push({ page: d.id, shape: e.id, key: k }); }
  }
  for (const [k, list] of tags) if (list.length > 1) add('drawing.duplicate-tag', 'error', `${k} is placed ${list.length} times`, list);
  for (const d of docs) {
    const p = index.pages.get(d.id); if (!p) continue;
    const ends = [];
    for (const e of d.elements || []) if (e.kind === 'wire') ends.push([e.pts[0], e.id], [e.pts.at(-1), e.id]);
    for (const [[x, y], id] of ends) {
      let touch = 0;
      for (const s of p.segs) {
        const dx = s[2] - s[0], dy = s[3] - s[1], L2 = dx * dx + dy * dy, u = L2 ? Math.max(0, Math.min(1, ((x - s[0]) * dx + (y - s[1]) * dy) / L2)) : 0;
        if (Math.hypot(x - (s[0] + u * dx), y - (s[1] + u * dy)) < 0.9) touch++;
        if (touch > 1) break;
      }
      if (touch <= 1) add('drawing.dangling', 'warning', `wire #${id} has a loose end`, [{ page: d.id, shape: id }]);
    }
  }

  // ---------------------------------------------------------------- cabinets vs drawings
  // one finding per cabinet, listing its devices that no schematic shows
  for (const c of cabinets) {
    const missing = (c.components || []).filter((x) => {
      const tag = String(x.tag).toUpperCase();
      return DEVICE.test(tag) && !(index.xref.get(tag) || []).some((o) => schematic.has(o.page));
    });
    if (missing.length) add('cabinet.not-in-drawing', 'warning', `cabinet ${c.id}: ${missing.length} device(s) on no schematic: ${missing.slice(0, 12).map((x) => x.tag).join(', ')}${missing.length > 12 ? ', …' : ''}`,
      missing.map((x) => ({ cabinet: c.id, key: String(x.tag).toUpperCase() })), { tags: missing.map((x) => x.tag) });
  }

  // ---------------------------------------------------------------- cabinet layout
  // layouts: [{ id, plate: { width, height }, ducts: [{ id, x, y, w, h, size }], components, routes }] (plate mm, y up)
  const OVERLAP = 1;                                  // mm both ways: touching parts are fine
  const inter = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > OVERLAP && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > OVERLAP;
  const od = Number(loads.wire_od_mm) || 2.6;         // KIV 0.75 mm² outer diameter
  if (!loads.wire_od_mm && layouts.some((l) => l.routes?.length)) assumptions.add(`wire outer diameter ${od} mm (KIV 0.75 mm²)`);
  for (const L of layouts) {
    const parts = (L.components || []).filter((c) => c.w > 0 && c.h > 0);
    const at = (c) => ({ cabinet: L.id, key: String(c.tag).toUpperCase() });
    const pairs = [];
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) if (inter(parts[i], parts[j])) pairs.push([parts[i], parts[j]]);
    for (const [a, b] of pairs) {
      // neighbours on one rail that overlap a little are usually outlines drawn wider than the part in the
      // layout drawing (label boxes, clips): said as info; a real clash is a warning
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), share = ox / Math.min(a.w, b.w);
      if (a.rail && a.rail === b.rail && share < 0.4) add('cabinet.overlap', 'info', `cabinet ${L.id}: ${a.tag} and ${b.tag} touch on rail ${a.rail} (${ox.toFixed(1)} mm) - check the real widths`, [at(a), at(b)], { mm: +ox.toFixed(1) });
      else add('cabinet.overlap', 'warning', `cabinet ${L.id}: ${a.tag} and ${b.tag} overlap on the plate`, [at(a), at(b)], { mm: +ox.toFixed(1) });
    }
    for (const c of parts) for (const d of L.ducts || []) if (inter(c, d)) add('cabinet.overlap', 'warning', `cabinet ${L.id}: ${c.tag} sits on duct ${d.id}`, [at(c)], { duct: d.id });
    if (L.plate) for (const c of parts) {
      const over = Math.max(-c.x, -c.y, c.x + c.w - L.plate.width, c.y + c.h - L.plate.height);
      if (over > OVERLAP) add('cabinet.outside', 'warning', `cabinet ${L.id}: ${c.tag} reaches ${Math.round(over)} mm past the plate edge`, [at(c)], { mm: Math.round(over) });
    }
    // duct fill: wires whose route runs inside a duct, against the duct's cross-section (WxxXHyy, minus walls)
    for (const d of L.ducts || []) {
      const m = /W(\d+)\s*X\s*H(\d+)/i.exec(d.size || '');
      if (!m) continue;
      const inside = (x, y) => x >= d.x - 0.5 && x <= d.x + d.w + 0.5 && y >= d.y - 0.5 && y <= d.y + d.h + 0.5;
      const n = (L.routes || []).filter((r) => r.ok && r.points?.some((p, k) => k && inside((p[0] + r.points[k - 1][0]) / 2, (p[1] + r.points[k - 1][1]) / 2))).length;
      if (!n) continue;
      const area = Math.max(1, (Number(m[1]) - 4) * (Number(m[2]) - 4)), pct = Math.round(n * Math.PI * (od / 2) ** 2 / area * 100);
      if (pct > 70) add('duct.fill', pct > 100 ? 'error' : 'warning', `cabinet ${L.id}: duct ${d.id} (${d.size}) estimated ${pct} % full with ${n} wires`, [{ cabinet: L.id, key: d.id }], { wires: n, percent: pct });
    }
  }

  // ---------------------------------------------------------------- translation
  let untranslated = 0; const firstMiss = [];
  for (const p of index.pages.values()) for (const t of p.texts) if (hasJapanese(t.text) && !translate(t.text, dict)) { untranslated++; if (firstMiss.length < 20) firstMiss.push({ page: p.id, shape: t.id }); }
  if (untranslated) add('drawing.untranslated', 'info', `${untranslated} Japanese text(s) without an English translation`, firstMiss);

  // ---------------------------------------------------------------- checklist
  const checklist = RULES.map((r) => {
    const f = findings.filter((x) => x.rule === r.id);
    const worst = f.some((x) => x.severity === 'error') ? 'error' : f.some((x) => x.severity === 'warning') ? 'warning' : f.length ? 'info' : 'pass';
    return { ...r, status: worst, count: f.length };
  });
  const count = (s) => findings.filter((f) => f.severity === s).length;
  return { summary: { errors: count('error'), warnings: count('warning'), info: count('info'), rules: RULES.length }, checklist, findings, assumptions: [...assumptions] };
}
