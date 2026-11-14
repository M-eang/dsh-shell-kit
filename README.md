# dsh-shell-kit

**给 DeepSeek Harness 加一套进程运维工具：一键重启、实时日志流、HMR 热更新、端口排查、profile 体检、预设管理。**

形态是**一个安装包 + 多个功能模块**：每个模块自己挂路由 / 命令 / 工具，只共享
`lib/core.js`（路径、profile 探针、日志/报告留档、进程与插件运行状态、HTTP 守卫与
命令/工具接线）与 `lib/profile-audit.js`（doctor 与 profile 共用的**只读**静态审计）；
模块可以单独关掉（配置里 `modules.<name>: false`），一个模块坏了也只
记日志、不影响其它模块（动态 import + 逐模块 try/catch）。

| 模块 | 状态 | 能力 |
|---|---|---|
| `restart` **一键重启** | ✅ 已可用 | 设置页卡片、桌面端标题栏「重启」按钮、`/restart` 斜杠命令、`restart_dsh` 智能体工具、CLI；优先请桌面端壳重启，没有通道时由本插件整应用重启 |
| `doctor` 插件诊断 | ✅ 已可用 | 活体 loader 阶段 + profile 静态面 + 宿主崩溃报告，给带证据的结论：`/diag` 命令、`diagnose_plugins` 工具、`GET /api/shell-kit/doctor/report` |
| `profile` 配置体检与修复 | ✅ 已可用 | 复用 doctor 的静态审计，把坏条目用官方覆盖行停掉（先备份、默认 dry-run）：`/fix` 命令、`fix_profile` 工具、`/api/shell-kit/profile/{plan,apply,restore}` |
| `logs` 宿主日志 | ✅ 已可用 | 用 cordis 的 `ctx.logger.exporter()` 收全部级别的日志记录（并按穿透方式兜住 stdout/stderr），落盘成 `harness-<日期>.log`：`/logs` 命令、`read_harness_log` 工具、`/api/shell-kit/logs/{list,tail,stream}` |
| `hmr` 热重载 | ✅ 已可用 | 从活体 loader 报告官方 `dsh-hmr` 的结论（配置热生效 / 源码也热生效 / 停用 / 不在）、记录 `hmr/change` 与 `hmr/reload` 事件、`/api/shell-kit/hmr/{status,events}`。**只报告不触发**（官方没给可编程入口）；重启仍然只走 `restart` 模块 |
| `presets` agent 预设 | ✅ 已可用 | 巡检旧格式 `.agent-presets` 遗留目录（当前版本已不读）并生成迁移 bundle 骨架：`/presets` 命令、`audit_presets` 工具、`/api/shell-kit/presets/report`。只生成不安装，安装仍走官方 `plugin_manager` |

设计参考与许可来源见 [NOTICE.md](NOTICE.md)（目前本包不含第三方源码副本）。

**聚合状态**：`GET /api/shell-kit/status`（只接受本机回环）把各模块的状态摊平成一份 JSON ——
`modules.<name>.{enabled,mounted,error,label,status}`、`profileChanges`（本进程启动后
profile 的权威输入文件变过没有），以及 `diagnostics.traceFailures`（面包屑写盘失败的次数）。
设置页卡片用的就是它；重启窗口里的等待循环则只打轻量的 `GET /api/shell-kit/restart/status`。

---

## 模块：一键重启

桌面端经常提示「N 项变更需重启 DeepSeek Harness 后生效」，而官方端那个提示旁边并没有
按钮（市场自带的重启按钮对桌面端是硬编码关闭的）。这个模块补上这一步。

### 走哪条通道（优先桌面端壳）

和 DSH Desktop 自带插件（插件市场安装器 / workbench / 图像生成）一样：**先看壳有没有
提供重启通道**，有就交给壳，没有才用自带助手。

| 通道 | 判据 | 行为 | 代价 |
|---|---|---|---|
| 桌面端壳 | 渲染进程里有 `window.dshDesktop.restartHarness()` | 请壳把 Harness 子进程停掉再拉一个新的；窗口保留，还顺带跑壳自己的 profile 维护（迁移 / generation / 待移除插件） | 约 3-6 秒 |
| 自带助手 | 没有上面的桥（例如官方端 0.2.0-rc.2） | 杀掉壳+宿主，按原命令行把整个应用重新拉起来 | 约 10-18 秒 |

调壳之前本模块会先过自己的守卫（插件操作进行中就不重启，避免把 node_modules 写坏）；
壳拒绝或调用失败会回落到自带助手，并把原因写进界面提示。

### 自带助手做了什么

点下按钮后：宿主写意图文件 → 拉起重启助手并确认它真的在跑
→ 助手等几秒、放一只看门狗 → 按精确 PID 先杀壳再杀宿主 → 等旧实例退出、等端口释放 →
用**与原来相同的可执行文件和命令行**重新启动（并清掉 `ELECTRON_RUN_AS_NODE`，否则新进程
会进纯 Node 模式、没有窗口）→ **先摆窗口**（最大化 / 最小化 / 普通矩形，按重启前抓到的
状态还原）→ 再等端口回来 → 写报告。看门狗一分钟左右醒一次，应用没回来就自己补一次启动。

