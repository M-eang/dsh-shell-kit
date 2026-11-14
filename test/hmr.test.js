/**
 * hmr 模块的用例：活体条目解读、事件记录、两个路由。
 *
 * 不启真服务器：mount 时替换 ctx.webServer.register 把路由收下来，用假 req/res 直接
 * 驱动 handler；loader 与事件总线都是假的（这个模块的全部输入就是这两样）。
 *
 * 跑法：`node --test test/hmr.test.js`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

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

/** 造一个 hmr 条目（形状照 doctor 模块里读 loader.entries() 的用法）。 */
function hmrEntry({ id = 'hmr', name = '@deepseek-ai/dsh-hmr', state = 2, disabled, root } = {}) {
  const options = { id, name }
  if (disabled !== undefined) options.disabled = disabled
  if (root !== undefined) options.config = { root }
  return { options, fiber: state === null ? null : { state } }
}

const req = (path) => ({
  method: 'GET',
  url: path,
  socket: { remoteAddress: '127.0.0.1' },
  headers: { host: 'localhost:19387' },
})

/** 起一个 hmr 模块，返回路由表、事件发射器与句柄。 */
async function mountHmr(entries, { loaderThrows = false } = {}) {
  const { mount } = await import('../lib/modules/hmr/index.js')
  const routes = []
  const listeners = new Map()
  const warnings = []
  const ctx = {
    logger: {
      info() {},
      warn(line) { warnings.push(String(line)) },
      error() {},
    },
    get(key) {
      if (key !== 'loader') return undefined
      if (loaderThrows) throw new Error('no loader service')
      return { entries: () => entries }
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return () => set.delete(listener)
    },
    webServer: {
      register(registration) {
        routes.push(registration)
        return () => {}
      },
    },
  }
  const handle = mount(ctx)
  return {
    handle,
    routes,
    warnings,
    emit(event, payload) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(payload)
    },
    async get(path) {
      const route = routes.find((registration) => registration.path === path)
      assert.ok(route, `必须注册了 ${path}`)
      const { state, res } = fakeRes()
      await route.handler(req(path), res)
      const parsed = state.chunks.length > 0 ? JSON.parse(state.chunks.join('')) : null
      // `ok()` 会把载荷包一层 { ok, data }，测试只关心 data。
      const json = parsed?.ok === true && parsed.data !== undefined ? parsed.data : parsed
      return { state, res, json }
    },
    async openStream() {
      const route = routes.find((registration) => registration.path.endsWith('/hmr/events'))
      assert.ok(route, '必须注册了 hmr/events 路由')
      const { state, res } = fakeRes()
      await route.handler(req(route.path), res)
      return { state, res }
    },
  }
}

test('hmr/status：条目活着但 root 为空 → config-only（源码改动仍需重启）', async () => {
  const mounted = await mountHmr([hmrEntry({ root: [] })])
  const { json } = await mounted.get('/api/shell-kit/hmr/status')
  assert.equal(json.available, true)
  assert.equal(json.verdict, 'config-only')
  assert.equal(json.watchesSources, false)
  assert.deepEqual(json.sourceRoots, [])
  assert.equal(json.entry.state, 'active')
})

test('hmr/status：监听了源码目录 → active；被停用 → disabled；没有条目 → missing', async () => {
  const watching = await mountHmr([hmrEntry({ root: ['.'] })])
  assert.equal((await watching.get('/api/shell-kit/hmr/status')).json.verdict, 'active')
  assert.equal((await watching.get('/api/shell-kit/hmr/status')).json.watchesSources, true)

  const off = await mountHmr([hmrEntry({ disabled: true })])
  assert.equal((await off.get('/api/shell-kit/hmr/status')).json.verdict, 'disabled')

  const none = await mountHmr([])
  const missing = (await none.get('/api/shell-kit/hmr/status')).json
  assert.equal(missing.available, false)
  assert.equal(missing.verdict, 'missing')
})

test('hmr/status：条目在但没有存活 fiber → inactive', async () => {
  const mounted = await mountHmr([hmrEntry({ state: null, root: ['.'] })])
  assert.equal((await mounted.get('/api/shell-kit/hmr/status')).json.verdict, 'inactive')
})

test('hmr/status：loader 取不到也不抛，按 missing 报告', async () => {
  const mounted = await mountHmr([], { loaderThrows: true })
  const { json } = await mounted.get('/api/shell-kit/hmr/status')
  assert.equal(json.verdict, 'missing')
  assert.deepEqual(json.recentEvents, [])
})

test('事件：hmr/reload 记条数与文件名（不落绝对路径），hmr/change 记 URL', async () => {
  const mounted = await mountHmr([hmrEntry({ root: [] })])
  mounted.emit('hmr/reload', [{ url: 'file:///C:/Users/x/plugins/foo/lib/index.js' }])
  mounted.emit('hmr/change', 'file:///C:/Users/x/profile/cordis.patch.yml')

  const { json } = await mounted.get('/api/shell-kit/hmr/status')
  assert.equal(json.reloadCount, 1)
  assert.ok(json.lastReloadAt, 'reload 时间戳必须记下')
  assert.equal(json.lastChangeUrl, 'file:///C:/Users/x/profile/cordis.patch.yml')
  const kinds = json.recentEvents.map((event) => event.kind)
  assert.deepEqual(kinds.slice(0, 2), ['change', 'reload'])
  const reload = json.recentEvents.find((event) => event.kind === 'reload')
  assert.deepEqual(reload.urls, ['index.js'])
  // 绝对路径只进日志与面板，绝不进事件载荷的其它字段
  assert.equal(JSON.stringify(reload).includes('C:/Users'), false)
  assert.equal(JSON.stringify(reload).includes('C:\\\\Users'), false)
})

test('hmr/events：首帧是当前状态，之后每次事件各推一帧', async () => {
  const mounted = await mountHmr([hmrEntry({ root: ['.'] })])
  const { state, res } = await mounted.openStream()
  assert.equal(state.status, 200)
  assert.equal(state.headers['content-type'], 'text/event-stream; charset=utf-8')
  assert.match(res.body(), /event: status\ndata: \{.*"verdict":"active"/)

  mounted.emit('hmr/reload', [])
  assert.match(res.body(), /event: reload\ndata: \{.*"kind":"reload"/)

  // 释放之后不再往这条流写
  const frames = state.chunks.length
  mounted.handle.dispose()
  mounted.emit('hmr/reload', [])
  assert.equal(state.chunks.length, frames)
  assert.equal(res.listenerCount('close'), 1)
})

test('dispose：摘掉事件监听、释放路由', async () => {
  const mounted = await mountHmr([hmrEntry({ root: [] })])
  mounted.handle.dispose()
  const before = (await mounted.get('/api/shell-kit/hmr/status')).json.reloadCount
  mounted.emit('hmr/reload', [])
  const after = (await mounted.get('/api/shell-kit/hmr/status')).json.reloadCount
  assert.equal(after, before, '释放后不应再记录事件')
})
