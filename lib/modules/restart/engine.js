/**
 * dsh-shell-kit — 「一键重启」模块的重启引擎。
 *
 * 从 dsh-quick-restart 原样搬过来的核心逻辑（含那边踩出来的所有坑，见仓库 README）：
 * 拉助手、确认它真的在跑、写意图/报告、日志轮转与报告留档。
 * 产物都在 <数据目录>/restart/ 下；助手源文件是本目录的 helper.mjs，
 * 执行时先复制成同目录下的 restart-helper.mjs（纯 ASCII 路径 + 目录改名也不影响已排的重启）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PLUGIN_ID,
  PLUGIN_VERSION,
  hostFacts,
  moduleFiles,
  pendingPluginRun,
  readJsonFile,
  tailLines,
} from '../../core.js'
import { captureScript, parseCapture, summarizeState } from './window-state.mjs'
/** 默认给 UI/日志留出的落地时间（毫秒）。 */
export const DEFAULT_DELAY_MS = 1200
/** 命令/工具路径留得更宽松一些，让结果先写进会话日志。 */
export const DEFAULT_DELAY_MS_INTERACTIVE = 2500
/**
 * 延迟下限：拉助手之后要花至多 2.5 秒确认它真的跑起来了，
 * 这个确认必须发生在它动手杀进程之前，否则调用方等不到响应。
 */
export const MIN_DELAY_MS = 3000
/**
 * 同一进程内两次重启之间的静默期，防止连点。
 *
 * 由 restart/index.js 的 `launch()` 读取：上一次排定的延迟到点后再加这段时间内，
 * 除非 force，否则不再排第二次（界面与 CLI 的「跳过插件操作与静默期检查」文案与此对应）。
 */
export const COOLDOWN_MS = 15000
/** 助手脚本与本模块产物都在 `moduleFiles('restart')` 的目录里。 */
const HELPER_SCRIPT = fileURLToPath(new URL('./helper.mjs', import.meta.url))

/**
 * 本模块的产物路径。文件名是 restart 自己的事，共享层只给目录（见 core.moduleFiles）。
 * @param {{ dir: string }} files
 */
function pathsOf(files) {
  return {
    dir: files.dir,
    log: join(files.dir, 'restart.log'),
    report: join(files.dir, 'last-report.json'),
    watchdogReport: join(files.dir, 'watchdog-report.json'),
    intent: join(files.dir, 'last-intent.json'),
    reports: join(files.dir, 'reports'),
    /** 助手的暂存目录（入口 + 它 import 的同目录模块，见 stageHelperBundle）。 */
    helperDir: join(files.dir, 'helper'),
    /** 助手自己的错误输出：没有这个，子进程起不来就只剩一句"没写出日志"（踩过）。 */
    helperStderr: join(files.dir, 'helper-stderr.log'),
  }
}

/** 本模块的产物路径（供 restart/index.js 做轮转与留档）。 */
export function restartPaths() {
  return pathsOf(moduleFiles('restart'))
}
/**
 * 把调用方给的延迟夹到 [MIN_DELAY_MS, 60000]；非法值用 fallback。
 * @param {unknown} value
 * @param {number} fallback
 */
export function clampDelay(value, fallback) {
  if (!Number.isFinite(value)) return fallback
  const rounded = Math.round(Number(value))
  if (rounded < MIN_DELAY_MS) return MIN_DELAY_MS
  if (rounded > 60000) return 60000
  return rounded
}

/**
 * 从模块源码里抽出相对 ESM 依赖（`from './x.js'` / `import './x.js'`）。
 * @param {string} text
 * @returns {string[]}
 */
function relativeImports(text) {
  const specs = new Set()
  for (const match of text.matchAll(/\bfrom\s+['"](\.[^'"]*)['"]/gu)) specs.add(match[1])
  for (const match of text.matchAll(/\bimport\s+['"](\.[^'"]*)['"]/gu)) specs.add(match[1])
  return [...specs]
}

