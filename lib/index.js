// DSH 插件入口：把记忆挂到每个会话上。
//
// 四件事：
//   1. 常驻提示（systemPrompt.section，内容恒定）—— 告诉它"你有长期记忆、可以直接记"
//   2. 每轮注入（systemPrompt.context）—— 只放这一轮想起来的那几条，不破坏系统提示缓存
//   3. 工具（remember / memory_recall / memory_forget）
//   4. 回合钩子（agent/turn-stopping）—— 攒够轮次在后台提炼，失败静默
//
// 注入通道为什么是 context 而不是 section：
//   section 拼进系统提示，内容一变整段 1 万多 token 的缓存全废（fishmem 实测 0.001 -> 0.02）；
//   context 是 DSH 给"每轮会变的内容"准备的，作为一条消息追加在末尾，只在变了才追加。

import { loadConfig } from './config.js'
import { loadHostDeps } from './hostdeps.mjs'
import { Memory } from './memory.js'
import { applyProposal, buildPrompt, parseProposal } from './extract.js'
import { loadSessionMap, saveSessionMap, sessionFileFor, storeFile, workspaceScope, memoryRoot, memoryDisabled } from './store.js'
import { diag } from './log.js'
import { today } from './text.js'

export const name = 'deep-memory'
export const inject = ['systemPrompt', 'agents', 'timer', 'tools', 'llm']

const hostDeps = await loadHostDeps()
const defineTool = hostDeps.defineTool
const createUserMessage = hostDeps.createUserMessage
try { for (const n of hostDeps.notes || []) diag('hostdeps: ' + n) } catch { /* 日志失败不拦加载 */ }

const HINT = [
  '【长期记忆】你有长期记忆，不用等用户提醒：值得长期记住的事，直接用 remember 工具记下来。',
  '值得记：用户明确说的重要偏好、约定、边界；这个项目的决策与理由；踩过的坑；反复强调的做法。',
  '不用记：日常进度、命令输出、一次性的临时状态（这些压缩后自然就没了，别占记忆）。',
  '记忆会在需要时自动被想起来，你不用主动复述；记的时候安静地记，别在回复里说「记下了」。',
].join('\n')

// ---------------- 会话相关的纯工具函数 ----------------

function sessionIdOf(session) {
  if (!session) return ''
  for (const k of ['id', 'sessionId', 'key', 'sessionKey', 'sid']) {
    try {
      const v = session[k]
      if (typeof v === 'string' && v) return v
    } catch { /* 某些字段是 getter，读就抛 */ }
  }
  try {
    const h = session.header
    if (h && typeof h.id === 'string' && h.id) return h.id
  } catch { /* 忽略 */ }
  return ''
}

function cwdOf(agent) {
  try {
    const h = agent && agent.session && agent.session.header
    if (h && typeof h.cwd === 'string' && h.cwd.trim()) return h.cwd
  } catch { /* 忽略 */ }
  try {
    const c = agent && agent.session && agent.session.cwd
    if (typeof c === 'string' && c.trim()) return c
  } catch { /* 忽略 */ }
  return process.cwd()
}

function isSubagent(agent) {
  try {
    const h = agent && agent.session && agent.session.header
    if (!h) return false
    if (h.origin === 'subagent') return true
    if (typeof h.delegationDepth === 'number' && h.delegationDepth > 0) return true
  } catch { /* 忽略 */ }
  return false
}

function textOfMessage(msg) {
  if (!msg) return ''
  if (typeof msg === 'string') return msg
  if (typeof msg.text === 'string') return msg.text
  if (typeof msg.content === 'string') return msg.content
  if (Array.isArray(msg.content)) {
    const parts = []
    for (const b of msg.content) {
      if (typeof b === 'string') parts.push(b)
      else if (b && typeof b.text === 'string') parts.push(b.text)
    }
    return parts.join(' ')
  }
  return ''
}

function snapshotEvents(session) {
  try {
    if (session && typeof session.snapshotEvents === 'function') return session.snapshotEvents() || []
  } catch { /* 忽略 */ }
  return []
}

function messageOfEvent(ev) {
  if (!ev) return null
  const m = (ev.data && ev.data.message) || ev.message || ev.data
  return m && typeof m === 'object' ? m : null
}

