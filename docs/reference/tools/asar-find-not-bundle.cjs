/* 定位 asar 内 "not-bundle" 判定逻辑：先列候选文件，再抽命中片段 */
const fs = require('fs');
const path = require('path');
const ASAR = 'D:\\DeepSeek\\resources\\app.asar';
const OUT = 'F:\\My Code\\dsh-context-pilot\\.data\\asar-out2';
const fd = fs.openSync(ASAR, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4);
const base = 8 + headerSize;
const headerJson = Buffer.alloc(head.readUInt32LE(12));
fs.readSync(fd, headerJson, 0, headerJson.length, 16);
const header = JSON.parse(headerJson.toString('utf8'));
const files = [];
(function walk(node, prefix) {
  if (node.files) { for (const [name, child] of Object.entries(node.files)) walk(child, prefix + '/' + name); }
  else files.push({ p: prefix, size: node.size, offset: node.offset });
})(header, '');

const RE = /plugin-manager|pluginManager|bundle|loader|composition|runner|inventory/i;
const candidates = files.filter((f) => RE.test(f.p) && /\.js$|\.mjs$|\.cjs$/.test(f.p) && f.size < 6_000_000);
console.log('candidates=' + candidates.length);

const HIT = /not-bundle/;
let hits = 0;
for (const f of candidates) {
  const buf = Buffer.alloc(f.size);
  fs.readSync(fd, buf, 0, f.size, base + Number(f.offset));
  const text = buf.toString('utf8');
  if (!HIT.test(text)) continue;
  hits++;
  const dest = path.join(OUT, f.p.replace(/\//g, '__'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  for (const m of text.matchAll(/not-bundle/g)) {
    const i = m.index;
    console.log('\n=== HIT ' + f.p + ' @' + i + ' ===');
    console.log(text.slice(Math.max(0, i - 500), i + 500).replace(/\n{2,}/g, '\n'));
  }
}
console.log('\ndone. files=' + files.length + ' candidates=' + candidates.length + ' hitFiles=' + hits);
fs.closeSync(fd);
