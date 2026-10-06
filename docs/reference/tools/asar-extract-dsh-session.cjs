/* 提取 dsh-session 的 deriveEventMessage（assistant/message 事件正文提取的官方实现） */
const fs = require('fs');
const path = require('path');
const ASAR = 'D:\\DeepSeek\\resources\\app.asar';
const OUT = 'F:\\My Code\\dsh-context-pilot\\docs\\reference\\__dsh__node_modules__@deepseek-ai__dsh-session';
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

const sessionFiles = Object.keys(index).filter((p) => /dsh-session\/lib\/.*\.js$/.test(p));
let hit = 0;
for (const p of sessionFiles) {
  const node = index[p];
  if (node.size > 8_000_000) continue;
  const buf = Buffer.alloc(node.size);
  fs.readSync(fd, buf, 0, node.size, base + Number(node.offset));
  const text = buf.toString('utf8');
  if (/deriveEventMessage/.test(text)) {
    const dest = path.join(OUT, p.replace(/\//g, '__'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    console.log('HIT ' + node.size + 'B -> ' + dest);
    hit++;
  }
}
console.log('done. sessionFiles=' + sessionFiles.length + ' hits=' + hit);
fs.closeSync(fd);
