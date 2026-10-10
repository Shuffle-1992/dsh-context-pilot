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

## 1. 结构：**单一身份** `dsh-context-pilot`

2026-10-10 起包名统一为 `dsh-context-pilot`（去掉 `@local/` 前缀），三处必须一致：

| 位置 | 值 |
| --- | --- |
| 根 `package.json` → `name` | `dsh-context-pilot` |
| `plugin/package.json` → `name` | `dsh-context-pilot`（`private: true`，仅作本地挂载目标，不发布） |
| `plugin/cordis.patch.yml` → `insert[0].name` | `dsh-context-pilot`（加载器按**包名**解析） |

- 仓库根 = **可分发包**（市场爬虫按仓库根识别）；`plugin/` = 代码 + 本地挂载目标。
- 本机 `node_modules` 下**两个 junction 指向同一目录**：
  `dsh-context-pilot`（新，正式）与 `@local/dsh-context-pilot`（旧，兼容别名，勿删以免打断运行中的挂载）。
- `plugin/cordis.patch.local.yml` 是**兼容补丁**（name = 旧别名），仅供回滚/旧挂载使用；
  生产与新装一律走 `plugin/cordis.patch.yml`。

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