function isPluginMessage(msg) {
  try { return Boolean(msg && msg.source && msg.source.kind === 'plugin') } catch { return false }
}

function lastUserText(session, limit = 500) {
  const ev = snapshotEvents(session)
  for (let i = ev.length - 1; i >= 0; i -= 1) {
    const e = ev[i]
    if (!e || e.type !== 'user/message') continue
    const msg = messageOfEvent(e)
    if (isPluginMessage(msg)) continue
    const t = textOfMessage(msg).replace(/\s+/g, ' ').trim()
    // 兜底：万一宿主把注入的那段也收进了 user/message，别拿它当查询词
    if (!t || t.startsWith('【长期记忆')) continue
    return t.slice(0, limit)
  }
  return ''
}

function transcriptOf(session, maxMessages, maxChars) {
  const ev = snapshotEvents(session)
  const lines = []
  for (let i = ev.length - 1; i >= 0 && lines.length < maxMessages; i -= 1) {
    const e = ev[i]
    if (!e) continue
    const role = e.type === 'user/message' ? '用户' : e.type === 'assistant/message' ? '助手' : ''
    if (!role) continue
    const msg = messageOfEvent(e)
    if (isPluginMessage(msg)) continue
    const t = textOfMessage(msg).replace(/\s+/g, ' ').trim()
    if (!t) continue
    lines.push(`${role}：${t.slice(0, 400)}`)
  }
  lines.reverse()
  let text = lines.join('\n')
  if (text.length > maxChars) text = text.slice(text.length - maxChars)
  return text
}

function sessionIdFromExec(exec) {
  try {
    const a = exec && (exec.agent || exec.caller || exec.agentRef)
    if (a && a.session) return sessionIdOf(a.session)
    if (a && typeof a === 'object') {
      for (const k of ['sessionId', 'id']) if (typeof a[k] === 'string') return a[k]
    }
  } catch { /* 忽略 */ }
  return ''
}

// ---------------- 插件本体 ----------------

