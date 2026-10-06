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

## 再生成方式

`tools/` 下的脚本按需重抽（改 `WANT` 列表即可抽任意源码）：

- `asar-extract.cjs` —— 批量抽取（压缩/计量包源码 + README）
- `asar-extract-dsh-session.cjs` —— dsh-session 包
- `asar-extract-time-context.cjs` —— dsh-time-context 包（注入挂点参考实现）
- `asar-find-createUserMessage.cjs` —— 定位 `createUserMessage` 导出位置
- `asar-find-not-bundle.cjs` —— 排查 `not-bundle` 静默跳过问题

用法：`node docs/reference/tools/<script>.cjs`（脚本内 `OUT` 指向本目录）。

## 政策（对齐 `zcode-dispatch` 仓库惯例）

- 第三方材料**带许可/来源说明可入库**，无来源说明的不入库；
- 本目录只保留**查阅所必需**的最小集合；大体积无关副本不入库；
- 这些副本是**只读参考**，本项目对它们的任何修改都无意义（升级 DSH 后应重新抽取）。
