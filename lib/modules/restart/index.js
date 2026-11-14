/**
 * dsh-shell-kit — 「一键重启」模块。
 *
 * 从 dsh-quick-restart 整体搬过来：设置页卡片、/restart 斜杠命令、restart_dsh 工具，
 * 以及两个 HTTP 路由。逻辑本身一字未改，只把接线换成 shell-kit 的模块形态：
 *   · 每个模块自己挂路由，前缀是 shell-kit 的 ROUTE_PREFIX + '/restart'
 *   · 模块只依赖 ../../core.js 与 ./engine.js，不碰别的模块
 *   · mount() 返回 { dispose, status }，由 lib/host.js 统一管理生命周期与状态聚合
 */
import {
  createRegistryTracker,
  hostFacts,
  httpError,
  localRoute,
  ok,
  pendingPluginRun,
  readBody,
  registerCommands,
  registerTools,
  ROUTE_PREFIX,
  rotateLog,
  archiveReport,
  trace,
} from '../../core.js'
import {
  COOLDOWN_MS,
  DEFAULT_DELAY_MS,
  DEFAULT_DELAY_MS_INTERACTIVE,
  HELPER_SCRIPT,
  invalidateRestartStatus,
  restartPaths,
  restartStatus,
  scheduleRestart,
} from './engine.js'
import { existsSync } from 'node:fs'

export const moduleName = 'restart'
export const label = { zh: '一键重启', en: 'Quick restart' }
/** 卡片里这一块的标题与说明（客户端按模块渲染时用）。 */
export const description = {
  zh: '插件或配置变更提示「需重启」时，一键重启：优先交给桌面端壳，没有通道时由本插件整应用重启。',
  en: 'Restart DeepSeek Harness in one click: handed to the desktop shell when it offers a channel, otherwise a whole-app restart by this plugin.',
}

function describeSchedule(result) {
  if (result?.alreadyScheduled) {
    const pending = Math.max(1, Math.round((result.pendingInMs ?? 0) / 1000))
    if (result.withinCooldown === true) {
      return `上一次重启刚发起，静默期内不再重复安排（约 ${pending} 秒后可以再排）。窗口会自动关闭并重新打开。`
    }
    return `重启已经在路上：约 ${pending} 秒后动手，不需要再点一次。窗口会自动关闭并重新打开。`
  }
  const seconds = Math.max(1, Math.round(result.delayMs / 1000))
  // 两种"能活过杀壳那一步"的启动方式都算正常：Windows 上走 WMI（脱离宿主作业对象），
  // 否则走 detached Node。其余（node-plain / none）才是真正会被一起带走的路径。
  const launch = result.launch === 'node-detached' || result.launch === 'wmi-detached'
    ? '，助手已确认在接管'
    : result.launch
      ? `，助手经 ${result.launch} 启动（这条路径可能在宿主被杀后一起消失）`
      : ''
  return `已安排约 ${seconds} 秒后重启 DeepSeek Harness${launch}，窗口会自动关闭并重新打开。`
}

/**
 * 这次请求算不算"重复排定"。纯函数，方便单测。
 *
 * 两段窗口：
 *   ① 上一次排的重启**延迟还没到点** → 还在路上，不要再排；
 *   ② 已经到点、但**距到点不到 COOLDOWN_MS** → 静默期（界面与 CLI 文案承诺过这条），
 *      除非显式 force，否则也不再排第二次，避免连点把重启排成两轮。
 * @param {{ lastScheduledAt: number, lastDelayMs: number }} state
 * @param {number} now
 * @returns {{ pendingInMs: number, withinCooldown: boolean }|null}
 */
export function describeDuplicate(state, now) {
  if (!Number.isFinite(state?.lastScheduledAt) || state.lastScheduledAt <= 0) return null
  const firesAt = state.lastScheduledAt + (Number.isFinite(state.lastDelayMs) ? state.lastDelayMs : DEFAULT_DELAY_MS)
  if (now < firesAt) return { pendingInMs: firesAt - now, withinCooldown: false }
  const quietUntil = firesAt + COOLDOWN_MS
  if (now < quietUntil) return { pendingInMs: quietUntil - now, withinCooldown: true }
  return null
}

/**
 * 挂载「一键重启」模块。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主 context
 * @returns {{ dispose: () => void, status: () => object }}
 */
