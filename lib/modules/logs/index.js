/**
 * dsh-shell-kit — 「宿主日志」模块。
 *
 * 解决的问题：桌面端打包后，Harness 宿主的 stdout/stderr 只被壳 pipe 走，**没有文件**。
 * 于是插件在运行时吐的告警（`ctx.logger.warn(...)`）、装载期的错误，事后都查不到。
 * 这里的做法就是 dsh-desktop 的 `dsh-desktop-log-bridge` 那条思路的"落盘版"：
 * 拦一次 `process.stdout.write` / `process.stderr.write`，把内容缓冲后写进
 *   <数据目录>/logs/harness-YYYYMMDD.log
 * 并给界面/命令/agent 工具一个查看入口（列文件、看尾部、按文件读）。
 *
 * 三条约束：
 *   · 拦截必须**穿透**（原样调用原函数），绝不能吞掉宿主自己的输出；
 *   · 写盘失败也绝不能影响宿主（全部 try/catch，且不写 stdout/stderr，避免递归）；
 *   · 只清理我们自己的 `harness-*.log`，不动别人任何文件。
 *
 * 注意：它只能记到"本模块挂载之后"的输出 —— 所以它在模块表里排第一位；
 * 装载器自己早期的输出（早于所有插件）仍然只能靠宿主崩溃报告（doctor 会读）。
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { format as formatMessage } from 'node:util'
import {
  createRegistryTracker,
  httpError,
  localRoute,
  moduleFiles,
  ok,
  registerCommands,
  registerTools,
  ROUTE_PREFIX,
  tailBytes,
  trace,
} from '../../core.js'
import { createSseWriter, sseComment, sseFrame } from '../../sse.js'

export const moduleName = 'logs'
export const label = { zh: '宿主日志', en: 'Host log' }
export const description = {
  zh: '把 Harness 宿主的 stdout/stderr 落盘成 harness-<日期>.log，并提供查看尾部/按文件读取的入口。',
  en: 'Persist the Harness host stdout/stderr into harness-<date>.log with tail and read endpoints.',
}

/** 单次落盘前最多缓冲的字节数：超过就先写出去，避免内存膨胀。 */
const FLUSH_THRESHOLD_BYTES = 128 * 1024
/** 缓冲最多留多久就落盘（毫秒）。 */
const FLUSH_INTERVAL_MS = 1000
/** 单个文件超过这个大小就滚成 -1/-2…。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024
/** 我们自己的日志最多保留几个文件。 */
const MAX_FILES = 6
/** 拦截标记：避免重复挂载时套多层 write。 */
const WRAP_MARKER = Symbol.for('dsh-shell-kit.logs.wrapped')
/** 我们自己的日志文件命名（列表、清理、滚动统一用它）。 */
const LOG_FILE_PATTERN = /^harness-\d{8}(?:-\d+)?\.log$/u

/**
 * 上一次挂载留下的 exporter 状态。
 *
 * `ctx.logger.exporter()` 内部就是 `ctx.effect()`，模块 fiber 被拆时会自行注销
 * （见 cordis `LoggerService.exporter`），所以正常的热重载路径不需要我们做什么。
 * 这里保留一句可观测的记录：如果挂载时发现上一次的 exporter 还没注销，
 * 说明释放路径没跑完 —— 那就要能在状态里看见，否则两个 sink 会交错写同一份日志、
 * `droppedBytes` 也会被拆到两个实例上。
 */
const exporterState = { active: false, previousOverlapped: false }

function stamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
}

function toBuffer(chunk, encoding) {
  if (Buffer.isBuffer(chunk)) return chunk
  if (typeof chunk === 'string') return Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8')
  return Buffer.from(String(chunk), 'utf8')
}

/**
 * 落盘器：缓冲 + 定时/阈值刷盘 + 按大小滚文件 + 只清理自己的旧文件。
 *
 * 滚动命名统一为 `harness-<日期>-<序号>.log`：以前还留过一条 `-<时间戳>.log` 的分支，
 * 那种名字既不匹配列表正则（读不到），也不匹配清理正则（永远堆着），是纯粹的漏网文件。
 */
