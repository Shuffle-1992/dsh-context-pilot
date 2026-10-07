#!/usr/bin/env node
/**
 * session-records.cjs —— DSH 会话存储（`session.v4.jsonl.zstd`）只读取证工具。
 *
 * 为什么需要它：压缩是否真的发生、发生在哪一步、阴影了哪些 seq、保留了什么，
 * **只有会话存储的逐帧记录能证明**（报告是本插件自己写的，不能自证）。
 * 本项目已用它两次定案：
 *   ① R4 E2E：证明「工具调用(18300) → 下一步 pre-step 的 compaction/start(18303)」的因果时序；
 *   ② R5：统计 12 次压缩的 `shadowedSeqs`，证明 `system/message` 15513 **从未被阴影化**
 *      （⇒ 引擎只保护 surface 头，`isSystemHead` 是载荷性逻辑而非防御性样板）。
 *
 * 格式事实（Node v24 实测）：
 *   - 文件是**多帧 zstd** 拼接（每帧魔数 `28 B5 2F FD`），一帧可含多行 JSON；
 *   - `zlib.zstdDecompressSync` 可解；
 *   - 直接在原始字节里扫魔数会有**假阳性**（压缩数据内部也可能出现该模式）⇒ 必须 try/catch 跳过；
 *   - 解码后按行 JSON.parse，残缺尾行忽略。
 *
 * ⚠️ 这是 DSH 的**私有存储格式**，仅用于取证；官方改格式时本工具需要同步。
 *
 * 用法：
 *   node docs/reference/tools/session-records.cjs <session.v4.jsonl.zstd> [选项]
 *   node docs/reference/tools/session-records.cjs --find 16616c07 [选项]
 *
 * 选项：
 *   --find <子串>     在 ~/.dsh/sessions 下找最新一个路径含该子串的会话文件（免手抄长路径）
 *   --from <seq>      只看 seq >= N 的记录
 *   --type <模式>     只看某类型；支持前缀通配，如 `compaction/*`、`agent/inbox/*`
 *   --compaction      逐条列出 compaction/summary 的 range / 阴影 token / shadowedSeqs 长度
 *   --shadowed <seq>  查询该 seq 是否出现在任一 summary 的 shadowedSeqs 中（R5 用的就是它）
 *   --json            以 JSON 输出统计（便于脚本消费）
 *
 * 退出码：0 = 成功；1 = 参数/文件错误
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** 多帧 zstd → JSONL 记录数组。假阳性魔数靠 try/catch 跳过（实测必须如此）。 */
function decodeSession(file) {
  const buf = fs.readFileSync(file);
  const lines = [];
  let frames = 0;
  let magicHits = 0;
  for (let i = 0; i + 3 < buf.length; i += 1) {
    if (buf[i] !== MAGIC[0] || buf[i + 1] !== MAGIC[1] || buf[i + 2] !== MAGIC[2] || buf[i + 3] !== MAGIC[3]) continue;
    magicHits += 1;
    try {
      lines.push(zlib.zstdDecompressSync(buf.subarray(i)).toString('utf8'));
      frames += 1;
    } catch {
      /* 假阳性：压缩数据内部恰好出现魔数 */
    }
  }
  const records = [];
  for (const line of lines.join('').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      records.push(JSON.parse(s));
    } catch {
      /* 残缺尾行 */
    }
  }
  return { bytes: buf.length, magicHits, frames, records };
}

/** 在 ~/.dsh/sessions 下找**最新**一个路径含 needle 的会话文件。 */
function findSession(needle) {
  const root = path.join(os.homedir(), '.dsh', 'sessions');
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === 'session.v4.jsonl.zstd' && p.includes(needle)) hits.push(p);
    }
  };
  walk(root, 0);
  hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return hits[0] ?? null;
}

/** 从记录里尽力抽一段可读文本（用于人工扫一眼内容对不对）。 */
function excerpt(r) {
  const d = r.data ?? {};
  const texts = [];
  if (typeof d.text === 'string') texts.push(d.text);
  if (typeof d.content === 'string') texts.push(d.content);
  if (typeof d.prompt === 'string') texts.push(d.prompt);
  if (typeof d.message?.content === 'string') texts.push(d.message.content);
  if (Array.isArray(d.message?.content)) for (const c of d.message.content) if (typeof c?.text === 'string') texts.push(c.text);
  if (Array.isArray(d.summary)) for (const c of d.summary) if (typeof c?.text === 'string') texts.push(c.text);
  return texts.join(' ').replace(/\s+/g, ' ').slice(0, 110);
}

