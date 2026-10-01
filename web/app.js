// App shell: project, workspace modes, sheet tree, symbol/component library, inspector, commands.
import { createEditor } from '/web/editor.js';
import { createPanel3D } from '/web/panel3d.js';
import { createFindBar } from '/web/findreplace.js';
import { printTerminalPlan, printLabels } from '/web/reports.js';
import { icon } from '/web/icons.js';
import { $, esc, toast, menu, dialog, confirmDialog, prompt, command, runCommand, openPalette, shortcutsDialog, keyLabel, slideIndicator } from '/web/ui.js';
import { buildDict, translate, hasJapanese } from '/lib/i18n.js';
import { PT, elementBox, STYLE_KEYS } from '/lib/sheetdoc.js';

const api = async (p, opt) => { const r = await fetch(p, opt); const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error || r.status), { status: r.status }); return j; };
const store = { get: (k, d) => { try { return localStorage.getItem('ecad.' + k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem('ecad.' + k, v); } catch { /* private */ } } };
const qs = new URLSearchParams(location.search);

const state = {
  project: null, projects: [], mode: '2d', drawings: [], symbols: [], components: [], dict: new Map(),
  english: (qs.get('lang') || store.get('lang', 'en')) !== 'ja', sheet: null, leftTab: store.get('leftTab', 'sheets'),
  xref: null, net: null, filter: '', openComp: null,
  check: null, checkOpen: null, checkActive: null, checkAll: new Set(), checking: false,
};
const project = () => state.project;
const tr = (s) => (state.english ? translate(s, state.dict) ?? s : s);

// ======================================================================== static chrome
$('#brandMark').innerHTML = icon('logo');
$('#tab2d').innerHTML = `${icon('sheet')}<span>Drawings</span>`;
$('#tab3d').innerHTML = `${icon('box3d')}<span>Panel 3D</span>`;
$('#paletteBtn').innerHTML = icon('command');
const applyTheme = (t) => { if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t; $('#themeBtn').innerHTML = icon(t === 'light' ? 'sun' : t === 'dark' ? 'moon' : 'panel'); store.set('theme', t); };
applyTheme(store.get('theme', 'system'));
$('#themeBtn').onclick = (e) => menu([
  { label: 'System', icon: 'panel', run: () => applyTheme('system') }, { label: 'Dark', icon: 'moon', run: () => applyTheme('dark') }, { label: 'Light', icon: 'sun', run: () => applyTheme('light') },
], { anchor: e.currentTarget });
const renderLang = () => { $('#langBtn').innerHTML = `<span class="mono" style="font-size:11px;font-weight:500">${state.english ? 'EN' : 'JA'}</span>`; };
renderLang();

// ======================================================================== editor + 3D
const stage2d = $('#stage2d'), stage3d = $('#stage3d');
const editor = createEditor(stage2d, {
  api, project, toast,
  onChange: (c) => { state.change = c; $('#dirtyDot').hidden = !c.dirty; renderSave(c); renderToolbar(); findBar?.refresh(); },
  onSelect: (s) => { state.selection = s; renderInspector(); renderStatusSel(s); },
  onCursor: (p) => { $('#stCursor').textContent = `x ${p.x.toFixed(1).padStart(6)}  y ${p.y.toFixed(1).padStart(6)} mm`; },
  onNet: (n) => { state.net = n; renderInspector(); },
  onTool: () => { renderToolbar(); renderStatusTool(); renderLibrary(); },
  onNavigate: ({ line }) => gotoLine(line),
  onView: () => renderZoom(),                       // any zoom/pan: wheel, fit, jumps from the xref or the checks
});
const findBar = createFindBar(stage2d, { editor, toast });
const panel3d = createPanel3D({ stage: stage3d, inspector: $('#inspector'), api, project, toast, onShowInDrawings: async ({ key, page, line }) => {
  await setMode('2d');
  if (key) return showXref(key.toUpperCase().replace(/\s+/g, ''), { jump: true });
  if (line) return gotoLine(line, page);
  if (page) return openSheet(page);
} });

// ======================================================================== toolbar (per mode)
const T = (id, ic, tip, keys, on = false, disabled = false) => `<button class="ibtn ${on ? 'on' : ''}" data-cmd="${id}" data-tip="${esc(tip)}" ${keys ? `data-keys="${esc(keys)}"` : ''} ${disabled ? 'disabled' : ''} aria-label="${esc(tip)}">${icon(ic)}</button>`;
function renderToolbar() {
  const tb = $('#toolbar');
  if (state.mode === '3d') {
    const s = panel3d.state;
    tb.innerHTML = `<div class="group"><select id="boxSel" aria-label="Box template" style="width:260px">${panel3d.boxes.map((b) => `<option value="${esc(b.id)}" ${b.id === panel3d.boxId ? 'selected' : ''}>${esc(b.id)} — ${esc(b.name)}</option>`).join('')}</select>
      <select id="cabSel" aria-label="Cabinet" style="width:140px"><option value="">No cabinet</option>${panel3d.cabinets.map((c) => `<option ${c === panel3d.cabinetId ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div><span class="sep"></span>
      ${T('door', 'door', s.door ? 'Close door' : 'Open door', 'O', s.door)}${T('xray', 'xray', 'X-ray', 'X', s.xray)}${T('labels', 'tag', 'Labels', 'L', s.labelsOn)}${T('wires3d', 'cable', 'Wires', 'W', s.wiresOn)}<span class="sep"></span>${T('fit3d', 'fit', 'Fit view', 'Home')}<span class="spacer" style="flex:1"></span>${T('reports', 'report', 'Reports: BOM, wire list, terminals, labels')}`;
    $('#boxSel').onchange = () => { const b = $('#boxSel').value; panel3d.load(b, panel3d.cabinets.includes(b) ? b : $('#cabSel').value); setTimeout(renderToolbar, 400); };
    $('#cabSel').onchange = () => panel3d.load($('#boxSel').value, $('#cabSel').value, false);
    return;
  }
  const t = editor.tool, sel = editor.selection.length, has = !!editor.doc;
  tb.innerHTML = `<div class="group">${T('tool.select', 'select', 'Select', 'V', t === 'select')}${T('tool.pan', 'pan', 'Pan', 'H', t === 'pan')}</div><span class="sep"></span>
    <div class="group">${T('tool.wire', 'wire', 'Wire', 'W', t === 'wire')}${T('tool.line', 'line', 'Line', 'L', t === 'line')}${T('tool.rect', 'rect', 'Rectangle', 'B', t === 'rect')}${T('tool.ellipse', 'ellipse', 'Ellipse', 'E', t === 'ellipse')}${T('tool.text', 'text', 'Text', 'T', t === 'text')}</div><span class="sep"></span>
    <div class="group">${T('undo', 'undo', state.change?.undoLabel ? `Undo ${state.change.undoLabel}` : 'Undo', keyLabel('mod+z'), false, !state.change?.canUndo)}${T('redo', 'redo', 'Redo', keyLabel('mod+y'), false, !state.change?.canRedo)}</div><span class="sep"></span>
    <div class="group">${T('rotate', 'rotate', 'Rotate 90°', keyLabel('mod+r'), false, !sel)}${T('duplicate', 'copy', 'Duplicate', keyLabel('mod+d'), false, !sel)}${T('delete', 'trash', 'Delete', 'Del', false, !sel)}${T('front', 'front', 'Bring to front', keyLabel('mod+]'), false, !sel)}${T('back', 'back', 'Send to back', keyLabel('mod+['), false, !sel)}</div>
    ${sel > 1 ? `<span class="sep"></span><div class="group">${T('align.left', 'alignL', 'Align left')}${T('align.center', 'alignC', 'Align centre')}${T('align.right', 'alignR', 'Align right')}${T('align.top', 'alignT', 'Align top')}${T('align.middle', 'alignM', 'Align middle')}${T('align.bottom', 'alignB', 'Align bottom')}</div>` : ''}
    <span class="sep"></span><div class="group">${T('snap', 'magnet', 'Snap', 'S', editor.snap)}${T('grid', 'grid', 'Grid', 'G', editor.grid)}${T('bg', 'layers', 'Title block', '', editor.background)}</div>
    <span class="spacer" style="flex:1"></span>
    <div class="group">${T('zoomOut', 'zoomOut', 'Zoom out', keyLabel('mod+-'))}<span class="zoom-read" id="zoomRead" data-tip="Zoom — click for presets">${editor.zoomPct()}%</span>${T('zoomIn', 'zoomIn', 'Zoom in', keyLabel('mod+='))}${T('fit', 'fit', 'Fit sheet', keyLabel('mod+0'))}</div><span class="sep"></span>
    <div class="group">${T('reports', 'report', 'Reports: BOM, wire list, terminals, labels')}${T('export', 'download', 'Export SVG', '', false, !has)}${T('print', 'print', 'Print / PDF', keyLabel('mod+p'), false, !has)}<button class="btn primary" data-cmd="save" data-tip="Save" data-keys="${keyLabel('mod+s')}" ${!has ? 'disabled' : ''}>${icon('save')}Save</button></div>`;
  $('#zoomRead').onclick = (e) => menu([50, 100, 150, 200, 400].map((p) => ({ label: p + '%', run: () => { editor.zoomToPct(p); renderZoom(); } })).concat(['-', { label: 'Fit sheet', icon: 'fit', run: () => { editor.fit(); renderZoom(); } }]), { anchor: e.currentTarget });
}
$('#toolbar').addEventListener('click', (e) => { const b = e.target.closest('[data-cmd]'); if (b && !b.disabled) { runCommand(b.dataset.cmd); renderToolbar(); } });
const renderZoom = () => { const z = $('#zoomRead'); if (z) z.textContent = editor.zoomPct() + '%'; $('#stZoom').innerHTML = `${icon('zoomIn')}<span class="mono">${editor.zoomPct()}%</span>`; };

// ======================================================================== status bar
const TOOL_NAMES = { select: 'Select', pan: 'Pan', wire: 'Wire — click points, double-click or Enter to finish, Shift = free angle', line: 'Line', rect: 'Rectangle — drag', ellipse: 'Ellipse — drag', text: 'Text — click to type', place: 'Place — click to drop, R rotates, Esc stops' };
function renderStatusTool() { $('#stTool').innerHTML = `${icon(editor.tool === 'place' ? 'lib' : 'cursor')}<span>${esc(editor.tool === 'place' && editor.placing ? `Place ${editor.placing.sym.name} — click to drop, R rotates, Esc stops` : TOOL_NAMES[editor.tool] || editor.tool)}</span>`; }
function renderStatusSel(s) { $('#stSel').textContent = s?.elements?.length ? `${s.elements.length} selected` : ''; }
function renderSave(c) {
  const d = editor.doc;
  $('#stSave').innerHTML = !d ? '' : c.dirty ? `<span class="warn">●</span> Unsaved changes` : d.saved ? `${icon('check')}<span>Saved</span>` : `<span class="faint">Imported — not saved yet</span>`;
}
function renderIndexStatus() {
  const ix = editor.index;
  if (!ix) { $('#stIndex').textContent = ''; return; }
  const jp = ix.texts.filter((t) => hasJapanese(t.text) && !translate(t.text, state.dict)).length;
  $('#stIndex').innerHTML = `<span>${ix.texts.length} texts · ${ix.segs.length} wire segments · ${ix.rows.length} lines</span>${state.english ? `<span class="${jp ? 'warn' : 'ok'}">${jp ? jp + ' untranslated' : 'English'}</span>` : ''}`;
}

// ======================================================================== workspace mode
async function setMode(m) {
  if (m === state.mode && (m === '2d' || !stage3d.hidden)) return;
  state.mode = m;
  store.set('mode', m);
  for (const b of $('#modeSeg').querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.mode === m));
  slideIndicator($('#modeSeg'));
  stage2d.hidden = m !== '2d'; stage3d.hidden = m !== '3d';
  $('#main').classList.toggle('no-left', m === '3d' || !leftOpen);
  $('#search').parentElement.hidden = m === '3d';
  for (const id of ['#stCursor', '#stZoom', '#stTool', '#stSel', '#stIndex', '#stSave', '.crumbs']) $(id).hidden = m === '3d';
  if (m === '3d') { panel3d.activate().then(renderToolbar); } else { panel3d.deactivate(); renderInspector(); }
  renderToolbar();
}
$('#modeSeg').onclick = (e) => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); };

// ======================================================================== left pane
let leftOpen = true, rightOpen = true;
function setLeftTab(t) {
  state.leftTab = t; store.set('leftTab', t);
  for (const b of $('#leftTabs').querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.tab === t));
  slideIndicator($('#leftTabs'));
  renderLeft();
  if (t === 'checks' && !state.check && project()) runCheck({ quiet: true });
}
$('#leftTabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) setLeftTab(b.dataset.tab); };

function renderLeft() {
  const tools = $('#leftTools');
  if (state.leftTab === 'sheets') {
    tools.innerHTML = `<input type="search" placeholder="Filter sheets" id="leftFilter" value="${esc(state.filter)}" aria-label="Filter sheets"><button class="ibtn" data-act="newSheet" data-tip="New sheet">${icon('plus')}</button>`;
  } else if (state.leftTab === 'checks') {
    tools.innerHTML = `<input type="search" placeholder="Filter findings" id="leftFilter" value="${esc(state.filter)}" aria-label="Filter findings"><button class="ibtn" data-act="runCheck" data-tip="Check again" data-keys="F7" aria-label="Check again">${icon('refresh')}</button>`;
  } else if (state.leftTab === 'components') {
    tools.innerHTML = `<input type="search" placeholder="Search part no., maker, tag" id="leftFilter" value="${esc(state.filter)}" aria-label="Filter parts"><button class="ibtn" data-act="exportBom" data-tip="Bill of materials (Excel)" aria-label="Export bill of materials">${icon('download')}</button>`;
  } else {
    tools.innerHTML = `<input type="search" placeholder="Search symbols" id="leftFilter" value="${esc(state.filter)}" aria-label="Filter symbols">`;
  }
  $('#leftFilter').oninput = (e) => { state.filter = e.target.value; renderLeftBody(); };
  renderLeftBody();
}
function renderLeftBody() {
  if (state.leftTab === 'sheets') renderTree(); else if (state.leftTab === 'symbols') renderLibrary(); else if (state.leftTab === 'checks') renderChecks(); else renderComponents();
}
$('#leftTools').addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]');
  if (a?.dataset.act === 'newSheet') runCommand('newSheet');
  if (a?.dataset.act === 'runCheck') runCheck();
  if (a?.dataset.act === 'exportBom') runCommand('exportBom');
});

function renderTree() {
  const q = state.filter.trim().toLowerCase();
  const html = state.drawings.map((d) => {
    const pages = d.pages.filter((p) => !q || `${d.title} ${tr(p.name)} ${p.name}`.toLowerCase().includes(q));
    if (!pages.length) return '';
    return `<div class="drawing"><span>${esc(d.title)}</span><span class="n">${pages.length}</span></div>` + pages.map((p) =>
      `<a data-p="${esc(p.id)}" ${p.id === state.sheet ? 'aria-current="page"' : ''} title="${esc(p.name)}">${icon(p.source === 'import' ? 'sheet' : 'sheetEdit')}<span class="nm">${esc(tr(p.name))}</span>${p.source !== 'import' ? `<span class="badge">${p.source === 'new' ? 'new' : 'edited'}</span>` : ''}</a>`).join('');
  }).join('');
  $('#leftBody').innerHTML = `<div class="tree">${html || '<div class="empty">No sheets match.</div>'}</div>`;
}

function symbolPreview(s) {
  const [w, h] = s.size, pad = Math.max(w, h) * 0.08 + 0.8, W = Math.max(w, 1) + pad * 2, H = Math.max(h, 1) + pad * 2;
  const sw = Math.max(W, H) / 60;
  const pts = (p) => p.pts.map(([x, y]) => `${(x + pad).toFixed(2)},${(H - pad - y).toFixed(2)}`).join(' ');
  return `<svg viewBox="0 0 ${W.toFixed(2)} ${H.toFixed(2)}" preserveAspectRatio="xMidYMid meet">${s.paths.map((p) => p.closed
    ? `<polygon points="${pts(p)}" fill="${p.fill ? 'currentColor' : 'none'}" fill-opacity=".12" stroke="${p.stroke === false ? 'none' : 'currentColor'}" stroke-width="${sw}"/>`
    : `<polyline points="${pts(p)}" fill="none" stroke="currentColor" stroke-width="${sw}"/>`).join('')}${s.pins.map((p) => `<circle cx="${p.at[0] + pad}" cy="${H - pad - p.at[1]}" r="${sw * 1.6}" fill="var(--net)"/>`).join('')}</svg>`;
}
const CAT_ORDER = ['custom', 'contacts', 'relays', 'coils', 'operator', 'sensors', 'protection', 'terminals', 'wiring', 'references', 'annotations', 'flowchart', 'basic', 'dimensions', 'mechanical', 'other'];
function renderLibrary() {
  if (state.leftTab !== 'symbols') return;
  const q = state.filter.trim().toLowerCase();
  const armed = editor.placing?.sym?.id;
  const groups = new Map();
  for (const s of state.symbols) if (!q || `${s.name} ${s.category} ${s.master || ''}`.toLowerCase().includes(q)) { if (!groups.has(s.category)) groups.set(s.category, []); groups.get(s.category).push(s); }
  const html = [...groups].sort((a, b) => CAT_ORDER.indexOf(a[0]) - CAT_ORDER.indexOf(b[0])).map(([cat, list]) =>
    `<div class="lib-cat"><span>${esc(cat)}</span><span class="n">${list.length}</span></div><div class="lib-grid">${list.map((s) =>
      `<div class="sym ${s.id === armed ? 'armed' : ''}" draggable="true" data-sym="${esc(s.id)}" title="${esc(s.name)}${s.master ? ' · Visio master ' + esc(s.masterEn || s.master) : ''} · used ${s.count}× in this project">${symbolPreview(s)}<span class="nm">${esc(s.name)}</span></div>`).join('')}</div>`).join('');
  $('#leftBody').innerHTML = html || `<div class="empty">${state.symbols.length ? 'No symbol matches.' : 'No symbol library yet. Run <span class="mono">node tools/extract-symbols.js ' + esc(project() || '<project>') + '</span>.'}</div>`;
}
$('#leftBody').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.chk-f')) { e.preventDefault(); e.stopPropagation(); checksClick(e); }
});
$('#leftBody').addEventListener('click', async (e) => {
  if (state.leftTab === 'checks' && checksClick(e)) return;
  const a = e.target.closest('[data-p]');
  if (a) return openSheet(a.dataset.p);
  const s = e.target.closest('[data-sym]');
  if (s) { const sym = state.symbols.find((x) => x.id === s.dataset.sym); if (state.mode !== '2d') await setMode('2d'); editor.startPlace(sym); return; }
  const c = e.target.closest('[data-comp]');
  if (c) { state.openComp = state.openComp === c.dataset.comp ? null : c.dataset.comp; renderComponents(); return; }
  const place = e.target.closest('[data-place]');
  if (place) { const sym = state.symbols.find((x) => x.id === place.dataset.place); if (sym) { editor.startPlace(sym, { tag: place.dataset.tag || null }); toast(`Placing ${sym.name}${place.dataset.tag ? ' as ' + place.dataset.tag : ''} — click on the sheet`, { kind: 'info', duration: 2200 }); } return; }
  const k = e.target.closest('[data-key]');
  if (k) return showXref(k.dataset.key, { jump: true });
});
// right-click a sheet in the tree: the sheet commands, run on that sheet (it opens first)
$('#leftBody').addEventListener('contextmenu', (e) => {
  const a = e.target.closest('[data-p]');
  if (!a) return;
  e.preventDefault();
  const id = a.dataset.p, page = pageOf(id)?.p;
  const on = (cmd) => async () => { if (await openSheet(id)) runCommand(cmd); };
  menu([
    { label: 'Open', icon: 'sheet', run: () => openSheet(id) },
    { label: 'Duplicate…', icon: 'copy', run: on('duplicateSheet') },
    { label: 'Rename…', icon: 'text', run: on('rename') },
    '-',
    { label: 'Delete…', icon: 'trash', danger: true, disabled: page?.source !== 'new', run: on('deleteSheet') },   // imported sheets stay
  ], { x: e.clientX, y: e.clientY });
});
$('#leftBody').addEventListener('dragstart', (e) => { const s = e.target.closest('[data-sym]'); if (s) { e.dataTransfer.setData('text/x-ecad-symbol', s.dataset.sym); e.dataTransfer.effectAllowed = 'copy'; } });
stage2d.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/x-ecad-symbol')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
stage2d.addEventListener('drop', (e) => {
  const id = e.dataTransfer.getData('text/x-ecad-symbol'); if (!id || !editor.doc) return;
  e.preventDefault();
  const sym = state.symbols.find((x) => x.id === id);
  if (sym) editor.dropSymbol(sym, e.clientX, e.clientY);
});

function renderComponents() {
  const q = state.filter.trim().toLowerCase();
  const list = state.components.filter((c) => !q || `${c.part} ${c.maker || ''} ${c.category} ${c.name || ''} ${c.tags.join(' ')}`.toLowerCase().includes(q));
  let cat = null;
  $('#leftBody').innerHTML = list.map((c) => {
    const head = c.category !== cat ? `<div class="lib-cat"><span>${esc((cat = c.category))}</span></div>` : '';
    const open = state.openComp === c.part;
    const det = open ? `<div style="grid-column:1/-1;margin-top:8px">
        <div class="kv">${c.footprint ? `<span>Footprint</span><span class="mono">${c.footprint[0]} × ${c.footprint[1]} mm</span>` : ''}<span>Source</span><span>${esc(c.sources.join(', '))}</span>${c.model ? `<span>3D model</span><span>${icon('box3d')} yes</span>` : ''}</div>
        ${c.tags.length ? `<div style="margin-top:8px">${c.tags.slice(0, 24).map((t) => `<span class="chip" data-key="${esc(t.toUpperCase())}">${esc(t)}</span>`).join('')}</div>` : ''}
        ${c.sheets.length ? `<div class="faint" style="margin-top:6px">Written on ${c.sheets.length} sheet(s)</div>` : ''}
        ${c.symbols.length ? `<div class="row" style="margin-top:8px;flex-wrap:wrap">${c.symbols.map((sid) => { const s = state.symbols.find((x) => x.id === sid); return s ? `<button class="btn solid" data-place="${esc(s.id)}">${icon('plus')}${esc(s.name)}</button>` : ''; }).join('')}</div>` : ''}
      </div>` : '';
    return `${head}<div class="comp ${open ? 'open' : ''}" data-comp="${esc(c.part)}"><span class="pn">${esc(c.part)}</span><span class="mk">${esc(c.maker || '')}</span>${c.name ? `<span class="ds">${esc(c.name)}</span>` : ''}${det}</div>`;
  }).join('') || '<div class="empty">No components match.</div>';
}

// ======================================================================== electrical check
const SEV_ICON = { error: 'error', warning: 'alert', info: 'info', pass: 'pass' };
const SEV_RANK = { error: 0, warning: 1, info: 2, pass: 3 };
const stIco = (s) => `<span class="st-ico ${s}">${icon(SEV_ICON[s])}</span>`;
function pageOf(pid) { for (const d of state.drawings) for (const p of d.pages) if (p.id === pid) return { d, p }; return null; }
// a sheet name that says where it is: bare page names ("2", "Page-1") get the drawing's name in front
function sheetShort(o) {
  const name = tr(o.p.name).trim();
  if (!/^(page-?\s*)?\d+$/i.test(name)) return name;
  return `${o.d.title.replace(/^\d{4}-[A-Z]\d{3}-\d{4}(-\d)?\s+/, '').replace(/\s+OK$/i, '')} · ${name}`;
}
function locLabel(w) {
  if (w.cabinet) return { lead: w.key, text: `cabinet ${w.cabinet}`, title: `Show ${w.key} in cabinet ${w.cabinet} (3D)` };
  const o = pageOf(w.page);
  return { lead: w.line || (w.shape == null ? w.key : '') || '', text: o ? sheetShort(o) : w.page, title: o ? `${o.d.title} · ${tr(o.p.name)}` : w.page };
}

async function runCheck({ quiet = false } = {}) {
  if (!project() || state.checking) return;
  state.checking = true;
  if (state.leftTab === 'checks') $('#leftTools [data-act=runCheck]')?.setAttribute('disabled', '');
  try {
    state.check = await api('/api/check/' + encodeURIComponent(project()));
    if (!state.checkOpen) state.checkOpen = new Set(state.check.checklist.filter((c) => c.status === 'error' || c.status === 'warning').map((c) => c.id));
    if (!quiet) { const s = state.check.summary; toast(s.errors || s.warnings ? `Check: ${s.errors} error(s), ${s.warnings} warning(s)` : 'Check passed — no errors or warnings', { kind: s.errors ? 'err' : s.warnings ? 'info' : 'ok', duration: 2200 }); }
  } catch (e) { if (!quiet) toast('Check failed: ' + e.message, { kind: 'err' }); }
  finally { state.checking = false; }
  renderCheckStatus();
  if (state.leftTab === 'checks') renderLeft();
  showIssues();
}
function showIssues() {
  if (!state.check || !state.sheet) { editor.setIssues([]); return; }
  const list = [];
  for (const f of state.check.findings) if (f.severity !== 'info') for (const w of f.where || []) if (w.page === state.sheet && (w.shape != null || w.key)) list.push({ shape: w.shape, key: w.key, severity: f.severity });
  editor.setIssues(list);
}
function renderCheckStatus() {
  const c = state.check, b = $('#stCheck'), dot = $('#checkDot');
  if (!c) { b.hidden = true; dot.hidden = true; return; }
  const { errors: e, warnings: w } = c.summary;
  b.hidden = false;
  b.innerHTML = e || w ? `${e ? `<span class="err row" style="gap:4px">${icon('error')}${e}</span>` : ''}${w ? `<span class="warn row" style="gap:4px">${icon('alert')}${w}</span>` : ''}` : `<span class="ok row" style="gap:4px">${icon('pass')}Check passed</span>`;
  b.setAttribute('aria-label', `Electrical check: ${e} errors, ${w} warnings`);
  dot.hidden = !(e || w); dot.classList.toggle('error', !!e);
}
function renderChecks() {
  const c = state.check;
  if (!c) { $('#leftBody').innerHTML = `<div class="empty">${state.checking ? 'Checking…' : 'Not checked yet.'}</div>`; return; }
  const q = state.filter.trim().toLowerCase();
  const byRule = new Map(c.checklist.map((r) => [r.id, []]));
  c.findings.forEach((f, i) => { if (!q || `${f.message} ${f.rule} ${(f.where || []).map((w) => `${w.key || ''} ${w.line || ''}`).join(' ')}`.toLowerCase().includes(q)) byRule.get(f.rule)?.push(i); });
  const t = new Date(c.at);
  let html = `<div class="chk-sum"><div class="n err ${c.summary.errors ? 'hot' : ''}"><b>${c.summary.errors}</b><span>errors</span></div><div class="n warn ${c.summary.warnings ? 'hot' : ''}"><b>${c.summary.warnings}</b><span>warnings</span></div><div class="n"><b>${c.summary.info}</b><span>notes</span></div></div>
    <div class="chk-at faint">${c.checklist.length} rules · checked ${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${q ? ` · filtered by “${esc(q)}”` : ''}</div>`;
  const failing = c.checklist.filter((r) => r.status !== 'pass').sort((a, b) => SEV_RANK[a.status] - SEV_RANK[b.status]);
  for (const r of failing) {
    const idx = byRule.get(r.id);
    if (q && !idx.length) continue;
    const open = !!q || state.checkOpen.has(r.id);
    html += `<button class="chk-rule" data-rule="${esc(r.id)}" aria-expanded="${open}">${stIco(r.status)}<span class="t">${esc(r.title)}</span><span class="c">${idx.length}</span><span class="chev">${icon('chevron')}</span></button>`;
    if (!open) continue;
    html += `<div class="chk-help">${esc(r.help)}</div>`;
    for (const i of idx) {
      const f = c.findings[i], ws = f.where || [], all = state.checkAll.has(i), shown = all ? ws : ws.slice(0, 3);
      html += `<div class="chk-f" role="button" tabindex="0" data-f="${i}" ${state.checkActive === i ? 'aria-current="true"' : ''}><div class="m">${esc(f.message)}</div>${ws.length ? `<div class="w">${shown.map((w, k) => { const l = locLabel(w); return `<span class="chk-loc" data-loc="${i}:${k}" title="${esc(l.title)}">${l.lead ? `<b>${esc(l.lead)}</b> ` : ''}${esc(l.text)}</span>`; }).join('')}${ws.length > shown.length ? `<span class="chk-loc more" data-more="${i}">+${ws.length - shown.length} more</span>` : ''}</div>` : ''}</div>`;
    }
  }
  const passed = c.checklist.filter((r) => r.status === 'pass');
  if (passed.length && !q) html += `<div class="lib-cat"><span>Passed</span><span class="n">${passed.length}</span></div><div class="chk-passed">${passed.map((r) => `<div title="${esc(r.help)}">${stIco('pass')}<span>${esc(r.title)}</span></div>`).join('')}</div>`;
  if (c.assumptions?.length && !q) html += `<div class="chk-assume"><b>Assumed values</b> (no datasheet figure in library/electrical/loads.yaml):<br>${c.assumptions.map(esc).join('<br>')}</div>`;
  $('#leftBody').innerHTML = html;
}
async function goWhere(w) {
  if (!w) return;
  if (w.cabinet) { await setMode('3d'); await panel3d.load(w.cabinet, w.cabinet); if (w.key) panel3d.selectTag(w.key); renderToolbar(); return; }
  if (state.mode !== '2d') await setMode('2d');
  if (!(await openSheet(w.page))) return;
  if (w.shape != null) { editor.focusShape(w.shape, w.key); return; }
  if (w.key) {
    const x = await api(`/api/xref/${encodeURIComponent(project())}?key=${encodeURIComponent(w.key)}`);
    const o = x.occurrences.find((q) => q.page === w.page);
    if (o) { state.xref = x; state.xrefActive = x.occurrences.indexOf(o); editor.focusShape(o.id, w.key); renderInspector(); return; }
  }
  if (w.line) await gotoLine(w.line, w.page);
}
function checksClick(e) {
  const r = e.target.closest('[data-rule]');
  if (r) { const id = r.dataset.rule; state.checkOpen.has(id) ? state.checkOpen.delete(id) : state.checkOpen.add(id); renderChecks(); return true; }
  const m = e.target.closest('[data-more]');
  if (m) { state.checkAll.add(Number(m.dataset.more)); renderChecks(); return true; }
  const l = e.target.closest('[data-loc]'), f = e.target.closest('[data-f]');
  if (!l && !f) return false;
  const [fi, wi] = l ? l.dataset.loc.split(':').map(Number) : [Number(f.dataset.f), 0];
  state.checkActive = fi;
  for (const x of $('#leftBody').querySelectorAll('.chk-f')) { if (Number(x.dataset.f) === fi) x.setAttribute('aria-current', 'true'); else x.removeAttribute('aria-current'); }
  goWhere(state.check.findings[fi].where?.[wi]);
  return true;
}
$('#stCheck').onclick = () => runCommand('checks');

// ======================================================================== inspector (drawings)
const num = (v) => (Math.round(v * 10) / 10).toFixed(1);
function renderInspector() {
  if (state.mode !== '2d') return;
  const el = $('#inspector');
  const doc = editor.doc, s = state.selection;
  if (!doc) { el.innerHTML = '<div class="empty">Open a sheet from the left.</div>'; return; }
  let html = '';
  const list = s?.elements || [];
  if (!list.length) {
    const ix = editor.index;
    html += `<div class="section"><h4>Sheet</h4><div class="kv"><span>Name</span><span>${esc(tr(doc.name))}</span><span>Size</span><span class="mono">${num(doc.widthMm)} × ${num(doc.heightMm)} mm</span><span>Shapes</span><span>${doc.elements.length}</span><span>State</span><span>${editor.dirty ? 'Unsaved changes' : doc.saved ? 'Saved' : 'Imported, not saved yet'}</span>${ix ? `<span>Lines</span><span>${ix.rows.length ? `${esc(ix.rows[0].label)} … ${esc(ix.rows.at(-1).label)}` : '—'}</span>` : ''}</div>
      <div class="row" style="margin-top:12px"><button class="btn solid" data-act="rename">${icon('text')}Rename</button><button class="btn solid" data-cmd="duplicateSheet">${icon('copy')}Duplicate</button>${doc.saved && doc.source === null ? `<button class="btn solid danger" data-act="deleteSheet">${icon('trash')}Delete</button>` : ''}</div></div>
      <div class="section"><h4>Tips</h4><div class="faint" style="line-height:1.6">Click a shape to see its cross-reference and net. Double-click text to edit it, or an L-number arrow to jump to that line. Drag symbols in from the Symbols tab. <kbd>${keyLabel('mod+k')}</kbd> lists every command.</div></div>`;
  } else if (list.length > 1) {
    const g = editor.selectionGroup();
    html += `<div class="section"><h4>${g != null ? 'Group' : 'Selection'} <span class="count">${list.length}</span></h4><div class="row" style="flex-wrap:wrap">${['left', 'center', 'right', 'top', 'middle', 'bottom'].map((k) => `<button class="ibtn" data-cmd="align.${k}" data-tip="Align ${k}">${icon('align' + { left: 'L', center: 'C', right: 'R', top: 'T', middle: 'M', bottom: 'B' }[k])}</button>`).join('')}</div>
      <div class="faint" style="margin-top:8px">${Object.entries(list.reduce((a, e) => ((a[e.kind] = (a[e.kind] || 0) + 1), a), {})).map(([k, n]) => `${n} ${k}`).join(' · ')}</div>
      <div class="row" style="margin-top:10px">${g != null ? `<button class="btn solid" data-cmd="ungroup">${icon('ungroup')}Ungroup</button>` : `<button class="btn solid" data-cmd="group">${icon('group')}Group</button>`}</div></div>`;
    const fmt = styleRows(list);
    if (fmt) html += `<div class="section"><h4>Format</h4><div class="kv">${fmt}</div></div>`;
  } else {
    html += propsOf(list[0], doc);
  }
  // cross-reference for the selected shape's identifiers
  const keys = [...new Set((s?.texts || []).flatMap((t) => t.keys))].slice(0, 6);
  if (keys.length) html += `<div class="section"><h4>Identifiers</h4>${keys.map((k) => `<span class="chip ${state.xref?.key === k ? 'net' : ''}" data-key="${esc(k)}">${esc(k)}</span>`).join('')}</div>`;
  if (state.xref) html += xrefHtml(state.xref);
  if (state.net) html += `<div class="section"><h4>${icon('net')} Net</h4><div class="faint" style="margin-bottom:6px">${state.net.segments} wire segment(s) connected${state.net.devices.length ? ' · ends at ' + state.net.devices.map(esc).join(', ') : ''}</div>${state.net.labels.map((k) => `<span class="chip net" data-key="${esc(k)}">${esc(k)}</span>`).join('') || '<span class="faint">No label on this net.</span>'}</div>`;
  el.innerHTML = html;
}
function propsOf(e, doc) {
  const [bx, by, bw, bh] = elementBox(e, doc);
  const xmm = num(bx / PT), ymm = num((doc.height - by - bh) / PT);
  const pos = `<span>Position</span><span class="row"><input class="mono" type="number" step="0.5" value="${xmm}" data-prop="x" aria-label="X mm" style="width:84px"><input class="mono" type="number" step="0.5" value="${ymm}" data-prop="y" aria-label="Y mm" style="width:84px"></span>`;
  const size = `<span>Size</span><span class="mono">${num(bw / PT)} × ${num(bh / PT)} mm</span>`;
  const K = { visio: 'Imported shape', wire: 'Wire', line: 'Line', rect: 'Rectangle', ellipse: 'Ellipse', text: 'Text', symbol: 'Symbol' };
  let rows = '';
  if (e.kind === 'symbol') rows = `<span>Symbol</span><span>${esc(e.name)}</span><span>Tag</span><span><input class="mono" type="text" value="${esc(e.tag || '')}" data-prop="tag" aria-label="Tag"></span><span>Part no.</span><span><input class="mono" type="text" list="partList" value="${esc(e.part || '')}" data-prop="part" aria-label="Part number" placeholder="from the catalogue"></span><span>Rotation</span><span><select data-prop="rot" aria-label="Rotation">${[0, 90, 180, 270].map((r) => `<option ${r === (e.rot || 0) ? 'selected' : ''} value="${r}">${r}°</option>`).join('')}</select></span>${pos}${size}<span>Pins</span><span>${e.pins?.length || 0}</span>`;
  else if (e.kind === 'text') rows = `<span>Text</span><span><textarea data-prop="text" rows="${Math.min(6, e.text.split('\n').length + 1)}" aria-label="Text">${esc(e.text)}</textarea></span>${pos}`;
  else if (e.kind === 'wire' || e.kind === 'line') { let L = 0; for (let i = 1; i < e.pts.length; i++) L += Math.hypot(e.pts[i][0] - e.pts[i - 1][0], e.pts[i][1] - e.pts[i - 1][1]); rows = `<span>Points</span><span>${e.pts.length}</span><span>Length</span><span class="mono">${num(L / PT)} mm</span>${pos}`; }
  else if (e.kind === 'visio') {
    const texts = (e.shapes || []).filter((x) => x.text).map((x) => x.text);
    rows = `<span>Master</span><span>${esc(e.master ? tr(e.master.replace(/\.\d+$/, '')) : '—')}</span>${texts.length ? `<span>Text</span><span>${texts.slice(0, 4).map((t) => `<div class="mono" style="white-space:pre-wrap">${esc(tr(t))}</div>`).join('')}</span>` : ''}${pos}${size}`;
  } else rows = `${pos}<span>Size</span><span class="row"><input class="mono" type="number" min="0.5" step="0.5" value="${num(bw / PT)}" data-prop="w" aria-label="Width mm" style="width:84px"><input class="mono" type="number" min="0.5" step="0.5" value="${num(bh / PT)}" data-prop="h" aria-label="Height mm" style="width:84px"></span>`;
  const fmt = styleRows([e]);
  return `<div class="section"><h4>${esc(K[e.kind] || e.kind)} <span class="count mono">#${e.id}</span>${e.group != null ? '<span class="count">· in a group</span>' : ''}</h4><div class="kv">${rows}</div></div>${fmt ? `<div class="section"><h4>Format</h4><div class="kv">${fmt}</div></div>` : ''}`;
}
// ---- format rows (one shape or many: a mixed value shows empty, a change applies to all)
const hex = (c) => { const s = String(c || ''); if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase(); if (/^#[0-9a-f]{3}$/i.test(s)) return '#' + [...s.slice(1)].map((ch) => ch + ch).join('').toLowerCase(); return s === 'white' ? '#ffffff' : '#000000'; };
const DASH_NAMES = { solid: 'Solid', dash: 'Dashed', dot: 'Dotted', dashdot: 'Dash-dot', long: 'Long dash' };
const FONT_NAMES = { mono: 'Plex Mono', sans: 'Plex Sans', gothic: 'MS Gothic' };
function styleRows(list) {
  const has = (k) => list.every((e) => (STYLE_KEYS[e.kind] || []).includes(k));
  const val = (k, d) => { const v = [...new Set(list.map((e) => e[k] ?? d))]; return v.length === 1 ? v[0] : undefined; };
  const sel = (k, names, d) => { const v = val(k, d); return `<select data-style="${k}" aria-label="${k}">${v === undefined ? '<option selected disabled>Mixed</option>' : ''}${Object.entries(names).map(([id, label]) => `<option value="${id}" ${id === v ? 'selected' : ''}>${label}</option>`).join('')}</select>`; };
  let r = '';
  if (has('stroke')) r += `<span>Colour</span><span class="row"><input type="color" data-style="stroke" value="${hex(val('stroke', '#000000'))}" aria-label="Line colour"></span>`;
  if (has('width')) r += `<span>Weight</span><span><input class="mono" type="number" min="0.1" max="5" step="0.1" value="${val('width', 0.72) ?? ''}" placeholder="mixed" data-style="width" aria-label="Line weight" style="width:84px"> pt</span>`;
  if (has('dash')) r += `<span>Pattern</span><span>${sel('dash', DASH_NAMES, 'solid')}</span>`;
  if (has('arrows')) r += `<span>Arrows</span><span>${sel('arrows', { none: 'None', start: 'At start', end: 'At end', both: 'Both ends' }, 'none')}</span>`;
  if (has('fill')) { const f = val('fill', null); r += `<span>Fill</span><span class="row"><label class="row" style="gap:4px"><input type="checkbox" data-style="fillOn" ${f ? 'checked' : ''} aria-label="Fill"></label><input type="color" data-style="fill" value="${hex(f || '#ffffff')}" aria-label="Fill colour" ${f ? '' : 'disabled'}></span>`; }
  if (has('color')) r += `<span>Colour</span><span><input type="color" data-style="color" value="${hex(val('color', '#000000'))}" aria-label="Text colour"></span>`;
  if (has('size')) r += `<span>Size</span><span><input class="mono" type="number" min="3" max="72" step="0.5" value="${val('size', 9) ?? ''}" placeholder="mixed" data-style="size" aria-label="Font size" style="width:84px"> pt</span>`;
  if (has('font')) r += `<span>Font</span><span>${sel('font', FONT_NAMES, 'mono')}</span>`;
  if (has('anchor')) r += `<span>Align</span><span>${sel('anchor', { start: 'Left', middle: 'Centre', end: 'Right' }, 'start')}</span>`;
  if (has('bold')) r += `<span>Bold</span><span><input type="checkbox" data-style="bold" ${val('bold', false) ? 'checked' : ''} aria-label="Bold"></span>`;
  return r;
}
function xrefHtml(x) {
  const occ = x.occurrences || [];
  const roles = [...new Set(occ.map((o) => o.role).filter(Boolean))];
  const nm = (pid) => { for (const d of state.drawings) for (const p of d.pages) if (p.id === pid) return `${d.title} · ${tr(p.name)}`; return pid; };
  return `<div class="section"><h4>${icon('search')} Cross reference</h4><div class="key-title">${esc(x.key)}</div><div class="faint" style="margin:2px 0 8px">${occ.length} place${occ.length === 1 ? '' : 's'} on ${new Set(occ.map((o) => o.page)).size} sheet(s)${roles.length ? ' · ' + roles.map(esc).join(', ') : ''}</div>
    ${x.line ? `<button class="btn solid" data-act="gotoLine" style="margin-bottom:8px">${icon('chevron')}Go to line ${esc(x.key)}</button>` : ''}
    ${occ.map((o, i) => `<div class="occ" data-occ="${i}" ${state.xrefActive === i ? 'aria-current="true"' : ''}><span class="ln">${esc(o.line || (o.row ? 'row' : '—'))}</span><span class="wh">${esc(nm(o.page))}</span>${o.role ? `<span class="rl">${esc(o.role)}</span>` : ''}</div>`).join('')}
    ${x.cabinet?.length ? `<div style="margin-top:10px">${x.cabinet.map((c, i) => `<button class="btn solid" data-cab="${i}">${icon('box3d')}Show in 3D · ${esc(c.cabinet)}</button>`).join('')}</div>` : ''}</div>`;
}
$('#inspector').addEventListener('change', (e) => {
  if (state.mode !== '2d') return;
  const st = e.target.dataset.style;
  if (st) {
    const t = e.target;
    const DEFAULTS = { dash: 'solid', arrows: 'none', anchor: 'start', font: 'mono' };
    if (st === 'fillOn') { editor.restyle({ fill: t.checked ? ($('#inspector [data-style=fill]')?.value || '#ffffff') : null }, t.checked ? 'Fill' : 'No fill'); return; }
    let v = t.type === 'checkbox' ? (t.checked || null) : t.value;
    if (st === 'width' || st === 'size') { v = Number(v); if (!(v > 0)) return; }
    if (DEFAULTS[st] === v) v = null;                         // defaults are not stored
    editor.restyle({ [st]: v }, { stroke: 'Line colour', color: 'Text colour', fill: 'Fill colour', width: 'Line weight', dash: 'Line pattern', arrows: 'Arrows', size: 'Font size', font: 'Font', anchor: 'Align text', bold: 'Bold' }[st] || 'Format');
    return;
  }
  const p = e.target.dataset.prop; if (!p) return;
  const [el] = editor.selection; if (!el) return;
  const v = e.target.value, doc = editor.doc;
  if (p === 'x' || p === 'y') {
    const [bx, by, , bh] = elementBox(el, doc);
    const want = Number(v) * PT;
    const dx = p === 'x' ? want - bx : 0, dy = p === 'y' ? (doc.height - want - bh) - by : 0;
    editor.select([el.id]); editor.nudge(+dx.toFixed(2), +dy.toFixed(2));
  } else if (p === 'w' || p === 'h') {
    const [bx, by, bw, bh] = elementBox(el, doc), want = Number(v) * PT;
    if (!(want > 0)) return;
    // the box grows from its top-left corner
    editor.reshape(el.id, [bx, by, p === 'w' ? want : bw, p === 'h' ? want : bh]);
  } else if (p === 'rot') editor.update(el.id, { rot: Number(v) }, 'Rotate');
  else if (p === 'tag') editor.update(el.id, { tag: v.trim() }, 'Edit tag');
  else if (p === 'part') editor.update(el.id, { part: v.trim().toUpperCase() || undefined }, 'Set part number');
  else if (p === 'text') editor.update(el.id, { text: v }, 'Edit text');
});
$('#inspector').addEventListener('click', async (e) => {
  if (state.mode !== '2d') return;
  const cmd = e.target.closest('[data-cmd]'); if (cmd) return runCommand(cmd.dataset.cmd);
  const k = e.target.closest('[data-key]'); if (k) return showXref(k.dataset.key);
  const o = e.target.closest('[data-occ]'); if (o) return goOcc(Number(o.dataset.occ));
  const a = e.target.closest('[data-act]');
  if (a?.dataset.act === 'gotoLine') return gotoLine(state.xref.key);
  if (a?.dataset.act === 'rename') return runCommand('rename');
  if (a?.dataset.act === 'deleteSheet') return runCommand('deleteSheet');
  const c = e.target.closest('[data-cab]');
  if (c) { const cab = state.xref.cabinet[Number(c.dataset.cab)]; await setMode('3d'); await panel3d.load(cab.cabinet, cab.cabinet); panel3d.selectTag(cab.tag); renderToolbar(); }
});

// ======================================================================== cross-reference / navigation
async function showXref(key, { jump = false } = {}) {
  state.xref = await api(`/api/xref/${encodeURIComponent(project())}?key=${encodeURIComponent(key)}`);
  state.xrefActive = null;
  renderInspector();
  if (jump && state.xref.occurrences.length) goOcc(0);
}
async function goOcc(i) {
  const o = state.xref?.occurrences[i]; if (!o) return;
  if (o.page !== state.sheet && !(await openSheet(o.page))) return;
  state.xrefActive = i;
  editor.focusShape(o.id, state.xref.key);
  renderInspector();
}
async function gotoLine(label, preferPage = null) {
  const x = await api(`/api/xref/${encodeURIComponent(project())}?key=${encodeURIComponent(label)}`);
  const ref = x.line;
  if (!ref) { if (preferPage) await openSheet(preferPage); toast(`Line ${label} is not on any sheet`, { kind: 'err' }); return; }
  if (ref.page !== state.sheet && !(await openSheet(ref.page))) return;
  editor.gotoRow(ref);
  state.xref = x; renderInspector();
}

// ======================================================================== sheets
async function guardUnsaved() {
  if (!editor.dirty) return true;
  const r = await dialog({ title: 'Save changes to this sheet?', body: `"${tr(editor.doc.name)}" has unsaved changes.`, actions: [{ label: 'Cancel', value: 'cancel', cancel: true }, { label: "Don't save", value: 'discard' }, { label: 'Save', value: 'save', primary: true }] });
  if (r === 'save') { try { await editor.save(); return true; } catch (e) { toast(e.message, { kind: 'err' }); return false; } }
  return r === 'discard';
}
async function openSheet(id, { force = false } = {}) {
  if (id === state.sheet && !force) return true;
  if (!(await guardUnsaved())) return false;
  try {
    await editor.open(id);
  } catch (e) { toast(e.message, { kind: 'err' }); return false; }
  state.sheet = id; store.set('sheet.' + project(), id);
  state.net = null;
  showIssues();
  findBar.refresh();
  const dr = state.drawings.find((d) => d.pages.some((p) => p.id === id));
  $('#crumbDrawing').textContent = dr?.title || '';
  $('#sheetName').textContent = tr(editor.doc.name);
  $('#crumbChev').innerHTML = icon('chevron'); $('#crumbChev2').innerHTML = icon('chevron');
  if (state.leftTab === 'sheets') renderTree();
  renderToolbar(); renderZoom(); renderIndexStatus(); renderInspector();
  history.replaceState(null, '', `?project=${encodeURIComponent(project())}&sheet=${encodeURIComponent(id)}`);
  return true;
}
async function refreshDrawings() { state.drawings = await api('/api/sheets/' + encodeURIComponent(project())); if (state.leftTab === 'sheets') renderTree(); }

// ======================================================================== search
let searchT = null;
$('#search').oninput = () => {
  clearTimeout(searchT);
  searchT = setTimeout(async () => {
    const q = $('#search').value.trim(), box = $('#searchResults');
    if (q.length < 2) { box.hidden = true; return; }
    const res = await api(`/api/search/${encodeURIComponent(project())}?q=${encodeURIComponent(q)}`);
    const r = $('#search').getBoundingClientRect();
    Object.assign(box.style, { left: r.left + 'px', top: r.bottom + 6 + 'px', width: Math.max(r.width, 260) + 'px' });
    box.innerHTML = res.map((x, i) => `<button data-k="${esc(x.key)}" ${i === 0 ? 'data-active' : ''}><span class="mono">${esc(x.key)}</span><kbd>${x.n}</kbd></button>`).join('') || '<div class="empty">No match</div>';
    box.hidden = false; box.style.setProperty('--origin', 'top left');
    requestAnimationFrame(() => { box.dataset.state = 'open'; });
  }, 110);
};
$('#search').onkeydown = (e) => {
  const box = $('#searchResults'), items = [...box.querySelectorAll('[data-k]')], i = items.findIndex((b) => b.hasAttribute('data-active'));
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[i]?.removeAttribute('data-active'); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.setAttribute('data-active', ''); }
  else if (e.key === 'Enter') { e.preventDefault(); (items[i] || items[0])?.click(); }
  else if (e.key === 'Escape') { box.hidden = true; $('#search').blur(); }
};
$('#searchResults').onclick = (e) => { const b = e.target.closest('[data-k]'); if (!b) return; $('#searchResults').hidden = true; $('#search').value = b.dataset.k; showXref(b.dataset.k, { jump: true }); };
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#searchResults, #search')) $('#searchResults').hidden = true; });

// ======================================================================== commands
const in2d = () => state.mode === '2d' && !!editor.doc;
const typingNow = () => !!document.activeElement?.closest?.('input, textarea, select, [contenteditable]');
const in3d = () => state.mode === '3d';
const tools = [['select', 'select', 'Select', 'v'], ['pan', 'pan', 'Pan', 'h'], ['wire', 'wire', 'Wire', 'w'], ['line', 'line', 'Line', 'l'], ['rect', 'rect', 'Rectangle', 'b'], ['ellipse', 'ellipse', 'Ellipse', 'e'], ['text', 'text', 'Text', 't']];
for (const [id, ic, title, key] of tools) command({ id: 'tool.' + id, title: `${title} tool`, group: 'Tools', icon: ic, keys: key, when: in2d, run: () => editor.setTool(id) });
command({ id: 'save', title: 'Save sheet', group: 'Sheet', icon: 'save', keys: 'mod+s', when: in2d, run: async () => {
  try { await editor.save(); toast('Sheet saved'); await refreshDrawings(); renderInspector(); runCheck({ quiet: true }); }
  catch (e) {
    if (e.status === 409) { const r = await confirmDialog('Sheet changed elsewhere', 'Another window saved this sheet after you opened it. Overwrite it with your version?', 'Overwrite', true); if (r) { editor.doc.rev = undefined; try { await editor.save(); toast('Sheet saved'); } catch (e2) { toast(e2.message, { kind: 'err' }); } } }
    else toast(e.message, { kind: 'err' });
  }
} });
command({ id: 'undo', title: 'Undo', group: 'Edit', icon: 'undo', keys: 'mod+z', when: in2d, run: () => editor.undo() });
command({ id: 'redo', title: 'Redo', group: 'Edit', icon: 'redo', keys: ['mod+y', 'mod+shift+z'], when: in2d, run: () => editor.redo() });
command({ id: 'delete', title: 'Delete selection', group: 'Edit', icon: 'trash', keys: ['Delete', 'Backspace'], when: in2d, run: () => editor.deleteSel() });
command({ id: 'duplicate', title: 'Duplicate', group: 'Edit', icon: 'copy', keys: 'mod+d', when: in2d, run: () => editor.duplicate() });
command({ id: 'copy', title: 'Copy', group: 'Edit', icon: 'copy', keys: 'mod+c', when: in2d, run: () => editor.copy() });
command({ id: 'cut', title: 'Cut', group: 'Edit', keys: 'mod+x', when: in2d, run: () => editor.cut() });
command({ id: 'paste', title: 'Paste', group: 'Edit', keys: 'mod+v', when: in2d, run: () => editor.paste() });
command({ id: 'selectAll', title: 'Select all', group: 'Edit', keys: 'mod+a', when: in2d, run: () => editor.selectAll() });
command({ id: 'rotate', title: 'Rotate 90°', group: 'Arrange', icon: 'rotate', keys: 'mod+r', when: in2d, run: () => editor.rotateSel() });
command({ id: 'flip', title: 'Flip horizontal', group: 'Arrange', keys: 'shift+h', when: () => in2d() && editor.selection.length > 0, run: () => editor.flipSel() });
command({ id: 'zoomSel', title: 'Zoom to selection', group: 'View', icon: 'search', keys: 'shift+2', when: () => in2d() && editor.selection.length > 0, run: () => { editor.zoomToSelection(); renderZoom(); } });
command({ id: 'saveSymbol', title: 'Save selection as symbol…', group: 'Library', icon: 'lib', when: () => in2d() && editor.selection.length > 0, run: async () => {
  const geo = editor.selectionAsSymbol();
  if (!geo) { toast('The selection has no drawable geometry', { kind: 'err' }); return; }
  const name = await prompt('Save as library symbol', 'New symbol', 'Save'); if (!name) return;
  try {
    const sym = await api(`/api/symbols/${encodeURIComponent(project())}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, category: 'custom', ...geo }) });
    state.symbols.push(sym); editor.setSymbols(state.symbols);
    if (state.leftTab === 'symbols') renderLibrary();
    toast(`Saved "${name}" to the library (${geo.pins.length} pin${geo.pins.length === 1 ? '' : 's'})`, { action: { label: 'Show', run: () => { setLeftTab('symbols'); } } });
  } catch (e) { toast(e.message, { kind: 'err' }); }
} });
command({ id: 'group', title: 'Group', group: 'Arrange', icon: 'group', keys: 'mod+g', when: () => in2d() && editor.selection.length > 1 && editor.selectionGroup() == null, run: () => editor.group() });
command({ id: 'ungroup', title: 'Ungroup', group: 'Arrange', icon: 'ungroup', keys: ['mod+shift+g', 'mod+shift+u'], when: () => in2d() && editor.selection.some((e) => e.group != null), run: () => editor.ungroup() });
command({ id: 'copyStyle', title: 'Copy format', group: 'Format', icon: 'paint', keys: 'mod+shift+c', when: () => in2d() && !typingNow() && editor.selection.length === 1, run: () => { if (editor.copyStyle()) toast('Format copied — select shapes, then Paste format', { kind: 'info', duration: 1800 }); else toast('This shape has no format to copy', { kind: 'info' }); } });
command({ id: 'pasteStyle', title: 'Paste format', group: 'Format', icon: 'paint', keys: 'mod+shift+v', when: () => in2d() && !typingNow() && editor.selection.length > 0 && editor.hasStyleClip, run: () => editor.pasteStyle() });
command({ id: 'front', title: 'Bring to front', group: 'Arrange', icon: 'front', keys: 'mod+]', when: in2d, run: () => editor.reorder(true) });
command({ id: 'back', title: 'Send to back', group: 'Arrange', icon: 'back', keys: 'mod+[', when: in2d, run: () => editor.reorder(false) });
for (const k of ['left', 'center', 'right', 'top', 'middle', 'bottom']) command({ id: 'align.' + k, title: `Align ${k}`, group: 'Arrange', icon: 'align' + { left: 'L', center: 'C', right: 'R', top: 'T', middle: 'M', bottom: 'B' }[k], when: () => in2d() && editor.selection.length > 1, run: () => editor.align(k) });
const G = 2.5 * PT;
for (const [k, dx, dy] of [['ArrowLeft', -1, 0], ['ArrowRight', 1, 0], ['ArrowUp', 0, -1], ['ArrowDown', 0, 1]]) {
  command({ id: 'nudge.' + k, keys: k, when: () => in2d() && editor.selection.length > 0, run: () => editor.nudge(dx * G, dy * G) });
  command({ id: 'nudgeBig.' + k, keys: 'shift+' + k, when: () => in2d() && editor.selection.length > 0, run: () => editor.nudge(dx * G * 10, dy * G * 10) });
}
command({ id: 'escape', keys: 'Escape', when: () => state.mode === '2d', run: () => editor.escape() });
command({ id: 'enter', keys: 'Enter', when: () => in2d() && ['wire', 'line'].includes(editor.tool), run: () => editor.finishDraft() });
command({ id: 'editText', title: 'Edit text of selection', group: 'Edit', icon: 'text', keys: 'F2', when: () => in2d() && editor.selection.length === 1, run: () => editor.editSelectedText() });
command({ id: 'ghostRotate', keys: 'r', when: () => in2d() && editor.tool === 'place', run: () => editor.rotateGhost() });
command({ id: 'snap', title: 'Toggle snap', group: 'View', icon: 'magnet', keys: 's', when: in2d, run: () => { editor.snap = !editor.snap; toast(`Snap ${editor.snap ? 'on' : 'off'}`, { kind: 'info', duration: 1200 }); } });
command({ id: 'grid', title: 'Toggle grid', group: 'View', icon: 'grid', keys: 'g', when: in2d, run: () => { editor.grid = !editor.grid; } });
command({ id: 'bg', title: 'Toggle title block', group: 'View', icon: 'layers', when: in2d, run: () => { editor.background = !editor.background; } });
command({ id: 'zoomIn', title: 'Zoom in', group: 'View', icon: 'zoomIn', keys: ['mod+=', 'mod++'], when: in2d, run: () => { editor.zoomBy(1 / 1.25); renderZoom(); } });
command({ id: 'zoomOut', title: 'Zoom out', group: 'View', icon: 'zoomOut', keys: 'mod+-', when: in2d, run: () => { editor.zoomBy(1.25); renderZoom(); } });
command({ id: 'fit', title: 'Fit sheet', group: 'View', icon: 'fit', keys: 'mod+0', when: in2d, run: () => { editor.fit(); renderZoom(); } });
command({ id: 'zoom100', title: 'Zoom to 100 %', group: 'View', keys: 'mod+1', when: in2d, run: () => { editor.zoomToPct(100); renderZoom(); } });
command({ id: 'lang', title: 'Switch drawing language (EN / JA)', group: 'View', icon: 'lang', keys: 'alt+l', run: () => {
  state.english = !state.english; store.set('lang', state.english ? 'en' : 'ja'); editor.setLanguage(state.english); renderLang(); renderLeftBody(); renderIndexStatus(); renderInspector();
  if (editor.doc) $('#sheetName').textContent = tr(editor.doc.name);
} });
$('#langBtn').onclick = () => runCommand('lang');
command({ id: 'palette', title: 'Command palette', group: 'Help', icon: 'command', keys: 'mod+k', run: openPalette });
$('#paletteBtn').onclick = openPalette;
command({ id: 'shortcuts', title: 'Keyboard shortcuts', group: 'Help', icon: 'keyboard', keys: '?', run: shortcutsDialog });
command({ id: 'find', title: 'Find tag / wire / address in the project', group: 'Navigate', icon: 'search', keys: ['mod+f', '/'], when: () => state.mode === '2d', run: () => $('#search').focus() });
command({ id: 'findText', title: 'Find text on this sheet', group: 'Edit', icon: 'search', when: in2d, run: () => findBar.open({ text: editor.selection.length === 1 ? (editor.selection[0].text || editor.selection[0].tag || null) : null }) });
command({ id: 'findReplace', title: 'Find and replace on this sheet', group: 'Edit', icon: 'replace', keys: 'mod+h', when: in2d, run: () => findBar.open({ replace: true, text: editor.selection.length === 1 ? (editor.selection[0].text || editor.selection[0].tag || null) : null }) });
command({ id: 'mode2d', title: 'Drawings workspace', group: 'Navigate', icon: 'sheet', keys: 'alt+1', run: () => setMode('2d') });
command({ id: 'mode3d', title: 'Panel 3D workspace', group: 'Navigate', icon: 'box3d', keys: 'alt+2', run: () => setMode('3d') });
command({ id: 'toggleLeft', title: 'Toggle left panel', group: 'View', icon: 'panel', keys: 'mod+b', run: () => { leftOpen = !leftOpen; $('#main').classList.toggle('no-left', !leftOpen || state.mode === '3d'); } });
command({ id: 'toggleRight', title: 'Toggle inspector', group: 'View', icon: 'panelR', keys: 'mod+.', run: () => { rightOpen = !rightOpen; $('#main').classList.toggle('no-right', !rightOpen); } });
command({ id: 'symbols', title: 'Show symbol library', group: 'Navigate', icon: 'lib', keys: 'alt+s', run: () => { setMode('2d'); setLeftTab('symbols'); $('#leftFilter')?.focus(); } });
command({ id: 'components', title: 'Show component catalogue', group: 'Navigate', icon: 'chip', keys: 'alt+c', run: () => { setMode('2d'); setLeftTab('components'); $('#leftFilter')?.focus(); } });
command({ id: 'newSheet', title: 'New sheet', group: 'Sheet', icon: 'plus', run: async () => {
  const name = await prompt('New sheet', 'New sheet', 'Create'); if (!name) return;
  const dr = state.drawings.find((d) => d.pages.some((p) => p.id === state.sheet));
  try {
    const r = await api(`/api/page/${encodeURIComponent(project())}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, drawing: dr?.file || 'custom', like: state.sheet }) });
    await refreshDrawings(); await openSheet(r.id); toast('Sheet created'); runCheck({ quiet: true });
  } catch (e) { toast(e.message, { kind: 'err' }); }
} });
command({ id: 'duplicateSheet', title: 'Duplicate sheet', group: 'Sheet', icon: 'copy', when: in2d, run: async () => {
  if (!(await guardUnsaved())) return;
  const name = await prompt('Duplicate sheet', `${tr(editor.doc.name)} (copy)`, 'Duplicate'); if (!name) return;
  const dr = state.drawings.find((d) => d.pages.some((p) => p.id === state.sheet));
  try {
    const r = await api(`/api/page/${encodeURIComponent(project())}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, drawing: dr?.file || 'custom', copyOf: state.sheet }) });
    await refreshDrawings(); await openSheet(r.id); toast('Sheet duplicated'); runCheck({ quiet: true });
  } catch (e) { toast(e.message, { kind: 'err' }); }
} });
command({ id: 'rename', title: 'Rename sheet', group: 'Sheet', icon: 'text', when: in2d, run: async () => {
  const name = await prompt('Rename sheet', tr(editor.doc.name), 'Rename'); if (!name || name === editor.doc.name) return;
  try { await editor.rename(name); $('#sheetName').textContent = tr(name); await refreshDrawings(); toast('Sheet renamed'); runCheck({ quiet: true }); } catch (e) { toast(e.message, { kind: 'err' }); }
} });
$('#sheetName').ondblclick = () => runCommand('rename');
command({ id: 'deleteSheet', title: 'Delete sheet', group: 'Sheet', icon: 'trash', when: () => in2d() && editor.doc.saved && !editor.doc.source, run: async () => {
  if (!(await confirmDialog('Delete this sheet?', `"${tr(editor.doc.name)}" will be moved out of the project (kept as a .deleted file).`, 'Delete', true))) return;
  try { await api(`/api/doc/${encodeURIComponent(project())}/${encodeURIComponent(state.sheet)}`, { method: 'DELETE' }); state.sheet = null; await refreshDrawings(); const first = state.drawings[0]?.pages[0]?.id; if (first) await openSheet(first, { force: true }); toast('Sheet deleted'); runCheck({ quiet: true }); } catch (e) { toast(e.message, { kind: 'err' }); }
} });
command({ id: 'export', title: 'Export sheet as SVG', group: 'Sheet', icon: 'download', when: in2d, run: () => {
  const blob = new Blob([editor.exportSvg()], { type: 'image/svg+xml' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${tr(editor.doc.name).replace(/[\\/:*?"<>|]+/g, '_')}.svg` });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
} });
command({ id: 'print', title: 'Print / save as PDF', group: 'Sheet', icon: 'print', keys: 'mod+p', when: in2d, run: () => {
  const d = editor.doc, w = window.open('', '_blank');
  if (!w) { toast('Allow pop-ups to print', { kind: 'err' }); return; }
  w.document.write(`<!doctype html><title>${esc(tr(d.name))}</title><style>@page{size:${d.widthMm}mm ${d.heightMm}mm;margin:0}html,body{margin:0}svg{width:${d.widthMm}mm;height:${d.heightMm}mm;display:block}</style>${editor.exportSvg()}`);
  w.document.close(); w.onload = () => { w.focus(); w.print(); };
} });
command({ id: 'door', title: 'Open / close door', group: '3D', icon: 'door', keys: 'o', when: in3d, run: () => { panel3d.toggleDoor(); setTimeout(renderToolbar, 50); } });
command({ id: 'xray', title: 'X-ray', group: '3D', icon: 'xray', keys: 'x', when: in3d, run: () => { panel3d.toggleXray(); renderToolbar(); } });
command({ id: 'labels', title: 'Labels', group: '3D', icon: 'tag', keys: 'l', when: in3d, run: () => { panel3d.toggleLabels(); renderToolbar(); } });
command({ id: 'wires3d', title: 'Wires', group: '3D', icon: 'cable', keys: 'w', when: in3d, run: () => { panel3d.toggleWires(); renderToolbar(); } });
command({ id: 'fit3d', title: 'Fit 3D view', group: '3D', icon: 'fit', keys: 'Home', when: in3d, run: () => panel3d.fit() });
command({ id: 'projects', title: 'Switch project', group: 'Navigate', icon: 'panel', run: () => $('#projectBtn').click() });
// ---- reports (Excel)
function download(url) { const a = Object.assign(document.createElement('a'), { href: url, download: '' }); document.body.append(a); a.click(); a.remove(); }
command({ id: 'exportBom', title: 'Export bill of materials (Excel)', group: 'Reports', icon: 'download', when: () => !!project(), run: () => {
  download(`/api/export/${encodeURIComponent(project())}/bom.xlsx`);
  toast('Bill of materials exported — rows marked "check" need a look before ordering', { kind: 'ok', duration: 3200 });
} });
/** cabinet reports: ask which cabinet when there is more than one (menu at the Reports button) */
async function pickCabinet(what, go) {
  const cabs = await api('/api/cabinets/' + encodeURIComponent(project())).catch(() => []);
  if (!cabs.length) { toast(`No cabinet in this project yet — the ${what} is made per cabinet`, { kind: 'info' }); return; }
  if (cabs.length === 1) return go(cabs[0]);
  const a = document.querySelector('#toolbar [data-cmd=reports]') || $('#paletteBtn');
  menu(cabs.map((c) => ({ label: `Cabinet ${c}`, icon: 'box3d', run: () => go(c) })), { anchor: a });
}
const P = () => encodeURIComponent(project());
command({ id: 'exportWires', title: 'Export wire list (Excel)…', group: 'Reports', icon: 'cable', when: () => !!project(), run: () => pickCabinet('wire list', (c) => { download(`/api/export/${P()}/wires/${encodeURIComponent(c)}.xlsx`); toast(`Wire list of ${c} exported`, { kind: 'ok', duration: 1800 }); }) });
command({ id: 'exportTerminals', title: 'Export terminal plan (Excel)…', group: 'Reports', icon: 'download', when: () => !!project(), run: () => pickCabinet('terminal plan', (c) => { download(`/api/export/${P()}/terminals/${encodeURIComponent(c)}.xlsx`); toast(`Terminal plan of ${c} exported`, { kind: 'ok', duration: 1800 }); }) });
command({ id: 'printTerminals', title: 'Print terminal plan…', group: 'Reports', icon: 'print', when: () => !!project(), run: () => pickCabinet('terminal plan', async (c) => printTerminalPlan(await api(`/api/terminals/${P()}/${encodeURIComponent(c)}`), { project: project(), toast })) });
command({ id: 'printLabels', title: 'Print wire labels…', group: 'Reports', icon: 'tag', when: () => !!project(), run: () => pickCabinet('label list', async (c) => printLabels(await api(`/api/labels/${P()}/${encodeURIComponent(c)}`), { project: project(), toast })) });
command({ id: 'exportLabels', title: 'Export wire labels (CSV for label printers)…', group: 'Reports', icon: 'download', when: () => !!project(), run: () => pickCabinet('label list', (c) => { download(`/api/export/${P()}/labels/${encodeURIComponent(c)}.csv`); toast(`Labels of ${c} exported`, { kind: 'ok', duration: 1800 }); }) });
command({ id: 'reports', title: 'Reports…', group: 'Reports', icon: 'report', when: () => !!project(), run: () => {
  const a = document.querySelector('#toolbar [data-cmd=reports]');
  const r = (id) => () => runCommand(id);
  menu([
    { label: 'Bill of materials (Excel)', icon: 'download', run: r('exportBom') },
    '-',
    { label: 'Wire list (Excel)…', icon: 'cable', run: r('exportWires') },
    { label: 'Terminal plan (Excel)…', icon: 'download', run: r('exportTerminals') },
    { label: 'Terminal plan (print)…', icon: 'print', run: r('printTerminals') },
    '-',
    { label: 'Wire labels (print)…', icon: 'tag', run: r('printLabels') },
    { label: 'Wire labels (CSV)…', icon: 'download', run: r('exportLabels') },
  ], a ? { anchor: a } : { x: innerWidth / 2, y: 80 });
} });
command({ id: 'runCheck', title: 'Run electrical check', group: 'Check', icon: 'shield', keys: 'F7', when: () => !!project(), run: async () => { if (state.mode !== '2d') await setMode('2d'); if (!leftOpen) runCommand('toggleLeft'); if (state.leftTab !== 'checks') setLeftTab('checks'); await runCheck(); } });
command({ id: 'checks', title: 'Show electrical check results', group: 'Check', icon: 'shield', when: () => !!project(), run: async () => { if (state.mode !== '2d') await setMode('2d'); if (!leftOpen) runCommand('toggleLeft'); setLeftTab('checks'); } });
command({ id: 'nextIssue', title: 'Next check finding', group: 'Check', icon: 'alert', keys: 'shift+F7', when: () => !!state.check?.findings.length, run: () => {
  const order = state.check.findings.map((f, i) => i).filter((i) => state.check.findings[i].severity !== 'info');
  if (!order.length) return;
  const next = order[(order.indexOf(state.checkActive) + 1) % order.length];
  state.checkActive = next;
  const f = state.check.findings[next];
  state.checkOpen?.add(f.rule);
  if (state.leftTab === 'checks') renderChecks();
  goWhere(f.where?.[0]);
  toast(f.message, { kind: f.severity === 'error' ? 'err' : 'info', duration: 3000 });
} });

stage2d.addEventListener('contextmenu', (e) => {
  if (!editor.doc || editor.tool !== 'select') return;
  const id = editor.pickAt(e.clientX, e.clientY);
  const has = id != null || editor.selection.length > 0;
  const k = (c) => keyLabel([].concat(c)[0]);
  menu([
    { label: 'Cut', keys: k('mod+x'), disabled: !has, run: () => runCommand('cut') },
    { label: 'Copy', icon: 'copy', keys: k('mod+c'), disabled: !has, run: () => runCommand('copy') },
    { label: 'Paste', keys: k('mod+v'), run: () => runCommand('paste') },
    { label: 'Duplicate', keys: k('mod+d'), disabled: !has, run: () => runCommand('duplicate') },
    '-',
    { label: 'Rotate 90°', icon: 'rotate', keys: k('mod+r'), disabled: !has, run: () => runCommand('rotate') },
    { label: 'Flip horizontal', keys: k('shift+h'), disabled: !has, run: () => runCommand('flip') },
    { label: 'Bring to front', icon: 'front', keys: k('mod+]'), disabled: !has, run: () => runCommand('front') },
    { label: 'Send to back', icon: 'back', keys: k('mod+['), disabled: !has, run: () => runCommand('back') },
    editor.selectionGroup() != null || editor.selection.some((x) => x.group != null)
      ? { label: 'Ungroup', icon: 'ungroup', keys: k('mod+shift+g'), run: () => runCommand('ungroup') }
      : { label: 'Group', icon: 'group', keys: k('mod+g'), disabled: editor.selection.length < 2, run: () => runCommand('group') },
    '-',
    { label: 'Copy format', icon: 'paint', keys: k('mod+shift+c'), disabled: editor.selection.length !== 1, run: () => runCommand('copyStyle') },
    { label: 'Paste format', keys: k('mod+shift+v'), disabled: !has || !editor.hasStyleClip, run: () => runCommand('pasteStyle') },
    '-',
    { label: 'Save as symbol…', icon: 'lib', disabled: !has, run: () => runCommand('saveSymbol') },
    { label: 'Zoom to selection', icon: 'search', keys: k('shift+2'), disabled: !has, run: () => runCommand('zoomSel') },
    '-',
    { label: 'Delete', icon: 'trash', keys: 'Del', danger: true, disabled: !has, run: () => runCommand('delete') },
  ], { x: e.clientX, y: e.clientY });
});

addEventListener('beforeunload', (e) => { if (editor.dirty) { e.preventDefault(); e.returnValue = ''; } });

// ======================================================================== project
$('#projectBtn').onclick = (e) => menu(state.projects.map((p) => ({ label: p, icon: p === project() ? 'check' : 'panel', run: () => loadProject(p) })), { anchor: e.currentTarget });
async function loadProject(p) {
  if (p === project()) return;
  if (!(await guardUnsaved())) return;
  state.project = p; store.set('project', p);
  $('#projectName').textContent = p;
  const [drawings, symbols, components, dict] = await Promise.all([
    api('/api/sheets/' + encodeURIComponent(p)), api('/api/symbols/' + encodeURIComponent(p)).catch(() => []),
    api('/api/components/' + encodeURIComponent(p)).catch(() => []), api('/api/i18n/' + encodeURIComponent(p)).catch(() => ({})),
  ]);
  Object.assign(state, { drawings, symbols, components, dict: buildDict(dict), xref: null, net: null, sheet: null, check: null, checkOpen: null, checkActive: null, checkAll: new Set() });
  renderCheckStatus();
  // part-number suggestions for symbols (shape data), from the component catalogue
  let dl = $('#partList'); if (!dl) { dl = document.createElement('datalist'); dl.id = 'partList'; document.body.append(dl); }
  dl.innerHTML = components.map((c) => `<option value="${esc(c.part)}">${esc([c.maker, c.category].filter(Boolean).join(' · '))}</option>`).join('');
  editor.setDict(state.dict); editor.setLanguage(state.english); editor.setSymbols(symbols);
  panel3d.reset();
  renderLeft();
  runCheck({ quiet: true });
  const want = qs.get('sheet') || store.get('sheet.' + p, drawings[0]?.pages[0]?.id);
  const exists = drawings.some((d) => d.pages.some((x) => x.id === want));
  const first = exists ? want : drawings[0]?.pages[0]?.id;
  if (first) await openSheet(first, { force: true }); else { stage2d.innerHTML = '<div class="empty-state"><div><div style="font-size:15px;color:var(--text-2);margin-bottom:6px">No sheets in this project yet</div><div class="mono">python -m ecad.cli import-visio &lt;folder&gt; projects/' + esc(p) + '</div></div></div>'; renderInspector(); }
}

// ======================================================================== boot
(async () => {
  state.projects = await api('/api/projects');
  setLeftTab(state.leftTab);
  slideIndicator($('#modeSeg'));
  renderToolbar(); renderStatusTool();
  if (!state.projects.length) {
    $('#projectName').textContent = 'No project';
    stage2d.innerHTML = '<div class="empty-state"><div><div style="font-size:15px;color:var(--text-2);margin-bottom:6px">No project yet</div><div class="mono">python -m ecad.cli import-visio &lt;folder-with-vsd&gt; projects/&lt;name&gt;</div></div></div>';
    document.body.dataset.ready = '1';
    return;
  }
  const want = qs.get('project') || store.get('project', state.projects[0]);
  await loadProject(state.projects.includes(want) ? want : state.projects[0]);
  if (qs.get('mode') === '3d') await setMode('3d');
  if (qs.has('key')) await showXref(qs.get('key').toUpperCase(), { jump: true });
  document.body.dataset.ready = '1';
})().catch((e) => { toast(e.message, { kind: 'err', duration: 8000 }); console.error(e); });

setInterval(() => { if (state.mode === '2d') renderIndexStatus(); }, 1500);

// read-only hooks for the browser tests
window.ecadDebug = { editor, panel3d, openSheet, showXref, setMode, get state() { return state; } };
