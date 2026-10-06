/* 定位并抽取 @deepseek-ai/dsh-llm 的 createUserMessage 实现 */
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
const targets = files.filter((f) => f.p.includes('@deepseek-ai/dsh-llm/lib') && f.p.endsWith('.js') && f.size < 4_000_000);
console.log('dsh-llm js files: ' + targets.length);
for (const f of targets) {
  const buf = Buffer.alloc(f.size);
  fs.readSync(fd, buf, 0, f.size, base + Number(f.offset));
  const text = buf.toString('utf8');
  const idx = text.search(/function createUserMessage|createUserMessage =/);
  if (idx >= 0) {
    const dest = path.join(OUT, f.p.replace(/\//g, '__'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    console.log('\n=== ' + f.p + ' (' + f.size + 'B) @' + idx + ' ===');
    console.log(text.slice(Math.max(0, idx - 800), idx + 1500));
  }
}
fs.closeSync(fd);
