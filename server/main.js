// ecad-code web app server: static files + JSON API over the YAML library and the projects.
//   node server/main.js [--port 7670] [--lan] [--lan-edit] [--open]
// Binds to 127.0.0.1 unless --lan. --open opens the app in the default browser (ECAD.bat uses it). Writes (save sheet, new page, delete, save symbol) are refused
// unless the request comes from this PC, or the server was started with --lan-edit.
// The same project logic answers the MCP server (server/mcp.js) and the CLI (tools/check.js).
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankDoc } from './docs.js';
import { createProjectContext } from './project.js';

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

const ctx = createProjectContext(root);
const { store, docs } = ctx;
const projectDir = (project) => path.join(root, 'projects', project);

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
  [/^\/api\/projects$/, () => ctx.projects()],
  [/^\/api\/parts$/, () => store.parts()],
  [/^\/api\/boxes$/, (m, q) => store.boxes(q.get('project') || null)],
  [/^\/api\/box\/([^/]+)$/, (m, q) => store.box(dec(m[1]), q.get('project') || null)],
  [/^\/api\/cabinets\/([^/]+)$/, (m) => store.cabinets(dec(m[1]))],
  [/^\/api\/cabinet\/([^/]+)\/([^/]+)$/, (m) => store.cabinet(dec(m[1]), dec(m[2]))],
  [/^\/api\/sheets\/([^/]+)$/, (m) => ctx.sheets(dec(m[1]))],
  [/^\/api\/doc\/([^/]+)\/(.+)$/, (m) => { const d = docs.get(dec(m[1]), dec(m[2])); d.saved = docs.saved(dec(m[1]), dec(m[2])); return d; }],
  [/^\/api\/symbols\/([^/]+)$/, (m) => ctx.symbols(dec(m[1]))],
  [/^\/api\/components\/([^/]+)$/, (m) => ctx.catalog(dec(m[1]))],
  [/^\/api\/i18n\/([^/]+)$/, (m) => ctx.i18nRaw(dec(m[1]))],
  [/^\/api\/wires\/([^/]+)\/([^/]+)$/, (m) => ctx.wires(dec(m[1]), dec(m[2]))],
  [/^\/api\/xref\/([^/]+)$/, (m, q) => ctx.xref(dec(m[1]), q.get('key'))],
  [/^\/api\/search\/([^/]+)$/, (m, q) => ctx.search(dec(m[1]), q.get('q'))],
  [/^\/api\/check\/([^/]+)$/, (m) => ctx.check(dec(m[1]))],
  [/^\/api\/nets\/([^/]+)\/(.+)$/, (m, q) => ctx.nets(dec(m[1]), dec(m[2]), q.get('label'))],
  [/^\/api\/bom\/([^/]+)$/, (m) => ctx.bom(dec(m[1]))],
  [/^\/api\/terminals\/([^/]+)\/([^/]+)$/, (m) => ctx.terminals(dec(m[1]), dec(m[2]))],
  [/^\/api\/labels\/([^/]+)\/([^/]+)$/, (m) => ctx.labels(dec(m[1]), dec(m[2]))],
];

// downloads: /api/export/<project>/bom.xlsx | wires/<cab>.xlsx | terminals/<cab>.xlsx | labels/<cab>.csv
const FILES = [
  [/^\/api\/export\/([^/]+)\/bom\.xlsx$/, (m) => ({ name: `${dec(m[1])} BOM.xlsx`, data: ctx.bomXlsx(dec(m[1])) })],
  [/^\/api\/export\/([^/]+)\/wires\/([^/]+)\.xlsx$/, (m) => ({ name: `${dec(m[1])} wires ${dec(m[2])}.xlsx`, data: ctx.wiresXlsx(dec(m[1]), dec(m[2])) })],
  [/^\/api\/export\/([^/]+)\/terminals\/([^/]+)\.xlsx$/, (m) => ({ name: `${dec(m[1])} terminals ${dec(m[2])}.xlsx`, data: ctx.terminalsXlsx(dec(m[1]), dec(m[2])) })],
  [/^\/api\/export\/([^/]+)\/labels\/([^/]+)\.csv$/, (m) => ({ name: `${dec(m[1])} labels ${dec(m[2])}.csv`, data: ctx.labelsCsv(dec(m[1]), dec(m[2])), type: 'text/csv; charset=utf-8' })],
];
function sendFile(res, { name, data, type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }) {
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="${name.replace(/[^\w .()-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}` });
  res.end(Buffer.from(data));
}

