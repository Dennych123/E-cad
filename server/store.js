// Reads the YAML library and projects from disk. Node only.
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { resolveBox } from '../lib/box.js';

export const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

const readYaml = (f) => yaml.load(fs.readFileSync(f, 'utf8')) ?? {};

/** id -> raw object for every *.yaml in the dirs; later dirs are overridden by earlier ones. */
export function readDir(...dirs) {
  const out = {};
  for (const d of [...dirs].reverse()) {
    if (!d || !fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (f.endsWith('.yaml')) out[f.slice(0, -5)] = { ...readYaml(path.join(d, f)), __file: path.join(d, f) };
  }
  return out;
}

export function createStore(root) {
  const lib = (k) => path.join(root, 'library', k);
  const proj = (p, k) => path.join(root, 'projects', p, k);
  const checkName = (n) => { if (!NAME_RE.test(n)) throw new Error('bad name: ' + n); return n; };

  return {
    projects() {
      const d = path.join(root, 'projects');
      return fs.existsSync(d) ? fs.readdirSync(d).filter((n) => fs.statSync(path.join(d, n)).isDirectory()) : [];
    },
    boxRaws(project) { return readDir(project ? proj(checkName(project), 'boxes') : null, lib('boxes')); },
    boxes(project) {
      const raws = this.boxRaws(project);
      return Object.keys(raws).sort().map((id) => {
        try {
          const t = resolveBox(id, raws);
          return { id, name: t.name, abstract: t.abstract, extends: t.extends ?? null, tags: t.tags, chain: t.chain,
                   kind: t.enclosure.kind, size: [t.enclosure.width, t.enclosure.height, t.enclosure.depth],
                   local: raws[id].__file.startsWith(path.join(root, 'projects')) };
        } catch (e) { return { id, error: e.message }; }
      });
    },
    box(id, project) { return resolveBox(checkName(id), this.boxRaws(project)); },
    cabinets(project) {
      const d = proj(checkName(project), 'cabinets');
      return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.yaml')).map((f) => f.slice(0, -5)) : [];
    },
    cabinet(project, id) {
      const f = path.join(proj(checkName(project), 'cabinets'), checkName(id) + '.yaml');
      return readYaml(f);
    },
    moduleRaws(project) { return readDir(project ? proj(checkName(project), 'modules') : null, lib('modules')); },
    /** part number (upper case) -> {model url, bbox, front, up} for parts that have a 3D model */
    parts() {
      const out = {};
      for (const [id, p] of Object.entries(readDir(lib('parts')))) {
        if (!p.model || !fs.existsSync(path.join(lib('parts'), p.model))) continue;
        out[String(p.part || id).toUpperCase()] = { model: '/library/parts/' + p.model, bbox: p.bbox || null, front: p.front || '-y', up: p.up || '+z' };
      }
      return out;
    },
  };
}
