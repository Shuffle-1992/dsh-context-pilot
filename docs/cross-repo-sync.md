# 两仓同构点与同步清单（D2）

> **背景**：`dsh-context-pilot` 与 [`dsh-browser-kit`](https://github.com/Shuffle-1992/dsh-browser-kit)
> 都是 DSH 宿主侧插件，共享同一套「入口薄壳 + mtime 热换 + remote face 轮询」机制。
> 因**各自独立部署**（profile Junction + 独立 client.js）且**无共享构建**，样板代码只能复制。
>
> **本清单的作用**：明示「改一处须同步另一处」的边界，避免两边漂移。
> **依据**：2026-10-07 逐文件对照实测（`git` 两仓同版本比对 + 关键模式扫描）。
>
> ⚠️ **重要前提**：同步 ≠ 盲目复制。两仓存在**有意为之的实现差异**（见 §4），
> 那些地方**不要**强行统一。判断依据是各自仓库的实测记录（`pitfalls.md` / `docs/`）。

---

## 1. 强同步点（改一处必须同步另一处）

这些是**协议/契约层**，漂移会导致**静默失败**（不报错、只是功能不通）。

| # | 位置 | 同步内容 | 漂移后果 |
| --- | --- | --- | --- |
| **S1** | `wire.host.mjs` 的 `REMOTE_METHOD_DESCRIPTOR` | 常量值必须是 `@deepseek-ai/dsh-typert-protocol/remote-methods` | face 方法无法被 `typertGateway` 认领 ⇒ 远端面注册静默失败 |
| **S2** | `wire.host.mjs` 的 `FACE_METHOD_TABLE` 结构 | `[方法名, 参数名[], 签名, 可选参数名[]]` 四元组 | TYPERT 声明生成错误 ⇒ RPC 参数校验失败 |
| **S3** | `wire.host.mjs` 的 `TYPERT` 三处派生 | `invocations` / `model.members` 必须从 `FACE_METHOD_TABLE.map` 派生；`service`/`namespace` 引用 `FACE_NAME` | 出现第二份清单 ⇒ 两处不一致时以哪份为准不明 |
| **S4** | `entry.mjs` 的薄壳形态 | ① 静态 `export const Config` ② `import('./host.impl.mjs?ts=<mtime>-<seq>')` ③ `activationSeq` 自增 ④ 有效代码 <40 行 | ②漏 `?ts=` ⇒ 改 impl 不生效（P16）；①漏 ⇒ 配置区不出现 |
| **S5** | `package.json` 的 `dsh.bundle.patch` | 指向 `./cordis.patch.yml` | 缺 `dsh.bundle` 段 ⇒ **not-bundle 静默跳过**（P1，重启也不生效） |
| **S6** | `package.json` 的 `exports` 键 | 至少 `.` / `./client` / `./typert` 三个 | 宿主按 `exports["./typert"]` 找 TYPERT ⇒ 缺则自动发现失败 |
| **S7** | `client.js` 的 client→host 消费范式 | ① `ctx.inject` 回调参数是 **scope**，服务在 `scope.remote.<名>` ② remote 代理返回 **`{ok,value}` 信封**，必须 unwrap ③ `inject` 声明**必须含 `typert`**（`$mount` 硬依赖） | 三连环空态（本仓在 2026-10-06 逐一实证踩坑，browser-kit `client.js:504/579/2098` 是同款先例） |

> **S7 是三端对账的核心**：`test/contract.mjs` 已把它纳入自动断言（本仓）。

---

## 2. 弱同步点（结构应对齐，内容各自独立）

| # | 位置 | 同步什么 | 不变量 |
| --- | --- | --- | --- |
| **W1** | 目录布局 | `plugin/{entry.mjs, host.impl.mjs, wire.host.mjs, client.js, plugin-config.schema.mjs, cordis.patch.yml, package.json}` | 文件名一致（便于跨仓查找与工具复用） |
| **W2** | `host.impl.mjs` 的 `apply(ctx, config, { pluginDir, reportPath })` 签名 | 第三参数注入 `pluginDir`/`reportPath` | 报告落盘路径约定 |
| **W3** | 报告落盘形态 | `{ plugin, purpose, updated, history: [...] }`，`history` 环形 cap | 取证工具可跨仓复用（本仓 `dump-report.cjs` 按此形状写） |
| **W4** | `plugin-config.schema.mjs` 的 schemastery 四级候选链 | 裸 import → `resourcesPath` 推导 → env 逃生口 → 硬编码本机位；`CANDIDATE_FILES` 列表一致 | 解析失败须**返回 undefined**（`export const Config = undefined` ⇒ DSH 视为 absent，插件照常工作） |
| **W5** | `cordis.patch.yml` 的挂载形态 | `- insert: - { id, name }` | id 须唯一；name 是包名 |

---

## 3. 部署矩阵（两仓一致）

| 改动文件 | 生效方式 |
| --- | --- |
| `host.impl.mjs` | plugin toggle 热换（`set_plugin include:<entry-id>` false→true） |
| `client.js` | 刷新页面 |
| `wire.host.mjs` | **重启 DSH**（但**仅当参数表/方法名/invocation 变更**；只改返回体签名注释属纯文档） |
| `plugin-config.schema.mjs` | **重启 DSH**（entry 静态导出） |
| `entry.mjs` | **重启 DSH**（薄壳，设计上永不改） |
| 面板配置字段 | **即时生效**（host 活读 config） |

---

## 4. 有意差异（**不要**强行同步）

这些是两仓在各自场景下**实测得出的不同选择**，同步反而会引入 bug。

| 差异点 | browser-kit | context-pilot | 依据 |
| --- | --- | --- | --- |
| **schema 字段是否 `.volatile()`** | ❌ 全部不用 | ✅ 全部使用 | 本仓注释：DSH 设置写入门禁要求条目存在 volatile 字段，否则面板保存被**静默拒绝**（`set()` 照样 resolve）——zcode 实测。browser-kit 在其配置面上未触发该问题 ⇒ **按各自实测，勿盲目抄** |
| **client 规模** | 2417 行（含大量 UI 注入：批注徽标/调试面板/多窗口联动） | 857 行（配置卡片 + 弹窗两行 + 计算器） | 功能域不同：browser-kit 是浏览器增强（高 DOM 交互），本仓是上下文治理（低 UI、高运行时逻辑） |
| **host 规模** | 705 行 | 1392 行（六代里程碑累积，待 D1 切分） | 本仓 host 承担上报/压缩/HUD/恢复多通道，且逐项取证字段多 |
| **client 依赖** | 无 `settingsScope` 闭包 | 有（配置卡片 + 弹窗开关共用） | 配置面需求不同 |
| **额外导出** | `./locale/*.json`（多语言） | 无 | browser-kit 有本地化文案 |
| **面方法数** | 多（截图/批注/统计等） | 1（`getHud`） | 功能域不同 |

---

## 5. 漂移检测（建议做法）

**手动**（改完任一强同步点后）：

```powershell
# 逐项对比两仓的强同步点常量
node -e "
const fs=require('fs');
const pairs=[
  ['REMOTE_METHOD_DESCRIPTOR','wire.host.mjs',/Symbol\.for\(['\"]([^'\"]+)/],
  ['FACE_METHOD_TABLE 结构','wire.host.mjs',/const FACE_METHOD_TABLE = \[[\s\S]*?\[\s*'([^']+)'/],
];
for(const [name,file,re] of pairs){
  const a=re.exec(fs.readFileSync('F:/My Code/dsh-browser-kit/plugin/'+file,'utf8'))?.[1];
  const b=re.exec(fs.readFileSync('F:/My Code/dsh-context-pilot/plugin/'+file,'utf8'))?.[1];
  console.log((a===b?'✅':'⚠️'), name, '| bk='+a, '| cp='+b);
}
"
```

**自动化**（可选，未实施）：在两仓各建 `test/cross-repo.mjs`，对 S1–S6 做断言。
本仓 `test/contract.mjs` 已覆盖**仓内三端对账**（S2/S3/S6 + 配置字段），
跨仓对账需读另一仓文件 ⇒ 属可选增强，且会引入**跨仓路径依赖**（两仓不同步时会误报）。

---

## 6. 维护约定

- 改任 **S1–S7** 项后：**同步另一仓** + 跑各自测试（本仓 `npm test`）
- 改 **W1–W5** 项后：检查另一仓是否受影响（不必强改，但需确认）
- 遇 **§4 差异**：不强行统一；若认为应统一，先在**各自仓库**用实测证据确认
- **新增强同步点**：补进本清单对应表格（含漂移后果）
