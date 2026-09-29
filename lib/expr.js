// "=expr" values in YAML. The language is the subset Python and JS read the same way:
// numbers, strings, + - * / % ( ), a.b, a[i], comparisons, and the functions below.
// Mirrors _EXPR_FUNCS in ecad/box/loader.py - keep the two lists identical.

export const EXPR_FUNCS = {
  min: Math.min, max: Math.max, abs: Math.abs,
  round: (x, n = 0) => { const f = 10 ** n; return Math.round(x * f) / f; },
  int: (x) => Math.trunc(Number(x)), float: (x) => Number(x),
  len: (x) => (x == null ? 0 : x.length), str: (x) => String(x),
  pick: (seq, i, def = null) => (i >= 0 && i < seq.length ? seq[i] : def),
};

const FORBIDDEN = /[;{}`]|=>|\b(function|new|this|constructor|__proto__|prototype|import|globalThis|window|process|require)\b/;
const cache = new Map();

/** Evaluate one expression (without the leading "=") against a scope object. */
export function evalExpr(src, scope) {
  // check the code only: string literals like 'CR{n}' may contain anything
  if (FORBIDDEN.test(src.replace(/'[^'\\]*'|"[^"\\]*"/g, "''"))) throw new Error(`expression not allowed: ${src}`);
  let fn = cache.get(src);
  if (!fn) {
    // sloppy-mode Function so `with` can expose scope keys as bare names
    fn = new Function('__s', `with (__s) { return (${src}); }`); // eslint-disable-line no-new-func
    cache.set(src, fn);
  }
  const s = Object.assign(Object.create(null), EXPR_FUNCS, scope);
  const v = fn(s);
  if (v === UNRESOLVED || v === undefined) throw new Error(`expression not ready: ${src}`);
  if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`expression gave ${v}: ${src}`);
  return v;
}

const isExpr = (v) => typeof v === 'string' && v.startsWith('=');
// An expression that reads a value still waiting for its own pass must fail, not concatenate:
// "=a" + 1 would silently become a string. A Symbol throws on any arithmetic or string use.
const UNRESOLVED = Symbol('unresolved');
const scopeOf = (node) => {
  if (Array.isArray(node)) return node.map(scopeOf);
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, scopeOf(v)]));
  return isExpr(node) ? UNRESOLVED : node;
};

/** Evaluate every "=expr" string in a tree, several passes so expressions may use each other.
 *  Names available: the top-level keys of `data` (plus `extra`). Returns a new tree. */
export function evalTree(data, extra = {}, maxPass = 10) {
  let out = structuredClone(data);
  for (let pass = 0; pass < maxPass; pass++) {
    const pending = [];
    const scope = scopeOf({ ...out, ...extra });
    const walk = (node) => {
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (v && typeof v === 'object') walk(v);
        else if (isExpr(v)) {
          try { node[k] = evalExpr(v.slice(1), scope); } catch (e) { pending.push(`${v} (${e.message})`); }
        }
      }
    };
    walk(out);
    if (!pending.length) return out;
    if (pass === maxPass - 1) throw new Error('unresolved expressions: ' + pending.join('; '));
  }
  return out;
}
