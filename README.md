# dsh-context-pilot — DSH 上下文智能压缩 + 智能思考插件

**当前版本 `v0.1.81`** · 逐版本更新见 [`docs/changelog.md`](docs/changelog.md) · 逐里程碑见 [`docs/milestones.md`](docs/milestones.md)。

> 面板名「上下文智能压缩」。一句话：**让长会话的上下文压力可见、可控，并把「何时压缩、留多少」交给模型决定**——
> 用工具调用触发、在下一步开始前落地，**本轮不中断、不注入消息、不伪造用户发言**。

## 它解决什么问题

| 长会话的痛点 | 这个插件怎么做 |
| --- | --- |
| 上下文快满了才发现，只能等系统自动压 / 手动 `/compact`，压完不知道丢了什么 | **每轮注入真实读数**（窗口 / 已用 / 占比），达标时附**压缩决策卡**给出"现在压会摘要掉多少"的数字 |
| 压缩时机由系统定，可能正好发生在关键推理中间 | **模型自己决定何时压**（工具 `compact_context`），插件在**下一步开始前**执行，本轮不中断 |
| 一刀切的保留比例：要么留太多浪费、要么丢太多返工 | **三档可选的近端保留预算**（8% / 16% / 24%），或按**语义锚点**精确指定"从哪条消息起原样保留" |
| 思考强度要么一直最高（贵）、要么一直最低（笨） | 可选**智能思考**：把当前档位与可选档告诉 Agent，由它按任务难度自主换档 |

## 核心能力与优点

| 能力 | 做法 | 好处 |
| --- | --- | --- |
| 读数透明 | 每轮 `Context usage` 行 + 趋势（每轮增量、距强制线轮数） | 不用猜"现在多满"，决策有数字依据 |
| 决策权给模型 | 决策卡：何时压 / 选哪档 / 锚点优先的两步顺序 | 模型看得到任务形态，比固定阈值更贴合实际 |
| 执行可控 | 按选定预算**自算保留范围**，边界交引擎校验；锚点绝不越过 | 压多少可预期、可追溯（回执给出保留预算与真实口径） |
| 零打扰 | 同轮不注入消息、不伪造发言、压缩后**继续任务** | 不打断推理链，也不用用户重发 |
| 异常安全 | 激活零抛；每处降级都留痕（不静默） | 插件故障不影响 DSH 主流程 |

## 两条压缩线（速查）

- **智能压缩线**（默认 30% 档）：模型可调 `compact_context` 主动压 —— 卡片出现时按卡上的数字判断；
- **强制压缩线**（默认 75% 档）：占用越线后**系统无条件代压**，按**当期会话档位**自算范围。

| 档位 | 近端保留预算 | 什么时候用 |
| --- | --- | --- |
| 深压 8% | 窗口 × 8% | 边界清晰、旧资料可从文件重读 |
| 标准 16% | 窗口 × 16%（默认） | 边界拿不准 |
| 浅压 24% | 窗口 × 24% | 近端证据不能过早只剩摘要 |
| 语义锚点 | 该位置之后**原样保留** | 能锁定"当前任务从哪条消息开始"时最精确 |

> 实验结论（601k 历史 / 1M 窗口）：**档位对任务成败与约束遵守没有可测影响**，真正的决定因素是摘要器；
> 详见 [`docs/compression-tier-experiment-2026-10-26.md`](docs/compression-tier-experiment-2026-10-26.md)。

## 智能思考（可选，默认关闭）

开启后：每轮注入当前思考档位 + 可选档；Agent 可调工具 `set_reasoning_effort` 自主换档（**本次任务内立即生效、任务不中断**）。
关闭时：提示词不注入、工具不注册（单档模型同样静默）。详见 [`docs/how-it-works.md`](docs/how-it-works.md)。

## 安装

```bash
# 从 GitHub 仓库安装（本项目**不分发 npm 包**，这是推荐路径；pnpm 规格）
dsh plugin --profile web add github:Shuffle-1992/dsh-context-pilot
```

> **分发方式（2026-10-10 决定）**：**不发布 npm**。安装一律走上面的 GitHub 仓库规格；
> `dsh plugin --profile web add dsh-context-pilot` 这条 npm 形式**在本项目不可用**（无 npm 包）。

安装后**重启 DSH** 生效（bundle 资格由本包 `package.json` 的 `dsh.bundle.patch` 声明，
patch 文件：`plugin/cordis.patch.yml`）。

<details>
<summary>本地开发挂载（本机已实测的路径）</summary>

profile `package.json` 两处要改（以本机 `desktop` profile 为例）：

