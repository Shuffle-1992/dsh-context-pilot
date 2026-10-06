/**
 * plugin-config.schema.mjs —— bundle config schema（DSH 插件详情页「配置区」的存在条件）。
 *
 * 为什么需要：Cordis Inspect 取证（browser-kit 2026-10-05）——DSH 插件详情页只在 bundle
 * 声明了 config schema 时才渲染配置区；schema 必须是 **schemastery 实例**
 * （JSON Schema 字面量会被判 status="unsupported" 并让插件条目 fiberPhase="failed"）。
 *
 * 解析策略（schemastery 不在本包依赖里，四级候选链照抄 browser-kit 实证模式）：
 *   1) 裸 import `@deepseek-ai/schemastery`；
 *   2) process.resourcesPath 推导的候选 node_modules 根；
 *   3) env `DSH_CONTEXT_PILOT_MODULES_ROOT` / `DSH_CONTEXT_PILOT_DSH_RESOURCES` 逃生口；
 *   4) 本机开发位 `F:\My Code\zcode-dispatch\node_modules`（已验证可用，纯兜底）。
 * 全部失败 → 返回 undefined → 入口不导出 Config → 退回 absent 旧行为（插件照常工作）。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** schemastery 包内候选入口（ESM 优先，CJS 兜底）。 */
const CANDIDATE_FILES = ['lib/index.mjs', 'lib/index.js', 'dist/index.js', 'index.js', 'lib/index.cjs'];

/** 候选 node_modules 根（顺序即优先级）。 */
function moduleRootCandidates() {
  const out = [];
  for (const k of ['DSH_CONTEXT_PILOT_MODULES_ROOT', 'DSH_CONTEXT_PILOT_DSH_RESOURCES']) {
    const v = process.env[k];
    if (typeof v === 'string' && v) out.push(v);
  }
  const res = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  if (res) {
    for (const base of [join(res, 'app.asar'), join(res, 'app.asar.unpacked')]) {
      out.push(join(base, 'dsh', 'node_modules'));
      out.push(join(base, 'node_modules'));
    }
  }
  out.push('F:\\My Code\\zcode-dispatch\\node_modules');
  return [...new Set(out.filter(Boolean))];
}

/** 取出 z 本体（ESM default / CJS exports / 嵌套 default 三种包装都要兼容）。 */
const unwrapZ = (mod) => {
  for (const c of [mod, mod && mod.default, mod && mod['module.exports']]) {
    if (c && typeof c.object === 'function') return c;
  }
  return null;
};

/** 异步解析 schemastery：裸 import → 候选根 × 候选文件。 */
export async function resolveSchemastery() {
  try {
    const z = unwrapZ(await import('@deepseek-ai/schemastery'));
    if (z) return z;
  } catch { /* 继续 */ }
  for (const root of moduleRootCandidates()) {
    for (const rel of CANDIDATE_FILES) {
      const file = join(root, '@deepseek-ai', 'schemastery', rel);
      if (!existsSync(file)) continue;
      try {
        const z = unwrapZ(await import(pathToFileURL(file).href));
        if (z) return z;
      } catch { /* 试下一个 */ }
    }
  }
  return null;
}

/** 用 z 构建本插件 schema（字段与 host.impl.mjs M3_DEFAULTS 一一对应）。
 *  ⚠️ 全部字段 .volatile()：DSH 设置写入门禁要求条目存在 volatile 字段，否则面板每次保存
 *  被静默拒绝（`Plugin entry "x" has no volatile fields`，且 set() 照样 resolve）——zcode 实测。 */
function buildWith(z) {
  try {
    return z.object({
      enabled: z.boolean().default(true).description('总开关（关闭后不注入、不决策、不压缩）').volatile(),
      dryRun: z.boolean().default(false).description('演习模式：只记录决策不真执行压缩').volatile(),
      highRatio: z.number().default(0.6).description('审计参考线（决策主体是模型标记，此值仅用于审计口径）').volatile(),
      criticalRatio: z.number().default(0.85).description('危险线：任务执行前/空闲时无条件强制压缩').volatile(),
      lightTaskChars: z.number().default(4000).description('轻任务字符阈值（仅审计口径）').volatile(),
      marker: z.string().default('[cp:compact]').description('模型回复尾部标记（置空字符串关闭标记通道）').volatile(),
      markerMinRatio: z.number().default(0.2).description('标记通道最低占用（低于此压缩无意义）').volatile(),
      armedTtlMs: z.number().default(120000).description('标记武装有效期（毫秒）').volatile(),
      policyCardMinRatio: z.number().default(0.3).description('压缩决策提示词注入的最低占用（0-1，低于此不注入，省 token）').volatile(),
      sweepMinIntervalMs: z.number().default(600000).description('危险线兜底扫除的最小间隔（毫秒；标记模式不受限）').volatile(),
      hudLastAct: z.string().default('').description('M5 状态：最近一次压缩摘要（host 自动写入，无需手改）').volatile(),
      hudArmed: z.string().default('').description('M5 状态：标记武装中时为 "armed"（host 自动写入）').volatile(),
      hudPending: z.string().default('').description('M5.5 状态：挂起待恢复的任务（JSON，host 自动写入）').volatile(),
    });
  } catch {
    return undefined;
  }
}

/** 顶层 await 解析并构建（模块加载期完成，满足 entry.mjs 的静态导出要求）。 */
const z = await resolveSchemastery();
export const DSH_CONTEXT_PILOT_CONFIG_SCHEMA = z ? buildWith(z) : undefined;
export const DSH_CONTEXT_PILOT_SCHEMA_SOURCE = z ? 'schemastery 已解析' : 'schemastery 不可达（Config 不导出）';
