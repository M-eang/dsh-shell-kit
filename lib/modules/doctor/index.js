/**
 * dsh-shell-kit — 「插件诊断」模块。
 *
 * 回答一个问题：**这套插件组合现在健康吗？如果不健康，是谁、在哪一步、证据是什么。**
 *
 * 三个数据源，互相补位：
 *   ① 活体 loader —— ctx.loader.entries() 里每个条目的 fiber 阶段（active/failed/...）
 *      与失败原因。这是"此刻正跑着的组合"的真话。
 *   ② profile 静态面 —— cordis.patch.yml 的行、package.json 的 dependencies 与
 *      dsh.profile.bundles。能提前发现"引用了没装的包""link 指向不存在的目录"
 *      "name 里混进了注释"这类**下一次启动才会炸**的问题（本插件自己就踩过 name 被
 *      粘上注释那一脚）。
 *   ③ 宿主崩溃报告 —— %APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-host.log
 *      里带着 host 的 stderr 与错误块；插件加载失败的结构化行
 *      （`[harness-node] plugin failures: {...}`）也从这里捞。
 *
 * 只读、只报告，不替你改配置：改配置的事情交回用户或 agent 决定。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { collectProfileFindings, isHostPackage, readText } from '../../profile-audit.js'
export { parsePatchRows } from '../../profile-audit.js'
import { join } from 'node:path'
import {
  createRegistryTracker,
  httpError,
  localRoute,
  ok,
  readBody,
  registerCommands,
  registerTools,
  resolveProfileDir,
  ROUTE_PREFIX,
  tailBytes,
  trace,
} from '../../core.js'

export const moduleName = 'doctor'
export const label = { zh: '插件诊断', en: 'Plugin diagnosis' }
export const description = {
  zh: '体检当前插件组合：活体 loader 阶段、profile 静态面、宿主崩溃报告，给出一份带证据的结论。',
  en: 'Check the plugin composition: live loader phases, the static profile surface, and desktop crash reports — with evidence.',
}

/** cordis 的根 fiber 阶段（官方客户端也是这套映射）。 */
const FIBER_STATES = { 0: 'pending', 1: 'loading', 2: 'active', 3: 'failed', 4: 'unloading' }

/** 每类发现在单个文件里最多收这么多条（报告体积与渲染成本都要有上限）。 */
const MAX_FINDINGS_PER_CODE = 20
/** 崩溃报告只扫末尾这么多字节（避免把一个被追加到几百 MB 的文件整个读进内存）。 */
const MAX_LOG_SCAN_BYTES = 4 * 1024 * 1024
/** 报告缓存时长：`status()` 是"看一眼状态"，不该每次都重新体检一遍。 */
const REPORT_TTL_MS = 10000



/** 活体 loader：每个条目的 fiber 阶段，失败条目连原因一起给。 */
function collectLoaderFindings(ctx) {
  let entries = []
  try {
    const loader = ctx.get('loader')
    entries = typeof loader?.entries === 'function' ? loader.entries() : []
  } catch (error) {
    return { entries: 0, failed: [], byState: {}, error: error?.message ?? String(error) }
  }
  const failed = []
  const noFiber = []
  const entryList = []
  const byState = {}
  // loader.entries() 返回的是 Set（没有 .length），统一成数组再数。
  const list = Array.from(entries ?? [])
  for (const entry of list) {
    const state = entry?.fiber?.state
    // fiber 为 null 的条目是"没有存活根 fiber"：从未启动、已被释放、或被上层 group 禁用。
    const key = state === undefined || state === null ? 'no-fiber' : (FIBER_STATES[state] ?? `state-${String(state)}`)
    byState[key] = (byState[key] ?? 0) + 1
    const id = entry?.options?.id ?? entry?.id ?? null
    const name = entry?.options?.name ?? entry?.name ?? null
    const disabled = entry?.options?.disabled === true || entry?.options?.disabled === false ? entry?.options?.disabled : null
    // 条目一览：用来回答"我这条配置到底热挂上了没"（id 精确匹配比翻日志快）。
    if (typeof id === 'string') entryList.push({ id, name, state: key, disabled })
    if (state === undefined || state === null) {
      // 盲区：**包解析失败时条目往往连 fiber 都没有**（不是 state=3），只靠状态抓不到。
      // 这里的候选是"有包名、没被显式禁用、却没有存活 fiber"的条目 —— 交给下面的
      // 静态检查（包是否存在）来判定它到底有没有问题。
      if (typeof name === 'string' && name !== '' && disabled !== true) noFiber.push({ id, name })
      continue
    }
    if (state !== 3) continue
    const fiber = entry?.fiber
    // fiber 上的错误字段随 cordis 版本不同，这里把几个可能的位置都试一遍。
    const raw = fiber?.error ?? fiber?._error ?? entry?._initTask?.error ?? entry?.error ?? null
    const message = typeof raw === 'string' ? raw : raw?.message ?? null
    failed.push({
      id: entry?.options?.id ?? entry?.id ?? null,
      name: entry?.options?.name ?? entry?.name ?? null,
      state: key,
      error: message === null ? null : message.slice(0, 600),
    })
  }
  return { entries: list.length, failed, noFiber, byState, entryList }
}

