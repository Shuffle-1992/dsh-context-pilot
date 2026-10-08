/**
 * @local/dsh-context-pilot —— Host 入口薄壳（业务逻辑全在 host.impl.mjs，勿在此放逻辑）。
 *
 * 双层缓存规避（继承 dsh-browser-kit 实测结论 2026-10-04）：
 *  1. cordis loader 经 Node ESM 缓存加载入口——插件 disable/enable 重跑 apply() 但模块实例不换新，
 *     改代码必须重启 DSH。故入口**永久保持此薄壳形态不变**（改它 = 又要重启）；
 *  2. 业务实现放 host.impl.mjs：每次 apply 按「impl 文件 mtime + 激活序号」构造带查询参数的
 *     import URL——参数变 ⇒ Node 视为新模块 ⇒ 免重启热换新代码（ESM 按完整 URL 缓存，规格行为）。
 *
 * ⚠️ M4 已实施（2026-10-06：本文件唯一一次允许的例外改动，改后需重启 DSH 一次）：
 *   DSH 插件详情页只在 bundle 声明了 config schema 时才渲染配置区，且 cordis loader 只认
 *   **入口模块的静态导出** Config（动态 import 的 impl 导出不被识别）。schema 本体住
 *   plugin-config.schema.mjs（schemastery 实例，四级候选链解析）；解析失败时导出 undefined
 *   → DSH 视为无 schema（absent），插件照常工作。模式照抄 dsh-browser-kit 实证版。
 */
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DSH_CONTEXT_PILOT_CONFIG_SCHEMA } from './plugin-config.schema.mjs';

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const IMPL_PATH = join(PLUGIN_DIR, 'host.impl.mjs');
/** M1 验证报告（重启/运行期随时可读，取证入口）。 */
const REPORT_PATH = join(PLUGIN_DIR, '.data', 'm1-report.json');
/** R14 解耦第六刀：core.mjs 也走同一套 ts —— 必须**先加载完再调 apply**（见下）。 */
const CORE_PATH = join(PLUGIN_DIR, 'core.mjs');

export const name = 'dsh-context-pilot';

/** bundle config schema：详情页配置区的存在条件（schemastery 不可达时为 undefined → 无 schema）。 */
export const Config = DSH_CONTEXT_PILOT_CONFIG_SCHEMA;

let activationSeq = 0;

/**
 * Host 入口。同步返回 { reportPath }；实际接线在 impl 里异步完成（不阻塞激活）。
 * @param {object} ctx cordis Context
 * @param {object} config 插件 config（M4 前无字段）
 * @param {{reportPath?: string}} [overrides] **仅供测试**（boot 的 entry 级冒烟用它把报告写到临时目录，
 *   避免污染运行期报告）。DSH 只按 `apply(ctx, config)` 调用 ⇒ 不传即默认路径。
 */
export function apply(ctx, config = {}, overrides = {}) {
  const seq = ++activationSeq;
  const reportPath = overrides.reportPath ?? REPORT_PATH;
  let mtime = 0;
  try {
    mtime = statSync(IMPL_PATH).mtimeMs;
  } catch { /* impl 缺失时 URL 仍可构造，import 会报出可读错误 */ }
  const url = `./host.impl.mjs?ts=${mtime}-${seq}`;
  /* R14：core.mjs 用**同一个 ts** `预加载`后作为第 4 个参数传给 apply。
   * 为什么必须由入口预加载：`state` / `log` / `svc` / `schedule` / `addListener` 都在 apply 期
   * **同步**使用，而 `?ts=` 动态 import 是异步的——只有让调用方先加载才能同时满足「热换」（P16）
   * 与「同步可用」。两者共用 ts ⇒ 同批热换。
   * ⚠️ 本文件属「改它必须重启 DSH」的薄壳：未重启时旧 entry 不会传 core，宿主已做**降级不崩**。 */
  const coreUrl = `./core.mjs?ts=${mtime}-${seq}`;
  Promise.all([import(coreUrl), import(url)])
    /* ⚠️⚠️ 2026-10-08 真机事故（R14 引入、R15.2 修）：这里原先直接把 core 的**模块命名空间**
     * (`{createCore}`) 传给了 apply，而不是 `createCore(...)` 的**返回值** ⇒ 宿主解构出的
     * `loadDefineTool` / `state` / `log` … 全是 `undefined` ⇒ apply 当场抛 TypeError ⇒
     * **插件完全没激活**（无监听器、无面、无报告），而 UI 只显示「处理失败」。
     * 教训：boot 冒烟当时**绕过了 entry**（直接传 createCore 的结果）⇒ 19/19 全绿也抓不到。
     * 现已补 `test/boot.mjs` 的 **entry 级**冒烟（走真实 entry.apply）。 */
    .then(([coreMod, impl]) => impl.apply(ctx, config, {
      pluginDir: PLUGIN_DIR,
      reportPath,
      core: coreMod.createCore({ ctx, config, pluginDir: PLUGIN_DIR, reportPath }),
    }))
    .catch((e) => {
      try {
        const m = e && e.message ? e.message : String(e);
        if (ctx && ctx.logger && ctx.logger.error) ctx.logger.error(`[dsh-context-pilot] impl 加载失败：${m}`);
        else console.error('[dsh-context-pilot] impl 加载失败：', m);
      } catch { /* 静默 */ }
    });
  return { reportPath };
}
