// The AI port: the MCP server speaks JSON-RPC over stdio and answers from the same project logic.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const haveProject = () => fs.existsSync(path.join(root, 'projects', '6451-M014', 'raw'));

function client() {
  const p = spawn(process.execPath, ['server/mcp.js'], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
  const rl = readline.createInterface({ input: p.stdout });
  const waiting = new Map(), stray = [];
  rl.on('line', (l) => { const m = JSON.parse(l); if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } else stray.push(m); });
  let id = 0;
  const call = (method, params) => new Promise((res, rej) => {
    const i = ++id; waiting.set(i, res);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
    setTimeout(() => rej(new Error('timeout ' + method)), 30000);
  });
  const notify = (method, params) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  return { call, notify, stray, close: () => p.kill() };
}

export default function (t) {
  t('MCP: handshake, tool list, unknown method, bad tool', async () => {
    const c = client();
    try {
      const init = await c.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      t.eq(init.result.serverInfo.name, 'ecad');
      t.ok(init.result.capabilities.tools);
      c.notify('notifications/initialized', {});
      const list = await c.call('tools/list', {});
      const names = list.result.tools.map((x) => x.name);
      for (const n of ['ecad_projects', 'ecad_check', 'ecad_xref', 'ecad_nets', 'ecad_wires']) t.ok(names.includes(n), 'missing tool ' + n);
      t.ok(list.result.tools.every((x) => x.inputSchema?.type === 'object'));
      t.eq((await c.call('nope', {})).error.code, -32601);
      t.eq((await c.call('tools/call', { name: 'no_such_tool', arguments: {} })).error.code, -32602);
      const bad = await c.call('tools/call', { name: 'ecad_check', arguments: { project: '../etc' } });
      t.ok(bad.result.isError, 'path-like project names must be refused');
      t.eq(c.stray, [], 'notifications must not get a reply');
    } finally { c.close(); }
  });

  t('MCP: ecad_check and ecad_xref answer from the project', async () => {
    if (!haveProject()) t.skip('project 6451-M014 not on this PC (confidential, not in git)');
    const c = client();
    try {
      await c.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      const chk = JSON.parse((await c.call('tools/call', { name: 'ecad_check', arguments: { project: '6451-M014', severity: 'warning' } })).result.content[0].text);
      t.ok(chk.checklist.length >= 10 && typeof chk.summary.errors === 'number');
      t.ok(chk.findings.every((f) => f.severity !== 'info'), 'severity filter');
      const x = JSON.parse((await c.call('tools/call', { name: 'ecad_xref', arguments: { project: '6451-M014', key: 'crpb1' } })).result.content[0].text);
      t.ok(x.occurrences.some((o) => o.line === 'L11002'), 'CRPB1 at L11002');
    } finally { c.close(); }
  });
}
