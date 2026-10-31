import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dshmem-store-'))
process.env.DSH_HOME = home

const { workspaceScope, storeFile, loadStore, saveStore, blankStore, sessionFileFor } = await import('../lib/store.js')

test('工作区标识稳定，不同目录不同标识', () => {
  const a = join(home, 'proj-a')
  const b = join(home, 'proj-b')
  assert.equal(workspaceScope(a), workspaceScope(a))
  assert.notEqual(workspaceScope(a), workspaceScope(b))
})

test('写进去能原样读回', () => {
  const file = storeFile('roundtrip')
  const data = blankStore('ws:test')
  data.facts.push({ id: 'f1', text: '项目用 pnpm', status: 'current', scope: 'ws:test' })
  data.profile.address = '老板'
  saveStore(file, data)

  const back = loadStore(file, 'ws:test')
  assert.equal(back.facts.length, 1)
  assert.equal(back.facts[0].text, '项目用 pnpm')
  assert.equal(back.profile.address, '老板')
})

test('坏文件从空库开始，不抛异常', () => {
  const file = storeFile('broken')
  writeFileSync(file, '{ 这不是 json', 'utf8')
  const back = loadStore(file, 'ws:test')
  assert.equal(back.facts.length, 0)
  assert.equal(back.scope, 'ws:test')
})

test('保存是原子写：tmp 不会留下来', () => {
  const file = storeFile('atomic')
  saveStore(file, blankStore('ws:test'))
  assert.ok(existsSync(file))
  assert.ok(!existsSync(file + '.tmp'))
  assert.doesNotThrow(() => JSON.parse(readFileSync(file, 'utf8')))
})

test('会话文件路径稳定且按 sid 区分', () => {
  assert.equal(sessionFileFor('abc-1'), sessionFileFor('abc-1'))
  assert.notEqual(sessionFileFor('abc-1'), sessionFileFor('abc-2'))
})
