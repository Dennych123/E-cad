// Shared UI pieces: toasts, tooltips, menus, dialogs, command palette, keyboard shortcuts.
// Motion follows styles.css: CSS transitions (interruptible), nothing keyboard-invoked animates.
import { icon } from '/web/icons.js';

export const $ = (s, r = document) => r.querySelector(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const isMac = /Mac/.test(navigator.platform);
export const modKey = isMac ? '⌘' : 'Ctrl';

// ---------------------------------------------------------------- toasts
const toastHost = Object.assign(document.createElement('div'), { className: 'toasts' });
document.body.append(toastHost);
export function toast(message, { kind = 'ok', action = null, duration = 3500 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  el.innerHTML = `${icon(kind === 'err' ? 'alert' : kind === 'info' ? 'info' : 'check')}<span>${esc(message)}</span>`;
  if (action) {
    const b = Object.assign(document.createElement('button'), { className: 'btn solid act', textContent: action.label });
    b.onclick = () => { action.run(); close(); };
    el.append(b);
  }
  toastHost.append(el);
  let t = null, left = duration;
  let started = Date.now();
  const arm = () => { started = Date.now(); t = setTimeout(close, left); };
  // pause while hovered or while the tab is hidden: a message nobody saw did not get read
  el.onpointerenter = () => { clearTimeout(t); left -= Date.now() - started; };
  el.onpointerleave = arm;
  const vis = () => { if (document.hidden) { clearTimeout(t); left -= Date.now() - started; } else arm(); };
  document.addEventListener('visibilitychange', vis);
  function close() {
    clearTimeout(t); document.removeEventListener('visibilitychange', vis);
    el.dataset.leaving = '';
    setTimeout(() => el.remove(), 160);
  }
  arm();
  return close;
}

// ---------------------------------------------------------------- tooltips
// First hover waits 500 ms; while one was visible in the last 600 ms, the next opens instantly.
const tip = Object.assign(document.createElement('div'), { className: 'tooltip' });
tip.dataset.state = 'closed';
document.body.append(tip);
let tipTimer = null, lastTipClose = 0, tipFor = null;
function showTip(target) {
  const label = target.dataset.tip, keys = target.dataset.keys;
  tip.innerHTML = `<span>${esc(label)}</span>${keys ? keys.split(' ').map((k) => `<kbd>${esc(k)}</kbd>`).join('') : ''}`;
  const r = target.getBoundingClientRect();
  const below = r.bottom + 40 < innerHeight;
  tip.style.left = Math.min(innerWidth - 8 - tip.offsetWidth, Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2)) + 'px';
  tip.style.top = (below ? r.bottom + 6 : r.top - tip.offsetHeight - 6) + 'px';
  tip.style.setProperty('--origin', below ? 'top center' : 'bottom center');
  const instant = Date.now() - lastTipClose < 600;
  if (instant) tip.dataset.instant = ''; else delete tip.dataset.instant;
  tip.dataset.state = 'open';
  tipFor = target;
}
function hideTip() {
  clearTimeout(tipTimer);
  if (tip.dataset.state === 'open') lastTipClose = Date.now();
  tip.dataset.state = 'closed';
  tipFor = null;
}
document.addEventListener('pointerover', (e) => {
  const t = e.target.closest?.('[data-tip]');
  if (!t || t === tipFor) return;
  clearTimeout(tipTimer);
  if (Date.now() - lastTipClose < 600 || tip.dataset.state === 'open') showTip(t);
  else tipTimer = setTimeout(() => showTip(t), 500);
});
document.addEventListener('pointerout', (e) => { const t = e.target.closest?.('[data-tip]'); if (t && !t.contains(e.relatedTarget)) hideTip(); });
document.addEventListener('pointerdown', hideTip, true);

// ---------------------------------------------------------------- menus
let openMenu = null;
export function menu(items, { x, y, anchor = null } = {}) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'menu'; m.setAttribute('role', 'menu'); m.dataset.state = 'closed';
  for (const it of items) {
    if (it === '-') { m.append(document.createElement('hr')); continue; }
    const b = document.createElement('button');
    b.setAttribute('role', 'menuitem');
    b.innerHTML = `${it.icon ? icon(it.icon) : '<span style="width:15px"></span>'}<span>${esc(it.label)}</span>${it.keys ? `<kbd>${esc(it.keys)}</kbd>` : ''}`;
    if (it.danger) b.style.color = 'var(--danger)';
    b.disabled = !!it.disabled;
    b.onclick = () => { closeMenu(); it.run(); };
    m.append(b);
  }
  document.body.append(m);
  if (anchor) { const r = anchor.getBoundingClientRect(); x = r.left; y = r.bottom + 4; }
  const left = Math.min(x, innerWidth - m.offsetWidth - 8), top = Math.min(y, innerHeight - m.offsetHeight - 8);
  m.style.left = left + 'px'; m.style.top = top + 'px';
  m.style.setProperty('--origin', `${x - left}px ${y - top}px`);         // grow from where it was asked for
  requestAnimationFrame(() => { m.dataset.state = 'open'; });
  openMenu = m;
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
  return m;
}
function outside(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }
// Escape closes an open menu before anything else sees the key
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openMenu) { e.preventDefault(); e.stopPropagation(); closeMenu(); } }, true);
export function closeMenu() {
  document.removeEventListener('pointerdown', outside, true);
  if (!openMenu) return;
  const m = openMenu; openMenu = null;
  m.dataset.state = 'closed';
  setTimeout(() => m.remove(), 160);
}