function createSink(logDir) {
  const state = { buffer: [], bytes: 0, timer: undefined, file: null, dropped: 0, writeError: null }

  function ensureDir() {
    try {
      if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })
    } catch { /* 写不进去时下面的 try 会兜住 */ }
  }

  function currentFile() {
    ensureDir()
    if (state.file !== null) return state.file
    let index = 0
    let candidate = join(logDir, `harness-${stamp()}.log`)
    while (existsSync(candidate) && statSync(candidate).size >= MAX_FILE_BYTES && index < 50) {
      index += 1
      candidate = join(logDir, `harness-${stamp()}-${index}.log`)
    }
    state.file = candidate
    return candidate
  }

  function pruneOldFiles() {
    try {
      const files = readdirSync(logDir)
        .filter((name) => LOG_FILE_PATTERN.test(name))
        .map((name) => ({ name, at: statSync(join(logDir, name)).mtimeMs }))
        .sort((a, b) => b.at - a.at)
      for (const old of files.slice(MAX_FILES)) rmSync(join(logDir, old.name), { force: true })
    } catch { /* 清理失败不影响记录 */ }
  }

  function flush() {
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    if (state.bytes === 0) return
    // 直接落 Buffer：多一次 `toString('utf8')` 只是把同样的字节解码成字符串、
    // 再由 appendFileSync 编回去（实测 800KB 一次多约 0.26ms，而 flush 最多每秒一次）。
    // dropped 仍按**字节数**记（以前记的是字符串 UTF-16 长度，中文会少算）。
    const buffer = Buffer.concat(state.buffer, state.bytes)
    state.buffer = []
    state.bytes = 0
    try {
      const file = currentFile()
      const size = existsSync(file) ? statSync(file).size : 0
      if (size >= MAX_FILE_BYTES) {
        // 滚文件：按 currentFile() 的同一套序号命名，下一次写新文件
        let index = 1
        let rolled = join(logDir, `harness-${stamp()}-${index}.log`)
        while (existsSync(rolled)) {
          index += 1
          rolled = join(logDir, `harness-${stamp()}-${index}.log`)
        }
        try { renameSync(file, rolled) } catch { /* 改不了就继续往后写 */ }
        state.file = null
        // 清理只在滚动时做：每次 flush 都 readdir + stat 一次，等于把宿主的
        // 标准输出路径反复拖进磁盘元数据操作。
        pruneOldFiles()
      }
      appendFileSync(currentFile(), buffer)
      state.writeError = null
    } catch (error) {
      state.dropped += buffer.length
      state.writeError = error?.message ?? String(error)
    }
  }

  return {
    write(chunk, encoding) {
      try {
        const buffer = toBuffer(chunk, encoding)
        if (buffer.length === 0) return
        state.buffer.push(buffer)
        state.bytes += buffer.length
        // 到阈值也不能同步 flush：flush 里的 appendFileSync 是同步磁盘 I/O，
        // 直接在 write 里调用等于把宿主的每一次标准输出都阻塞住。改成"下个 tick 立刻写"，
        // 缓冲区最多多活一个 tick，内存上限不变。
        if (state.bytes >= FLUSH_THRESHOLD_BYTES) {
          if (state.timer !== undefined) clearTimeout(state.timer)
          state.timer = setTimeout(() => { state.timer = undefined; flush() }, 0)
          state.timer.unref?.()
        } else if (state.timer === undefined) {
          state.timer = setTimeout(() => { state.timer = undefined; flush() }, FLUSH_INTERVAL_MS)
          state.timer.unref?.()
        }
      } catch { /* 记录失败也要保证宿主输出照常 */ }
    },
    flush,
    file: () => state.file,
    dropped: () => state.dropped,
    writeError: () => state.writeError,
  }
}

