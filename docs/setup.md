# 环境、composition 与部署

> 从 README 拆出（2026-10-07）。面向「要在本机把插件挂起来 / 排查挂载问题」的场景。
> 交接必读的结论在 README §1–§2。

## 1. 环境事实（本机，已核实）

| 项 | 值 |
| --- | --- |
| DSH Desktop | 0.2.0-rc.2（Electron 44 / Chromium 152 / Node 24） |
| DSH 进程模型 | 主进程 + **RUN_AS_NODE 纯 Node 插件宿主**（插件 host 摸不到 Electron API——已实证，勿尝试） |
| Profile | `C:\Users\Administrator\.dsh\profiles\desktop\` |
| composition 来源 | ① `package.json` 的 `dsh.profile.bundles`（首个 `@deepseek-ai/dsh-base` = 基础 composition，压缩挂载来自这里）② `cordis.patch.yml`（profile 补丁层）③ 根 `cordis.yml` 恒为 `[]` |
| 本地插件挂载 | profile `package.json` 的 `dependencies` 加 `"@local/xxx": "link:<项目>/plugin"` + `bundles` 加 `"@local/xxx"` + **插件 package.json 必须有 `dsh.bundle` 段**（否则 not-bundle 静默跳过，见 §4 P1）；手工 Junction 进 `node_modules\@local\` 可免 pnpm install（browser-kit/本项目均实证）。重启 DSH 生效 |
| Inspect 工具 | 会话里有 `cordis_inspect_list/query`（host Service/Event/Config 目录可直接查——本报告服务签名即来自它） |

## 2. composition 的真相（踩坑复盘）

- **根 `cordis.yml` 恒为 `[]`，头部注释明言 "Edit cordis.patch.yml, not this file"**。它会被 DSH 归一化重写——**永远不要编辑它**。
- **坑 P1（2026-10-05 实证）：手工 link + dependencies/bundles 手工登记 ≠ 能挂载。** bundle 资格判据 = 插件 package.json **必须有 `dsh.bundle` 段**（如 `"bundle": { "patch": "./cordis.patch.yml" }`；patch 文件用 `- insert: - {id, name}` 行声明挂载，照抄 browser-kit）。缺段时 plugin-manager 报 `error: {"code":"not-bundle"}`，composition **静默跳过该 bundle**——重启几次都不会生效，host 侧无日志可查。源码依据：dsh-plugin-manager/lib/index.js `if (manifest?.dsh?.bundle === void 0) throw new ManagementFailure("not-bundle")`。排查利器：会话工具 `plugin_manager` 的 `list_bundles`（error 字段直接给答案）；asar 检索脚本 `docs/reference/tools/asar-find-not-bundle.cjs`。
- 本次实验曾把 thresholdRatio: 0.6 写进 cordis.yml（一份 1565 行的陈旧全量快照），**从未生效**，随后被 DSH 重写回 `[]`。当前生效配置 = dsh-base 内置默认（thresholdRatio 0.8）。
- 正确的调参路径（按优先级）：
  1. `cordis.patch.yml` 加同名挂载/配置做 profile 级覆写（**覆写语义需实验验证**——同 id 是替换还是合并未确认，M1 顺手验证）；
  2. `configEditor` 服务 `edit(entry, change)`（走正常 Loader 重载）；
  3. 直接改 asar 内 dsh-base（不可取，升级即失）。
- 压缩参数改动需重启 DSH 生效；改任何 profile 文件前先备份（目录里有 `.bak-*` 先例）。

## 3. 部署与热换

本机部署已于 2026-10-05 完成（两轮，第二轮补齐 bundle 资格）：

```powershell
# 已做：profile package.json dependencies/bundles 均加 dsh-context-pilot
#       （改前备份：package.json.bak-20261005-m1-context-pilot）
# 已做：node_modules\@local\dsh-context-pilot Junction → F:\My Code\dsh-context-pilot\plugin
#       （与 browser-kit 同款手工 Junction，未跑 pnpm install）
# 第一轮重启结果：not-bundle 静默跳过（见上文 P1）
# 已补：plugin/package.json 加 dsh.bundle 段 + plugin/cordis.patch.yml（insert 行）
# 第二轮重启：✅ 挂载成功，list_bundles 无 error，M1 验证通过
# 免重启热换（P3，2026-10-06 实证）：改 host.impl.mjs 后用会话工具 plugin_manager
#   set_plugin target="include:dsh-context-pilot"（⚠️ 必须 entry id 形式；bundle 名报 unknown-plugin）
#   先 enabled:false 再 enabled:true → apply 重跑 → mtime URL 换新 impl。
```

## 4. 部署矩阵（改哪个文件要做什么）

| 改动文件 | 生效方式 | 说明 |
| --- | --- | --- |
| `host.impl.mjs` | **toggle 热换** | `set_plugin include:dsh-context-pilot` false→true；entry 的 `?ts=mtime-seq` 换新模块 |
| `client.js` | **刷新页面** | 无 dev watcher，不热换 |
| `wire.host.mjs` | **重启 DSH** | 模块被静态 import 缓存（2026-10-06 起 impl 改为动态 import，改 wire 可随 impl 热换） |
| `plugin-config.schema.mjs` | **重启 DSH** | entry 静态导出 Config，loader 只认入口模块静态导出 |
| `entry.mjs` | **重启 DSH** | 薄壳，设计上永不改（改它就等于放弃热换能力） |
