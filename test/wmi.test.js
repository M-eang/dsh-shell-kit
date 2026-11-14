/**
 * 逃生路线的实测：WMI 拉起一个替身脚本，确认它真的跑起来（并写出了标记文件）。
 *
 * 这条路径的存在理由是「助手必须活过杀掉壳那一步」——桌面端把宿主放进
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的作业对象，只有换父进程（WmiPrvSE.exe
 * 不在作业里）才能真正脱离。作业语义没法在单测里复现，但下面几件事都是这条
 * 路线真会坏的环节，而且坏掉时引擎会静默退回 detached Node、用户只看到
 * 「重启偶尔失败」，所以必须实测：
 *   · WMI 能不能创建进程、能不能把带空格的路径当命令行传对（临时目录故意带空格）；
 *   · `Win32_ProcessStartup.EnvironmentVariables` 是整块替换，缺了 SystemRoot/TEMP
 *     子进程就起不来——这里断言替身脚本拿到了完整环境与 `ELECTRON_RUN_AS_NODE=1`；
 *   · 返回的 PID 是不是那个真跑起来的进程（不是一段中间 shell 的）。
 * 只在 Windows 上跑；其它平台直接跳过。
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { launchViaWmi } from '../lib/modules/restart/engine.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

describe('restart wmi escape', { skip: process.platform !== 'win32' }, () => {
  /** @type {string} */
  let dir

  after(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  })

  it('creates the helper process through Win32_Process.Create', async () => {
    // 目录名故意带空格：cmd/命令行二次解析出问题时最先在这里炸。
    dir = mkdtempSync(join(tmpdir(), 'dsh shell kit wmi '))
    const marker = join(dir, 'marker.json')
    const stub = join(dir, 'stub.mjs')
    const config = join(dir, 'config.json')
    // 替身脚本只证明「它被启动了，并且拿到了配置与环境」。
    writeFileSync(stub, [
      "import { readFileSync, writeFileSync } from 'node:fs'",
      "const config = JSON.parse(readFileSync(process.argv[3], 'utf8'))",
      'writeFileSync(config.marker, JSON.stringify({',
      '  tag: config.tag,',
      '  pid: process.pid,',
      '  runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,',
      '  systemRoot: process.env.SystemRoot ?? null,',
      '}), "utf8")',
      '',
    ].join('\n'), 'utf8')
    writeFileSync(config, `${JSON.stringify({ marker, tag: 'wmi' })}\n`, 'utf8')

    const launched = launchViaWmi({
      execPath: process.execPath,
      scriptPath: stub,
      configPath: config,
      workDir: dir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    assert.ok(Number.isInteger(launched.pid) && launched.pid > 0, `没有拿到 PID：${JSON.stringify(launched)}`)

    let seen = null
    for (let attempt = 0; attempt < 40 && seen === null; attempt += 1) {
      await sleep(250)
      try {
        seen = JSON.parse(readFileSync(marker, 'utf8'))
      } catch { /* 还没写出来 */ }
    }
    assert.ok(seen !== null, '替身脚本没有写出标记文件：WMI 创建出来的进程没有真正执行')
    assert.equal(seen.tag, 'wmi')
    assert.equal(seen.runAsNode, '1', '子进程没拿到 ELECTRON_RUN_AS_NODE=1（EnvironmentVariables 传丢了）')
    assert.ok(typeof seen.systemRoot === 'string' && seen.systemRoot !== '', '子进程环境块被截断：连 SystemRoot 都没有')
    assert.equal(seen.pid, launched.pid, 'WMI 报的 PID 与真正执行脚本的进程不是同一个')
  })
})
