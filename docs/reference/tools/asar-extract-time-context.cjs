/* 抽取 dsh-time-context 全部源码（M2 注入惯用法范例） */
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
const targets = files.filter((f) => f.p.includes('dsh-time-context'));
let n = 0;
for (const f of targets) {
  if (f.size > 8_000_000) continue;
  const buf = Buffer.alloc(f.size);
  fs.readSync(fd, buf, 0, f.size, base + Number(f.offset));
  const dest = path.join(OUT, f.p.replace(/\//g, '__'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  console.log('OK ' + f.size + 'B ' + f.p);
  n++;
}
console.log('done ' + n + ' files');
fs.closeSync(fd);
