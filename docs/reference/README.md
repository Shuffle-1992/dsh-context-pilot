# docs/reference —— 第三方（DSH 官方）材料说明

本目录存放从 DSH Desktop 安装包（`D:\DeepSeek\resources\app.asar`）抽取的**官方包源码/文档副本**，
仅用于离线查阅 API 形状（本机无法直接浏览 asar 内源码）。**非本项目产物，请勿修改。**

## 来源与许可

| 抽取包 | 版本 | 许可 |
| --- | --- | --- |
| `@deepseek-ai/dsh-compaction-basic` | 0.2.0-rc.2 | MIT |
| `@deepseek-ai/dsh-compaction` | 0.2.0-rc.2 | MIT |
| `@deepseek-ai/dsh-token-meter` | 0.2.0-rc.2 | MIT |
| `@deepseek-ai/dsh-session` | 0.2.0-rc.2 | MIT |

来源：DSH Desktop 安装目录内 `app.asar` 的 `/dsh/node_modules/@deepseek-ai/<pkg>/`。
文件命名为路径扁平化（`__` 分隔），例如
`__dsh__node_modules__@deepseek-ai__dsh-token-meter__lib__index.js`
= `/dsh/node_modules/@deepseek-ai/dsh-token-meter/lib/index.js`。

> 各包 `package.json` 声明 `license: MIT`、`private: false`（抽取时核对，2026-10-06）。

## 用工具重新抽取

`tools/` 下是**统一工具**（2026-10-07 收敛，此前的 7 个一次性脚本已合并删除）：

### `asar-query.cjs` —— 查询 DSH 安装包

```bash
node tools/asar-query.cjs list --filter dsh-compaction        # 列文件
node tools/asar-query.cjs pkg   --path "/dsh/node_modules/@deepseek-ai/dsh-session/package.json"
node tools/asar-query.cjs grep  --pattern compactIfNeeded --ext js --ctx 3
node tools/asar-query.cjs extract --paths "/dsh/node_modules/@deepseek-ai/dsh-token-meter/lib/index.js" --out .
```

默认 asar 路径 `D:\DeepSeek\resources\app.asar`，可用 `--asar` 覆盖。

### `dump-report.cjs` —— 读插件取证报告

```bash
node tools/dump-report.cjs                  # 概览 + 尾部条目
node tools/dump-report.cjs --tail 20        # 尾部 N 条
node tools/dump-report.cjs --kind m3-act    # 按 reason 过滤
node tools/dump-report.cjs --field m3.eff   # 取最近一条的某字段
node tools/dump-report.cjs --history-acts   # 压缩历史（含 hud-acts.json）
```

默认读 `plugin/.data/m1-report.json`，可用 `--report` 指定。

> ⚠️ **路径约定（踩过坑）**：报告的 `m3`/`m5`/`m55` 块在**每个 history 条目上**，不在报告顶层。
> 早期脚本按顶层读会拿到 null——统一工具已修正。


## 政策（对齐 `zcode-dispatch` 仓库惯例）

- 第三方材料**带许可/来源说明可入库**，无来源说明的不入库；
- 本目录只保留**查阅所必需**的最小集合；大体积无关副本不入库；
- 这些副本是**只读参考**，本项目对它们的任何修改都无意义（升级 DSH 后应重新抽取）。