```jsonc
{
  "dependencies": { "dsh-context-pilot": "link:F:/My Code/dsh-context-pilot/plugin" },
  "dsh": { "profile": { "bundles": [ /* … 其它 bundle …, */ "dsh-context-pilot" ] } }
}
```

再手工 Junction（可免 pnpm install）：`node_modules/dsh-context-pilot` → `<仓库>/plugin`。

> ⚠️ 插件 `package.json` **必须有 `dsh.bundle` 段**，否则 plugin-manager 报 `not-bundle` 并**静默跳过**
> （重启几次都不生效、host 无日志）——详见 [`docs/setup.md`](docs/setup.md) §2 坑 P1。
> 包名统一为 `dsh-context-pilot`（2026-10-10 起去掉 `@local/` 前缀）；旧挂载名 `@local/dsh-context-pilot`
> 仍可用 `plugin/cordis.patch.local.yml` 兼容，但新装请用正式名。

</details>

## 仓库结构

| 路径 | 作用 |
| --- | --- |
| `package.json`（根） | **可分发包清单**（name/version/license/repository/`dsh.bundle.patch`/`meta`）——市场按仓库根识别 |
| `plugin/` | 插件本体（`entry.mjs` / `client.js` / 域模块 / `icon.svg` / 两个 patch 文件）——也是本机 `link:` 挂载目标 |
| `test/` | 四套断言（contract / static / report / boot） |
| `docs/` | 设计与交接文档（含 `docs/setup.md` 部署矩阵、`docs/hub-publishing.md` 上架清单） |

## 当前状态

**已完成**：M1–M5（用量读取 / 每轮注入 / 会话自说明 / HUD 弹窗 / 历史持久化）、R1–R21
（智能思考 + 换档工具、压缩改工具触发、保留范围自算、全面审查加固、**压缩档位三选一**、
工具后自检回执、回执按会话隔离、**用户手动改档的轮首知情**、**单档模型零注入 + 工具静默**）。**9 个域模块 + core**，`host.impl.mjs` **1836 → 518 行**。
**测试**：contract 816 + static 84 + report 54 + boot 22 + client-render 33 = **1009 断言**全绿；关键回归均有变异验证。
逐里程碑台账（含踩坑与实测数值）：[`docs/milestones.md`](docs/milestones.md)；
早期进度历史存档：[`docs/status-archive.md`](docs/status-archive.md)。

## 快速验证

```bash
npm test    # 五套断言，< 1 秒
```

测试/取证细节（每套断言在测什么、怎么逐帧核对压缩是否真发生）见
[`docs/testing-and-forensics.md`](docs/testing-and-forensics.md)。

## 文档索引

| 你想了解 | 文档 |
| --- | --- |
| 机制与关键概念（降级链、两条线、锚点、智能思考、可改动点） | [`docs/how-it-works.md`](docs/how-it-works.md) |
| 安装/部署矩阵、热换与发布 | [`docs/setup.md`](docs/setup.md)、[`docs/hub-publishing.md`](docs/hub-publishing.md) |
| 配置项全表、成本模型、文案模板 | [`docs/configuration.md`](docs/configuration.md)、[`docs/cost-model.md`](docs/cost-model.md) |
| 测试与取证 | [`docs/testing-and-forensics.md`](docs/testing-and-forensics.md) |
| 版本更新 | [`docs/changelog.md`](docs/changelog.md) |
| 逐里程碑台账（含踩坑与实测数值，超长） | [`docs/milestones.md`](docs/milestones.md) |
| 设计风险与验收标准 | [`docs/design-risks.md`](docs/design-risks.md) |
| 压缩档位实验（8/16/24 与锚点的实测） | [`docs/compression-tier-experiment-2026-10-26.md`](docs/compression-tier-experiment-2026-10-26.md) |
| DSH 版本兼容复核（0.2.1） | [`docs/DSH-0.2.1-COMPAT-REVIEW.md`](docs/DSH-0.2.1-COMPAT-REVIEW.md) |
| 外部审查（任务书 + 23 条findings） | [`docs/review-brief.md`](docs/review-brief.md)、[`docs/review-findings.md`](docs/review-findings.md) |
| 调查报告（上下文压缩与推理能力） | [`docs/context-compression-reasoning-investigation-2026-10-26.md`](docs/context-compression-reasoning-investigation-2026-10-26.md) |
| 分领域设计/审查记录（R1 起） | `docs/r*.md`（如 [`docs/r5-retention-range-design.md`](docs/r5-retention-range-design.md)、[`docs/r7-review-and-hardening.md`](docs/r7-review-and-hardening.md)） |

> 本文只做入口；深入内容都在 [`docs/`](docs/)。