const WRITE = [
  // save a sheet document; baseRev guards against overwriting a newer save from another window
  ['PUT', /^\/api\/doc\/([^/]+)\/(.+)$/, async (m, b) => {
    const project = dec(m[1]), id = dec(m[2]);
    if (!b.doc || b.doc.id !== id || !Array.isArray(b.doc.elements)) throw new Error('bad document');
    const r = docs.put(project, id, b.doc, b.baseRev ?? null);
    ctx.invalidate(project);
    return r;
  }],
  // new blank page in a drawing folder (frame + title block copied from `like`), or a copy of `copyOf`
  ['POST', /^\/api\/page\/([^/]+)$/, async (m, b) => {
    const project = dec(m[1]);
    const drawing = String(b.drawing || 'custom').replace(/[^A-Za-z0-9 _.()-]/g, '').slice(0, 80) || 'custom';
    const existing = ctx.index(project).drawings.find((d) => d.file === drawing)?.pages || [];
    let k = existing.length + 1, id;
    do id = `${drawing}/s${String(k++).padStart(2, '0')}`; while (docs.has(project, id));
    let doc;
    if (b.copyOf && docs.has(project, b.copyOf)) {
      doc = { ...docs.get(project, b.copyOf), id, name: String(b.name || 'Copy').slice(0, 80), source: null, rev: 0 };
      delete doc.saved;
    } else {
      const like = b.like && docs.has(project, b.like) ? docs.get(project, b.like) : null;
      doc = blankDoc(id, String(b.name || 'New sheet').slice(0, 80), like);
    }
    docs.put(project, id, doc, null);
    ctx.invalidate(project);
    return { id };
  }],
  // save a selection as a new library symbol (projects/<p>/symbols/custom.json)
  ['POST', /^\/api\/symbols\/([^/]+)$/, async (m, b) => {
    const project = dec(m[1]);
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name || !Array.isArray(b.paths) || !b.paths.length || !Array.isArray(b.size)) throw new Error('bad symbol');
    const f = path.join(projectDir(project), 'symbols', 'custom.json');
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
    ctx.invalidate(project);
    return { ok: true };
  }],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  try {
    if (url.pathname === '/') { res.writeHead(302, { Location: '/web/index.html' }); return res.end(); }
    if (req.method === 'GET') {
      for (const [re, fn] of GET) { const m = re.exec(url.pathname); if (m) return json(res, 200, fn(m, url.searchParams)); }
      for (const [re, fn] of FILES) { const m = re.exec(url.pathname); if (m) return sendFile(res, fn(m)); }
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

const appUrl = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`;

function openBrowser(url) {
  const [cmd, argv, o] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url], { windowsVerbatimArguments: true }]
    : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {}];
  spawn(cmd, argv, { ...o, detached: true, stdio: 'ignore' }).on('error', () => console.log(`open ${url} in a browser`)).unref();
}

// --open (used by ECAD.bat): open the app once listening; when ecad already runs on the port, just open it
server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  http.get(`http://127.0.0.1:${port}/api/projects`, { timeout: 2000 }, (r) => {
    r.resume();
    if (r.statusCode === 200 && args.includes('--open')) { console.log(`ecad-code already running on ${appUrl}`); openBrowser(appUrl); process.exit(0); }
    console.error(r.statusCode === 200 ? `ecad-code already running on ${appUrl}` : `port ${port} is used by another program; start with --port <number>`);
    process.exit(1);
  }).on('error', () => { console.error(`port ${port} is used by another program; start with --port <number>`); process.exit(1); });
});

server.listen(port, host, () => {
  console.log(`ecad-code on ${appUrl}`);
  if (args.includes('--open')) openBrowser(appUrl);
});
