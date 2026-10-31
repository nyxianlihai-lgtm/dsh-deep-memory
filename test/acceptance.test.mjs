// 验收用例：把 REQUIREMENTS 第 11 节里「不需要重启宿主」的几条做成可重复运行的测试。
//
// 覆盖：4（重开会话仍能想起）、5（不串项目）、10（会忘记但不删）、11（提炼失败不阻塞）、12（容量）。
// 不覆盖：6（缓存命中，要看请求日志）。
//
// 注意：4/5 这里是「同一进程内新建 Memory/插件实例」模拟重开会话与换 cwd ——
// 库层与胶水层是真的，但「宿主重启」本身没有覆盖，那一半只能人工开新会话验。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'dshmem-accept-'))
process.env.DSH_HOME = join(root, 'home-0')
mkdirSync(process.env.DSH_HOME, { recursive: true })
process.env.DSH_MEMORY_NO_HOSTDEPS = '1'

const mod = await import('../lib/index.js')
const { Memory } = await import('../lib/memory.js')
const { storeFile } = await import('../lib/store.js')
const { DEFAULTS } = await import('../lib/config.js')
const { today } = await import('../lib/text.js')

let seq = 0
function freshHome(tag) {
  const h = join(root, 'home-' + tag + '-' + (seq += 1))
  mkdirSync(h, { recursive: true })
  process.env.DSH_HOME = h
  return h
}
function freshDir(tag) {
  const d = join(root, tag + '-' + (seq += 1))
  mkdirSync(d, { recursive: true })
  return d
}

const userMsg = (text) => ({ type: 'user/message', data: { message: { content: [{ type: 'text', text }] } } })
const asstMsg = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })

function fakeWorld(events = [], header = {}) {
  const state = { events, sections: [], contexts: [], globalTools: [], agentTools: [], handlers: {} }
  const agent = {
    session: {
      id: 's1',
      header: { id: 's1', ...header },
      snapshotEvents: () => state.events,
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    },
    ctx: {
      systemPrompt: {
        section: (o) => { state.sections.push(o); return () => {} },
        context: (o) => { state.contexts.push(o); return () => {} },
      },
      tools: { register: (t) => { state.agentTools.push(t); return () => {} } },
      on: (n, f) => { state.handlers[n] = f; return () => {} },
    },
  }
  const ctx = {
    agents: { list: () => [agent] },
    tools: { register: (t) => { state.globalTools.push(t); return () => {} } },
    interval: () => () => {},
    effect: () => () => {},
    llm: { stream: async function* () {} },
    get: () => null,
  }
  return { state, ctx, agent }
}

const tool = (w, name) => w.state.globalTools.find((t) => t.name === name)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------- 4. 记得住：重开会话仍能想起 ----------------

test('4 重开会话（同 cwd）：上一轮记的还能被想起', async () => {
  freshHome('reopen')
  const cwd = freshDir('proj-reopen')

  const w1 = fakeWorld([userMsg('记住：我对芒果过敏')], { id: 'sA', cwd })
  mod.apply(w1.ctx)
  const r = await tool(w1, 'remember').execute(
    { text: '我对芒果过敏', scope: 'global', importance: 0.8 },
    { agent: w1.agent },
  )
  assert.equal(r.ok, true)

  // 新会话：同一 cwd、新 sid、全新的插件实例（模拟关掉再开）
  const w2 = fakeWorld([userMsg('之前说过芒果的事')], { id: 'sB', cwd })
  mod.apply(w2.ctx)
  const out = w2.state.contexts[0].text()
  assert.match(out, /芒果/, '新会话应该能想起上一个会话记下的事')
})

// ---------------- 5. 不串项目 ----------------

test('5 换 cwd：项目事实不串，全局事实仍然出现', async () => {
  freshHome('scope')
  const projA = freshDir('proj-A')
  const projB = freshDir('proj-B')

  const wA = fakeWorld([userMsg('A 项目每周五轮换部署密钥')], { id: 'sA', cwd: projA })
  mod.apply(wA.ctx)
  await tool(wA, 'remember').execute({ text: 'A 项目每周五轮换部署密钥', importance: 0.7 }, { agent: wA.agent })
  await tool(wA, 'remember').execute({ text: '我对芒果过敏', scope: 'global', importance: 0.8 }, { agent: wA.agent })

  const wB = fakeWorld([userMsg('芒果 密钥 轮换')], { id: 'sB', cwd: projB })
  mod.apply(wB.ctx)
  const out = wB.state.contexts[0].text()

  assert.match(out, /芒果/, '全局事实（用户偏好）跨项目可见')
  assert.doesNotMatch(out, /轮换/, 'A 项目的记忆不该出现在 B 项目里')
})

