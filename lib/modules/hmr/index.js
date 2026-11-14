/**
 * dsh-shell-kit — 「热重载 (HMR)」模块。
 *
 * 官方的 `@deepseek-ai/dsh-hmr`（profile 里 `- id: hmr`）管三件事：替换插件源码模块、
 * 刷新 Include、以及在 profile 配置（`cordis.yml` / `cordis.patch.yml` / manifest）
 * 变化时**不重启进程**地重新组合插件树。桌面 profile 默认给它的 `config.root` 是 `[]`，
 * 也就是说：**配置改动热生效，源码改动仍需重启**；想在编辑源码时也热生效，得给那条
 * 配置加 `root: ["."]`（见 dsh-hmr 的 README）。
 *
 * 这件事对 shell-kit 的意义在于：本插件此前只会「整进程重启」。装了 HMR 之后，
 * 「改完到底要不要重启」变成一个**可观测、可分情况回答**的问题，而不是一律重启。
 * 所以这个模块只做三件不越权的事：
 *   ① 如实报出 HMR 在不在、什么状态、监听哪些目录（活体 loader 里读，不猜）；
 *   ② 把 `hmr/change` / `hmr/reload` 事件记成结构化事件（谁在什么时候被重载了）；
 *   ③ 提供 `GET /hmr/events` 的 SSE 流，让面板能实时看着重载发生。
 *
 * 故意**不**自己动手触发重载：本版本的 dsh-hmr 没有对外暴露「请重载这个条目」的
 * 编程接口（`runReload` 在插件内部），伪造出来的触发方式（比如无意义地重写配置文件
 * 去骗文件监听）比"如实说"更危险。需要热生效就让用户/插件市场去改配置。
 */
import { localRoute, ok, ROUTE_PREFIX, trace } from '../../core.js'
import { createSseWriter, sseComment, sseFrame } from '../../sse.js'

export const moduleName = 'hmr'

export const label = { zh: '热重载 (HMR)', en: 'Hot reload (HMR)' }

/** 卡片里这一块的说明（客户端按模块渲染时用）。 */
export const description = {
  zh: '报告官方 dsh-hmr 的活体状态：源码改动会不会热生效、监听哪些目录、最近重载了什么；并提供重载事件的 SSE 流。不代替你触发重载。',
  en: 'Reports the live state of the official dsh-hmr: whether source edits apply hot, which roots are watched, and what was reloaded most recently; also streams reload events over SSE. It never triggers a reload for you.',
}

/** HMR 条目在 profile 里固定的 id 与包名。 */
const HMR_ENTRY_ID = 'hmr'
const HMR_ENTRY_NAME = '@deepseek-ai/dsh-hmr'

/** fiber 阶段码 → 名字（与 doctor 模块同一张表；cordis 的 FiberState 枚举）。 */
const FIBER_STATES = { 0: 'pending', 1: 'loading', 2: 'active', 3: 'failed', 4: 'unloading' }

/** 事件环上限（状态路由里回看的条数）。 */
const MAX_EVENTS = 50
/** SSE 心跳间隔：没有事件时也要让中间的代理知道连接还活着。 */
const SSE_HEARTBEAT_MS = 15000

/** 取活体 loader 条目列表；拿不到就返回空数组（不抛）。 */
function loaderEntries(ctx) {
  try {
    const loader = ctx.get('loader')
    return typeof loader?.entries === 'function' ? Array.from(loader.entries() ?? []) : []
  } catch {
    return []
  }
}

/**
 * 从活体 loader 里定位 HMR 条目。
 * @param ctx 宿主上下文。
 * @returns 条目摘要；找不到时 `found: false`。
 */
function readHmrEntry(ctx) {
  for (const entry of loaderEntries(ctx)) {
    const id = entry?.options?.id ?? entry?.id ?? null
    const name = entry?.options?.name ?? entry?.name ?? null
    if (id !== HMR_ENTRY_ID && name !== HMR_ENTRY_NAME) continue
    const state = entry?.fiber?.state
    const config = entry?.options?.config ?? null
    const root = Array.isArray(config?.root) ? config.root.filter((item) => typeof item === 'string') : null
    return {
      found: true,
      id,
      name,
      disabled: entry?.options?.disabled === true,
      state: state === undefined || state === null ? 'no-fiber' : (FIBER_STATES[state] ?? `state-${String(state)}`),
      root,
    }
  }
  return { found: false, id: null, name: null, disabled: null, state: null, root: null }
}

/**
 * 一句话结论（给客户端本地化用的稳定 code，不在线上传中文）。
 * - `active`       HMR 活着，且监听了源码目录 → 源码改动会热生效
 * - `config-only`  HMR 活着，但 `root: []` → 只有 profile 配置改动热生效
 * - `disabled`     条目被显式停用 → 任何改动都要重启
 * - `inactive`     条目在，但没有存活 fiber（从未启动 / 已被释放）
 * - `missing`      profile 里没有这条条目
 * @param entry `readHmrEntry` 的结果。
 * @returns code。
 */
function verdictOf(entry) {
  if (!entry.found) return 'missing'
  if (entry.disabled) return 'disabled'
  if (entry.state !== 'active') return 'inactive'
  return Array.isArray(entry.root) && entry.root.length > 0 ? 'active' : 'config-only'
}

/**
 * 挂载模块。
 * @param ctx 宿主上下文。
 * @returns `{ dispose, status }`，由 lib/host.js 统一管理。
 */
