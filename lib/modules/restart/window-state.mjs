/**
 * dsh-shell-kit — 壳主窗口显示状态的抓取与恢复（Windows / user32）。
 *
 * 为什么需要它：宿主自己不持久化窗口几何 —— D:\DeepSeek Harness\resources\app\lib\main.js
 * 的 createWindow() 把窗口写死成 1280×820，既没有 bounds 存档也没有 isMaximized()/
 * setFullScreen() 的恢复分支（全仓库只有 desktop/settings.json 这类偏好文件，没有窗口状态）。
 * 于是每次重启后窗口都回到普通大小，用户得自己再最大化一次。插件既然是重启的发起方，
 * 就把这件事补上：杀壳之前用 GetWindowPlacement 记下 showCmd + 矩形，壳重新起来之后
 * 用 ShowWindow / SetWindowPos 摆回去。
 *
 * 为什么是外部 Win32 而不是改壳：壳在 resources\app 下，每次 DeepSeek 更新都会覆盖；
 * 而 PowerShell 是 Windows 自带的，零新增依赖、不动宿主文件，随插件一起发布。
 *
 * 本文件不 import 仓库内任何模块：它会被 stageHelperBundle 原样拷进暂存目录，
 * 供独立的助手进程直接使用（见 engine.js 的 stageHelperBundle）。
 */

/** 状态文件的 schema 版本；解析时不匹配一律当「没有状态」，宁可不动窗口也不要乱摆。 */
export const WINDOW_STATE_VERSION = 1

/** SW_SHOWMAXIMIZED：任务栏「最大化」对应的 showCmd，也是 GetWindowPlacement 的常见返回值。 */
export const SW_SHOWMAXIMIZED = 3
/** SW_SHOWMINIMIZED：窗口被最小化时的 showCmd。 */
export const SW_SHOWMINIMIZED = 2
/** SW_RESTORE：把最小化/最大化窗口还原成普通窗口。 */
export const SW_RESTORE = 9
/** 最小化窗口的 GetWindowRect 会返回这个量级的占位坐标（屏幕外），不是真位置。 */
const HIDDEN_ORIGIN = -30000
/** SWP_NOZORDER | SWP_NOACTIVATE：只挪位置和大小，不改 z 序、不抢焦点。 */
const SETWINDOWPOS_FLAGS = 0x0014

/**
 * 抓取与恢复共用的 P/Invoke 源码。
 * 两个脚本各带一份：它们在不同时刻、不同进程里跑，没有复用编译结果的机会。
 */
export const WINDOW_API_SOURCE = [
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class DshShellKitWindow {',
  '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT {',
  '    public int length; public int flags; public int showCmd;',
  '    public POINT ptMinPosition; public POINT ptMaxPosition; public RECT rcNormalPosition;',
  '  }',
  '  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT p);',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
  '  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);',
  '  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);',
  '}',
].join('\n')

/** PowerShell 单引号字符串：内部的 ' 写成 '' 即可原样传递。 */
function psQuote(value) {
  return "'" + String(value).replace(/'/gu, "''") + "'"
}

/** 只接受有限数值；其余一律 null（让调用方决定回退，而不是把 NaN 写进命令行）。 */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null
}

/**
 * 定位主窗口的 PowerShell 片段：先按 PID（最精确），再按进程名兜底。
 * 进程名来自壳自己（facts.exe 的 basename，去掉 .exe），只用于「PID 已经不对」的场景。
 * @param {{ pid?: number, imageName?: string }} target
 * @returns {string}
 */
function findWindowBlock(target) {
  const pid = Number.isSafeInteger(target?.pid) && target.pid > 0 ? String(target.pid) : '0'
  const name = typeof target?.imageName === 'string' && target.imageName !== '' ? psQuote(target.imageName) : ''
  return [
    '$target = $null',
    '$byId = Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue',
    'if ($null -ne $byId -and $byId.MainWindowHandle -ne [IntPtr]::Zero) { $target = $byId }',
    'if ($null -eq $target) {',
    name === ''
      ? '  $byName = @()'
      : '  $byName = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.ProcessName -eq ' + name + ' })',
    '  if ($byName.Count -gt 0) { $target = $byName[0] }',
    '}',
  ].join('\r\n')
}

/** 每个脚本都要的那几行：错误策略、编译 P/Invoke、加载 Windows.Forms 取屏幕尺寸。 */
function prologue() {
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    "Add-Type -TypeDefinition @'",
    WINDOW_API_SOURCE,
    "'@",
  ].join('\r\n')
}

