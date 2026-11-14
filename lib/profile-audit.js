/**
 * dsh-shell-kit — profile 静态审计（doctor 与 profile 两个模块共用）。
 *
 * 只做**读**与**判断**，不写任何文件：判断结果给 doctor 出报告，
 * 也给 profile 生成"可修项"（哪些行可以禁用/启用）。
 *
 * 为什么单独一个文件而不是放进某个模块：模块之间约定不互相 import，
 * 共享逻辑只能落在 lib/ 下的公共文件里（这与"一个模块坏了不连坐"是配套的）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolveProfileDir } from './core.js'

/** npm 包名（含 scope）。用来抓"name 里混进其它字符"这类脏数据。 */
export const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u

/** 宿主自带的包命名空间：它们不在 profile 的 node_modules 里，跳过存在性检查。 */
const HOST_NAMESPACES = ['@deepseek-ai/']

export function isHostPackage(name) {
  return typeof name === 'string' && HOST_NAMESPACES.some((prefix) => name.startsWith(prefix))
}

export function readText(path) {
  try { return readFileSync(path, 'utf8') } catch { return null }
}

/**
 * 行级解析 cordis.patch.yml。
 *
 * 刻意不依赖 yaml 包：这里只想拿到 id / name / disabled / insert 这几个字段，
 * 而行级扫描对"文件被写坏"这件事本身就有诊断价值（比如 name 被粘上注释 —— 那次
 * YAML 其实还能解析，只是 name 变成了一个不存在的包名）。
 *
 * 条目行的缩进只可能是 0（顶层）或 4（insert 块内）；更深处的 `- id:` 是配置数据
 * （例如 llm-pi-ai 的 models 列表），不能当成插件条目，否则它下面的 `name:`
 * （模型显示名，如 "Deepseek-V4.1-Flash"）会被误判成"非法包名"。
 */
