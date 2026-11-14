/**
 * dsh-quick-restart — 独立重启助手 / 看门狗（Node 版）。
 *
 * 由 lib/core.js 用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 拉起，参数是一个
 * JSON 字符串（不用拼命令行，中文/空格路径都不会被二次解析）。
 *
 * 为什么是 Node 而不是 PowerShell（2026-09-30 实测结论，别再改回去）：
 *   · detached 的 powershell.exe **根本起不来**（进程立刻消失）；
 *   · 普通 spawn 的 powershell.exe 起得来，但父进程一退出它就跟着死 ——
 *     Node/libuv 在 Windows 上会管理子进程，宿主被杀时助手必须活着，
 *     所以这条路也不行；
 *   · 无控制台的父进程里 cmd.exe **完全跑不起来**（`cmd /c echo` 都不写文件），
 *     所以「经 cmd start 转一道手」也不成立；
 *   · detached 的 node.exe 既能起来、又能在父进程退出/被杀之后继续活着。
 * 结论：助手必须是 Node 脚本，并且必须以 detached 方式启动。
 *
 * 用法（两个模式共用一个文件）：
 *   node restart-helper.mjs '{"mode":"helper",...}'
 *   node restart-helper.mjs '{"mode":"watchdog",...}'
 */
import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { portListening, waitPortFree, waitPortListening } from './ports.js'
import { parseRestore, restoreScript } from './window-state.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const SELF_PATH = fileURLToPath(import.meta.url)

/**
 * `--selftest`：只证明「这份脚本连同它的相对 import 能被解析」。
 *
 * 暂存副本少了 ./ports.js 时，进程会在 import 阶段直接死掉 —— 早于本文件任何一行
 * 代码，也早于第一行日志。宿主侧因此在三条启动路线上都只能看到「没有写出日志」，
 * 完全指不出原因（2026-10-17 踩到）。有了这个模式，宿主在排重启前就能问出真话。
 * 放在读配置之前：自检不需要配置，也不该因为配置缺失而失败。
 */
if (process.argv[2] === '--selftest') {
  process.stdout.write('ok\n')
  process.exit(0)
}

const CONFIG_RAW = readRawConfig(process.argv)
if (CONFIG_RAW === undefined || CONFIG_RAW.trim() === '') {
  console.error('restart-helper: missing JSON config argument')
  process.exit(64)
}

/**
 * 取助手配置：既接受内联 JSON（`argv[2]`），也接受 `--config-file <路径>`。
 *
 * 文件形式是给 WMI 启动路径用的：那种启动要经过 PowerShell 的
 * `Start-Process -ArgumentList`，把一长串带引号与中文的 JSON 塞在命令行里
 * 会被二次解析；落成文件后命令行只剩一个纯 ASCII 路径。
 * @param {string[]} argv
 * @returns {string|undefined}
 */
function readRawConfig(argv) {
  if (argv[2] === '--config-file') {
    try {
      return readFileSync(argv[3], 'utf8')
    } catch (error) {
      console.error(`restart-helper: cannot read config file: ${error.message}`)
      process.exit(64)
    }
  }
  return argv[2]
}
let config
try {
  config = JSON.parse(CONFIG_RAW)
} catch (error) {
  console.error(`restart-helper: config is not valid JSON: ${error.message}`)
  process.exit(64)
}

const mode = config.mode === 'watchdog' ? 'watchdog' : 'helper'
const isWatchdog = mode === 'watchdog'
const tag = isWatchdog ? 'watchdog' : 'helper'
const startedAt = new Date()
const startedMs = Date.now()

