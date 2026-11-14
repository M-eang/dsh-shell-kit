/**
 * dsh-shell-kit — 插件本体（宿主半边）。
 *
 * 形态：**一个安装包 + 多个功能模块**。模块放在 lib/modules/<name>/，
 * 每个模块自己挂路由、命令与工具，只共享 lib/core.js（以及 doctor/profile 共用的
 * 只读审计 lib/profile-audit.js）；本文件负责
 *   ① 按配置决定挂哪些模块（config.modules.<name> === false 就跳过）；
 *   ② 逐个 try/catch 挂载 —— 某个模块坏了只记日志，不影响其它模块；
 *   ③ 提供一个聚合状态路由（/api/shell-kit/status），把各模块状态摊平；
 *   ④ 生命周期收尾（释放各模块与自己的定时器）。
 *
 * 为什么是一个包而不是多个包：重启是诊断/体检这些模块的**公共动作**（都要"改完重启"），
 * 拆包会让它们各自复制一份重启逻辑；而粒度可控这件事用「模块开关 + 逐模块 try/catch」
 * 来换回，不需要多占 profile 的一行安装位。
 */
import {
  PLUGIN_ID,
  PLUGIN_VERSION,
  ROUTE_PREFIX,
  diagnostics,
  localRoute,
  ok,
  profileConfigChanges,
  trace,
} from './core.js'

export const name = 'dsh-shell-kit'
export const inject = ['webServer']

/**
 * 模块名 → 懒加载入口。**必须是动态 import**：静态 import 会让任何一个模块的
 * 语法/依赖错误连坐整个 kit；动态导入 + try/catch 才能做到"只坏一个功能"。
 * 每加一个新模块，这里加一行即可（doctor / profile / presets ...）。
 */
const MODULE_LOADERS = {
  // logs 排第一：它越早挂上，越能记到别的模块挂载时打的日志。
  logs: () => import('./modules/logs/index.js'),
  restart: () => import('./modules/restart/index.js'),
  hmr: () => import('./modules/hmr/index.js'),
  doctor: () => import('./modules/doctor/index.js'),
  profile: () => import('./modules/profile/index.js'),
  presets: () => import('./modules/presets/index.js'),
}

/**
 * 读一个布尔开关：只认 true / false。
 *
 * 写错类型（`off`、`0`、`"false"`）时按默认值处理并记一条 warn —— 静默当成真值最坑：
 * 用户以为关掉了，实际还在跑，出问题时完全找不到线索。
 * @param {unknown} value 配置里读到的原始值
 * @param {boolean} fallback 缺省值（也给类型写错的情况兜底）
 * @param {string} label 写进告警的配置名，例如 `modules.logs`
 * @param {(message: string) => void} [onWarn]
 * @returns {boolean}
 */
export function readFlag(value, fallback, label, onWarn) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  onWarn?.(`[shell-kit] 配置 ${label} 期望布尔值，收到 ${JSON.stringify(value)}（按默认 ${String(fallback)} 处理）`)
  return fallback
}

