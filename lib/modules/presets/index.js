/**
 * dsh-shell-kit — 「agent 预设」模块。
 *
 * 先说什么**不**做：官方 `@deepseek-ai/dsh-agent-preset` 自带的 skill
 * （`editing-cordis-compositions`）写得很明确 —— 预设现在是 **bundle 里的声明行**
 * （`- id: preset-<id>` + `name: '@deepseek-ai/dsh-agent-preset'` + `config.plugins`），
 * 而 `.agent-presets/<id>/`（`preset.yml` + `agent.cordis.yml`）这套旧格式
 * **已经没有任何代码读它了**；安装必须走官方 `plugin_manager`（`install_bundle`），
 * 并且明令"不要用 shell 命令复刻安装步骤"。所以本模块不装、不卸、不替市场干活。
 *
 * 那它做什么 —— 做官方只给了文档、没给工具的那段路：
 *   ① **旧格式巡检**：扫 $DSH_HOME 下的 `.agent-presets*` 这类遗留目录，逐个判定
 *      「官方已内置（可直接删）」/「第三方安装遗留，路径已失效」/「用户自建（需迁移）」，
 *      并给出证据（写死的绝对路径是否存在、插件名还能不能装上）。
 *   ② **迁移骨架生成**：为用户自建/需迁移的预设生成一个 bundle 目录
 *      （package.json + 声明行 + 逐条插件名核对报告 + 安装指引），
 *      然后引导用户走官方 plugin_manager 或插件市场安装 —— 始终不自己装。
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createRegistryTracker,
  httpError,
  localRoute,
  moduleFiles,
  ok,
  readBody,
  registerCommands,
  registerTools,
  ROUTE_PREFIX,
  resolveDshHome,
  resolveProfileDir,
  trace,
} from '../../core.js'
import { PACKAGE_NAME, readText } from '../../profile-audit.js'

export const moduleName = 'presets'
export const label = { zh: 'agent 预设', en: 'Agent presets' }
export const description = {
  zh: '巡检旧格式 .agent-presets 遗留目录并生成迁移骨架（只生成、不安装；安装走官方 plugin_manager）。',
  en: 'Audit legacy .agent-presets directories and generate a migration skeleton (generate only; installation stays with the official plugin_manager).',
}

const HOST_NAMESPACE = '@deepseek-ai/'
/** 报告缓存时长：`status()` 是"看一眼状态"，不该每次都重扫一遍 node_modules。 */
const REPORT_TTL_MS = 10000
const reportCache = { at: 0, value: null }

/** 让下一次 `cachedPresetReport()` 重新扫描。 */
export function invalidatePresetReportCache() {
  reportCache.at = 0
  reportCache.value = null
}

/**
 * 带 TTL 的预设报告。`status()` 与 `/presets` 路由走缓存，工具调用走 `force`。
 * @param {object} ctx
 * @param {{ force?: boolean }} [options]
 */
export function cachedPresetReport(ctx, options = {}) {
  const now = Date.now()
  if (options.force !== true && reportCache.value !== null && now - reportCache.at < REPORT_TTL_MS) {
    return reportCache.value
  }
  const built = buildPresetReport(ctx)
  reportCache.at = now
  reportCache.value = built
  return built
}

