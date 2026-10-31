import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'dshmem-plugin-'))
const project = join(root, 'project')
mkdirSync(project, { recursive: true })

// 必须在 import 插件之前指好家目录：插件模块顶层会写 diag.log
process.env.DSH_HOME = join(root, 'home-0')
mkdirSync(process.env.DSH_HOME, { recursive: true })
// 不去宿主的 node_modules 里翻真实 defineTool —— 测试要的是确定行为
process.env.DSH_MEMORY_NO_HOSTDEPS = '1'
const mod = await import('../lib/index.js')

function freshHome(tag) {
  const h = join(root, 'home-' + tag)
  mkdirSync(h, { recursive: true })
  process.env.DSH_HOME = h
  return h
}

function fakeWorld(events = [], headerExtra = {}) {
  const state = {
    events,
    sections: [],
    contexts: [],
    globalTools: [],
    agentTools: [],
    handlers: {},
  }
  const agent = {
    session: {
      id: 's1',
      header: { id: 's1', cwd: project, ...headerExtra },
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

const userMsg = (text) => ({ type: 'user/message', data: { message: { content: [{ type: 'text', text }] } } })

test('挂载：注册工具 + 常驻提示 + 每轮注入', () => {
  freshHome('a')
  const w = fakeWorld([userMsg('我对芒果过敏')])
  mod.apply(w.ctx)

  assert.equal(w.state.contexts.length, 1)
  assert.equal(w.state.contexts[0].name, 'deep-memory')
  assert.equal(w.state.contexts[0].interpolate, false, '记忆里有 {{ }} 也不能让宿主当模板解析')
  assert.ok(w.state.contexts[0].order >= 900)

  assert.equal(w.state.sections.length, 1)
  assert.equal(w.state.sections[0].name, 'deep-memory-hint')
  assert.equal(typeof w.state.sections[0].text, 'function')

  assert.ok(w.state.globalTools.some((t) => t.name === 'remember'))
  assert.ok(w.state.globalTools.some((t) => t.name === 'memory_recall'))
  assert.ok(w.state.globalTools.some((t) => t.name === 'memory_forget'))
  assert.ok(w.state.agentTools.some((t) => t.name === 'remember'))

  // 空库不注入任何东西
  assert.equal(w.state.contexts[0].text(), '')
})

test('remember 之后，同一轮就能被注入；数据落在独立目录', async () => {
  const home = freshHome('b')
  const w = fakeWorld([userMsg('我对芒果过敏')])
  mod.apply(w.ctx)

  const remember = w.state.globalTools.find((t) => t.name === 'remember')
  const r = await remember.execute({ text: '我对芒果过敏', importance: 0.9, scope: 'global' }, { agent: w.agent })
  assert.equal(r.ok, true)

  const out = w.state.contexts[0].text()
  assert.match(out, /长期记忆/)
  assert.match(out, /芒果/)

  assert.ok(existsSync(join(home, 'deep-memory', 'global.json')))
  assert.ok(existsSync(join(home, 'deep-memory', 'sessions.json')))
})

test('工具参数不对时明确说没记住，而不是假装成功', async () => {
  freshHome('c')
  const w = fakeWorld([])
  mod.apply(w.ctx)

  const remember = w.state.globalTools.find((t) => t.name === 'remember')
  const r1 = await remember.execute({ text: '   ' }, { agent: w.agent })
  assert.equal(r1.ok, false)
  assert.match(r1.message, /空|没记住/)

  const forget = w.state.globalTools.find((t) => t.name === 'memory_forget')
  const r2 = await forget.execute({ id: 'nope' }, { agent: w.agent })
  assert.equal(r2.ok, false)
})

test('memory_recall 没查到会说没查到', async () => {
  freshHome('d')
  const w = fakeWorld([])
  mod.apply(w.ctx)
  const recall = w.state.globalTools.find((t) => t.name === 'memory_recall')
  const r = await recall.execute({ query: '芒果' }, { agent: w.agent })
  assert.equal(r.ok, true)
  assert.match(r.text, /没找到|空/)
})

test('子代理不挂载，不浪费文件', () => {
  freshHome('e')
  const w = fakeWorld([], { origin: 'subagent' })
  mod.apply(w.ctx)
  assert.equal(w.state.contexts.length, 0)
  assert.equal(w.state.sections.length, 0)
})

test('开关关掉时什么都不挂', () => {
  const home = freshHome('f')
  mkdirSync(join(home, 'deep-memory'), { recursive: true })
  writeFileSync(join(home, 'deep-memory', 'config.json'), JSON.stringify({ enabled: false }), 'utf8')
  const w = fakeWorld([])
  mod.apply(w.ctx)
  assert.equal(w.state.contexts.length, 0)
  assert.equal(w.state.globalTools.length, 0)
})
