# NOTICE — 来源与许可

本包（`dsh-shell-kit`）由本机开发，许可证 MIT。

## 已包含的代码来源

| 本包路径 | 来源 | 许可 |
|---|---|---|
| `index.js`、`lib/**`、`client.js`、`bin/**`、`test/**` | 本机自研；逻辑与代码来自本仓库的前身 `dsh-quick-restart`（同一作者，MIT） | MIT |

**目前本包不包含任何第三方源码副本。** 下面的"设计参考"只借用了思路与协议，
不是代码搬运；一旦真的搬运了代码，必须在这里逐个文件列出，并保留原许可声明。

## 设计参考（读了但未复制代码）

- **DSH Desktop** — `github.com/dataelement/dsh-desktop`，v0.1.1，MIT，
  Copyright (c) 2026 DataElement。参考点：
  - 渲染端桥 `window.dshDesktop.restartHarness()` + IPC `harness:restart` 的重启路径，
    以及"装完需要重启时由壳来重启"的做法（`packages/dsh-desktop-market-installer/client.js`、
    `src/main/index.ts` 的 `restartHarness()`/`launchHarness()`）；
  - 插件启动失败的归因链（`[harness-node] plugin failures:` 结构化行 +
    日志启发式 + 引用→profile 插件映射），见 `src/main/plugin-recovery-detection.ts`、
    `src/main/state/plugin-recovery.ts`；
  - 禁用宿主插件用**独立覆盖层**文件而不是改 profile patch 的做法
    （`src/main/state/host-disabled-plugins.ts`）。
- **DSH / DeepSeek Harness** — `@deepseek-ai/dsh-*`（官方运行时与客户端）：
  只通过公开的 Cordis 服务与 Web 路由交互，不复制其代码。
- **dshmarket**（第三方插件市场）— 只参考了它的重启守卫口径
  （回环直连 + 自定义头 + 拒绝转发请求），未复制代码。

## 上游许可要求的履行方式

若后续模块（例如 `doctor`、`profile`）移植了 DataElement 的源码或其衍生实现，
该模块目录下必须同时放入：

1. 原项目 `LICENSE` 的完整副本（MIT，Copyright (c) 2026 DataElement）；
2. 一个 `NOTICE.md`，写明来源仓库、commit、原文件路径、以及本包做了哪些修改；
3. 源码文件头部保留原始版权声明。

`ppt-runtime` 一类包含第三方 vendored 代码（`upstream/`）的部分**不按 MIT 直接处理**，
移植前单独核对每个 upstream 的许可证。