/** preset.yml 的字段（只取我们需要的三个，行级解析）。 */
export function parsePresetYml(text) {
  const result = {}
  for (const rawLine of String(text ?? '').split(/\r?\n/u)) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/u.exec(rawLine)
    if (match === null) continue
    result[match[1]] = match[2].replace(/^['"]|['"]$/gu, '')
  }
  return result
}

/** agent.cordis.yml 里的插件条目（顶层 `- id:` 行）与其 name。 */
export function parsePlugins(text) {
  const plugins = []
  let current = null
  String(text ?? '').split(/\r?\n/u).forEach((rawLine) => {
    const idMatch = /^-\s+id:\s*(\S+)\s*$/u.exec(rawLine)
    if (idMatch !== null) {
      current = { id: idMatch[1], name: null }
      plugins.push(current)
      return
    }
    const nameMatch = /^\s+name:\s*(.+?)\s*$/u.exec(rawLine)
    if (nameMatch !== null && current !== null && current.name === null) {
      current.name = nameMatch[1].replace(/^['"]|['"]$/gu, '')
    }
  })
  return plugins
}

/** 只认"包名"形态的插件标识：`cordis:group`、`./local.mjs`、`/abs/path` 都不是包。 */
export function isPackageSpec(name) {
  return typeof name === 'string' && !name.includes(':') && !name.startsWith('.') && !name.startsWith('/') && PACKAGE_NAME.test(name)
}

/** agent.cordis.yml 里写死的绝对路径（第三方安装遗留最容易坏在这里）。 */
export function extractAbsolutePaths(text) {
  const found = new Set()
  const lines = []
  for (const rawLine of String(text ?? '').split(/\r?\n/u)) {
    // 带引号的路径：`"D:\a\b.mjs"` / `'C:/a/b'`
    const matches = [...rawLine.matchAll(/["']([A-Za-z]:[\\/][^"']+)["']/gu)].map((match) => match[1])
    if (matches.length === 0) {
      // 没有引号时允许路径里有空格，但要在常见的 YAML/代码分隔处停下。
      // 负向断言排除 `<scheme>://`：盘符是"一个字母 + 冒号"，而 scheme 至少要两个字符，
      // 所以"冒号前面还有字母"的一律不是路径 —— 单字母 scheme（`x://…`）也一并挡住。
      for (const match of rawLine.matchAll(/(?<![A-Za-z])([A-Za-z]:[\\/][^\r\n]*?)(?=\s*(?:$|,|\]|\}|["']|#))/gu)) matches.push(match[1])
    }
    for (const path of matches) {
      const cleaned = path.replace(/[\\/]+$/u, '').trim()
      if (cleaned.length < 4) continue
      found.add(cleaned)
    }
    if (matches.length > 0) lines.push(rawLine.trim().slice(0, 200))
  }
  return { paths: [...found], lines: lines.slice(0, 5) }
}

/** 找 $DSH_HOME 下的 `.agent-presets*` 目录。 */
function legacyDirs() {
  const home = resolveDshHome()
  if (home === null) return []
  let names = []
  try { names = readdirSync(home) } catch { return [] }
  return names
    .filter((name) => name.startsWith('.agent-presets'))
    .map((name) => join(home, name))
    .filter((dir) => {
      try { return statSync(dir).isDirectory() } catch { return false }
    })
}

/**
 * node_modules 里的包目录，`@scope/name` 只展开一层。
 *
 * 旧实现让"非 scope 包"的 base 退回整个 node_modules，于是每个包都要把整个目录
 * 重新 readdir 一遍再逐个探测：N 个包 = N 次全量 readdir + N×N 次路径探测。
 * 它挂在 status 上（客户端每 2 秒轮询，10 秒 TTL 一到就重扫），冷体检的耗时几乎全在这里。
 * @param {string} root
 * @returns {Array<{name: string, dir: string}>}
 */
function scanPackages(root) {
  const out = []
  let top = []
  try { top = readdirSync(root) } catch { return out }
  for (const name of top) {
    if (name.startsWith('@')) {
      const scopeDir = join(root, name)
      let children = []
      try { children = readdirSync(scopeDir) } catch { continue }
      for (const child of children) out.push({ name: `${name}/${child}`, dir: join(scopeDir, child) })
      continue
    }
    out.push({ name, dir: join(root, name) })
  }
  return out
}

/** 官方已内置/当前生效的 preset 声明 id：活体 loader + 已安装 bundle 的 presets/ + profile 覆盖行。 */
function collectPresetIds(ctx, profileDir) {
  const ids = new Set()
  // ① 活体 loader —— 最权威（宿主内置的 preset 声明就是普通条目，id 形如 preset-xxx）
  const live = []
  try {
    const entries = Array.from(ctx?.get?.('loader')?.entries?.() ?? [])
    for (const entry of entries) {
      const id = entry?.options?.id ?? entry?.id
      if (typeof id === 'string' && id.startsWith('preset-')) {
        ids.add(id)
        live.push({ id, state: entry?.fiber?.state ?? null, name: entry?.options?.name ?? null })
      }
    }
  } catch { /* loader 不可用就只靠文件扫描 */ }
  // ② 已安装 bundle 自带的 presets/*.yml
  if (profileDir !== null) {
    const root = join(profileDir, 'node_modules')
    for (const pkg of scanPackages(root)) {
      const presetsDir = join(pkg.dir, 'presets')
      let files = []
      try { files = readdirSync(presetsDir) } catch { continue }
      for (const file of files) {
        if (!/\.ya?ml$/u.test(file)) continue
        const text = readText(join(presetsDir, file)) ?? ''
        for (const match of text.matchAll(/^\s*-\s*id:\s*(preset-[\w.-]+)\s*$/gmu)) ids.add(match[1])
      }
    }
    // ③ profile 自己的 patch 里也可能有声明/覆盖行
    const patch = readText(join(profileDir, 'cordis.patch.yml')) ?? ''
    for (const match of patch.matchAll(/^\s*-\s*id:\s*(preset-[\w.-]+)\s*$/gmu)) ids.add(match[1])
  }
  return { ids, live }
}

/** 当前生效的 preset 声明一览（装了的 bundle 里带的）。 */
function currentDeclarations(profileDir) {
  const out = []
  if (profileDir === null) return out
  for (const pkg of scanPackages(join(profileDir, 'node_modules'))) {
    const presetsDir = join(pkg.dir, 'presets')
    let files = []
    try { files = readdirSync(presetsDir) } catch { continue }
    for (const file of files) {
      if (!/\.ya?ml$/u.test(file)) continue
      const full = join(presetsDir, file)
      const text = readText(full) ?? ''
      for (const block of text.split(/\r?\n(?=-\s+id:\s*preset-)/u)) {
        const idMatch = /-\s*id:\s*(preset-[\w.-]+)/u.exec(block)
        if (idMatch === null) continue
        const orderMatch = /order:\s*(\d+)/u.exec(block)
        const pluginCount = (block.match(/^\s{4,}-\s+id:/gmu) ?? []).length
        out.push({
          id: idMatch[1],
          order: orderMatch === null ? null : Number(orderMatch[1]),
          plugins: pluginCount,
          source: `${pkg.name}/${file}`,
          file: full,
        })
      }
    }
  }
  return out.sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
}

/** 一个旧格式 preset 的判定。 */
export function judgeLegacy(dir, shipped, profileDir) {
  const id = dir.split(/[\\/]/u).pop() ?? ''
  const presetText = readText(join(dir, 'preset.yml'))
  const agentText = readText(join(dir, 'agent.cordis.yml'))
  const meta = parsePresetYml(presetText ?? '')
  const plugins = parsePlugins(agentText ?? '')
  const paths = extractAbsolutePaths(agentText ?? '')
  const deadPaths = paths.paths.filter((path) => !existsSync(path))
  const nodeModules = profileDir === null ? null : join(profileDir, 'node_modules')
  const missingPlugins = []
  const builtinPlugins = []
  for (const plugin of plugins) {
    if (plugin.name === null) continue
    if (plugin.name.startsWith(HOST_NAMESPACE)) continue
    // `cordis:group` 这类是内置的组标记，不是包，不该报"缺包"
    if (!isPackageSpec(plugin.name)) { builtinPlugins.push(plugin.name); continue }
    if (nodeModules !== null && !existsSync(join(nodeModules, plugin.name))) missingPlugins.push(plugin.name)
  }
  const shippedId = `preset-${id.replace(/^wsl-/u, '')}`
  const isShipped = shipped.has(shippedId) || shipped.has(`preset-${id}`)
  const verdict = isShipped
    ? 'shipped'
    : deadPaths.length > 0 || missingPlugins.length > 0
      ? 'stale'
      : 'user'
  return {
    dir,
    id,
    name: meta.name ?? null,
    order: meta.order === undefined ? null : Number(meta.order) || null,
    description: meta.description ?? null,
    plugins: plugins.length,
    pluginNames: plugins.map((plugin) => plugin.name).filter((name) => typeof name === 'string'),
    builtinPlugins,
    deadPaths,
    deadPathLines: paths.lines,
    missingPlugins,
    shippedAs: isShipped ? shippedId : null,
    verdict,
  }
}

/** 旧格式巡检 + 当前声明一览 + 建议。 */
export function buildPresetReport(ctx) {
  const profileDir = resolveProfileDir()
  const collected = collectPresetIds(ctx, profileDir)
  const shipped = collected.ids
  const legacy = legacyDirs()
  const records = []
  for (const dir of legacy) {
    let children = []
    try {
      children = readdirSync(dir)
        .map((name) => join(dir, name))
        .filter((child) => {
          try { return statSync(child).isDirectory() } catch { return false }
        })
    } catch { continue }
    for (const child of children) {
      if (!existsSync(join(child, 'agent.cordis.yml'))) continue
      records.push(judgeLegacy(child, shipped, profileDir))
    }
  }
  const declarations = [
    ...collected.live.map((item) => ({ id: item.id, order: null, plugins: null, source: 'live loader', state: item.state, file: null })),
    ...currentDeclarations(profileDir),
  ]
  const findings = []
  const stale = records.filter((record) => record.verdict === 'stale')
  const shippedRecords = records.filter((record) => record.verdict === 'shipped')
  const userRecords = records.filter((record) => record.verdict === 'user')
  if (stale.length > 0) {
    findings.push({
      level: 'warn', code: 'legacy-stale-presets',
      title: `有 ${stale.length} 个旧格式预设已经失效（写死了不存在的路径或缺插件）`,
      detail: `这些目录当前版本不会再读：${stale.map((record) => record.id).join('、')}。要恢复同类能力，应改用插件市场安装对应的 bundle，再由 DSH 重新生成预设。`,
    })
  }
  if (shippedRecords.length > 0) {
    findings.push({
      level: 'info', code: 'legacy-shipped-presets',
      title: `有 ${shippedRecords.length} 个旧格式预设，当前版本已内置同名声明，可以直接删`,
      detail: shippedRecords.map((record) => `${record.id} → ${record.shippedAs}`).join('；'),
    })
  }
  if (userRecords.length > 0) {
    findings.push({
      level: 'warn', code: 'legacy-user-presets',
      title: `有 ${userRecords.length} 个疑似自建的旧格式预设需要迁移`,
      detail: `${userRecords.map((record) => record.id).join('、')}。可以用本模块生成迁移骨架（只生成 bundle 目录，安装仍走官方 plugin_manager）。`,
    })
  }
  if (records.length === 0) {
    findings.push({ level: 'info', code: 'no-legacy-presets', title: '没有发现旧格式的 .agent-presets 目录', detail: '当前版本用的是 bundle 声明行，没有遗留需要处理。' })
  }
  return { at: new Date().toISOString(), profileDir, legacyDirs: legacy, records, declarations, findings, shippedIds: [...shipped] }
}

export function renderPresetReport(report) {
  const lines = []
  lines.push(`agent 预设：当前声明 ${report.declarations.length} 条；旧格式遗留 ${report.records.length} 个`)
  lines.push('')
  if (report.declarations.length > 0) {
    lines.push('当前生效的声明：')
    for (const item of report.declarations.slice(0, 20)) {
      const count = item.plugins === null || item.plugins === undefined ? '' : `，插件 ${item.plugins} 条`
      lines.push(`  · ${item.id}（order=${item.order ?? '-'}${count}）  ← ${item.source}`)
    }
    lines.push('')
  }
  if (report.records.length === 0) {
    lines.push('没有发现旧格式 .agent-presets 目录，无需处理。')
  } else {
    lines.push('旧格式遗留目录：')
    for (const record of report.records) {
      const tag = record.verdict === 'shipped' ? '官方已内置' : record.verdict === 'stale' ? '已失效' : '疑似自建'
      lines.push(`  · ${record.id}［${tag}］${record.name ?? ''}`)
      lines.push(`      插件 ${record.plugins} 条（内置组标记 ${record.builtinPlugins.length} 个）；写死的绝对路径 ${record.deadPaths.length} 个`)
      if (record.shippedAs !== null) lines.push(`      当前版本内置为：${record.shippedAs}`)
      if (record.missingPlugins.length > 0) lines.push(`      缺包：${[...new Set(record.missingPlugins)].join('、')}`)
      if (record.deadPathLines.length > 0) lines.push(`      例：${record.deadPathLines[0]}`)
    }
  }
  for (const finding of report.findings) {
    const tag = finding.level === 'error' ? '错误' : finding.level === 'warn' ? '提示' : '备注'
    lines.push('')
    lines.push(`[${tag}] ${finding.title}`)
    if (finding.detail) lines.push(`      ${String(finding.detail).replace(/\n/gu, ' ')}`)
  }
  return lines.join('\n')
}

/** 把一段 YAML 整体缩进 n 个空格（用于把 agent.cordis.yml 嵌进声明行）。 */
function indentBlock(text, spaces) {
  const pad = ' '.repeat(spaces)
  return String(text ?? '')
    .replace(/\r\n/gu, '\n')
    .split('\n')
    .map((line) => (line.trim() === '' ? line : `${pad}${line}`))
    .join('\n')
    .replace(/\n+$/u, '')
}

/**
 * 为某个旧格式预设生成迁移骨架（bundle 目录）。**只生成，不安装。**
 * @param {string} id 旧预设目录名（例如 wsl-standard）
 */
export function generateSkeleton(id, ctx) {
  const report = buildPresetReport(ctx)
  const record = report.records.find((item) => item.id === id)
  if (record === undefined) throw httpError(404, 'PRESET_NOT_FOUND', `找不到旧格式预设：${id}`)
  const paths = moduleFiles('presets')
  const outDir = join(paths.dir, 'bundles', `dsh-preset-${id}`)
  try {
    mkdirSync(outDir, { recursive: true })
  } catch (error) {
    throw httpError(500, 'MKDIR_FAILED', `创建目录失败：${error?.message ?? String(error)}`)
  }
  const agentText = readText(join(record.dir, 'agent.cordis.yml')) ?? ''
  const packageName = `dsh-preset-${id.replace(/[^a-z0-9._-]+/giu, '-').toLowerCase()}`

  const manifest = {
    name: packageName,
    version: '0.1.0',
    private: true,
    description: `Migrated agent preset ${id}（由 dsh-shell-kit presets 模块生成）`,
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }
  const declaration = [
    '# 由 dsh-shell-kit presets 模块生成：旧格式 .agent-presets/' + id + ' 的迁移骨架',
    '# 按官方 skill（editing-cordis-compositions）的约定：声明行取 id/name/order 自',
    '# preset.yml，plugins 取 agent.cordis.yml 原文。插件名沿用旧名 —— 若某个包已改名，',
    '# 激活时会失败，请按下面的核对结果逐个确认。',
    '- id: preset-' + id,
    "  name: '@deepseek-ai/dsh-agent-preset'",
    '  config:',
    `    id: ${id}`,
    `    order: ${record.order ?? 100}`,
    ...(record.name === null ? [] : [`    name: ${JSON.stringify(record.name)}`]),
    ...(record.description === null ? [] : [`    description: ${JSON.stringify(record.description)}`]),
    '    plugins:',
    indentBlock(agentText, 6),
    '',
  ].join('\n')

  const checkLines = record.pluginNames
    .filter((name) => !record.builtinPlugins.includes(name))
    .map((name) => {
      const host = name.startsWith(HOST_NAMESPACE)
      return `- [${host ? '宿主自带' : '已在 profile 里'}] ${name}`
    })
  const builtinLines = record.builtinPlugins.length === 0
    ? []
    : [`- [内置标记] ${[...new Set(record.builtinPlugins)].join('、')}（不是包名，无需安装）`]
  const missing = [...new Set(record.missingPlugins)].map((name) => `- [缺] ${name}（profile 里没有这个包；可能已改名或需要先装）`)
  const readme = [
    `# 迁移骨架：${id}`,
    '',
    `由 dsh-shell-kit 的 presets 模块生成于 ${new Date().toISOString()}。`,
    '',
    '## 它是什么',
    '',
    '旧格式 `$DSH_HOME/.agent-presets/' + id + '/`（`preset.yml` + `agent.cordis.yml`）在当前版本**已经不会被读取**。',
    '官方做法是把预设变成 bundle 里的一条**声明行**（本目录的 `cordis.patch.yml` 就是这条声明）。',
    '',
    '## 怎么装（不要用 shell 命令复刻，走官方入口）',
    '',
    '1. 让 agent 调用官方 `plugin_manager` 工具：`action: install_bundle`，`target` 指到本目录：',
    `   ${outDir}`,
    '2. 或者把本目录交给插件市场安装。',
    '3. 装完用 `plugin_manager` 的 `list_bundles` / `list_plugins` 确认出现 `preset-' + id + '` 行，',
    '   并确认它的激活状态正常（激活失败的行会留在名单上并带诊断信息）。',
    '4. 确认无误后，再删掉旧的 `.agent-presets*` 目录（例如 ' + record.id + '）。',
    '',
    '## 插件名核对（最重要的一步）',
    '',
    '旧预设里写的是当时的包名，官方文档明确提醒：**改过名的包会让声明激活失败**。',
    '',
    ...checkLines,
    ...builtinLines,
    ...missing,
    ...(record.deadPathLines.length === 0 ? [] : [
      '',
      '## 旧文件里写死的绝对路径（迁移时通常都要删掉）',
      '',
      ...record.deadPathLines.map((line) => `- \`${line}\``),
      '',
    ]),
    '',
  ].join('\n')

  try {
    writeFileSync(join(outDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    writeFileSync(join(outDir, 'cordis.patch.yml'), declaration, 'utf8')
    writeFileSync(join(outDir, 'README.md'), readme, 'utf8')
  } catch (error) {
    throw httpError(500, 'WRITE_FAILED', `写骨架失败：${error?.message ?? String(error)}`)
  }
  trace(`presets：已生成迁移骨架 ${outDir}（预设 ${id}，插件 ${record.plugins} 条）`)
  return {
    id,
    outDir,
    files: ['package.json', 'cordis.patch.yml', 'README.md'],
    plugins: record.plugins,
    missingPlugins: record.missingPlugins,
    deadPaths: record.deadPaths,
    installHint: `让 agent 调用官方 plugin_manager（action: install_bundle，target: ${outDir}），或把该目录交给插件市场安装。本模块不会自己安装。`,
  }
}

/**
 * 挂载「agent 预设」模块。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function mount(ctx) {
  const tracker = createRegistryTracker()
  const registrations = tracker.state
  const disposers = []

  try {
    disposers.push(localRoute(ctx, {
      method: 'GET',
      path: `${ROUTE_PREFIX}/presets/report`,
      handler: async (req, res) => {
        const report = cachedPresetReport(ctx)
        ok(res, { ...report, text: renderPresetReport(report) })
      },
    }))
  } catch (error) {
    ctx.logger?.warn(`[shell-kit:presets] 路由注册失败：${error?.message ?? String(error)}`)
    trace(`presets 路由注册失败：${error?.stack ?? error?.message ?? String(error)}`)
  }
  registrations.routes = disposers.length

  registerCommands(ctx, {
    label: 'presets',
    tracker,
    register: (commandCtx) => commandCtx.commands.register({
      name: 'presets',
      description: '查看 agent 预设现状与旧格式遗留；`/presets migrate <id>` 生成迁移骨架（不安装）',
      input: { hint: '[migrate <id>]' },
      handler: ({ rawInput }) => {
        try {
          const input = String(rawInput ?? '').trim()
          if (input.toLowerCase().startsWith('migrate')) {
            const id = input.split(/\s+/u)[1]
            if (id === undefined || id === '') return { kind: 'error', text: '用法：/presets migrate <预设目录名>（先发 /presets 看有哪些）' }
            const result = generateSkeleton(id, ctx)
            return { kind: 'success', text: `已生成迁移骨架：${result.outDir}\n文件：${result.files.join('、')}\n插件 ${result.plugins} 条，其中缺 ${result.missingPlugins.length} 个。\n\n${result.installHint}` }
          }
          return { kind: 'success', text: renderPresetReport(cachedPresetReport(ctx)) }
        } catch (error) {
          return { kind: 'error', text: `处理失败：${error?.message ?? String(error)}` }
        }
      },
    }),
  })

  registerTools(ctx, {
    label: 'presets',
    tracker,
    definition: {
      name: 'audit_presets',
      description: [
        '巡检 DeepSeek Harness 的 agent 预设：列出当前生效的 preset 声明（来自已安装 bundle），',
        '并检查 $DSH_HOME 下旧格式 .agent-presets 遗留目录（当前版本已不读这套格式），',
        '逐个判定"官方已内置可直接删" / "已失效" / "疑似自建需迁移"。',
        '可选 generate 指定 id 时，为该预设生成迁移 bundle 骨架到模块数据目录 —— 只生成文件，',
        '安装仍然必须走官方 plugin_manager（install_bundle）或插件市场。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          generate: { type: 'string', description: '为这个旧预设 id 生成迁移骨架（省略则只巡检）' },
        },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args) {
        const options = typeof args === 'object' && args !== null ? args : {}
        // 工具调用要的是"现在"的结论，所以绕过 TTL 缓存。
        const report = cachedPresetReport(ctx, { force: true })
        const header = renderPresetReport(report)
        if (typeof options.generate !== 'string' || options.generate === '') return header
        const result = generateSkeleton(options.generate, ctx)
        return `${header}\n\n已生成迁移骨架：${result.outDir}\n文件：${result.files.join('、')}\n缺插件：${result.missingPlugins.length} 个\n\n${result.installHint}`
      },
    },
  })

  trace('presets.mount 完成')
  return {
    dispose() {
      for (const dispose of disposers) {
        try { dispose() } catch { /* 释放失败不影响进程退出 */ }
      }
      invalidatePresetReportCache()
    },
    status() {
      const report = cachedPresetReport(ctx)
      return {
        declarations: report.declarations.length,
        legacy: report.records.length,
        legacyStale: report.records.filter((record) => record.verdict === 'stale').length,
        legacyShipped: report.records.filter((record) => record.verdict === 'shipped').length,
        legacyUser: report.records.filter((record) => record.verdict === 'user').length,
        findings: report.findings.map((finding) => finding.code),
        registrations: { ...registrations },
      }
    },
  }
}
