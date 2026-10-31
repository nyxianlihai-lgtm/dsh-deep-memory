import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, copyFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

test('可视化服务支持中文和空格路径，仅提供本地文件', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), '记忆 可视化-'))
  copyFileSync(fileURLToPath(new URL('../viz-kit/serve.mjs', import.meta.url)), join(dir, 'serve.mjs'))
  writeFileSync(join(dir, 'brain.html'), '<h1>memory</h1>')
  const child = spawn(process.execPath, [join(dir, 'serve.mjs'), '0'], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start')), 5000)
    child.once('error', (error) => { clearTimeout(timeout); reject(error) })
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error('Server exited: ' + code)) })
    child.stdout.on('data', (data) => {
      const match = String(data).match(/http:\/\/127\.0\.0\.1:\d+/)
      if (match) { clearTimeout(timeout); resolve(match[0]) }
    })
  })
  const response = await fetch(url)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), '<h1>memory</h1>')
  assert.equal((await fetch(url + '/missing.json')).status, 404)
})