/**
 * 抓取脚本：输出一行 JSON（schema/pid/showCmd/zoomed/rect/normal/screen）。
 *
 * 拿不到窗口时**不写任何输出**并以 0 退出 —— 「没有窗口」是正常情况（比如壳刚启动），
 * 不是错误，宿主侧按「没有状态」处理即可，不需要为它写一条错误日志。
 * @param {{ pid?: number, imageName?: string }} [target]
 * @returns {string} PowerShell 脚本
 */
export function captureScript(target = {}) {
  return [
    prologue(),
    findWindowBlock(target),
    'if ($null -eq $target) { exit 0 }',
    '$h = $target.MainWindowHandle',
    '$wp = New-Object DshShellKitWindow+WINDOWPLACEMENT',
    '$wp.length = [System.Runtime.InteropServices.Marshal]::SizeOf($wp)',
    '[void][DshShellKitWindow]::GetWindowPlacement($h, [ref]$wp)',
    '$r = New-Object DshShellKitWindow+RECT',
    '[void][DshShellKitWindow]::GetWindowRect($h, [ref]$r)',
    '$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea',
    '$payload = [ordered]@{',
    '  schema = ' + WINDOW_STATE_VERSION,
    '  pid = [int]$target.Id',
    '  showCmd = [int]$wp.showCmd',
    '  zoomed = [bool][DshShellKitWindow]::IsZoomed($h)',
    '  rect = [ordered]@{ x = [int]$r.Left; y = [int]$r.Top; width = [int]($r.Right - $r.Left); height = [int]($r.Bottom - $r.Top) }',
    '  normal = [ordered]@{ x = [int]$wp.rcNormalPosition.Left; y = [int]$wp.rcNormalPosition.Top; width = [int]($wp.rcNormalPosition.Right - $wp.rcNormalPosition.Left); height = [int]($wp.rcNormalPosition.Bottom - $wp.rcNormalPosition.Top) }',
    '  screen = [ordered]@{ width = [int]$wa.Width; height = [int]$wa.Height; x = [int]$wa.X; y = [int]$wa.Y }',
    '}',
    '$payload | ConvertTo-Json -Compress -Depth 4',
  ].join('\r\n')
}

/** 矩形校验：四个字段都必须是有限整数且宽高为正，否则整个矩形作废。 */
function normalizeRect(value) {
  if (value === null || typeof value !== 'object') return null
  const x = finite(value.x ?? 0)
  const y = finite(value.y ?? 0)
  const width = finite(value.width)
  const height = finite(value.height)
  if (x === null || y === null || width === null || height === null) return null
  if (width <= 0 || height <= 0) return null
  return { x: x, y: y, width: width, height: height }
}

/**
 * 把 captureScript 的输出解析成结构化状态；任何异常都返回 null。
 * @param {string} text
 * @returns {{schema: number, pid: number, showCmd: number, zoomed: boolean, maximized: boolean, fullscreen: boolean, rect: object, normal: object, screen: object}|null}
 */
export function parseCapture(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  // ConvertTo-Json 只写一行，但 stdout 里可能混进 Add-Type 的 warning，取最后一段 JSON。
  const line = raw.split(/\r?\n/u).map((item) => item.trim()).filter((item) => item.startsWith('{')).pop()
  if (line === undefined) return null
  let value
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object') return null
  if (value.schema !== WINDOW_STATE_VERSION) return null
  const windowRect = normalizeRect(value.rect)
  const normal = normalizeRect(value.normal)
  const screen = normalizeRect(value.screen)
  if (windowRect === null || screen === null) return null
  const maximized = value.showCmd === SW_SHOWMAXIMIZED || value.zoomed === true
  // 最小化时 GetWindowRect 给的是 -32000 的占位矩形（窗口仍然「可见」，只是被挪到屏幕外），
  // 直接拿它摆回去等于把窗口丢出屏幕；真正要还原的是 GetWindowPlacement 的 rcNormalPosition。
  const minimized = !maximized
    && (value.showCmd === SW_SHOWMINIMIZED || windowRect.x <= HIDDEN_ORIGIN || windowRect.y <= HIDDEN_ORIGIN)
  const rect = minimized ? (normal ?? windowRect) : windowRect
  // 真全屏（Electron setFullScreen）的特征：矩形与工作区吻合且贴齐工作区原点；
  // 而 Windows 的「最大化」会把窗口外扩到 -8,-8，比屏幕还大一圈，两者不会混淆。
  const fullscreen = !maximized
    && rect.width >= screen.width - 2
    && rect.height >= screen.height - 2
    && rect.x <= screen.x + 2
    && rect.y <= screen.y + 2
  return {
    schema: WINDOW_STATE_VERSION,
    pid: Number.isSafeInteger(value.pid) ? value.pid : 0,
    showCmd: Number.isSafeInteger(value.showCmd) ? value.showCmd : 0,
    zoomed: value.zoomed === true,
    maximized: maximized,
    minimized: minimized,
    fullscreen: fullscreen,
    rect: rect,
    normal: normal ?? rect,
    screen: screen,
  }
}

