#!/usr/bin/env node
/**
 * test/run.mjs —— 一键跑全部测试。
 *
 * 用法：node test/run.mjs
 * 退出码：0 = 全通过；1 = 任一失败
 *
 * 四个测试的分工：
 *   contract.mjs  三端契约对账（face 方法表 ↔ client 描述符 ↔ TYPERT；Config 字段三处对账）
 *   static.mjs    静态约束（语法 / client 自足 / entry 薄壳 / 依赖方向 / 热换纪律 / 无调试残留）
 *   report.mjs    报告形状契约（产出侧字段 + 回填链依赖 + 瘦身档位 + dump 工具自检）
 *   boot.mjs      **宿主启动冒烟**（真跑 apply() + 真调 getHud/pre-step —— 源断言无法证明「接线可达」，
 *                 R11 真的踩过：接线块被嵌进另一个函数、语法合法、423 条源断言全绿，运行时全链路静默失效）
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const SUITES = ['contract.mjs', 'static.mjs', 'report.mjs', 'boot.mjs'];

const results = [];
for (const suite of SUITES) {
  const t0 = Date.now();
  let out = '';
  let pass = true;
  try {
    out = execFileSync(process.execPath, [join(DIR, suite)], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    pass = false;
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  // 从各自汇总行提取通过数
  const m = /：(\d+)\/(\d+) 通过/.exec(out);
  const [got, total] = m ? [Number(m[1]), Number(m[2])] : [pass ? '?' : 0, '?'];
  results.push({ suite, pass, got, total, ms: Date.now() - t0 });
  console.log(`${pass ? '✅' : '❌'} ${suite.padEnd(16)} ${String(got).padStart(3)}/${String(total).padEnd(3)} 通过  (${Date.now() - t0}ms)`);
  if (!pass) {
    if (!m) {
      // 套件崩溃（未产出汇总行）：打印异常首行，避免只显示 0/? 而无从下手
      const crash = out.split('\n').filter((l) => /Error|ReferenceError|TypeError|SyntaxError/.test(l)).slice(0, 2);
      console.log('   ⚠️ 套件崩溃（无汇总行）：' + (crash[0]?.trim() || '未知错误'));
      if (crash[1]) console.log('      ' + crash[1].trim());
    } else {
      // 失败时打印该套件的失败行，方便定位
      for (const line of out.split('\n')) if (line.includes('❌')) console.log('   ' + line.trim());
    }
  }
}

const failed = results.filter((r) => !r.pass);
console.log('\n' + '='.repeat(52));
console.log(failed.length ? `❌ ${failed.length}/${results.length} 套件失败：${failed.map((r) => r.suite).join(', ')}` : `✅ 全部 ${results.length} 套件通过`);
console.log('='.repeat(52));
process.exit(failed.length ? 1 : 0);