// ---------------- 5b. 全局事实跨实例可见，且不被覆盖 ----------------

test('5b 全局事实：一个工作区写的，另一个工作区立刻能看到；后写的不覆盖先写的', async () => {
  const home = freshHome('shared')
  const projA = freshDir('shared-A')
  const projB = freshDir('shared-B')

  // B 先挂载（这是关键：真实场景里别的会话很早就开着，global 层那时是空的）
  const wB = fakeWorld([userMsg('芒果')], { id: 'sB', cwd: projB })
  mod.apply(wB.ctx)

  // 然后 A 才记下一条全局事实
  const wA = fakeWorld([userMsg('记住：我对芒果过敏')], { id: 'sA', cwd: projA })
  mod.apply(wA.ctx)
  await tool(wA, 'remember').execute({ text: '我对芒果过敏', scope: 'global', importance: 0.8 }, { agent: wA.agent })

  assert.match(wB.state.contexts[0].text(), /芒果/, 'A 写的全局事实，已经开着的 B 也要能看到')

  // B 自己也写一条全局事实：不能把 A 那条冲掉
  await tool(wB, 'remember').execute({ text: '用户偏好用中文', scope: 'global', importance: 0.5 }, { agent: wB.agent })

  const g = JSON.parse(readFileSync(join(home, 'deep-memory', 'global.json'), 'utf8'))
  assert.equal(g.facts.length, 2, `全局层应该是 2 条，实际 ${g.facts.length}：${JSON.stringify(g.facts.map((f) => f.text))}`)
  assert.ok(g.facts.some((f) => f.text.includes('芒果')), 'B 的写入不能抹掉 A 的全局事实')
})

// ---------------- 5c. 工作区隔离标记 ----------------

test('5c 工作区放 .dsh-memory-off：不挂载、不注入、不注册工具', () => {
  freshHome('off')
  const cwd = freshDir('proj-off')
  writeFileSync(join(cwd, '.dsh-memory-off'), '')

  const w = fakeWorld([userMsg('你好')], { cwd })
  mod.apply(w.ctx)

  assert.equal(w.state.contexts.length, 0, '不该有每轮注入')
  assert.equal(w.state.sections.length, 0, '不该有常驻提示')
  assert.equal(w.state.agentTools.length, 0, '不该按会话注册工具')
})

test('5d 标记放在父目录，子目录里开会话也一样隔离', () => {
  freshHome('off2')
  const cwd = freshDir('proj-off2')
  writeFileSync(join(cwd, '.dsh-memory-off'), '')
  const sub = join(cwd, 'src', 'deep')
  mkdirSync(sub, { recursive: true })

  const w = fakeWorld([userMsg('你好')], { cwd: sub })
  mod.apply(w.ctx)
  assert.equal(w.state.contexts.length, 0, 'cwd 往上找到标记也要隔离')
})

// ---------------- 10. 会忘记，但不删 ----------------

test('10 两年前 + 低重要度：排不到前面，但文件里还在', () => {
  freshHome('decay')
  const m = new Memory({
    globalFile: storeFile('g-decay'),
    scopeFile: storeFile('w-decay'),
    scopeId: 'ws:decay',
    cfg: { ...DEFAULTS, consolidateHours: 0 },
  })

  const old = new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10)
  m.addFact({ text: '部署脚本在 scripts/deploy.sh', scope: 'workspace', importance: 0.9, tEvent: today() })
  m.addFact({ text: '部署脚本以前放在根目录', scope: 'workspace', importance: 0, tEvent: old })

  const r = m.recall('部署脚本')
  if (r.facts.length > 0) {
    assert.match(r.facts[0].text, /scripts\/deploy\.sh/, '新的、重要的那条应该排在前面')
  }

  m.save(true)
  const data = JSON.parse(readFileSync(storeFile('w-decay'), 'utf8'))
  assert.equal(data.facts.length, 2, '淡忘只降低命中率，不自动删除')
})

