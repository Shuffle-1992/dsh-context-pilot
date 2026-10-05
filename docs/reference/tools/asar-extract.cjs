/* 第三轮：精准抽取关键文件 */
const fs = require('fs');
const path = require('path');
const ASAR = 'D:\\DeepSeek\\resources\\app.asar';
const OUT = 'F:\\My Code\\dsh-browser-kit\\plugin\\.data\\asar-out';
const fd = fs.openSync(ASAR, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4);
const base = 8 + headerSize;
const headerJson = Buffer.alloc(head.readUInt32LE(12));
fs.readSync(fd, headerJson, 0, headerJson.length, 16);
const header = JSON.parse(headerJson.toString('utf8'));
const index = {};
(function walk(node, prefix) {
  if (node.files) { for (const [name, child] of Object.entries(node.files)) walk(child, prefix + '/' + name); }
  else index[prefix] = node;
})(header, '');
const WANT = [
  '/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js',
  '/dsh/node_modules/@deepseek-ai/dsh-compaction/lib/types/types.js',
  '/dsh/node_modules/@deepseek-ai/dsh-token-meter/lib/index.js',
  '/dsh/node_modules/@deepseek-ai/dsh-token-meter/README.md',
  '/dsh/node_modules/@deepseek-ai/dsh-compaction/README.md',
  '/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/README.md',
];
let extracted = 0;
for (const w of WANT) {
  const node = index[w];
  if (!node) { console.log('MISS ' + w); continue; }
  const buf = Buffer.alloc(node.size);
  fs.readSync(fd, buf, 0, node.size, base + Number(node.offset));
  const dest = path.join(OUT, w.replace(/\//g, '__'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  console.log('OK ' + node.size + 'B -> ' + dest);
  extracted++;
}
// dsh-agent 里搜 compactIfNeeded 调用点
const agentFiles = Object.keys(index).filter((p) => /dsh-agent\/lib\/.*\.js$/.test(p));
let callSites = 0;
for (const p of agentFiles) {
  const node = index[p];
  if (node.size > 8_000_000) continue;
  const buf = Buffer.alloc(node.size);
  fs.readSync(fd, buf, 0, node.size, base + Number(node.offset));
  const text = buf.toString('utf8');
  if (/compactIfNeeded|compactNow|compactionTrigger/i.test(text)) {
    const dest = path.join(OUT, p.replace(/\//g, '__'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    console.log('AGENT-CALL ' + p);
    callSites++;
  }
}
console.log('done. extracted=' + extracted + ' agentCallFiles=' + callSites);
fs.closeSync(fd);
