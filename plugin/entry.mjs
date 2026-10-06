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

export const name = 'dsh-context-pilot';

/** bundle config schema：详情页配置区的存在条件（schemastery 不可达时为 undefined → 无 schema）。 */
export const Config = DSH_CONTEXT_PILOT_CONFIG_SCHEMA;

let activationSeq = 0;

/**
 * Host 入口。同步返回 { reportPath }；实际接线在 impl 里异步完成（不阻塞激活）。
 * @param {object} ctx cordis Context
 * @param {object} config 插件 config（M4 前无字段）
 */
export function apply(ctx, config = {}) {
  const seq = ++activationSeq;
  let mtime = 0;
  try {
    mtime = statSync(IMPL_PATH).mtimeMs;
  } catch { /* impl 缺失时 URL 仍可构造，import 会报出可读错误 */ }
  const url = `./host.impl.mjs?ts=${mtime}-${seq}`;
  import(url)
    .then((impl) => impl.apply(ctx, config, { pluginDir: PLUGIN_DIR, reportPath: REPORT_PATH }))
    .catch((e) => {
      try {
        const m = e && e.message ? e.message : String(e);
        if (ctx && ctx.logger && ctx.logger.error) ctx.logger.error(`[dsh-context-pilot] impl 加载失败：${m}`);
        else console.error('[dsh-context-pilot] impl 加载失败：', m);
      } catch { /* 静默 */ }
    });
  return { reportPath: REPORT_PATH };
}