/** 安装/卸载对 stdout、stderr 的穿透式拦截（`captureStdio: false` 时只建 sink、不碰流）。 */
function installCapture(logDir, { captureStdio = true } = {}) {
  const sink = createSink(logDir)
  const targets = captureStdio
    ? [
      { stream: process.stdout, name: 'stdout' },
      { stream: process.stderr, name: 'stderr' },
    ]
    : []
  const installed = []
  for (const target of targets) {
    const stream = target.stream
    if (stream === undefined || stream === null) continue
    if (stream[WRAP_MARKER] === true) continue
    const original = stream.write
    if (typeof original !== 'function') continue
    const wrapper = function write(chunk, encoding, callback) {
      sink.write(chunk, encoding)
      // 穿透：原样交给原函数，绝不改变宿主行为
      return original.call(this, chunk, encoding, callback)
    }
    try {
      stream.write = wrapper
      stream[WRAP_MARKER] = true
      installed.push({ stream, original, wrapper })
    } catch { /* 冻结的流就跳过 */ }
  }
  return {
    installed,
    sink,
    restore() {
      for (const item of installed) {
        try {
          if (item.stream.write === item.wrapper) item.stream.write = item.original
          delete item.stream[WRAP_MARKER]
        } catch { /* 尽力恢复 */ }
      }
    },
  }
}

function listLogFiles(logDir) {
  try {
    if (!existsSync(logDir)) return []
    return readdirSync(logDir)
      .filter((name) => LOG_FILE_PATTERN.test(name))
      .map((name) => {
        const info = statSync(join(logDir, name))
        return { name, size: info.size, at: info.mtime.toISOString() }
      })
      .sort((a, b) => (a.at < b.at ? 1 : -1))
  } catch {
    return []
  }
}

/**
 * 读某个日志文件的尾部（默认自己最新的那份）。
 *
 * 返回三态，供调用方区分「目录里还没有日志」和「你点名的那个文件不存在」——
 * 这两种情况以前共用一条消息，于是"文件明明在列表里"的时候用户会被告知"还没有日志文件"。
 * @returns {{ file: string|null, lines: string[], size: number, files: Array<object>, requested?: string, missing?: boolean }}
 */
function tailLog(logDir, { lines = 200, file = null } = {}) {
  const files = listLogFiles(logDir)
  const chosen = file === null ? files[0] : files.find((item) => item.name === file)
  if (chosen === undefined) {
    return file === null
      ? { file: null, lines: [], size: 0, files }
      : { file: null, lines: [], size: 0, files, requested: file, missing: true }
  }
  const full = join(logDir, chosen.name)
  // 只读末尾一段（日志可能很大，不整个读进内存）；起点可能落在多字节字符中间，
  // 所以丢掉最前面那个不完整的行，中文字符串不会以乱码开头。
  const text = tailBytes(full, { dropFirstLine: true })
  if (text === null) return { file: chosen.name, lines: [], size: chosen.size, files }
  const all = text.split(/\r?\n/u)
  return { file: chosen.name, size: chosen.size, lines: all.slice(Math.max(0, all.length - lines)), files }
}

/**
 * 把 cordis 的日志记录格式化成一行（自己格式化，不 import cordis）：
 * `[ISO 时间] [级别] [logger 名] 正文`
 *
 * 注意 cordis 的 logger **自己不往 stdout/stderr 写** —— 它只把记录交给注册的
 * exporter（阈值规则：`exporter.levels[name] ?? levels.default ?? logger.level >= message.level`，
 * 所以给一个足够大的 default 就能收下全部级别）。这也是为什么光拦 stdout 抓不到
 * `ctx.logger.info(...)`：宿主压根没往流里写。
 */
function formatRecord(message) {
  const ts = new Date(typeof message?.ts === 'number' ? message.ts : Date.now()).toISOString()
  const type = String(message?.type ?? 'info').toUpperCase()
  const name = String(message?.name ?? '?')
  const args = Array.isArray(message?.args) ? message.args.map((arg) => (arg instanceof Error ? (arg.stack ?? arg.message) : arg)) : []
  let text = ''
  try {
    text = args.length === 0 ? '' : formatMessage(...args)
  } catch {
    text = args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' ')
  }
  const body = text.split(/\r?\n/u).map((line, index) => (index === 0 ? line : `    ${line}`)).join('\n')
  return `[${ts}] [${type}] [${name}] ${body}`
}

