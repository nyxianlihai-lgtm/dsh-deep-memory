import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dshmem-extract-'))
process.env.DSH_HOME = home

const { parseProposal, applyProposal, buildPrompt } = await import('../lib/extract.js')
const { Memory } = await import('../lib/memory.js')
const { storeFile } = await import('../lib/store.js')
const { DEFAULTS } = await import('../lib/config.js')

let seq = 0
function make() {
  seq += 1
  return new Memory({
    globalFile: storeFile('g' + seq),
    scopeFile: storeFile('w' + seq),
    scopeId: 'ws:test',
    cfg: { ...DEFAULTS, consolidateHours: 0 },
  })
}

test('能从代码块里解析 JSON', () => {
  const text = '好的，这是结果：\n```json\n{"facts":[{"subject":"user","text":"用户对芒果过敏","importance":0.8}],"topic":"过敏"}\n```'
  const p = parseProposal(text)
  assert.ok(p)
  assert.equal(p.facts.length, 1)
  assert.equal(p.facts[0].subject, 'user')
  assert.equal(p.facts[0].importance, 0.8)
  assert.equal(p.topic, '过敏')
})

test('脏输出返回 null，不抛', () => {
  assert.equal(parseProposal(''), null)
  assert.equal(parseProposal('没有 JSON'), null)
  assert.equal(parseProposal('{坏的}'), null)
  assert.equal(parseProposal('[1,2,3]'), null)
})

test('字段越界会被截断/丢弃', () => {
  const p = parseProposal(JSON.stringify({
    facts: [
      { subject: '外星人', text: 'x'.repeat(300), confidence: 9, importance: -3 },
      { text: '' },
      null,
    ],
    pending: [{ text: '等评审', due: '不是日期' }],
    resolved: [{ id: 'p123', state: 'expired' }],
  }))
  assert.equal(p.facts.length, 1)
  assert.equal(p.facts[0].subject, 'user')
  assert.equal(p.facts[0].text.length, 120)
  assert.equal(p.facts[0].confidence, 1)
  assert.equal(p.facts[0].importance, 0)
  assert.equal(p.pending[0].due, '')
  assert.equal(p.resolved[0].state, 'expired')
})

test('应用：user 进全局、project 进工作区、事项能结清', () => {
  const m = make()
  const pend = m.addPending({ text: '等发布评审', due: '2999-01-01' })
  const p = parseProposal(JSON.stringify({
    facts: [
      { subject: 'user', text: '用户习惯用 Windows 开发', importance: 0.7 },
      { subject: 'project', text: '这个项目用 pnpm 而不是 npm' },
    ],
    events: [{ text: '一起定下了记忆系统的分层方案', tEvent: '2026-10-30' }],
    pending: [{ text: '把测试跑通' }],
    resolved: [{ id: pend.item.id, state: 'done' }],
  }))
  const out = applyProposal(m, p)
  assert.equal(out.facts, 2)
  assert.equal(out.events, 1)
  assert.equal(out.pending, 1)
  assert.equal(out.resolved, 1)
  assert.equal(m.global.data.facts.length, 1)
  assert.equal(m.local.data.facts.length, 1)
  assert.equal(m.local.data.pending.find((x) => x.id === pend.item.id).state, 'done')
})

test('提炼出来的密钥也会被脱敏', () => {
  const m = make()
  const p = parseProposal(JSON.stringify({
    facts: [{ subject: 'project', text: '部署 token: ghp_abcdefghijklmnopqrstuvwxyz123456' }],
  }))
  const out = applyProposal(m, p)
  assert.equal(out.redacted, 1)
  assert.ok(!m.local.data.facts[0].text.includes('ghp_'))
})

test('提示词带上今天和已有事实，且不含真实模板变量', () => {
  const { system, user } = buildPrompt({
    date: '2026-10-31',
    existingFacts: '- 用户对芒果过敏',
    openPending: '- p1：等评审',
    transcript: '用户：我用 pnpm',
  })
  assert.match(system, /2026-10-31/)
  assert.match(system, /用户对芒果过敏/)
  assert.match(system, /p1：等评审/)
  assert.ok(!system.includes('{{'))
  assert.match(user, /pnpm/)
})

test('自动提炼的画像字段也会脱敏后落盘', () => {
  const m = make()
  const secret = 'ghp_' + 'a'.repeat(32)
  const proposal = parseProposal(JSON.stringify({ profile: {
    address: secret, style: [secret], agreements: [secret], boundaries: [secret],
  } }))
  applyProposal(m, proposal)
  const stored = JSON.stringify(m.global.data.profile)
  assert.ok(!stored.includes('ghp_'), stored)
  assert.match(stored, /已隐去/)
})
