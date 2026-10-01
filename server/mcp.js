#!/usr/bin/env node
// MCP server: the AI port into ecad projects. Read-only tools over the same project logic the web app
// uses (server/project.js). Transport: JSON-RPC 2.0 over stdio, one message per line.
//   claude mcp add ecad -- node server/mcp.js        (or the repo's .mcp.json)
// Nothing but protocol messages may go to stdout; diagnostics go to stderr.
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createProjectContext, RULES } from './project.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = createProjectContext(root);
const VERSION = '0.3.0';

const str = (description) => ({ type: 'string', description });
const projectArg = { project: str('Project folder name under projects/ (see ecad_projects)') };

const TOOLS = [
  { name: 'ecad_projects', description: 'List the ecad projects on this machine.', inputSchema: { type: 'object', properties: {} },
    run: () => ctx.projects() },
  { name: 'ecad_check', description: 'Run the electrical rule check on a project: shorts between supplies, joined protected branches, estimated branch load vs circuit protector, relay contacts vs relay poles, contact tables vs drawn contacts, coils missing or drawn twice, PLC addresses wired twice, loose wire ends, duplicate tags, panel devices missing from the drawings, untranslated text. Returns a summary, a checklist (one row per rule with pass/warning/error) and the findings with sheet/line locations.',
    inputSchema: { type: 'object', properties: { ...projectArg, severity: { type: 'string', enum: ['error', 'warning', 'info'], description: 'Only findings at least this severe' }, rule: str('Only this rule id') }, required: ['project'] },
    run: ({ project, severity, rule }) => {
      const r = ctx.check(project), rank = { info: 0, warning: 1, error: 2 };
      const findings = r.findings.filter((f) => (!severity || rank[f.severity] >= rank[severity]) && (!rule || f.rule === rule));
      return { summary: r.summary, checklist: r.checklist.map(({ id, title, status, count, help }) => ({ id, title, status, count, help })), findings, assumptions: r.assumptions };
    } },
  { name: 'ecad_rules', description: 'Describe every electrical check rule (id, severity, what it measures).', inputSchema: { type: 'object', properties: {} }, run: () => RULES },
  { name: 'ecad_sheets', description: 'List the drawings and their sheets (pages) of a project, with English names.', inputSchema: { type: 'object', properties: projectArg, required: ['project'] },
    run: ({ project }) => ctx.sheets(project).map((d) => ({ drawing: d.title, sheets: d.pages.map((p) => ({ id: p.id, name: p.nameEn, source: p.source, texts: p.texts })) })) },
  { name: 'ecad_sheet', description: 'Summarise one sheet: its line-number range, device tags, wire labels and PLC addresses found on it.',
    inputSchema: { type: 'object', properties: { ...projectArg, sheet: str('Sheet id from ecad_sheets') }, required: ['project', 'sheet'] },
    run: ({ project, sheet }) => {
      const p = ctx.index(project).pages.get(sheet);
      if (!p) throw new Error('no such sheet: ' + sheet);
      const keys = [...new Set(p.texts.flatMap((t) => t.keys))];
      return { id: sheet, lines: p.rows.length ? [p.rows[0].label, p.rows.at(-1).label] : null, texts: p.texts.length, wireSegments: p.segs.length,
        devices: keys.filter((k) => /^(CR|MC|PB|PL|SS|KS|LS|PS|SOL|CP|CB|BZ|SW|TB)[A-Z0-9]*\d/.test(k)).sort(),
        supplies: keys.filter((k) => /^[PZ]\d{2}[A-Z]?$/.test(k)).sort(), plcAddresses: keys.filter((k) => /^CH\d\d\.\d{3}$/.test(k)).sort(),
        references: keys.filter((k) => /^L\d{3,6}$/.test(k)).length };
    } },
  { name: 'ecad_xref', description: 'Cross-reference one identifier (relay tag like CRPB1, wire number like P24A, PLC address like CH00.004, line number like L1005): every place it appears, with sheet, line and role, plus panel locations.',
    inputSchema: { type: 'object', properties: { ...projectArg, key: str('Identifier to look up') }, required: ['project', 'key'] },
    run: ({ project, key }) => ctx.xref(project, key) },
  { name: 'ecad_search', description: 'Search identifiers in a project (substring).', inputSchema: { type: 'object', properties: { ...projectArg, query: str('At least two characters') }, required: ['project', 'query'] },
    run: ({ project, query }) => ctx.search(project, query) },
  { name: 'ecad_nets', description: 'Electrical nets of one sheet: connected wire segments with the labels on them and the devices they end at. Give a label (e.g. P24A) to get only the nets carrying it.',
    inputSchema: { type: 'object', properties: { ...projectArg, sheet: str('Sheet id'), label: str('Optional label filter') }, required: ['project', 'sheet'] },
    run: ({ project, sheet, label }) => ctx.nets(project, sheet, label) },
  { name: 'ecad_wires', description: 'From-to wire list of a cabinet derived from the drawings, routed through its ducts, with lengths.',
    inputSchema: { type: 'object', properties: { ...projectArg, cabinet: str('Cabinet id, e.g. 1CE') }, required: ['project', 'cabinet'] },
    run: ({ project, cabinet }) => { const w = ctx.wires(project, cabinet); return { ...w, wires: w.wires.map(({ id, no, from, to, line, route }) => ({ no, from: `${from.tag}${from.pin ? ':' + from.pin : ''}`, to: `${to.tag}${to.pin ? ':' + to.pin : ''}`, line, lengthMm: route?.ok ? route.length : null })) }; } },
  { name: 'ecad_components', description: 'Component catalogue of a project (part numbers with maker, category, tags using them).',
    inputSchema: { type: 'object', properties: { ...projectArg, query: str('Optional filter') }, required: ['project'] },
    run: ({ project, query }) => { const q = String(query || '').toLowerCase(); return ctx.catalog(project).filter((c) => !q || `${c.part} ${c.maker} ${c.category} ${c.tags.join(' ')}`.toLowerCase().includes(q)).map(({ part, maker, category, name, tags, footprint }) => ({ part, maker, category, name, tags, footprint })); } },
  { name: 'ecad_symbols', description: 'Symbol library of a project (names, categories, pin counts).',
    inputSchema: { type: 'object', properties: { ...projectArg, query: str('Optional filter') }, required: ['project'] },
    run: ({ project, query }) => { const q = String(query || '').toLowerCase(); return ctx.symbols(project).filter((s) => !q || `${s.name} ${s.category}`.toLowerCase().includes(q)).map(({ id, name, category, size, pins, count }) => ({ id, name, category, sizeMm: size, pins: pins.length, usedTimes: count })); } },
];

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params = {} } = msg;
  if (method === 'initialize') {
    return reply(id, { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'ecad', version: VERSION },
      instructions: 'Read-only access to ecad electrical projects. Start with ecad_projects, then ecad_check for problems or ecad_xref / ecad_nets to follow a signal. Locations are sheet ids plus Denso line numbers (L1005).' });
  }
  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return;   // notifications get no reply
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params.name);
    if (!tool) return fail(id, -32602, 'unknown tool: ' + params.name);
    try {
      const out = await tool.run(params.arguments || {});
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] });
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: 'error: ' + e.message }], isError: true });
    }
  }
  if (id !== undefined) fail(id, -32601, 'method not found: ' + method);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'parse error'); }
  Promise.resolve(handle(msg)).catch((e) => { process.stderr.write(String(e?.stack || e) + '\n'); if (msg.id !== undefined) fail(msg.id, -32603, e.message); });
});
process.stderr.write(`ecad MCP server ${VERSION} ready (${TOOLS.length} tools)\n`);