export function mount(ctx) {
  let hasLoader = false
  try {
    hasLoader = ctx?.get?.('loader') != null
  } catch {
    // 没有 loader 服务时一切按 missing / 无事件报告，不阻断挂载。
  }
  trace(`hmr.mount 开始：loader=${hasLoader ? 'present' : 'absent'}`)
  const state = {
    lastChangeAt: null,
    lastChangeUrl: null,
    lastReloadAt: null,
    reloadCount: 0,
    events: [],
  }
  /** 当前打开的 SSE 订阅者：`push` 由各写入器自己实现。 */
  const subscribers = new Set()
  /** 各条直播流的收尾函数（清心跳、摘订阅、释放写入器），dispose 时统一跑。 */
  const streamStops = new Set()
  const disposers = []
  const listeners = []

  /** 记一条事件：进状态环 + 广播给 SSE 订阅者 + 写一行结构化日志。 */
  function record(kind, data) {
    const event = { at: new Date().toISOString(), kind, ...data }
    state.events.unshift(event)
    if (state.events.length > MAX_EVENTS) state.events.length = MAX_EVENTS
    for (const push of subscribers) {
      // push 是异步的（SSE 写入返回 promise）：try/catch 抓不到它内部的拒绝，
      // 而未处理的 rejection 在 Node 默认策略下会直接掀掉宿主进程。
      try {
        void Promise.resolve(push(event)).catch(() => { /* 单个订阅者坏了不影响其它人与状态 */ })
      } catch { /* 同步抛错也挡住 */ }
    }
    ctx.logger?.info(`[shell-kit:hmr] ${kind} ${JSON.stringify(data)}`)
  }

  // HMR 通过宿主上下文广播这两个事件（`@deepseek-ai/dsh-hmr` 里的 ctx.emit），
  // 因此不需要声明服务依赖；监听是纯增量，事件没来过也完全正常。
  try {
    const offChange = ctx.on?.('hmr/change', (url) => {
      state.lastChangeAt = new Date().toISOString()
      state.lastChangeUrl = typeof url === 'string' ? url : null
      record('change', { url: state.lastChangeUrl })
    })
    if (typeof offChange === 'function') listeners.push(offChange)
    const offReload = ctx.on?.('hmr/reload', (reloads) => {
      state.lastReloadAt = new Date().toISOString()
      state.reloadCount += 1
      const list = Array.isArray(reloads) ? reloads : []
      record('reload', {
        count: list.length,
        // 只记 URL 的文件名部分：这些值会进日志与面板，绝对路径没有必要。
        urls: list.slice(0, 10).map((item) => {
          const raw = typeof item === 'string' ? item : (item?.url ?? item?.filename ?? '')
          return String(raw).split(/[\\/]/).pop() || null
        }).filter((item) => item !== null),
      })
    })
    if (typeof offReload === 'function') listeners.push(offReload)
  } catch (error) {
    ctx.logger?.warn(`[shell-kit:hmr] 订阅 HMR 事件失败（状态查询仍然可用）：${error?.message ?? String(error)}`)
  }

  /** 状态路由与 SSE 首帧共用的快照。 */
  function snapshot() {
    const entry = readHmrEntry(ctx)
    return {
      available: entry.found,
      verdict: verdictOf(entry),
      entry: { id: entry.id, name: entry.name, state: entry.state, disabled: entry.disabled },
      sourceRoots: entry.root,
      watchesSources: Array.isArray(entry.root) && entry.root.length > 0,
      lastChangeAt: state.lastChangeAt,
      lastChangeUrl: state.lastChangeUrl,
      lastReloadAt: state.lastReloadAt,
      reloadCount: state.reloadCount,
      recentEvents: state.events.slice(0, 10),
    }
  }

  const routes = [
    {
      method: 'GET',
      path: `${ROUTE_PREFIX}/hmr/status`,
      handler: (_req, res) => ok(res, snapshot()),
    },
    {
      method: 'GET',
      path: `${ROUTE_PREFIX}/hmr/events`,
      handler: (req, res) => {
        const writer = createSseWriter(res)
        writer.open()
        const push = (event) => writer.write(sseFrame(event.kind, event))
        subscribers.add(push)
        const heartbeat = setInterval(() => { void writer.write(sseComment('ping')) }, SSE_HEARTBEAT_MS)
        heartbeat.unref?.()
        const stop = () => {
          clearInterval(heartbeat)
          streamStops.delete(stop)
          subscribers.delete(push)
          writer.dispose()
        }
        streamStops.add(stop)
        res.once('close', stop)
        // 首帧：先把当前状态给出去，客户端不必另发一次 /hmr/status。
        void writer.write(sseFrame('status', snapshot()))
      },
    },
  ]

  for (const route of routes) {
    try {
      disposers.push(localRoute(ctx, route))
    } catch (error) {
      ctx.logger?.warn(`[shell-kit:hmr] 路由 ${route.path} 注册失败：${error?.message ?? String(error)}`)
    }
  }

  const entry = readHmrEntry(ctx)
  ctx.logger?.info(`[shell-kit:hmr] HMR ${verdictOf(entry)}（state=${String(entry.state)} root=${JSON.stringify(entry.root)}）`)

  return {
    dispose() {
      for (const off of listeners) {
        try { off() } catch { /* 释放失败不影响进程退出 */ }
      }
      for (const stop of [...streamStops]) {
        try { stop() } catch { /* 同上 */ }
      }
      for (const push of [...subscribers]) subscribers.delete(push)
      for (const dispose of disposers) {
        try { dispose() } catch { /* 同上 */ }
      }
    },
    status() {
      return snapshot()
    },
  }
}