/**
 * 把助手**连同它 import 的同目录模块**一起复制到插件数据目录（`C:\Users\…\.dsh\…`，纯 ASCII 路径）再执行。
 *
 * 三个原因：① 插件可能装在带中文/空格的目录里，而把非 ASCII 路径交给别的进程解释
 * 从来不是稳的事；② 复制之后，即使有人在重启途中移动或改名插件目录，待执行的重启
 * 也不会失败；③ **助手已经不是单文件了**（端口探针拆去了 ./ports.js）——只拷入口文件时
 * 暂存副本会在 `import './ports.js'` 处直接 ERR_MODULE_NOT_FOUND 死掉，而它死得比
 * 第一行日志还早，宿主侧只能看到「三条启动路线都没写出日志」（2026-10-17 实际踩到）。
 * 所以这里按相对 import 递归拷贝依赖，以后再拆模块也不会重犯。
 * @returns 可执行副本的绝对路径。
 */
export function stageHelperBundle(paths) {
  const dir = paths.helperDir
  const entryName = 'restart-helper.mjs'
  try {
    mkdirSync(dir, { recursive: true })
    const queue = [{ source: HELPER_SCRIPT, name: entryName }]
    const copied = new Set([entryName])
    while (queue.length > 0) {
      const item = queue.shift()
      const text = readFileSync(item.source, 'utf8')
      const target = join(dir, item.name)
      writeFileSync(target, text, 'utf8')
      // 以拷贝后的副本为基准解析依赖：暂存目录里必须长得和源目录一样。
      for (const spec of relativeImports(text)) {
        const source = resolve(dirname(item.source), spec)
        const name = basename(spec)
        if (copied.has(name)) continue
        copied.add(name)
        queue.push({ source, name })
      }
    }
    // 旧版本只往 <dir> 根下拷一个 restart-helper.mjs，留着会让人以为它还在跑。
    try { rmSync(join(paths.dir, entryName), { force: true }) } catch { /* 没有就算了 */ }
    return join(dir, entryName)
  } catch {
    // 拷不了就用源目录里那份（ports.js 就在旁边，反而更容易跑通）。
    return HELPER_SCRIPT
  }
}

