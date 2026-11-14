/**
 * dsh-shell-kit — `cordis.patch.yml` 的行级改写。
 *
 * 官方覆盖行就是一条列表项（`- id: X` 下面挂键），所以「停用某条目」有两种写法：
 *   · 该 id 已经有一条覆盖行 → **改它**（保留它自己的 config 等键，只把 disabled 改成目标值）；
 *   · 该 id 还没有 → 追加一条新行。
 *
 * 旧实现只会追加，于是同一个 id 被反复修就会堆出多条重复行；而 patch 层对重复
 * 行的合并规则不是「后者覆盖前者」那么直观，用户看到的清单与最终生效的配置就
 * 会对不上（对照 Evhye38496/dsh-perfscope 的 profile-writer：同名 id 合并、保留既有 config 键）。
 *
 * 纯文本进、纯文本出：不引 YAML 依赖（本包零依赖），也不做写入，写入由调用方
 * 走「临时文件 + 原子改名」完成。
 * @module dsh-shell-kit/profile/patch-text
 */

/** 覆盖行：顶层缩进 0，insert 块内缩进 4（与 profile-audit.parsePatchRows 一致）。 */
const ROW_RE = /^(\s{0,4})-\s+id:\s*(\S+)\s*$/u

/**
 * 定位某 id 的覆盖行。
 * @param {string[]} lines
 * @param {string} id
 * @returns {{start: number, end: number, indent: number}|null} [start, end) 是该项的行区间
 */
export function locateRow(lines, id) {
  for (let index = 0; index < lines.length; index += 1) {
    const match = ROW_RE.exec(lines[index])
    if (match === null || match[2] !== id) continue
    const indent = match[1].length
    let end = lines.length
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]
      if (line.trim() === '') continue
      // 缩进不深于本项 ⇒ 本项结束（同级 `- id:`、顶层注释、顶层其它键都算）。
      if (line.length - line.trimStart().length <= indent) {
        end = cursor
        break
      }
    }
    return { start: index, end, indent }
  }
  return null
}

/**
 * 读回某覆盖行当前的 disabled 值（没有该行或没有该键时 undefined）。
 * @param {string} text
 * @param {string} id
 * @returns {boolean|undefined}
 */
export function readOverride(text, id) {
  const lines = text.split(/\r?\n/u)
  const found = locateRow(lines, id)
  if (found === null) return undefined
  for (let index = found.start + 1; index < found.end; index += 1) {
    const match = /^(\s*)disabled\s*:\s*(\S+)\s*$/u.exec(lines[index])
    if (match === null || match[1].length !== found.indent + 2) continue
    return match[2] === 'true'
  }
  return undefined
}

/** 推断换行风格（patch 是用户文件，别把 CRLF 洗成 LF）。 */
function eolOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * 写入（或更新）一条覆盖行。
 * @param {string} text 现有 patch 全文
 * @param {{id: string, disabled: boolean, header?: string}} action header 只在追加新行时用作注释
 * @returns {{text: string, mode: 'updated'|'appended'}}
 */
export function upsertOverride(text, action) {
  const eol = eolOf(text)
  const lines = text.split(/\r?\n/u)
  const found = locateRow(lines, action.id)
  const value = action.disabled === true ? 'true' : 'false'

  if (found !== null) {
    const pad = ' '.repeat(found.indent + 2)
    for (let index = found.start + 1; index < found.end; index += 1) {
      const match = /^(\s*)disabled\s*:/u.exec(lines[index])
      if (match !== null && match[1].length === found.indent + 2) {
        lines[index] = `${pad}disabled: ${value}`
        return { text: lines.join(eol), mode: 'updated' }
      }
    }
    // 有覆盖行但没写 disabled：插在本项第一行之后，保留它已有的键。
    lines.splice(found.start + 1, 0, `${pad}disabled: ${value}`)
    return { text: lines.join(eol), mode: 'updated' }
  }

  const trimmed = text.replace(/\s+$/u, '')
  const head = trimmed === '' ? '' : `${trimmed}${eol}${eol}`
  const comment = typeof action.header === 'string' && action.header !== '' ? `${action.header}${eol}` : ''
  const appended = `${head}${comment}- id: ${action.id}${eol}  disabled: ${value}${eol}`
  return { text: appended, mode: 'appended' }
}
