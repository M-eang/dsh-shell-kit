/**
 * dsh-shell-kit — 宿主侧共享核心（与 cordis 无关的纯逻辑）。
 *
 * 各功能模块（lib/modules/<name>/）共用这里的东西：路径解析、profile 探针、
 * 报告与日志留档、进程与插件运行状态、以及 HTTP 路由守卫。
 * 模块之间不互相 import，只共享本文件。
 */
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fenceReason } from './loopback.js'

/**
 * 装载/挂载面包屑：宿主里没有可见的控制台，插件里 ctx.logger 的输出看不到，
 * 出问题时 <数据目录>/load.log 是唯一能说清"走到哪一步、报了什么错"的地方。
 * 任何模块都可以调用；写不进去也绝不能影响功能 —— 但**失败要能被看见**：
 * 记不下面包屑时只是静默返回，出问题的人会以为"一切正常、只是没问题"，
 * 所以这里把失败次数与最后一次原因留在内存里，由聚合状态摊出去。
 */
export const diagnostics = { traceFailures: 0, lastTraceError: null }

export function trace(line) {
  try {
    mkdirSync(pluginDataDir(), { recursive: true })
    appendFileSync(join(pluginDataDir(), 'load.log'), `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch (error) {
    diagnostics.traceFailures += 1
    diagnostics.lastTraceError = error?.message ?? String(error)
  }
}
export const PLUGIN_ID = 'dsh-shell-kit'
/**
 * 版本号：唯一真相是 package.json 的 `version`，这里只负责找到它。
 *
 * 两条查找路径，按可信度排序：
 *   1. 同目录 `version.json` —— 壳（index.js）在把 lib/ 拷进
 *      `<数据目录>/instances/<hash>/` 时写下，这是插件在宿主里跑时的位置，
 *      旁边没有 package.json，所以必须靠它；
 *   2. `../package.json` —— 源码目录或被直接 import 时（测试就是这么跑的）。
 * 两条都读不到才回落 'unknown'：宁可在状态里露出 unknown，也不要再写死一个
 * 会跟 package.json 分叉的字面量 —— 0.1.2 与 0.2.0 漂了两个月就是这么来的。
 */
function readPluginVersion() {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const file of [join(here, 'version.json'), join(here, '..', 'package.json')]) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const version = typeof raw?.version === 'string' ? raw.version.trim() : ''
      if (version !== '') return version
    } catch { /* 读不到就试下一条 */ }
  }
  return 'unknown'
}

export const PLUGIN_VERSION = readPluginVersion()
export const ROUTE_PREFIX = '/api/shell-kit'
export const PLUGIN_HEADER = 'x-dsh-plugin'
export const PLUGIN_HEADER_VALUE = 'shell-kit'

/** DSH home：优先用进程环境，回落 ~/.dsh（与 dsh-home-paths 的默认一致）。 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** 本进程启动时记录的 profile 配置文件指纹（用于「启动后配置变了吗」这一判断）。 */
const profileFingerprints = new Map()

function fileFingerprint(path) {
  try {
    const info = statSync(path)
    return `${info.size}:${Math.round(info.mtimeMs)}`
  } catch {
    return null
  }
}

/**
 * 定位当前 profile 目录：优先 DSH_PROFILE 环境变量，其次宿主的 argv（宿主是
 * `… dsh-desktop-host/lib/index.js <runtimeDir> <profileDir> …` 启动的），
 * 最后看 desktop 这个默认名。找不到就返回 null（调用方按「不知道」处理）。
 */
export function resolveProfileDir() {
  const root = join(resolveDshHome(), 'profiles')
  const candidates = []
  const profileName = process.env.DSH_PROFILE
  if (typeof profileName === 'string' && profileName.trim() !== '') candidates.push(join(root, profileName.trim()))
  candidates.push(join(root, 'desktop'))
  const argvCandidate = process.argv[3]
  if (typeof argvCandidate === 'string' && argvCandidate !== '') candidates.push(argvCandidate)
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isDirectory() && existsSync(join(candidate, 'package.json'))) return candidate
    } catch { /* 试下一个 */ }
  }
  return null
}

export function pluginDataDir() {
  const dir = join(resolveDshHome(), 'dsh-shell-kit')
  try { mkdirSync(dir, { recursive: true }) } catch { /* 只读 home：调用方按失败处理 */ }
  return dir
}

/**
 * 模块自己的数据目录：`<数据目录>/<moduleName>/`。
 *
 * 这里必须把目录建出来，否则模块的日志轮转 / 报告留档 / 助手脚本暂存都会静默失败（踩过）。
 * 只返回目录本身 —— 具体文件名是各模块自己的事（restart 的文件名定义在它的 engine.js 里），
 * 这样共享层不必知道任何模块的产物名。
 * @returns {{ dir: string }}
 */
export function moduleFiles(moduleName) {
  const dir = join(pluginDataDir(), moduleName)
  try { mkdirSync(dir, { recursive: true }) } catch { /* 只读 home：调用方按失败处理 */ }
  return { dir }
}

/** 日志超过这个大小就轮转一次（日志是追加写的，否则只增不减）。 */
const MAX_LOG_BYTES = 512 * 1024
/** 报告留档保留的份数。 */
const MAX_ARCHIVED_REPORTS = 20

function stampFrom(value) {
  const source = typeof value === 'string' && value !== '' ? value : new Date().toISOString()
  return source.replace(/[:.]/gu, '-')
}

/**
 * 日志轮转：超过上限就把 restart.log 改名留档，下次写日志会新建。
 * @returns 留档后的路径，没轮转时返回 null。
 */
export function rotateLog(paths) {
  try {
    if (statSync(paths.log).size < MAX_LOG_BYTES) return null
    const target = join(paths.dir, `restart-${stampFrom(null)}.log`)
    renameSync(paths.log, target)
    return target
  } catch {
    return null
  }
}

/**
 * 把上一份报告**拷**一份进 reports/ 留档，这样「连着重启两次、第一次为什么失败」
 * 还能翻出来；原件保留不删——否则新进程一挂载就把它挪走，界面上的「上次重启」
 * 永远显示"无记录"（2026-10-17 实测踩到）。
 * @returns 留档后的路径，没有旧报告时返回 null。
 */
export function archiveReport(paths) {
  const previous = readJsonFile(paths.report)
  if (previous === null) return null
  // 只给「已结算」的报告留档：助手是先写 killing 再写 finished，而新进程往往在
  // 助手收尾之前就起来了 —— 那时读到的是 killing 阶段（没有 outcome），
  // 归了档也只会得到一堆 -unknown.json，没意义。
  if (previous.phase !== 'finished') return null
  try {
    mkdirSync(paths.reports, { recursive: true })
    const target = join(paths.reports, `${stampFrom(previous.at)}-${previous.outcome ?? 'unknown'}.json`)
    // 拷贝而不是改名：留档是"多留一份"，不是"从原位搬走"。
    copyFileSync(paths.report, target)
    const files = readdirSync(paths.reports).filter((name) => name.endsWith('.json')).sort()
    for (const old of files.slice(0, Math.max(0, files.length - MAX_ARCHIVED_REPORTS))) {
      rmSync(join(paths.reports, old), { force: true })
    }
    return target
  } catch {
    return null
  }
}

/**
 * 本进程启动后 profile 配置有没有被动过（装了/改了/删了插件多半会动这几个文件）。
 *
 * 为什么不用「问插件市场」：市场把「需要重启」这个结论**随每次安装/开关操作的响应**
 * 返回给它的客户端（`body.activation` / `restartRequired`），`/dsh-market/status`
 * 里并没有这份状态；官方侧 `pluginInventory/list` 也只报 pending/loading/active/
 * failed/unloading，没有「待重启」。与其去猜别人的内部状态，不如给一个能站得住的
 * 事实：这几个权威输入文件变了 —— 变了既可能是已热挂载、也可能是要重启。
 * @returns {{profileDir: string|null, changed: string[], at: string|null}}
 */
export function profileConfigChanges() {
  const files = ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'node_modules/.modules.yaml']
  const dir = resolveProfileDir()
  if (dir === null) return { profileDir: null, changed: [], at: null }
  const changed = []
  for (const relative of files) {
    const full = join(dir, relative)
    const current = fileFingerprint(full)
    const before = profileFingerprints.get(full)
    if (before === undefined) {
      profileFingerprints.set(full, current)
      continue
    }
    if (before !== current) {
      profileFingerprints.set(full, current)
      changed.push(relative)
    }
  }
  return { profileDir: dir, changed, at: changed.length > 0 ? new Date().toISOString() : null }
}

export function readJsonFile(path) {
  try {
    const text = readFileSync(path, 'utf8')
    if (text.trim() === '') return null
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 读取文件末尾若干行。
 *
 * 只适用于**已知有界的小文件**（例如 restart.log，上限 512KB —— 见上面的 MAX_LOG_BYTES，
 * 这里直接把它当读取上限，前提破了也只是截断而不是把整个大文件读进内存）。
 * 任意大小、可能很大的日志请用 `tailBytes()`。
 */
export function tailLines(path, count = 25) {
  const text = tailBytes(path, { maxBytes: MAX_LOG_BYTES })
  if (text === null) return []
  return text.split(/\r?\n/u).filter((line) => line !== '').slice(-count)
}

/** 单次尾读的默认上限：只读文件末尾这么多字节。 */
export const TAIL_BYTES = 256 * 1024

/**
 * 用 Buffer 精确读文件末尾一段（不把大文件整个读进内存）。
 *
 * 起点可能落在某个多字节字符中间，因此允许调用方丢掉最前面那个不完整的行
 * （`dropFirstLine`）—— 否则中文日志的尾部视图第一行会是乱码或被截断的半行。
 * @param {string} path 文件路径
 * @param {{ maxBytes?: number, dropFirstLine?: boolean }} [options]
 * @returns {string|null} 文本；文件不存在/读不了时返回 null（调用方区分"空文件"与"读失败"）
 */
export function tailBytes(path, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? Math.round(options.maxBytes) : TAIL_BYTES
  const dropFirstLine = options.dropFirstLine === true
  try {
    const info = statSync(path)
    const bytes = Math.min(info.size, maxBytes)
    const fd = openSync(path, 'r')
    let text
    try {
      const buffer = Buffer.alloc(bytes)
      const read = readSync(fd, buffer, 0, bytes, info.size - bytes)
      text = buffer.subarray(0, read).toString('utf8')
    } finally {
      closeSync(fd)
    }
    if (bytes < info.size && dropFirstLine) {
      const cut = text.indexOf('\n')
      text = cut === -1 ? '' : text.slice(cut + 1)
    }
    return text
  } catch {
    return null
  }
}

/**
 * 当前宿主能否一键自重启。
 * @param {{ webServer?: { port?: number } }} [ctx] 宿主 context（只为取端口）。
 * @returns {object} 能力事实；`supported` 为 false 时 `reasons` 说明原因。
 */
export function hostFacts(ctx) {
  const reasons = []
  const platform = process.platform
  const hostPid = process.pid
  const shellPid = process.ppid

  // 桌面端的判据（2026-09-30 实测校正）：
  //   ① 跑在 Electron 二进制里 —— process.versions.electron 有值；
  //   ② 壳把它当 Node 子进程拉起来 —— ELECTRON_RUN_AS_NODE=1。
  // 注意：壳只给「插件子进程」注入 DSH_DESKTOP_NODE_EXECUTABLE，宿主自己并没有
  // 这个变量（desktopNodeEnvironment(node, undefined, env)），所以不能靠它判断。
  // 另一路旁证是 DSH 桌面宿主的入口脚本 dsh-desktop-host/lib/index.js 出现在 argv 里。
  const electron = typeof process.versions.electron === 'string' && process.versions.electron !== ''
  const runAsNode = process.env.ELECTRON_RUN_AS_NODE === '1'
  const desktopEntry = process.argv.some((value) => typeof value === 'string' && /dsh-desktop-host[\\/]lib[\\/]index\.js/iu.test(value))
  const desktop = electron && (runAsNode || desktopEntry)
  const marker = process.env.DSH_DESKTOP_NODE_EXECUTABLE
  const exe = typeof marker === 'string' && marker.trim() !== '' ? marker.trim() : process.execPath

  if (platform !== 'win32') reasons.push(`当前系统 ${platform} 不在支持范围内（仅 Windows 桌面端）`)
  if (!electron) reasons.push('本进程不是 Electron 进程（process.versions.electron 为空）')
  else if (!desktop) reasons.push('本进程不是 DSH 桌面端的宿主进程（ELECTRON_RUN_AS_NODE 未置位，argv 里也没有 dsh-desktop-host 入口）')
  if (!Number.isInteger(shellPid) || shellPid <= 0 || shellPid === hostPid) reasons.push(`无法定位 Electron 壳进程（ppid=${String(shellPid)}）`)
  if (!/\.exe$/iu.test(exe)) reasons.push(`宿主可执行文件不是 .exe：${exe}`)

  let port = 0
  try {
    const candidate = ctx?.webServer?.port
    if (Number.isInteger(candidate) && candidate > 0) port = candidate
  } catch { /* 服务尚未就绪 */ }

  return {
    supported: reasons.length === 0,
    reasons,
    platform,
    desktop,
    exe,
    workDir: dirname(exe),
    hostPid,
    shellPid,
    port,
  }
}

/** 进程是否仍然存在（EPERM 说明存在但无权限，同样算活着）。 */
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * 是否有插件操作正在写 profile。
 *
 * 官方 plugin-manager 会把正在跑的 pnpm 运行记录在 <profile>/.plugin-manager/run.json，
 * 运行结束即删除。此刻重启会打断写 node_modules，所以默认拒绝（force 可越过）。
 * @returns {{busy: boolean, hits: Array<{profile: string, pid: number|null, detail: string}>}}
 */
export function pendingPluginRun() {
  const root = join(resolveDshHome(), 'profiles')
  const hits = []
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return { busy: false, hits }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const record = join(root, entry.name, '.plugin-manager', 'run.json')
    if (!existsSync(record)) continue
    const value = readJsonFile(record)
    const pid = value?.pid
    if (processAlive(pid)) {
      hits.push({ profile: entry.name, pid, detail: `profile ${entry.name} 的 pnpm 运行（pid ${pid}）仍在进行` })
    } else {
      hits.push({ profile: entry.name, pid: null, detail: `profile ${entry.name} 留有 .plugin-manager/run.json，但记录的进程已退出` })
    }
  }
  return { busy: hits.length > 0, hits }
}

/** Windows PowerShell 5.1 绝对路径优先，找不到就交给 PATH。 */
export function resolveWindowsPowerShell() {
  const candidates = []
  const systemRoot = process.env.SystemRoot ?? process.env.windir
  if (typeof systemRoot === 'string' && systemRoot !== '') {
    candidates.push(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  }
  candidates.push('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  for (const candidate of candidates) {
    if (candidate.includes('\\') && existsSync(candidate)) return candidate
  }
  return 'powershell.exe'
}

/* ------------------------------------------------------------------ */
/* HTTP 路由基础设施（各模块的路由共用）                                  */
/* ------------------------------------------------------------------ */

export function httpError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code })
}

export function sendJson(res, status, body) {
  if (res.writableEnded) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

export function ok(res, data) {
  sendJson(res, 200, { ok: true, data })
}

export function fail(res, error) {
  sendJson(res, error?.statusCode ?? 500, {
    ok: false,
    error: { code: error?.code ?? 'INTERNAL', message: String(error?.message ?? error) },
  })
}

/**
 * 请求体上限。宿主的 webServer 是裸 `node:http` 服务器，没有 body 限制中间件，
 * 所以这是唯一一道防线：不限的话，本机任何进程发一个大 JSON 就能把宿主内存吃满。
 * 本包所有 POST 的实际载荷都很小（`{confirm:true}` / `{force,delayMs,by}` / actions 列表）。
 */
export const MAX_BODY_BYTES = 64 * 1024

export async function readBody(req, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? Math.round(options.maxBytes) : MAX_BODY_BYTES
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    // 真实请求给的是 Buffer；这里对 string/Uint8Array 也照收，顺带让字节数算得准
    // （字符串的 .length 是字符数，不是字节数）。
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > maxBytes) {
      // 先掐掉连接再报错，避免对方继续往一个不会读完的 socket 里灌数据。
      try { req.destroy() } catch { /* 已经断了就算了 */ }
      throw httpError(413, 'BODY_TOO_LARGE', `请求体超过上限 ${maxBytes} 字节`)
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw httpError(400, 'INVALID_BODY', '请求体不是合法 JSON')
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw httpError(400, 'INVALID_BODY', '请求体必须是 JSON 对象')
  }
  return data
}

/**
 * 回环守卫的四条规则实现在 lib/loopback.js（与 dsh-prompt-refine / dsh-stt-qwen 同构）；
 * 这里重新导出，保持 `import { isLoopbackRequest } from '../lib/core.js'` 的既有写法可用。
 *
 * 语义变化（0.1.1）：`isLoopbackRequest` 现在**只看套接字**；转发痕迹与
 * Host/Origin 交给 `fenceReason` / `isTrustedRequest` 判定。localRoute 走的是
 * 后者，所以「有转发头」「Host 是被 rebind 的攻击域名」「Origin 是跨站页面」
 * 这三种情况都会在路由层被拒 —— 旧实现只查了转发头与套接字。
 */
export { fenceReason, isLoopbackRequest, isTrustedRequest } from './loopback.js'

/**
 * 非 GET 请求必须带 x-dsh-plugin: shell-kit —— 自定义头会触发 CORS 预检，
 * 而本服务器从不回答预检，等于一层最小的 CSRF 防线。
 */
export function guard(handler) {
  return async (req, res) => {
    try {
      if (req.method !== 'GET' && req.headers?.[PLUGIN_HEADER] !== PLUGIN_HEADER_VALUE) {
        throw httpError(403, 'FORBIDDEN', `缺少 ${PLUGIN_HEADER}: ${PLUGIN_HEADER_VALUE} 请求头`)
      }
      await handler(req, res)
    } catch (error) {
      fail(res, error)
    }
  }
}

/**
 * 注册一条"只服务本机回环"的 exact 路由。
 *
 * 把这几道固定检查（`guard` 的插件头 + 方法白名单 + 回环守卫的四条规则）收在一处：
 * 各个模块只写业务逻辑。这样"漏写回环检查"从一个可能发生的疏忽，变成不可能 ——
 * 新增路由时不需要记得检查任何东西。
 * @param {object} ctx 宿主 context
 * @param {{ method: 'GET'|'POST', path: string, handler: (req, res) => any }} route
 * @returns {() => void} 注销函数（webServer.register 的返回值）
 */
export function localRoute(ctx, route) {
  const method = String(route.method).toUpperCase()
  return ctx.webServer.register({
    kind: 'exact',
    path: route.path,
    handler: guard(async (req, res) => {
      if (req.method !== method) throw httpError(405, 'METHOD', `只接受 ${method}`)
      const reason = fenceReason(req)
      if (reason !== null) throw httpError(403, 'FORBIDDEN', `只接受本机回环请求（${reason}）`)
      await route.handler(req, res)
    }),
  })
}

/* ------------------------------------------------------------------ */
/* 注册状态追踪与命令/工具接线（各模块共用）                              */
/* ------------------------------------------------------------------ */

/**
 * 各模块 `status()` 里都会摊出去的那份"注册情况"。
 *
 * 初值 `command: false` / `tool: false`、`toolError: '等待 tools 服务'` 是有意的：
 * 命令与工具都挂在 `ctx.inject()` 的回调里，服务不出现就永远不会置位，
 * 这几个初值正是"没挂上"的可观测证据。
 */
export function createRegistryTracker() {
  const state = { routes: 0, command: false, tool: false, toolError: '等待 tools 服务' }
  return {
    state,
    /** @param {Partial<typeof state>} patch */
    record(patch) { Object.assign(state, patch) },
  }
}

/**
 * 注册一条斜杠命令：等服务出现 → 注册 → 记状态 → 失败只记日志。
 *
 * `ctx.inject()` 的回调里注册的东西由那个子 fiber 持有，不需要模块自己释放；
 * 模块只负责自己的路由（用 `localRoute` 拿到 disposer）。
 * @param {object} ctx 宿主 context
 * @param {{ label: string, register: (commandCtx: object) => any, tracker: ReturnType<typeof createRegistryTracker> }} input
 */
export function registerCommands(ctx, input) {
  const { label, register, tracker } = input
  ctx.inject(['commands'], (commandCtx) => {
    try {
      register(commandCtx)
      tracker.record({ command: true })
      ctx.logger?.info(`[shell-kit:${label}] 已注册斜杠命令`)
    } catch (error) {
      ctx.logger?.warn(`[shell-kit:${label}] 斜杠命令注册失败：${error?.message ?? String(error)}`)
    }
  })
}

/**
 * 注册一个智能体工具：与服务注册同上的约定，额外维护 `tool` / `toolError` 两个状态位。
 * @param {object} ctx 宿主 context
 * @param {{ label: string, definition: object|((toolCtx: object) => object), tracker: ReturnType<typeof createRegistryTracker> }} input
 */
export function registerTools(ctx, input) {
  const { label, definition, tracker } = input
  ctx.inject(['tools'], (toolCtx) => {
    tracker.record({ toolError: 'tools 服务出现但注册未完成' })
    try {
      toolCtx.tools.register(typeof definition === 'function' ? definition(toolCtx) : definition)
      tracker.record({ tool: true, toolError: null })
      ctx.logger?.info(`[shell-kit:${label}] 已注册智能体工具`)
    } catch (error) {
      tracker.record({ toolError: `注册失败：${error?.message ?? String(error)}` })
      ctx.logger?.warn(`[shell-kit:${label}] 工具注册失败：${error?.message ?? String(error)}`)
    }
  })
}