/** 日志文件的最后修改时间，用作「助手是否真的跑起来了」的判据。 */
function logStamp(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** PowerShell 单引号字符串：内部的 ' 写成 '' 即可原样传递。 */
function psQuote(value) {
  return `'${String(value).replace(/'/gu, "''")}'`
}

/** Windows 命令行的引号形式（路径可能带空格；WMI 不做二次解析，但 CreateProcess 会）。 */
function windowsQuote(value) {
  return `"${String(value).replace(/"/gu, '\\"')}"`
}

/** PowerShell -EncodedCommand 要的是 UTF-16LE 的 base64。 */
function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * 把环境变量整理成 PowerShell 字符串数组的元素（`NAME=VALUE`）。
 * 值是空的也保留：`PATH=` 与「没有 PATH」对子进程来说不是一回事。
 */
function envPairs(env) {
  return Object.keys(env)
    .filter((key) => key !== '' && !key.includes('='))
    .map((key) => `${key}=${env[key]}`)
}

/** 系统自带的 Windows PowerShell（不要用 pwsh：那属于用户环境，可能没装）。 */
function powershellPath() {
  const root = process.env.SystemRoot ?? process.env.windir
  return root === undefined ? 'powershell.exe' : join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** -EncodedCommand 的实参上限（Windows 命令行 32767，留出余量给外层参数）。 */
const ENCODED_COMMAND_LIMIT = 24000

/**
 * 用 WMI 拉起助手，让它整个脱离宿主所在的 Windows Job Object。
 *
 * 背景（对照 Mandarin715/dsh-autopilot 的 launch-helper.js:1-19,142-160）：
 * 桌面端把宿主进程放进了一个 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE 的作业对象，
 * 而 `detached: true` 只设 DETACHED_PROCESS、不设 CREATE_BREAKAWAY_FROM_JOB ——
 * 于是「子进程还活着」只在宿主自己退出时成立；一旦助手按设计把壳/宿主杀掉
 * （这正是重启的一步），作业随之关闭，助手自己也一起被杀，重启就断在半路。
 *
 * 逃生路线是换父进程：`Win32_Process.Create` 由 WmiPrvSE.exe 创建进程，而它
 * 不在这个作业里，它的子进程自然也不在。
 *
 * 配方是实测出来的（2026-10-14，见 lib/modules/restart/engine.js 的注释与
 * test/wmi.test.js），三条弯路都排除了：
 *   · WMI 创建**内层 PowerShell** 再 `Start-Process`：返回码 0、PID 也有，但这个
 *     环境里内层 PowerShell 根本没有真正执行（连重定向文件都没生成）；
 *   · WMI 创建 **cmd.exe** 跑 .cmd 包装脚本：无空格的路径可以，一旦路径带空格
 *     （或交给它的窗体是 `""…""`、`call`）全部静默失败；
 *   · 直接给 `$startup.EnvironmentVariables` 只填我们要的那两个变量：子进程
 *     没了 SystemRoot/TEMP，node 起不来。**该属性是整块替换，不是追加**。
 * 可行的是最后这条：把**完整环境变量块**（含 `ELECTRON_RUN_AS_NODE=1`）交给
 * `Win32_ProcessStartup.EnvironmentVariables`，再让 WMI 直接创建 Electron 二进制
 * 本身——不经过任何 shell，带空格的路径也能跑，而且父进程是 WmiPrvSE。
 *
 * 外层 PowerShell 是宿主的子进程（仍在作业里），但它只活到 WMI 返回 PID 为止，
 * 不需要 survive；真正要活下来的是它创建的那个进程。
 *
 * 导出是为了让 `test/wmi.test.js` 能真跑一次（用一个只写标记文件的替身脚本），
 * 而不是只靠代码评审相信这条逃生路线在这个环境里可用。
 * @returns {{pid: number|null, detail: string}}
 */
function wmiEncodedArgs({ execPath, scriptPath, configPath, workDir, env }) {
  const commandLine = [execPath, scriptPath, '--config-file', configPath].map(windowsQuote).join(' ')
  const pairs = envPairs(env ?? { ...process.env, ELECTRON_RUN_AS_NODE: '1' })
  const outerScript = [
    "$ErrorActionPreference = 'Stop'",
    // ShowWindow = 0：Electron 二进制是 GUI 子系统，不抑制的话会闪一个窗口。
    "$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()",
    '$startup.ShowWindow = 0',
    `$startup.EnvironmentVariables = @(${pairs.map(psQuote).join(', ')})`,
    // 第二参是 CurrentDirectory（不参与命令行解析），第三参是上面那个 startup。
    `$r = ([wmiclass]'Win32_Process').Create(${psQuote(commandLine)}, ${workDir === undefined || workDir === null ? '$null' : psQuote(workDir)}, $startup)`,
    'if ($r.ReturnValue -ne 0) { [Console]::Error.WriteLine("Win32_Process.Create failed: " + $r.ReturnValue); exit 1 }',
    '[Console]::Out.WriteLine($r.ProcessId)',
  ].join('\r\n')

  const encoded = encodePowerShell(outerScript)
  if (encoded.length > ENCODED_COMMAND_LIMIT) {
    // 环境变量块异常大（几十 KB）时宁可退回 detached，也不要发一条会被截断的命令行。
    throw new Error(`WMI 启动跳过：环境变量块过大（${encoded.length} > ${ENCODED_COMMAND_LIMIT} 字符）`)
  }

  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]
}

/** 从 WMI 的 PowerShell 输出里取 PID；失败时抛出带 stderr 尾巴的错误。 */
function wmiResult({ stdout, stderr, status }) {
  const text = String(stdout ?? '').trim()
  const last = text.split(/\r?\n/u).filter((line) => line.trim() !== '').pop() ?? ''
  const pid = /^\d+$/u.test(last.trim()) ? Number(last.trim()) : null
  if (status !== 0 || pid === null) {
    const detail = String(stderr ?? '').trim() || `exit ${status}, stdout ${JSON.stringify(text.slice(0, 200))}`
    throw new Error(`WMI 启动失败：${detail}`)
  }
  return { pid, detail: 'Win32_Process.Create + EnvironmentVariables' }
}

/**
 * 同步版：只给 `test/wmi.test.js` 与人工诊断用。
 *
 * 它会在调用线程上阻塞（PowerShell 冷启动最坏 20 秒），**不要**放进请求路径：
 * 运行时的一键重启走下面的 `launchViaWmiAsync`。
 * @returns {{pid: number|null, detail: string}}
 */
export function launchViaWmi(input) {
  const probe = spawnSync(powershellPath(), wmiEncodedArgs(input), { encoding: 'utf8', windowsHide: true, timeout: 20000 })
  if (probe.error !== undefined && probe.error !== null) throw probe.error
  return wmiResult({ stdout: probe.stdout, stderr: probe.stderr, status: probe.status })
}

/** 异步版：同一套命令行，用 spawn + Promise，绝不阻塞宿主事件循环（B2）。 */
export async function launchViaWmiAsync(input) {
  const probe = await runCaptured(powershellPath(), wmiEncodedArgs(input), { timeoutMs: 20000 })
  if (probe.error !== null) throw probe.error
  return wmiResult({ stdout: probe.stdout, stderr: probe.stderr, status: probe.timedOut ? -1 : probe.status })
}

/** 这两条命令只回一行 PID / 几行错误，异常刷屏时不必把内存吃光。 */
const OUTPUT_CAP_BYTES = 64 * 1024

/**
 * 跑一次子进程并收集输出，全异步（绝不阻塞事件循环）。
 *
 * 为什么值得单独写：WMI 逃生与助手自检原来都是 `spawnSync`，而它们挂在 HTTP 处理器
 * 与工具调用的同步路径上 —— 一次 PowerShell 冷启动就能把整个宿主（所有路由、WebSocket、
 * 渲染器）冻到超时上限。超时也要收尸，否则会留下卡住的 PowerShell 占着句柄。
 * @returns {Promise<{status: number|null, stdout: string, stderr: string, error: Error|null, timedOut: boolean}>}
 */
function runCaptured(command, args, { timeoutMs, env, windowsHide = true } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { windowsHide, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ status: null, stdout: '', stderr: '', error, timedOut: false })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch { /* 已经退出 */ }
    }, timeoutMs)
    timer.unref?.()
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const append = (current, chunk) => current.length >= OUTPUT_CAP_BYTES
      ? current
      : current + String(chunk).slice(0, OUTPUT_CAP_BYTES - current.length)
    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk) })
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk) })
    child.once('error', (error) => finish({ status: null, stdout, stderr, error, timedOut }))
    child.once('close', (code) => finish({ status: code, stdout, stderr, error: null, timedOut }))
  })
}