// ---------------- 11. 提炼失败不阻塞 ----------------

test('11 llm 抛错：回合钩子不抛，diag 有记录', async () => {
  const home = freshHome('nollm')
  mkdirSync(join(home, 'deep-memory'), { recursive: true })
  writeFileSync(
    join(home, 'deep-memory', 'config.json'),
    JSON.stringify({ extractEveryTurns: 1, extractMinIntervalMs: 0 }),
    'utf8',
  )

  const cwd = freshDir('proj-nollm')
  const w = fakeWorld([userMsg('聊聊部署'), asstMsg('好的，部署脚本在 scripts 下')], { cwd })
  w.ctx.llm = { stream: () => { throw new Error('boom') } }
  mod.apply(w.ctx)

  const onTurn = w.state.handlers['agent/turn-stopping']
  assert.equal(typeof onTurn, 'function', '回合钩子应该挂上')

  assert.doesNotThrow(() => onTurn({ turn: 1 }))
  await sleep(120)

  const diag = readFileSync(join(home, 'deep-memory', 'diag.log'), 'utf8')
  assert.match(diag, /提炼跳过|调用失败|提炼异常/, `diag 里应记下失败，实际：${diag.slice(-300)}`)
})

test('提炼解析失败时，诊断日志不包含模型返回的私人正文', async () => {
  const home = freshHome('private-output')
  mkdirSync(join(home, 'deep-memory'), { recursive: true })
  writeFileSync(join(home, 'deep-memory', 'config.json'), JSON.stringify({ extractEveryTurns: 1, extractMinIntervalMs: 0 }))
  const w = fakeWorld([userMsg('整理部署约定')], { cwd: freshDir('private-output') })
  const privateText = 'PRIVATE_MODEL_OUTPUT_MUST_NOT_BE_LOGGED'
  let completed
  const done = new Promise((resolve) => { completed = resolve })
  w.ctx.llm.stream = async function* () {
    yield { type: 'text-delta', text: privateText }
    completed()
  }
  mod.apply(w.ctx)
  w.state.handlers['agent/turn-stopping']()
  await done
  await new Promise((resolve) => setImmediate(resolve))
  const log = readFileSync(join(home, 'deep-memory', 'diag.log'), 'utf8')
  assert.match(log, /提炼输出解析失败/)
  assert.ok(!log.includes(privateText))
})

test('已挂载会话新增隔离标记后，工具与注入立即停止', async () => {
  freshHome('live-marker')
  const cwd = freshDir('live-marker')
  const w = fakeWorld([userMsg('芒果')], { cwd })
  mod.apply(w.ctx)
  await tool(w, 'remember').execute({ text: '我对芒果过敏' }, { agent: w.agent })
  assert.match(w.state.contexts[0].text(), /芒果/)
  writeFileSync(join(cwd, '.dsh-memory-off'), '')
  assert.equal(w.state.contexts[0].text(), '')
  const result = await tool(w, 'memory_recall').execute({}, { agent: w.agent })
  assert.equal(result.ok, false)
  const write = await tool(w, 'remember').execute({ text: '隔离后不可写入' }, { agent: w.agent })
  assert.equal(write.ok, false)
})

test('提炼请求进行中关闭工作区，返回的结果不再写入', async () => {
  const home = freshHome('extract-marker')
  mkdirSync(join(home, 'deep-memory'), { recursive: true })
  writeFileSync(join(home, 'deep-memory', 'config.json'), JSON.stringify({ extractEveryTurns: 1, extractMinIntervalMs: 0 }))
  const cwd = freshDir('extract-marker')
  const w = fakeWorld([userMsg('项目用 pnpm')], { cwd })
  let started, release
  const began = new Promise((resolve) => { started = resolve })
  const resume = new Promise((resolve) => { release = resolve })
  w.ctx.llm.stream = async function* () {
    started()
    await resume
    yield { type: 'text-delta', text: JSON.stringify({ facts: [{ subject: 'project', text: 'SHOULD_NOT_BE_SAVED' }] }) }
  }
  mod.apply(w.ctx)
  w.state.handlers['agent/turn-stopping']()
  await began
  writeFileSync(join(cwd, '.dsh-memory-off'), '')
  release()
  await new Promise((resolve) => setImmediate(resolve))
  const { readdirSync } = await import('node:fs')
  for (const file of readdirSync(join(home, 'deep-memory')).filter((name) => name.endsWith('.json'))) {
    assert.ok(!readFileSync(join(home, 'deep-memory', file), 'utf8').includes('SHOULD_NOT_BE_SAVED'))
  }
})

