/**
 * dsh-shell-kit — 重启引擎与预设解析的回归测试。
 *
 * engine.js 的导入是安全的：它只 import node: 内置模块、core.js，以及在模块顶层做的
 * `fileURLToPath(new URL('./helper.mjs', import.meta.url))`（纯路径计算，不读文件）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  COOLDOWN_MS,
  DEFAULT_DELAY_MS,
  DEFAULT_DELAY_MS_INTERACTIVE,
  MIN_DELAY_MS,
  clampDelay,
} from '../lib/modules/restart/engine.js'
import { parsePlugins, parsePresetYml, extractAbsolutePaths, isPackageSpec, judgeLegacy } from '../lib/modules/presets/index.js'
import { describeDuplicate } from '../lib/modules/restart/index.js'

function tempDir(label) {
  const dir = join(tmpdir(), `dsh-shell-kit-test-${label}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/* ------------------------------------------------------------------ */
/* 重启引擎：延迟夹取与静默期常量                                          */
/* ------------------------------------------------------------------ */

test('clampDelay：非法值用默认值，低于下限抬到下限，高于 60s 压到 60s', () => {
  assert.equal(clampDelay(undefined, DEFAULT_DELAY_MS), DEFAULT_DELAY_MS)
  assert.equal(clampDelay(Number.NaN, DEFAULT_DELAY_MS), DEFAULT_DELAY_MS)
  assert.equal(clampDelay('abc', DEFAULT_DELAY_MS), DEFAULT_DELAY_MS)
  assert.equal(clampDelay(0, DEFAULT_DELAY_MS), MIN_DELAY_MS)
  assert.equal(clampDelay(1200, DEFAULT_DELAY_MS), MIN_DELAY_MS)
  assert.equal(clampDelay(MIN_DELAY_MS, DEFAULT_DELAY_MS), MIN_DELAY_MS)
  assert.equal(clampDelay(5000, DEFAULT_DELAY_MS), 5000)
  assert.equal(clampDelay(60001, DEFAULT_DELAY_MS), 60000)
  // 交互路径（命令/工具）留得更宽松，但同样受上下限约束
  assert.equal(clampDelay(undefined, DEFAULT_DELAY_MS_INTERACTIVE), DEFAULT_DELAY_MS_INTERACTIVE)
  assert.equal(clampDelay(100, DEFAULT_DELAY_MS_INTERACTIVE), MIN_DELAY_MS)
})

test('静默期常量是一个正数（界面与 CLI 文案依赖它）', () => {
  assert.equal(Number.isInteger(COOLDOWN_MS), true)
  assert.ok(COOLDOWN_MS > 0)
})

test('describeDuplicate：延迟未到点算"在路上"，到点后 COOLDOWN_MS 内算静默期，过后放行', () => {
  const t0 = 1_000_000
  const state = { lastScheduledAt: t0, lastDelayMs: MIN_DELAY_MS }

  // 从没排过
  assert.equal(describeDuplicate({ lastScheduledAt: 0, lastDelayMs: 0 }, t0), null)

  // 延迟还没到点 → 在路上
  const pending = describeDuplicate(state, t0 + 1000)
  assert.deepEqual(pending, { pendingInMs: MIN_DELAY_MS - 1000, withinCooldown: false })

  // 刚好到点那一刻 → 进入静默期
  const atFire = describeDuplicate(state, t0 + MIN_DELAY_MS)
  assert.equal(atFire.withinCooldown, true)
  assert.equal(atFire.pendingInMs, COOLDOWN_MS)

  // 静默期最后 1 毫秒仍在挡
  const almost = describeDuplicate(state, t0 + MIN_DELAY_MS + COOLDOWN_MS - 1)
  assert.equal(almost.withinCooldown, true)
  assert.equal(almost.pendingInMs, 1)

  // 静默期结束 → 放行
  assert.equal(describeDuplicate(state, t0 + MIN_DELAY_MS + COOLDOWN_MS), null)
  assert.equal(describeDuplicate(state, t0 + MIN_DELAY_MS + COOLDOWN_MS + 10_000), null)

  // lastDelayMs 非法时按默认延迟算，不炸
  const fallback = describeDuplicate({ lastScheduledAt: t0, lastDelayMs: undefined }, t0 + 1)
  assert.equal(fallback.pendingInMs, DEFAULT_DELAY_MS - 1)
})

/* ------------------------------------------------------------------ */
/* 预设解析                                                             */
/* ------------------------------------------------------------------ */

