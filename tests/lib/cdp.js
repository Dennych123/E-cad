// Minimal Chrome DevTools Protocol driver for Edge/Chrome, using Node's built-in WebSocket.
// Real clicks and screenshots for browser tests, with no playwright/puppeteer dependency.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
];

export function findBrowser() { return BROWSERS.find((b) => fs.existsSync(b)) || null; }

export async function launch({ width = 1600, height = 1000, port = 9333 } = {}) {
  const exe = findBrowser();
  if (!exe) throw new Error('no Edge/Chrome found');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecad-cdp-'));
  const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ }
  }
  if (!target) { proc.kill(); throw new Error('browser did not start'); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
    else if (msg.method) events.push(msg);
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable'); await send('Runtime.enable');

  const api = {
    send, events,
    async goto(url, readyExpr = 'document.body.dataset.ready === "1"', timeout = 20000) {
      await send('Page.navigate', { url });
      await api.waitFor(readyExpr, timeout);
    },
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async waitFor(expr, timeout = 10000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) { try { if (await api.eval(expr)) return true; } catch { /* page not ready */ } await new Promise((r) => setTimeout(r, 100)); }
      throw new Error('timeout waiting for ' + expr);
    },
    async click(x, y) {
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
        await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
      await new Promise((r) => setTimeout(r, 150));
    },
    async screenshot(file) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    },
    errors: () => events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text),
    async close() { try { await send('Browser.close'); } catch { /* already gone */ } ws.close(); proc.kill(); },
  };
  return api;
}
