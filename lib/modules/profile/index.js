/**
 * dsh-shell-kit — 「配置体检与修复」模块。
 *
 * 与 doctor 的分工：doctor 只**看**，本模块能**修**。
 *   看 —— 复用 lib/profile-audit.js 的静态审计（patch 行 / 依赖 / 组合包）。
 *   修 —— 把坏条目用官方那套「覆盖行」停掉：往 profile 的 cordis.patch.yml 写
 *        `- id: X` + `disabled: true`（插件市场也是这么写开关的），**先备份**，
 *        同 id 已有覆盖行就就地改写（保留它自己的 config 等键，不堆重复行），
 *        写完自审 + 临时文件原子改名，再在同目录留一份可手工执行的 apply/rollback 说明与脚本。
 *
 * 三条铁律，都是刻意的：
 *   1. 写入前一定先备份 cordis.patch.yml（`*.bak-shellkit-<时间戳>`）；
 *   2. 任何"改配置"都必须显式确认（工具/命令默认只给方案，dry-run）；
 *   3. 只动 cordis.patch.yml 这一层：删依赖、删 junction 这类动 package.json 与
 *      node_modules 的操作**只给出手工命令**，不代劳。
 */
import { copyFileSync, existsSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
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
  resolveProfileDir,
  ROUTE_PREFIX,
  trace,
} from '../../core.js'
import { collectProfileFindings, listPatchBackups, parsePatchRows, readText } from '../../profile-audit.js'
import { readOverride, upsertOverride } from './patch-text.js'

export const moduleName = 'profile'
export const label = { zh: '配置体检与修复', en: 'Profile repair' }
export const description = {
  zh: '体检 profile 配置与依赖，并把坏条目用官方覆盖行安全停掉（先备份，默认只给方案）。',
  en: 'Audit the profile and safely disable broken entries through the official patch override rows (backup first; dry-run by default).',
}

/**
 * loader 条目 id 的合法形态：`- id: X` 这一行的 X 只可能是这种标识
 * （字母开头，后面是字母/数字/下划线/连字符）。
 *
 * 这条校验是**安全**需要而不是洁癖：id 会被直接拼进 `cordis.patch.yml` 的行里，
 * 不校验的话，一个带换行的 id 就能往用户 profile 里注入任意 YAML 行。
 */
const ENTRY_ID = /^[A-Za-z][\w-]*$/u

/** 只保留最近这么多份 patch 备份（再往前没人会手工去回滚）。 */
const KEEP_BACKUPS = 10
/** 临时文件超过这个年龄才算孤儿：更年轻的可能正被另一次写入/另一个进程用着。 */
const TMP_MAX_AGE_MS = 60_000

/**
 * 清掉本模块自己留下的垃圾：超额的 patch 备份 + 中途被杀时留下的 .tmp-shellkit-*。
 *
 * 为什么挂在 buildPlan 里：体检每次都会跑（status 轮询每 2 秒一次），清理就
 * "顺带发生"，不需要再养一个定时器，也不会在退出路径上漏掉。
 * @param {string} profileDir
 */
function pruneProfileArtifacts(profileDir) {
  for (const old of listPatchBackups(profileDir).slice(KEEP_BACKUPS)) {
    try { unlinkSync(join(profileDir, old.name)) } catch { /* 删不掉就留着，不影响体检 */ }
  }
  let names = []
  try { names = readdirSync(profileDir) } catch { return }
  const now = Date.now()
  for (const name of names) {
    if (!name.startsWith('cordis.patch.yml.tmp-shellkit-')) continue
    const full = join(profileDir, name)
    try {
      if (now - statSync(full).mtimeMs < TMP_MAX_AGE_MS) continue
      unlinkSync(full)
    } catch { /* 正在被用就跳过 */ }
  }
}