窗口恢复**必须排在等端口之前**：宿主的端口是每次启动随机挑的，拿旧端口去等只会耗满超时，
用户先白看一分钟的小窗口——助手万一在这段路上退出，窗口就永远没人管。所以旧端口最多等 20 秒，
之后用 `netstat -ano -p TCP` 按新实例**及其子进程**反查它真正监听的端口（端口通常开在壳拉起的宿主进程里，
只看根 PID 会永远找不到），查到就算恢复成功，报告里会写一句
`port X never came back; new instance listens on Y instead`。两条证据一起盯，谁先成立就收工，不把超时耗满。

Windows 上助手**优先用 WMI 拉起**（`Win32_Process.Create`，由 `WmiPrvSE.exe` 创建，因而
不在宿主的作业对象里），失败或三秒内没写出日志才退回 detached 的 Node 进程。原因是桌面端
给宿主设了 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`：`detached` 只设 `DETACHED_PROCESS`、不设
`CREATE_BREAKAWAY_FROM_JOB`，于是助手一旦按设计把壳/宿主杀掉，作业关闭会把它自己也带走，
重启就断在半路。

这条路上的配方是实测出来的，别改回去（2026-10-14 复核）：

| 做法 | 结果 |
| --- | --- |
| WMI 创建**内层 PowerShell** 再 `Start-Process` | 返回码 0、也给了 PID，但内层 PowerShell 在这个环境里**根本没执行**（连 `-RedirectStandard*` 的文件都没生成） |
| WMI 创建 **`cmd.exe`** 跑 `.cmd` 包装脚本 | 无空格的路径可以；路径一带空格（`""…""`、`call`、`cd /d` 各种写法都试过）静默失败 |
| `$startup.EnvironmentVariables` 只填自己要的两个变量 | 子进程丢了 `SystemRoot`/`TEMP`，node 起不来——**该属性是整块替换，不是追加** |
| **WMI 直接创建 Electron 二进制，并把完整环境变量块交给 `Win32_ProcessStartup.EnvironmentVariables`** | ✅ 不经过任何 shell、带空格的路径也能跑，子进程拿到 `ELECTRON_RUN_AS_NODE=1` 与完整环境，PID 就是真正执行脚本的那个进程 |

外层 PowerShell 用 `-EncodedCommand`（UTF-16LE base64）送进去，`$startup.ShowWindow = 0`
抑制 GUI 子系统的窗口；助手配置走 `--config-file`（纯 ASCII 路径），避免引号被二次解析。
环境变量块过大（base64 超过 24000 字符，Windows 命令行装不下）时**主动退回 detached**，
而不是发一条会被截断的命令行。`test/wmi.test.js` 会真跑一次这条路线：替身脚本在带空格的
临时目录里写出 `{runAsNode, systemRoot, pid}`，断言三件事——进程真的执行了、
`ELECTRON_RUN_AS_NODE=1` 确实传到了、WMI 报的 PID 与写文件的进程是同一个。

“等端口释放”的判据是**只有 `ECONNREFUSED` 才算释放**：连接超时、无路由、权限拒绝这类
“没能观测”的结果一律按“可能仍在监听”继续等，否则助手会按旧端口抢跑，新实例撞上旧宿主。

> 壳的启动参数由**助手**自己去查（`Get-CimInstance Win32_Process` 拿 pid 的 CommandLine，
> 懒求值、只查一次）：这件事以前在宿主里做，而它是一次同步 PowerShell 查询，
> 最坏能把宿主的事件循环卡 4 秒 —— 为此把它挪到了这个短命的一次性进程里。

### 重启后窗口状态

壳自己不持久化窗口几何（`resources/app/lib/main.js` 的 `createWindow()` 写死 `1280×820`，
也没有 `--fullscreen` / `--maximized` 这类参数），默认每次重启窗口都会缩回去。插件把这个补上了：

- 杀壳**之前**用 `GetWindowPlacement` 记下 `showCmd` 与矩形，摘要写进意图文件；
- 助手（以及接管的看门狗）在新壳起来之后，按记下的状态用 `ShowWindow(SW_SHOWMAXIMIZED)`
  或 `SetWindowPos` 摆回去，结果落在报告的 `windowRestore` 字段里。

三条边界：

- Electron 的真全屏（`setFullScreen`）是主进程内部状态，外部复原不回来，会**降级成最大化**
  （铺满工作区，标题栏还在）；
- 记录时窗口是**最小化**的：Windows 对最小化窗口的 `GetWindowRect` 返回 `-32000` 附近的占位矩形
  （窗口仍然「可见」，只是被挪到屏幕外），照那个坐标摆回去等于把窗口丢出屏幕。这一路改用
  `GetWindowPlacement` 的 `rcNormalPosition`（最小化前的几何），恢复时先 `SW_RESTORE` 还原、
  再 `SetWindowPos` 定位，报告里 `restored: true`；
- 抓不到窗口（比如壳当时没有主窗口）就是 `null`，重启照常进行。
关掉它：给宿主设环境变量 `DSH_SHELL_KIT_WINDOW_STATE=0`。

产物都在 `$DSH_HOME\dsh-shell-kit\restart\`（未设 `DSH_HOME` 时回落 `%USERPROFILE%\.dsh`）：

| 文件 | 内容 |
|---|---|
| `restart.log` | 每次重启的时间线（助手与看门狗都写这里；超过 512KB 轮转） |
| `last-report.json` | 上一次重启的结局：`outcome`、杀了哪些 PID、端口是否恢复、耗时 |
| `reports/` | 最近 20 份报告留档（每次启动把上一份挪进来） |
| `last-intent.json` / `watchdog-report.json` | 谁、何时、延迟多久发起；看门狗的判决 |
| `helper/` | 助手脚本的运行副本（`restart-helper.mjs` + 它 import 的 `ports.js`、`window-state.mjs`；源文件在 `lib/modules/restart/`） |
| `helper-stderr.log` | 助手自己的错误输出。**排查「助手没能启动」先看这里**：进程起不来时日志一行都不会有，真话只在这个文件里 |
| `helper-config.json` | 最近一次交给助手的配置（给 WMI 那条路用的 `--config-file`） |

### 五种用法 + 命令行

| 入口 | 怎么用 |
|---|---|
| 标题栏菜单栏 | 桌面端左上角「应用 / 编辑」旁边多一个「重启」（浏览器里不出现） |
| 设置页卡片 | **设置 → Shell Kit → 立即重启** |
| 斜杠命令 | `/restart`（`/restart force` 跳过插件操作与静默期检查） |
| 智能体工具 | 说「重启一下 DeepSeek Harness」（`restart_dsh`） |
| 命令行 | `node bin/dsh-shell-kit.mjs --status / --restart [--wait] [--force]` |

标题栏那个按钮点一下先弹确认框，然后与设置页卡片走同一条重启通道；排上之后按钮变成
「重启中…」，进程回落后页面自动刷新。它由客户端半边在桌面端注入，不出现就说明当前不是
桌面窗口（或本插件没在 profile 里）。

去重与静默期：延迟还没到点、或者上一次重启刚发起（延迟到点后再加 15 秒静默期）时，
除非带 `force`，否则不会排第二次 —— 界面和 CLI 的「跳过插件操作与静默期检查」说的就是这件事。

---

## 模块：插件诊断（doctor）

**回答一个问题：这套插件组合现在健康吗？如果不健康，是谁、在哪一步、证据是什么。**

三个数据源互相补位：

| 数据源 | 看什么 | 能抓到什么 |
|---|---|---|
| 活体 loader | `ctx.loader.entries()` 里每个条目的 fiber 阶段 | fiber 起不来的条目（`failed`）、**没有存活 fiber 且包不存在**的条目 |
| profile 静态面 | `cordis.patch.yml` 的行、`package.json` 的依赖与 `dsh.profile.bundles` | name 非法（被粘了注释这种）、引用了没装的包、`link:` 指向不存在的目录、组合包里列了没装的、同 id 重复、`disabled` 值可疑 —— **下一次启动才会炸的问题提前看见** |
| 宿主崩溃报告 | `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-host.log` | 宿主 stderr 里的 `Cannot find package`、`[harness-node] plugin failures:` 结构化行、重复 entry id、slot 冲突。第三方壳（`dsh-desktop`）的历史日志只作提示，不算当前错误 |

三种用法：

```bash
/diag                                          # 斜杠命令，直接看结论
GET /api/shell-kit/doctor/report               # JSON + 渲染好的文本
# 智能体工具：diagnose_plugins（可加 full 取全部发现）
```

只读、只报告，不替你改配置 —— 改配置的事交回用户或 agent 决定。报告里每条发现都带**证据**（`文件:行号` 或 `live loader`），并按 错误 / 警告 / 提示 分级；健康的 profile 上不该有任何错误（本机 212 个条目、185 个 active 的组合跑出来是 0 错 0 警，只有 3 条历史提示）。

报告按 10 秒 TTL 缓存：`GET /api/shell-kit/status` 里的 doctor 摘要与 `/diag` 都读同一份，
而 `diagnose_plugins` 工具总是强制重新体检（要的是"现在"的结论）。
崩溃报告只扫末尾 4 MB，且每类发现在单个文件里最多收 20 条（超出的记一条"同类过多"提示），
免得一份反复失败的日志把报告撑到几千条。

---

## 模块：配置体检与修复（profile）

与 doctor 的分工：**doctor 只看，profile 能修**。修的方式就用官方那套**覆盖行**——
往 profile 的 `cordis.patch.yml` 写 `- id: X` + `disabled: true`（插件市场写开关也是这个写法），
坏条目在下次组合时被跳过，profile 就能起来了。**同一个 id 已经有覆盖行就就地改写它**
（保住这行自己的 `config` 等键，不再堆出第二条重复行），没有才追加新行。

三条刻意的铁律：

1. **写前必先备份**：`cordis.patch.yml.bak-shellkit-<时间戳>`，并同时写一份
   `apply-<时间戳>.md`（本次写了什么、怎么回滚）；
2. **任何写入都要显式确认**：工具与命令默认只给方案（dry-run），要写必须 `apply: true` / `/fix apply`；
3. **只动 `cordis.patch.yml` 这一层**：删依赖、删 `node_modules` 里的 junction 这类动
   `package.json` / 文件系统的操作只给手工命令，不代劳；写失败会尝试用备份回滚。

写入本身走三步：**先合并 → 自审 → 原子替换**。合并结果里每条动作都要能读回目标值、
原有条目一条都不能少（读不回来就直接拒绝写入）；落盘是先写同目录临时文件再 `renameSync`
覆盖，避免留下半截 YAML。返回的回执带 `changes[]`（哪条是就地改写、哪条是新增）、
`atomic`、写入前后字节数。

```bash
/fix                     # 只看方案（可修项 + 需手工处理的项 + 备份数）
/fix apply               # 真的写入（先备份）
GET  /api/shell-kit/profile/plan
POST /api/shell-kit/profile/apply    {"confirm":true}
POST /api/shell-kit/profile/restore  {}            # 回滚到最近一份备份
# 智能体工具：fix_profile（默认 dry-run；apply:true 才写）
```

被覆盖行停用的 id 不会再被审计报错（否则"修完还一直报"，用户会以为没修好）。
实测闭环：注入坏条目 → 方案列出 1 项 → 确认写入 → 复检 0 项、doctor 0 错 → 回滚 → 问题重现。

---

## 模块：宿主日志（logs）

打包后的桌面端，Harness 宿主的 stdout/stderr 只被壳 pipe 走，**没有文件** ——
插件在运行期吐的告警、装载期的错误，事后都查不到。这个模块把它们落盘：

| 来源 | 怎么拿到的 | 拿到什么 |
|---|---|---|
| cordis logger 记录（首选） | `ctx.logger.exporter({ levels: { default: 999 } })` | 结构化记录，格式化成 `[ISO] [级别] [logger 名] 正文`；**包含别的插件与宿主自己打的日志**，且不受宿主打印级别影响 |
| stdout / stderr（兜底） | 穿透式包一层 `process.stdout.write` / `process.stderr.write`（原样调用原函数，绝不吞输出） | 任何直接往流里写的东西（loader 的原始 stderr、插件的 `console.log`） |

> 兜底那条可以关：`config.logs.captureStdio: false` 时只保留 cordis 的结构化记录，
> 不再包流（在意"每一次输出都过一次缓冲"这点开销时用）。首选那条始终保留。

产物在 `$DSH_HOME\dsh-shell-kit\logs\`（未设 `DSH_HOME` 时回落 `%USERPROFILE%\.dsh`）：
`harness-<日期>.log`，单文件超 2 MB 就按同一套命名滚成 `harness-<日期>-1.log`、
`-2.log`…，只保留最新 6 个我们自己的文件（不动其它任何文件）。
按"6 个 × 2 MB"算是约 12 MB 上限。写盘失败不影响宿主（全程 try/catch，且不往 stdout 写以免递归），
失败字节数（`droppedBytes`）与最后一次写入错误（`writeError`）都能在 `/api/shell-kit/status` 里看到。

```bash
/logs                    # 看尾部（默认 60 行，最多 500）
/logs 200                # 看最后 200 行
GET  /api/shell-kit/logs/list
GET  /api/shell-kit/logs/tail?lines=200[&file=harness-20261001.log]
GET  /api/shell-kit/logs/stream[?from=begin][&intervalMs=1000]   # SSE：event: line
# 智能体工具：read_harness_log（lines / file）
```

尾读只读文件末尾 256 KB，并丢掉被截断的第一个不完整行（否则中文日志会以乱码开头）；
点名的 `file` 不存在时返回 404 / 明确的错误文本，而不是含糊的「还没有日志文件」。

实时流（`logs/stream`）是 SSE：开流先冲一帧 `: open`（客户端立刻拿到响应头），
之后每来一行推一个 `event: line`（`data` 是 `{"line":"…"}`，走 JSON 所以多行文本不会把帧切断），
滚到新文件时先推一条 `event: file`，15 秒没有新行就发一个 `: ping` 心跳。
按字节增量跟着当前文件走，半行与跨块被切断的多字节字符都留在缓冲里 —— 中文行不会在帧里裂成乱码。
写帧等 `drain`（背压），客户端断开或模块被卸载即停掉定时器。
设置页卡片里的「实时跟随（SSE）」勾上就换成这条流（默认仍显示随轮询拿回的尾部）。

设置页卡片里也会显示当前日志文件名与大小。**一个已知边界**：它只能记到"本模块挂载之后"
的输出，所以它在模块表里排第一位；更早的装载期失败仍然要靠宿主崩溃报告
（那是 `doctor` 的活）。

---

## 模块：热重载（HMR）

官方的 `@deepseek-ai/dsh-hmr`（profile 里 `- id: hmr`）管三件事：替换插件源码模块、刷新 Include、
以及在 profile 配置变化时**不重启进程**地重新组合插件树。桌面 profile 给它的 `config.root` 默认是 `[]`，
也就是说：**配置改动热生效，源码改动仍需重启**；想让编辑源码也热生效，要把它那条条目的
`config.root` 设成 `["."]`。

这件事对 shell-kit 的意义是：此前它只会「整进程重启」，装了 HMR 之后
「改完到底要不要重启」变成一个**可分情况回答**的问题。所以本模块只做三件不越权的事：

| 能力 | 说明 |
|---|---|
| 如实报告状态 | 从**活体 loader** 读 `hmr` 条目的 fiber 状态与 `config.root`，给一个稳定 code：`active`（监听源码，源码也热生效）/ `config-only`（`root: []`，只有配置热生效）/ `disabled` / `inactive` / `missing`。文案留在客户端，宿主只传 code |
| 记录重载事件 | 订阅 `hmr/change`（哪个文件被改）与 `hmr/reload`（重载了几项、哪些文件），进一个 50 条的事件环；URL 只记文件名（绝对路径没必要进日志与面板） |
| 实时看重载 | `GET /api/shell-kit/hmr/events` 的 SSE：首帧就是当前状态，之后每个事件一帧，15 秒无事件发 `: ping`。设置页卡片里有「热重载（HMR）」折叠块，展开就能看到结论与最近事件 |

```bash
GET /api/shell-kit/hmr/status    # available / verdict / sourceRoots / lastReloadAt / recentEvents
GET /api/shell-kit/hmr/events    # SSE：event: status 首帧，之后 event: change / event: reload
node --test test/hmr.test.js     # 7 组用例（结论分档、事件记录、SSE 首帧与释放）
```

**故意不做的**：不提供「请重载这个条目」的按钮。本版本的 dsh-hmr 没有对外暴露可编程的触发入口
（`runReload` 在插件内部），伪触发（比如无意义地重写配置文件去骗文件监听）比如实说更危险 ——
需要热生效就让用户/插件市场去改配置。本模块也不会代替你重启：重启仍然只有一个地方（`restart` 模块）。

---

## 模块：agent 预设（presets）

官方在 `@deepseek-ai/dsh-agent-preset` 自带的 skill（`editing-cordis-compositions`）里说得很清楚：
预设现在是 **bundle 里的一条声明行**（`- id: preset-<id>` + `name: '@deepseek-ai/dsh-agent-preset'`
+ `config.plugins`），而旧格式 `$DSH_HOME/.agent-presets/<id>/`（`preset.yml` + `agent.cordis.yml`）
**已经没有任何代码读它了**；安装必须走官方 `plugin_manager`，并且明令"不要用 shell 命令复刻安装步骤"。
所以本模块**不装、不卸、不替市场干活**，只做官方只给了文档、没给工具的那一段：

| 能力 | 说明 |
|---|---|
| 旧格式巡检 | 扫 `$DSH_HOME/.agent-presets*`，逐个判定「官方已内置（可直接删）」/「已失效」/「疑似自建（需迁移）」。证据包括写死的绝对路径（第三方安装遗留最常坏在这里，取整行原文而不是截断的片段）与缺包清单 |
| 当前声明一览 | 从**活体 loader** 拿真实的 `preset-*` 条目 —— 这比翻文件权威（宿主内置的预设就是普通条目），也和插件市场的 `list_plugins` 同一口径 |
| 迁移骨架 | `/presets migrate <id>` 生成 bundle 目录：`package.json` + 声明行（`plugins` 取旧 `agent.cordis.yml` 原文，官方 skill 的要求）+ 逐条插件名核对 + 安装指引 |

```bash
/presets                      # 巡检（列出当前声明 + 旧格式遗留判定）
/presets migrate wsl-cordis   # 生成迁移骨架（只落文件）
GET  /api/shell-kit/presets/report
# 智能体工具：audit_presets（传 generate: "<id>" 时顺带生成骨架）
```

骨架落在 `<数据目录>/presets/bundles/dsh-preset-<id>/`。**安装始终交回官方**
（`plugin_manager` 的 `install_bundle` 指到该目录，或把它交给插件市场）——
本模块不执行安装，因为那正是官方文档明令不要复刻的步骤。

报告同样按 10 秒 TTL 缓存（`status` 与 `/presets` 路由共用），`audit_presets` 工具强制重扫。

---

## 安装 / 卸载

```powershell
$kit     = '<dsh-shell-kit 的绝对路径>'          # 例如 <插件目录>
$profile = "$env:DSH_HOME\profiles\desktop"      # 未设 DSH_HOME 时用 "$env:USERPROFILE\.dsh\profiles\desktop"

