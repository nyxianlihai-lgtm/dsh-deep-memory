import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dshmem-mem-'))
process.env.DSH_HOME = home

const { Memory } = await import('../lib/memory.js')
const { storeFile } = await import('../lib/store.js')
const { DEFAULTS } = await import('../lib/config.js')

let seq = 0
function make(cfg = {}) {
  seq += 1
  return new Memory({
    globalFile: storeFile('g' + seq),
    scopeFile: storeFile('w' + seq),
    scopeId: 'ws:test',
    cfg: { ...DEFAULTS, consolidateHours: 0, ...cfg },
  })
}

test('同一事实键：新版本取代旧版本，旧的仍保留', () => {
  const m = make()
  const a = m.addFact({ subject: 'user', text: '用户偏好用中文回复', key: '用户.回复语言', scope: 'global', importance: 0.7 })
  assert.equal(a.ok, true)
  const b = m.addFact({ subject: 'user', text: '用户偏好用英文回复', key: '用户.回复语言', scope: 'global', importance: 0.9 })
  assert.equal(b.ok, true)

  const facts = m.global.data.facts
  assert.equal(facts.length, 2)
  const old = facts.find((f) => f.id === a.item.id)
  assert.equal(old.status, 'superseded')
  assert.equal(old.replacedBy, b.item.id)
  assert.equal(b.item.supersedes, a.item.id)
  assert.equal(facts.filter((f) => f.status === 'current').length, 1)
})

test('没给键、内容一样：只强化不重复记', () => {
  const m = make()
  m.addFact({ subject: 'project', text: '项目用 pnpm 管理依赖', scope: 'workspace' })
  m.addFact({ subject: 'project', text: '项目用 pnpm 管理依赖', scope: 'workspace' })
  const facts = m.local.data.facts
  assert.equal(facts.length, 1)
  assert.ok(facts[0].confirm >= 2)
})

test('scope 路由：user 进全局层，project 进工作区层', () => {
  const m = make()
  m.addFact({ subject: 'user', text: '用户对芒果过敏', scope: 'global' })
  m.addFact({ subject: 'project', text: '这个仓库禁止直接 push main', scope: 'workspace' })
  assert.equal(m.global.data.facts.length, 1)
  assert.equal(m.local.data.facts.length, 1)
  assert.equal(m.stats().facts, 2)
})

test('空库 / 无信息量的问句：不硬凑', () => {
  const m = make()
  assert.deepEqual(m.recall('在吗').facts, [])
  m.addFact({ subject: 'user', text: '用户对芒果过敏', scope: 'global' })
  const r = m.recall('在吗')
  assert.equal(r.facts.length, 0)
  assert.equal(r.record.gated, true)
})

test('相关问句能召回相关事实', () => {
  const m = make()
  m.addFact({ subject: 'user', text: '用户对芒果过敏', scope: 'global', importance: 0.8 })
  m.addFact({ subject: 'project', text: '项目用 pnpm 管理依赖', scope: 'workspace' })
  const r = m.recall('之前说过芒果的事')
  assert.ok(r.facts.some((f) => f.text.includes('芒果')))
})

test('画像常驻：问句没信息量也照样注入', () => {
  const m = make()
  m.updateProfile({ address: '老板', style: ['先给结论再解释'] })
  m.addFact({ subject: 'user', text: '用户对芒果过敏', scope: 'global' })
  const text = m.render('在吗')
  assert.match(text, /老板/)
  assert.match(text, /先给结论/)
})

test('注入有字数预算', () => {
  const m = make()
  const long = '项目事实' + '这是一段很长的说明'.repeat(6)
  for (let i = 0; i < 4; i += 1) m.addFact({ subject: 'project', text: long + i, key: '项目.事实' + i, scope: 'workspace' })
  const text = m.render('项目事实 说明', { maxChars: 260 })
  assert.ok(text.length > 0, '应该至少带进来一条')
  assert.ok(text.length <= 260, `实际 ${text.length}`)
})

test('写入前脱敏', () => {
  const m = make()
  const r = m.addFact({ subject: 'user', text: '我的 key 是 sk-abcdefghijklmnopqrstuv', scope: 'global' })
  assert.equal(r.redacted, true)
  assert.ok(!m.global.data.facts[0].text.includes('sk-abc'))
  assert.match(m.global.data.facts[0].text, /已隐去/)
})

test('过期事项在整理时归档', () => {
  const m = make()
  m.addPending({ text: '等体检结果', due: '2020-01-01' })
  m.addPending({ text: '等发布评审', due: '2999-01-01' })
  const out = m.local.consolidate(DEFAULTS)
  assert.equal(out.expired, 1)
  const states = m.local.data.pending.map((p) => p.state).sort()
  assert.deepEqual(states, ['expired', 'open'])
})

test('删除按 id 生效', () => {
  const m = make()
  const r = m.addFact({ subject: 'project', text: '项目用 pnpm', scope: 'workspace' })
  assert.equal(m.delete(r.item.id), 'facts')
  assert.equal(m.stats().facts, 0)
  assert.equal(m.delete('不存在'), null)
})