/**
 * 窗口状态恢复的开关：默认开启，`DSH_SHELL_KIT_WINDOW_STATE=0/false/off` 关闭。
 * 用一个环境变量而不是模块配置项：它是「出问题时才关」的逃生阀，不值得占配置面。
 */
export function windowStateRestoreEnabled(env = process.env) {
  const flag = String(env.DSH_SHELL_KIT_WINDOW_STATE ?? '').trim().toLowerCase()
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no')
}

/**
 * 重启前抓一次壳主窗口的显示状态。
 *
 * 壳自己不持久化窗口几何（resources/app/lib/main.js 的 createWindow 写死 1280×820），
 * 不记就必然丢。但这只是「顺手多做一点」——任何失败都返回 null，重启照常进行，
 * 绝不因为它没成就把一次重启判失败。只在 win32 上有意义：GetWindowPlacement 是 user32 的东西。
 * @param {{ exe?: string, shellPid?: number }} facts hostFacts 的结果
 * @param {{ enabled?: boolean }} [options]
 * @returns {Promise<object|null>}
 */
export async function captureWindowState(facts, options = {}) {
  if (process.platform !== 'win32') return null
  if (options.enabled === false) return null
  const exe = typeof facts?.exe === 'string' ? facts.exe : ''
  const imageName = exe === '' ? '' : basename(exe).replace(/\.exe$/iu, '')
  const script = captureScript({ pid: Number(facts?.shellPid) || 0, imageName })
  const probe = await runCaptured(powershellPath(), [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script),
  ], { timeoutMs: 5000 })
  if (probe.error !== null || probe.timedOut || probe.status !== 0) return null
  return parseCapture(probe.stdout)
}