/** 生成"可修项"清单：只有带 id 的问题才可能被安全地停掉。 */
export function buildPlan() {
  const profileDir = resolveProfileDir()
  if (profileDir === null) {
    return {
      profileDir: null, patchPath: null, fixable: [], findings: [],
      backups: [], manual: [], error: '定位不到 profile 目录',
    }
  }
  // 体检顺带清垃圾：备份只留最近 KEEP_BACKUPS 份，孤儿临时文件删掉。
  pruneProfileArtifacts(profileDir)
  const audit = collectProfileFindings(profileDir)
  const findings = audit.findings
  const rows = audit.rows
  const fixable = []
  const manual = []
  for (const finding of findings) {
    if (finding.fix?.kind === 'disable-entry' && typeof finding.fix.id === 'string') {
      // 同一个 id 可能同时有 insert 行和覆盖行，find 取到的也许是没有 disabled 的那条。
      // 判「已经停用」要问「任意一行 disabled 了吗」，否则会重复写一遍覆盖行。
      const alreadyDisabled = rows.some((candidate) => candidate.id === finding.fix.id && candidate.disabled === 'true')
      fixable.push({
        id: finding.fix.id,
        problem: finding.title,
        detail: finding.detail ?? null,
        evidence: finding.evidence ?? null,
        alreadyDisabled,
        action: 'disable-entry',
        preview: `- id: ${finding.fix.id}\n  disabled: true`,
      })
      continue
    }
    if (finding.code === 'broken-link' || finding.code === 'bundle-missing') {
      manual.push({ code: finding.code, problem: finding.title, detail: finding.detail ?? null })
    }
  }
  return {
    profileDir,
    patchPath: join(profileDir, 'cordis.patch.yml'),
    findings,
    fixable,
    manual,
    backups: listPatchBackups(profileDir).slice(0, 10),
    error: null,
  }
}

/** 写一份人类可读的修复说明（含要追加的 YAML 与回滚命令）。 */
function writeNotes(paths, { stamp, backupPath, patchPath, actions }) {
  const lines = [
    `# dsh-shell-kit profile 修复记录 ${stamp}`,
    '',
    `目标文件：${patchPath}`,
    `备份：${backupPath}`,
    '',
    '## 本次写入的覆盖行',
    '',
    '```yaml',
    ...actions.map((action) => `- id: ${action.id}\n  disabled: ${action.type === 'disable-entry' ? 'true' : 'false'}`),
    '```',
    '',
    '## 回滚',
    '',
    '```powershell',
    `Copy-Item '${backupPath}' '${patchPath}' -Force`,
    '```',
  ].join('\n')
  const notePath = join(paths.dir, `apply-${stamp}.md`)
  try { writeFileSync(notePath, `${lines}\n`, 'utf8') } catch { return null }
  return notePath
}

/**
 * 执行修复：先备份，再追加覆盖行。
 * @param {Array<{type:'disable-entry'|'enable-entry', id:string}>} actions
 * @param {{confirm:boolean}} options confirm 必须为 true
 */
