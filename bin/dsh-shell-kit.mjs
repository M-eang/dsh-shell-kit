#!/usr/bin/env node
/**
 * dsh-shell-kit 的独立命令行入口。
 *
 * 用途：不开界面、也不进会话就能看状态或重启 —— 例如在终端里：
 *   node bin/dsh-shell-kit.mjs --status
 *   node bin/dsh-shell-kit.mjs --restart --by cli
 *
 * 它只是本插件 HTTP 路由的瘦客户端（回环、无需认证，只带 x-dsh-plugin 头），
 * 因此 Node 版本、DSH_HOME 与 profile 都无关，只要能连上端口就行。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PLUGIN_HEADER = 'x-dsh-plugin'
const PLUGIN_HEADER_VALUE = 'shell-kit'
/** 本插件自己的标识（用来确认端口上那个服务真的是 dsh-shell-kit）。 */
const PLUGIN_ID = 'dsh-shell-kit'
const DEFAULT_PORTS = [19387, 3000]
/** --wait 的默认上限：等应用回来最多这么久。 */
const DEFAULT_WAIT_SECONDS = 180

function parseArgs(argv) {
  const options = { status: false, restart: false, force: false, graceful: false, delayMs: undefined, port: undefined, by: 'cli', json: false, waitSeconds: 0, dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    switch (token) {
      case '--status': options.status = true; break
      case '--restart': options.restart = true; break
      case '--force': options.force = true; break
      case '--dry-run': options.dryRun = true; break
      case '--wait': options.waitSeconds = DEFAULT_WAIT_SECONDS; break
      case '--wait-seconds': options.waitSeconds = Number(argv[++index]); break
      case '--hard': options.graceful = false; break
      case '--graceful': options.graceful = true; break
      case '--json': options.json = true; break
      case '--delay':
      case '--delay-ms': options.delayMs = Number(argv[++index]); break
      case '--port': options.port = Number(argv[++index]); break
      case '--by': options.by = String(argv[++index] ?? 'cli'); break
      case '--help':
      case '-h': options.help = true; break
      default:
        if (token.startsWith('--delay=')) options.delayMs = Number(token.slice(8))
        else if (token.startsWith('--port=')) options.port = Number(token.slice(7))
        else if (token.startsWith('--by=')) options.by = token.slice(5)
        else if (token !== '') console.error(`未知参数：${token}`)
    }
  }
  return options
}

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** 端口来源：--port > 上次意图/报告文件 > 默认候选。 */
function candidatePorts(explicit) {
  const ports = []
  if (Number.isInteger(explicit) && explicit > 0) ports.push(explicit)
  const dir = join(dshHome(), 'dsh-shell-kit', 'restart')
  for (const name of ['last-intent.json', 'last-report.json']) {
    try {
      const value = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      if (Number.isInteger(value?.port) && value.port > 0) ports.push(value.port)
    } catch { /* 文件不存在或还没写过 */ }
  }
  ports.push(...DEFAULT_PORTS)
  return [...new Set(ports)]
}

