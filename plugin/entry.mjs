/**
 * @local/dsh-context-pilot —— M0 最小入口（激活自证：日志可见即可）。
 *
 * 纪律（继承 dsh-browser-kit 经验）：
 *  - apply() 内任何异常只记录不抛（抛 = 条目装载失败）；
 *  - 业务实现后续放 impl 文件走 mtime+seq 热换（entry 永久薄壳，见 browser-kit entry.mjs 头注）；
 *  - 本插件为 host 侧纯 Node（RUN_AS_NODE runner），不可 require('electron')。
 */
export const name = 'dsh-context-pilot';

export function apply(ctx) {
  const log = (level, text) => {
    try {
      const logger = ctx && ctx.logger;
      if (logger && typeof logger[level] === 'function') logger[level](`[dsh-context-pilot] ${text}`);
      else console[level === 'info' ? 'log' : level](`[dsh-context-pilot] ${text}`);
    } catch { /* 静默 */ }
  };
  try {
    log('info', `激活成功（M0 骨架）@ ${new Date().toISOString()}`);
    const has = (k) => {
      try { return typeof ctx?.get === 'function' && !!ctx.get(k); } catch { return 'err'; }
    };
    log('info', `服务在位检查：tokenMeter=${has('tokenMeter')} compaction=${has('compaction')} systemPrompt=${has('systemPrompt')} llm=${has('llm')}`);
    // M1 待办：枚举活动 Session（ctx.agents.list() 或 sessions/sessionQuery 服务）并对
    // tokenMeter.measure(session) 做一次真实读数验证——详见项目 README §6 M1。
  } catch (e) {
    log('warn', `激活期异常（已吞）：${e && e.message ? e.message : e}`);
  }
}