export function applyFixes(actions, options = {}) {
  if (options.confirm !== true) throw httpError(400, 'CONFIRM_REQUIRED', '改配置需要显式确认（confirm: true）')
  const plan = buildPlan()
  if (plan.profileDir === null || plan.patchPath === null) throw httpError(500, 'NO_PROFILE', '定位不到 profile 目录')
  const list = Array.isArray(actions) ? actions.filter((action) => action !== null && typeof action === 'object') : []
  const valid = list.filter((action) => (action.type === 'disable-entry' || action.type === 'enable-entry') && typeof action.id === 'string' && action.id !== '')
  if (valid.length === 0) throw httpError(400, 'NO_ACTIONS', '没有可执行的修复动作')
  // 拼进 YAML 之前的最后一道闸：id 必须是合法条目 id，否则拒绝整次写入（不做"跳过坏的那个"，
  // 免得用户以为全部都修了）。
  for (const action of valid) {
    if (!ENTRY_ID.test(action.id)) {
      throw httpError(400, 'BAD_ACTION_ID', `拒绝写入：条目 id 不是合法标识 —— ${JSON.stringify(action.id)}`)
    }
  }

  const before = readText(plan.patchPath)
  if (before === null) throw httpError(500, 'PATCH_MISSING', `读不到 ${plan.patchPath}`)

  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const backupPath = `${plan.patchPath}.bak-shellkit-${stamp}`
  try {
    copyFileSync(plan.patchPath, backupPath)
  } catch (error) {
    throw httpError(500, 'BACKUP_FAILED', `备份失败，未做任何修改：${error?.message ?? String(error)}`)
  }

  const paths = moduleFiles('profile')
  // 逐条合并：已有覆盖行就改它（保住它自己的 config 等键），没有才追加新行。
  // 旧实现一律追加，同一个 id 反复修就会堆出重复覆盖行。
  const header = `# ↓ dsh-shell-kit profile 修复 ${stamp}（备份：${backupPath.split(/[\\/]/u).pop()}）`
  let after = before
  const changes = []
  for (const action of valid) {
    const disabled = action.type === 'disable-entry'
    const merged = upsertOverride(after, { id: action.id, disabled, header })
    after = merged.text
    changes.push({ id: action.id, type: action.type, disabled, mode: merged.mode })
  }

  // 写入前自审：每一条动作都要能在结果里读回目标值，否则宁可不写。
  for (const change of changes) {
    if (readOverride(after, change.id) !== change.disabled) {
      throw httpError(500, 'MERGE_SELFCHECK_FAILED', `合并结果自审失败（${change.id}），未做任何修改`)
    }
  }
  // 原有条目只允许增、不允许少：合并写坏了别人的行比不写更糟。
  const idsAfter = new Set(parsePatchRows(after).map((row) => row.id))
  for (const row of parsePatchRows(before)) {
    if (row.id !== undefined && !idsAfter.has(row.id)) {
      throw httpError(500, 'MERGE_SELFCHECK_FAILED', `合并结果丢了条目 ${row.id}，未做任何修改`)
    }
  }

  // 原子写：先写同目录临时文件，再改名覆盖 —— 半截的 YAML 是最难查的故障。
  const tmpPath = `${plan.patchPath}.tmp-shellkit-${stamp}`
  try {
    writeFileSync(tmpPath, after, 'utf8')
    renameSync(tmpPath, plan.patchPath)
  } catch (error) {
    try { rmSync(tmpPath, { force: true }) } catch { /* 尽力而为 */ }
    try { copyFileSync(backupPath, plan.patchPath) } catch { /* 尽力而为 */ }
    throw httpError(500, 'WRITE_FAILED', `写入失败，已尝试回滚：${error?.message ?? String(error)}`)
  }
  const notePath = writeNotes(paths, { stamp, backupPath, patchPath: plan.patchPath, actions: valid })
  trace(`profile 修复已应用：${valid.map((action) => `${action.type}:${action.id}`).join(', ')}；备份 ${backupPath}`)
  return {
    applied: valid,
    changes,
    backupPath,
    notePath,
    patchPath: plan.patchPath,
    atomic: true,
    bytesBefore: Buffer.byteLength(before, 'utf8'),
    bytesAfter: Buffer.byteLength(after, 'utf8'),
  }
}

