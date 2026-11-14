/**
 * 重启流程的端口探针 —— 「已释放」只认 ECONNREFUSED。
 *
 * 旧实现把任何「连不上」都当成端口空闲，于是 DNS/权限/防火墙/超时这类
 * **未能观测**的结果都会被误判成释放，助手随即按旧端口拉起新实例，撞上
 * 还在监听的旧宿主（表现为「重启后白屏 / 端口被占用」）。
 *
 * 这里的判定分三档，只有明确被拒绝（ECONNREFUSED，即内核确认没有监听者）
 * 才算空闲；其余一律按「可能仍在监听」处理，宁可多等。
 * @module dsh-shell-kit/restart/ports
 */
import net from 'node:net'

/** 单次连接探测的超时（毫秒）。 */
export const PROBE_TIMEOUT_MS = 1000

/** 'listening' 连上了 · 'free' 明确被拒绝 · 'unknown' 没能观测（超时或其它错误）。 */
export const LISTENING = 'listening'
export const FREE = 'free'
export const UNKNOWN = 'unknown'

/**
 * 探测一次 127.0.0.1:port。
 * @param {number} port 端口；非法端口直接判为 free（没有端口就没有占用）。
 * @param {{timeoutMs?: number, host?: string}} [options]
 * @returns {Promise<'listening'|'free'|'unknown'>}
 */
export function probePort(port, options = {}) {
  if (!Number.isInteger(port) || port <= 0) return Promise.resolve(FREE)
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : PROBE_TIMEOUT_MS
  const host = typeof options.host === 'string' && options.host !== '' ? options.host : '127.0.0.1'
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    let settled = false
    const settle = (verdict) => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      // 迟到的 error（destroy 引发的 ECONNRESET 等）没有监听者会变成
      // unhandled 'error' 直接崩掉助手进程，所以留一个空监听。
      socket.on('error', () => {})
      socket.destroy()
      resolve(verdict)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => settle(LISTENING))
    socket.once('timeout', () => settle(UNKNOWN))
    socket.once('error', (error) => settle(error?.code === 'ECONNREFUSED' ? FREE : UNKNOWN))
  })
}

/**
 * 端口上是否有人在监听。未知按「在监听」处理（保守）。
 * @param {number} port
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<boolean>}
 */
export async function portListening(port, options) {
  return (await probePort(port, options)) !== FREE
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 等端口空出来。只有明确观测到 ECONNREFUSED 才返回 true；超时仍未确认则 false，
 * 由调用方决定是继续等、还是明确报告「端口未被释放」。
 * @param {number} port
 * @param {number} timeoutSec
 * @param {{timeoutMs?: number, intervalMs?: number}} [options]
 * @returns {Promise<boolean>}
 */
export async function waitPortFree(port, timeoutSec, options = {}) {
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 300
  const deadline = Date.now() + Math.max(0, timeoutSec) * 1000
  let verdict = await probePort(port, options)
  while (verdict !== FREE && Date.now() < deadline) {
    await sleep(intervalMs)
    verdict = await probePort(port, options)
  }
  return verdict === FREE
}

/**
 * 等端口开始监听（新实例起来了没）。
 * @param {number} port
 * @param {number} timeoutSec
 * @param {{timeoutMs?: number, intervalMs?: number}} [options]
 * @returns {Promise<boolean>}
 */
export async function waitPortListening(port, timeoutSec, options = {}) {
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 400
  const deadline = Date.now() + Math.max(0, timeoutSec) * 1000
  let verdict = await probePort(port, options)
  while (verdict !== LISTENING && Date.now() < deadline) {
    await sleep(intervalMs)
    verdict = await probePort(port, options)
  }
  return verdict === LISTENING
}