export function parsePatchRows(text) {
  const rows = []
  let current = null
  let insideInsert = false
  text.split(/\r?\n/u).forEach((rawLine, index) => {
    const line = rawLine.replace(/\s+#.*$/u, '')
    if (/^\s*#/u.test(rawLine) || line.trim() === '') return
    const topRow = /^-\s+([A-Za-z][\w-]*):/u.exec(line)
    if (topRow !== null) {
      insideInsert = topRow[1] === 'insert'
      if (topRow[1] === 'insert') current = null
    }
    const idMatch = /^(\s{0,4})-\s+id:\s*(\S+)\s*$/u.exec(line)
    if (idMatch !== null) {
      current = { line: index + 1, id: idMatch[2], insert: insideInsert, indent: idMatch[1].length }
      rows.push(current)
      return
    }
    const nameMatch = /^(\s*)name:\s*(.+?)\s*$/u.exec(line)
    if (nameMatch !== null && current !== null && nameMatch[1].length === (current.indent ?? 0) + 2) {
      current.name = nameMatch[2].replace(/^['"]|['"]$/gu, '')
      return
    }
    const disabledMatch = /^\s+disabled:\s*(.+?)\s*$/u.exec(line)
    if (disabledMatch !== null && current !== null) current.disabled = disabledMatch[1]
  })
  return { rows }
}

/**
 * 采集 profile 静态面上的问题。
 * @param {string} profileDir profile 目录
 * @returns {Array<{level:'error'|'warn'|'info',code:string,title:string,detail?:string,evidence?:string,id?:string,fix?:object}>}
 */
export function collectProfileFindings(profileDir) {
  const findings = []
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const patchText = readText(patchPath)
  const nodeModules = join(profileDir, 'node_modules')
  let rows = []

  if (patchText === null) {
    findings.push({
      level: 'warn', code: 'patch-missing',
      title: '没有找到 cordis.patch.yml', detail: patchPath,
    })
  } else {
    rows = parsePatchRows(patchText).rows
    // 被"覆盖行"显式停用的 id：`- id: X` + `disabled: true`（插件市场与本模块的修复动作
    // 都这么写）。停用之后，它上面的 insert 行即使引用了不存在的包也不再是问题 ——
    // 否则修完还会一直报，用户以为没修好。
    const disabledIds = new Set(rows.filter((row) => row.disabled === 'true' && row.id !== undefined).map((row) => row.id))
    const byId = new Map()
    for (const row of rows) {
      const turnedOff = row.id !== undefined && disabledIds.has(row.id)
      // ① name 里混进了非包名字符（最阴的一类：YAML 照样解析，包名却不存在）
      if (!turnedOff && row.name !== undefined && !PACKAGE_NAME.test(row.name)) {
        findings.push({
          level: 'error', code: 'bad-package-name', id: row.id,
          title: `patch 第 ${row.line} 行的 name 不是一个合法包名`,
          detail: `name = ${JSON.stringify(row.name)}（疑似把注释或其它内容粘在了一起）`,
          evidence: `cordis.patch.yml:${row.line}`,
          fix: row.id === undefined ? undefined : { kind: 'disable-entry', id: row.id },
        })
      }
      // ② 引用了一个 profile 里没装的包
      if (!turnedOff && row.name !== undefined && PACKAGE_NAME.test(row.name) && !isHostPackage(row.name) && !existsSync(join(nodeModules, row.name))) {
        findings.push({
          level: 'error', code: 'missing-package', id: row.id,
          title: `patch 第 ${row.line} 行引用的包没装：${row.name}`,
          detail: '这条 entry 在启动时会加载失败（条目在、fiber 起不来），插件会被跳过',
          evidence: `cordis.patch.yml:${row.line}`,
          fix: row.id === undefined ? undefined : { kind: 'disable-entry', id: row.id },
        })
      }
      // ③ disabled 值不像布尔/表达式
      if (row.disabled !== undefined && !/^(true|false|!!js\b)/u.test(row.disabled)) {
        findings.push({
          level: 'warn', code: 'bad-disabled-value', id: row.id,
          title: `patch 第 ${row.line} 行的 disabled 值可疑`,
          detail: `disabled = ${JSON.stringify(row.disabled)}`,
          evidence: `cordis.patch.yml:${row.line}`,
        })
      }
      if (row.id !== undefined) {
        const list = byId.get(row.id) ?? []
        list.push(row)
        byId.set(row.id, list)
      }
    }
    for (const [id, list] of byId) {
      // 只认"两条都带 name"的重复：`- id: X` + `disabled: true` 这种**覆盖行**是官方约定
      // （插件市场的开关、以及本模块的修复动作都这么写），不能算重复。
      const named = list.filter((row) => row.name !== undefined)
      if (named.length > 1) {
        findings.push({
          level: 'warn', code: 'duplicate-id', id,
          title: `patch 里同一个 id 出现 ${named.length} 次：${id}`,
          detail: `行号 ${named.map((row) => row.line).join(', ')}；后面的行会覆盖前面的配置`,
          evidence: `cordis.patch.yml:${named[0].line}`,
        })
      }
    }
  }

  const manifestPath = join(profileDir, 'package.json')
  const manifestText = readText(manifestPath)
  let manifest = null
  try { manifest = manifestText === null ? null : JSON.parse(manifestText) } catch { manifest = null }
  if (manifest === null) {
    findings.push({
      level: 'error', code: 'manifest-unreadable',
      title: 'profile 的 package.json 读不出来或不是合法 JSON',
      detail: manifestPath,
    })
    return { findings, rows }
  }

  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
    const target = spec.slice('link:'.length)
    if (!existsSync(target)) {
      findings.push({
        level: 'error', code: 'broken-link',
        title: `本地 link 依赖指向的目录不存在：${name}`,
        detail: `${spec} → ${target}；要手工处理：从 package.json 的 dependencies 里删掉它，并删掉 node_modules\\${name} 这个 junction`,
        evidence: 'package.json',
      })
    } else if (!existsSync(join(target, 'package.json'))) {
      findings.push({
        level: 'warn', code: 'link-without-manifest',
        title: `link 目标没有 package.json：${name}`,
        detail: target,
        evidence: 'package.json',
      })
    }
  }

  const bundles = manifest.dsh?.profile?.bundles
  if (Array.isArray(bundles)) {
    for (const bundle of bundles) {
      if (typeof bundle !== 'string' || isHostPackage(bundle)) continue
      if (!existsSync(join(nodeModules, bundle))) {
        findings.push({
          level: 'error', code: 'bundle-missing',
          title: `dsh.profile.bundles 里列了但没装的组合包：${bundle}`,
          detail: '组合包在启动时会被加载，缺失会让 profile 起不来',
          evidence: 'package.json',
        })
      }
    }
  }

  return { findings, rows }
}

/** 当前 profile 目录（找不到时返回 null）。 */
export function auditProfileDir() {
  return resolveProfileDir()
}

/** 备份文件清单（新的在前）。 */
export function listPatchBackups(profileDir) {
  let names = []
  try {
    names = readdirSync(profileDir)
  } catch {
    return []
  }
  return names
    .filter((name) => name.startsWith('cordis.patch.yml.bak-'))
    .map((name) => ({ name, at: mtime(join(profileDir, name)) }))
    .sort((a, b) => b.at - a.at)
}

function mtime(path) {
  try { return statSync(path).mtimeMs } catch { return 0 }
}