/**
 * 暂存副本能不能被 node 解析（`--selftest`，见 helper.mjs）。
 *
 * 为什么值得多花这 200ms：暂存副本坏掉时它是**在 import 阶段就死**的，
 * 早于第一行日志，宿主侧的三条启动路线只会齐声报告「没有写出日志」——
 * 那个提示既没说错，也没指出任何可修的东西（2026-10-17 正是这样被卡住）。
 * @returns {{ok: boolean, detail: string}}
 */
async function helperSelftest(scriptPath, env) {
  const probe = await runCaptured(process.execPath, [scriptPath, '--selftest'], { timeoutMs: 10000, env })
  if (probe.error !== null) return { ok: false, detail: probe.error.message }
  if (probe.timedOut) return { ok: false, detail: '自检超时（10 秒没有退出）' }
  if (probe.status === 0) return { ok: true, detail: '' }
  const detail = String(probe.stderr ?? '').trim().split(/\r?\n/u).slice(0, 5).join(' / ')
  return { ok: false, detail: detail === '' ? `退出码 ${String(probe.status)}` : detail }
}

/**
 * 结束一条失败路线上已经拉起来的子进程。
 *
 * 返回一句结果描述，写进 notes：万一「没写出日志」是误判，日志里能直接看到
 * 我们终止了哪个 pid，而不是只留下一句含糊的启动失败。
 * @returns {string}
 */
function terminateAttempt(child) {
  if (child === null || child === undefined) return '没有进程句柄'
  try {
    if (typeof child.kill === 'function') {
      child.kill()
      return '已发终止信号'
    }
    if (Number.isInteger(child.pid)) {
      process.kill(child.pid)
      return '已按 pid 终止'
    }
    return '没有可用的终止句柄'
  } catch (error) {
    return `终止失败：${error?.message ?? String(error)}`
  }
}

/**
 * 拉起重启助手，并确认它真的开始执行了。
 *
 * 这一步是踩坑踩出来的，配方别再改（2026-09-30 实测）：
 *   · `detached: true` 拉 powershell.exe：进程根本起不来；
 *   · 普通 spawn 拉 powershell.exe：起得来，但父进程一退出就跟着死；
 *   · 无控制台父进程里 cmd.exe 完全跑不起来，所以 `cmd /c start` 也不行；
 *   · 唯一同时在「起得来」和「父进程死了还活着」上都成立的是：
 *     detached 的 node.exe（也就是宿主自己的那个 Electron 二进制 + ELECTRON_RUN_AS_NODE=1）。
 * 助手参数走一个 JSON 字符串，避免命令行对中文/空格路径的二次解析。
 * 启动后再用日志时间戳确认它确实在执行；失败就抛错，绝不承诺一次不会发生的重启。
 *
 * Windows 上先试 WMI（见 launchViaWmi：helper 必须活过「杀掉壳」那一步，而
 * detached 拉起的进程仍在宿主的作业对象里）；WMI 不可用或没写出日志时，
 * 再退回上面这条实测可用的 detached node 路线。
 * @returns {{ launch: string, helperPid: number|null, verified: boolean, attempts: string[] }}
 */
