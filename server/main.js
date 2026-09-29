// ecad-code web app server: static files + read-only JSON API over the YAML library/projects.
//   node server/main.js [--port 7670] [--lan]
// Binds to 127.0.0.1 unless --lan. Writes (later) are refused unless the request comes from this PC.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, NAME_RE } from './store.js';
import { buildSheetIndex } from './sheets.js';
import { cabinetWires } from './connections.js';
import { routeWires } from '../lib/route.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const port = Number(opt('--port', 7670));
const host = args.includes('--lan') ? '0.0.0.0' : '127.0.0.1';

const STATIC = { '/web/': 'web', '/lib/': 'lib', '/vendor/three/': 'node_modules/three', '/library/parts/3d/': 'library/parts/3d' };
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm' };

const store = createStore(root);

// sheet index per project, built on first use (imported Visio drawings)
const sheetIx = new Map();
function sheets(project) {
  if (!NAME_RE.test(project)) throw new Error('bad project');
  if (!sheetIx.has(project)) sheetIx.set(project, buildSheetIndex(path.join(root, 'projects', project, 'raw')));
  return sheetIx.get(project);
}
function xrefOf(project, key) {
  const ix = sheets(project);
  const occ = ix.xref.get(key) || [];
  const cab = store.cabinets(project).flatMap((c) => (store.cabinet(project, c).components || [])
    .filter((x) => x.tag.toUpperCase() === key).map((x) => ({ cabinet: c, tag: x.tag, part: x.part || null, rail: x.rail || null })));
  return { key, occurrences: occ, line: ix.lineIndex.get(key) || null, cabinet: cab };
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
    res.writeHead(200, { 'Content-Type': (MIME[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8',
      'Cache-Control': 'no-cache' });
    return fs.createReadStream(file).pipe(res), true;
  }
  return false;
}

const routes = [
  [/^\/api\/projects$/, () => store.projects()],
  [/^\/api\/parts$/, () => store.parts()],
  [/^\/api\/boxes$/, (m, q) => store.boxes(q.get('project') || null)],
  [/^\/api\/box\/([^/]+)$/, (m, q) => store.box(decodeURIComponent(m[1]), q.get('project') || null)],
  [/^\/api\/cabinets\/([^/]+)$/, (m) => store.cabinets(decodeURIComponent(m[1]))],
  [/^\/api\/cabinet\/([^/]+)\/([^/]+)$/, (m) => store.cabinet(decodeURIComponent(m[1]), decodeURIComponent(m[2]))],
  [/^\/api\/sheets\/([^/]+)$/, (m) => sheets(decodeURIComponent(m[1])).drawings],
  // wires of one cabinet, from the drawings' nets, routed through its ducts
  [/^\/api\/wires\/([^/]+)\/([^/]+)$/, (m) => {
    const project = decodeURIComponent(m[1]), cab = store.cabinet(project, decodeURIComponent(m[2]));
    const box = store.box(cab.box, project);
    const r = cabinetWires(sheets(project), cab);
    const routes = routeWires(box, cab.components || [], r.wires);
    return { units: r.units, unresolved: r.unresolved.length, wires: r.wires.map((w, i) => ({ ...w, route: routes[i] })) };
  }],
  [/^\/api\/sheet\/([^/]+)\/(.+)$/, (m) => {
    const p = sheets(decodeURIComponent(m[1])).pages.get(decodeURIComponent(m[2]));
    if (!p) throw new Error('no such sheet');
    return p;
  }],
  [/^\/api\/xref\/([^/]+)$/, (m, q) => xrefOf(decodeURIComponent(m[1]), (q.get('key') || '').toUpperCase().replace(/\s+/g, ''))],
  [/^\/api\/search\/([^/]+)$/, (m, q) => {
    const s = (q.get('q') || '').toUpperCase().replace(/\s+/g, '');
    if (s.length < 2) return [];
    const ix = sheets(decodeURIComponent(m[1]));
    return [...ix.xref.keys()].filter((k) => k.includes(s)).sort((a, b) => a.indexOf(s) - b.indexOf(s) || a.length - b.length)
      .slice(0, 40).map((k) => ({ key: k, n: ix.xref.get(k).length }));
  }],
];

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  try {
    if (url.pathname === '/') { res.writeHead(302, { Location: '/web/index.html' }); return res.end(); }
    if (req.method === 'GET') {
      for (const [re, fn] of routes) {
        const m = re.exec(url.pathname);
        if (m) return json(res, 200, fn(m, url.searchParams));
      }
      if (serveStatic(res, url.pathname)) return;
      // original Visio sheet SVGs: /raw/<project>/<file>/pNN.svg
      const rm = /^\/raw\/([^/]+)\/([^/]+)\/(p\d+\.svg)$/.exec(url.pathname);
      if (rm) {
        const [project, file, name] = rm.slice(1).map(decodeURIComponent);
        const base = path.join(root, 'projects', project, 'raw');
        const f = path.normalize(path.join(base, file, name));
        if (NAME_RE.test(project) && f.startsWith(base + path.sep) && fs.existsSync(f)) {
          res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'max-age=3600' });
          return void fs.createReadStream(f).pipe(res);
        }
      }
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 400, { error: e.message });
  }
});

server.listen(port, host, () => console.log(`ecad-code on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`));