export async function apply(ctx, config = {}) {
  trace(`host.apply 开始：webServer=${String(typeof ctx?.webServer)} ROUTE_PREFIX=${ROUTE_PREFIX}`)
  const warn = (message) => ctx.logger?.warn(message)
  const moduleConfig = typeof config?.modules === 'object' && config.modules !== null ? config.modules : {}
  if (config?.modules !== undefined && config.modules !== null && typeof config.modules !== 'object') {
    warn(`[shell-kit] 配置 modules 期望对象，收到 ${JSON.stringify(config.modules)}（已忽略，所有模块按默认开启）`)
  }
  // 模块自己的配置项放在顶层（`config.<name>`），`config.modules.<name>` 只表示开关。
  // 这样"关掉一个模块"和"给某个模块单项配置"是两件互不干扰的事。
  const moduleOptions = { captureStdio: readFlag(config?.captureStdio, true, 'captureStdio', warn) }
  const mounted = new Map()
  const modules = {}
  const state = { profileChanges: null }

  // ---------------------------------------------------------------- #
  // ① 逐模块挂载                                                       #
  // ---------------------------------------------------------------- #
  for (const [moduleId, load] of Object.entries(MODULE_LOADERS)) {
    const enabled = readFlag(moduleConfig[moduleId], true, `modules.${moduleId}`, warn)
    modules[moduleId] = { id: moduleId, enabled, mounted: false, error: null, label: null }
    if (!enabled) {
      ctx.logger?.info(`[shell-kit] 模块 ${moduleId} 被配置关闭（config.modules.${moduleId} = false）`)
      continue
    }
    try {
      const mod = await load()
      // 必须 await：模块的 mount 允许是异步的，否则拿到的会是一个 Promise，
      // dispose/status 都取不到（表现为"挂上了但永远没有状态"，且不报错）。
      const handle = await mod.mount(ctx, { config: moduleOptions, logger: ctx.logger })
      if (handle !== undefined && handle !== null && typeof handle?.dispose !== 'function' && typeof handle?.status !== 'function') {
        throw new Error('mount() 的返回值既没有 dispose() 也没有 status()，无法管理其生命周期')
      }
      mounted.set(moduleId, handle ?? {})
      modules[moduleId].mounted = true
      modules[moduleId].label = mod.label ?? null
      modules[moduleId].description = mod.description ?? null
      ctx.logger?.info(`[shell-kit] 模块 ${moduleId} 已挂载`)
      trace(`模块 ${moduleId} 已挂载`)
    } catch (error) {
      modules[moduleId].error = error?.message ?? String(error)
      ctx.logger?.warn(`[shell-kit] 模块 ${moduleId} 挂载失败（其余模块继续）：${modules[moduleId].error}`)
      trace(`模块 ${moduleId} 挂载失败：${modules[moduleId].error}`)
    }
  }

  // ---------------------------------------------------------------- #
  // ② 聚合状态路由                                                     #
  // ---------------------------------------------------------------- #
  const kitDisposers = []
  const aggregatePath = `${ROUTE_PREFIX}/status`
  try {
    kitDisposers.push(localRoute(ctx, {
      method: 'GET',
      path: aggregatePath,
      handler: async (req, res) => {
        const payload = {
          plugin: PLUGIN_ID,
          version: PLUGIN_VERSION,
          modules: {},
          profileChanges: state.profileChanges,
          diagnostics: { ...diagnostics },
        }
        for (const [moduleId, meta] of Object.entries(modules)) {
          let status = null
          try {
            status = mounted.get(moduleId)?.status?.() ?? null
          } catch (error) {
            status = { error: error?.message ?? String(error) }
          }
          payload.modules[moduleId] = { ...meta, status }
        }
        ok(res, payload)
      },
    }))
  } catch (error) {
    ctx.logger?.warn(`[shell-kit] 聚合状态路由注册失败：${error?.message ?? String(error)}`)
    trace(`聚合状态路由注册失败：${error?.stack ?? error?.message ?? String(error)}`)
  }
  {
    const table = ctx.webServer?.exact
    const has = table instanceof Map ? table.has(aggregatePath) : 'n/a'
    trace(`聚合路由注册结果：exact 表大小=${table instanceof Map ? table.size : 'n/a'}；含 ${aggregatePath}=${has}；listenedPort=${String(ctx.webServer?.listenedPort)}`)
  }
  trace(`聚合状态路由注册完成：共 ${String(kitDisposers.length)} 条`)

  // ---------------------------------------------------------------- #
  // ③ 只做提示：本进程启动后 profile 配置有没有被动过                   #
  // ---------------------------------------------------------------- #
  // 装了/改了/删了插件，多半会动 profile 的 package.json / patch / lock。
  // 变了既可能是已经热挂载、也可能需要重启，卡片上如实这么写；
  // 重启的时机始终由用户（或桌面端壳的按钮）决定，这里不自动重启。
  void profileConfigChanges() // 先记一次基线
  const refreshProfileChanges = () => {
    const result = profileConfigChanges()
    if (result.changed.length > 0) {
      const merged = new Set([...(state.profileChanges?.changed ?? []), ...result.changed])
      state.profileChanges = { profileDir: result.profileDir, changed: [...merged], at: new Date().toISOString() }
      ctx.logger?.info(`[shell-kit] profile 配置在本进程启动后被改动：${result.changed.join(', ')}`)
    }
  }
  const profileTimer = setInterval(refreshProfileChanges, Math.max(3000, Number(config.pendingPollMs) || 10000))
  profileTimer.unref?.()

  // ---------------------------------------------------------------- #
  // ④ 生命周期收尾                                                     #
  // ---------------------------------------------------------------- #
  ctx.effect(() => () => {
    clearInterval(profileTimer)
    for (const dispose of kitDisposers) {
      try { dispose() } catch { /* 释放失败不影响进程退出 */ }
    }
    for (const [moduleId, handle] of mounted) {
      try { handle.dispose?.() } catch (error) {
        ctx.logger?.warn(`[shell-kit] 模块 ${moduleId} 释放失败：${error?.message ?? String(error)}`)
      }
    }
  })

  const mountedNames = [...mounted.keys()]
  ctx.logger?.info(`[shell-kit] v${PLUGIN_VERSION} 已挂载（模块：${mountedNames.length > 0 ? mountedNames.join(', ') : '无'}；status: ${ROUTE_PREFIX}/status）`)
}

/** 供 index.js 的装载外壳通过 ctx.plugin() 挂载的插件对象。 */
export default { name, inject, apply }