test('parsePresetYml / parsePlugins：行级解析，引号被去掉，只在 id 后取第一个 name', () => {
  const preset = ["name: '@deepseek-ai/dsh-wsl-standard'", 'order: 30', 'description: "WSL 标准流程"'].join('\n')
  assert.deepEqual(parsePresetYml(preset), {
    name: '@deepseek-ai/dsh-wsl-standard',
    order: '30',
    description: 'WSL 标准流程',
  })

  const agent = [
    '- id: wsl-cordis',
    "  name: '@deepseek-ai/dsh-wsl-cordis'",
    '- id: group-a',
    '  name: cordis:group',
    '  config:',
    '    name: 显示名不该被当成包名',
    '- id: local-plugin',
    '  name: ./local.mjs',
  ].join('\n')
  const plugins = parsePlugins(agent)
  assert.deepEqual(plugins.map((plugin) => plugin.id), ['wsl-cordis', 'group-a', 'local-plugin'])
  assert.equal(plugins[0].name, '@deepseek-ai/dsh-wsl-cordis')
  // 第二条的 name 已取到 cordis:group，config 里的 name 不该覆盖它
  assert.equal(plugins[1].name, 'cordis:group')
  assert.equal(plugins[2].name, './local.mjs')
})

test('isPackageSpec：只认包名，组标记/相对路径/绝对路径都不算', () => {
  assert.equal(isPackageSpec('dsh-x'), true)
  assert.equal(isPackageSpec('@scope/pkg'), true)
  assert.equal(isPackageSpec('cordis:group'), false)
  assert.equal(isPackageSpec('./local.mjs'), false)
  assert.equal(isPackageSpec('/abs/path.mjs'), false)
  assert.equal(isPackageSpec(undefined), false)
})

test('extractAbsolutePaths：带引号与不带引号两种写法都能取到，去重，且不误收 URL', () => {
  const text = [
    'args: ["D:/proj/a.mjs"]',
    "cwd: 'C:/proj/b'",
    'entry: D:/proj/b,',
    '  again: D:/proj/b',
    'url: https://example.com/x',
  ].join('\n')
  const found = extractAbsolutePaths(text)
  assert.deepEqual(found.paths.sort(), ['C:/proj/b', 'D:/proj/a.mjs', 'D:/proj/b'])
  assert.ok(found.lines.length > 0)
  assert.ok(found.lines.length <= 5)
  // scheme 不是盘符：多字母 scheme（https/file）必须被排除，真盘符路径必须保留。
  // 已知边界（刻意不改）：单字母 scheme（`x://…`）仍会被当成盘符路径 —— 见 README 遗留说明。
  assert.deepEqual(extractAbsolutePaths('u: https://example.com/x').paths, [])
  assert.deepEqual(extractAbsolutePaths('u: x://custom/scheme').paths, ['x://custom/scheme'])
})

test('judgeLegacy：内置同名判定优先；写死路径/缺包判为 stale；其余判为 user', () => {
  const dir = tempDir('legacy')
  try {
    const presetDir = join(dir, 'wsl-standard')
    mkdirSync(presetDir, { recursive: true })
    writeFileSync(join(presetDir, 'preset.yml'), 'name: WSL\norder: 20\n', 'utf8')

    // ① 官方已内置：shipped 集合里有 preset-standard（wsl- 前缀会被剥掉）
    writeFileSync(join(presetDir, 'agent.cordis.yml'), [
      '- id: a',
      '  name: dsh-not-installed-anywhere',
    ].join('\n'), 'utf8')
    const shipped = judgeLegacy(presetDir, new Set(['preset-standard']), null)
    assert.equal(shipped.verdict, 'shipped')
    assert.equal(shipped.shippedAs, 'preset-standard')
    assert.equal(shipped.name, 'WSL')
    assert.equal(shipped.order, 20)

    // ② 未内置 + 缺包 → stale。注意：node_modules 为 null 时表示"不知道"，
    //    所以这里必须传一个真实存在、但里面没有那个包的 profile 目录。
    const profileDir = join(dir, 'profile')
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
    const stale = judgeLegacy(presetDir, new Set(), profileDir)
    assert.equal(stale.verdict, 'stale')
    assert.deepEqual(stale.missingPlugins, ['dsh-not-installed-anywhere'])

    // ③ 未内置 + 包都在 node_modules 里 → user（自建）
    mkdirSync(join(profileDir, 'node_modules', 'dsh-present'), { recursive: true })
    writeFileSync(join(presetDir, 'agent.cordis.yml'), [
      '- id: a',
      '  name: dsh-present',
      '- id: b',
      '  name: cordis:group',
    ].join('\n'), 'utf8')
    const user = judgeLegacy(presetDir, new Set(), profileDir)
    assert.equal(user.verdict, 'user')
    assert.deepEqual(user.missingPlugins, [])
    assert.deepEqual(user.builtinPlugins, ['cordis:group'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
