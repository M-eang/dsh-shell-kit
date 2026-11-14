/**
 * dsh-shell-kit — 共享核心与纯逻辑的回归测试。
 *
 * 只测"没有副作用、也不需要宿主"的部分：HTTP 守卫、注册状态机、尾读工具、
 * profile 的静态审计（含"覆盖行停用后不再报"这条规则）、预设文件的解析。
 * 跑法：`npm test`（等价于 `node --test test/`，无第三方依赖）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  MAX_BODY_BYTES,
  archiveReport,
  createRegistryTracker,
  fenceReason,
  httpError,
  isLoopbackRequest,
  localRoute,
  readBody,
  registerCommands,
  registerTools,
  tailBytes,
  tailLines,
} from '../lib/core.js'
import { collectProfileFindings, parsePatchRows } from '../lib/profile-audit.js'

/** 每个用例一个临时目录，结束就删。 */
function tempDir(label) {
  const dir = join(tmpdir(), `dsh-shell-kit-test-${label}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 造一个能跑 `localRoute` 的最小 ctx：register 的返回值是一个可断言的 dispose。 */
function fakeCtx() {
  const registered = []
  return {
    registered,
    webServer: {
      register(route) {
        registered.push(route)
        return () => { registered.splice(registered.indexOf(route), 1) }
      },
    },
  }
}

/** 造一个能在 for-await 里迭代出指定块的"请求体"。 */
function fakeRequest(chunks) {
  return {
    async* [Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writableEnded: false,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(text) {
      this.body = text
      this.writableEnded = true
    },
  }
}

/* ------------------------------------------------------------------ */
/* HTTP 守卫                                                            */
/* ------------------------------------------------------------------ */

test('isLoopbackRequest：只看套接字（回环直连）', () => {
  const ok4 = { socket: { remoteAddress: '127.0.0.1' }, headers: {} }
  const ok6 = { socket: { remoteAddress: '::1' }, headers: {} }
  const okMapped = { socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: {} }
  assert.equal(isLoopbackRequest(ok4), true)
  assert.equal(isLoopbackRequest(ok6), true)
  assert.equal(isLoopbackRequest(okMapped), true)

  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '10.0.0.5' }, headers: {} }), false)
  // 转发头不再由「套接字判定」负责 —— 交给 fenceReason，避免一个名字管两件事。
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { forwarded: 'for=1.2.3.4' } }), true)
})

test('fenceReason：四条规则按序判定（转发头 → 套接字 → Host → Origin）', () => {
  const loop = { socket: { remoteAddress: '127.0.0.1' }, headers: {} }
  assert.equal(fenceReason(loop), null)
  assert.equal(fenceReason({ socket: { remoteAddress: '::1' }, headers: {} }), null)
  assert.equal(fenceReason({ socket: { remoteAddress: '127.0.0.1' }, headers: { forwarded: 'for=1.2.3.4' } }), 'forwarded')
  assert.equal(fenceReason({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '1.2.3.4' } }), 'forwarded')
  assert.equal(fenceReason({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-real-ip': '1.2.3.4' } }), 'forwarded')
  assert.equal(fenceReason({ socket: { remoteAddress: '10.0.0.5' }, headers: {} }), 'socket')
  assert.equal(fenceReason({ ...loop, headers: { host: 'evil.com' } }), 'host')
  assert.equal(fenceReason({ ...loop, headers: { host: 'localhost.evil.com:19387' } }), 'host')
  assert.equal(fenceReason({ ...loop, headers: { host: 'localhost:19387' } }), null)
  assert.equal(fenceReason({ ...loop, headers: { host: '[::1]:19387' } }), null)
  assert.equal(fenceReason({ ...loop, headers: { host: 'LOCALHOST' } }), null)
  assert.equal(fenceReason({ ...loop, headers: { host: 'localhost', origin: 'https://evil.com' } }), 'origin')
  assert.equal(fenceReason({ ...loop, headers: { host: 'localhost', origin: 'http://127.0.0.1:19387' } }), null)
  assert.equal(fenceReason({ ...loop, headers: { host: 'localhost', origin: 'null' } }), 'origin')
  assert.equal(fenceReason({ ...loop, headers: { host: 'localhost', origin: 'http://localhost.evil.com' } }), 'origin')
})

test('localRoute：GET 直连放行，非回环 403，方法不符 405，POST 缺插件头 403', async () => {
  const ctx = fakeCtx()
  const dispose = localRoute(ctx, { method: 'GET', path: '/api/shell-kit/x', handler: async (req, res) => { res.end('hit') } })
  assert.equal(ctx.registered.length, 1)
  assert.equal(ctx.registered[0].kind, 'exact')
  assert.equal(ctx.registered[0].path, '/api/shell-kit/x')

  const handler = ctx.registered[0].handler

  // 放行：handler 被调用（这一条只断言"到了业务代码"——状态码 200 由 node:http 默认给，
  // 不是 handler 设置的，fake res 上不会凭空出现）
  const good = fakeResponse()
  await handler({ method: 'GET', url: '/api/shell-kit/x', socket: { remoteAddress: '127.0.0.1' }, headers: {} }, good)
  assert.equal(good.body, 'hit')
  assert.equal(good.statusCode, 0)

  const wrongMethod = fakeResponse()
  await handler({ method: 'POST', url: '/api/shell-kit/x', socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-dsh-plugin': 'shell-kit' } }, wrongMethod)
  assert.equal(wrongMethod.statusCode, 405)

  const remote = fakeResponse()
  await handler({ method: 'GET', url: '/api/shell-kit/x', socket: { remoteAddress: '192.168.1.9' }, headers: {} }, remote)
  assert.equal(remote.statusCode, 403)

  const postCtx = fakeCtx()
  localRoute(postCtx, { method: 'POST', path: '/api/shell-kit/y', handler: async (req, res) => { res.end('posted') } })
  const noHeader = fakeResponse()
  await postCtx.registered[0].handler({ method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: {} }, noHeader)
  assert.equal(noHeader.statusCode, 403)

  const withHeader = fakeResponse()
  await postCtx.registered[0].handler({ method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-dsh-plugin': 'shell-kit' } }, withHeader)
  assert.equal(withHeader.body, 'posted')

  dispose()
  assert.equal(ctx.registered.length, 0)
})

test('readBody：合法对象通过，非 JSON/数组被拒，超限抛 413 并断开连接', async () => {
  assert.deepEqual(await readBody(fakeRequest(['{"a":1}'])), { a: 1 })
  assert.deepEqual(await readBody(fakeRequest(['   '])), {})
  assert.deepEqual(await readBody(fakeRequest(['{"a":', '"b"}'])), { a: 'b' })

  await assert.rejects(() => readBody(fakeRequest(['not json'])), (error) => error.code === 'INVALID_BODY' && error.statusCode === 400)
  await assert.rejects(() => readBody(fakeRequest(['[1,2]'])), (error) => error.code === 'INVALID_BODY')

  let destroyed = false
  const oversize = {
    async* [Symbol.asyncIterator]() {
      yield Buffer.alloc(MAX_BODY_BYTES + 1)
    },
    destroy() { destroyed = true },
  }
  await assert.rejects(() => readBody(oversize), (error) => error.code === 'BODY_TOO_LARGE' && error.statusCode === 413)
  assert.equal(destroyed, true)

  // 自定义上限同样生效
  await assert.rejects(() => readBody(fakeRequest([Buffer.alloc(64)]), { maxBytes: 16 }), (error) => error.code === 'BODY_TOO_LARGE')
})

/* ------------------------------------------------------------------ */
/* 注册状态机（命令 / 工具）                                             */
/* ------------------------------------------------------------------ */

test('注册追踪：初值表达"没挂上"，注册成功后状态位翻正', () => {
  const tracker = createRegistryTracker()
  assert.deepEqual(tracker.state, { routes: 0, command: false, tool: false, toolError: '等待 tools 服务' })

  const ctx = {
    logger: { info() {}, warn() {} },
    inject(services, callback) {
      assert.deepEqual(services, ['commands'])
      callback({ commands: { register() {} } })
    },
  }
  registerCommands(ctx, { label: 'test', tracker, register: (commandCtx) => commandCtx.commands.register({ name: 'x' }) })
  assert.equal(tracker.state.command, true)
})

test('注册追踪：tools 服务不出现时 toolError 保持"等待"，注册抛错则记下原因', () => {
  const idle = createRegistryTracker()
  // inject 永不回调：等价于 tools 服务始终没出现。
  registerTools({ logger: { warn() {} }, inject() {} }, { label: 'test', tracker: idle, definition: { name: 'x' } })
  assert.equal(idle.state.tool, false)
  assert.equal(idle.state.toolError, '等待 tools 服务')

  const failing = createRegistryTracker()
  const ctx = {
    logger: { info() {}, warn() {} },
    inject(services, callback) { callback({ tools: { register() { throw new Error('已存在同名工具') } } }) },
  }
  registerTools(ctx, { label: 'test', tracker: failing, definition: { name: 'x' } })
  assert.equal(failing.state.tool, false)
  assert.match(failing.state.toolError, /已存在同名工具/)
})

/* ------------------------------------------------------------------ */
/* 尾读工具                                                             */
/* ------------------------------------------------------------------ */

test('tailBytes：只读末尾一段、可丢弃被截断的首行，读失败返回 null', () => {
  const dir = tempDir('tail')
  try {
    const file = join(dir, 'a.log')
    writeFileSync(file, 'l1\nl2\nl3\nl4\nl5\n', 'utf8')
    assert.equal(tailBytes(file), 'l1\nl2\nl3\nl4\nl5\n')
    assert.equal(tailBytes(file, { maxBytes: 6 }), 'l4\nl5\n')
    // 从行中间截断时首行不完整（"\nl4\nl5\n"），dropFirstLine 把它去掉
    assert.equal(tailBytes(file, { maxBytes: 7 }), '\nl4\nl5\n')
    assert.equal(tailBytes(file, { maxBytes: 7, dropFirstLine: true }), 'l4\nl5\n')
    assert.equal(tailBytes(file, { maxBytes: 8, dropFirstLine: true }), 'l4\nl5\n')
    assert.equal(tailBytes(join(dir, 'missing.log')), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tailLines：跳过空行并取最后 N 行，文件不存在返回空数组', () => {
  const dir = tempDir('lines')
  try {
    const file = join(dir, 'a.log')
    writeFileSync(file, 'a\n\nb\nc\n', 'utf8')
    assert.deepEqual(tailLines(file, 2), ['b', 'c'])
    assert.deepEqual(tailLines(join(dir, 'missing.log')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* 重启报告的留档                                                       */
/* ------------------------------------------------------------------ */

test('archiveReport：留档是拷贝，原件必须留在原位（否则界面永远「无记录」）', () => {
  const dir = tempDir('report')
  try {
    const paths = { report: join(dir, 'last-report.json'), reports: join(dir, 'reports') }
    const report = { phase: 'finished', outcome: 'ok', at: '2026-10-17T02:47:20.102Z', elapsedMs: 6643 }
    writeFileSync(paths.report, JSON.stringify(report), 'utf8')

    const archived = archiveReport(paths)
    assert.ok(archived !== null, '已结算的报告要留档')
    assert.equal(readFileSync(archived, 'utf8'), readFileSync(paths.report, 'utf8'), '留档内容与原件一致')
    assert.ok(existsSync(paths.report), '原件不能被挪走：status.lastReport 还要读它')
    assert.equal(JSON.parse(readFileSync(paths.report, 'utf8')).outcome, 'ok')

    // 重复挂载不产生重复文件（同一份报告 → 同一个文件名）。
    assert.equal(archiveReport(paths), archived)
    assert.equal(readdirSync(paths.reports).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('archiveReport：没结算（killing 阶段）的报告不留档，没有报告时返回 null', () => {
  const dir = tempDir('report-pending')
  try {
    const paths = { report: join(dir, 'last-report.json'), reports: join(dir, 'reports') }
    assert.equal(archiveReport(paths), null, '文件不存在时不报错')

    writeFileSync(paths.report, JSON.stringify({ phase: 'killing' }), 'utf8')
    assert.equal(archiveReport(paths), null, 'killing 阶段没有 outcome，留档没有意义')
    assert.equal(existsSync(paths.reports), false, '不应凭空建出 reports 目录')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* profile 静态审计                                                     */
/* ------------------------------------------------------------------ */

test('parsePatchRows：只认顶层与 insert 块内的 - id:，跳过配置数据里的同形行', () => {
  const yaml = [
    '# 注释行',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    '    providers:',
    '      workbuddy:',
    '        models:',
    '          - id: deepseek-v4.1-flash',
    '            name: Deepseek-V4.1-Flash',
    '- insert:',
    '    - id: shell-kit',
    '      name: dsh-shell-kit',
    '    - id: broken-entry',
    '      name: "not-a-package # 注释粘上来了"',
    '- id: shell-kit',
    '  disabled: true',
  ].join('\n')
  const { rows } = parsePatchRows(yaml)
  const ids = rows.map((row) => row.id)
  assert.deepEqual(ids, ['agent-default-model', 'shell-kit', 'broken-entry', 'shell-kit'])
  // 模型名不能被当成包名
  assert.equal(rows.some((row) => row.name === 'Deepseek-V4.1-Flash'), false)
  assert.equal(rows[1].name, 'dsh-shell-kit')
  assert.equal(rows[1].insert, true)
  assert.equal(rows[0].insert, false)
  assert.equal(rows[3].disabled, 'true')
})

test('collectProfileFindings：覆盖行停用后不再报错，真正坏掉的条目会被点名', () => {
  const dir = tempDir('audit')
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { 'gone-pkg': 'link:D:/definitely/not/here' },
      dsh: { profile: { bundles: ['never-installed-bundle'] } },
    }), 'utf8')
    writeFileSync(join(dir, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: bad-name',
      '      name: "dsh-x dsh-y"',
      '    - id: quoted-name',
      '      name: "dsh-quoted" # 行尾注释会被剥掉，这样的 name 是合法的',
      '    - id: missing-pkg',
      '      name: dsh-not-installed',
      '    - id: disabled-entry',
      '      name: also-not-installed',
      '- id: disabled-entry',
      '  disabled: true',
    ].join('\n'), 'utf8')
    // 把"合法但没装"的包先造出来，这样这个用例只考察 name 合法性与覆盖行语义
    for (const name of ['dsh-quoted', 'dsh-not-installed', 'also-not-installed']) {
      mkdirSync(join(dir, 'node_modules', name), { recursive: true })
    }

    const { findings } = collectProfileFindings(dir)
    const codes = findings.map((finding) => finding.code)
    assert.ok(codes.includes('bad-package-name'), `期望 bad-package-name，实际：${codes.join(', ')}`)
    assert.ok(codes.includes('broken-link'))
    assert.ok(codes.includes('bundle-missing'))
    // 只有 bad-name 被判 name 非法；行尾注释只是注释，quoted-name 的 name 是合法的
    assert.deepEqual(findings.filter((finding) => finding.code === 'bad-package-name').map((finding) => finding.id), ['bad-name'])
    // 覆盖行停用的那条不该再报
    assert.equal(findings.some((finding) => finding.id === 'disabled-entry'), false)
    // 每条都带证据（patch 行给 文件:行号）
    for (const finding of findings) {
      if (finding.code === 'broken-link' || finding.code === 'bundle-missing') continue
      assert.match(String(finding.evidence), /^cordis\.patch\.yml:\d+$/u)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('collectProfileFindings：package.json 读不出来时报 manifest-unreadable 并提前收尾', () => {
  const dir = tempDir('audit-bad-manifest')
  try {
    writeFileSync(join(dir, 'package.json'), '{ not json', 'utf8')
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: x\n  name: dsh-x\n', 'utf8')
    const { findings } = collectProfileFindings(dir)
    assert.equal(findings.some((finding) => finding.code === 'manifest-unreadable'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* 其它纯逻辑                                                           */
/* ------------------------------------------------------------------ */

test('httpError / createRegistryTracker：错误形状与状态字段稳定', () => {
  const error = httpError(409, 'PLUGIN_OPERATION', 'busy')
  assert.equal(error.statusCode, 409)
  assert.equal(error.code, 'PLUGIN_OPERATION')
  assert.equal(error.message, 'busy')
  assert.ok(error instanceof Error)
})

test('logs 落盘：多字节内容按字节写盘，不产生替换字符', async () => {
  const home = tempDir('logs-home')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { mount } = await import('../lib/modules/logs/index.js')
    let captured = null
    const ctx = {
      logger: { info() {}, warn() {}, error() {}, exporter(exporter) { captured = exporter; return () => {} } },
      webServer: { register() { return () => {} } },
      inject() {},
    }
    // captureStdio: false → 只走 exporter 这条写入路径，正是本轮改动的地方
    const handle = mount(ctx, { config: { captureStdio: false } })
    const line = '多字节中文：exporter 记录 🚀'
    captured.export({ ts: Date.now(), type: 'info', name: 'test', args: [line] })
    handle.dispose()

    const dir = join(home, 'dsh-shell-kit', 'logs')
    const files = readdirSync(dir)
    assert.equal(files.length, 1)
    const text = readFileSync(join(dir, files[0]), 'utf8')
    assert.ok(text.includes(line), '中文与 emoji 必须完整落盘')
    assert.equal((text.match(/\uFFFD/gu) ?? []).length, 0, '不应出现 UTF-8 替换字符')
    assert.equal(handle.status().writeError, null)
    assert.equal(handle.status().droppedBytes, 0)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})
