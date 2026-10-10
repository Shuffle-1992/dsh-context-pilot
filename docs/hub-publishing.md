# 上架 DSH Plugin Hub / 社区市场：清单与现状（2026-10-10）

> 面向「把本插件发布到任一 DSH 插件市场」的场景。**先满足基础项，再选市场**。
> 每一项都标注了**取证方式**——不靠记忆，靠可复现的命令。

## 0. 基础项现状总览

| 基础要求 | 现状 | 取证 / 处置 |
| --- | --- | --- |
| **公开 GitHub 仓库**（私有仓库爬不到） | ✅ 公开 | 匿名 API：`Invoke-WebRequest https://api.github.com/repos/Shuffle-1992/dsh-context-pilot` → `visibility: public`、`private: false` |
| **Topic `dsh-plugin`** | ✅ 已加 | 同上 API 的 `topics` 数组 |
| **Topic `deepseek-harness`**（Cordis 插件建议） | ✅ 已加 | 同上 |
| 附带：`cordis-plugin` / `context-compression` / `context-management` / `reasoning-effort` / `dsh` / `deepseek` / `llm-agent` | ✅ 共 9 个 | 同上 |
| `dsh-skill` / `agent-skills` | ⛔ **不需要** | 这两个是 **Skill 包** 用的；本插件是 **Cordis Bundle**，加了反而误导 |
| **README 有可直接复制的安装命令** | ✅ 已补（README「安装」段） | `dsh plugin --profile web add dsh-context-pilot` |
| **package.json 的 name / version 准确** | ✅ `dsh-context-pilot` / `0.1.0` | 根 `package.json`；`version` 与 git tag `v0.1.0` 一致 |
| **Bundle 分发需 `dsh.bundle.patch`** | ✅ 根与 `plugin/` 两处都有 | 根 → `./plugin/cordis.patch.public.yml`；开发用 `plugin/package.json` → `./cordis.patch.yml` |
| **许可证** | ✅ MIT（`LICENSE`） | 原仓库无 license 字段；如需换协议只改 `LICENSE` + 两处 `package.json` 的 `license` |
| 仓库元数据（repository / homepage / bugs / keywords / author） | ✅ 已补 | 根 `package.json` |

**复核命令（匿名、只读，一条就够）**：

```powershell
$j = (Invoke-WebRequest https://api.github.com/repos/Shuffle-1992/dsh-context-pilot -UseBasicParsing).Content | ConvertFrom-Json
$j | Select-Object full_name, private, visibility, license, homepage, topics
```

## 1. 关键结构决策：**仓库根 = 可分发包，`plugin/` = 代码 + 本地开发身份**

市场爬虫按**仓库根**的 `package.json` 识别插件；而本机开发时 profile 以
`"@local/dsh-context-pilot": "link:.../plugin"` 挂载（包根是 `plugin/`）。
两个身份都必须存在，且**包名必须与各自 patch 里 `name` 一致**（加载器按包名解析）：

| 场景 | 包名 | manifest | bundle patch |
| --- | --- | --- | --- |
| 市场 / npm / GitHub 安装 | `dsh-context-pilot` | 根 `package.json` | `plugin/cordis.patch.public.yml` |
| 本机开发（`link:` 挂载） | `@local/dsh-context-pilot` | `plugin/package.json` | `plugin/cordis.patch.yml` |

> 为什么不在根沿用 `@local/`：**npm 的 `@local` 作用域不可发布**（非本人 scope），
> 市场安装会失败。故公开包名取无作用域的 `dsh-context-pilot`。
> 本机 profile **无需任何改动**——它仍然 link `plugin/`（那次改造 0 风险）。

## 2. 上架前最后三步（人工，需 GitHub 权限）

1. **发布到 npm**（若要 `add <包名>` 这条最顺的路径）：
   ```bash
   npm publish --access public     # 根 package.json，files 已限定 plugin/ + README + LICENSE
   ```
   > 未发布也能装：用 `dsh plugin --profile web add github:Shuffle-1992/dsh-context-pilot`（pnpm 规格）。
2. **打 tag / 建 Release**（可选但利于市场展示版本）：`git tag v0.1.0 && git push origin v0.1.0`。
3. **按所选市场提交**：填仓库 URL + 包名 `dsh-context-pilot`；若市场要求 Bundle 清单，
   指向 `plugin/cordis.patch.public.yml`。

## 3. 自动化护栏（防止这些要求日后漂移）

`test/static.mjs` 里有对应断言（**根清单必需字段 + 两处 patch 与包名一致 + README 安装命令存在**），
`npm test` 会一并校验。改动清单文件后若断言变红，说明上架基础项被破坏了。
