/**
 * logs 模块的实时流端点 `GET /api/shell-kit/logs/stream` 的用例。
 *
 * 不启真服务器：mount 时替换 ctx.webServer.register 把路由注册收下来，
 * 再用假 req/res 直接驱动 handler，之后从 exporter 写日志、等一个 tick，看帧到不到。
 *
 * 跑法：`node --test test/logs-stream.test.js`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`))
}

function fakeRes() {
  const state = { status: 0, headers: {}, chunks: [], ended: false, listeners: { close: new Set(), drain: new Set() } }
  const res = {
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) {
      state.status = status
      Object.assign(state.headers, headers)
    },
    write(chunk) {
      state.chunks.push(String(chunk))
      return true
    },
    end(chunk) {
      if (chunk !== undefined) state.chunks.push(String(chunk))
      res.writableEnded = true
      state.ended = true
    },
    once(event, listener) {
      state.listeners[event]?.add(listener)
      return res
    },
    off(event, listener) {
      state.listeners[event]?.delete(listener)
      return res
    },
    emit(event) {
      for (const listener of [...(state.listeners[event] ?? [])]) listener()
    },
    listenerCount(event) {
      return state.listeners[event]?.size ?? 0
    },
    body() {
      return state.chunks.join('')
    },
  }
  return { state, res }
}

/** 起一个 logs 模块（不落 stdio），返回路由表、exporter 与句柄。 */
async function mountLogs(home) {
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const { mount } = await import('../lib/modules/logs/index.js')
  const routes = []
  let exporter = null
  const ctx = {
    logger: {
      info() {},
      warn() {},
      error() {},
      exporter(value) {
        exporter = value
        return () => {
          exporter = null
        }
      },
    },
    webServer: {
      register(registration) {
        routes.push(registration)
        return () => {}
      },
    },
    inject() {},
  }
  const handle = mount(ctx, { config: { captureStdio: false } })
  return {
    handle,
    routes,
    grabExporter() {
      assert.ok(exporter, 'exporter 未注册')
      return exporter
    },
    export(record) {
      assert.ok(exporter, 'exporter 未注册')
      exporter.export(record)
    },
    restore() {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    },
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('logs/stream：开流帧 + 之后新写入的行按 event: line 推给客户端', async () => {
  const home = tempDir('logs-stream')
  const mounted = await mountLogs(home)
  try {
    const route = mounted.routes.find((registration) => String(registration.path).endsWith('/logs/stream'))
    assert.ok(route, '必须注册了 logs/stream 路由')

    // 默认 from=now：开流之前已经落盘的不推（首 tick 会先 flush sink，这行因此在决定偏移前已在盘上）
    mounted.export({ ts: Date.now(), type: 'info', name: 'test', args: ['开流之前'] })

    const { state, res } = fakeRes()
    await route.handler(
      {
        method: 'GET',
        url: `${route.path}?intervalMs=200`,
        socket: { remoteAddress: '127.0.0.1' },
        headers: { host: 'localhost:19387' },
      },
      res,
    )

    assert.equal(state.status, 200)
    assert.equal(state.headers['content-type'], 'text/event-stream; charset=utf-8')
    assert.equal(res.body().startsWith(': open\n\n'), true, '先冲一帧注释让客户端立刻拿到响应头')

    await wait(500)
    assert.equal(res.body().includes('开流之前'), false, '默认不重放历史')

    // 开流之后写入的必须到
    const line = '实时流第一行：中文与 emoji 🚀'
    mounted.export({ ts: Date.now(), type: 'info', name: 'test', args: [line] })
    await wait(500)
    assert.equal(res.body().includes('event: line'), true, res.body())
    assert.equal(res.body().includes(line), true, '中文与 emoji 必须完整送达')
    assert.equal((res.body().match(/\uFFFD/gu) ?? []).length, 0, '不应出现 UTF-8 替换字符')

    // 客户端断开之后：定时器停掉，再写日志也不再产生帧
    res.emit('close')
    const frames = state.chunks.length
    mounted.export({ ts: Date.now(), type: 'info', name: 'test', args: ['断开之后不该出现'] })
    await wait(500)
    assert.equal(state.chunks.length, frames)
    assert.equal(res.body().includes('断开之后不该出现'), false)
  } finally {
    mounted.handle.dispose()
    mounted.restore()
    rmSync(home, { recursive: true, force: true })
  }
})

test('logs/stream?from=begin：先把已有内容推完再跟新行', async () => {
  const home = tempDir('logs-stream-begin')
  const mounted = await mountLogs(home)
  try {
    const route = mounted.routes.find((registration) => String(registration.path).endsWith('/logs/stream'))
    assert.ok(route)

    // 开流之前先落一行（handler 首次 tick 会 flush sink，这行在决定偏移前已经在盘上）
    mounted.export({ ts: Date.now(), type: 'info', name: 'test', args: ['历史里的一行'] })

    const { state, res } = fakeRes()
    await route.handler(
      {
        method: 'GET',
        url: `${route.path}?from=begin&intervalMs=200`,
        socket: { remoteAddress: '127.0.0.1' },
        headers: { host: 'localhost:19387' },
      },
      res,
    )
    await wait(400)
    assert.equal(res.body().includes('历史里的一行'), true, `from=begin 要重放历史：${res.body()}`)

    mounted.export({ ts: Date.now(), type: 'info', name: 'test', args: ['新的一行'] })
    await wait(500)
    assert.equal(res.body().includes('新的一行'), true)
    // 历史只推一次，不因为下一轮 tick 重复推
    const first = res.body().split('历史里的一行').length - 1
    await wait(400)
    assert.equal(res.body().split('历史里的一行').length - 1, first, '历史行不能重复推')
  } finally {
    mounted.handle.dispose()
    mounted.restore()
    rmSync(home, { recursive: true, force: true })
  }
})

test('logs/stream：非 GET 与非回环来源被 core 的守卫挡下（守卫自己写响应，不抛给调用方）', async () => {
  const home = tempDir('logs-stream-guard')
  const mounted = await mountLogs(home)
  try {
    const route = mounted.routes.find((registration) => String(registration.path).endsWith('/logs/stream'))
    assert.ok(route)

    // 非 GET：带上插件头，好让方法白名单（而不是凭证检查）成为拒绝原因
    const post = fakeRes()
    await route.handler(
      {
        method: 'POST',
        url: route.path,
        socket: { remoteAddress: '127.0.0.1' },
        headers: { host: 'localhost:19387', 'x-dsh-plugin': 'shell-kit' },
      },
      post.res,
    )
    assert.equal(post.state.status, 405, post.res.body())
    assert.equal(post.res.body().includes('METHOD'), true)

    // 非回环套接字
    const remote = fakeRes()
    await route.handler(
      {
        method: 'GET',
        url: route.path,
        socket: { remoteAddress: '10.0.0.7' },
        headers: { host: 'localhost:19387' },
      },
      remote.res,
    )
    assert.equal(remote.state.status, 403, remote.res.body())
    assert.equal(remote.res.body().includes('FORBIDDEN'), true)

    // 被 rebind 的 Host
    const rebind = fakeRes()
    await route.handler(
      {
        method: 'GET',
        url: route.path,
        socket: { remoteAddress: '127.0.0.1' },
        headers: { host: 'evil.example.com' },
      },
      rebind.res,
    )
    assert.equal(rebind.state.status, 403, rebind.res.body())
  } finally {
    mounted.handle.dispose()
    mounted.restore()
    rmSync(home, { recursive: true, force: true })
  }
})

test('logs/stream：模块 dispose 会停掉还开着的流', async () => {
  const home = tempDir('logs-stream-dispose')
  const mounted = await mountLogs(home)
  try {
    const route = mounted.routes.find((registration) => String(registration.path).endsWith('/logs/stream'))
    assert.ok(route)
    const { state, res } = fakeRes()
    await route.handler(
      {
        method: 'GET',
        url: `${route.path}?intervalMs=200`,
        socket: { remoteAddress: '127.0.0.1' },
        headers: { host: 'localhost:19387' },
      },
      res,
    )
    const exporter = mounted.grabExporter()
    mounted.handle.dispose()
    assert.equal(res.listenerCount('close'), 1, '写帧器已释放，只剩路由自己那一个 close 监听')
    const frames = state.chunks.length
    try {
      exporter.export({ ts: Date.now(), type: 'info', name: 'test', args: ['释放之后'] })
    } catch {
      /* sink 已关，写不进去也符合预期 */
    }
    await wait(500)
    assert.equal(state.chunks.length, frames)
    assert.equal(res.body().includes('释放之后'), false)
  } finally {
    mounted.handle.dispose()
    mounted.restore()
    rmSync(home, { recursive: true, force: true })
  }
})
