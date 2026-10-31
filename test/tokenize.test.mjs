import test from 'node:test'
import assert from 'node:assert/strict'
import { tokens } from '../lib/tokenize.js'

test('英文标识符按 camelCase / 点号拆开', () => {
  const t = tokens('MemoryV3.recall 里 workspaceKey 这个 bug 还没修')
  for (const w of ['memory', 'recall', 'workspace', 'key', 'bug']) {
    assert.ok(t.has(w), `缺少 ${w}`)
  }
})

test('路径按段拆开', () => {
  const t = tokens('bot/src/memory-v3.js')
  for (const w of ['bot', 'src', 'memory', 'v3', 'js']) {
    assert.ok(t.has(w), `缺少 ${w}`)
  }
})

test('中文二字能命中', () => {
  const t = tokens('我对芒果过敏')
  assert.ok(t.has('芒果'))
  assert.ok(t.has('过敏'))
})

test('纯停用词不产生词', () => {
  assert.equal(tokens('的了是在').size, 0)
})

test('单字母和停用英文词被丢掉', () => {
  const t = tokens('a the and use pnpm')
  assert.ok(!t.has('a'))
  assert.ok(!t.has('the'))
  assert.ok(!t.has('and'))
  assert.ok(!t.has('use'))
  assert.ok(t.has('pnpm'))
})
