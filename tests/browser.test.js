// Real browser, real clicks (Edge/Chrome over CDP): the app must behave like a drawing tool.
// Editing tests run on a throw-away copy of one drawing, never on the real project.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, findBrowser } from './lib/cdp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'projects', '6451-M014');
const PORT = 7681;
const DRAW = '09_6451-M014-0000-0_PLC IO CIRCUIT DIAGRAM_OK';
const SHEET = `${DRAW}/p01`;
const E = 'window.ecadDebug.editor';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tempProject() {
  const name = `_t${process.pid}`;
  const dst = path.join(root, 'projects', name);
  fs.mkdirSync(path.join(dst, 'raw'), { recursive: true });
  fs.cpSync(path.join(SRC, 'raw', DRAW), path.join(dst, 'raw', DRAW), { recursive: true, filter: (f) => !/\.(png|vsdx)$/.test(f) });
  for (const d of ['i18n', 'symbols']) if (fs.existsSync(path.join(SRC, d))) fs.cpSync(path.join(SRC, d), path.join(dst, d), { recursive: true });
  return { name, dispose: () => fs.rmSync(dst, { recursive: true, force: true }) };
}

async function withApp(project, fn) {
  const srv = spawn(process.execPath, ['server/main.js', '--port', String(PORT)], { cwd: root, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/projects`); break; } catch { await sleep(100); } }
  const b = await launch({ width: 1720, height: 1000, port: 9341 });
  try {
    await b.goto(`http://127.0.0.1:${PORT}/web/index.html?project=${project}&sheet=${encodeURIComponent(SHEET)}`, 'document.body.dataset.ready === "1"', 30000);
    await fn(b);
  } finally { await b.close(); srv.kill(); }
}
const scr = (b, x, y) => b.eval(`(() => { const s = document.querySelector('#stage2d svg.sheet'); const p = s.createSVGPoint(); p.x=${x}; p.y=${y}; const q = p.matrixTransform(s.getScreenCTM()); return [q.x, q.y]; })()`);
const mouse = (b, type, x, y, buttons, clickCount = 1) => b.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount });
async function drag(b, x0, y0, x1, y1) {
  await mouse(b, 'mouseMoved', x0, y0, 0); await mouse(b, 'mousePressed', x0, y0, 1);
  for (let i = 1; i <= 8; i++) await mouse(b, 'mouseMoved', x0 + (x1 - x0) * i / 8, y0 + (y1 - y0) * i / 8, 1);
  await mouse(b, 'mouseReleased', x1, y1, 0); await sleep(250);
}
async function key(b, k, mods = 0) {
  const vk = k.length === 1 ? k.toUpperCase().charCodeAt(0) : { Enter: 13, Escape: 27, Delete: 46 }[k];
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, modifiers: mods, windowsVirtualKeyCode: vk });
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, modifiers: mods, windowsVirtualKeyCode: vk });
  await sleep(150);
}
const textCentre = (b, key_) => b.eval(`(() => { const t = ${E}.index.texts.find(t => t.key === '${key_}'); return [t.box[0]+t.box[2]/2, t.box[1]+t.box[3]/2]; })()`);