/**
 * 恢复脚本：先把窗口等出来（最多 waitSeconds），再按记下的状态摆回去。
 *
 * 等待放在 PowerShell 里而不是 Node 侧循环：一次 Add-Type 编译要 0.5–1 秒，
 * 在助手那边重试 20 次就是 20 秒的纯开销；这里只起一个进程，内部每 500ms 探一次。
 * @param {object} state parseCapture 的结果
 * @param {{ pid?: number, imageName?: string, waitSeconds?: number }} [target]
 * @returns {string} PowerShell 脚本
 */
export function restoreScript(state, target = {}) {
  const waitSeconds = Math.max(1, Math.min(60, Math.round(Number(target.waitSeconds) || 20)))
  const rect = normalizeRect(state?.rect) ?? { x: 0, y: 0, width: 1280, height: 820 }
  // 真全屏没法从外部复原成 Electron 的 setFullScreen（那是主进程内部状态），
  // 退化成「铺满工作区 + 最大化」——像素上等价，标题栏会留着。这是有意的降级。
  const maximize = state?.maximized === true || state?.fullscreen === true
  // 记录时窗口是最小化的：SetWindowPos 对最小化窗口不生效，必须先 SW_RESTORE 还原，
  // 再按记录的矩形摆位置，否则窗口会留在任务栏缩着。
  const restoreFirst = !maximize && state?.minimized === true
  const mode = maximize ? 'maximize' : 'bounds'
  const applyLines = []
  if (maximize) {
    applyLines.push('[void][DshShellKitWindow]::ShowWindow($h, ' + SW_SHOWMAXIMIZED + ')')
  } else {
    if (restoreFirst) applyLines.push('[void][DshShellKitWindow]::ShowWindow($h, ' + SW_RESTORE + ')')
    applyLines.push('[void][DshShellKitWindow]::SetWindowPos($h, [IntPtr]::Zero, ' + rect.x + ', ' + rect.y + ', ' + rect.width + ', ' + rect.height + ', ' + SETWINDOWPOS_FLAGS + ')')
  }
  const apply = applyLines.join('\r\n')
  return [
    prologue(),
    '$deadline = (Get-Date).AddSeconds(' + waitSeconds + ')',
    '$target = $null',
    'while ($true) {',
    findWindowBlock(target).split('\r\n').map((line) => '  ' + line).join('\r\n'),
    '  if ($null -ne $target) { break }',
    '  if ((Get-Date) -gt $deadline) {',
    '    Write-Output ' + JSON.stringify(JSON.stringify({ schema: WINDOW_STATE_VERSION, applied: false, reason: 'no-window' })).replace(/^"|"$/gu, "'").replace(/\\"/gu, '"'),
    '    exit 0',
    '  }',
    '  Start-Sleep -Milliseconds 500',
    '}',
    '$h = $target.MainWindowHandle',
    apply,
    'Write-Output ' + JSON.stringify(JSON.stringify({ schema: WINDOW_STATE_VERSION, applied: true, mode: mode, restored: restoreFirst })).replace(/^"|"$/gu, "'").replace(/\\"/gu, '"'),
  ].join('\r\n')
}

/**
 * 解析恢复脚本的输出：{applied, mode, reason}；解析不了返回 null。
 * @param {string} text
 */
export function parseRestore(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  const line = raw.split(/\r?\n/u).map((item) => item.trim()).filter((item) => item.startsWith('{')).pop()
  if (line === undefined) return null
  try {
    const value = JSON.parse(line)
    if (value === null || typeof value !== 'object') return null
    return {
      applied: value.applied === true,
      mode: typeof value.mode === 'string' ? value.mode : null,
      reason: typeof value.reason === 'string' ? value.reason : null,
    }
  } catch {
    return null
  }
}

/** 把状态压成可写进 intent/report 的紧凑摘要。 */
export function summarizeState(state) {
  if (state === null || typeof state !== 'object') return null
  return {
    maximized: state.maximized === true,
    minimized: state.minimized === true,
    fullscreen: state.fullscreen === true,
    rect: normalizeRect(state.rect),
    screen: normalizeRect(state.screen),
  }
}
