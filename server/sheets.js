// Project-wide sheet index: every page (imported or edited) indexed with lib/sheetindex.js, plus the
// cross-reference by normalised token and the L-line lookup. Edited pages are read from their saved
// documents; untouched imports straight from the raw dump (same result, faster).
import { indexPage } from '../lib/sheetindex.js';
import { docToRawPage } from '../lib/sheetdoc.js';

export { normKey } from '../lib/sheetindex.js';

export function buildSheetIndex(docs, project) {
  const drawings = docs.list(project);
  const pages = new Map(), xref = new Map(), lineIndex = new Map();
  for (const dr of drawings) for (const pg of dr.pages) {
    const raw = docs.rawPage(project, pg.id) || docToRawPage(docs.get(project, pg.id));
    const ix = indexPage(raw);
    ix.id = pg.id; ix.name = pg.name; ix.file = dr.file;
    pages.set(pg.id, ix);
    pg.texts = ix.texts.length;
    for (const t of ix.texts) {
      for (const k of t.keys) {
        if (!xref.has(k)) xref.set(k, []);
        xref.get(k).push({ page: pg.id, id: t.id, line: t.line, role: t.role, text: t.text, row: !!t.row });
      }
      if (t.row) lineIndex.set(t.key, { page: pg.id, y: t.at[1], x: t.at[0] });
    }
  }
  return { drawings, pages, xref, lineIndex };
}