export function apply(ctx) {
  const cfg = loadConfig()
  if (!cfg.enabled) {
    diag('deep-memory 是关着的（config.json 里 enabled=false），不挂任何东西')
    return
  }

  const mounted = new Map() // sid -> { agent, off }
  // 按「层」缓存，不是按会话：同一个工作区的多个会话必须共用同一个 Memory 实例，
  // 否则各自持有一份内存副本、各自整份回写 → 后写的把先写的覆盖掉（丢记忆）。
  const memories = new Map() // scopeId -> { memory, cwd }
  const bySid = new Map() // sid -> memory
  const extracting = new Set()
  const offNoticed = new Set() // sid -> 已经为它记过一次「被标记关掉」，免得每 800ms 刷日志
  const sessions = loadSessionMap()
  let toolOffs = []
  let stopTick = null

  function memoryFor(sid, cwd) {
    const known = sid && sessions.sessions[sid] ? sessions.sessions[sid] : null
    const useCwd = cwd || (known && known.cwd) || ''
    if (useCwd && memoryDisabled(useCwd)) return null
    const scopeId = useCwd ? 'ws:' + workspaceScope(useCwd) : 'session:' + (sid || 'unknown')
    const scopeFile = useCwd ? storeFile('ws-' + workspaceScope(useCwd)) : sessionFileFor(sid || 'unknown')

    let memory = null
    const cur = memories.get(scopeId)
    if (cur) {
      memory = cur.memory
    } else {
      try {
        memory = new Memory({ globalFile: storeFile('global'), scopeFile, scopeId, cfg: loadConfig() })
      } catch (e) {
        diag('打开记忆库失败：' + (e && e.message))
        return null
      }
      memories.set(scopeId, { memory, cwd: useCwd })
    }

    if (sid) {
      bySid.set(sid, memory)
      sessions.sessions[sid] = { scope: scopeId, cwd: useCwd, at: Date.now() }
      try { saveSessionMap(sessions) } catch { /* 映射丢了不致命 */ }
    }
    return memory
  }

  function renderFor(agent, memory) {
    try {
      const current = loadConfig()
      if (!current.enabled || memoryDisabled(cwdOf(agent))) return ''
      memory.cfg = current
      memory.engine.cfg = current
      const q = lastUserText(agent && agent.session)
      if (!q) return ''
      const text = memory.render(q)
      if (!text) return ''
      return '【长期记忆 · 本轮想起来的部分】\n' + text
    } catch (e) {
      diag('注入渲染失败：' + (e && e.message))
      return ''
    }
  }

  function mountFor(agent, sid) {
    const memory = memoryFor(sid, cwdOf(agent))
    if (!memory) return () => {}
    const offs = []
    const keep = (x) => {
      if (typeof x === 'function') offs.push(x)
      else if (x && typeof x.off === 'function') offs.push(() => x.off())
    }

    const sp = agent && agent.ctx && agent.ctx.systemPrompt
    try {
      if (sp && typeof sp.section === 'function') {
        keep(sp.section({
          name: 'deep-memory-hint',
          order: 89990, // 排在 DSH 自己的段之后：变一次只多花最后这一小段
          interpolate: false,
          text: () => HINT,
        }))
      }
    } catch (e) {
      diag('常驻提示挂不上：' + (e && e.message))
    }

    try {
      if (sp && typeof sp.context === 'function') {
        keep(sp.context({
          name: 'deep-memory',
          order: 900, // 排在沙箱/审批/子代理那几条之后
          interpolate: false, // 记忆里可能有 {{ }}，不能让宿主当模板解析
          text: () => renderFor(agent, memory),
        }))
      } else {
        diag('这个 DSH 版本没有 systemPrompt.context，跳过每轮注入（只剩 remember 工具）')
      }
    } catch (e) {
      diag('每轮注入挂不上：' + (e && e.message))
    }

    try {
      if (agent && agent.ctx && typeof agent.ctx.on === 'function') {
        keep(agent.ctx.on('agent/turn-stopping', () => onTurn(agent, sid)))
      }
    } catch (e) {
      diag('回合钩子挂不上：' + (e && e.message))
    }

    try {
      if (agent && agent.ctx && agent.ctx.tools && typeof agent.ctx.tools.register === 'function') {
        keep(agent.ctx.tools.register(rememberTool))
      }
    } catch (e) {
      diag('按会话注册 remember 失败：' + (e && e.message))
    }

    return () => {
      for (const off of offs) {
        try { off() } catch { /* 卸载失败不影响别的 */ }
      }
    }
  }

  function unmount(sid) {
    const cur = mounted.get(sid)
    if (!cur) return
    try { cur.off() } catch { /* 忽略 */ }
    mounted.delete(sid)
  }

  // ---------- 后台提炼 ----------

  function trimTurns(turns) {
    const keys = Object.keys(turns || {})
    if (keys.length <= 200) return
    keys.sort((a, b) => (Number(turns[a]) || 0) - (Number(turns[b]) || 0))
    for (const k of keys.slice(0, keys.length - 200)) delete turns[k]
  }

  function onTurn(agent, sid) {
    try {
      if (!loadConfig().enabled || memoryDisabled(cwdOf(agent))) return
      const memory = bySid.get(sid) || memoryFor(sid, cwdOf(agent))
      if (!memory) return
      const meta = memory.meta()
      if (!meta.turns || typeof meta.turns !== 'object') meta.turns = {}
      meta.turns[sid] = (Number(meta.turns[sid]) || 0) + 1
      trimTurns(meta.turns)

      const c = loadConfig()
      if (c.extractEveryTurns <= 0) {
        memory.save()
        return
      }
      if (meta.turns[sid] % c.extractEveryTurns !== 0) {
        memory.save()
        return
      }
      memory.save()
      scheduleExtract(agent, sid, memory)
    } catch (e) {
      diag('回合处理失败：' + (e && e.message))
    }
  }

  function pickModel(agent) {
    try {
      const h = agent && agent.session && typeof agent.session.requestHeader === 'function' ? agent.session.requestHeader() : null
      const c = h && h.config
      if (c && c.provider && c.model) return { provider: c.provider, model: c.model }
    } catch { /* 忽略 */ }
    try {
      const o = agent && agent.options
      if (o && o.provider && o.model) return { provider: o.provider, model: o.model }
    } catch { /* 忽略 */ }
    try {
      const svc = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null
      const sel = svc && typeof svc.currentSelection === 'function' ? svc.currentSelection() : null
      if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model }
    } catch { /* 忽略 */ }
    return null
  }

  async function askModel(agent, system, user, maxTokens) {
    const llm = ctx.llm
    if (!llm || typeof llm.stream !== 'function') return { ok: false, message: '宿主没有 llm 服务' }
    const target = pickModel(agent)
    if (!target) return { ok: false, message: '拿不到会话在用的模型' }
    let messages
    try {
      messages = [createUserMessage({
        content: [{ type: 'text', text: user }],
        source: { kind: 'plugin', plugin: 'dsh-deep-memory' },
      })]
    } catch (e) {
      return { ok: false, message: '构造消息失败：' + (e && e.message) }
    }
    let out = ''
    try {
      const stream = llm.stream({
        provider: target.provider,
        model: target.model,
        system,
        messages,
        maxTokens: maxTokens || 700,
        temperature: 0.1,
      })
      for await (const chunk of stream) {
        if (!chunk) continue
        if (chunk.type === 'text-delta') out += chunk.text || ''
        if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
          const f = chunk.reason.failure || {}
          return { ok: false, message: '模型报错：' + (f.message || f.code || '?') }
        }
      }
    } catch (e) {
      return { ok: false, message: '调用失败：' + (e && e.message) }
    }
    return { ok: true, text: String(out || '').trim() }
  }

  function scheduleExtract(agent, sid, memory) {
    if (extracting.has(sid)) return
    const c = loadConfig()
    const meta = memory.meta()
    if (Date.now() - (Number(meta.lastExtractAt) || 0) < c.extractMinIntervalMs) return
    const transcript = transcriptOf(agent && agent.session, c.transcriptMessages, c.transcriptChars)
    if (!transcript) return
    const prompt = buildPrompt({
      date: today(),
      existingFacts: memory.factLines(15),
      openPending: memory.pendingLines(),
      transcript,
    })
    extracting.add(sid)
    Promise.resolve()
      .then(() => {
        if (!loadConfig().enabled || memoryDisabled(cwdOf(agent))) return null
        return askModel(agent, prompt.system, prompt.user, 700)
      })
      .then((res) => {
        if (!loadConfig().enabled || memoryDisabled(cwdOf(agent))) return
        if (!res || !res.ok) {
          diag('提炼跳过：' + ((res && res.message) || '没拿到模型'))
          return
        }
        const proposal = parseProposal(res.text)
        if (!proposal) {
          diag('提炼输出解析失败（不记录模型输出）')
          return
        }
        const out = applyProposal(memory, proposal, { source: 'auto', now: Date.now() })
        const m = memory.meta()
        m.lastExtractAt = Date.now()
        m.extractRuns = (Number(m.extractRuns) || 0) + 1
        memory.save()
        diag(`提炼：+${out.facts} 事实 / +${out.events} 经历 / +${out.pending} 事项 / 结清 ${out.resolved}${out.redacted ? `（脱敏 ${out.redacted}）` : ''}`)
      })
      .catch((e) => diag('提炼异常：' + (e && e.message)))
      .finally(() => extracting.delete(sid))
  }

  // ---------- 工具 ----------

  function memoryFromExec(exec) {
    const sid = sessionIdFromExec(exec)
    const agent = exec && (exec.agent || exec.caller || exec.agentRef)
    if (!loadConfig().enabled || isSubagent(agent) || memoryDisabled(cwdOf(agent))) return { sid, memory: null }
    if (sid && bySid.has(sid)) return { sid, memory: bySid.get(sid) }
    return { sid, memory: memoryFor(sid, cwdOf(agent)) }
  }

  // 宿主 defineTool 会做 spec -> JSON Schema 的转换与校验；万一它拒了，退回原始定义，
  // 至少让插件还能加载、注入还能用（工具可能不可用，diag 里能看见原因）。
  function makeTool(def) {
    try {
      return defineTool(def)
    } catch (e) {
      diag('defineTool 拒绝了工具定义，退回原始对象：' + (e && e.message))
      return def
    }
  }

  const rememberTool = makeTool({
    name: 'remember',
    description:
      '把一件事记进长期记忆（以后需要时会自动想起来）。一条只装一件事。' +
      '只记长期有价值的：用户明确说的重要偏好/约定/边界、这个项目的决策与理由、踩过的坑。' +
      '不要记日常进度、命令输出、临时状态；不要记重复的。' +
      '记的时候安静地记，不要在回复里说「记下了」「我记住了」。',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: '要记住的事，一句话说清，写具体（人名、模块名、约定内容）。不要写密钥/token。',
      },
      importance: {
        type: 'number',
        description: '0 = 随口提过；0.5 = 比较重要；1 = 非常重要（硬约束、长期约定）。不确定就 0.5。',
      },
      key: {
        type: 'string',
        description: '可选。这条讲的是哪件会变的事，用「对象.方面」写，像 `项目.包管理器`、`用户.回复语言`。' +
          '同一个键 = 同一件事，以后只留最新一条。键里不要写具体值；拿不准就留空。',
      },
      replace: {
        type: 'string',
        description: '可选。如果这条是在更新一条以前记过的事，把旧那条的大意填这里 —— 它会被标成「已被取代」。' +
          '不是在更新旧的就别填。',
      },
      scope: {
        type: 'string',
        enum: ['workspace', 'global'],
        description: 'workspace = 只在这个项目里用（默认）；global = 跨项目（用户本人的偏好、约定）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
      },
      render(_args, value) {
        if (value && value.ok === false) return [{ type: 'text', text: '✗ ' + String(value.message || '没记住') }]
        return [{ type: 'text', text: '✓' }]
      },
    },
    async execute(args, exec) {
      const { memory } = memoryFromExec(exec)
      if (!memory) return { ok: false, message: '记不了（拿不到记忆库）' }
      if (!loadConfig().enabled) return { ok: false, message: '长期记忆是关着的' }
      const text = String((args && args.text) || '').trim()
      if (!text) return { ok: false, message: '没记住（内容是空的）' }

      let replaced = false
      const old = String((args && args.replace) || '').trim()
      if (old) {
        for (const layer of memory.layers()) {
          const hit = layer.data.facts.find((f) => f.status === 'current' && String(f.text || '').includes(old))
          if (hit) {
            hit.status = 'superseded'
            hit.replacedAt = Date.now()
            hit.validTo = today()
            layer.dirty = true
            replaced = true
            break
          }
        }
      }

      const scope = args && args.scope === 'global' ? 'global' : 'workspace'
      const subject = scope === 'global' ? 'user' : 'project'
      const r = memory.addFact({
        subject,
        text,
        key: String((args && args.key) || ''),
        scope,
        confidence: 0.9,
        importance: args && args.importance,
        source: { kind: 'remember', at: Date.now() },
      })
      if (!r.ok) return { ok: false, message: r.message || '没记住' }
      memory.save()
      const s = memory.stats()
      const extra = replaced ? '，旧的那条标成了已被取代' : ''
      const red = r.redacted ? '，里面的密钥已隐去' : ''
      return { ok: true, message: `记下了（现在共 ${s.facts} 条事实）${extra}${red}` }
    },
  })

  const recallTool = makeTool({
    name: 'memory_recall',
    description:
      '查长期记忆：按话题找出可能相关的记忆。用户提到「之前/上次/我们说好的」但你没把握时用它。' +
      '查询留空 = 看最近记下的几条。只读，不会改任何东西。',
    parameters: {
      query: { type: 'string', description: '要查的话题或关键词；留空看最近记的。' },
      limit: { type: 'number', description: '最多几条，默认 8。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
      },
      render(_args, value) {
        return [{ type: 'text', text: (value && value.text) || '（没有查到）' }]
      },
    },
    async execute(args, exec) {
      const { memory } = memoryFromExec(exec)
      if (!memory) return { ok: false, text: '拿不到记忆库' }
      const limit = Math.min(20, Math.max(1, Math.round(Number(args && args.limit) || 8)))
      const q = String((args && args.query) || '').trim()

      if (!q) {
        const rows = memory.recent(limit)
        if (!rows.length) return { ok: true, text: '（这个库还是空的）' }
        return { ok: true, text: rows.map((x) => `- [${x.kind}] ${x.id} ${x.text}`).join('\n') }
      }

      const { facts, events, pending } = memory.recall(q, { kFacts: limit, kEvents: limit, kPending: limit })
      const out = []
      for (const f of facts) out.push(`- [事实] ${f.id} ${f.text}`)
      for (const e of events) out.push(`- [经历] ${e.id} ${e.tEvent || ''} ${e.text}`)
      for (const p of pending) out.push(`- [事项] ${p.id} ${p.text}${p.due ? `（到期 ${p.due}）` : ''}`)
      return { ok: true, text: out.length ? out.slice(0, limit * 3).join('\n') : '（没找到相关的；可以换个说法再查）' }
    },
  })

  const forgetTool = makeTool({
    name: 'memory_forget',
    description: '删掉一条长期记忆（用户明确要求「忘掉」时用）。要先从 memory_recall 里拿到 id。',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: '要删的那条 id（也可以是开头几位）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
      },
      render(_args, value) {
        return [{ type: 'text', text: (value && value.message) || '（没删）' }]
      },
    },
    async execute(args, exec) {
      const { memory } = memoryFromExec(exec)
      if (!memory) return { ok: false, message: '拿不到记忆库' }
      const id = String((args && args.id) || '').trim()
      if (!id) return { ok: false, message: '要给 id' }
      const kind = memory.delete(id)
      if (!kind) return { ok: false, message: '没找到这条记忆' }
      memory.save()
      return { ok: true, message: `已删除（${kind}）` }
    },
  })

  function registerTools() {
    if (!ctx.tools || typeof ctx.tools.register !== 'function') {
      diag('宿主没有 tools.register，工具不可用（注入照常）')
      return
    }
    for (const t of [rememberTool, recallTool, forgetTool]) {
      try {
        const off = ctx.tools.register(t)
        if (typeof off === 'function') toolOffs.push(off)
      } catch (e) {
        diag(`工具 ${t.name} 注册失败：` + (e && e.message))
      }
    }
  }

  // ---------- 挂载循环 ----------

  function tick() {
    let list = []
    try {
      if (ctx.agents && typeof ctx.agents.list === 'function') list = ctx.agents.list() || []
    } catch { list = [] }

    for (const agent of list) {
      const sid = sessionIdOf(agent && agent.session)
      if (!sid) continue
      if (isSubagent(agent)) {
        unmount(sid)
        continue
      }
      // 工作区放 .dsh-memory-off：整棵目录树都不要记忆，已经挂上的要摘掉
      const cwd = cwdOf(agent)
      if (cwd && memoryDisabled(cwd)) {
        if (mounted.has(sid)) {
          unmount(sid)
          bySid.delete(sid)
          if (!offNoticed.has(sid)) {
            offNoticed.add(sid)
            diag('工作区标了 .dsh-memory-off，不挂记忆：' + cwd)
          }
        }
        continue
      }
      const cur = mounted.get(sid)
      if (cur && cur.agent === agent) continue
      if (cur) unmount(sid)
      try {
        const off = mountFor(agent, sid)
        mounted.set(sid, { agent, off })
        diag('挂上记忆：' + sid)
      } catch (e) {
        diag('挂载失败：' + sid + ' ' + (e && e.message))
      }
    }

    const alive = new Set(list.map((a) => sessionIdOf(a && a.session)).filter(Boolean))
    for (const sid of [...mounted.keys()]) {
      if (!alive.has(sid)) unmount(sid)
    }
  }

  function cleanup() {
    for (const sid of [...mounted.keys()]) unmount(sid)
    for (const off of toolOffs) {
      try { off() } catch { /* 忽略 */ }
    }
    toolOffs = []
    for (const v of memories.values()) {
      try { v.memory.save() } catch { /* 忽略 */ }
    }
    memories.clear()
    bySid.clear()
    if (stopTick) {
      try { stopTick() } catch { /* 忽略 */ }
      stopTick = null
    }
  }

  registerTools()
  tick()

  try {
    if (typeof ctx.effect === 'function' && typeof ctx.interval === 'function') {
      ctx.effect(() => ctx.interval(tick, 800))
    } else if (typeof ctx.interval === 'function') {
      const off = ctx.interval(tick, 800)
      if (typeof off === 'function') stopTick = off
    }
  } catch (e) {
    diag('定时挂载循环没起来（不影响已有会话）：' + (e && e.message))
  }

  try {
    if (typeof ctx.effect === 'function') ctx.effect(() => () => cleanup())
  } catch { /* 清理器挂不上就靠进程退出 */ }

  diag('deep-memory 已启动，库目录：' + memoryRoot())
}
