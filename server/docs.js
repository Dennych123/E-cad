// Sheet documents on disk. An imported page becomes an editable document the first time it is asked
// for (built from the Visio SVG export + the raw shape dump, not saved until edited); saved documents
// live in projects/<p>/sheets/<drawing>/<page>.json and win over the import from then on.
import fs from 'node:fs';
import path from 'node:path';
import { PT } from '../lib/sheetdoc.js';

const PAGE_RE = /^[^/\\]+\/[A-Za-z0-9_.-]+$/;           // "<drawing folder>/<page>"

/** the end index (exclusive) of the <g ...>...</g> element starting at `i` */
function matchG(s, i) {
  const re = /<(\/?)g\b[^>]*?(\/?)>/g;
  re.lastIndex = i;
  let depth = 0, m;
  while ((m = re.exec(s))) {
    if (m[1]) { if (--depth === 0) return re.lastIndex; }
    else if (!m[2]) depth++;
    else if (depth === 0) return re.lastIndex;           // self-closing at top
  }
  throw new Error('unbalanced <g> in SVG');
}

/** direct children of the group whose open tag ends at `open` and which closes at `end` */
function children(s, open, end) {
  const out = [];
  let i = open;
  while (i < end) {
    const lt = s.indexOf('<', i);
    if (lt < 0 || lt >= end) break;
    if (s.startsWith('</g', lt)) break;
    if (s.startsWith('<g', lt)) { const e = matchG(s, lt); out.push(s.slice(lt, e)); i = e; continue; }
    const tag = /^<([A-Za-z:]+)/.exec(s.slice(lt, lt + 40))?.[1];
    if (!tag) { i = lt + 1; continue; }
    const close = s.indexOf(`</${tag}>`, lt);
    const selfEnd = s.indexOf('/>', lt), gt = s.indexOf('>', lt);
    const e = selfEnd >= 0 && selfEnd < gt + 1 && selfEnd === gt - 1 ? gt + 1 : close >= 0 ? close + tag.length + 3 : gt + 1;
    if (!['title', 'desc'].includes(tag) && !tag.startsWith('v:')) out.push(s.slice(lt, e));   // v:* is Visio metadata
    i = e;
  }
  return out;
}

export function splitVisioSvg(svg) {
  const vb = /viewBox="([^"]+)"/.exec(svg)?.[1]?.split(/\s+/).map(Number) || [0, 0, 0, 0];
  const rootClass = /<svg\b[^>]*\bclass="([^"]*)"/.exec(svg)?.[1] || '';
  const css = /<style[^>]*>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/style>/.exec(svg)?.[1]?.trim() || '';
  const defs = (svg.match(/<defs\b[\s\S]*?<\/defs>/g) || []).join('\n');
  const grab = (ctx) => {
    const m = new RegExp(`<g\\b[^>]*v:groupContext="${ctx}"[^>]*>`).exec(svg);
    if (!m) return null;
    const end = matchG(svg, m.index);
    return { start: m.index, open: m.index + m[0].length, end, markup: svg.slice(m.index, end) };
  };
  const bg = grab('backgroundPage'), fg = grab('foregroundPage');
  const parts = fg ? children(svg, fg.open, fg.end - 4) : [];
  return { width: vb[2], height: vb[3], rootClass, css, defs, background: bg?.markup || '', parts };
}

/** imported page -> document */
export function visioToDoc(raw, svgText, id) {
  const sp = splitVisioSvg(svgText);
  const byParent = new Map();
  for (const s of raw.shapes) { if (!byParent.has(s.parent)) byParent.set(s.parent, []); byParent.get(s.parent).push(s); }
  const subtree = (s) => { const out = [], st = [s]; while (st.length) { const c = st.pop(); out.push(c); st.push(...(byParent.get(c.id) || [])); } return out; };
  const top = new Map(raw.shapes.filter((s) => s.depth === 0).map((s) => [s.id, s]));
  const elements = [];
  let anon = 900000;
  for (const markup of sp.parts) {
    const m = /^<g\b[^>]*\bid="(?:shape|group)(\d+)-/.exec(markup);
    const shape = m && top.get(Number(m[1]));
    if (shape) elements.push({ id: shape.id, kind: 'visio', master: shape.master || null, svg: markup, dx: 0, dy: 0, shapes: subtree(shape) });
    else elements.push({ id: anon++, kind: 'visio', master: null, svg: markup, dx: 0, dy: 0, shapes: [] });
  }
  return {
    version: 1, id, name: raw.name, source: { raw: id },
    width: sp.width || +(raw.width_mm * PT).toFixed(2), height: sp.height || +(raw.height_mm * PT).toFixed(2),
    widthMm: raw.width_mm, heightMm: raw.height_mm,
    rootClass: sp.rootClass, css: sp.css, defs: sp.defs, background: sp.background, elements,
  };
}

/** blank page, same frame size as an existing document (or A3 landscape) */
export function blankDoc(id, name, like = null) {
  const wMm = like?.widthMm || 420, hMm = like?.heightMm || 297;
  return { version: 1, id, name, source: null, width: +(wMm * PT).toFixed(2), height: +(hMm * PT).toFixed(2), widthMm: wMm, heightMm: hMm,
    rootClass: like?.rootClass || '', css: like?.css || '', defs: like?.defs || '', background: like?.background || '', elements: [] };
}

