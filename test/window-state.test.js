/**
 * dsh-shell-kit — 壳窗口状态抓取/恢复的回归测试。
 *
 * 这里只测「脚本长什么样」和「输出怎么解析」：真正执行需要一台 Windows 桌面和一个活着的
 * 主窗口，属于人工验证范围（captureScript 已在真机上跑通，见提交说明）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SW_RESTORE,
  SW_SHOWMAXIMIZED,
  SW_SHOWMINIMIZED,
  WINDOW_STATE_VERSION,
  captureScript,
  parseCapture,
  parseRestore,
  restoreScript,
  summarizeState,
} from '../lib/modules/restart/window-state.mjs'

function capturePayload(overrides = {}) {
  return JSON.stringify({
    schema: WINDOW_STATE_VERSION,
    pid: 1304,
    showCmd: 1,
    zoomed: false,
    rect: { x: 632, y: 286, width: 1296, height: 828 },
    normal: { x: 632, y: 286, width: 1296, height: 828 },
    screen: { x: 0, y: 0, width: 2560, height: 1392 },
    ...overrides,
  })
}

/* ------------------------------------------------------------------ */
/* captureScript                                                       */
/* ------------------------------------------------------------------ */

test('captureScript：按 PID 定位窗口，并把进程名兜底写进脚本', () => {
  const script = captureScript({ pid: 1304, imageName: 'DeepSeek Harness' })
  assert.match(script, /Get-Process -Id 1304/u)
  assert.match(script, /MainWindowHandle/u)
  assert.ok(script.includes("'DeepSeek Harness'"), '进程名应作为兜底条件')
  assert.match(script, /ConvertTo-Json -Compress/u)
  assert.ok(script.includes('schema = ' + WINDOW_STATE_VERSION))
})

test('captureScript：没有 pid 时退化为按进程名，且单引号被转义成两个', () => {
  const script = captureScript({ imageName: "O'Brien" })
  assert.match(script, /Get-Process -Id 0/u)
  assert.ok(script.includes("'O''Brien'"), 'PowerShell 单引号字符串要写成两个单引号')
})

test('captureScript：既没有 pid 也没有进程名时不抛错，只是找不到窗口', () => {
  const script = captureScript()
  assert.match(script, /\$byName = @\(\)/u)
  assert.match(script, /if \(\$null -eq \$target\) \{ exit 0 \}/u)
})

/* ------------------------------------------------------------------ */
/* parseCapture                                                        */
/* ------------------------------------------------------------------ */

test('parseCapture：普通矩形被原样读出，既不是最大化也不是全屏', () => {
  const state = parseCapture(capturePayload())
  assert.deepEqual(state.rect, { x: 632, y: 286, width: 1296, height: 828 })
  assert.equal(state.maximized, false)
  assert.equal(state.fullscreen, false)
  assert.equal(state.pid, 1304)
})

test('parseCapture：showCmd=3 或 zoomed=true 都算最大化', () => {
  assert.equal(parseCapture(capturePayload({ showCmd: SW_SHOWMAXIMIZED })).maximized, true)
  assert.equal(parseCapture(capturePayload({ zoomed: true })).maximized, true)
})

test('parseCapture：铺满工作区且贴齐原点的非最大化窗口视为全屏', () => {
  const state = parseCapture(capturePayload({
    rect: { x: 0, y: 0, width: 2560, height: 1392 },
  }))
  assert.equal(state.maximized, false)
  assert.equal(state.fullscreen, true)
})

test('parseCapture：最大化外扩到屏幕外时不会被误判成全屏', () => {
  const state = parseCapture(capturePayload({
    showCmd: SW_SHOWMAXIMIZED,
    zoomed: true,
    rect: { x: -8, y: -8, width: 2576, height: 1408 },
  }))
  assert.equal(state.maximized, true)
  assert.equal(state.fullscreen, false)
})

test('parseCapture：最小化窗口用 rcNormalPosition 顶替 -32000 占位矩形', () => {
  const state = parseCapture(capturePayload({
    showCmd: SW_SHOWMINIMIZED,
    rect: { x: -32000, y: -32000, width: 160, height: 28 },
    normal: { x: 632, y: 286, width: 1296, height: 828 },
  }))
  assert.equal(state.minimized, true)
  assert.equal(state.maximized, false)
  assert.deepEqual(state.rect, { x: 632, y: 286, width: 1296, height: 828 })
})

test('parseCapture：没有 showCmd 时靠 -32000 占位坐标识别最小化', () => {
  const state = parseCapture(capturePayload({
    showCmd: 0,
    rect: { x: -32000, y: -32000, width: 160, height: 28 },
    normal: { x: 100, y: 100, width: 1280, height: 820 },
  }))
  assert.equal(state.minimized, true)
  assert.deepEqual(state.rect, { x: 100, y: 100, width: 1280, height: 820 })
})

test('parseCapture：普通窗口不会被误判成最小化', () => {
  assert.equal(parseCapture(capturePayload()).minimized, false)
})

test('parseCapture：normal 缺失时用 rect 顶上', () => {
  const state = parseCapture(capturePayload({ normal: null }))
  assert.deepEqual(state.normal, state.rect)
})

