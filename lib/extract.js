// 后台提炼：把一段对话压成结构化 JSON，再合并进记忆。
//
// 编码/工作会话里值得留下的是：决策与理由、约束、踩过的坑、用户反复强调的偏好。
// 字段沿用六层模型那套，只把 subject 的取值定成 user / project / self，
// 分别路由到 global / workspace 两层。

import { redactSecrets, today } from './text.js'

const LIMITS = { facts: 8, events: 4, pending: 4, resolved: 6 }
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const num01 = (v, def) => {
  const n = Number(v)
  return isFinite(n) ? Math.min(1, Math.max(0, n)) : def
}
const arr = (v) => (Array.isArray(v) ? v : [])

export function buildPrompt({ date = today(), existingFacts = '（无）', openPending = '（无）', transcript = '' } = {}) {
  const system = [
    '你是长期记忆整理器。把末尾的对话整理成一份 JSON，只输出 JSON，不要解释、不要代码块。',
    '',
    '字段：',
    '{"profile":{"address":"怎么称呼用户","style":["说话与工作偏好"],"agreements":["双方约定"],"boundaries":["明确禁忌"]},',
    ' "facts":[{"subject":"user|project|self","text":"一句事实","key":"对象.方面","confidence":0.0-1.0,"importance":0.0-1.0,"tEvent":"YYYY-MM-DD"}],',
    ' "events":[{"text":"一起做过/决定过的事","tEvent":"YYYY-MM-DD","importance":0.0-1.0}],',
    ' "pending":[{"text":"还没结束的事","due":"YYYY-MM-DD"}],',
    ' "resolved":[{"id":"p 开头的事项 ID","state":"done|expired"}],',
    ' "topic":"当前在做什么，10 字以内"}',
    '',
    '规则：',
    '1. 一条只讲一件事。',
    '2. 事实必须来自用户明说、或对话里可验证的结果；你的猜测不要写成事实。',
    '3. 只记有长期价值的东西：决策与理由、约束、踩过的坑、用户反复强调的偏好、项目事实。',
    '   不要记进度流水、命令输出、正在运行的临时状态（「刚跑完测试」这种不要）。',
    '4. 不记密钥、token、密码；看到也不要抄进记忆。',
    '5. 同一属性用同一个事实键（「对象.方面」），键里不写具体值。拿不准就留空。',
    '6. subject：关于用户本人 = user（跨项目）；关于这个项目/代码库 = project（只在本工作区）；关于你自己的做法 = self。',
    '7. 相对时间（昨天/上周/刚才）按「今天是 ' + date + '」换算成具体日期；拿不准留空。',
    '8. 没有新信息就返回空数组，不要凑数。',
    '9. 正文写具体：人名、模块名、约定内容，别写「对方」「那个」。',
    '',
    '已知事实（别重复）：',
    existingFacts,
    '',
    '未结束事项（能对应上就填 resolved）：',
    openPending,
    '',
    `今天是 ${date}。`,
  ].join('\n')

  const user = ['对话：', transcript].join('\n')
  return { system, user }
}

/** 容错解析：去掉代码块、找最外层花括号，字段一律过滤+截断。 */
export function parseProposal(text) {
  let s = String(text || '').trim()
  if (!s) return null
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  let raw
  try {
    raw = JSON.parse(s.slice(a, b + 1))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

  const out = { profile: null, facts: [], events: [], pending: [], resolved: [], topic: '' }

  if (raw.profile && typeof raw.profile === 'object') {
    const p = raw.profile
    const profile = {
      address: str(p.address, 24),
      style: arr(p.style).map((x) => str(x, 60)).filter(Boolean).slice(0, 8),
      agreements: arr(p.agreements).map((x) => str(x, 60)).filter(Boolean).slice(0, 8),
      boundaries: arr(p.boundaries).map((x) => str(x, 60)).filter(Boolean).slice(0, 8),
    }
    if (profile.address || profile.style.length || profile.agreements.length || profile.boundaries.length) out.profile = profile
  }

  for (const x of arr(raw.facts).slice(0, LIMITS.facts)) {
    if (!x || typeof x !== 'object') continue
    const text = str(x.text, 120)
    if (!text) continue
    const subject = ['user', 'project', 'self'].includes(x.subject) ? x.subject : 'user'
    const tEvent = DATE_RE.test(str(x.tEvent, 10)) ? str(x.tEvent, 10) : ''
    out.facts.push({
      subject,
      text,
      key: str(x.key, 40),
      confidence: num01(x.confidence, 0.6),
      importance: num01(x.importance, 0.5),
      tEvent,
    })
  }

  for (const x of arr(raw.events).slice(0, LIMITS.events)) {
    if (!x || typeof x !== 'object') continue
    const text = str(x.text, 160)
    if (!text) continue
    out.events.push({
      text,
      tEvent: DATE_RE.test(str(x.tEvent, 10)) ? str(x.tEvent, 10) : '',
      importance: num01(x.importance, 0.5),
    })
  }

  for (const x of arr(raw.pending).slice(0, LIMITS.pending)) {
    if (!x || typeof x !== 'object') continue
    const text = str(x.text, 120)
    if (!text) continue
    out.pending.push({ text, due: DATE_RE.test(str(x.due, 10)) ? str(x.due, 10) : '' })
  }

  for (const x of arr(raw.resolved).slice(0, LIMITS.resolved)) {
    if (!x || typeof x !== 'object') continue
    const id = str(x.id, 40)
    if (!id) continue
    out.resolved.push({ id, state: x.state === 'expired' ? 'expired' : 'done' })
  }

  out.topic = str(raw.topic, 20)
  return out
}

/** 合并：文本先脱敏，再按 scope 路由进两层。 */
export function applyProposal(memory, proposal, { source = 'auto', now = Date.now() } = {}) {
  const out = { facts: 0, events: 0, pending: 0, resolved: 0, redacted: 0 }
  if (!proposal || !memory) return out

  if (proposal.profile) memory.updateProfile(proposal.profile)

  for (const f of proposal.facts) {
    const r = memory.addFact({
      subject: f.subject,
      text: f.text,
      key: f.key,
      confidence: f.confidence,
      importance: f.importance,
      tEvent: f.tEvent,
      source: { kind: source, at: now },
    })
    if (r.ok && r.item) {
      out.facts += 1
      if (r.redacted) out.redacted += 1
    }
  }

  for (const e of proposal.events) {
    const r = memory.addEvent({ text: e.text, tEvent: e.tEvent, importance: e.importance, source: { kind: source, at: now } })
    if (r.ok && r.item) {
      out.events += 1
      if (r.redacted) out.redacted += 1
    }
  }

  for (const p of proposal.pending) {
    const r = memory.addPending({ text: p.text, due: p.due, source: { kind: source, at: now } })
    if (r.ok && r.item) {
      out.pending += 1
      if (r.redacted) out.redacted += 1
    }
  }

  for (const r of proposal.resolved) {
    if (memory.resolvePending(r.id, r.state)) out.resolved += 1
  }

  memory.save()
  return out
}

/** 给 remember 工具兜底用的单条脱敏（store 层也会做，这里只是提前判一下）。 */
export function cleanText(text) {
  return redactSecrets(String(text || '')).text
}