export function createDocStore(root) {
  const P = (project) => path.join(root, 'projects', project);
  const check = (id) => { if (!PAGE_RE.test(id)) throw new Error('bad sheet id: ' + id); return id; };
  const docFile = (project, id) => path.join(P(project), 'sheets', ...check(id).split('/')) + '.json';
  const rawFile = (project, id) => path.join(P(project), 'raw', ...check(id).split('/')) + '.json';
  const svgFile = (project, id) => path.join(P(project), 'raw', ...check(id).split('/')) + '.svg';
  // earlier saved versions: projects/<p>/history/<drawing>/<page>/<rev>.json, newest HISTORY_KEEP kept
  const histDir = (project, id) => path.join(P(project), 'history', ...check(id).split('/'));
  const HISTORY_KEEP = 30;
  const importDoc = (project, id) => {
    const raw = JSON.parse(fs.readFileSync(rawFile(project, id), 'utf8'));
    const sf = svgFile(project, id);
    return visioToDoc(raw, fs.existsSync(sf) ? fs.readFileSync(sf, 'utf8') : '<svg viewBox="0 0 0 0"></svg>', id);
  };

  const store = {
    has: (project, id) => fs.existsSync(docFile(project, id)) || fs.existsSync(rawFile(project, id)),
    saved: (project, id) => fs.existsSync(docFile(project, id)),
    get(project, id) {
      const f = docFile(project, id);
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!fs.existsSync(rawFile(project, id))) throw new Error('no such sheet: ' + id);
      return importDoc(project, id);
    },
    /** raw page for indexing: straight from the import when the sheet was never edited (fast) */
    rawPage(project, id) {
      const f = docFile(project, id);
      if (!fs.existsSync(f)) return JSON.parse(fs.readFileSync(rawFile(project, id), 'utf8'));
      return null;
    },
    put(project, id, doc, baseVersion) {
      const f = docFile(project, id);
      if (fs.existsSync(f) && baseVersion != null) {
        const cur = JSON.parse(fs.readFileSync(f, 'utf8'));
        if ((cur.rev || 0) !== baseVersion) throw Object.assign(new Error('the sheet changed since you opened it'), { code: 409, rev: cur.rev || 0 });
      }
      // keep the version being replaced
      if (fs.existsSync(f)) {
        const prev = fs.readFileSync(f, 'utf8'), prevRev = JSON.parse(prev).rev || 0, hd = histDir(project, id);
        fs.mkdirSync(hd, { recursive: true });
        fs.writeFileSync(path.join(hd, `${prevRev}.json`), prev);
        const old = fs.readdirSync(hd).filter((x) => /^\d+\.json$/.test(x)).sort((a, b) => parseInt(b) - parseInt(a)).slice(HISTORY_KEEP);
        for (const x of old) fs.rmSync(path.join(hd, x), { force: true });
      }
      doc.rev = (doc.rev || 0) + 1;
      doc.savedAt = new Date().toISOString();
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(doc));
      fs.renameSync(tmp, f);                                        // atomic replace
      return { rev: doc.rev, savedAt: doc.savedAt };
    },
    /** earlier versions of a sheet, newest first; `import` = the Visio original when the sheet came from one */
    history(project, id) {
      const hd = histDir(project, id), out = [];
      if (fs.existsSync(hd)) for (const x of fs.readdirSync(hd).filter((n) => /^\d+\.json$/.test(n))) {
        try { const j = JSON.parse(fs.readFileSync(path.join(hd, x), 'utf8')); out.push({ rev: j.rev || 0, savedAt: j.savedAt || null, name: j.name, shapes: (j.elements || []).length }); } catch { /* unreadable: skip */ }
      }
      out.sort((a, b) => b.rev - a.rev);
      if (fs.existsSync(rawFile(project, id))) out.push({ rev: 'import', savedAt: null, name: null, shapes: null });
      return out;
    },
    revision(project, id, rev) {
      if (rev === 'import') return importDoc(project, id);
      if (!/^\d+$/.test(String(rev))) throw new Error('bad revision: ' + rev);
      const f = path.join(histDir(project, id), `${rev}.json`);
      if (!fs.existsSync(f)) throw new Error(`revision ${rev} of ${id} is not kept`);
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    },
    remove(project, id) { const f = docFile(project, id); if (fs.existsSync(f)) fs.renameSync(f, f + '.deleted'); },
    /** pages: every imported non-background page plus every saved document, per drawing folder */
    list(project) {
      const out = new Map();
      const add = (drawing, page, name, source) => {
        if (!out.has(drawing)) out.set(drawing, new Map());
        out.get(drawing).set(page, { id: `${drawing}/${page}`, name, source });
      };
      const rawDir = path.join(P(project), 'raw');
      if (fs.existsSync(rawDir)) for (const d of fs.readdirSync(rawDir)) {
        const dir = path.join(rawDir, d);
        if (!fs.statSync(dir).isDirectory()) continue;
        for (const f of fs.readdirSync(dir).filter((x) => /^p\d+\.json$/.test(x))) {
          const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          if (!j.background) add(d, f.slice(0, -5), j.name, 'import');
        }
      }
      const sdir = path.join(P(project), 'sheets');
      if (fs.existsSync(sdir)) for (const d of fs.readdirSync(sdir)) {
        const dir = path.join(sdir, d);
        if (!fs.statSync(dir).isDirectory()) continue;
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
          const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          add(d, f.slice(0, -5), j.name, out.get(d)?.get(f.slice(0, -5)) ? 'edited' : 'new');
        }
      }
      return [...out].sort(([a], [b]) => a.localeCompare(b)).map(([drawing, pages]) => ({
        file: drawing, title: drawing.replace(/^\d+_/, '').replace(/_OK$/, '').replace(/_/g, ' '),
        pages: [...pages.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })),
      }));
    },
  };
  return store;
}
