// ecad-code web app server: static files + JSON API over the YAML library and the projects.
//   node server/main.js [--port 7670] [--lan] [--lan-edit]
// Binds to 127.0.0.1 unless --lan. Writes (save sheet, new page, delete) are refused unless the
// request comes from this PC, or the server was started with --lan-edit.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { createStore, NAME_RE } from './store.js';
import { createDocStore, blankDoc } from './docs.js';
import { buildSheetIndex } from './sheets.js';
import { cabinetWires } from './connections.js';
import { buildCatalog } from './components.js';
import { routeWires } from '../lib/route.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const port = Number(opt('--port', 7670));
const host = args.includes('--lan') ? '0.0.0.0' : '127.0.0.1';
const lanEdit = args.includes('--lan-edit');

const STATIC = {
  '/web/': 'web', '/lib/': 'lib', '/vendor/three/': 'node_modules/three', '/library/parts/3d/': 'library/parts/3d',
  '/vendor/fonts/plex-sans/': 'node_modules/@fontsource/ibm-plex-sans/files', '/vendor/fonts/plex-mono/': 'node_modules/@fontsource/ibm-plex-mono/files',
};
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.woff': 'font/woff' };

const store = createStore(root);
const docs = createDocStore(root);
const P = (project) => { if (!NAME_RE.test(project)) throw new Error('bad project'); return path.join(root, 'projects', project); };
const readYaml = (f) => (fs.existsSync(f) ? yaml.load(fs.readFileSync(f, 'utf8')) || {} : {});