async function launchHelper({ scriptPath, helperArgs, workDir, paths }) {
  const cwd = existsSync(workDir) ? workDir : undefined
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  // 配置文件形式：WMI 那条路要经过 PowerShell 的命令行，内联 JSON 会被二次解析。
  let configPath = null
  try {
    configPath = join(paths.dir, 'helper-config.json')
    writeFileSync(configPath, `${JSON.stringify(helperArgs)}\n`, 'utf8')
  } catch {
    configPath = null
  }
  const args = configPath === null
    ? [scriptPath, JSON.stringify(helperArgs)]
    : [scriptPath, '--config-file', configPath]

  // 先确认「这份脚本到底跑得起来吗」：解析不了就别去猜三条启动路线。
  const selftest = await helperSelftest(scriptPath, env)
  if (!selftest.ok) {
    throw Object.assign(
      new Error(`重启助手跑不起来（暂存副本自检失败，未安排重启）：${selftest.detail}（脚本：${scriptPath}）`),
      { statusCode: 500, code: 'HELPER_BROKEN' },
    )
  }

  // 子进程的 stderr 落到文件：stdio: 'ignore' 会把「为什么起不来」整句吞掉（踩过）。
  let stderrFd = 'ignore'
  try {
    stderrFd = openSync(paths.helperStderr, 'w')
  } catch {
    stderrFd = 'ignore'
  }
  /** 读回子进程的错误输出尾巴（没有就返回空串）。 */
  const stderrTail = () => tailLines(paths.helperStderr, 4).join(' / ')

  try {
    const attempts = []
    if (process.platform === 'win32' && configPath !== null) {
      attempts.push({
        name: 'wmi-detached',
        run: async () => {
          const launched = await launchViaWmiAsync({ execPath: process.execPath, scriptPath, configPath, workDir: cwd ?? workDir, env })
          return {
            pid: launched.pid,
            unref() {},
            // WMI 的进程不在我们手里，pid 是唯一能收尸的把手（见 terminateAttempt）。
            kill: () => { try { process.kill(launched.pid) } catch { /* 已经退出 */ } },
          }
        },
      })
    }
    attempts.push(
      {
        name: 'node-detached',
        run: () => spawn(process.execPath, args, {
          detached: true, stdio: ['ignore', 'ignore', stderrFd], windowsHide: true, cwd, env,
        }),
      },
      {
        name: 'node-plain',
        run: () => spawn(process.execPath, args, {
          stdio: ['ignore', 'ignore', stderrFd], windowsHide: true, cwd, env,
        }),
      },
    )

    const notes = []
    for (const attempt of attempts) {
      const before = logStamp(paths.log)
      let child
      try {
        // 有的路线是异步的（WMI：spawn + Promise），有的是同步的（detached spawn）；await 两边都吃。
        child = await attempt.run()
      } catch (error) {
        notes.push(`${attempt.name} 启动抛错（${error?.message ?? String(error)}）`)
        continue
      }
      child.unref?.()
      // 立刻退出＝脚本根本没进到写日志那一步，没必要再干等 3 秒。
      let exited = null
      if (typeof child.once === 'function') child.once('exit', (code, signal) => { exited = { code, signal } })
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        if (logStamp(paths.log) > before) {
          return { launch: attempt.name, helperPid: child.pid ?? null, verified: true, attempts: notes }
        }
        if (exited !== null) break
      }
      // 判定失败之前再确认一次日志：刚好在 deadline 那一刻写出来的助手是活的，
      // 杀掉它等于把一次成功的启动算成失败。
      if (logStamp(paths.log) > before) {
        return { launch: attempt.name, helperPid: child.pid ?? null, verified: true, attempts: notes }
      }
      // 收尸：判失败就必须杀掉它。留在那儿的助手会继续倒计时，等下一个助手已经接管
      // 之后再来一次 kill 宿主 + relaunch，一次点击就打成两轮重启（A2 的根因）。
      const killed = terminateAttempt(child)
      const why = exited === null ? '' : `，而且进程立刻退出（code=${String(exited.code)}）`
      const stderr = stderrTail()
      notes.push(`${attempt.name} 启动后没有写出日志${why}${stderr === '' ? '' : `：${stderr}`}（已终止 pid=${String(child.pid ?? '?')}：${killed}）`)
    }
    return { launch: 'none', helperPid: null, verified: false, attempts: notes }
  } finally {
    if (typeof stderrFd === 'number') {
      try { closeSync(stderrFd) } catch { /* 关不掉不影响结果 */ }
    }
  }
}

