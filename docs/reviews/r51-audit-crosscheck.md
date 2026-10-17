# 对千问（qoder/Qwen3.8-Flash）审计报告的逐条复核 —— 2026-10-17

被复核对象：`docs/reviews/r51-independent-audit-qwen38flash.md`（24KB，62 轮，由派发台
`j-mvccw8hw-1-c90e` 产出；模型 `Qwen3.8-Flash`，engine=qoder，exit=0）。

方法：**不采信报告结论**，每条都回到源码自己定位；能写行为级测试的就写，写不了的至少写结构守卫，
并对每条修复做**变异**（把它改回去，确认断言真的会红）。

## 结论：4 条真缺陷全部成立，已全部修复并加守卫（v0.1.42）

| 编号 | 它说的 | 我的复核 | 严重度 | 修法 |
| --- | --- | --- | --- | --- |
| F1 | 宿主 `getLastUserText` 用了未解构的 `lastUserText` | **成立**：`host.impl.mjs:317` 是自由标识符；第 38–44 行 `core` 解构里确实没有它（core 导出了、宿主没取）。调用即 `ReferenceError`，被 m2 的空 `catch` 吞掉 ⇒ 思考强度提醒永远拿不到用户文本 | **高**（静默降级） | 解构里补 `lastUserText` |
| F2 | 清理块引用未定义的 `pending`，卸载时 disposer 全不执行 | **成立**：`pending` 既没解构、`core` 也**没导出**（只在其内部被 `schedule` 用）⇒ 清理块**第一行**就抛 | **高**（每次 toggle/卸载都泄漏） | core 新增 `clearSchedules()`（防抖表归它清），宿主改调它 |
| F3 | `client.js` 的 `alive` 引用作用域外变量 | **成立**：`alive` 只声明在**上一个 effect**（304 行）；340/350 在 autoClamp 那个 effect 里 ⇒ `ReferenceError`，且在 `catch` 内**再抛一次** ⇒ 未捕获 rejection + 用户看不到任何提示 | 中 | autoClamp effect 声明**自己的** `alive` + 返回清理 |
| F4 | 回执只写全局镜像，读取端只读 per-sid | **成立**：`host.impl.mjs:380` 直写 `state.m3.lastCompactVerify`，而 `takeCompactVerify(sid)` 只读 `verifyBySid[sid]` ⇒ 这条「未执行」回执**永远读不回来**（正是那段注释声称要防的事） | 中 | 同时写 per-sid 槽 + 全局镜像 |

## 关于它的 M1（测试元审计）

它指出「780 项全绿却抓不到上述三条」，并给了四条证据。其中**最锋利的一条成立并被采纳**：

- **`test/boot.mjs` 的 `effect` 桩 `return setup?.()` 把卸载器返回后直接丢弃** ⇒ 卸载路径**从未被执行**
  （F2 因此三个版本都没被发现）。**已修**：桩现在收集卸载器，boot 末尾**真调**一遍并断言不抛
  （`卸载器可执行且不抛（清理块无未定义标识符 / disposer 全跑完）`）—— 这条**行为级**断言正是 F2 的
  回归守卫（变异 M2 实测：改回 `pending.values()` ⇒ 它和结构守卫同时红）。

其余三条（`contract.mjs:519` 把 F1 错误文本钉死、`:1567` 只数不查、`:2220` 对账方向）**未逐条复核**，
如实记为未验证项。

## 我自己那份自审报告的错误（必须记下）

`docs/reviews/r51-audit-self.md` §5 的 H1 写着「逐函数复核后**未再发现第三例**」——**这是错的**。
F1/F2/F3/F4 正是"自由标识符/作用域外引用"这一类，而我当时只用"抽查 + 现有测试"作依据就下了结论。
⇒ 自审报告的可信度上限就在这里：**我能发现的只是"我上次就想到的"**。这四条里 F1/F2/F4 都在
`host.impl.mjs` 的**几十行之内**，我读过它很多次，却没看见。

## 验证

- **782 断言全绿**（contract 629 / static 77 / report 54 / boot 22）
- **变异 4/4 CAUGHT**（F1 解构 / F2 清理块 / F3 作用域 / F4 回执同源）
- 其中 F1 的守卫首版**被自己的注释骗过**（变异 MISSED）：解构块上方的注释里也有 `lastUserText`
  ⇒ 已改为**先剥注释再比对**，复测 CAUGHT。这一条本身也是"断言可能假绿"的现场教训。
