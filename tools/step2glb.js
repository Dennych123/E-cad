// Convert a maker's STEP model into a GLB the 3D panel view can load, keeping real size (mm).
//   node tools/step2glb.js <in.stp> [<out.glb>] [--part <P/N>] [--front -y] [--up +z]
// Writes <out.glb> and, with --part, library/parts/<P/N>.yaml pointing at it (bbox measured).
// OpenCASCADE (occt-import-js, WebAssembly) does the tessellation; no CAD install needed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import occtimportjs from 'occt-import-js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function stepToMeshes(file, { linearDeflection = 0.1 } = {}) {
  const occt = await occtimportjs();
  const res = occt.ReadStepFile(new Uint8Array(fs.readFileSync(file)), {
    linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: linearDeflection / 100,
    angularDeflection: 0.5,
  });
  if (!res.success) throw new Error('STEP read failed: ' + file);
  return res.meshes.filter((m) => m.index?.array?.length);
}

/** Minimal glTF 2.0 binary writer: one node per mesh, colour per mesh. */
export function meshesToGlb(meshes) {
  const bufs = [], bufferViews = [], accessors = [], materials = [], meshesJ = [], nodes = [];
  let offset = 0;
  const push = (typed, target) => {
    const b = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const pad = (4 - (b.length % 4)) % 4;
    bufs.push(b, Buffer.alloc(pad));
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: b.length, target });
    offset += b.length + pad;
    return bufferViews.length - 1;
  };
  const matIx = new Map();
  const bbox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  meshes.forEach((m, i) => {
    const pos = Float32Array.from(m.attributes.position.array);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < pos.length; k += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], pos[k + a]); max[a] = Math.max(max[a], pos[k + a]); }
    for (let a = 0; a < 3; a++) { bbox[a] = Math.min(bbox[a], min[a]); bbox[a + 3] = Math.max(bbox[a + 3], max[a]); }
    const attributes = { POSITION: accessors.push({ bufferView: push(pos, 34962), componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max }) - 1 };
    if (m.attributes.normal?.array?.length === pos.length) {
      attributes.NORMAL = accessors.push({ bufferView: push(Float32Array.from(m.attributes.normal.array), 34962), componentType: 5126, count: pos.length / 3, type: 'VEC3' }) - 1;
    }
    const idx = Uint32Array.from(m.index.array);
    const indices = accessors.push({ bufferView: push(idx, 34963), componentType: 5125, count: idx.length, type: 'SCALAR' }) - 1;
    const c = m.color || [0.7, 0.7, 0.72];
    const ck = c.map((v) => v.toFixed(3)).join(',');
    if (!matIx.has(ck)) matIx.set(ck, materials.push({ pbrMetallicRoughness: { baseColorFactor: [...c, 1], metallicFactor: 0.1, roughnessFactor: 0.6 }, doubleSided: true }) - 1);
    meshesJ.push({ name: m.name || `mesh${i}`, primitives: [{ attributes, indices, material: matIx.get(ck) }] });
    nodes.push({ mesh: i, name: m.name || `mesh${i}` });
  });
  const json = { asset: { version: '2.0', generator: 'ecad-code step2glb' }, scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes, meshes: meshesJ, materials, accessors, bufferViews, buffers: [{ byteLength: offset }] };
  let js = Buffer.from(JSON.stringify(json));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(bufs);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  return { glb: Buffer.concat([head, ch(js.length, 0x4e4f534a), js, ch(bin.length, 0x004e4942), bin]), bbox };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
  const part = opt('--part', null), front = opt('--front', '-y'), up = opt('--up', '+z');
  const [inp, outArg] = args;
  if (!inp) { console.error('usage: node tools/step2glb.js <in.stp> [out.glb] [--part P/N] [--front -y] [--up +z]'); process.exit(2); }
  const safe = (part || path.basename(inp).replace(/\.(stp|step)$/i, '')).replace(/[^A-Za-z0-9_.-]/g, '_');
  const out = outArg || path.join(root, 'library', 'parts', '3d', safe + '.glb');
  const t0 = Date.now();
  const meshes = await stepToMeshes(inp);
  const { glb, bbox } = meshesToGlb(meshes);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, glb);
  const size = [bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2]].map((v) => +v.toFixed(1));
  console.log(`${path.basename(inp)} -> ${out}  ${meshes.length} meshes, ${(glb.length / 1e6).toFixed(1)} MB, bbox ${size.join(' x ')} mm, ${Date.now() - t0} ms`);
  if (part) {
    const y = path.join(root, 'library', 'parts', safe + '.yaml');
    fs.writeFileSync(y, `# ${part}: 3D model converted from ${path.basename(inp)}\npart: ${part}\nmodel: 3d/${path.basename(out)}\n`
      + `bbox: [${bbox.map((v) => +v.toFixed(2)).join(', ')}]   # model mm: xmin ymin zmin xmax ymax zmax\n`
      + `front: '${front}'   # model axis that faces out of the panel\nup: '${up}'      # model axis that points up\n`);
    console.log('wrote', y);
  }
}
