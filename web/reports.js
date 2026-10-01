// Printable reports in their own window: terminal plan and wire marking labels. Each page carries a small
// screen-only bar (label size, print); the paper shows only the report.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function page(title, css, body, script = '') {
  const o = location.origin;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
@font-face { font-family: 'Plex Sans'; font-weight: 400; src: url(${o}/vendor/fonts/plex-sans/ibm-plex-sans-latin-400-normal.woff2) format('woff2'); }
@font-face { font-family: 'Plex Sans'; font-weight: 600; src: url(${o}/vendor/fonts/plex-sans/ibm-plex-sans-latin-600-normal.woff2) format('woff2'); }
@font-face { font-family: 'Plex Mono'; font-weight: 500; src: url(${o}/vendor/fonts/plex-mono/ibm-plex-mono-latin-500-normal.woff2) format('woff2'); }
* { box-sizing: border-box; }
body { margin: 0; font: 11px/1.4 'Plex Sans', 'Segoe UI', sans-serif; color: #111; background: #e9e7e2; }
.sheet { background: #fff; margin: 16px auto; padding: 12mm; box-shadow: 0 2px 12px rgba(0,0,0,.15); }
.bar { position: sticky; top: 0; z-index: 2; display: flex; gap: 10px; align-items: center; padding: 8px 16px; background: #1a1e22; color: #e8eaed; font-size: 12px; }
.bar button, .bar select { font: inherit; height: 28px; padding: 0 10px; border-radius: 5px; border: 1px solid #353c44; background: #262c32; color: #e8eaed; cursor: pointer; }
.bar button.primary { background: #ff7a1a; border-color: #ff7a1a; color: #1c0d02; font-weight: 600; }
.bar .sp { flex: 1; }
h1 { font-size: 15px; margin: 0 0 2px; font-weight: 600; }
.meta { color: #555; margin-bottom: 10px; }
.mono { font-family: 'Plex Mono', Consolas, monospace; }
${css}
@media print { body { background: #fff; } .bar { display: none; } .sheet { margin: 0; padding: 0; box-shadow: none; } }
</style></head><body>${body}${script ? `<script>${script}<\/script>` : ''}</body></html>`;
}

function openWindow(html, toast) {
  const w = window.open('', '_blank');
  if (!w) { toast?.('Allow pop-ups to open the report', { kind: 'err' }); return null; }
  w.document.write(html);
  w.document.close();
  return w;
}

/** terminal plan: one table per strip; a bracket joins bridged neighbours */
export function printTerminalPlan(plan, { project, toast }) {
  const date = new Date().toISOString().slice(0, 10);
  const strips = plan.strips.map((s) => `
    <section class="strip"><h2><span class="mono">${esc(s.tag)}</span>${s.part ? ` <span class="part mono">${esc(s.part)}</span>` : ''} <span class="n">${s.terminals.length} terminals</span></h2>
    <table><thead><tr><th>Up wire</th><th class="br"></th><th class="pos">Pos</th><th class="br"></th><th>Down wire</th><th>Connects to</th></tr></thead><tbody>
    ${s.terminals.map((t, i) => {
      const prev = s.terminals[i - 1];
      const bu = `${prev?.bridgeUp ? 'top' : ''} ${t.bridgeUp ? 'bot' : ''}`, bd = `${prev?.bridgeDown ? 'top' : ''} ${t.bridgeDown ? 'bot' : ''}`;
      return `<tr><td class="mono w">${esc(t.up || '')}</td><td class="br ${bu}"></td><td class="pos mono">${t.pos}</td><td class="br ${bd}"></td><td class="mono w">${esc(t.down || '')}</td>
        <td class="to">${t.links.map((l) => `<span>${l.wire ? `<b class="mono">${esc(l.wire)}</b> → ` : ''}${esc(l.to)}</span>`).join('')}</td></tr>`;
    }).join('')}
    </tbody></table></section>`).join('');
  const css = `
.sheet { width: 287mm; }
h2 { font-size: 13px; margin: 14px 0 6px; display: flex; gap: 8px; align-items: baseline; }
h2 .part { color: #555; font-weight: 400; } h2 .n { color: #888; font-weight: 400; font-size: 11px; }
table { border-collapse: collapse; width: 100%; }
th { text-align: left; font-weight: 600; color: #555; border-bottom: 1.5px solid #111; padding: 3px 6px; }
td { border-bottom: 1px solid #ddd; padding: 3px 6px; vertical-align: top; }
td.w { width: 70px; font-size: 12px; } td.pos, th.pos { width: 40px; text-align: center; background: #f3f2ee; }
td.br, th.br { width: 10px; padding: 0; position: relative; border-bottom-color: transparent; }
td.br.bot::after, td.br.top::before { content: ''; position: absolute; left: 4px; width: 2px; background: #e8590c; }
td.br.bot::after { top: 50%; bottom: 0; } td.br.top::before { top: 0; height: 50%; }
td.br.bot:not(.top)::before, td.br.top:not(.bot)::after { content: none; }
td.to span { display: inline-block; margin-right: 12px; }
tr { break-inside: avoid; }
@page { size: A4 landscape; margin: 10mm; }`;
  const body = `<div class="bar"><b>Terminal plan</b><span>${esc(project)} · cabinet ${esc(plan.cabinet)}</span><span class="sp"></span><button class="primary" onclick="print()">Print / PDF</button></div>
    <div class="sheet"><h1>Terminal plan — cabinet ${esc(plan.cabinet)}</h1><div class="meta">${esc(project)} · ${date} · wire numbers from the cabinet layout; connections from the drawings and the module cables · an orange bracket = bridge to the next terminal</div>
    ${strips || '<p>This cabinet has no terminal strips.</p>'}</div>`;
  return openWindow(page(`Terminal plan ${plan.cabinet}`, css, body), toast);
}

/** wire marking labels on a grid; the size is picked on the page (sticky) */
export function printLabels(data, { project, toast }) {
  const date = new Date().toISOString().slice(0, 10);
  const css = `
.sheet { width: 210mm; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, var(--w)); gap: 2mm; }
.lab { width: var(--w); height: var(--h); border: 0.2mm solid #999; border-radius: 1mm; display: flex; flex-direction: column; align-items: center; justify-content: center; overflow: hidden; break-inside: avoid; }
.lab .m { font-family: 'Plex Mono', Consolas, monospace; font-weight: 500; font-size: var(--fs); line-height: 1.05; white-space: nowrap; }
.lab .a { font-size: calc(var(--fs) * .42); color: #555; white-space: nowrap; max-width: 96%; overflow: hidden; text-overflow: ellipsis; }
.warn { margin: 10px 0 0; padding: 6px 8px; background: #fff4e5; border-left: 3px solid #e8590c; }
body.no-at .lab .a { display: none; }
@page { size: A4; margin: 8mm; }`;
  const labels = data.labels.map((l) => `<div class="lab" title="${esc(l.source)}"><div class="m">${esc(l.mark)}</div><div class="a">${esc(l.at)}</div></div>`).join('');
  const body = `<div class="bar"><b>Wire labels</b><span>${esc(project)} · cabinet ${esc(data.cabinet)} · ${data.labels.length} labels</span><span class="sp"></span>
      <label>Size <select id="size"><option value="25x8">25 × 8 mm</option><option value="30x10" selected>30 × 10 mm</option><option value="40x12">40 × 12 mm</option><option value="20x6">20 × 6 mm (tube)</option></select></label>
      <label><input type="checkbox" id="at" checked> Position</label>
      <button class="primary" onclick="print()">Print / PDF</button></div>
    <div class="sheet"><h1>Wire marking labels — cabinet ${esc(data.cabinet)}</h1><div class="meta">${esc(project)} · ${date} · one label per wire end · PLC wires are marked with their address (0000 00)</div>
    <div class="grid">${labels}</div>
    ${data.unnumbered.length ? `<div class="warn">Wires without a number (no label made): ${data.unnumbered.map(esc).join(', ')}</div>` : ''}</div>`;
  const script = `
const set = () => { const [w, h] = document.getElementById('size').value.split('x').map(Number); const r = document.documentElement.style;
  r.setProperty('--w', w + 'mm'); r.setProperty('--h', h + 'mm'); r.setProperty('--fs', Math.min(h * 0.55, w / 5) + 'mm'); };
document.getElementById('size').onchange = set; set();
document.getElementById('at').onchange = (e) => document.body.classList.toggle('no-at', !e.target.checked);`;
  return openWindow(page(`Wire labels ${data.cabinet}`, css, body, script), toast);
}