/**
 * 安排一次重启：写意图文件，拉起重启助手并确认它开始执行。
 *
 * graceful 默认为 false（直接强杀）：自检发现 taskkill 不带 /F 的「优雅关闭」
 * 可能连助手自己一起带走，而桌面端 Electron 主窗口收到 WM_CLOSE 通常只是隐藏到
 * 托盘、并不退出，所以它既没用又危险，只作为显式选项保留。
 * @param {{facts: object, ctx?: object, delayMs?: number, graceful?: boolean, by?: string}} input
 * @returns {Promise<object>} 调度结果（含助手启动方式、延迟、脚本与产物路径）。
 */
export async function scheduleRestart(input) {
  const facts = input.facts
  if (!facts || facts.supported !== true) {
    const reason = (facts?.reasons ?? ['未知原因']).join('；')
    throw Object.assign(new Error(`当前宿主不支持一键重启：${reason}`), { statusCode: 501, code: 'UNSUPPORTED' })
  }
  const paths = pathsOf(moduleFiles('restart'))
  const delayMs = clampDelay(input.delayMs, DEFAULT_DELAY_MS)
  const graceful = input.graceful === true
  const by = typeof input.by === 'string' && input.by !== '' ? input.by : 'unknown'
  const scriptPath = stageHelperBundle(paths)
  // 动手杀壳之前把窗口状态记下来：壳不自己记（见 window-state.mjs 开头），
  // 而这时候窗口还活着。抓不到就是 null，助手会跳过恢复，不影响重启。
  const restoreWindow = windowStateRestoreEnabled()
  const windowState = restoreWindow ? await captureWindowState(facts) : null

  const intent = {
    at: new Date().toISOString(),
    by,
    delayMs,
    graceful,
    exe: facts.exe,
    shellPid: facts.shellPid,
    hostPid: facts.hostPid,
    port: facts.port,
    helperScript: scriptPath,
    // 只记摘要（maximized / minimized / rect / screen），够复盘用，也不让意图文件变成大块数据。
    windowState: summarizeState(windowState),
  }
  try {
    writeFileSync(paths.intent, `${JSON.stringify(intent, null, 2)}\n`, 'utf8')
  } catch { /* 状态文件写不了不影响重启本身 */ }

  // 壳的原始命令行：宿主这一侧不再同步查（一次 PowerShell 查询最坏能把事件循环卡 4 秒，
  // 而它本来就是"拿不到也无所谓"的尽力而为）。改由助手在空闲时机自己查，见 helper.mjs。
  const helperArgs = {
    mode: 'helper',
    shellPid: facts.shellPid,
    hostPid: facts.hostPid,
    exe: facts.exe,
    workDir: facts.workDir,
    port: facts.port ?? 0,
    graceMs: delayMs,
    softCloseMs: graceful ? 2500 : 0,
    deadlineSec: 45,
    relaunchWaitSec: 90,
    relaunch: true,
    watchdog: true,
    shellArgsProbe: true,
    logPath: paths.log,
    reportPath: paths.report,
    watchdogReportPath: paths.watchdogReport,
    startedBy: by,
    // 助手与看门狗都用这份状态把窗口摆回去（见 helper.mjs 的 restoreWindowState）。
    windowState,
    windowStateRestore: restoreWindow,
  }

  const launched = await launchHelper({
    scriptPath,
    helperArgs,
    workDir: facts.workDir,
    paths,
  })
  if (!launched.verified) {
    const tail = tailLines(paths.log, 6).join(' / ')
    throw Object.assign(
      new Error(`重启助手没能启动：${launched.attempts.join('；')}${tail === '' ? '' : `（日志尾部：${tail}）`}`),
      { statusCode: 500, code: 'HELPER_NOT_LAUNCHED' },
    )
  }

  return {
    scheduled: true,
    delayMs,
    // 计划开火时刻（毫秒）：restart/index.js 拿它当倒计时基准，
    // 免得 pendingInMs 从「发起请求」而不是「助手起来了」开始算。
    scheduledAt: Date.now() + delayMs,
    graceful,
    by,
    launch: launched.launch,
    // 降级＝没走成能活过「杀壳」那一步的路线：node-plain 是宿主的子进程，
    // 必定随宿主一起死；none 表示没有一条路线成功。wmi-detached 与
    // node-detached 都算正常。
    degraded: launched.launch !== 'node-detached' && launched.launch !== 'wmi-detached',
    helperPid: launched.helperPid,
    helperScript: scriptPath,
    sourceScript: HELPER_SCRIPT,
    logPath: paths.log,
    reportPath: paths.report,
    // 抓到了什么，状态接口里就能看到（抓不到是 null，不是 []）。
    windowState: summarizeState(windowState),
  }
}

