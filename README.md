# dsh-context-pilot — DSH 上下文领航插件

> **交接文档**：新会话的 agent 读完本文 + `docs/` 即可接着开发，无需其他上下文。
> 创建：2026-10-05 · 状态：探索完成、零代码（仅 M0 骨架）· 探索结论全部经运行时/源码实证

## 1. 项目定位

DSH（DeepSeek Harness）宿主侧插件 `@local/dsh-context-pilot`：**上下文领航员**。

核心循环：

```
每轮任务前 → 读取上下文用量（tokenMeter）→ 注入"上限/已用/占比"进 prompt
          → AI 按任务复杂度自评 → 决定是否先压缩（compactNow）→ 再执行任务
```

要解决的问题：长会话上下文压力不可见、自动压缩时机（80%）与任务复杂度无关——重任务需要全上下文，轻任务其实可以先压缩腾空间。

## 2. 环境事实（本机，已核实）

| 项 | 值 |
| --- | --- |
| DSH Desktop | 0.2.0-rc.2（Electron 44 / Chromium 152 / Node 24） |
| DSH 进程模型 | 主进程 + **RUN_AS_NODE 纯 Node 插件宿主**（插件 host 摸不到 Electron API——已实证，勿尝试） |
| Profile | `C:\Users\Administrator\.dsh\profiles\desktop\` |
| composition 来源 | ① `package.json` 的 `dsh.profile.bundles`（首个 `@deepseek-ai/dsh-base` = 基础 composition，压缩挂载来自这里）② `cordis.patch.yml`（profile 补丁层）③ 根 `cordis.yml` 恒为 `[]` |
| 本地插件挂载 | profile `package.json` 的 `dependencies` 加 `"@local/xxx": "link:<项目>/plugin"` + `bundles` 加 `"@local/xxx"`，重启 DSH 生效（现成范例：同目录 `@local/dsh-browser-kit`） |
| Inspect 工具 | 会话里有 `cordis_inspect_list/query`（host Service/Event/Config 目录可直接查——本报告服务签名即来自它） |

## 3. 已验证的核心 API（全部经运行时 Service 目录 + asar 源码实证）

### 3.1 读用量（可读 ✅）

```js
const m = ctx.tokenMeter.measure(session);
// m.totalTokens      请求+响应压力
// m.surfaceTokens    表面总量（= nodes[].tokens 之和）
// m.contextPressure / m.projectedTokens
// m.contextBreakdown { systemTokens, messageTokens, toolsTokens }
```
- 上限 W：从 LLM 适配器容量解析（`LlmModelContext.contextWindow`，`ctx.llm.listModels()` 同字段）。
- ⚠️ 精度：无 provider usage 时按 **4 字符/token 启发式，CJK 与 JSON Schema 低估**（官方 Dev Note 承认）。占比是估计值。

### 3.2 压缩（可手动触发 ✅）

```js
ctx.compaction.compactNow(agent)            // 立即压缩（等价 /compact）
ctx.compaction.compactIfNeeded(agent, trigger)
ctx.compaction.compactRegion(start, end, agent)  // 需要开放 turn
```

### 3.3 每轮 prompt 注入（官方挂点 ✅）

```js
ctx.systemPrompt.variable('ctxUsage', (ctx) => `上限 ${W} / 已用 ${used}（${pct}%）`);
ctx.systemPrompt.context(...)   // 或 section(...)
```
`systemPrompt` 服务就是"每轮模型步进前组装 prompt"的注册表。

### 3.4 自动压缩参数（可配 ✅，来自 `@deepseek-ai/dsh-compaction-basic`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `thresholdRatio` | 0.8 | 触发线 = `floor(min(W×ratio, W−O−headroom))`，O=输出预留，headroom 默认 65536 |
| `retainRatio` | 0.16 | 压缩后近端保留（可用 `retainTokens` 绝对值替代） |
| `modelPolicies[]` | [] | 按 provider+model 覆写 |
| `auto` | true | 自动压缩开关（false = 仅手动） |
| `summarizationProvider/Model` | 路由回退 | 压缩摘要可用便宜模型 |

## 4. ⚠️ composition 的真相（本次实验踩坑复盘，重要）

- **根 `cordis.yml` 恒为 `[]`，头部注释明言 "Edit cordis.patch.yml, not this file"**。它会被 DSH 归一化重写——**永远不要编辑它**。
- 本次实验曾把 thresholdRatio: 0.6 写进 cordis.yml（一份 1565 行的陈旧全量快照），**从未生效**，随后被 DSH 重写回 `[]`。当前生效配置 = dsh-base 内置默认（thresholdRatio 0.8）。
- 正确的调参路径（按优先级）：
  1. `cordis.patch.yml` 加同名挂载/配置做 profile 级覆写（**覆写语义需实验验证**——同 id 是替换还是合并未确认，M1 顺手验证）；
  2. `configEditor` 服务 `edit(entry, change)`（走正常 Loader 重载）；
  3. 直接改 asar 内 dsh-base（不可取，升级即失）。
- 压缩参数改动需重启 DSH 生效；改任何 profile 文件前先备份（目录里有 `.bak-*` 先例）。

## 5. 当前状态

- [x] 探索与服务实证（本报告 + docs/reference 抽取源码）
- [x] thresholdRatio 实验复盘（见 §4——未生效，现已回默认 0.8，无需回滚）
- [x] M0 骨架（plugin/entry.mjs 最小入口）
- [ ] M1-M5（见下）

## 6. 里程碑

### M1 用量读取 + 激活验证
- 部署空插件（见 §8），确认激活日志可见；
- 解决关键未知：**如何拿到活动 Session 句柄**（`ctx.agents.list()`？`sessions`/`sessionQuery` 服务？——用 Inspect host Service 目录查 `sessions`/`sessionController`/`sessionQuery` 签名）；
- 对活动会话调 `tokenMeter.measure()`，把结果写日志验证。

### M2 每轮注入
- `systemPrompt.variable()` 注册用量摘要（上限/已用/占比三数）；
- 验证：新会话随便问一句"你的上下文占用"，模型应能报出注入值。

### M3 复杂度决策 + compactNow
- 启发式先行：任务文本长度 + 占用 > 阈值 → 建议压缩；
- 进阶：一次轻量 LLM 调用做复杂度判定（参考 compaction-basic 的 summarization 路由思路）；
- 决策"先压缩" → `compactNow()`；把决策与理由写入日志/提示。

### M4 自身 Config 面
- 参照 `F:\My Code\dsh-browser-kit\plugin\plugin-config.schema.mjs` 的 schemastery 四级候选链模式，暴露自己的阈值配置。

### M5（可选）GUI 占用浮层
- client 半段 + Slots，显示实时占用条。注意 client 侧问题见 browser-kit pitfalls P37（多实例认领制）。

## 7. 已知设计风险（开发前必读）

1. **`isolate: { compaction: true }` 作用域**：cordis.yml（陈旧快照）显示压缩服务按 agent 作用域隔离（三个 `cordis:group`，isolate compaction: true）。顶层插件的 `ctx.compaction` **可能不是**某作用域 agent 实际用的那个实例。M3 前必须搞清作用域解析（必要时插件要挂进对应 group，或经 Event 监听而非直调）。
2. **Session 句柄**：`measure(session)` 需要 Session 对象；获取路径是 M1 的关键未知。
3. **compactNow 需要 agent 上下文**（`ManualCompactAgentContext`）——插件侧能否合法构造/获取，M3 前验证。
4. **CJK 计数低估**：占用比是估计值，决策阈值要留余量。
5. **激活安全**：插件 apply() 内任何异常只记录不抛（DSH 纪律：抛 = 条目装载失败）。参考 browser-kit 的 entry 薄壳 + impl mtime 热换模式（`F:\My Code\dsh-browser-kit\plugin\entry.mjs`）。

## 8. 部署（M1 第一步）

```powershell
# 1) profile package.json：dependencies 加
"@local/dsh-context-pilot": "link:F:/My Code/dsh-context-pilot/plugin"
#    bundles 加
"@local/dsh-context-pilot"
# 2) 在 profile 目录装链接（或手动 mklink /J 到 node_modules\@local\）
pnpm install
# 3) 重启 DSH，看插件激活日志
```

## 9. 参考资料索引

- `docs/context-control-exploration.md` —— 探索报告全文
- `docs/reference/*` —— 从 app.asar 抽取的官方包（compaction-basic README 含全部配置字段与压缩机制；token-meter README 含测量语义）
- `docs/reference/tools/asar-extract.cjs` —— asar 文件抽取脚本（改 WANT 列表即可抽任意源码；asar 路径 `D:\DeepSeek\resources\app.asar`）
- 运行时查询：会话工具 `cordis_inspect_list` / `cordis_inspect_query`（host Service 目录）
- 相关经验：`F:\My Code\dsh-browser-kit\pitfalls.md`（P30/P37/P38 等）；浏览器增强插件本体 `F:\My Code\dsh-browser-kit\`

## 10. 验收标准（项目完成定义）

1. 每轮 prompt 含实时用量三元组（上限/已用/占比），模型可正确复述；
2. 高占用 + 轻任务场景下，插件自动先压缩再执行，压缩事件出现在会话日志；
3. 低占用或重任务场景不误触发压缩；
4. 自身阈值可经 Config 配置，改后重启生效；
5. 插件任何异常不影响 DSH 主流程（激活安全零抛）。