# 1) 以 link 依赖登记（这样后续 pnpm install 不会把它当成多余的包删掉）
#    profile/package.json 的 dependencies 里加（路径用正斜杠）：
#    "dsh-shell-kit": "link:D:/Desktop/DSH插件/dsh-shell-kit"
New-Item -ItemType Junction -Path "$profile\node_modules\dsh-shell-kit" -Target $kit
#    注：走 pnpm 装 link 依赖时，node_modules 下出现的是符号链接（Mode 里的 l）而不是
#    Junction，两种都能被 loader 解析，按你的安装方式选一种即可，别重复建。

# 2) 在 profile/cordis.patch.yml 末尾追加一行 insert（改前请备份）
#    - insert:
#        - id: shell-kit
#          name: dsh-shell-kit
```

热挂载：`cordis.patch.yml` 的**语义**变化会让 loader 在约 1 秒内重新组合，不需要重启进程。
改代码后想立刻生效，用 `- id: shell-kit` + `disabled: true` → `false` 走一次禁用/启用循环
（`index.js` 会把整个 `lib/` 按内容哈希暂存到实例目录再加载，所以任何实现文件的改动都会
被带上，不用重启）。

模块开关（可选，写在 `cordis.patch.yml` 的该条目下）：

```yaml
- id: shell-kit
  name: dsh-shell-kit
  config:
    modules:
      restart: true
      doctor: false      # 只想要重启就把它关掉（modules.<name> 只管开关）
    captureStdio: false  # 可选：logs 模块只要 cordis 的结构化日志，不包 stdout/stderr