function main(argv) {
  const args = argv.slice(2);
  const opt = { from: null, type: null, compaction: false, shadowed: null, json: false, find: null, file: null };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--from') opt.from = Number(args[++i]);
    else if (a === '--type') opt.type = args[++i];
    else if (a === '--compaction') opt.compaction = true;
    else if (a === '--shadowed') opt.shadowed = Number(args[++i]);
    else if (a === '--json') opt.json = true;
    else if (a === '--find') opt.find = args[++i];
    else if (!a.startsWith('--')) opt.file = a;
  }
  const file = opt.file ?? (opt.find ? findSession(opt.find) : null);
  if (!file || !fs.existsSync(file)) {
    console.error('用法：node docs/reference/tools/session-records.cjs <session.v4.jsonl.zstd|--find 子串> [--from seq] [--type 模式] [--compaction] [--shadowed seq] [--json]');
    return 1;
  }
  const { bytes, magicHits, frames, records } = decodeSession(file);
  const byType = {};
  for (const r of records) byType[r.type] = (byType[r.type] ?? 0) + 1;

  const summaries = records.filter((r) => r.type === 'compaction/summary');
  const out = { file, bytes, magicHits, frames, records: records.length, byType };

  if (opt.shadowed !== null) {
    out.shadowedQuery = summaries.map((r) => {
      const seqs = (r.data?.shadowedSeqs ?? []).map(Number);
      return { summarySeq: r.seq, has: seqs.includes(opt.shadowed), range: r.data?.shadowedRange ?? null, seqs: seqs.length };
    });
    out.shadowedEverShadowed = out.shadowedQuery.some((x) => x.has);
  }

  if (opt.json) {
    console.log(JSON.stringify(out, null, 1));
    return 0;
  }

  console.log(`file    ${file}`);
  console.log(`bytes   ${bytes} ｜ magicHits ${magicHits} ｜ frames ${frames} ｜ records ${records.length}`);
  console.log('types   ' + JSON.stringify(byType));

  if (opt.compaction) {
    console.log('--- compaction/summary 逐条 ---');
    for (const r of summaries) {
      const d = r.data ?? {};
      const seqs = (d.shadowedSeqs ?? []).map(Number);
      const sorted = [...seqs].sort((a, b) => a - b);
      console.log(
        `seq ${r.seq} | range ${JSON.stringify(d.shadowedRange)} | shadowedTokens ${d.shadowedTokenCount}` +
        ` | seqs ${seqs.length} [${sorted[0] ?? '-'}..${sorted[sorted.length - 1] ?? '-'}]` +
        ` | ${d.provider ?? '?'}/${d.model ?? '?'} | usage ${JSON.stringify(d.usage ?? null)}`,
      );
    }
  }

  if (opt.shadowed !== null) {
    console.log(`--- seq ${opt.shadowed} 是否被阴影化过：${out.shadowedEverShadowed} ---`);
    for (const x of out.shadowedQuery) console.log(`  summary seq ${x.summarySeq} | range ${JSON.stringify(x.range)} | 含? ${x.has} | seqs ${x.seqs}`);
  }

  if (opt.from !== null || opt.type) {
    const re = opt.type ? new RegExp('^' + opt.type.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$') : null;
    const picked = records.filter((r) => (opt.from === null || Number(r.seq) >= opt.from) && (!re || re.test(String(r.type))));
    console.log(`--- 命中 ${picked.length} 条（from=${opt.from ?? '-'} type=${opt.type ?? '-'}）---`);
    for (const r of picked.slice(0, 300)) {
      const d = r.data ?? {};
      const extra = [d.shadowedRange ? `range=${JSON.stringify(d.shadowedRange)}` : '', d.source ? `source=${JSON.stringify(d.source)}` : '']
        .filter(Boolean).join(' ');
      console.log(`[${r.seq}] ${r.type} ${r.time} ${extra} ${excerpt(r)}`.trimEnd());
    }
    if (picked.length > 300) console.log(`…（只显示前 300 条，共 ${picked.length} 条）`);
  }
  return 0;
}

process.exitCode = main(process.argv);