/** 单 tick 最多读这么多新增字节（读不完下一 tick 接着读，避免一次把大日志读进内存）。 */
const MAX_STREAM_CHUNK_BYTES = 256 * 1024
/** 半行缓冲的上限：一行长到这种程度就不再留（防止一个只写不换行的进程把内存吃满）。 */
const MAX_STREAM_PENDING_BYTES = 64 * 1024

/**
 * 实时跟随当前日志文件的字节游标（SSE 流用它）。
 *
 * 只读增量：每 tick 记下读到哪个字节，下一 tick 从该偏移继续；文件被 roll
 * （本模块按大小滚动）时游标归零并报一条 `file` 事件。按 `0x0A` 切行，
 * 半行与"跨块被切断的多字节字符"都留在缓冲里 —— 所以中文行不会在帧里裂成乱码。
 *
 * @param {{ logDir: string, writer: object, flush?: () => void, fromBegin?: boolean, intervalMs?: number, heartbeatMs?: number }} options
 * @returns {{ start: () => Promise<void>, stop: () => void }}
 */
function createLogStream({ logDir, writer, flush, fromBegin = false, intervalMs = 1000, heartbeatMs = 15000 }) {
  const state = {
    timer: undefined,
    stopped: false,
    busy: false,
    bound: false,
    file: null,
    offset: null,
    pending: Buffer.alloc(0),
    lastFrameAt: Date.now(),
  }

  const emitText = async (text) => {
    for (const raw of text.split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      if (line === '') continue
      state.lastFrameAt = Date.now()
      await writer.write(sseFrame('line', { line }))
    }
  }

  const readDelta = async (name) => {
    const full = join(logDir, name)
    let size
    try {
      size = statSync(full).size
    } catch {
      return
    }
    if (state.offset === null) {
      // 首次绑定：默认从现在开始（只看新行）；?from=begin 才从头读
      state.offset = fromBegin ? 0 : size
      if (!fromBegin) return
    } else if (size < state.offset) {
      state.offset = 0
    }
    if (size <= state.offset) return

    const length = Math.min(size - state.offset, MAX_STREAM_CHUNK_BYTES)
    const buffer = Buffer.allocUnsafe(length)
    let read = 0
    const fd = openSync(full, 'r')
    try {
      read = readSync(fd, buffer, 0, length, state.offset)
    } finally {
      closeSync(fd)
    }
    if (read <= 0) return
    state.offset += read

    const merged = Buffer.concat([state.pending, buffer.subarray(0, read)])
    const cut = merged.lastIndexOf(0x0a)
    if (cut === -1) {
      state.pending = merged.length > MAX_STREAM_PENDING_BYTES ? Buffer.alloc(0) : merged
      return
    }
    state.pending = Buffer.from(merged.subarray(cut + 1))
    await emitText(merged.subarray(0, cut).toString('utf8'))
  }

  const tick = async () => {
    if (state.stopped || state.busy) return
    state.busy = true
    try {
      try {
        flush?.()
      } catch { /* 刷不出去也要继续跟，下一 tick 再试 */ }
      const newest = listLogFiles(logDir)[0] ?? null
      if (newest !== null && newest.name !== state.file) {
        const rolled = state.bound
        state.file = newest.name
        state.offset = null
        state.pending = Buffer.alloc(0)
        state.bound = true
        // 第一次绑定不必报；roll 之后要报，否则读者会以为日志停在了旧文件末尾。
        if (rolled) await writer.write(sseFrame('file', { name: newest.name, rolled: true }))
      }
      if (state.file !== null) await readDelta(state.file)
    } catch (error) {
      try {
        await writer.write(sseFrame('error', { message: String(error?.message ?? error) }))
      } catch { /* 写不进去就算了，流本身已经坏了 */ }
    } finally {
      state.busy = false
    }
    if (Date.now() - state.lastFrameAt >= heartbeatMs) {
      state.lastFrameAt = Date.now()
      await writer.write(sseComment('ping')).catch(() => {})
    }
  }

  return {
    async start() {
      await tick()
      state.timer = setInterval(() => {
        void tick()
      }, intervalMs)
      state.timer.unref?.()
    },
    stop() {
      if (state.stopped) return
      state.stopped = true
      if (state.timer !== undefined) clearInterval(state.timer)
      state.timer = undefined
      writer.dispose()
    },
  }
}