test('parseCapture：空输出、非 JSON、schema 不符、矩形非法都返回 null', () => {
  assert.equal(parseCapture(''), null)
  assert.equal(parseCapture('   '), null)
  assert.equal(parseCapture('not json at all'), null)
  assert.equal(parseCapture(capturePayload({ schema: 99 })), null)
  assert.equal(parseCapture(capturePayload({ rect: null })), null)
  assert.equal(parseCapture(capturePayload({ rect: { x: 0, y: 0, width: 0, height: 100 } })), null)
  assert.equal(parseCapture(capturePayload({ screen: null })), null)
})

test('parseCapture：stdout 里混进 warning 时取最后一段 JSON', () => {
  const noisy = 'WARNING: something\r\n' + capturePayload() + '\r\n'
  assert.equal(parseCapture(noisy).pid, 1304)
})

/* ------------------------------------------------------------------ */
/* restoreScript                                                       */
/* ------------------------------------------------------------------ */

test('restoreScript：最大化状态生成 ShowWindow(SW_SHOWMAXIMIZED)', () => {
  const script = restoreScript({ maximized: true, fullscreen: false, rect: { x: 0, y: 0, width: 1280, height: 820 } })
  assert.ok(script.includes('::ShowWindow($h, ' + SW_SHOWMAXIMIZED + ')'))
  assert.ok(!script.includes('::SetWindowPos('), '最大化不需要摆坐标')
})

test('restoreScript：真全屏降级为最大化（外部无法复原 setFullScreen）', () => {
  const script = restoreScript({ maximized: false, fullscreen: true, rect: { x: 0, y: 0, width: 2560, height: 1392 } })
  assert.ok(script.includes('::ShowWindow($h, ' + SW_SHOWMAXIMIZED + ')'))
})

test('restoreScript：普通矩形生成 SetWindowPos，坐标是整数且带 NOZORDER|NOACTIVATE', () => {
  const script = restoreScript({ maximized: false, rect: { x: 632, y: 286, width: 1296, height: 828 } })
  assert.ok(script.includes('::SetWindowPos($h, [IntPtr]::Zero, 632, 286, 1296, 828, 20)'))
})

test('restoreScript：最小化且非最大化时先 SW_RESTORE 再摆坐标', () => {
  const script = restoreScript({
    maximized: false,
    minimized: true,
    rect: { x: 632, y: 286, width: 1296, height: 828 },
  })
  const restoreAt = script.indexOf('::ShowWindow($h, ' + SW_RESTORE + ')')
  const posAt = script.indexOf('::SetWindowPos(')
  assert.ok(restoreAt > 0, '最小化窗口要先还原')
  assert.ok(posAt > restoreAt, '还原之后才摆坐标')
  assert.ok(!script.includes('::ShowWindow($h, ' + SW_SHOWMAXIMIZED + ')'))
})

test('restoreScript：非有限坐标不会渗进命令行', () => {
  const script = restoreScript({ maximized: false, rect: { x: Number.NaN, y: 0, width: 100, height: 100 } })
  assert.ok(script.includes('::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 1280, 820, 20)'), '坏矩形回落到默认几何')
})

test('restoreScript：等待秒数被夹在 1–60，并且等待循环在脚本内', () => {
  // 0/NaN 视同未提供（落到默认 20 秒），下限 1 只对真正的负数/小数生效。
  assert.ok(restoreScript({}, { waitSeconds: 0 }).includes('AddSeconds(20)'))
  assert.ok(restoreScript({}, { waitSeconds: -5 }).includes('AddSeconds(1)'))
  assert.ok(restoreScript({}, { waitSeconds: 999 }).includes('AddSeconds(60)'))
  assert.ok(restoreScript({}, { waitSeconds: 20 }).includes('Start-Sleep -Milliseconds 500'))
})

test('restoreScript：超时分支输出 applied:false reason:no-window 并以 0 退出', () => {
  const script = restoreScript({})
  assert.ok(script.includes('"applied":false'))
  assert.ok(script.includes('"reason":"no-window"'))
})

/* ------------------------------------------------------------------ */
/* parseRestore / summarizeState                                       */
/* ------------------------------------------------------------------ */

test('parseRestore：读出 applied/mode/reason', () => {
  assert.deepEqual(
    parseRestore('{"schema":1,"applied":true,"mode":"maximize"}'),
    { applied: true, mode: 'maximize', reason: null },
  )
  assert.deepEqual(
    parseRestore('{"schema":1,"applied":false,"reason":"no-window"}'),
    { applied: false, mode: null, reason: 'no-window' },
  )
})

test('parseRestore：空输出与坏 JSON 返回 null', () => {
  assert.equal(parseRestore(''), null)
  assert.equal(parseRestore('garbage'), null)
  assert.equal(parseRestore('{"applied":'), null)
})

test('summarizeState：只留白名单字段，坏输入返回 null', () => {
  const summary = summarizeState({
    maximized: true,
    minimized: false,
    fullscreen: false,
    pid: 1304,
    rect: { x: 1, y: 2, width: 300, height: 400 },
    screen: { x: 0, y: 0, width: 1920, height: 1080 },
    secret: 'drop me',
  })
  assert.deepEqual(Object.keys(summary).sort(), ['fullscreen', 'maximized', 'minimized', 'rect', 'screen'])
  assert.equal(summary.maximized, true)
  assert.equal(summary.minimized, false)
  assert.equal(summarizeState(null), null)
  assert.equal(summarizeState(undefined), null)
})