export function mount(ctx) {
  trace('restart.mount 开始：webServer=' + String(typeof ctx?.webServer))
  const state = { lastScheduledAt: 0, lastDelayMs: 0, lastScheduledBy: null, lastResult: null }
  const tracker = createRegistryTracker()
  const registrations = tracker.state
  const paths = restartPaths()

  // 模块自己的运维动作：日志轮转、上一份报告留档。
  const rotatedLog = rotateLog(paths)
  const archivedReport = archiveReport(paths)
  if (rotatedLog !== null) ctx.logger?.info(`[shell-kit:restart] 日志已轮转：${rotatedLog}`)
  if (archivedReport !== null) ctx.logger?.info(`[shell-kit:restart] 上一份重启报告已留档：${archivedReport}`)

  // 上一轮重启的结果，开机就写进日志，方便「重启到底成没成」有据可查。
  const previousReport = restartStatus(ctx)?.lastReport
  if (previousReport?.outcome) {
    ctx.logger?.info(`[shell-kit:restart] 上次重启 outcome=${previousReport.outcome} 耗时 ${String(previousReport.elapsedMs ?? '?')}ms`)
  }

  const facts = () => {
    const current = hostFacts(ctx)
    // 助手脚本是重启模块自己的依赖，只有这个模块关心它在不在。
    if (!existsSync(HELPER_SCRIPT)) {
      current.supported = false
      current.reasons = [...(current.reasons ?? []), `重启助手脚本缺失：${HELPER_SCRIPT}`]
    }
    return current
  }

  /** 准入检查：宿主能力与插件的并发操作。 */
  function admit(force) {
    const current = facts()
    if (!current.supported) throw httpError(501, 'UNSUPPORTED', `当前宿主不支持一键重启：${current.reasons.join('；')}`)
    const pending = pendingPluginRun()
    if (pending.busy && force !== true) {
      throw httpError(409, 'PLUGIN_OPERATION', `插件操作进行中，重启可能写坏 profile：${pending.hits.map((hit) => hit.detail).join('；')}（确认无碍时加 force）`)
    }
    return current
  }

  /** 上一次排的重启还有多久动手（0 表示没有在路上的重启）。 */
  function pendingRestartInMs() {
    if (state.lastScheduledAt === 0) return 0
    const firesAt = state.lastScheduledAt + (state.lastDelayMs ?? DEFAULT_DELAY_MS)
    return Math.max(0, firesAt - Date.now())
  }

  /** 正在排定的那一次 launch（并发闸，见下方 launch 内部注释）。 */
  let inFlight = null

  async function launch(options) {
    const current = admit(options.force)
    // 去重与静默期：两条都只挡"没有 force 的重复请求"，force 一律穿透。
    const duplicate = describeDuplicate(state, Date.now())
    if (duplicate !== null && options.force !== true) {
      return {
        scheduled: true,
        alreadyScheduled: true,
        pendingInMs: duplicate.pendingInMs,
        by: state.lastScheduledBy,
        launch: state.lastResult?.launch ?? null,
        ...(duplicate.withinCooldown ? { withinCooldown: true } : {}),
      }
    }

    // 并发闸：占位必须发生在第一个 await 之前。两个同时到达的请求（/restart 命令 +
    // restart_dsh 工具、或两次连点）在 awaits 期间都还看得见旧的 state，于是都能穿过上面
    // 的去重闸，各拉一个助手 —— 两个助手各自 kill 宿主并 armWatchdog，重启会打成两轮。
    // 占位就是一个 in-flight promise：后来者等它，共享同一个「已排定」的答案。
    if (inFlight !== null) {
      const joined = await inFlight.catch(() => null)
      if (joined !== null) {
        const pendingInMs = pendingRestartInMs()
        return { ...joined, scheduled: true, alreadyScheduled: true, ...(pendingInMs > 0 ? { pendingInMs } : {}) }
      }
      // 上一次没排成：这次自己重新尝试一遍，不把上一次的失败吞掉。
    }

    const run = (async () => {
      const result = await scheduleRestart({
        facts: current,
        delayMs: options.delayMs,
        graceful: options.graceful,
        by: options.by,
      })
      // 倒计时基准取「助手确认起来之后」算出的计划开火时刻，而不是发起请求的时刻：
      // 后者要早一个 launchHelper 的耗时（最长约 9 秒），status 里的 pendingInMs 会偏大。
      state.lastScheduledAt = Number.isFinite(result.scheduledAt)
        ? result.scheduledAt - result.delayMs
        : Date.now()
      state.lastDelayMs = result.delayMs
      state.lastScheduledBy = options.by
      state.lastResult = result
      invalidateRestartStatus()
      ctx.logger?.info(`[shell-kit:restart] ${describeSchedule(result)} by=${options.by}`)
      return result
    })()
    inFlight = run
    try {
      return await run
    } finally {
      if (inFlight === run) inFlight = null
    }
  }

  // ---------------------------------------------------------------- #
  // HTTP 路由                                                         #
  // ---------------------------------------------------------------- #
  const disposers = []
  try {
    disposers.push(localRoute(ctx, {
      method: 'GET',
      path: `${ROUTE_PREFIX}/restart/status`,
      handler: async (req, res) => {
        const payload = restartStatus(ctx)
        payload.registrations = { ...registrations }
        payload.restartPendingInMs = pendingRestartInMs()
        payload.lastScheduledBy = state.lastScheduledBy
        payload.lastSchedule = state.lastResult
        ok(res, payload)
      },
    }))

    disposers.push(localRoute(ctx, {
      method: 'POST',
      path: `${ROUTE_PREFIX}/restart`,
      handler: async (req, res) => {
        const body = await readBody(req)
        const result = await launch({
          force: body.force === true,
          graceful: body.graceful === true,
          delayMs: body.delayMs === undefined ? DEFAULT_DELAY_MS : body.delayMs,
          by: typeof body.by === 'string' && body.by !== '' ? body.by : 'http',
        })
        ok(res, { ...result, message: describeSchedule(result) })
      },
    }))
  } catch (error) {
    ctx.logger?.warn(`[shell-kit:restart] 路由注册失败：${error?.message ?? String(error)}`)
    trace(`restart 路由注册失败：${error?.stack ?? error?.message ?? String(error)}`)
  }
  trace('restart 路由数=' + String(disposers.length))
  registrations.routes = disposers.length

  // ---------------------------------------------------------------- #
  // /restart 斜杠命令                                                 #
  // ---------------------------------------------------------------- #
  registerCommands(ctx, {
    label: 'restart',
    tracker,
    register: (commandCtx) => commandCtx.commands.register({
      name: 'restart',
      description: '重启 DeepSeek Harness，让插件/配置变更生效（加 force 可跳过插件操作检查）',
      input: { hint: '[force]' },
      handler: async ({ rawInput }) => {
        const force = String(rawInput ?? '').trim().toLowerCase().startsWith('force')
        try {
          const result = await launch({ force, delayMs: DEFAULT_DELAY_MS_INTERACTIVE, graceful: false, by: '/restart' })
          return { kind: 'success', text: `${describeSchedule(result)}本轮对话已保存，重启后可以继续。` }
        } catch (error) {
          return { kind: 'error', text: `重启未安排：${error?.message ?? String(error)}` }
        }
      },
    }),
  })

  // ---------------------------------------------------------------- #
  // restart_dsh 智能体工具（原始定义对象，不依赖任何 import）          #
  // ---------------------------------------------------------------- #
  registerTools(ctx, {
    label: 'restart',
    tracker,
    definition: {
      name: 'restart_dsh',
      description: [
        '重启 DeepSeek Harness 桌面端进程，让需要重启才能生效的插件/配置变更立即生效。',
        '重启会在几秒后发生：本工具会先返回结果，然后窗口自动关闭并重新打开，当前这一轮对话因此会被中断（会话本身已保存，重启后可以继续）。',
        '只有在确实需要重启时才调用（例如刚装好插件、改完 profile 配置）；调用前不要在同一轮里再安排其他需要进程存活的工作。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: '为什么需要重启（一句话，便于日志追溯）' },
          delay_seconds: { type: 'number', description: '延迟秒数，默认 2.5；给刚写完的日志/文件留出落地时间' },
          force: { type: 'boolean', description: '即使检测到插件操作进行中也强制重启' },
          graceful: { type: 'boolean', description: '是否先尝试优雅退出（默认 false，即直接强杀）' },
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const options = typeof args === 'object' && args !== null ? args : {}
        const seconds = Number.isFinite(options.delay_seconds) ? Number(options.delay_seconds) : DEFAULT_DELAY_MS_INTERACTIVE / 1000
        const result = await launch({
          force: options.force === true,
          graceful: options.graceful === true,
          delayMs: seconds * 1000,
          by: `agent:${typeof options.reason === 'string' && options.reason !== '' ? options.reason : 'restart_dsh'}`,
        })
        return `${describeSchedule(result)}本轮对话将被中断，但会话已保存，重启完成后可继续。`
      },
    },
  })

  return {
    dispose() {
      for (const dispose of disposers) {
        try { dispose() } catch { /* 释放失败不影响进程退出 */ }
      }
      invalidateRestartStatus()
    },
    status() {
      const payload = restartStatus(ctx)
      payload.registrations = { ...registrations }
      payload.restartPendingInMs = pendingRestartInMs()
      payload.lastScheduledBy = state.lastScheduledBy
      payload.lastSchedule = state.lastResult
      return payload
    },
  }
}
