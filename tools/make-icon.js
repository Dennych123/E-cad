#!/usr/bin/env node
// Builds web/ecad.ico (desktop shortcut / favicon) from the app mark, rendered by headless Edge/Chrome.
//   node tools/make-icon.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../tests/lib/cdp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// same mark as the favicon in web/index.html: an orange tile with a signal trace
const MARK = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' rx='4' fill='#ff7a1a'/><path d='M2.5 11.5h3l1.5-7 2 9 1.5-5h3' fill='none' stroke='#1c0d02' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/></svg>`;
const SIZES = [16, 24, 32, 48, 64, 256];

const b = await launch({ width: 300, height: 300, port: 9341 });
try {
  const pngs = await b.eval(`(async () => {
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(MARK)});
    await img.decode();
    return ${JSON.stringify(SIZES)}.map((s) => {
      const c = document.createElement('canvas'); c.width = c.height = s;
      c.getContext('2d').drawImage(img, 0, 0, s, s);
      return c.toDataURL('image/png').split(',')[1];
    });
  })()`);
  const data = pngs.map((p) => Buffer.from(p, 'base64'));
  // ICO: 6-byte header, a 16-byte entry per image, then the PNG streams
  const head = Buffer.alloc(6 + 16 * data.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(data.length, 4);
  let offset = head.length;
  data.forEach((d, i) => {
    const e = 6 + 16 * i, s = SIZES[i] % 256;   // 256 is written as 0
    head.writeUInt8(s, e); head.writeUInt8(s, e + 1); head.writeUInt8(0, e + 2); head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6); head.writeUInt32LE(d.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += d.length;
  });
  const out = path.join(root, 'web', 'ecad.ico');
  fs.writeFileSync(out, Buffer.concat([head, ...data]));
  console.log(`${path.relative(root, out)}: ${SIZES.join(', ')} px, ${offset} bytes`);
} finally { await b.close(); }