/**
 * `restartStatus()` 的读盘缓存。
 *
 * 客户端在重启窗口里会反复取状态，而每次 `restartStatus()` 都要读 3 个 JSON + 尾读日志。
 * 与其让"看一眼状态"变成持续 I/O，这里给一个很短的 TTL：默认 2 秒。
 * 会话内的实时量（`restartPendingInMs` / `lastSchedule`）由 restart/index.js 另行附加，
 * 不经过这份缓存，所以状态语义不会被缓存拖旧。
 */
const STATUS_TTL_MS = 2000
const statusCache = { at: 0, value: null }

/**
 * 一次完整的运行时状态快照，供 HTTP 状态路由与客户端卡片使用。
 * @param {object} ctx
 * @param {{ fresh?: boolean }} [options] fresh=true 时绕过缓存（刚排完重启后读结果时用）
 */
export function restartStatus(ctx, options = {}) {
  const now = Date.now()
  if (options.fresh !== true && statusCache.value !== null && now - statusCache.at < STATUS_TTL_MS) {
    return statusCache.value
  }
  const facts = hostFacts(ctx)
  const paths = pathsOf(moduleFiles('restart'))
  const pending = pendingPluginRun()
  const value = {
    plugin: PLUGIN_ID,
    version: PLUGIN_VERSION,
    supported: facts.supported,
    reasons: facts.reasons,
    platform: facts.platform,
    desktop: facts.desktop,
    exe: facts.exe,
    shellPid: facts.shellPid,
    hostPid: facts.hostPid,
    port: facts.port,
    pluginOperation: pending,
    lastIntent: readJsonFile(paths.intent),
    lastReport: readJsonFile(paths.report),
    watchdogReport: readJsonFile(paths.watchdogReport),
    logTail: tailLines(paths.log, 20),
  }
  statusCache.at = now
  statusCache.value = value
  return value
}

/** 让下一次 `restartStatus()` 重新读盘（排完重启、模块释放时调用）。 */
export function invalidateRestartStatus() {
  statusCache.at = 0
  statusCache.value = null
}

export { HELPER_SCRIPT }