#!/usr/bin/env node
/**
 * make-contract.cjs —— 生成「DSH 契约快照」`docs/reference/dsh-contract.json`。
 *
 * 用途：给插件的**契约守卫测试**提供权威清单（`test/contract.mjs` 的 R48 块）。
 * 快照内容只保留**可证实**的两类：
 *   · sessionEvents：来自官方包 `@deepseek-ai/dsh-session` 的 `lib/types/known-event-types.js`（权威）
 *   · hookEvents   ：从 DSH 安装包 `app.asar` 内 `@deepseek-ai` 各包扫描 `ctx.on(...)` / `dispatch.waterfall(...)` 字面量
 * 服务名**不纳入**：host 服务不以字面量 `provide()` 注册，扫描不可靠（服务契约靠升级后冒烟验证）。
 *
 * 用法：
 *   node docs/reference/tools/make-contract.cjs \
 *     --asar "D:\DeepSeek\resources\app.asar" \
 *     --session <dsh-session 包内 known-event-types.js 的本地路径> \
 *     --out docs/reference/dsh-contract.json
 *
 * **升级 DSH 后重跑本脚本刷新快照**，然后跑 `npm test`：若插件用到的事件名不在新清单里，守卫会报红。
 * 也用于确认「DSH 事件清单有没有增删」。
 */
const fs = require('node:fs');

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};

const ASAR = getArg('asar', 'D:\\DeepSeek\\resources\\app.asar');
const SESSION_PKG = getArg('session', '');
const SESSION_VERSION = getArg('session-version', '（未标注）');
const OUT = getArg('out', 'docs/reference/dsh-contract.json');

/* ---- asar 头解析（--session 缺省时用它抽 known-event-types.js）---- */
const fd = fs.openSync(ASAR, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const base = 8 + head.readUInt32LE(4);
const headerJson = Buffer.alloc(head.readUInt32LE(12));
fs.readSync(fd, headerJson, 0, headerJson.length, 16);
const header = JSON.parse(headerJson.toString('utf8'));
const index = new Map();
(function walk(node, prefix) {
  if (node.files) for (const [name, child] of Object.entries(node.files)) walk(child, prefix + '/' + name);
  else if (node.size !== undefined) index.set(prefix, { size: node.size, offset: Number(node.offset) });
})(header, '');
const readAt = (meta) => {
  const buf = Buffer.alloc(meta.size);
  fs.readSync(fd, buf, 0, meta.size, base + meta.offset);
  return buf.toString('utf8');
};

/* ---- sessionEvents ---- */
let sessionEvents = [];
let sessionSrc = SESSION_PKG;
if (!sessionSrc) {
  sessionSrc = '/dsh/node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js';
  const meta = index.get(sessionSrc);
  if (!meta) {
    console.error('asar 内找不到 ' + sessionSrc + '（可用 --session 指定本地文件）');
    process.exit(1);
  }
  sessionSrc = ASAR + '!' + sessionSrc;
}
const sessText = SESSION_PKG ? fs.readFileSync(SESSION_PKG, 'utf8') : readAt(index.get('/dsh/node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js'));
const iSess = sessText.indexOf('KNOWN_SESSION_EVENT_TYPES');
if (iSess < 0) {
  console.error('找不到 KNOWN_SESSION_EVENT_TYPES：' + sessionSrc);
  process.exit(1);
}
const seg = sessText.slice(iSess, sessText.indexOf(']);', iSess));
sessionEvents = [...new Set([...seg.matchAll(/['"]([a-z-]+\/[a-z-]+)['"]/g)].map((m) => m[1]))].sort();

/* ---- hookEvents（扫 asar）---- */

const hooks = new Set();
let scanned = 0;
for (const [p, meta] of index) {
  if (!p.startsWith('/dsh/node_modules/@deepseek-ai/')) continue;
  if (!/\.js$/.test(p) || meta.size > 3_000_000) continue;
  let s;
  try {
    const buf = Buffer.alloc(meta.size);
    fs.readSync(fd, buf, 0, meta.size, base + meta.offset);
    s = buf.toString('utf8');
  } catch { continue; }
  scanned += 1;
  for (const m of s.matchAll(/\bon\(\s*["']((?:agent|session|tool|llm|compaction|plugin)\/[a-zA-Z0-9/-]+)["']/g)) hooks.add(m[1]);
  for (const m of s.matchAll(/dispatch\.(?:waterfall|serial|parallel)\(\s*["']([a-zA-Z0-9/-]+)["']/g)) hooks.add(m[1]);
}

const out = {
  provenance: {
    sessionEvents: `官方包 @deepseek-ai/dsh-session ${SESSION_VERSION} 的 lib/types/known-event-types.js（权威清单）`,
    hookEvents: `${ASAR} 内 @deepseek-ai 各包扫描 ctx.on(...) / dispatch.waterfall(...)（${scanned} 个文件）`,
    extractedAt: new Date().toISOString(),
    purpose: '插件契约守卫：插件用到的会话事件 / hook 事件必须 ⊆ 本清单；升级 DSH 后重跑刷新本文件。',
    caution: '服务名不纳入本快照（host 服务不以字面量 provide，扫描不可靠）⇒ 服务契约靠升级后冒烟。',
  },
  sessionEvents,
  hookEvents: [...hooks].sort(),
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`sessionEvents=${sessionEvents.length}  hookEvents=${out.hookEvents.length}  (扫描 ${scanned} 文件)`);
console.log('-> ' + OUT);