async function call(port, path, init) {
  const response = await fetch(`http://127.0.0.1:${port}/api/shell-kit/restart${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', [PLUGIN_HEADER]: PLUGIN_HEADER_VALUE, ...(init?.headers ?? {}) },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload?.error?.message ?? `HTTP ${response.status}`)
    error.code = payload?.error?.code
    throw error
  }
  return payload.data
}

/**
 * 确认端口上那个服务真的是本插件。
 *
 * 端口候选里有可能坐着别的服务（默认列表里就有 3000）：对方返回 200 + 任意 JSON 时，
 * 不校验的话 --status 会打印一堆 undefined、--restart 会往一个无关服务发 POST。
 * 这里用一个专用错误码表示"这个端口不是 shell-kit"，让 withPort 继续试下一个；
 * 服务端明确拒绝（带 code）则照旧立刻停手 —— 换端口也没用。
 */
function assertShellKit(port, data) {
  const looksLikeShellKit = data !== null && typeof data === 'object'
    && (data.plugin === PLUGIN_ID || typeof data.delayMs === 'number' || data.scheduled === true)
  if (!looksLikeShellKit) {
    const error = new Error(`端口 ${port} 上的服务不是 ${PLUGIN_ID}`)
    error.code = 'NOT_SHELL_KIT'
    throw error
  }
  return data
}

/**
 * 依次试候选端口。
 * @param {number[]} ports 候选端口（显式 --port 会排在最前面）
 * @param {(port: number) => Promise<any>} run
 * @param {number|undefined} explicit 用户显式指定的端口：给了它就只试它，不回落到别的实例
 */
async function withPort(ports, run, explicit = undefined) {
  let lastError
  const hasExplicit = Number.isInteger(explicit) && explicit > 0 && ports.includes(explicit)
  for (const port of ports) {
    // 显式指定了端口就别"猜"：否则 --port 指到一个无关服务上时，
    // 会静默地回落到 19387 上另一个实例，命令看起来"成功"但操作的不是你要的那个。
    if (hasExplicit && port !== explicit) break
    try {
      return await run(port)
    } catch (error) {
      lastError = error
      // 服务端明确拒绝：换端口也没用；"这个端口不是本插件"：换下一个。
      if (error?.code !== undefined && error.code !== 'NOT_SHELL_KIT') throw error
      if (hasExplicit) {
        throw new Error(`指定的端口 ${explicit} 上没有 ${PLUGIN_ID} 在跑：${error?.message ?? String(error)}`)
      }
    }
  }
  throw lastError ?? new Error('没有找到正在运行的 DSH 实例（端口都不通）')
}

function usage() {
  console.log(`dsh-shell-kit CLI

  --status              读取宿主状态（能不能重启、上次结果、待重启插件、日志尾部）
  --restart             安排一次重启
  --force               跳过插件操作与静默期检查
  --hard                不做优雅退出尝试，直接强杀
  --delay <ms>          延迟毫秒数（默认 1200；命令/工具路径默认 2500，下限 3000）
  --dry-run             只打印将要请求的地址与参数，不发请求
  --wait                排完就等应用回来（默认最多 ${DEFAULT_WAIT_SECONDS} 秒），回来后退出 0
  --wait-seconds <n>    自定义 --wait 的上限秒数
  --port <port>         DSH 监听端口（默认自动探测，常见 19387；指定后不再回落到别的端口）
  --by <label>          记录发起者（默认 cli）
  --json                原样输出 JSON
  -h, --help            显示本帮助

注意：--wait 只有在 CLI 进程**不在** DSH 的进程树里时才有意义（例如你从终端跑）。
如果它是由 DSH 自己拉起来的，应用一重启它也会跟着被杀。
`)
}

const options = parseArgs(process.argv.slice(2))
if (options.help || (!options.status && !options.restart)) {
  usage()
  process.exit(options.help ? 0 : 1)
}

const ports = candidatePorts(options.port)

try {
  if (options.status) {
    const data = await withPort(ports, async (port) => assertShellKit(port, await call(port, '/status')), options.port)
    if (options.json) console.log(JSON.stringify(data, null, 2))
    else {
      console.log(`插件版本：${data.plugin} v${data.version}`)
      console.log(`可重启：${data.supported ? '是' : '否'}${data.supported ? '' : `（${(data.reasons ?? []).join('；')}）`}`)
      console.log(`宿主：壳 pid ${data.shellPid} · Host pid ${data.hostPid} · 端口 ${data.port}`)
      console.log(`可执行文件：${data.exe}`)
      if (data.lastReport) {
        console.log(`上次重启：${data.lastReport.outcome}（${data.lastReport.elapsedMs}ms，${data.lastReport.at}）`)
      } else {
        console.log('上次重启：无记录')
      }
      if (data.pluginOperation?.busy) {
        console.log(`插件操作：进行中 —— ${data.pluginOperation.hits.map((hit) => hit.detail).join('；')}`)
      }
    }
  }

  if (options.restart) {
    const body = { by: options.by, force: options.force === true, graceful: options.graceful === true }
    if (Number.isFinite(options.delayMs)) body.delayMs = options.delayMs
    if (options.dryRun) {
      console.log(`[dry-run] POST http://127.0.0.1:<port>/api/shell-kit/restart body=${JSON.stringify(body)}`)
      console.log('（未发出请求。去掉 --dry-run 才会真的排定重启。）')
      process.exit(0)
    }
    const data = await withPort(ports, async (port) => assertShellKit(port, await call(port, '', { method: 'POST', body: JSON.stringify(body) })), options.port)
    if (options.json) console.log(JSON.stringify(data, null, 2))
    else console.log(data.message ?? `已安排重启（${data.delayMs}ms 后）`)

    if (options.waitSeconds > 0) {
      const deadline = Date.now() + options.waitSeconds * 1000
      console.log(`等待应用回来（最多 ${options.waitSeconds} 秒）…`)
      let back = false
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        try {
          await withPort(ports, (port) => call(port, '/status'))
          back = true
          break
        } catch {
          // 还没回来，继续等
        }
      }
      if (!back) {
        console.error(`错误：等待 ${options.waitSeconds} 秒后应用仍没有响应`)
        process.exit(3)
      }
      console.log('应用已经回来。')
    }
  }
} catch (error) {
  console.error(`错误：${error?.message ?? String(error)}`)
  process.exit(2)
}