// ---------------------------------------------------------------- dialogs
export function dialog({ title, body = '', input = null, actions }) {
  return new Promise((resolve) => {
    const scrim = document.createElement('div');
    scrim.className = 'scrim center';
    scrim.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h3>${esc(title)}</h3>${body ? `<p>${esc(body)}</p>` : ''}${input !== null ? `<input type="text" value="${esc(input)}">` : ''}<div class="actions"></div></div>`;
    const acts = scrim.querySelector('.actions');
    const inp = scrim.querySelector('input');
    const done = (v) => { document.removeEventListener('keydown', key, true); scrim.remove(); resolve(v); };
    for (const a of actions) {
      const b = Object.assign(document.createElement('button'), { className: `btn ${a.primary ? 'primary' : a.danger ? 'solid danger' : 'solid'}`, textContent: a.label });
      b.onclick = () => done(inp ? (a.value === false ? null : inp.value) : a.value);
      acts.append(b);
    }
    const key = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(inp ? null : actions.find((a) => a.cancel)?.value ?? null); }
      if (e.key === 'Enter' && (inp ? document.activeElement === inp : true)) { e.preventDefault(); e.stopPropagation(); const p = actions.find((a) => a.primary); if (p) done(inp ? inp.value : p.value); }
    };
    document.addEventListener('keydown', key, true);
    scrim.onpointerdown = (e) => { if (e.target === scrim) done(inp ? null : actions.find((a) => a.cancel)?.value ?? null); };
    document.body.append(scrim);
    (inp || acts.querySelector('.primary') || acts.lastChild).focus();
    if (inp) inp.select();
  });
}
export const confirmDialog = (title, body, ok = 'Continue', danger = false) =>
  dialog({ title, body, actions: [{ label: 'Cancel', value: false, cancel: true }, { label: ok, value: true, primary: !danger, danger }] });
export const prompt = (title, value = '', ok = 'OK') =>
  dialog({ title, input: value, actions: [{ label: 'Cancel', value: false, cancel: true }, { label: ok, primary: true }] });

// ---------------------------------------------------------------- shortcuts + command palette
const commands = new Map();       // id -> {id, title, group, icon, keys, run, when}
export function command(c) { commands.set(c.id, c); return c; }
export function runCommand(id) { const c = commands.get(id); if (c && (!c.when || c.when())) c.run(); }

const norm = (e) => {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return `${e.ctrlKey || e.metaKey ? 'mod+' : ''}${e.shiftKey && e.key.length > 1 ? 'shift+' : ''}${e.shiftKey && e.key.length === 1 && /[a-z]/i.test(e.key) ? 'shift+' : ''}${e.altKey ? 'alt+' : ''}${k}`;
};
export function keyLabel(keys) {
  return keys.split('+').map((p) => (p === 'mod' ? modKey : p === 'shift' ? '⇧' : p === 'alt' ? (isMac ? '⌥' : 'Alt') : p.length === 1 ? p.toUpperCase() : p)).join(isMac ? '' : '+');
}
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || document.querySelector('.scrim')) return;
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  const k = norm(e);
  for (const c of commands.values()) {
    for (const key of [].concat(c.keys || [])) {
      if (key !== k) continue;
      if (typing && !key.startsWith('mod+')) continue;       // single keys never steal typing
      if (c.when && !c.when()) continue;
      e.preventDefault();
      c.run();
      return;
    }
  }
});

export function openPalette() {
  if (document.querySelector('.scrim')) return;
  closeMenu();
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.innerHTML = `<div class="palette" role="dialog" aria-label="Command palette"><input type="text" placeholder="Type a command or search…" aria-label="Command"><div class="list" role="listbox"></div></div>`;
  const input = scrim.querySelector('input'), list = scrim.querySelector('.list');
  let items = [], active = 0;
  const render = () => {
    const q = input.value.trim().toLowerCase();
    items = [...commands.values()].filter((c) => c.title && (!c.when || c.when()) && (!q || `${c.group} ${c.title}`.toLowerCase().includes(q)));
    active = Math.min(active, Math.max(0, items.length - 1));
    let grp = null;
    list.innerHTML = items.map((c, i) => {
      const head = c.group !== grp ? `<div class="grp">${esc((grp = c.group))}</div>` : '';
      const k = [].concat(c.keys || [])[0];
      return `${head}<div class="item" role="option" data-i="${i}" ${i === active ? 'data-active' : ''}>${c.icon ? icon(c.icon) : ''}<span class="t">${esc(c.title)}</span>${k ? `<kbd>${esc(keyLabel(k))}</kbd>` : ''}</div>`;
    }).join('') || '<div class="empty">No matching command</div>';
    list.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' });
  };
  const close = () => { scrim.remove(); };
  const go = (i) => { const c = items[i]; close(); if (c) c.run(); };
  input.oninput = () => { active = 0; render(); };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); go(active); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  };
  list.onclick = (e) => { const it = e.target.closest('[data-i]'); if (it) go(Number(it.dataset.i)); };
  scrim.onpointerdown = (e) => { if (e.target === scrim) close(); };
  document.body.append(scrim);
  render();
  input.focus();
}

export function shortcutsDialog() {
  const rows = [...commands.values()].filter((c) => c.title && c.keys).map((c) => `<span>${esc(c.title)}</span><span>${[].concat(c.keys).map((k) => `<kbd>${esc(keyLabel(k))}</kbd>`).join(' ')}</span>`).join('');
  const scrim = document.createElement('div');
  scrim.className = 'scrim center';
  scrim.innerHTML = `<div class="dialog" style="width:min(560px,92vw)"><h3>Keyboard shortcuts</h3><div class="shortcuts">${rows}</div><div class="actions"><button class="btn primary">Done</button></div></div>`;
  const close = () => { scrim.remove(); document.removeEventListener('keydown', key, true); };
  const key = (e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener('keydown', key, true);
  scrim.querySelector('button').onclick = close;
  scrim.onpointerdown = (e) => { if (e.target === scrim) close(); };
  document.body.append(scrim);
}

// ---------------------------------------------------------------- tabs / segmented indicator
export function slideIndicator(container) {
  const ind = container.querySelector('.ind');
  const sel = container.querySelector('[aria-selected=true]');
  if (!ind || !sel) return;
  ind.style.width = sel.offsetWidth + 'px';
  ind.style.transform = `translateX(${sel.offsetLeft}px)`;
}