/** 宿主崩溃报告：里面有 host 的 stderr 与错误块。 */
function collectLogFindings() {
  const appData = process.env.APPDATA ?? ''
  // 两个来源分开对待：官方壳的日志才算"本应用"的证据；第三方壳（dsh-desktop）
  // 的 harness.log 是另一套安装留下的历史，只作提示，不能算当前错误。
  const sources = [
    { dir: join(appData, '@deepseek-ai', 'dsh-desktop', 'logs'), official: true, name: '官方宿主' },
    { dir: join(appData, 'dsh-desktop', 'logs'), official: false, name: '第三方宿主(dsh-desktop)' },
  ].filter((source) => appData !== '' && existsSync(source.dir))
  const findings = []
  const scanned = []
  // 本进程的启动时刻：比它更早的失败都是「上一次启动/别的壳」的事。
  const bootedAt = Date.now() - process.uptime() * 1000
  for (const source of sources) {
    let files = []
    try {
      files = readdirSync(source.dir)
        .map((name) => ({ name, at: statSync(join(source.dir, name)).mtimeMs }))
        .sort((a, b) => b.at - a.at)
        .slice(0, 6)
    } catch { continue }
    for (const file of files) {
      const full = join(source.dir, file.name)
      // 只读末尾一段：崩溃报告可能被追加得很大，而我们要找的失败永远是最近那次。
      let text = tailBytes(full, { maxBytes: MAX_LOG_SCAN_BYTES })
      if (text === null) text = readText(full)
      if (text === null || text.trim() === '') continue
      scanned.push(full)
      // 每类发现在单个文件里最多收 MAX_FINDINGS_PER_CODE 条；超出的只计数，
      // 否则一份反复失败的日志能把报告撑到几千条，客户端与渲染都跟着变慢。
      const perCode = new Map()
      const pushFinding = (finding, code) => {
        const count = perCode.get(code) ?? 0
        perCode.set(code, count + 1)
        if (count >= MAX_FINDINGS_PER_CODE) {
          if (count === MAX_FINDINGS_PER_CODE) {
            findings.push({
              level: 'info', code: `${code}-truncated`,
              title: `${prefix}同一类发现过多，只保留前 ${MAX_FINDINGS_PER_CODE} 条：${code}`,
              detail: `这个文件里还有更多同类记录，已省略；完整内容见 ${full}`,
              evidence: full,
            })
          }
          return
        }
        findings.push(finding)
      }
      const stale = !source.official || file.at < bootedAt - 60_000
      const stamp = new Date(file.at).toISOString().replace('T', ' ').slice(0, 19)
      const prefix = source.official
        ? (stale ? `历史（${stamp}）：` : '')
        : `来自${source.name}（${stamp}）：`
      const level = source.official && !stale ? 'error' : 'info'
      // 结构化行（Harness loader 打的那一行）优先
      for (const match of text.matchAll(/\[harness-node\] plugin failures: (\{.*\})/gu)) {
        try {
          const report = JSON.parse(match[1])
          for (const failure of report?.failures ?? []) {
            pushFinding({
              level, code: 'plugin-startup-failure',
              title: `${prefix}启动失败：${failure?.packageName ?? '未知插件'}（阶段 ${failure?.stage ?? '?'}）`,
              detail: String(failure?.message ?? '').slice(0, 600),
              evidence: full,
            }, 'plugin-startup-failure')
          }
        } catch { /* 协议不认识的当普通日志 */ }
      }
      const patterns = [
        { re: /Cannot find package '([^']+)'/gu, level, code: 'module-not-found', title: (m) => `${prefix}找不到包：${m[1]}` },
        { re: /duplicate loader entry id:\s*["']?([^\s"']+)/gu, level, code: 'duplicate-entry-id', title: (m) => `${prefix}重复的 loader 条目 id：${m[1]}` },
        { re: /single slot\s+["']([^"']+)["']\s+already has a registration/gu, level, code: 'slot-conflict', title: (m) => `${prefix}slot 冲突：${m[1]}` },
        { re: /Failed to load plugins/gu, level: level === 'error' ? 'warn' : level, code: 'failed-to-load-plugins', title: () => `${prefix}宿主报告「Failed to load plugins」` },
      ]
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern.re)) {
          pushFinding({
            level: pattern.level, code: pattern.code, title: pattern.title(match),
            detail: (match[0] ?? '').slice(0, 300), evidence: full,
          }, pattern.code)
        }
      }
    }
  }
  const seen = new Set()
  const deduped = findings.filter((finding) => {
    const key = `${finding.code}|${finding.title}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { findings: deduped, scanned }
}

/** 体检报告：三个数据源 + 分级结论。 */
export function buildReport(ctx) {
  const profileDir = resolveProfileDir()
  const profileFindings = profileDir === null ? [{
    level: 'error', code: 'profile-not-found',
    title: '定位不到 profile 目录', detail: 'DSH_PROFILE / argv / ~/.dsh/profiles/desktop 都没命中',
  }] : collectProfileFindings(profileDir).findings

  const loader = collectLoaderFindings(ctx)
  const entryList = Array.isArray(loader.entryList) ? loader.entryList.slice(0, 500) : []
  const loaderFindings = loader.failed.map((row) => ({
    level: 'error', code: 'fiber-failed',
    title: `条目 fiber 起不来：${row.id ?? '?'}（${row.name ?? '?'}）`,
    detail: row.error ?? '（没能从 fiber 上取到错误详情）',
    evidence: 'live loader',
  }))
  // 没有存活 fiber 的条目：只有"包根本不存在"才算错误，其余留给 JSON 里的明细，
  // 免得一堆"未启用/被 group 禁用"的正常条目把报告刷满。
  for (const row of loader.noFiber) {
    const isHost = typeof row.name === 'string' && isHostPackage(row.name)
    const installed = isHost || (profileDir !== null && existsSync(join(profileDir, 'node_modules', row.name)))
    if (installed) continue
    loaderFindings.push({
      level: 'error', code: 'no-fiber-missing-package',
      title: `条目没有存活 fiber，且包不存在：${row.id ?? '?'}（${row.name ?? '?'}）`,
      detail: 'loader 里挂着这条 entry，但它没有存活的根 fiber，profile 里也找不到这个包 —— 典型是包名写错/没装成',
      evidence: 'live loader',
    })
  }

  const logs = collectLogFindings()
  const findings = [...profileFindings, ...loaderFindings, ...logs.findings]
  const count = (level) => findings.filter((finding) => finding.level === level).length

  return {
    at: new Date().toISOString(),
    profileDir,
    loader: {
      entries: loader.entries,
      byState: loader.byState,
      failed: loader.failed,
      noFiber: loader.noFiber ?? [],
      entryList: entryList,
      error: loader.error ?? null,
    },
    scannedLogs: logs.scanned,
    findings,
    summary: {
      errors: count('error'),
      warnings: count('warn'),
      notes: count('info'),
      healthy: count('error') === 0 && loader.failed.length === 0,
    },
  }
}

/** 把报告渲染成给人/给 agent 看的中文文本。 */
export function renderReport(report, { maxFindings = 12 } = {}) {
  const lines = []
  lines.push(`插件诊断：${report.summary.healthy ? '没有发现错误' : `发现 ${report.summary.errors} 个错误`}（警告 ${report.summary.warnings}，提示 ${report.summary.notes}）`)
  lines.push(`profile：${report.profileDir ?? '未定位到'}`)
  lines.push(`活体 loader：${report.loader.entries} 个条目（${Object.entries(report.loader.byState).map(([key, value]) => `${key}=${value}`).join('、') || '无状态数据'}）`)
  lines.push('')
  if (report.findings.length === 0) {
    lines.push('没有任何发现：配置、依赖与运行中的条目都一致。')
    return lines.join('\n')
  }
  const order = { error: 0, warn: 1, info: 2 }
  const sorted = [...report.findings].sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3))
  for (const finding of sorted.slice(0, maxFindings)) {
    const tag = finding.level === 'error' ? '错误' : finding.level === 'warn' ? '警告' : '提示'
    lines.push(`[${tag}] ${finding.title}`)
    if (finding.detail) lines.push(`      ${String(finding.detail).replace(/\n/gu, ' ').slice(0, 300)}`)
    if (finding.evidence) lines.push(`      证据：${finding.evidence}`)
  }
  if (sorted.length > maxFindings) lines.push(`…还有 ${sorted.length - maxFindings} 条（用 HTTP 路由或工具取完整报告）`)
  return lines.join('\n')
}

/**
 * 报告缓存。
 *
 * `status()` 会在聚合状态路由（`GET /api/shell-kit/status`）里被调用，而客户端在重启窗口
 * 里大约每秒取一次 —— 如果每次都真的重新体检（遍历 loader 条目、正则扫崩溃报告、
 * 重读 patch/package.json），"看一眼状态"就变成持续的全量 I/O。
 * 这里按 TTL 复用同一份报告；`force` 与重建后失效两条路径保证报告不会长期陈旧。
 */
const reportCache = { at: 0, value: null }

/** 让下一次 `cachedReport()` 重新体检（配置/依赖刚被改动后调用）。 */
export function invalidateReportCache() {
  reportCache.at = 0
  reportCache.value = null
}

/**
 * 带 TTL 的体检报告。对外暴露的读路径（路由 / 命令 / 工具 / status）都走这里。
 * @param {object} ctx
 * @param {{ force?: boolean }} [options]
 */
export function cachedReport(ctx, options = {}) {
  const now = Date.now()
  if (options.force !== true && reportCache.value !== null && now - reportCache.at < REPORT_TTL_MS) {
    return reportCache.value
  }
  const built = buildReport(ctx)
  reportCache.at = now
  reportCache.value = built
  return built
}

/**
 * 挂载「插件诊断」模块。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function mount(ctx) {
  const tracker = createRegistryTracker()
  const registrations = tracker.state
  const disposers = []

  const report = () => {
    const built = cachedReport(ctx)
    trace(`doctor 报告：errors=${built.summary.errors} warnings=${built.summary.warnings} loaderFailed=${built.loader.failed.length}`)
    return built
  }

  try {
    disposers.push(localRoute(ctx, {
      method: 'GET',
      path: `${ROUTE_PREFIX}/doctor/report`,
      handler: async (req, res) => {
        const built = report()
        ok(res, { ...built, text: renderReport(built) })
      },
    }))
  } catch (error) {
    ctx.logger?.warn(`[shell-kit:doctor] 路由注册失败：${error?.message ?? String(error)}`)
    trace(`doctor 路由注册失败：${error?.stack ?? error?.message ?? String(error)}`)
  }
  registrations.routes = disposers.length

  registerCommands(ctx, {
    label: 'doctor',
    tracker,
    register: (commandCtx) => commandCtx.commands.register({
      name: 'diag',
      description: '体检当前插件组合：loader 阶段、profile 配置、宿主崩溃报告（只读，不改配置）',
      handler: () => {
        try {
          return { kind: 'success', text: renderReport(report()) }
        } catch (error) {
          return { kind: 'error', text: `诊断失败：${error?.message ?? String(error)}` }
        }
      },
    }),
  })

  registerTools(ctx, {
    label: 'doctor',
    tracker,
    definition: {
      name: 'diagnose_plugins',
      description: [
        '体检当前 DeepSeek Harness 的插件组合：报告活体 loader 里起不来的条目、profile 配置与依赖里的问题、',
        '以及宿主崩溃报告里记录的插件加载失败，并给出证据（文件:行号）。',
        '只读诊断，不修改任何配置；装完/改完插件后怀疑组合有问题、或启动曾经失败时调用它。',
      ].join(' '),
      parameters: { type: 'object', properties: { full: { type: 'boolean', description: '是否输出全部发现（默认截断到 12 条）' } } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args) {
        const options = typeof args === 'object' && args !== null ? args : {}
        // 工具调用要的是"现在"的结论，所以绕过 TTL 缓存。
        const built = cachedReport(ctx, { force: true })
        return renderReport(built, { maxFindings: options.full === true ? 200 : 12 })
      },
    },
  })

  trace('doctor.mount 完成')
  return {
    dispose() {
      for (const dispose of disposers) {
        try { dispose() } catch { /* 释放失败不影响进程退出 */ }
      }
      invalidateReportCache()
    },
    status() {
      const built = report()
      return { ...built.summary, loaderFailed: built.loader.failed.length, registrations: { ...registrations } }
    },
  }
}