/**
 * 挂载「宿主日志」模块。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ config?: object }} [shared]
 */
export function mount(ctx, shared = {}) {
  const config = shared.config ?? {}
  const captureStdio = config.captureStdio !== false
  const paths = moduleFiles('logs')
  const logDir = paths.dir
  const tracker = createRegistryTracker()
  const registrations = tracker.state
  const disposers = []
  /** 打开的实时流：模块被拆时要一起停掉，否则 setInterval 会跟着模块表一起留在内存里。 */
  const activeStreams = new Set()
  let exportedRecords = 0
  let exporterError = null

  const capture = installCapture(logDir, { captureStdio })
  capture.sink.write(`\n===== dsh-shell-kit logs 开始记录 ${new Date().toISOString()} pid=${process.pid} =====\n`)

  // ① 首选：cordis 的正式导出钩子，拿到结构化记录（包含别的插件与宿主自己打的日志）
  try {
    if (typeof ctx.logger?.exporter === 'function') {
      exporterState.previousOverlapped = exporterState.active
      if (exporterState.previousOverlapped) {
        trace('logs：检测到上一次挂载的 exporter 尚未注销，本次会与它短暂交错写日志（若反复出现，说明释放路径没跑完）')
      }
      // exporter() 的返回值是注销函数，句柄必须拿住：正常路径下 cordis 会随本模块的
      // fiber 一起注销它（LoggerService.exporter 内部就是 ctx.effect），
      // 这里在 dispose() 里再显式调一次，保证"模块被释放"等价于"不再写任何一条记录"。
      const disposeExporter = ctx.logger.exporter({
        colors: false,          // 文件里不要 ANSI 转义
        maxLength: 4096,
        levels: { default: 999 }, // 阈值足够大 → 收下 debug/info/warn/error 全部
        export(message) {
          exportedRecords += 1
          capture.sink.write(`${formatRecord(message)}\n`)
        },
      })
      exporterState.active = true
      if (typeof disposeExporter === 'function') {
        disposers.push(() => {
          disposeExporter()
          exporterState.active = false
        })
      }
    } else {
      exporterError = 'ctx.logger.exporter 不可用，只靠 stdio 兜底'
      trace(`logs：${exporterError}`)
    }
  } catch (error) {
    exporterError = error?.message ?? String(error)
    trace(`logs：注册 exporter 失败：${exporterError}`)
  }

  trace(`logs.mount：exporter=${typeof ctx.logger?.exporter === 'function'} 拦截流=${capture.installed.length} stdio=${captureStdio} 目录=${logDir}`)

  try {
    disposers.push(localRoute(ctx, {
      method: 'GET',
      path: `${ROUTE_PREFIX}/logs/list`,
      handler: async (req, res) => {
        ok(res, {
          dir: logDir,
          files: listLogFiles(logDir),
          droppedBytes: capture.sink.dropped(),
          writeError: capture.sink.writeError(),
          current: capture.sink.file(),
        })
      },
    }))
    disposers.push(localRoute(ctx, {
      method: 'GET',
      path: `${ROUTE_PREFIX}/logs/tail`,
      handler: async (req, res) => {
        // 先把自己的缓冲刷出去，看到的才是"到现在为止"的真实内容
        capture.sink.flush()
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const lines = Math.min(2000, Math.max(1, Number(url.searchParams.get('lines')) || 200))
        const file = url.searchParams.get('file')
        const tail = tailLog(logDir, { lines, file })
        if (tail.missing === true) throw httpError(404, 'LOG_NOT_FOUND', `没有这个日志文件：${file}`)
        ok(res, { dir: logDir, ...tail })
      },
    }))
    disposers.push(localRoute(ctx, {
      method: 'GET',
      path: `${ROUTE_PREFIX}/logs/stream`,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const fromBegin = url.searchParams.get('from') === 'begin'
        const intervalMs = Math.min(5000, Math.max(200, Number(url.searchParams.get('intervalMs')) || 1000))
        const writer = createSseWriter(res)
        writer.open()
        const stream = createLogStream({
          logDir,
          writer,
          flush: () => capture.sink.flush(),
          fromBegin,
          intervalMs,
        })
        activeStreams.add(stream)
        const stop = () => {
          activeStreams.delete(stream)
          stream.stop()
        }
        res.once('close', stop)
        await stream.start()
      },
    }))
  } catch (error) {
    ctx.logger?.warn(`[shell-kit:logs] 路由注册失败：${error?.message ?? String(error)}`)
    trace(`logs 路由注册失败：${error?.stack ?? error?.message ?? String(error)}`)
  }
  registrations.routes = disposers.length

  registerCommands(ctx, {
    label: 'logs',
    tracker,
    register: (commandCtx) => commandCtx.commands.register({
      name: 'logs',
      description: '查看 Harness 宿主日志（落盘在 <数据目录>/logs/）：/logs [行数]',
      input: { hint: '[行数]' },
      handler: ({ rawInput }) => {
        try {
          capture.sink.flush()
          const lines = Math.min(500, Math.max(10, Number(String(rawInput ?? '').trim()) || 60))
          const tail = tailLog(logDir, { lines })
          if (tail.file === null) return { kind: 'error', text: `还没有日志文件（目录：${logDir}）` }
          return { kind: 'success', text: `# ${tail.file}（${tail.size} 字节，最后 ${lines} 行）\n\n${tail.lines.join('\n')}` }
        } catch (error) {
          return { kind: 'error', text: `读取日志失败：${error?.message ?? String(error)}` }
        }
      },
    }),
  })

  registerTools(ctx, {
    label: 'logs',
    tracker,
    definition: {
      name: 'read_harness_log',
      description: [
        '读取 DeepSeek Harness 宿主的运行时日志（本插件把 stdout/stderr 落盘到 <数据目录>/logs/harness-<日期>.log）。',
        '插件告警、装载错误、宿主输出都在里面。只看得到本插件挂载之后的内容；更早的装载期失败去看 diagnose_plugins。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          lines: { type: 'number', description: '读最后多少行（默认 200，上限 2000）' },
          file: { type: 'string', description: '指定文件名（默认最新的一份）' },
        },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args) {
        const options = typeof args === 'object' && args !== null ? args : {}
        capture.sink.flush()
        const lines = Math.min(2000, Math.max(1, Number(options.lines) || 200))
        const tail = tailLog(logDir, { lines, file: typeof options.file === 'string' ? options.file : null })
        const fileList = (tail.files ?? []).map((item) => `${item.name}(${item.size}B)`).join('、')
        if (tail.missing === true) return `没有这个日志文件：${tail.requested}\n目录里现有：${fileList || '（空）'}`
        if (tail.file === null) return `还没有日志文件（目录：${logDir}）`
        return `# ${tail.file}（${tail.size} 字节；目录里还有：${fileList}）\n\n${tail.lines.join('\n')}`
      },
    },
  })

  return {
    dispose() {
      // 实时流先停：它们的定时器与响应不属于 disposers，只跟着模块活。
      for (const stream of activeStreams) stream.stop()
      activeStreams.clear()
      // 先注销 exporter 再释放路由：释放之后不该再有任何一条记录写进我们的 sink。
      for (const dispose of disposers) {
        try { dispose() } catch { /* 释放失败不影响进程退出 */ }
      }
      capture.sink.flush()
      capture.restore()
    },
    status() {
      const files = listLogFiles(logDir)
      return {
        dir: logDir,
        files: files.length,
        newest: files[0]?.name ?? null,
        newestSize: files[0]?.size ?? 0,
        wrappedStreams: capture.installed.length,
        captureStdio: captureStdio === true,
        exportedRecords,
        droppedBytes: capture.sink.dropped(),
        writeError: capture.sink.writeError(),
        exporterError,
        exporterOverlapped: exporterState.previousOverlapped,
        registrations: { ...registrations },
      }
    },
  }
}