/** 回滚：用某份备份覆盖当前 patch（默认用最新的一份）。 */
export function restoreBackup(name) {
  const plan = buildPlan()
  if (plan.profileDir === null || plan.patchPath === null) throw httpError(500, 'NO_PROFILE', '定位不到 profile 目录')
  const backups = listPatchBackups(plan.profileDir)
  if (backups.length === 0) throw httpError(404, 'NO_BACKUP', '没有可用的备份')
  const target = typeof name === 'string' && name !== '' ? backups.find((item) => item.name === name) : backups[0]
  if (target === undefined) throw httpError(404, 'BACKUP_NOT_FOUND', `找不到备份：${name}`)
  const source = join(plan.profileDir, target.name)
  if (!existsSync(source)) throw httpError(404, 'BACKUP_MISSING', source)
  // 回滚也先给当前文件留一份，免得"回滚"本身不可逆。
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const safety = `${plan.patchPath}.bak-shellkit-${stamp}`
  // 回滚同样要原子：直接 copyFileSync 覆盖，进程在写一半时被杀就留下半截 YAML。
  const tmpPath = `${plan.patchPath}.tmp-shellkit-${stamp}`
  try {
    copyFileSync(plan.patchPath, safety)
    copyFileSync(source, tmpPath)
    renameSync(tmpPath, plan.patchPath)
  } catch (error) {
    try { rmSync(tmpPath, { force: true }) } catch { /* 尽力而为 */ }
    throw httpError(500, 'RESTORE_FAILED', `回滚失败：${error?.message ?? String(error)}`)
  }
  trace(`profile 已回滚到 ${target.name}（回滚前的文件备份为 ${safety}）`)
  return { restored: target.name, safetyBackup: safety }
}

/** 给人/给 agent 看的文本。 */
export function renderPlan(plan) {
  const lines = []
  if (plan.error !== null) return `配置体检：${plan.error}`
  lines.push(`配置体检：可修 ${plan.fixable.length} 项，需手工处理 ${plan.manual.length} 项`)
  lines.push(`patch：${plan.patchPath}`)
  lines.push(`已有备份：${plan.backups.length} 份（最新 ${plan.backups[0]?.name ?? '无'}）`)
  if (plan.fixable.length === 0 && plan.manual.length === 0) {
    lines.push('')
    lines.push('没有需要处理的问题。')
    return lines.join('\n')
  }
  if (plan.fixable.length > 0) {
    lines.push('')
    lines.push('可一键修复（加覆盖行停掉坏条目，改前自动备份）：')
    for (const item of plan.fixable) {
      lines.push(`  · ${item.id}${item.alreadyDisabled ? '（已经是停用状态）' : ''} —— ${item.problem}`)
      if (item.evidence !== null) lines.push(`      证据：${item.evidence}`)
    }
  }
  if (plan.manual.length > 0) {
    lines.push('')
    lines.push('需要手工处理（本模块不代改 package.json / node_modules）：')
    for (const item of plan.manual) {
      lines.push(`  · ${item.problem}`)
      if (item.detail !== null) lines.push(`      ${String(item.detail).replace(/\n/gu, ' ')}`)
    }
  }
  return lines.join('\n')
}

