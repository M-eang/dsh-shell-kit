/**
 * lib/loopback.js 的独立用例。
 *
 * 与 dsh-prompt-refine/tests/loopback.test.ts 覆盖同一张真值表 —— 两份用例一起改，
 * 「三份实现同构」才是可验证的事实，而不是注释里的一句愿望。
 * 跑法：`node --test test/loopback.test.js`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { TRUSTED_HOSTNAMES, fenceReason, isLoopbackRequest, isTrustedRequest } from '../lib/loopback.js'

const req = (fields = {}) => ({
  socket: { remoteAddress: fields.remoteAddress ?? '127.0.0.1' },
  headers: {
    ...(fields.host === undefined ? {} : { host: fields.host }),
    ...(fields.forwarded === undefined ? {} : { forwarded: fields.forwarded }),
    ...(fields.xff === undefined ? {} : { 'x-forwarded-for': fields.xff }),
    ...(fields.realIp === undefined ? {} : { 'x-real-ip': fields.realIp }),
    ...(fields.origin === undefined ? {} : { origin: fields.origin }),
  },
})

test('isLoopbackRequest：只认回环套接字', () => {
  assert.equal(isLoopbackRequest(req({ remoteAddress: '127.0.0.1' })), true)
  assert.equal(isLoopbackRequest(req({ remoteAddress: '::1' })), true)
  assert.equal(isLoopbackRequest(req({ remoteAddress: '::ffff:127.0.0.1' })), true)
  assert.equal(isLoopbackRequest(req({ remoteAddress: '192.168.1.7' })), false)
  assert.equal(isLoopbackRequest(req({ remoteAddress: '' })), false)
  assert.equal(isLoopbackRequest({}), false)
})

test('isTrustedRequest：回环套接字 + 受信任 Host / 缺 Host / 本机 Origin', () => {
  assert.equal(isTrustedRequest(req({ host: 'localhost' })), true)
  assert.equal(isTrustedRequest(req({ host: 'localhost:19387' })), true)
  assert.equal(isTrustedRequest(req({ host: '127.0.0.1:19387' })), true)
  assert.equal(isTrustedRequest(req({ host: '[::1]:19387' })), true)
  assert.equal(isTrustedRequest(req({ host: 'LOCALHOST' })), true)
  assert.equal(isTrustedRequest(req({})), true)
  assert.equal(isTrustedRequest(req({ host: 'localhost', origin: 'http://127.0.0.1:19387' })), true)
  assert.equal(isTrustedRequest(req({ host: 'localhost', origin: 'https://localhost' })), true)
  assert.equal(isTrustedRequest(req({ host: 'localhost', origin: '' })), true)
})

test('isTrustedRequest：DNS rebinding 的攻击 Host 一律被拒', () => {
  assert.equal(isTrustedRequest(req({ host: 'evil.com' })), false)
  assert.equal(isTrustedRequest(req({ host: 'evil.com:19387' })), false)
  assert.equal(isTrustedRequest(req({ host: 'localhost.evil.com' })), false)
  assert.equal(isTrustedRequest(req({ host: '127.0.0.1.evil.com:19387' })), false)
  assert.equal(isTrustedRequest(req({ host: 'internal.attacker.example' })), false)
})

test('isTrustedRequest：三种转发痕迹（Forwarded / X-Forwarded-For / X-Real-IP）都被拒', () => {
  assert.equal(isTrustedRequest(req({ forwarded: 'for=203.0.113.7' })), false)
  assert.equal(isTrustedRequest(req({ forwarded: 'for=203.0.113.7', host: 'localhost' })), false)
  assert.equal(isTrustedRequest(req({ xff: '203.0.113.7' })), false)
  assert.equal(isTrustedRequest(req({ realIp: '203.0.113.7' })), false)
  assert.equal(isTrustedRequest(req({ realIp: '127.0.0.1', host: 'localhost' })), false)
})

test('isTrustedRequest：跨站与退化 Origin 被拒', () => {
  assert.equal(isTrustedRequest(req({ host: 'localhost', origin: 'https://evil.com' })), false)
  assert.equal(isTrustedRequest(req({ host: 'localhost', origin: 'http://evil.com:19387' })), false)
  assert.equal(isTrustedRequest(req({ host: 'localhost', origin: 'null' })), false)
  assert.equal(isTrustedRequest(req({ host: 'localhost', origin: 'file://' })), false)
  assert.equal(isTrustedRequest(req({ host: 'localhost', origin: 'http://localhost.evil.com' })), false)
  assert.equal(isTrustedRequest(req({ host: 'localhost', origin: 'http://127.0.0.1.evil.com:19387' })), false)
})

test('isTrustedRequest：非回环套接字无论如何都被拒', () => {
  assert.equal(isTrustedRequest(req({ remoteAddress: '192.168.1.7', host: 'localhost' })), false)
  assert.equal(isTrustedRequest(req({ remoteAddress: '192.168.1.7', host: 'localhost', origin: 'http://localhost' })), false)
})

test('fenceReason：报出失败的那条规则，并保持判定顺序', () => {
  assert.equal(fenceReason(req({ host: 'localhost' })), null)
  assert.equal(fenceReason(req({ forwarded: 'for=1.2.3.4' })), 'forwarded')
  assert.equal(fenceReason(req({ realIp: '203.0.113.7' })), 'forwarded')
  assert.equal(fenceReason(req({ remoteAddress: '192.168.1.7' })), 'socket')
  assert.equal(fenceReason(req({ host: 'evil.com' })), 'host')
  assert.equal(fenceReason(req({ host: 'localhost', origin: 'https://evil.com' })), 'origin')

  const all = { forwarded: 'for=1.2.3.4', remoteAddress: '192.168.1.7', host: 'evil.com', origin: 'https://evil.com' }
  assert.equal(fenceReason(req(all)), 'forwarded')
  assert.equal(fenceReason(req({ remoteAddress: '192.168.1.7', host: 'evil.com', origin: 'https://evil.com' })), 'socket')
  assert.equal(fenceReason(req({ host: 'evil.com', origin: 'https://evil.com' })), 'host')
})

test('TRUSTED_HOSTNAMES：信任名单只有三个本机写法', () => {
  assert.deepEqual([...TRUSTED_HOSTNAMES].sort(), ['127.0.0.1', '::1', 'localhost'])
})
