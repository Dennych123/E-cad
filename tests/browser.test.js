// Real browser, real clicks (Edge/Chrome over CDP): the live drawing must behave like the paper one.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, findBrowser } from './lib/cdp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(root, 'projects', '6451-M014', 'raw');
const PORT = 7681;
const SHEET09 = '09_6451-M014-0000-0_PLC IO CIRCUIT DIAGRAM_OK/p01';

async function withApp(fn) {
  const srv = spawn(process.execPath, ['server/main.js', '--port', String(PORT)], { cwd: root, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/projects`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const b = await launch({ width: 1700, height: 1000, port: 9341 });
  try { await fn(b); } finally { await b.close(); srv.kill(); }
}
const scr = (b, x, y) => b.eval(`(() => { const s = document.querySelector('#sheet svg'); const p = s.createSVGPoint(); p.x=${x}; p.y=${y}; const q = p.matrixTransform(s.getScreenCTM()); return [q.x, q.y]; })()`);

export default function (t) {
  const ready = () => {
    if (!findBrowser()) t.skip('no Edge/Chrome on this PC');
    if (!fs.existsSync(RAW)) t.skip('project 6451-M014 not imported (raw/ is not in git: confidential drawings)');
  };

  t('drawings: CRPB1 cross-reference = coil L1005 + its contact table L1013, L1018, L11002', () => withApp(async (b) => {
    ready();
    await b.goto(`http://127.0.0.1:${PORT}/web/index.html?project=6451-M014&mode=2d&sheet=${encodeURIComponent(SHEET09)}&key=CRPB1`);
    await b.waitFor(`document.querySelectorAll('#occ tr').length > 0`);
    const lines = await b.eval(`[...document.querySelectorAll('#occ tr td:first-child')].map(td => td.textContent)`);
    for (const l of ['L1005', 'L1013', 'L1018', 'L11002']) t.ok(lines.includes(l), `missing ${l} in ${lines}`);
    t.eq(b.errors(), []);
  }));

  t('drawings: clicking the P24A bus lights its net and stops at the contacts (not Z24A)', () => withApp(async (b) => {
    ready();
    await b.goto(`http://127.0.0.1:${PORT}/web/index.html?project=6451-M014&mode=2d&sheet=${encodeURIComponent(SHEET09)}`);
    const seg = await b.eval(`(() => { let best=null; for (const s of window.ecadDebug.sheet.page.segs) { const L=Math.hypot(s[2]-s[0], s[3]-s[1]); if (Math.abs(s[0]-s[2])<0.5 && L>300 && (!best || s[0]<best[0])) best=s; } return best; })()`);
    const [x, y] = await scr(b, seg[0], (seg[1] + seg[3]) / 2);
    await b.click(x, y);
    const labels = await b.eval(`[...document.querySelectorAll('#net [data-k]')].map(e => e.dataset.k)`);
    t.ok(labels.includes('P24A'), 'P24A on the net: ' + labels);
    t.ok(!labels.includes('Z24A'), 'Z24A must not be on the P24A net: ' + labels);
    t.ok(!labels.some((l) => l.startsWith('CH00')), 'net must stop at the contacts, not reach the PLC inputs: ' + labels);
  }));

  t('drawings: clicking an L-number arrow jumps to that line on its own sheet', () => withApp(async (b) => {
    ready();
    await b.goto(`http://127.0.0.1:${PORT}/web/index.html?project=6451-M014&mode=2d&sheet=${encodeURIComponent(SHEET09)}`);
    const at = await b.eval(`(() => { const t = window.ecadDebug.sheet.page.texts.find(t => t.key === 'L3007'); return [t.box[0]+t.box[2]/2, t.box[1]+t.box[3]/2]; })()`);
    const [x, y] = await scr(b, ...at);
    await b.click(x, y);
    await b.waitFor(`window.ecadDebug.sheet.page.name === '202PB'`, 5000);
  }));
}