export default function (t) {
  const ready = () => {
    if (!findBrowser()) t.skip('no Edge/Chrome on this PC');
    if (!fs.existsSync(path.join(SRC, 'raw', DRAW))) t.skip('project 6451-M014 not imported (confidential, not in git)');
  };

  t('drawings: selecting CRPB1 lists coil L1005 + its contact table L1013, L1018, L11002', async () => {
    ready();
    await withApp('6451-M014', async (b) => {
      const [x, y] = await scr(b, ...(await textCentre(b, 'CRPB1')));
      await b.click(x, y);
      await b.eval(`document.querySelector('#inspector [data-key="CRPB1"]').click()`);
      await b.waitFor(`document.querySelectorAll('#inspector .occ').length > 0`);
      const lines = await b.eval(`[...document.querySelectorAll('#inspector .occ .ln')].map(e => e.textContent)`);
      for (const l of ['L1005', 'L1013', 'L1018', 'L11002']) t.ok(lines.includes(l), `missing ${l} in ${lines}`);
      t.eq(b.errors(), []);
    });
  });

  t('drawings: selecting the P24A bus lights its net, which stops at the contacts (not Z24A)', async () => {
    ready();
    await withApp('6451-M014', async (b) => {
      const seg = await b.eval(`(() => { let best=null; for (const s of ${E}.index.segs) { const L=Math.hypot(s[2]-s[0], s[3]-s[1]); if (Math.abs(s[0]-s[2])<0.5 && L>300 && (!best || s[0]<best[0])) best=s; } return best; })()`);
      const [x, y] = await scr(b, seg[0], (seg[1] + seg[3]) / 2);
      await b.click(x, y);
      await b.waitFor(`document.querySelectorAll('#inspector .chip.net').length > 0`);
      const labels = await b.eval(`[...document.querySelectorAll('#inspector .chip.net')].map(e => e.dataset.key)`);
      t.ok(labels.includes('P24A'), 'P24A on the net: ' + labels);
      t.ok(!labels.includes('Z24A'), 'Z24A must not be on the P24A net: ' + labels);
      t.ok(!labels.some((l) => l.startsWith('CH00')), 'net must stop at the contacts: ' + labels);
    });
  });

  t('drawings: double-clicking an L-number arrow jumps to that line on its own sheet', async () => {
    ready();
    await withApp('6451-M014', async (b) => {
      const [x, y] = await scr(b, ...(await textCentre(b, 'L3007')));
      await mouse(b, 'mouseMoved', x, y, 0);
      await mouse(b, 'mousePressed', x, y, 1, 1); await mouse(b, 'mouseReleased', x, y, 0, 1);
      await mouse(b, 'mousePressed', x, y, 1, 2); await mouse(b, 'mouseReleased', x, y, 0, 2);
      await b.waitFor(`${E}.doc.name === '202PB'`, 8000);
    });
  });

  t('editor: place a symbol, glue a wire to it, move it, undo, save, reload - and the index knows the new tag', async () => {
    ready();
    const tp = tempProject();
    try {
      await withApp(tp.name, async (b) => {
        await b.eval(`(() => { const s = window.ecadDebug.state.symbols.find(s => s.id === 'm-no-contact-a'); ${E}.startPlace(s, { tag: 'CR77' }); })()`);
        const [px, py] = await scr(b, 1100, 1000);
        await mouse(b, 'mouseMoved', px, py, 0); await sleep(80);
        await b.click(px, py); await key(b, 'Escape');
        const sym = await b.eval(`(() => { const e = ${E}.doc.elements.at(-1); return { kind: e.kind, tag: e.tag }; })()`);
        t.eq([sym.kind, sym.tag], ['symbol', 'CR77']);
        // wire from the right pin to the right
        await key(b, 'w');
        const pp = await b.eval(`(async () => { const m = await import('/lib/sheetdoc.js'); const e = ${E}.doc.elements.at(-1); return m.symPoint(e, e.pins[1].at); })()`);
        const [ax, ay] = await scr(b, ...pp), [bx, by] = await scr(b, pp[0] + 100, pp[1]);
        await b.click(ax, ay); await b.click(bx, by); await key(b, 'Enter'); await key(b, 'Escape');
        const wire0 = await b.eval(`JSON.stringify(${E}.doc.elements.at(-1).pts)`);
        t.ok(wire0.startsWith(JSON.stringify([pp]).slice(0, -1)), `wire should start on the pin: ${wire0} vs ${pp}`);
        // select the symbol and nudge it down: the wire end follows (glue)
        await b.eval(`${E}.select([${E}.doc.elements.at(-2).id])`);
        await key(b, 'ArrowDown'); await key(b, 'ArrowDown');
        const [w1, s1] = await b.eval(`(async () => { const m = await import('/lib/sheetdoc.js'); const els = ${E}.doc.elements; const s = els.at(-2); return [els.at(-1).pts, m.symPoint(s, s.pins[1].at)]; })()`);
        t.eq(w1[0], s1, 'wire end did not follow the pin');
        await key(b, 'z', 2);
        await key(b, 'z', 2);
        const back = await b.eval(`JSON.stringify(${E}.doc.elements.at(-1).pts)`);
        t.eq(back, wire0, 'undo twice should restore the wire');
        // save and reload
        await key(b, 's', 2);
        await b.waitFor(`!${E}.dirty && ${E}.doc.saved`, 8000);
        await b.goto(`http://127.0.0.1:${PORT}/web/index.html?project=${tp.name}&sheet=${encodeURIComponent(SHEET)}`, 'document.body.dataset.ready === "1"', 30000);
        t.ok(await b.eval(`${E}.doc.elements.some(e => e.tag === 'CR77')`), 'CR77 not saved');
        const x = await (await fetch(`http://127.0.0.1:${PORT}/api/xref/${tp.name}?key=CR77`)).json();
        t.eq(x.occurrences.length, 1, 'server index should see CR77 after save');
        t.eq(b.errors(), []);
      });
    } finally { tp.dispose(); }
  });
}
