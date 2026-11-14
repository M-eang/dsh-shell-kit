/**
 * lib/sse.js 的用例：帧格式、背压等待、断开与 dispose。
 *
 * 与 dsh-prompt-refine/tests/sse.test.ts 是同一张行为表（那边用 vitest，这里用 node:test）。
 * 跑法：`node --test test/sse.test.js`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createSseWriter, sseComment, sseFrame } from '../lib/sse.js'

/** 假响应：write 的返回值可排队指定（false = 缓冲满，需要 drain）。 */
function fakeRes({ writeReturns = [] } = {}) {
  const state = { status: 0, headers: {}, chunks: [], listeners: { close: new Set(), drain: new Set() } }
  const res = {
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) {
      state.status = status
      Object.assign(state.headers, headers)
    },
    write(chunk) {
      state.chunks.push(String(chunk))
      return writeReturns.length > 0 ? writeReturns.shift() : true
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
  }
  return { state, res }
}

test('open()：写 SSE 头部并立刻冲一帧注释', () => {
  const { state, res } = fakeRes()
  const writer = createSseWriter(res)
  writer.open()
  assert.equal(state.status, 200)
  assert.equal(state.headers['content-type'], 'text/event-stream; charset=utf-8')
  assert.equal(state.headers['cache-control'], 'no-cache, no-transform')
  assert.equal(state.headers['x-accel-buffering'], 'no')
  assert.equal(state.chunks.join(''), ': open\n\n')
})

test('write()：缓冲未满时同步返回，不挂起', async () => {
  const { state, res } = fakeRes()
  const writer = createSseWriter(res)
  writer.open()
  await writer.write(sseFrame('line', { line: '一' }))
  assert.equal(state.chunks.join('').endsWith('event: line\ndata: {"line":"一"}\n\n'), true)
})

test('write()：write 返回 false 时等到 drain 才继续', async () => {
  const { state, res } = fakeRes({ writeReturns: [true, false, true] })
  const writer = createSseWriter(res)
  writer.open() // 冲头那次用掉第一个 true
  let settled = false
  const pending = writer.write('event: line\ndata: {}\n\n').then(() => {
    settled = true
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(settled, false, '缓冲满时必须挂起，不能直接 resolve')
  assert.equal(res.listenerCount('drain'), 1)
  res.emit('drain')
  await pending
  assert.equal(settled, true)
  assert.equal(res.listenerCount('drain'), 0, 'drain 之后要摘掉监听')
})

test('write()：close 到达时挂起的写也要落地（先 resolve 再失败由调用方决定）', async () => {
  const { state, res } = fakeRes({ writeReturns: [true, false] })
  const writer = createSseWriter(res)
  writer.open()
  const pending = writer.write('event: line\ndata: {}\n\n')
  res.emit('close')
  await pending
  assert.equal(state.chunks.join('').includes('event: line'), true)
})

test('close 之后不再写任何东西', async () => {
  const { state, res } = fakeRes()
  const writer = createSseWriter(res)
  writer.open()
  const before = state.chunks.length
  res.emit('close')
  await writer.write(sseFrame('line', { line: '断开之后' }))
  assert.equal(state.chunks.length, before)
})

test('dispose()：摘掉 close 监听并让后续写变空操作', async () => {
  const { state, res } = fakeRes()
  const writer = createSseWriter(res)
  writer.open()
  assert.equal(res.listenerCount('close'), 1)
  writer.dispose()
  assert.equal(res.listenerCount('close'), 0)
  const before = state.chunks.length
  await writer.write(sseFrame('line', { line: '已释放' }))
  assert.equal(state.chunks.length, before)
})

test('writableEnded / destroyed 的响应不再写', async () => {
  const ended = fakeRes()
  ended.res.writableEnded = true
  const writerA = createSseWriter(ended.res)
  await writerA.write('x')
  assert.equal(ended.state.chunks.length, 0)

  const destroyed = fakeRes()
  destroyed.res.destroyed = true
  const writerB = createSseWriter(destroyed.res)
  await writerB.write('x')
  assert.equal(destroyed.state.chunks.length, 0)
})

test('sseFrame / sseComment：data 里不出现裸换行（多行文本不会被切成两帧）', () => {
  const frame = sseFrame('line', { line: '第一行\n第二行' })
  assert.equal(frame, 'event: line\ndata: {"line":"第一行\\n第二行"}\n\n')
  assert.equal(frame.split('\n\n').length, 2, '整帧只有一个空行分隔符')
  assert.equal(sseComment('ping\npong'), ': ping pong\n\n')
  assert.equal(sseFrame('line', undefined), 'event: line\ndata: null\n\n')
})
