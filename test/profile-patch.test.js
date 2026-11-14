/**
 * ./patch-text.js 的合并语义：同 id 就地改写（保留它自己的键），没有才追加。
 *
 * 这组用例对应一次真实别扭：旧实现只会往 cordis.patch.yml 追加，同一个 id
 * 连修两次就出现两条覆盖行，用户在体检清单里看到的和最终生效的对不上。
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { locateRow, readOverride, upsertOverride } from '../lib/modules/profile/patch-text.js'

const MARKET_STYLE = [
  '- id: dsh-cost-meter',
  '  disabled: false',
  '  config:',
  '    currency: CNY',
  '',
].join('\n')

describe('profile patch text', () => {
  it('appends a new override row when the id is absent', () => {
    const { text, mode } = upsertOverride(MARKET_STYLE, { id: 'dsh-ops', disabled: true, header: '# ↓ 修复' })
    assert.equal(mode, 'appended')
    assert.match(text, /# ↓ 修复\n- id: dsh-ops\n  disabled: true\n$/u)
    assert.ok(text.startsWith(MARKET_STYLE.trimEnd()))
    assert.equal(readOverride(text, 'dsh-ops'), true)
  })

  it('rewrites an existing row in place and keeps its other keys', () => {
    const { text, mode } = upsertOverride(MARKET_STYLE, { id: 'dsh-cost-meter', disabled: true, header: '# ↓ 修复' })
    assert.equal(mode, 'updated')
    // 关键断言：没有变成两行，header 也不该出现在就地改写里。
    assert.equal(text.match(/- id: dsh-cost-meter/gu)?.length, 1)
    assert.equal(text.includes('# ↓ 修复'), false)
    assert.equal(readOverride(text, 'dsh-cost-meter'), true)
    // 原有 config 子树必须原样留着。
    assert.match(text, /  config:\n    currency: CNY/u)
  })

  it('flips back to enabled and inserts the key when the row lacks one', () => {
    const once = upsertOverride(MARKET_STYLE, { id: 'dsh-cost-meter', disabled: true }).text
    const twice = upsertOverride(once, { id: 'dsh-cost-meter', disabled: false })
    assert.equal(twice.mode, 'updated')
    assert.equal(readOverride(twice.text, 'dsh-cost-meter'), false)

    const bare = '- id: dsh-ops\n'
    const withKey = upsertOverride(bare, { id: 'dsh-ops', disabled: true })
    assert.equal(withKey.mode, 'updated')
    assert.equal(readOverride(withKey.text, 'dsh-ops'), true)
  })

  it('never duplicates a row across repeated upserts', () => {
    let text = ''
    for (const id of ['a-plugin', 'b-plugin', 'a-plugin', 'c-plugin', 'b-plugin']) {
      text = upsertOverride(text, { id, disabled: true }).text
    }
    for (const id of ['a-plugin', 'b-plugin', 'c-plugin']) {
      assert.equal(text.match(new RegExp(`- id: ${id}\\b`, 'gu'))?.length, 1, `${id} 被写了多次`)
    }
  })

  it('finds rows nested inside an insert block (indent 4)', () => {
    const nested = ['- id: dsh-plugin-kit', '  disabled: false', '  insert:', '    - id: inner-plugin', '      disabled: false', ''].join('\n')
    const found = locateRow(nested.split(/\r?\n/u), 'inner-plugin')
    assert.equal(found?.indent, 4)
    const { text, mode } = upsertOverride(nested, { id: 'inner-plugin', disabled: true })
    assert.equal(mode, 'updated')
    assert.equal(readOverride(text, 'inner-plugin'), true)
    // 外层条目不能被误伤。
    assert.equal(readOverride(text, 'dsh-plugin-kit'), false)
  })

  it('keeps CRLF and reports nothing for unknown ids', () => {
    const crlf = '- id: dsh-ops\r\n  disabled: false\r\n'
    const { text } = upsertOverride(crlf, { id: 'dsh-ops', disabled: true })
    assert.equal(text.includes('\n') && !text.includes('\r\n'), false)
    assert.match(text, /disabled: true\r\n/u)
    assert.equal(readOverride(text, 'no-such-plugin'), undefined)
    assert.equal(readOverride('- id: dsh-ops\n', 'dsh-ops'), undefined)
  })
})
