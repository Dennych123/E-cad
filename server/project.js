// Everything the app knows about a project, behind one object: used by the HTTP server, the MCP server
// (the AI port) and the CLI, so all three answer from the same code.
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { createStore, NAME_RE } from './store.js';
import { createDocStore } from './docs.js';
import { buildSheetIndex } from './sheets.js';
import { cabinetWires, sheetNets } from './connections.js';
import { buildCatalog } from './components.js';
import { runChecks, RULES } from './checks.js';
import { routeWires } from '../lib/route.js';
import { buildDict, translate } from '../lib/i18n.js';
import { buildNets, labelsOfNet } from '../lib/nets.js';

export { RULES };

export function createProjectContext(root) {
  const store = createStore(root);
  const docs = createDocStore(root);
  const P = (project) => { if (!NAME_RE.test(project || '')) throw new Error('bad project name: ' + project); return path.join(root, 'projects', project); };
  const readYaml = (f) => (fs.existsSync(f) ? yaml.load(fs.readFileSync(f, 'utf8')) || {} : {});
  const cache = new Map();                      // project -> {index, check}
  const slot = (project) => { P(project); if (!cache.has(project)) cache.set(project, {}); return cache.get(project); };

  const ctx = {
    root, store, docs,
    projects: () => store.projects(),
    invalidate(project) { cache.delete(project); },
    index(project) { const s = slot(project); return (s.index ||= buildSheetIndex(docs, project)); },
    i18nRaw(project) { return { ...readYaml(path.join(root, 'library', 'i18n', 'ja-en.yaml')), ...readYaml(path.join(P(project), 'i18n', 'ja-en.yaml')) }; },
    dict(project) { const s = slot(project); return (s.dict ||= buildDict(ctx.i18nRaw(project))); },
    sheets(project) {
      const dict = ctx.dict(project);
      return ctx.index(project).drawings.map((d) => ({ ...d, pages: d.pages.map((p) => ({ ...p, nameEn: translate(p.name, dict) || p.name })) }));
    },
    xref(project, key) {
      key = String(key || '').toUpperCase().replace(/\s+/g, '');
      const ix = ctx.index(project);
      const cab = store.cabinets(project).flatMap((c) => (store.cabinet(project, c).components || [])
        .filter((x) => x.tag.toUpperCase() === key).map((x) => ({ cabinet: c, tag: x.tag, part: x.part || null, rail: x.rail || null })));
      return { key, occurrences: ix.xref.get(key) || [], line: ix.lineIndex.get(key) || null, cabinet: cab };
    },
    search(project, q) {
      const s = String(q || '').toUpperCase().replace(/\s+/g, '');
      if (s.length < 2) return [];
      const ix = ctx.index(project);
      return [...ix.xref.keys()].filter((k) => k.includes(s)).sort((a, b) => a.indexOf(s) - b.indexOf(s) || a.length - b.length)
        .slice(0, 40).map((k) => ({ key: k, n: ix.xref.get(k).length }));
    },
    /** nets on one sheet that carry a label (or every labelled net when no label is given) */
    nets(project, sheet, label = null) {
      const ix = ctx.index(project), p = ix.pages.get(sheet);
      if (!p) throw new Error('no such sheet: ' + sheet);
      const n = buildNets(p.segs), ids = [...new Set(n)];
      const out = [];
      for (const id of ids) {
        const labels = [...new Set(labelsOfNet(p.texts, p.segs, n, id).flatMap((t) => t.keys))];
        const devices = [...new Set(p.segs.filter((_, i) => n[i] === id).map((s) => p.owner[s[4]]).filter(Boolean))];
        if (!labels.length && !devices.length) continue;
        if (label && !labels.includes(String(label).toUpperCase())) continue;
        out.push({ segments: n.filter((x) => x === id).length, labels, devices });
      }
      return out;
    },
    symbols(project) {
      const read = (n) => { const f = path.join(P(project), 'symbols', n); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).symbols : []; };
      return [...read('library.json'), ...read('custom.json')].filter((s) => !s.hidden).map(({ instances, ...s }) => s);
    },
    catalog(project) {
      const mdir = path.join(P(project), 'modules');
      const modules = fs.existsSync(mdir) ? fs.readdirSync(mdir).filter((f) => f.endsWith('.yaml')).map((f) => ({ id: f.slice(0, -5), ...readYaml(path.join(mdir, f)) })) : [];
      const cabinets = store.cabinets(project).map((c) => ({ id: c, ...store.cabinet(project, c) }));
      const parts = store.parts();
      return buildCatalog({ modules, cabinets, index: ctx.index(project) }).map((c) => ({ ...c, model: parts[c.part]?.model || null }));
    },
    wires(project, cabinet) {
      const cab = store.cabinet(project, cabinet);
      const box = store.box(cab.box, project);
      const r = cabinetWires(ctx.index(project), cab);
      const routes = routeWires(box, cab.components || [], r.wires);
      return { units: r.units, unresolved: r.unresolved.length, wires: r.wires.map((w, i) => ({ ...w, route: routes[i] })) };
    },
    loads(project) {
      const lib = readYaml(path.join(root, 'library', 'electrical', 'loads.yaml'));
      const own = readYaml(path.join(P(project), 'electrical.yaml'));
      return { ...lib, ...own };                  // a project table replaces the library table of the same name
    },
    check(project) {
      const s = slot(project);
      if (!s.check) {
        const index = ctx.index(project);
        const savedDocs = index.drawings.flatMap((d) => d.pages).filter((p) => docs.saved(project, p.id)).map((p) => docs.get(project, p.id));
        const cabinets = store.cabinets(project).map((c) => ({ id: c, ...store.cabinet(project, c) }));
        s.check = { ...runChecks({ index, cabinets, docs: savedDocs, dict: ctx.dict(project), loads: ctx.loads(project) }), at: new Date().toISOString() };
      }
      return s.check;
    },
    sheetNets: (project) => sheetNets(ctx.index(project)),
  };
  return ctx;
}
