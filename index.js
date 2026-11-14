/**
 * dsh-shell-kit — 宿主半边的装载外壳（loader shim）。
 *
 * 为什么要这一层：同一条 loader 行的模块 URL 在进程生命周期内固定，Node 的 ESM
 * 缓存会一直返回第一次加载的对象 —— 于是"在运行中的 DSH 上覆盖安装"仍旧执行旧代码。
 * dsh-quick-restart 当初的办法是给入口加内容哈希查询串，但那只解决了入口一层：
 * 入口里 `import './core.js'` 这类**静态** import 仍然是稳定 URL，改了 core.js
 * 照样跑旧代码（我在那边踩过一次）。
 *
 * 这次换更彻底的做法：把整个 lib/ 按内容哈希**暂存到**
 *   <数据目录>/instances/<hash>/
 * 再从那个目录 import。版本一变，所有文件的物理路径都变，静态 import 也不会撞缓存，
 * 代码保持可读的自然写法。实例目录只留最近 3 份。
 *
 * 因此本文件必须保持稳定：它自身的改动才需要重启。
 */
import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
const LIB_DIR = join(PACKAGE_DIR, 'lib')
const IMPL = join(LIB_DIR, 'host.js')

function dataDir() {
  const fromEnv = process.env.DSH_HOME
  const home = typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : join(homedir(), '.dsh')
  return join(home, 'dsh-shell-kit')
}

/**
 * 装载面包屑。宿主里没有控制台，插件 stdout/stderr 看不到；挂载失败时
 * <数据目录>/load.log 是唯一能说清"走到哪一步、报了什么错"的地方。
 */
function breadcrumb(line) {
  try {
    mkdirSync(dataDir(), { recursive: true })
    appendFileSync(join(dataDir(), 'load.log'), `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch { /* 记不下来就算了，不能因此让插件挂不了 */ }
}

/** lib/ 下所有文件（递归）的内容哈希：任何一个实现文件变了，实例目录就换一个。 */
function implementationVersion() {
  const hash = createHash('sha256')
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name)
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        hash.update(`${relative}/`)
        walk(full, relative)
      } else {
        hash.update(relative)
        hash.update(readFileSync(full))
      }
    }
  }
  try {
    walk(LIB_DIR, '')
    return hash.digest('hex').slice(0, 16)
  } catch {
    return null
  }
}

/**
 * 把 lib/ 暂存到实例目录（同版本已存在就复用），并只保留最近 3 份。
 *
 * "已存在就复用"的判据是 **host.js 在不在**，而不是目录在不在：目录可能因为一次中途失败
 * （磁盘满、进程被杀）而残缺，甚至只是一个空壳 —— 那时复用等于 import 一份不存在的实现。
 * 所以拷贝也改成先落到 `<version>.staging-<pid>` 再 rename 就位（同目录内 rename 是原子的）：
 * "host.js 在" 因此等价于 "这份快照完整"，残缺目录会被直接重做一次。
 */
function packageVersion() {
  try {
    const raw = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
    return typeof raw.version === 'string' && raw.version.trim() !== '' ? raw.version.trim() : null
  } catch {
    return null
  }
}

/**
 * 把 package.json 的版本写进实例目录。
 *
 * lib/ 被拷到 `<数据目录>/instances/<hash>/` 之后，旁边没有 package.json，
 * 实现层的 core.js 只能靠这份 version.json 报版本（否则就得写死一个字面量，
 * 然后跟 package.json 分叉 —— 0.1.2 对 0.2.0 就是这么来的）。
 * 幂等：每次装载都刷新一遍，改版本号不必等实例目录换哈希。
 */
function writeStagedVersion(dir) {
  const version = packageVersion()
  if (version === null) return
  try {
    writeFileSync(join(dir, 'version.json'), `${JSON.stringify({ version })}\n`, 'utf8')
  } catch { /* 写不进去就靠 core.js 的下一条查找路径 */ }
}

function stageLib(version) {
  const instances = join(dataDir(), 'instances')
  const target = join(instances, version)
  if (!existsSync(join(target, 'host.js'))) {
    mkdirSync(instances, { recursive: true })
    const staging = `${target}.staging-${process.pid}`
    rmSync(staging, { recursive: true, force: true })
    cpSync(LIB_DIR, staging, { recursive: true })
    writeStagedVersion(staging)
    rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
  } else {
    writeStagedVersion(target)
  }
  try {
    const kept = readdirSync(instances, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, at: statSync(join(instances, entry.name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
    for (const old of kept.slice(3)) rmSync(join(instances, old.name), { recursive: true, force: true })
  } catch { /* 清理失败不影响加载 */ }
  return join(target, 'host.js')
}

/**
 * 导入实现：有当前文件版本号就导入暂存副本，没有就直接导原文件。
 * @param {string|null} version `implementationVersion()` 的结果，由调用方算一次传进来
 *   （它要读文件 + 算 sha256，在 apply 里重复算一遍纯属浪费）。
 */
async function loadImpl(version) {
  if (version === null) return await import(pathToFileURL(IMPL).href)
  return await import(pathToFileURL(stageLib(version)).href)
}

/** 本壳只依赖 webServer；模块、命令、工具都在实现里各自按需注入。 */
export const inject = ['webServer']
export const name = 'dsh-shell-kit'

export async function apply(ctx, config) {
  breadcrumb(`apply() 开始（config=${JSON.stringify(config ?? null)}）`)
  try {
    const version = implementationVersion()
    breadcrumb(`实现版本=${String(version)}`)
    const mod = await loadImpl(version)
    breadcrumb('实现已导入')
    /*
     * ⚠️ 这里**不能写 `return await ctx.plugin(...)`**。
     *
     * ctx.plugin() 返回的是 fiber，而 fiber 是 thenable；cordis 会把 apply() 的返回值
     * 当成 effect 收集，于是这个子 fiber 刚建好就被拆掉 —— 症状极具误导性：
     * 实现里的 apply() 明明跑完了、路由也注册进了 webServer 的 exact 表（表大小 +N、
     * has(path) 为 true），但紧接着 disposer 一跑，外部请求全部 401。
     * 该子 fiber 由 loader 的条目生命周期持有，壳不需要、也不该把它交出去。
     */
    await ctx.plugin(mod.default ?? mod, config)
    breadcrumb('ctx.plugin() 完成（未交出返回值）')
  } catch (error) {
    breadcrumb(`装载失败：${error?.stack ?? error?.message ?? String(error)}`)
    throw error
  }
}