```

卸载：删掉 patch 里那行 insert、`package.json` 里的依赖、以及 `node_modules\dsh-shell-kit`
这个链接；`$DSH_HOME\dsh-shell-kit\` 里的日志可以留也可以删。

---

## 模块开发契约

新功能就是 `lib/modules/<name>/` 下一个目录，然后在 `lib/host.js` 的 `MODULE_LOADERS`
里加一行（必须是动态 import，否则一个模块的语法错误会连坐整个 kit）：

```js
// lib/modules/<name>/index.js
export const moduleName = 'doctor'
export const label = { zh: '启动失败归因', en: 'Startup diagnosis' }
export const description = { zh: '卡片里的说明', en: 'Card description' } // 可选，进 /api/shell-kit/status
export function mount(ctx, shared) {
  // ctx: Cordis context；shared: { config, logger }
  const tracker = createRegistryTracker()
  const disposers = [
    localRoute(ctx, { method: 'GET', path: `${ROUTE_PREFIX}/<name>/report`, handler: async (req, res) => ok(res, {}) }),
  ]
  registerCommands(ctx, { label: 'doctor', tracker, register: (c) => c.commands.register({ /* … */ }) })
  registerTools(ctx, { label: 'doctor', tracker, definition: { /* 原始定义对象 */ } })
  const { dir } = moduleFiles('<name>') // 只有需要落盘产物的模块才要：它会把目录建出来
  return {
    dispose() { for (const dispose of disposers) dispose() },
    status() { return { ...tracker.state } }, // 给 /api/shell-kit/status 的状态对象，可抛错
  }
}
```

规则：模块之间**不互相 import**，只共享 `lib/core.js`（路径、profile 探针、日志/报告留档、
进程与插件运行状态、HTTP 守卫与接线助手）与 `lib/profile-audit.js`（只读的 profile 静态审计）；
需要别的模块的能力时，通过 kit 提供的共享对象，不要直接依赖。另外三条硬约束：

- **路由一律用 `localRoute()`**：它把"插件头校验 + 方法白名单 + 只接受本机回环"收在一处，
  手写 `ctx.webServer.register()` 容易漏掉回环检查，那就是一个无认证的本地端点。
- **命令/工具一律用 `registerCommands()` / `registerTools()`**：统一 `registrations` 状态位与
  "注册失败只记日志"的约定，`toolError` 的初值（`等待 tools 服务`）就是"没挂上"的证据。
- **`mount()` 可以是 async**（`host.js` 会 await）；返回值要么没有，要么至少带
  `dispose()` 或 `status()` 之一，否则按挂载失败处理。

---

## 踩过的坑（都在 `restart` 模块里，别再踩回去）

1. **助手必须活过「杀掉壳」那一步**：实测 `detached` 的 PowerShell 根本起不来；
   普通 spawn 的 PowerShell 会被父进程带走；无控制台的父进程里 `cmd.exe` 连 `echo`
   都不写文件。起得来的是 detached 的 `process.execPath`（Electron 二进制 +
   `ELECTRON_RUN_AS_NODE=1`），但它**仍在宿主的作业对象里**：桌面端设了
   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，而 `detached` 只设 `DETACHED_PROCESS`、不设
   `CREATE_BREAKAWAY_FROM_JOB` —— 助手把壳/宿主杀掉的那一刻，作业关闭会把它一起带走。
   所以 Windows 上优先走 WMI（`Win32_Process.Create`，父进程是 `WmiPrvSE.exe`，不在作业里），
   detached Node 只是退路；`node-plain` 必定随宿主死，状态里记 `degraded: true`。
   WMI 这条路的细节：**不经过任何 shell**（内层 PowerShell 实测不执行；`cmd.exe` 包装脚本
   在带空格的路径上静默失败），直接用 `Win32_ProcessStartup.EnvironmentVariables` 把**完整
   环境变量块**交给子进程——该属性是整块替换，只填自己要的变量会让子进程缺 `SystemRoot`/`TEMP`
   而起不来。`$startup.ShowWindow = 0` 抑制窗口。助手配置因此支持 `--config-file`：
   命令行只谈路径，内联 JSON 会被二次解析。
2. **启动新实例前必须清掉 `ELECTRON_RUN_AS_NODE`**，否则 Electron 进纯 Node 模式、没有窗口。
3. **不要 `import '@deepseek-ai/dsh-*'`**：profile 里的第三方插件不一定能解析宿主运行时包
   （实测 `Cannot find package '@deepseek-ai/dsh-tools'`）。工具注册用原始定义对象即可。
4. **桌面端的判据**：壳只给"插件子进程"注入 `DSH_DESKTOP_NODE_EXECUTABLE`，宿主自己没有；
   可靠判据是 `process.versions.electron` + `ELECTRON_RUN_AS_NODE === '1'`。
5. **Node 的 ESM 缓存**：入口加哈希查询串只能解决入口一层，静态 `import './core.js'` 照样
   被缓存 —— 所以 `index.js` 改成"整个 lib/ 按哈希暂存到实例目录再导入"。
6. **别用 PowerShell 存文本状态**：日志/报告一律显式 UTF-8；PS 5.1 的 `Get-Content`
   默认按 ANSI 解码，中文路径会变乱码（历史版本踩过两次）。
7. **`ctx.plugin()` 的返回值绝不能交出去**：fiber 是 thenable，cordis 会把 `apply()` 的
   返回值当 effect 收集，于是子 fiber 刚注册完路由就被拆掉。症状极具误导性 ——
   实现里的 `apply()` 明明跑完、路由也进了 webServer 的 exact 表（`has(path) === true`），
   但紧接着 disposer 一跑，外部请求全部 401。写 `await ctx.plugin(...)` 然后什么都不返回。
8. **本文件（壳）自身的改动必须重启才生效**：`lib/**` 走"禁用/启用循环"热重载，但
   `index.js` 是被 loader 用稳定 URL 缓存的。改完壳如果没重启，跑的还是旧壳 —— 上面第 7 条
   就是这么被卡了一轮的。排查时先看 `$DSH_HOME\dsh-shell-kit\load.log` 面包屑（宿主没有可见
   控制台，那是唯一能说话的地方），它会把 apply 的每一步和异常堆栈落盘。要是连 `load.log`
   都写不出来（home 只读、磁盘满），`GET /api/shell-kit/status` 的 `diagnostics.traceFailures`
   会告诉你失败了几次。
9. **每个模块的数据目录必须先建出来**：`moduleFiles()` 里要 `mkdirSync(dir)`，否则模块的
   日志轮转、报告留档、助手脚本暂存都会**静默失败**（不会报错，只是东西没写进去）。
   它现在只返回 `{ dir }` —— 具体文件名是模块自己的事（restart 的在 `engine.js` 里）。
10. **全新包名第一次不能靠热挂载**：profile 里第一次出现的插件包名，loader 侧条目会出现
   "条目在、fiber 起不来"的情况（本机实测），冷启动一次即正常。所以第一次装本插件需要
   重启一次（之后改代码都走热重载）。
11. **`loader.entries()` 迭代的是生成器（不是 Set）**：没有 `.length`（要 `Array.from`），
   而 `for...of` 照样能迭代 —— 所以"能列出条目但计数是空"就是这么来的。
12. **包解析失败的条目往往连 fiber 都没有**：不是 `fiber.state === 3`（failed），而是
   `fiber === undefined`。只按状态判断会漏掉"包名写错/没装"这类最常见的启动失败，
   必须结合"条目有没有存活 fiber + 包在不在 node_modules"一起判定（doctor 就是这么做的）。
13. **注释里别写 `*/`**：`.agent-presets*/` 这种写法会**提前结束块注释**，后面的注释全变成
   代码，而报错位置却指在几百行之后（本模块第一次提交就踩了：`SyntaxError: Unexpected token ':'`
   指在第 59 行，真凶在第 12 行的注释里）。写完文件先跑一次 `npm run check`，再看错误行号附近的
   注释里有没有 `*/`。
14. **别用 PowerShell 双引号去改 JS**：反引号是 PS 的转义符，模板字面量会被吃掉、`\n` 会变成
   字面量。改代码用编辑器或 `node` 脚本；PS 只用来跑命令与检查。
15. **共享层不要长成"某个模块的形状"**：`moduleFiles()` 一度返回 `restart.log` / `last-report.json`
   这些 restart 专有文件名，别的模块只能忽略它们。共享层只给目录，产物名留给模块自己。
16. **别把"无上限"的东西交给别人渲染**：崩溃日志的发现条数、状态路由里的数组长度都要设上限，
   否则一份反复失败的日志会把报告推到几千条、把客户端拖慢（报告里现在每类最多 20 条、
   每 10 秒才重算一次）。
17. **实例目录要"要么完整、要么不存在"**：`index.js` 把 `lib/` 拷进 `instances/<hash>/` 时，
   一次中途失败（磁盘满、进程被杀）会留下半个目录，而复用判断只看"目录在不在"，
   下次同 hash 就会加载这份残缺快照。现在先拷到 `<hash>.staging-<pid>` 再 rename 就位
   （同目录内 rename 是原子的），"目录存在"因此等价于"快照完整"。
18. **助手已经是多文件了，暂存必须连依赖一起拷**：端口探针拆去 `./ports.js` 之后，
   暂存逻辑仍然只拷 `helper.mjs`，副本于是在 `import './ports.js'` 处
   `ERR_MODULE_NOT_FOUND` —— 而它**死在第一行日志之前**，宿主侧三条启动路线只能齐声报告
   「启动后没有写出日志」（2026-10-17 卡在这一条上）。现在按相对 import 递归拷依赖
   （`stageHelperBundle`），并且排重启前先跑一次 `--selftest` 把"能不能解析"问清楚；
   子进程的 stderr 也不再 `stdio: 'ignore'` 吞掉，而是落到 `helper-stderr.log`。
   教训：**任何"拷一份出去再执行"的设计，都要有一步证明拷出去的那份跑得起来**。

---

## 测试与自检

```bash
npm run check     # 对全部源文件跑 node --check（第 13 条那个坑的最小防线）
npm test          # node --test test/…：纯逻辑回归（HTTP 守卫、注册状态机、尾读、
                  #   patch 审计与覆盖行语义、预设解析与判定）