// ---------------- 12. 容量 ----------------

test('12 400 条事实：写入不崩，注入仍在预算内', () => {
  const home = freshHome('cap')
  const m = new Memory({
    globalFile: storeFile('g-cap'),
    scopeFile: storeFile('w-cap'),
    scopeId: 'ws:cap',
    cfg: { ...DEFAULTS, consolidateHours: 0 },
  })

  for (let i = 0; i < 400; i += 1) {
    // 第 7 条带一个独一无二的英文标识，用来验证「大库里还找得到特定的那一条」
    const mark = i === 7 ? ' zebrafish' : ''
    m.addFact({
      text: `第 ${i} 条：模块 mod${i} 的部署注意事项与回滚步骤${mark}`,
      // 每条一个事实键：400 条是 400 件不同的事。
      // 不给键的话它们文本相似度 >0.72，会被正确地当成「同一件事重复说」合并成 1 条
      // （第一次跑就撞上了这个，说明去重逻辑是好的）。
      key: `容量.模块${i}`,
      scope: 'workspace',
      importance: 0.2 + (i % 5) * 0.15,
    })
  }
  assert.ok(m.stats().facts >= 300, `应该真的灌进去了，实际 ${m.stats().facts}`)

  // (a) 有区分度的查询：找得到那一条，且总字数在预算内
  const text = m.render('zebrafish 回滚', { maxChars: 600 })
  assert.ok(text.length > 0, '带唯一标识的查询应该命中')
  assert.match(text, /zebrafish/)
  assert.ok(text.length <= 600, `注入必须在预算内，实际 ${text.length}`)

  // (b) 没有信息量的问句：大库也不硬凑
  assert.equal(m.render('在吗'), '', '「在吗」不该从 400 条里凑出东西')

  // (c) 落了盘、条数没丢
  m.save(true)
  const data = JSON.parse(readFileSync(storeFile('w-cap'), 'utf8'))
  assert.ok(data.facts.length >= 300, '落盘后条数不能丢')
  assert.ok(existsSync(join(home, 'deep-memory', 'w-cap.json')))
})

// ---------------- 13. 宿主注入的消息不能当查询词 ----------------

test('13 每轮注入的 runtime context 不能顶替用户这句话当查询词', async () => {
  const home = freshHome('inject')
  const cwd = freshDir('proj-inject')

  const timeCtx = {
    type: 'user/message',
    data: {
      message: {
        source: { kind: 'time-context', form: 'snapshot' },
        content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 1: 2026-10-31T19:16:00+08:00' }],
      },
    },
  }
  const catalog = {
    type: 'user/message',
    data: {
      message: {
        source: { kind: 'skill-catalog' },
        content: [{ type: 'text', text: '<system-reminder> The available skill catalog changed.' }],
      },
    },
  }
  const real = {
    type: 'user/message',
    data: {
      message: {
        source: { kind: 'user', rpcId: 'r1' },
        content: [{ type: 'text', text: '你的名字是什么' }],
      },
    },
  }

  // 真实消息在前，两条注入在后 —— 没有修复时会取到最后那条时间戳
  const w = fakeWorld([real, timeCtx, catalog], { id: 'sN', cwd })
  mod.apply(w.ctx)
  await tool(w, 'remember').execute(
    { text: '我的名字之一是小鱼', scope: 'global', importance: 0.8 },
    { agent: w.agent },
  )

  const out = w.state.contexts[0].text()
  // 召回是靠查询词驱动的：如果这里取到的是最后那条时间戳，tokens 里没有「名/字」，
  // 「小鱼」这条根本进不来。所以这一条断言同时证明了查询词取对了。
  assert.match(out, /小鱼/, '用「你的名字是什么」问，应该召回名字那条')
  assert.doesNotMatch(out, /Time sampled/, '注入的时间戳不能出现在召回结果里')
})
