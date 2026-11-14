/**
 * 回环守卫（dsh-shell-kit 侧的唯一实现）。
 *
 * 与 dsh-prompt-refine/src/loopback.ts、dsh-stt-qwen/lib/loopback.js 是**同一套四条规则**，
 * 按同一顺序判定：转发痕迹 → 套接字 → Host → Origin。三份实现刻意保持逐行同构，
 * 改动任一份时另外两份要一起改。
 *
 * 为什么四条都要：
 * - 转发痕迹：出现 X-Forwarded-For / X-Real-IP / Forwarded 说明路径上有代理，
 *   这套信任模型不覆盖代理场景，直接拒绝；
 * - 套接字：只有本机回环直连才谈得上"这是我自己的 UI 在说话"；
 * - Host：防 DNS rebinding —— 被 rebind 的攻击域名仍然落在回环套接字上，
 *   但它带的 Host 是攻击者的域名，这里拒绝。缺 Host（HTTP/1.0 风格）放行，
 *   因为套接字检查已经把调用方限制在本机进程；
 * - Origin：浏览器自动带，跨站 fire-and-forget 请求一定带一个不被信任的 Origin。
 */

/** 允许用来到达本机回环服务的主机名。 */
export const TRUSTED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])

/** 任何一条都代表"路径上有代理"。 */
const FORWARDING_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded']

function hasForwardingHeader(req) {
  const headers = req?.headers ?? {}
  return FORWARDING_HEADERS.some((name) => headers[name] !== undefined)
}

/** 请求是否落在回环套接字上（只看套接字，不看头）。 */
export function isLoopbackRequest(req) {
  const address = req?.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** 去掉 Host 头里的端口（以及 IPv6 方括号）。 */
function hostnameOf(hostHeader) {
  const trimmed = String(hostHeader).trim().toLowerCase()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    return end === -1 ? trimmed : trimmed.slice(1, end)
  }
  const colon = trimmed.lastIndexOf(':')
  return colon === -1 ? trimmed : trimmed.slice(0, colon)
}

/** 只接受同源本机页面作为 Origin。 */
function isTrustedOrigin(origin) {
  let url
  try {
    url = new URL(String(origin))
  } catch {
    return false
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && TRUSTED_HOSTNAMES.has(url.hostname)
}

/**
 * 四条规则的完整判定。
 * @returns {'forwarded'|'socket'|'host'|'origin'|null} 失败的那条规则；`null` 表示受信任。
 */
export function fenceReason(req) {
  if (hasForwardingHeader(req)) return 'forwarded'
  if (!isLoopbackRequest(req)) return 'socket'
  const host = req?.headers?.host
  if (typeof host === 'string' && host.trim() !== '' && !TRUSTED_HOSTNAMES.has(hostnameOf(host))) return 'host'
  const origin = req?.headers?.origin
  if (typeof origin === 'string' && origin.trim() !== '' && !isTrustedOrigin(origin)) return 'origin'
  return null
}

/** 布尔形式，给路由守卫用。 */
export function isTrustedRequest(req) {
  return fenceReason(req) === null
}
