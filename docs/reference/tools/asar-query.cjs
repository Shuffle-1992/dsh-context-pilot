#!/usr/bin/env node
/**
 * asar-query.cjs —— DSH 安装包（app.asar）通用查询工具。
 *
 * 合并并取代此前散落的一次性探针脚本
 * （asar-extract / asar-extract-dsh-session / asar-extract-time-context /
 *  asar-find-createUserMessage / asar-find-not-bundle / asar-probe / asar-extract-*）。
 *
 * 用法：
 *   # 列出所有文件（可过滤）
 *   node docs/reference/tools/asar-query.cjs list --filter "dsh-compaction"
 *
 *   # 抽取文件内容（多个用逗号分隔；--out 指定输出目录）
 *   node docs/reference/tools/asar-query.cjs extract \
 *     --paths "/dsh/node_modules/@deepseek-ai/dsh-token-meter/lib/index.js" --out docs/reference
 *
 *   # 按内容搜索（正则），--ctx 输出上下文行数、--ext 限定后缀
 *   node docs/reference/tools/asar-query.cjs grep --pattern "compactIfNeeded" --ext js --ctx 3
 *
 *   # 打印某文件的 package.json 关键字段
 *   node docs/reference/tools/asar-query.cjs pkg --path "/dsh/node_modules/@deepseek-ai/dsh-session/package.json"
 *
 * 默认 asar 路径：D:\\DeepSeek\\resources\\app.asar（可用 --asar 覆盖）
 */
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const cmd = args[0];
const getArg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const has = (name) => args.includes('--' + name);

const ASAR = getArg('asar', 'D:\\DeepSeek\\resources\\app.asar');
if (!fs.existsSync(ASAR)) {
  console.error('asar 不存在：' + ASAR + '\n（用 --asar 指定，或确认 DSH 安装路径）');
  process.exit(1);
}

/* ---- asar 头解析（格式：16 字节头 + JSON 目录 + 数据区） ---- */
const fd = fs.openSync(ASAR, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4);
const base = 8 + headerSize;
const headerJson = Buffer.alloc(head.readUInt32LE(12));
fs.readSync(fd, headerJson, 0, headerJson.length, 16);
const header = JSON.parse(headerJson.toString('utf8'));

/** 路径 → { size, offset } 索引 */
const index = new Map();
(function walk(node, prefix) {
  if (node.files) for (const [name, child] of Object.entries(node.files)) walk(child, prefix + '/' + name);
  else if (node.size !== undefined) index.set(prefix, { size: node.size, offset: Number(node.offset) });
})(header, '');

const readFileAt = (meta) => {
  const buf = Buffer.alloc(meta.size);
  fs.readSync(fd, buf, 0, meta.size, base + meta.offset);
  return buf;
};

const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|eot|mp3|mp4|wav|pdf|node|map|wasm|zip|gz)$/i;

if (cmd === 'list') {
  const filter = getArg('filter', '');
  const all = [...index.keys()].filter((p) => !filter || p.includes(filter)).sort();
  console.log(`匹配 ${all.length} / 总 ${index.size} 个文件${filter ? `（filter="${filter}"）` : ''}`);
  for (const p of all) console.log(`  ${String(index.get(p).size).padStart(9)}  ${p}`);
} else if (cmd === 'extract') {
  const paths = (getArg('paths', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const outDir = getArg('out', path.join(__dirname, '..', '..', '..', '.data', 'asar-out'));
  if (!paths.length) { console.error('需要 --paths <逗号分隔的 asar 内路径>'); process.exit(1); }
  fs.mkdirSync(outDir, { recursive: true });
  let ok = 0;
  for (const p of paths) {
    const meta = index.get(p);
    if (!meta) { console.log('MISS ' + p); continue; }
    const dest = path.join(outDir, p.replace(/[/\\]/g, '__'));
    fs.writeFileSync(dest, readFileAt(meta));
    console.log(`OK ${meta.size}B -> ${dest}`);
    ok++;
  }
  console.log(`done. extracted=${ok}/${paths.length}`);
} else if (cmd === 'grep') {
  const pattern = getArg('pattern', '');
  if (!pattern) { console.error('需要 --pattern <正则>'); process.exit(1); }
  const re = new RegExp(pattern);
  const extFilter = getArg('ext', '');
  const ctxN = Number(getArg('ctx', 0));
  const maxHits = Number(getArg('max', 40));
  const maxSize = Number(getArg('maxsize', 8_000_000));
  let scanned = 0, hits = 0;
  for (const [p, meta] of index) {
    if (meta.size > maxSize || meta.size < 4) continue;
    if (SKIP_EXT.test(p)) continue;
    if (extFilter && !p.endsWith('.' + extFilter)) continue;
    scanned++;
    const text = readFileAt(meta).toString('utf8');
    if (!re.test(text)) continue;
    hits++;
    console.log(`\n=== ${p} (${meta.size}B) ===`);
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        for (let k = Math.max(0, i - ctxN); k <= Math.min(lines.length - 1, i + ctxN); k++) {
          console.log(`  ${k + 1}: ${lines[k].slice(0, 200)}`);
        }
        if (ctxN) console.log('  ---');
      }
    }
    if (hits >= maxHits) { console.log(`\n（已达 --max ${maxHits}，停止）`); break; }
  }
  console.log(`\nscanned=${scanned} filesWithHit=${hits}`);
} else if (cmd === 'pkg') {
  const p = getArg('path', '');
  if (!p) { console.error('需要 --path <asar 内 package.json 路径>'); process.exit(1); }
  const meta = index.get(p);
  if (!meta) { console.error('MISS ' + p); process.exit(1); }
  const j = JSON.parse(readFileAt(meta).toString('utf8'));
  const keys = ['name', 'version', 'license', 'private', 'description', 'main', 'exports', 'dsh'];
  for (const k of keys) if (j[k] !== undefined) console.log(`${k} = ${JSON.stringify(j[k])}`);
} else {
  console.log('用法：asar-query.cjs <list|extract|grep|pkg> [选项]');
  console.log('  list    --filter <子串>');
  console.log('  extract --paths <逗号分隔> [--out <目录>]');
  console.log('  grep    --pattern <正则> [--ext js] [--ctx 3] [--max 40]');
  console.log('  pkg     --path <package.json 路径>');
  console.log('  通用：--asar <路径>');
}

fs.closeSync(fd);
