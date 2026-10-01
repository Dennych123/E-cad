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

  t('checks: the tab lists the findings; clicking one opens its sheet and frames the spot; the sheet shows issue badges', async () => {
    ready();
    await withApp('6451-M014', async (b) => {
      await b.eval(`document.querySelector('#leftTabs [data-tab="checks"]').click()`);
      await b.waitFor(`document.querySelectorAll('#leftBody .chk-f').length > 0`, 15000);
      const api = await (await fetch(`http://127.0.0.1:${PORT}/api/check/6451-M014`)).json();
      const sum = await b.eval(`[...document.querySelectorAll('#leftBody .chk-sum b')].map(e => +e.textContent)`);
      t.eq(sum, [api.summary.errors, api.summary.warnings, api.summary.info]);
      t.ok(await b.eval(`!document.querySelector('#stCheck').hidden`), 'status bar shows the check result');
      const i = api.findings.findIndex((f) => f.rule === 'relay.table-mismatch' && f.where?.[0]?.shape != null);
      t.ok(i >= 0, 'a contact-table finding with a location');
      await b.eval(`document.querySelector('#leftBody [data-f="${i}"]').click()`);
      await b.waitFor(`window.ecadDebug.state.sheet === ${JSON.stringify(api.findings[i].where[0].page)}`, 10000);
      await b.waitFor(`document.querySelectorAll('#stage2d .focus').length === 1`);
      t.ok(await b.eval(`document.querySelectorAll('#stage2d .issue.warning').length > 0`), 'issue badges on the sheet');
      t.eq(b.errors(), []);
    });
  });

  t('3D: every body panel has the enclosure size, and no component pokes out of the box', async () => {
    ready();
    await withApp('6451-M014', async (b) => {
      await b.eval(`window.ecadDebug.setMode('3d')`);
      await b.waitFor(`!!window.ecadDebug.panel3d.debug.model`, 15000);
      // expected sizes come from the project's own box template (its numbers stay out of this public repo)
      const r = await b.eval(`(async () => {
        const THREE = await import('three');
        const p = window.ecadDebug.panel3d, m = p.debug.model, faces = {}, out = [];
        const box = await (await fetch('/api/box/' + encodeURIComponent(p.boxId) + '?project=6451-M014')).json();
        const e = box.enclosure, W = e.width, D = e.depth, H = e.height, st = e.stand_height || 0;
        const tb = e.thickness?.body ?? 2, td = e.thickness?.door ?? e.thickness?.plate ?? tb;
        m.root.updateMatrixWorld(true);
        m.root.traverse((o) => {
          if (!o.isMesh) return;
          const bb = new THREE.Box3().setFromObject(o);
          const s = bb.getSize(new THREE.Vector3());
          if (o.userData.kind === 'body') faces[o.userData.face] = [s.x, s.y, s.z].map((v) => Math.round(v));
          if (o.userData.kind === 'component' && (bb.max.z > st + H - tb || bb.max.y > D - tb || bb.min.x < tb || bb.max.x > W - tb)) out.push(o.userData.tag);
        });
        const R = (a) => a.map((v) => Math.round(v));
        return { faces, out, want: { right: R([tb, D, H]), left: R([tb, D, H]), back: R([W, tb, H]), top: R([W, D, tb]), door: R([W, td, H]) } };
      })()`);
      for (const f of ['right', 'left', 'back', 'top', 'door']) t.eq(r.faces[f], r.want[f], `${f} panel size`);
      t.eq(r.out, [], 'components outside the enclosure');
    });
  });

  t('editor: resize a box by its handle, drag a wire segment, group, format both, undo', async () => {
    ready();
    const tp = tempProject();
    try {
      await withApp(tp.name, async (b) => {
        const G = 2.5 * 72 / 25.4, at = (x, y) => scr(b, x, y);
        const last = (n = 1) => b.eval(`${E}.doc.elements.slice(-${n})`);
        // rectangle by drag, then its south-east handle 4 grid steps right, 2 down
        await key(b, 'b');
        await drag(b, ...(await at(1020, 980)), ...(await at(1020 + 10 * G, 980 + 6 * G)));
        const [r0] = await last();
        t.eq(r0.kind, 'rect');
        await key(b, 'v');
        await drag(b, ...(await at(r0.x + r0.w, r0.y + r0.h)), ...(await at(r0.x + r0.w + 4 * G, r0.y + r0.h + 2 * G)));
        const [r1] = await last();
        t.near(r1.w, r0.w + 4 * G, 0.6, `width ${r0.w} -> ${r1.w}`); t.near(r1.h, r0.h + 2 * G, 0.6, `height ${r0.h} -> ${r1.h}`);
        t.eq([r1.x, r1.y], [r0.x, r0.y], 'the opposite corner stays');
        // wire: drag the middle of a straight wire down: it becomes a U and both ends stay on their spots
        await key(b, 'w');
        const [p1, p2] = [await at(1020, 1120), await at(1020 + 12 * G, 1120)];
        await b.click(...p1); await b.click(...p2); await key(b, 'Enter'); await key(b, 'v');
        const w0 = await b.eval(`(() => { const e = ${E}.doc.elements.at(-1); ${E}.select([e.id]); return e.pts; })()`);
        t.eq(w0.length, 2);
        const mx = (w0[0][0] + w0[1][0]) / 2, my = w0[0][1];
        await drag(b, ...(await at(mx, my)), ...(await at(mx, my + 3 * G)));
        const [w1] = await last();
        t.eq(w1.pts.length, 4, JSON.stringify(w1.pts)); t.eq(w1.pts[0], w0[0]); t.eq(w1.pts[3], w0[1]);
        t.near(w1.pts[1][1] - w0[0][1], 3 * G, 0.6);
        // group the two; a click on the wire then selects both
        await b.eval(`${E}.select(${E}.doc.elements.slice(-2).map(e => e.id))`);
        await key(b, 'g', 2);
        const g = (await last(2)).map((e) => e.group);
        t.ok(g[0] != null && g[0] === g[1], 'grouped: ' + g);
        await key(b, 'Escape');
        await b.click(...(await at(mx, my + 3 * G)));
        t.eq(await b.eval(`${E}.selection.length`), 2, 'a click selects the whole group');
        // format both from the inspector, then undo it
        const setStyle = (k, v) => b.eval(`(() => { const i = document.querySelector('#inspector [data-style=${k}]'); i.value = '${v}'; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await setStyle('stroke', '#1a4d8f'); await sleep(300); await setStyle('dash', 'dash'); await sleep(300);
        t.eq((await last(2)).map((e) => [e.stroke, e.dash]), [['#1a4d8f', 'dash'], ['#1a4d8f', 'dash']]);
        await key(b, 'z', 2); await key(b, 'z', 2);
        t.eq((await last(2)).map((e) => `${e.stroke}|${e.dash || ''}`), ['#000|', '#000|']);
        t.eq(b.errors(), []);
      });
    } finally { tp.dispose(); }
  });

  t('editor: find and replace on a sheet (Ctrl+H), replace all is one undo step', async () => {
    ready();
    const tp = tempProject();
    try {
      await withApp(tp.name, async (b) => {
        const n0 = await b.eval(`${E}.findText('INPUT UNIT').length`);
        t.ok(n0 > 0, 'the PLC sheet has INPUT UNIT headers');
        await key(b, 'h', 2);
        await b.waitFor(`!!document.querySelector('.findbar:not([hidden])') && document.activeElement?.dataset.f === 'find'`);
        await b.send('Input.insertText', { text: 'INPUT UNIT' });
        await sleep(250);
        t.eq(await b.eval(`document.querySelector('.fr-count').textContent`), `1 of ${n0}`);
        t.eq(await b.eval(`document.querySelectorAll('#stage2d .focus').length`), 1, 'current match framed');
        await b.eval(`document.querySelector('.findbar [data-f=rep]').focus()`);
        await b.send('Input.insertText', { text: 'INPUT MODULE' });
        await b.eval(`document.querySelector('.findbar [data-act=all]').click()`);
        await sleep(300);
        t.eq(await b.eval(`${E}.findText('INPUT MODULE').length`), n0);
        t.eq(await b.eval(`document.querySelector('.fr-count').textContent`), 'No results');
        await b.eval(`document.activeElement.blur()`);
        await key(b, 'z', 2);
        t.eq(await b.eval(`${E}.findText('INPUT UNIT').length`), n0, 'one undo restores every replacement');
        t.eq(b.errors(), []);
      });
    } finally { tp.dispose(); }
  });

  t('editor: number the wires drawn on a sheet; the numbers become the nets\' labels; numbered nets are kept', async () => {
    ready();
    const tp = tempProject();
    try {
      await withApp(tp.name, async (b) => {
        const G = 2.5 * 72 / 25.4, at = (x, y) => scr(b, x, y);
        await key(b, 'w');
        for (const y of [1000, 1060]) { await b.click(...(await at(1020, y))); await b.click(...(await at(1020 + 14 * G, y))); await key(b, 'Enter'); }
        await key(b, 'v'); await sleep(250);
        const r1 = await b.eval(`${E}.numberWires({ scheme: 'seq', prefix: 'W', start: 1, digits: 3 })`);
        t.eq(r1, { count: 2, names: ['W001', 'W002'] }, 'reading order: upper wire first');
        await sleep(300);
        const nets = await b.eval(`(() => { const ix = ${E}.index; return ['W001', 'W002'].map((k) => ix.texts.some((t) => t.keys.includes(k))); })()`);
        t.eq(nets, [true, true], 'numbers are indexed');
        await b.eval(`${E}.select([${E}.doc.elements.find((e) => e.kind === 'wire').id])`);
        await b.waitFor(`window.ecadDebug.state.net?.labels.includes('W001')`, 3000);
        t.eq(await b.eval(`${E}.numberWires({ scheme: 'seq', prefix: 'W', start: 1, digits: 3 }, { dryRun: true }).count`), 0, 'numbered nets are kept');
        t.eq((await b.eval(`${E}.numberWires({ scheme: 'seq', prefix: 'X', start: 5, digits: 2, renumber: true })`)).names, ['X05', 'X06'], 'renumber redoes the automatic ones');
        t.eq(await b.eval(`${E}.doc.elements.filter((e) => e.auto === 'wireno').map((e) => e.text)`), ['X05', 'X06']);
        t.eq(b.errors(), []);
      });
    } finally { tp.dispose(); }
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
