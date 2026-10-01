// Find & replace on the open sheet: a bar over the drawing (Ctrl+H), like a code editor's find widget.
// Enter / Shift+Enter step through the matches; every match is outlined, the current one framed.
import { icon } from '/web/icons.js';

export function createFindBar(stage, { editor, toast }) {
  let el = null, list = [], cur = -1;
  const opts = { matchCase: false, word: false };
  const $ = (s) => el.querySelector(s);

  function build() {
    el = document.createElement('div');
    el.className = 'findbar';
    el.setAttribute('role', 'search');
    el.hidden = true;
    el.innerHTML = `
      <div class="fr-row">
        <input type="text" class="mono" data-f="find" placeholder="Find on this sheet" aria-label="Find" spellcheck="false" autocomplete="off">
        <button class="ibtn tog" data-opt="matchCase" data-tip="Match case" aria-pressed="false" aria-label="Match case"><span class="mono">Aa</span></button>
        <button class="ibtn tog" data-opt="word" data-tip="Whole word" aria-pressed="false" aria-label="Whole word"><span class="mono">ab</span></button>
        <span class="fr-count" aria-live="polite"></span>
        <button class="ibtn" data-act="prev" data-tip="Previous match" data-keys="Shift+Enter" aria-label="Previous match">${icon('up')}</button>
        <button class="ibtn" data-act="next" data-tip="Next match" data-keys="Enter" aria-label="Next match">${icon('down')}</button>
        <button class="ibtn" data-act="close" data-tip="Close" data-keys="Esc" aria-label="Close">${icon('x')}</button>
      </div>
      <div class="fr-row" data-rep>
        <input type="text" class="mono" data-f="rep" placeholder="Replace with" aria-label="Replace with" spellcheck="false" autocomplete="off">
        <button class="btn solid" data-act="one" data-keys="Enter">Replace</button>
        <button class="btn solid" data-act="all" data-keys="Ctrl+Alt+Enter">Replace all</button>
      </div>`;
    stage.append(el);
    $('[data-f=find]').addEventListener('input', () => search(true));
    el.addEventListener('click', (e) => {
      const o = e.target.closest('[data-opt]');
      if (o) { opts[o.dataset.opt] = !opts[o.dataset.opt]; o.setAttribute('aria-pressed', String(opts[o.dataset.opt])); search(true); return; }
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (a === 'next') step(1); else if (a === 'prev') step(-1); else if (a === 'close') close();
      else if (a === 'one') replaceOne(); else if (a === 'all') replaceAll();
    });
    el.addEventListener('keydown', (e) => {
      e.stopPropagation();                                   // the sheet's single-key tools stay quiet while typing here
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Enter') { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h') { e.preventDefault(); toggleReplace(true); } return; }
      e.preventDefault();
      const inRep = e.target.dataset.f === 'rep';
      if (inRep && (e.ctrlKey || e.metaKey) && e.altKey) replaceAll();
      else if (inRep) replaceOne();
      else step(e.shiftKey ? -1 : 1);
    });
    // keep the drawing's pointer events: the bar only takes clicks on itself
    for (const t of ['pointerdown', 'dblclick', 'contextmenu', 'wheel']) el.addEventListener(t, (e) => e.stopPropagation());
  }

  const query = () => $('[data-f=find]').value;
  function render() {
    const n = list.length, fixed = list.filter((m) => !m.replaceable).length;
    const c = $('.fr-count');
    c.textContent = !query() ? '' : n ? `${cur + 1} of ${n}` : 'No results';
    c.title = fixed ? `${fixed} match(es) only in the English display; switch to JA (Alt+L) to edit the original text` : '';
    c.classList.toggle('none', !!query() && !n);
    for (const b of el.querySelectorAll('[data-act=prev],[data-act=next]')) b.disabled = n < 2;
    for (const b of el.querySelectorAll('[data-act=one],[data-act=all]')) b.disabled = !list.some((m) => m.replaceable);
  }
  function search(reveal) {
    const q = query();
    list = q ? editor.findText(q, opts) : [];
    cur = list.length ? Math.min(Math.max(cur, 0), list.length - 1) : -1;
    if (reveal && list.length) cur = 0;
    editor.showMatches(list, cur, reveal);
    render();
  }
  function step(d) {
    if (!list.length) return;
    cur = (cur + d + list.length) % list.length;
    editor.showMatches(list, cur, true);
    render();
  }
  function replaceOne() {
    const m = list[cur];
    if (!m) return;
    if (!m.replaceable) { toast?.('This match is in the English display only — switch to JA (Alt+L) to edit the original text', { kind: 'info', duration: 3200 }); step(1); return; }
    editor.replaceText(query(), $('[data-f=rep]').value, opts, [m]);
    // the replaced text drops out of the results; stay on the same index
    list = editor.findText(query(), opts);
    cur = list.length ? Math.min(cur, list.length - 1) : -1;
    editor.showMatches(list, cur, true);
    render();
  }
  function replaceAll() {
    const n = editor.replaceText(query(), $('[data-f=rep]').value, opts);
    toast?.(n ? `Replaced ${n} occurrence${n === 1 ? '' : 's'}` : 'Nothing to replace', { kind: n ? 'ok' : 'info', duration: 1800 });
    search(false);
  }
  function toggleReplace(on) { el.querySelector('[data-rep]').hidden = !on; if (on) $('[data-f=rep]').focus(); }

  function open({ replace = false, text = null } = {}) {
    if (!el) build();
    el.hidden = false;
    el.querySelector('[data-rep]').hidden = !replace;
    const f = $('[data-f=find]');
    if (text) f.value = text;
    f.focus(); f.select();
    search(!!f.value);
  }
  function close() {
    if (!el || el.hidden) return;
    el.hidden = true;
    list = []; cur = -1;
    editor.clearMarks();
    stage.focus({ preventScroll: true });
  }
  return {
    open, close,
    /** the sheet or its content changed: search again without moving the view */
    refresh() { if (el && !el.hidden) search(false); },
    get isOpen() { return !!el && !el.hidden; },
  };
}
