/**
 * 助手暂存副本的回归测试：「拷过去的那份」必须和源目录里那份一样能跑。
 *
 * 这组用例来自一次真实故障（2026-10-17）：端口探针拆成 ./ports.js 之后，
 * 暂存逻辑仍然只拷 helper.mjs 一个文件，于是副本在 `import './ports.js'` 处
 * 直接 ERR_MODULE_NOT_FOUND —— 死得比第一行日志还早，宿主只看到
 * 「wmi-detached / node-detached / node-plain 启动后没有写出日志」。
 * 断言两件事：依赖被一起拷过去，且副本能通过 --selftest。
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { stageHelperBundle } from '../lib/modules/restart/engine.js'

const root = mkdtempSync(join(tmpdir(), 'shell-kit-staging-'))

after(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('restart helper staging', () => {
  it('copies the entry script and every relative import it needs', () => {
    const dir = join(root, 'restart')
    const staged = stageHelperBundle({ dir, helperDir: join(dir, 'helper') })

    assert.ok(existsSync(staged), `暂存入口不存在：${staged}`)
    const files = readdirSync(join(dir, 'helper')).sort()
    assert.ok(files.includes('restart-helper.mjs'), `缺入口文件：${files.join(', ')}`)
    // 助手现在 import ./ports.js（端口探针）。少了它副本就跑不起来。
    assert.ok(files.includes('ports.js'), `缺依赖文件 ports.js：${files.join(', ')}`)
  })

  it('the staged copy passes its selftest', () => {
    const dir = join(root, 'restart-selftest')
    const staged = stageHelperBundle({ dir, helperDir: join(dir, 'helper') })
    const probe = spawnSync(process.execPath, [staged, '--selftest'], {
      encoding: 'utf8', timeout: 20000, windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    assert.equal(probe.status, 0, `自检失败：${String(probe.stderr ?? '').trim()}`)
    assert.match(String(probe.stdout ?? ''), /ok/u)
  })
})