// project sheet index, rebuilt after every save (whole project: ~0.5 s)
const sheetIx = new Map();
function sheets(project) {
  P(project);
  if (!sheetIx.has(project)) sheetIx.set(project, buildSheetIndex(docs, project));
  return sheetIx.get(project);
}
function xrefOf(project, key) {
  const ix = sheets(project);
  const occ = ix.xref.get(key) || [];
  const cab = store.cabinets(project).flatMap((c) => (store.cabinet(project, c).components || [])
    .filter((x) => x.tag.toUpperCase() === key).map((x) => ({ cabinet: c, tag: x.tag, part: x.part || null, rail: x.rail || null })));
  return { key, occurrences: occ, line: ix.lineIndex.get(key) || null, cabinet: cab };
}
function symbols(project) {
  const read = (n) => { const f = path.join(P(project), 'symbols', n); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).symbols : []; };
  // extracted library + symbols users saved from their own selections
  return [...read('library.json'), ...read('custom.json')].filter((s) => !s.hidden).map(({ instances, ...s }) => s);
}
function i18n(project) {
  return { ...readYaml(path.join(root, 'library', 'i18n', 'ja-en.yaml')), ...readYaml(path.join(P(project), 'i18n', 'ja-en.yaml')) };
}
function catalog(project) {
  const mdir = path.join(P(project), 'modules');
  const modules = fs.existsSync(mdir) ? fs.readdirSync(mdir).filter((f) => f.endsWith('.yaml')).map((f) => ({ id: f.slice(0, -5), ...readYaml(path.join(mdir, f)) })) : [];
  const cabinets = store.cabinets(project).map((c) => ({ id: c, ...store.cabinet(project, c) }));
  const parts = store.parts();
  return buildCatalog({ modules, cabinets, index: sheets(project) }).map((c) => ({ ...c, model: parts[c.part]?.model || null }));
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function serveStatic(res, pathname) {
  for (const [prefix, dir] of Object.entries(STATIC)) {
    if (!pathname.startsWith(prefix)) continue;
    const base = path.join(root, dir);
    const file = path.normalize(path.join(base, decodeURIComponent(pathname.slice(prefix.length))));
    if (!file.startsWith(base + path.sep)) break;           // no escaping the mapped folder
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) break;
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': (MIME[ext] || 'application/octet-stream') + (/woff|glb|png|wasm/.test(ext) ? '' : '; charset=utf-8'),
      'Cache-Control': /woff/.test(ext) ? 'max-age=31536000, immutable' : 'no-cache' });
    return fs.createReadStream(file).pipe(res), true;
  }
  return false;
}
function writeAllowed(req) {
  const ra = req.socket.remoteAddress || '';
  const local = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
  const hostHdr = String(req.headers.host || '').replace(/:\d+$/, '');
  // a page from another site that resolves to 127.0.0.1 arrives with its own Host: refuse it
  return (local && ['127.0.0.1', 'localhost', '[::1]'].includes(hostHdr)) || lanEdit;
}
function body(req, limit = 32 << 20) {
  return new Promise((ok, fail) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > limit) { fail(new Error('request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { fail(e); } });
    req.on('error', fail);
  });
}
const dec = decodeURIComponent;

const GET = [
  [/^\/api\/projects$/, () => store.projects()],
  [/^\/api\/parts$/, () => store.parts()],
  [/^\/api\/boxes$/, (m, q) => store.boxes(q.get('project') || null)],
  [/^\/api\/box\/([^/]+)$/, (m, q) => store.box(dec(m[1]), q.get('project') || null)],
  [/^\/api\/cabinets\/([^/]+)$/, (m) => store.cabinets(dec(m[1]))],
  [/^\/api\/cabinet\/([^/]+)\/([^/]+)$/, (m) => store.cabinet(dec(m[1]), dec(m[2]))],
  [/^\/api\/sheets\/([^/]+)$/, (m) => sheets(dec(m[1])).drawings],
  [/^\/api\/doc\/([^/]+)\/(.+)$/, (m) => { const d = docs.get(dec(m[1]), dec(m[2])); d.saved = docs.saved(dec(m[1]), dec(m[2])); return d; }],
  [/^\/api\/symbols\/([^/]+)$/, (m) => symbols(dec(m[1]))],
  [/^\/api\/components\/([^/]+)$/, (m) => catalog(dec(m[1]))],
  [/^\/api\/i18n\/([^/]+)$/, (m) => i18n(dec(m[1]))],
  [/^\/api\/wires\/([^/]+)\/([^/]+)$/, (m) => {
    const project = dec(m[1]), cab = store.cabinet(project, dec(m[2]));
    const box = store.box(cab.box, project);
    const r = cabinetWires(sheets(project), cab);
    const routes = routeWires(box, cab.components || [], r.wires);
    return { units: r.units, unresolved: r.unresolved.length, wires: r.wires.map((w, i) => ({ ...w, route: routes[i] })) };
  }],
  [/^\/api\/xref\/([^/]+)$/, (m, q) => xrefOf(dec(m[1]), (q.get('key') || '').toUpperCase().replace(/\s+/g, ''))],
  [/^\/api\/search\/([^/]+)$/, (m, q) => {
    const s = (q.get('q') || '').toUpperCase().replace(/\s+/g, '');
    if (s.length < 2) return [];
    const ix = sheets(dec(m[1]));
    return [...ix.xref.keys()].filter((k) => k.includes(s)).sort((a, b) => a.indexOf(s) - b.indexOf(s) || a.length - b.length)
      .slice(0, 40).map((k) => ({ key: k, n: ix.xref.get(k).length }));
  }],
];

const WRITE = [
  // save a sheet document; baseRev guards against overwriting a newer save from another window
  ['PUT', /^\/api\/doc\/([^/]+)\/(.+)$/, async (m, b) => {
    const project = dec(m[1]), id = dec(m[2]);
    if (!b.doc || b.doc.id !== id || !Array.isArray(b.doc.elements)) throw new Error('bad document');
    const r = docs.put(project, id, b.doc, b.baseRev ?? null);
    sheetIx.delete(project);
    return r;
  }],
  // new blank page in a drawing folder (frame + title block copied from `like`)
  ['POST', /^\/api\/page\/([^/]+)$/, async (m, b) => {
    const project = dec(m[1]);
    const drawing = String(b.drawing || 'custom').replace(/[^A-Za-z0-9 _.()-]/g, '').slice(0, 80) || 'custom';
    const existing = sheets(project).drawings.find((d) => d.file === drawing)?.pages || [];
    let k = existing.length + 1, id;
    do id = `${drawing}/s${String(k++).padStart(2, '0')}`; while (docs.has(project, id));
    const like = b.like && docs.has(project, b.like) ? docs.get(project, b.like) : null;
    const doc = blankDoc(id, String(b.name || 'New sheet').slice(0, 80), like);
    docs.put(project, id, doc, null);
    sheetIx.delete(project);
    return { id };
  }],
  // save a selection as a new library symbol (projects/<p>/symbols/custom.json)
  ['POST', /^\/api\/symbols\/([^/]+)$/, async (m, b) => {
    const project = dec(m[1]);
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name || !Array.isArray(b.paths) || !b.paths.length || !Array.isArray(b.size)) throw new Error('bad symbol');
    const f = path.join(P(project), 'symbols', 'custom.json');
    const cur = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { symbols: [] };
    let id = 'u-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    for (let k = 2; cur.symbols.some((s) => s.id === id); k++) id = id.replace(/--\d+$/, '') + '--' + k;
    const sym = { id, name, category: String(b.category || 'custom').toLowerCase().slice(0, 30), master: null, count: 0,
      size: b.size.map(Number), paths: b.paths, pins: b.pins || [], texts: [], samples: [], custom: true, created: new Date().toISOString() };
    cur.symbols.push(sym);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(cur, null, 1));
    return sym;
  }],
  ['DELETE', /^\/api\/doc\/([^/]+)\/(.+)$/, async (m) => {
    const project = dec(m[1]), id = dec(m[2]);
    if (!docs.saved(project, id)) throw new Error('only saved sheets can be deleted; imported pages stay in raw/');
    docs.remove(project, id);
    sheetIx.delete(project);
    return { ok: true };
  }],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  try {
    if (url.pathname === '/') { res.writeHead(302, { Location: '/web/index.html' }); return res.end(); }
    if (req.method === 'GET') {
      for (const [re, fn] of GET) { const m = re.exec(url.pathname); if (m) return json(res, 200, fn(m, url.searchParams)); }
      if (serveStatic(res, url.pathname)) return;
      return json(res, 404, { error: 'not found' });
    }
    for (const [method, re, fn] of WRITE) {
      const m = re.exec(url.pathname);
      if (!m || req.method !== method) continue;
      if (!writeAllowed(req)) return json(res, 403, { error: 'editing is only allowed from this PC (start with --lan-edit to allow the LAN)' });
      return json(res, 200, await fn(m, method === 'DELETE' ? {} : await body(req)));
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, e.code === 409 ? 409 : 400, { error: e.message, rev: e.rev });
  }
});

server.listen(port, host, () => console.log(`ecad-code on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`));