const lines = []
function log(message) {
  const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 23)}] [${tag}] ${message}`
  lines.push(line)
  if (typeof config.logPath === 'string' && config.logPath !== '') {
    try {
      const parent = dirname(config.logPath)
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
      appendFileSync(config.logPath, `${line}\n`, 'utf8')
    } catch { /* 日志写不了不影响重启 */ }
  }
}

function writeReport(path, value) {
  if (typeof path !== 'string' || path === '') return
  try {
    const parent = dirname(path)
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  } catch (error) {
    log(`report write failed: ${error.message}`)
  }
}

/** 进程是否还在（EPERM 说明存在但无权限，同样算活着）。 */
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** 进程的镜像名（只比对文件名：PID 来自我们自己的 ppid/pid，不存在复用误伤）。 */
function imageName(pid) {
  try {
    const out = execFileSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    })
    const match = /^"([^"]+)"/mu.exec(out)
    return match === null ? null : match[1]
  } catch {
    return null
  }
}

function sameImage(pid, exe) {
  if (!alive(pid)) return false
  const name = imageName(pid)
  if (name === null) return false
  return name.toLowerCase() === basename(exe).toLowerCase()
}

/**
 * 是否还有同一个可执行文件的进程在跑（看门狗判断「应用是不是已经起来」）。
 *
 * 必须排除自己：助手与看门狗是用 `process.execPath`（也就是壳的 exe）加
 * `ELECTRON_RUN_AS_NODE=1` 跑起来的，镜像名和壳一模一样。不排除的话，
 * 看门狗永远只能看见自己，于是每次都会判成「应用已在运行」而放弃接管。
 */
function imageRunning(exe, excludePids = []) {
  try {
    const image = basename(exe)
    const out = execFileSync('tasklist.exe', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    })
    const skip = new Set([process.pid, ...excludePids].filter((pid) => Number.isSafeInteger(pid) && pid > 0))
    for (const line of out.split(/\r?\n/u)) {
      const match = /^"([^"]+)","(\d+)"/u.exec(line)
      if (match === null) continue
      if (match[1].toLowerCase() !== image.toLowerCase()) continue
      if (skip.has(Number(match[2]))) continue
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * 新实例实际监听的端口（没有就返回 0）。
 *
 * 宿主的端口是每次启动随机挑的，拿旧端口去等必然超时；重启本身其实早就成功了。
 * 用 netstat 按 PID 反查一次，比死等 90 秒诚实得多（netstat 一分钟内基本不变）。
 */
/**
 * 新实例实际监听的端口（没有就返回 0）。
 *
 * 宿主的端口是每次启动随机挑的，拿旧端口去等必然超时；重启本身其实早就成功了。
 * 用 netstat 按 PID 反查一次，比死等 90 秒诚实得多。
 *
 * 反查必须连**子进程**一起看：壳被拉起之后，真正监听 HTTP 端口的往往是它再拉起的宿主进程，
 * 只按 relaunch 拿到的那个 PID 找会永远找不到，于是明明起来了还报 port-timeout。
 */
function listeningPortOf(pid) {
  return listeningPortFor(pid, descendantPids(pid))
}

/** 按已探好的子孙列表查端口（netstat 一次约 60ms，轮询里只查一次进程树）。 */
function listeningPortFor(pid, kids = []) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 0
  try {
    const out = execFileSync('netstat.exe', ['-ano', '-p', 'TCP'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    })
    const listeners = new Map()
    for (const line of out.split(/\r?\n/u)) {
      if (!line.includes('LISTENING')) continue
      const parts = line.trim().split(/\s+/u)
      if (parts.length < 5) continue
      const owner = Number(parts[parts.length - 1])
      if (!Number.isInteger(owner) || owner <= 0) continue
      const local = parts[1] ?? ''
      const port = Number(local.slice(local.lastIndexOf(':') + 1))
      if (Number.isInteger(port) && port > 0) listeners.set(owner, port)
    }
    if (listeners.size === 0) return 0
    const own = listeners.get(pid)
    if (own !== undefined) return own
    for (const child of kids) {
      const port = listeners.get(child)
      if (port !== undefined) return port
    }
    return 0
  } catch {
    return 0
  }
}

/** rootPid 的所有子孙进程（拿不到就返回空数组）。
 * 端口开在子进程里是常态，所以 worker 只认根 PID 是不够的。 */
function descendantPids(rootPid) {
  try {
    const script = [
      '$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId',
      '$ids = New-Object System.Collections.Generic.HashSet[int]',
      '[void]$ids.Add(' + rootPid + ')',
      '$changed = $true',
      'while ($changed) { $changed = $false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) { [void]$ids.Add([int]$p.ProcessId); $changed = $true } } }',
      '$ids | Where-Object { $_ -ne ' + rootPid + ' }',
    ].join('; ')
    const out = execFileSync(resolvePowerShell(), ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 10000, windowsHide: true,
    })
    return out.split(/\r?\n/u).map((line) => Number(line.trim())).filter((n) => Number.isInteger(n) && n > 0)
  } catch {
    return []
  }
}

function terminate(pid, why) {
  if (!alive(pid)) return false
  log(`terminate pid ${pid} - ${why}`)
  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch (error) {
    log(`terminate pid ${pid} failed: ${error.message}`)
    return false
  }
}

/** Windows PowerShell 5.1 绝对路径优先，找不到就交给 PATH。 */
function resolvePowerShell() {
  const systemRoot = process.env.SystemRoot ?? process.env.windir
  const candidates = []
  if (typeof systemRoot === 'string' && systemRoot !== '') {
    candidates.push(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  }
  candidates.push('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return 'powershell.exe'
}

/**
 * 取壳进程的原始命令行参数（只取参数部分，可执行文件单独给）。
 *
 * 这一步以前在**宿主**里做（每次排重启都同步阻塞事件循环至多 4 秒），现在搬到助手：
 * 助手本来就是短命的一次性进程，阻塞几秒没有任何代价，而且它等 graceMs 的那段时间
 * 正好可以拿来干这件事。桌面端的壳通常就是「exe + 零个参数」，拿不到也完全无所谓。
 * @returns {string} 参数串（拿不到就空串 = 零参数重启）
 */
function shellArgumentsOf(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return ''
  try {
    const out = execFileSync(resolvePowerShell(), [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
    ], { encoding: 'utf8', timeout: 4000, windowsHide: true })
    const line = out.trim()
    if (line === '') return ''
    if (line.startsWith('"')) {
      const close = line.indexOf('"', 1)
      return close > 0 ? line.slice(close + 1).trim() : ''
    }
    const space = line.indexOf(' ')
    return space > 0 ? line.slice(space + 1).trim() : ''
  } catch {
    return ''
  }
}

/**
 * 壳重新起来之后，把窗口摆回重启前的样子。
 *
 * 为什么在助手这边做：壳是不带状态重启的（createWindow 写死 1280×820），
 * 而宿主要么已经死了、要么还没起来，只有助手这一刻既活着又知道新壳的 PID。
 * 恢复脚本自己会在 PowerShell 里轮询窗口（最多 20 秒），这里只等一次结果，
 * 任何失败都只记日志——窗口没摆回去不是重启失败。
 * @param {number} pid 新壳的 PID
 * @returns {{applied: boolean, mode: string|null, reason: string|null}|null}
 */
function restoreWindowState(pid) {
  if (process.platform !== 'win32') return null
  if (config.windowStateRestore === false) return null
  const state = config.windowState
  if (state === null || typeof state !== 'object') return null
  const exe = typeof config.exe === 'string' ? config.exe : ''
  const imageName = exe === '' ? '' : basename(exe).replace(/\.exe$/iu, '')
  const script = restoreScript(state, { pid: pid, imageName, waitSeconds: 20 })
  try {
    const out = execFileSync(resolvePowerShell(), [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], { encoding: 'utf8', timeout: 30000, windowsHide: true })
    const result = parseRestore(out)
    if (result === null) log('window state: restore helper produced no result')
    else log(result.applied
      ? `window state restored (${result.mode ?? 'unknown'})`
      : `window state not restored (${result.reason ?? 'unknown reason'})`)
    return result
  } catch (error) {
    log(`window state restore failed (continuing): ${error.message}`)
    return null
  }
}

async function waitGone(pids, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    if (!pids.some((pid) => alive(pid))) return true
    await sleep(250)
  }
  return !pids.some((pid) => alive(pid))
}

/** 端口探针在 ./ports.js：只有 ECONNREFUSED 才算释放，其余按仍在监听处理。 */

/** 启动新实例：detached + 清掉 ELECTRON_RUN_AS_NODE（宿主自带，继承下去会变成纯 Node 模式）。 */
function launchApp(why, argsOverride) {
  const exe = config.exe
  const workDir = typeof config.workDir === 'string' && config.workDir !== '' && existsSync(config.workDir)
    ? config.workDir
    : dirname(exe)
  const shellArgs = String(argsOverride ?? config.shellArgs ?? '').trim()
  const args = shellArgs === '' ? [] : shellArgs.match(/"[^"]*"|\S+/gu)?.map((token) => token.replace(/^"|"$/gu, '')) ?? []
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  log(`starting ${exe} (cwd ${workDir}, args '${shellArgs}') - ${why}`)
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', cwd: workDir, env })
  child.unref()
  return child.pid ?? 0
}
/** 放看门狗：同样是 detached 的 node 子进程，能在助手被一起带走时接管重启。 */
function armWatchdog(delayMs, shellArgs) {
  const reportPath = typeof config.watchdogReportPath === 'string' && config.watchdogReportPath !== ''
    ? config.watchdogReportPath
    : (typeof config.reportPath === 'string' && config.reportPath !== ''
      ? join(dirname(config.reportPath), 'watchdog-report.json')
      : '')
  const watchdogConfig = {
    mode: 'watchdog',
    shellPid: config.shellPid,
    hostPid: config.hostPid,
    exe: config.exe,
    workDir: config.workDir,
    port: config.port,
    graceMs: delayMs,
    relaunchWaitSec: config.relaunchWaitSec,
    relaunch: config.relaunch,
    logPath: config.logPath,
    reportPath: reportPath,
    shellArgs,
    // 看门狗接管重启时也要把窗口摆回去：它拿的是同一份抓取结果。
    windowState: config.windowState,
    windowStateRestore: config.windowStateRestore,
  }
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  try {
    const child = spawn(process.execPath, [SELF_PATH, JSON.stringify(watchdogConfig)], {
      detached: true, stdio: 'ignore', env,
    })
    child.unref()
    log(`watchdog armed: pid ${child.pid}, checks in ${delayMs}ms`)
    return child.pid ?? 0
  } catch (error) {
    log(`watchdog arm failed (continuing without it): ${error.message}`)
    return 0
  }
}

// ------------------------------------------------------------------ //
// 看门狗                                                              //
// ------------------------------------------------------------------ //
if (isWatchdog) {
  log(`watchdog start: shell=${config.shellPid} host=${config.hostPid} exe=${config.exe} port=${config.port} delay=${config.graceMs}ms`)
  await sleep(Math.max(0, Number(config.graceMs) || 0))

  let outcome = 'unknown'
  let exitCode = 0
  let relaunched = false
  let relaunchPid = 0
  let portRecovered = null
  let windowRestored = null
  const listeningPid = null

  if (Number(config.port) > 0 && await portListening(Number(config.port))) {
    outcome = 'skipped-app-listening'
    log('app is listening again; watchdog stands down')
  } else if (imageRunning(config.exe)) {
    outcome = 'skipped-instance-present'
    log('another instance of the app is present; watchdog stands down')
  } else if (config.relaunch === false) {
    outcome = 'skipped-relaunch-disabled'
    log('relaunch disabled; watchdog stands down')
  } else {
    log('app is gone and nothing is listening - watchdog is taking over the relaunch')
    try {
      relaunchPid = launchApp('watchdog recovery')
      relaunched = relaunchPid > 0
      await sleep(1200)
      if (!alive(relaunchPid)) {
        outcome = 'watchdog-relaunch-died'
        exitCode = 3
        log('watchdog relaunch died immediately')
      } else {
        // 先摆窗口再等端口：窗口是用户唯一看得见的东西，等旧端口只会耗满超时。
        if (alive(relaunchPid)) windowRestored = restoreWindowState(relaunchPid)
        if (Number(config.port) > 0) {
          const portSec = Math.min(Number(config.relaunchWaitSec) || 90, 20)
          const deadline = Date.now() + portSec * 1000
          let kids = null
          let hitPort = 0
          while (Date.now() < deadline) {
            if (await waitPortListening(Number(config.port), 1)) {
              hitPort = Number(config.port)
              break
            }
            if (kids === null || kids.length === 0) kids = descendantPids(relaunchPid)
            hitPort = listeningPortFor(relaunchPid, kids)
            if (hitPort > 0) break
            await sleep(700)
          }
          portRecovered = hitPort > 0
          if (hitPort > 0 && hitPort !== Number(config.port)) log(`watchdog: old port ${config.port} is gone; new instance listens on ${hitPort}`)
          outcome = portRecovered ? 'watchdog-recovered' : 'watchdog-port-timeout'
          log(portRecovered ? 'watchdog recovery succeeded: a port is listening' : 'watchdog relaunched the app but no port came back')
        } else {
          outcome = 'watchdog-recovered'
        }
      }
    } catch (error) {
      outcome = 'watchdog-relaunch-failed'
      exitCode = 3
      log(`watchdog relaunch failed: ${error.message}`)
    }
  }

  writeReport(config.reportPath, {
    mode: 1,
    at: new Date().toISOString(),
    outcome,
    exitCode,
    elapsedMs: Date.now() - startedMs,
    exe: config.exe,
    windowRestore: windowRestored,
    port: config.port,
    listeningPid,
    relaunched,
    relaunchPid,
    portRecovered,
    logTail: lines.slice(-20),
  })
  log(`watchdog done: outcome=${outcome} exit=${exitCode}`)
  process.exit(exitCode)
}

// ------------------------------------------------------------------ //
// 主助手                                                              //
// ------------------------------------------------------------------ //
const shellPid = Number(config.shellPid)
const hostPid = Number(config.hostPid)
const exe = String(config.exe ?? '')
const port = Number(config.port) || 0
const graceMs = Math.max(0, Number(config.graceMs) || 0)
const deadlineSec = Number(config.deadlineSec) || 45
const relaunchWaitSec = Number(config.relaunchWaitSec) || 90
const shouldRelaunch = config.relaunch !== false

log(`helper start: shell=${shellPid} host=${hostPid} exe=${exe} port=${port} grace=${graceMs}ms relaunch=${shouldRelaunch} pid=${process.pid}`)
log(`workdir: ${config.workDir ?? ''}`)

/**
 * 壳的启动参数：优先用调用方给的，没给（宿主已不再同步查，见 engine.js）就自己查一次。
 * 懒求值 + 记忆化：只在真的要重新启动时付这一次查询的钱。
 */
let probedShellArgs = null
function effectiveShellArgs() {
  if (typeof config.shellArgs === 'string' && config.shellArgs !== '') return config.shellArgs
  if (config.shellArgsProbe === false) return ''
  if (probedShellArgs === null) {
    probedShellArgs = shellArgumentsOf(shellPid)
    log(`shell argv probed: '${probedShellArgs}'`)
  }
  return probedShellArgs
}

let outcome = 'unknown'
let exitCode = 0
let killedShell = false
let killedHost = false
let portFreed = null
let relaunched = false
let relaunchPid = 0
let portRecovered = null
let watchdogPid = 0
let windowRestored = null
const shellAliveAtStart = alive(shellPid)

// 身份校验：只杀「确认是同一个可执行文件」的进程，避免 PID 复用误伤他人。
const shellVerified = sameImage(shellPid, exe)
const hostVerified = sameImage(hostPid, exe)
if (!shellVerified && !hostVerified) {
  outcome = 'identity-unverified'
  exitCode = 2
  log(`refusing to kill: could not verify shell ${shellPid} / host ${hostPid} against ${exe}`)
} else {
  if (!shellVerified) log(`shell ${shellPid} identity unverified; relying on host ${hostPid}`)
  if (!hostVerified) log(`host ${hostPid} identity unverified; relying on shell ${shellPid}`)

  if (graceMs > 0) await sleep(graceMs)

  // 可选：先试一次「优雅关闭」（taskkill 不带 /F，等于发 WM_CLOSE）。
  // 默认关闭：桌面端 Electron 主窗口收到 WM_CLOSE 通常只是隐藏到托盘、并不退出，
  // 所以这一步基本没用，还会白白多等几秒。需要时由调用方显式要求（graceful=true）。
  const softCloseMs = Math.max(0, Number(config.softCloseMs) || 0)
  if (softCloseMs > 0 && alive(shellPid)) {
    log('requesting graceful quit (taskkill without /F)')
    try {
      execFileSync('taskkill.exe', ['/PID', String(shellPid)], { timeout: 5000, windowsHide: true })
    } catch (error) {
      log(`taskkill(soft) failed: ${error.message}`)
    }
    const softGone = await waitGone([shellPid, hostPid], softCloseMs / 1000)
    log(softGone ? 'graceful quit completed' : 'graceful quit did not finish in time; escalating')
  }

  if (config.watchdog !== false && shouldRelaunch) {
    watchdogPid = armWatchdog(graceMs + softCloseMs + deadlineSec * 1000 + 15000, effectiveShellArgs())
  }

  writeReport(config.reportPath, {
    mode: 0,
    phase: 'killing',
    at: new Date().toISOString(),
    shellPid,
    hostPid,
    exe,
    port,
    shellArgs: effectiveShellArgs(),
    watchdogPid,
    logTail: lines.slice(-20),
  })

  // 先壳后宿主：壳先死就不会弹出「宿主崩溃」的恢复对话框。
  killedShell = terminate(shellPid, 'forced restart (electron shell)')
  killedHost = terminate(hostPid, 'forced restart (dsh host)')

  const gone = await waitGone([shellPid, hostPid], deadlineSec)
  if (!gone) {
    outcome = 'exit-timeout'
    exitCode = 4
    log(`timed out after ${deadlineSec}s waiting for ${shellPid} / ${hostPid} to exit`)
  } else {
    log('old instance exited')
  }

  if (gone && port > 0) {
    portFreed = await waitPortFree(port, 15)
    log(`port ${port} free: ${portFreed}`)
  }

  if (gone && shouldRelaunch) {
    try {
      relaunchPid = launchApp('helper relaunch', effectiveShellArgs())
      relaunched = relaunchPid > 0
      log(`relaunched: pid ${relaunchPid} (${exe})`)
    } catch (error) {
      outcome = 'relaunch-failed'
      exitCode = 3
      log(`relaunch failed: ${error.message}`)
    }

    if (relaunched) {
      await sleep(1200)
      if (!alive(relaunchPid)) {
        outcome = 'relaunch-died'
        exitCode = 3
        log('relaunched process exited immediately')
      } else {
        // 先摆窗口，再去等端口。窗口是用户唯一看得见的东西，而宿主每次启动都会换端口：
        // 把恢复排在「等旧端口」后面，用户就得先看一分钟的小窗口，甚至永远等不到。
        windowRestored = restoreWindowState(relaunchPid)
        const portSec = Math.min(relaunchWaitSec, 20)
        if (port > 0) {
          // 旧端口大概率不会再回来（宿主每次启动随机挑端口），所以同时盯两种证据：
          // 「旧端口能连上」或者「新实例（含它的子进程）自己开了一个监听端口」。
          // 只要任一条成立就立刻收工，不把 20 秒耗满。
          const deadline = Date.now() + portSec * 1000
          let kids = null
          let hitPort = 0
          while (Date.now() < deadline) {
            if (await waitPortListening(port, 1)) {
              hitPort = port
              break
            }
            if (kids === null || kids.length === 0) kids = descendantPids(relaunchPid)
            hitPort = listeningPortFor(relaunchPid, kids)
            if (hitPort > 0) break
            await sleep(700)
          }
          portRecovered = hitPort > 0
          if (hitPort > 0 && hitPort !== port) log(`port ${port} never came back; new instance listens on ${hitPort} instead`)
          outcome = portRecovered ? 'ok' : 'ok-port-timeout'
          log(portRecovered
            ? `restart complete in ${((Date.now() - startedMs) / 1000).toFixed(1)}s; a port is listening again`
            : `app relaunched but neither port ${port} nor a new one came back within ${portSec}s`)
        } else {
          outcome = 'ok'
          log(`restart complete in ${((Date.now() - startedMs) / 1000).toFixed(1)}s`)
        }
      }
    }
  } else if (gone && !shouldRelaunch) {
    outcome = 'killed-only'
    log('relaunch disabled (self-test mode)')
  }
}

writeReport(config.reportPath, {
  mode: 0,
  phase: 'finished',
  at: new Date().toISOString(),
  startedAt: startedAt.toISOString(),
  outcome,
  exitCode,
  elapsedMs: Date.now() - startedMs,
  shellPid,
  hostPid,
  shellAliveAtStart,
  exe,
  shellArgs: effectiveShellArgs(),
  port,
  watchdogPid,
  killedShell,
  killedHost,
  portFreed,
  relaunched,
  relaunchPid,
  portRecovered,
  windowRestore: windowRestored,
  logTail: lines.slice(-40),
})
log(`helper done: outcome=${outcome} exit=${exitCode} elapsed=${((Date.now() - startedMs) / 1000).toFixed(1)}s`)
process.exit(exitCode)
