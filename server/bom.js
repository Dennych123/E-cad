// Bill of materials: one row per part number.
// Quantity = the devices that explicitly use the part: cabinet layouts, modules, part numbers set on placed
// symbols, module cables. A part known only from the drawings counts the labels written there. When the
// drawings show more labels than devices are listed, the row says so ("check") instead of guessing - a label
// can be the same device written twice (parts list + schematic), or a device missing from the layout.
// Tags next to the labels on the drawings are listed for orientation only; they never change a quantity.
import { buildCatalog, partsOfText } from './components.js';

// device tags: letters then a number (CR12, PB/PL7, SS2, TB12, CRLS2A); not line numbers, PLC addresses,
// supply labels, wire gauges or part numbers
const TAG_RE = /^(?!L\d{3,6}$)(?!CH\d)(?![PZN]\d{2,3}[A-Z]?\d?$)(?!AWG)[A-Z]{1,5}(\/[A-Z]{1,3})?\d{1,4}[A-Z]?\d?$/;
const LABEL_TO_TAG = 80;                      // pt: a part label names the tag at most this far away

export function buildBom({ modules = [], cabinets = [], index = null, docs = [] }) {
  const catalog = buildCatalog({ modules, cabinets, index });
  const rows = new Map(catalog.map((c) => [c.part, { ...c, tagSet: new Set(c.tags.map((t) => t.toUpperCase())), near: new Set(), labels: 0 }]));
  const row = (part) => {
    const k = part.toUpperCase();
    if (!rows.has(k)) rows.set(k, { part: k, name: null, maker: null, category: 'Other', footprint: null, tags: [], sources: [], tagSet: new Set(), near: new Set(), labels: 0 });
    return rows.get(k);
  };

  // where a tag is mounted: a cabinet's plate, or the box of the module that lists it
  const where = new Map();
  for (const m of modules) for (const p of m.parts || []) if (p.tag && m.box && !p.tag.includes('{')) where.set(p.tag.toUpperCase(), m.box);
  for (const c of cabinets) for (const x of c.components || []) if (x.tag) where.set(x.tag.toUpperCase(), c.id);

  // part labels on the drawings, and the device tag written next to each (orientation only)
  if (index) for (const pg of index.pages.values()) {
    const tags = pg.texts.filter((t) => t.keys?.some((k) => TAG_RE.test(k)));
    for (const t of pg.texts) for (const part of partsOfText(t.text)) {
      const r = row(part);
      r.labels++;
      let best = null, bd = LABEL_TO_TAG;
      for (const q of tags) { if (q === t) continue; const d = Math.hypot(q.at[0] - t.at[0], q.at[1] - t.at[1]); if (d < bd) { bd = d; best = q; } }
      if (best) r.near.add(best.keys.find((k) => TAG_RE.test(k)));
    }
  }
  // part numbers set on placed symbols (editor sheets); an untagged symbol is still one device
  let anon = 0;
  for (const d of docs) for (const el of d.elements || []) {
    if (el.kind !== 'symbol' || !el.part) continue;
    const r = row(el.part);
    r.tagSet.add(el.tag ? el.tag.toUpperCase() : `(untagged ${++anon})`);
    if (!r.sources.includes('symbol')) r.sources = [...r.sources, 'symbol'];
  }
  // cables listed by modules
  for (const m of modules) for (const c of m.cables || []) {
    if (!c.part || !c.tag) continue;
    const r = row(c.part);
    r.tagSet.add(c.tag.toUpperCase());
    r.category = r.category === 'Other' ? 'Cable / harness' : r.category;
    r.maker ||= c.maker || null;
    if (c.from && c.to) where.set(c.tag.toUpperCase(), `${c.from} → ${c.to}`);
  }

  const byNum = (a, b) => a.localeCompare(b, 'en', { numeric: true });
  const out = [...rows.values()].map((r) => {
    const tags = [...r.tagSet].sort(byNum);
    const qty = tags.length || r.labels || 1;
    const tbd = /TBD/i.test(r.part);
    const basis = tbd ? 'part number to be decided'
      : tags.length ? (r.labels > tags.length ? `devices listed; drawings show ${r.labels} labels - check` : 'devices listed')
        : r.labels ? 'labels on drawings' : 'listed only';
    const locs = new Map();
    const at = (w) => { if (!locs.has(w)) locs.set(w, { at: w, n: 0, tags: [] }); return locs.get(w); };
    for (const t of tags) { const l = at(where.get(t) || 'not placed'); l.n++; l.tags.push(t); }
    if (!tags.length) at(r.labels ? 'drawings' : 'unassigned').n = qty;
    return { part: r.part, maker: r.maker, category: tbd ? 'To be decided' : r.category, name: r.name, qty, tags, labels: r.labels,
      drawingTags: [...r.near].filter((t) => !r.tagSet.has(t)).sort(byNum), basis, check: /check/.test(basis),
      locations: [...locs.values()].sort((a, b) => b.n - a.n), sources: r.sources };
  });
  return out.sort((a, b) => a.category.localeCompare(b.category) || a.part.localeCompare(b.part));
}

