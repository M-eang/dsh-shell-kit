/**
 * ./ports.js 的判定表：只有 ECONNREFUSED 才算「端口已释放」。
 *
 * 这组用例存在的理由是一次真实误判：旧实现把「连不上」一律当成空闲，
 * 于是超时/无路由/权限这类「没能观测」的结果也会让助手按旧端口抢跑，
 * 新实例撞上还在监听的旧宿主。
 */
import { strict as assert } from 'node:assert'
import { createServer } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { FREE, LISTENING, UNKNOWN, portListening, probePort, waitPortFree, waitPortListening } from '../lib/modules/restart/ports.js'

/** 一个黑洞地址：连它只会超时或不可达，永远不会 ECONNREFUSED。 */
const BLACKHOLE = '10.255.255.1'
const BLACKHOLE_OPTS = { host: BLACKHOLE, timeoutMs: 150 }

describe('restart ports', () => {
  /** @type {import('node:net').Server} */
  let server
  /** @type {number} */
  let port

  before(async () => {
    server = createServer(() => {})
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = server.address().port
  })

  after(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  it('reports a live listener as listening', async () => {
    assert.equal(await probePort(port), LISTENING)
    assert.equal(await portListening(port), true)
    assert.equal(await waitPortListening(port, 1), true)
  })

  it('calls a refused port free', async () => {
    const free = createServer()
    await new Promise((resolve) => free.listen(0, '127.0.0.1', resolve))
    const freePort = free.address().port
    await new Promise((resolve) => free.close(resolve))

    assert.equal(await probePort(freePort), FREE)
    assert.equal(await portListening(freePort), false)
    assert.equal(await waitPortFree(freePort, 2), true)
  })

  it('treats an unobservable port as still listening (fail-conservative)', async () => {
    assert.equal(await probePort(port, BLACKHOLE_OPTS), UNKNOWN)
    // 关键断言：未知 ≠ 空闲，等待逻辑必须继续等。
    assert.equal(await portListening(port, BLACKHOLE_OPTS), true)
    assert.equal(await waitPortFree(port, 0.2, { ...BLACKHOLE_OPTS, intervalMs: 50 }), false)
    assert.equal(await waitPortListening(port, 0.2, { ...BLACKHOLE_OPTS, intervalMs: 50 }), false)
  })

  it('never claims free for a non-port', async () => {
    assert.equal(await probePort(0), FREE)
    assert.equal(await probePort(Number.NaN), FREE)
    assert.equal(await portListening(0), false)
  })

  it('waits for the listener to come up', async () => {
    const late = createServer(() => {})
    // 先占一个临时端口再放掉，拿到一个刚空出来的端口，避免写死端口撞车。
    await new Promise((resolve) => late.listen(0, '127.0.0.1', resolve))
    const latePort = late.address().port
    await new Promise((resolve) => late.close(resolve))

    const pending = waitPortListening(latePort, 2, { intervalMs: 50 })
    await new Promise((resolve) => setTimeout(resolve, 200))
    await new Promise((resolve) => late.listen(latePort, '127.0.0.1', resolve))
    assert.equal(await pending, true)
    await new Promise((resolve) => late.close(resolve))
  })
})