```

测试只覆盖**不需要宿主**的部分：能被单测的纯函数尽量留成导出函数（`clampDelay`、`parsePatchRows`、`judgeLegacy` …），需要 cordis context 的部分靠 `/diag` 与运行期产物核对。

发布前记得两处一起改：`package.json` 的 `version` 与 `lib/core.js` 的 `PLUGIN_VERSION`
（它会被打进 `/api/shell-kit/status` 与 CLI 输出）。不在这里读 `package.json` 是有意的：
`lib/` 会被拷进 `<数据目录>/instances/<hash>/` 再加载，与 `package.json` 的相对层级不固定，
为它加一层路径解析与读盘比手工同步更脆。

## 目录结构

```
dsh-shell-kit/
├── package.json / cordis.patch.yml / NOTICE.md
├── index.js                     # loader 外壳：lib/ 按内容哈希暂存后导入
├── lib/
│   ├── core.js                  # 共享核心（路径 / 探针 / 留档 / HTTP 守卫 / 接线助手）
│   ├── profile-audit.js         # 共享的 profile 静态审计（doctor + profile 只读复用）
│   ├── host.js                  # 插件本体：模块注册表 + 聚合状态路由
│   └── modules/
│       ├── logs/index.js        # 宿主日志：exporter + stdio 兜底 + 查看入口
│       ├── restart/
│       │   ├── index.js         # 模块接线：路由 + /restart 命令 + restart_dsh 工具
│       │   ├── engine.js        # 重启引擎：暂存助手、自检、拉起、确认、状态快照（带 TTL 缓存）
│       │   ├── helper.mjs       # detached 运行的重启助手 / 看门狗（含 --selftest）
│       │   ├── ports.js         # 端口探针：只有 ECONNREFUSED 才算「已释放」
│       │   └── window-state.mjs # 壳窗口状态：GetWindowPlacement 抓、ShowWindow/SetWindowPos 摆回
│       ├── doctor/index.js      # 插件诊断（报告带 TTL 缓存与条数上限）
│       ├── profile/index.js     # 配置体检与修复（备份 + dry-run）
│       └── presets/index.js     # agent 预设巡检与迁移骨架
├── client.js                    # 浏览器半边：设置 → Shell Kit 卡片 + 桌面端标题栏「重启」按钮
├── bin/dsh-shell-kit.mjs        # 命令行入口（HTTP 瘦客户端）
├── test/                        # node:test 回归测试
└── README.md
```

## 协议

MIT（本包自研部分）。移植第三方代码时的署名要求见 [NOTICE.md](NOTICE.md)。