/** BOM and wire-list tables, ready for xlsx() */
export function bomSheets(bom, { project = '' } = {}) {
  const byLoc = [];
  for (const r of bom) for (const l of r.locations) byLoc.push([l.at, r.part, r.maker || '', r.category, l.n, l.tags.join(', ')]);
  byLoc.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  return [
    { name: 'BOM', columns: [{ header: 'Item', width: 6 }, { header: 'Part number', width: 24 }, { header: 'Maker', width: 16 }, { header: 'Category', width: 18 },
      { header: 'Description', width: 34 }, { header: 'Qty', width: 6 }, { header: 'Tags', width: 40 }, { header: 'Location', width: 22 }, { header: 'Quantity basis', width: 36 },
      { header: 'Labels on drawings', width: 10 }, { header: 'Tags next to labels', width: 30 }],
    rows: bom.map((r, i) => [i + 1, r.part, r.maker || '', r.category, r.name || '', r.qty, r.tags.join(', '), r.locations.map((l) => `${l.at} ×${l.n}`).join(', '), r.basis, r.labels || '', r.drawingTags.join(', ')]) },
    { name: 'By location', columns: [{ header: 'Location', width: 18 }, { header: 'Part number', width: 24 }, { header: 'Maker', width: 16 }, { header: 'Category', width: 18 }, { header: 'Qty', width: 6 }, { header: 'Tags', width: 40 }], rows: byLoc },
    { name: 'About', columns: [{ header: 'Field', width: 18 }, { header: 'Value', width: 80 }], rows: [
      ['Project', project], ['Generated', new Date().toISOString().slice(0, 16).replace('T', ' ')],
      ['Quantity', 'Devices listed with the part: cabinet layouts, modules, placed symbols with a part number, module cables. With no listed device, the part number labels on the drawings are counted.'],
      ['"check"', 'The drawings show more labels than devices are listed: a device may be missing from the layout, or the part is written twice (parts list and schematic). Confirm before ordering.'],
      ['Tags next to labels', 'The device tag written within 80 pt of each label on the drawings, for orientation. It never changes the quantity.']] },
  ];
}

export function wireSheets(wires, { project = '', cabinet = '' } = {}) {
  const end = (e) => [e?.tag || '', e?.pin || ''];
  return [{ name: `Wires ${cabinet}`, columns: [{ header: 'No', width: 6 }, { header: 'Wire / mark', width: 14 }, { header: 'From', width: 14 }, { header: 'From pin', width: 9 },
    { header: 'To', width: 14 }, { header: 'To pin', width: 9 }, { header: 'Line', width: 9 }, { header: 'Length mm', width: 11 }, { header: 'Sheet', width: 48 }],
  rows: wires.map((w, i) => [i + 1, w.no || '', ...end(w.from), ...end(w.to), w.line || '', w.route?.ok ? Math.round(w.route.length) : '', w.page || '']) },
  { name: 'About', columns: [{ header: 'Field', width: 18 }, { header: 'Value', width: 80 }], rows: [
    ['Project', project], ['Cabinet', cabinet], ['Generated', new Date().toISOString().slice(0, 16).replace('T', ' ')],
    ['Length', 'Routed through the cabinet ducts (shortest path on the duct centre lines), without slack.']] }];
}
