// Tiny test runner, no framework. A SKIP always prints why; a silent skip looks like a pass.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const dir = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv[2];
let pass = 0, fail = 0, skip = 0;

class Skip extends Error {}
const t = Object.assign(
  (name, fn) => cases.push({ name, fn }),
  {
    eq: (a, b, msg) => assert.deepStrictEqual(a, b, msg),
    ok: (v, msg) => assert.ok(v, msg),
    near: (a, b, tol = 1e-6, msg) => assert.ok(Math.abs(a - b) <= tol, msg || `${a} != ${b} (tol ${tol})`),
    throws: (fn, re) => assert.throws(fn, re),
    skip: (why) => { throw new Skip(why); },
  },
);
let cases;

for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.test.js') && (!only || f.includes(only))).sort()) {
  cases = [];
  (await import(pathToFileURL(path.join(dir, f)))).default(t);
  for (const c of cases) {
    try { await c.fn(); pass++; console.log(`  ok    ${f} :: ${c.name}`); }
    catch (e) {
      if (e instanceof Skip) { skip++; console.log(`  SKIP  ${f} :: ${c.name} - ${e.message}`); }
      else { fail++; console.log(`  FAIL  ${f} :: ${c.name}\n        ${String(e.message).split('\n').join('\n        ')}`); }
    }
  }
}
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