/**
 * 挂载「配置体检与修复」模块。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function mount(ctx) {
  const paths = moduleFiles('profile')
  const tracker = createRegistryTracker()
  const registrations = tracker.state
  const disposers = []
  let lastApply = null

  try {
    disposers.push(localRoute(ctx, {
      method: 'GET',
      path: `${ROUTE_PREFIX}/profile/plan`,
      handler: async (req, res) => {
        const plan = buildPlan()
        ok(res, { ...plan, text: renderPlan(plan), lastApply })
      },
    }))
    disposers.push(localRoute(ctx, {
      method: 'POST',
      path: `${ROUTE_PREFIX}/profile/apply`,
      handler: async (req, res) => {
        const body = await readBody(req)
        const plan = buildPlan()
        // 允许 body.actions 指定，缺省则修掉全部"可修项"（仍需 confirm）
        const actions = Array.isArray(body.actions) && body.actions.length > 0
          ? body.actions
          : plan.fixable.filter((item) => !item.alreadyDisabled).map((item) => ({ type: 'disable-entry', id: item.id }))
        const result = applyFixes(actions, { confirm: body.confirm === true })
        lastApply = { at: new Date().toISOString(), ...result }
        ok(res, { ...result, message: `已追加 ${result.applied.length} 条覆盖行（备份：${result.backupPath.split(/[\\/]/u).pop()}）；重启后生效` })
      },
    }))
    disposers.push(localRoute(ctx, {
      method: 'POST',
      path: `${ROUTE_PREFIX}/profile/restore`,
      handler: async (req, res) => {
        const body = await readBody(req)
        const result = restoreBackup(typeof body.backup === 'string' ? body.backup : undefined)
        lastApply = { at: new Date().toISOString(), ...result, restored: true }
        ok(res, { ...result, message: `已回滚到 ${result.restored}；重启后生效` })
      },
    }))
  } catch (error) {
    ctx.logger?.warn(`[shell-kit:profile] 路由注册失败：${error?.message ?? String(error)}`)
    trace(`profile 路由注册失败：${error?.stack ?? error?.message ?? String(error)}`)
  }
  registrations.routes = disposers.length

  registerCommands(ctx, {
    label: 'profile',
    tracker,
    register: (commandCtx) => commandCtx.commands.register({
      name: 'fix',
      description: '配置体检与修复：不带参数只看方案，`/fix apply` 才会写入（写前自动备份）',
      input: { hint: '[apply]' },
      handler: ({ rawInput }) => {
        try {
          const plan = buildPlan()
          const shouldApply = String(rawInput ?? '').trim().toLowerCase().startsWith('apply')
          if (!shouldApply) return { kind: 'success', text: `${renderPlan(plan)}\n\n要执行就发 /fix apply（会先备份 cordis.patch.yml）。` }
          if (plan.fixable.length === 0) return { kind: 'success', text: '没有可一键修复的项，不需要写入。' }
          const result = applyFixes(plan.fixable.filter((item) => !item.alreadyDisabled).map((item) => ({ type: 'disable-entry', id: item.id })), { confirm: true })
          return { kind: 'success', text: `已追加 ${result.applied.length} 条覆盖行，备份：${result.backupPath}\n重启后生效；要撤销就回到这一轮对话让我回滚，或手工把备份拷回去。` }
        } catch (error) {
          return { kind: 'error', text: `修复失败：${error?.message ?? String(error)}` }
        }
      },
    }),
  })

  registerTools(ctx, {
    label: 'profile',
    tracker,
    definition: {
      name: 'fix_profile',
      description: [
        '体检并（可选）修复 DeepSeek Harness 的 profile 配置：把引用了不存在包的坏条目、name 非法的条目，',
        '用官方覆盖行 `- id: X` + `disabled: true` 安全停掉，写前自动备份 cordis.patch.yml。',
        '默认只返回方案（dry-run）；真的要写时必须显式传 apply: true。只动 cordis.patch.yml，',
        '不代改 package.json 与 node_modules（那些只给手工命令）。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          apply: { type: 'boolean', description: '是否真的写入（默认 false，只给方案）' },
          ids: { type: 'array', items: { type: 'string' }, description: '只修这些 id（省略就是全部可修项）' },
        },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args) {
        const options = typeof args === 'object' && args !== null ? args : {}
        const plan = buildPlan()
        const header = renderPlan(plan)
        if (options.apply !== true) return `${header}\n\n（dry-run：要执行请再调用一次并传 apply: true）`
        const wanted = Array.isArray(options.ids) && options.ids.length > 0 ? new Set(options.ids) : null
        const actions = plan.fixable
          .filter((item) => !item.alreadyDisabled && (wanted === null || wanted.has(item.id)))
          .map((item) => ({ type: 'disable-entry', id: item.id }))
        if (actions.length === 0) return `${header}\n\n没有需要写入的项。`
        const result = applyFixes(actions, { confirm: true })
        return `${header}\n\n已追加 ${result.applied.length} 条覆盖行。\n备份：${result.backupPath}\n说明与回滚命令：${result.notePath ?? '（未写出）'}\n重启后生效。`
      },
    },
  })

  trace('profile.mount 完成')
  return {
    dispose() {
      for (const dispose of disposers) {
        try { dispose() } catch { /* 释放失败不影响进程退出 */ }
      }
    },
    status() {
      const plan = buildPlan()
      return {
        profileDir: plan.profileDir,
        fixable: plan.fixable.length,
        manual: plan.manual.length,
        backups: plan.backups.length,
        lastApply,
        registrations: { ...registrations },
      }
    },
  }
}
