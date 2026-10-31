// 记忆核心：分层存储 + 打分召回 + 注入渲染 + 整理。
//
// 数据模型沿用「六层记忆」里可搬到桌面 Agent 的那四层：
//   profile（常驻画像）/ facts（带事实键，会更新）/ events（共同经历）/ pending（未结束事项）
// 作用域换成 DSH 的两层：
//   global  —— 关于用户本人：称呼、偏好、约定、边界、忌口这类跨项目事实
//   <ws>    —— 某个 cwd：项目事实、决策理由、踩过的坑、共同经历、没做完的事
// 每层一个文件、一个 MemoryLayer；读的时候合并，写的时候按 scope 路由。

import { DAY, RECALL_CUE, formatDate, jaccard, redactSecrets, relDay, timeWindow, today, uid } from './text.js'
import { tokens } from './tokenize.js'
import { loadStore, saveStore, backupStore } from './store.js'

const FACT_MAX = 120
const EVENT_MAX = 160
const PENDING_MAX = 120

const clamp01 = (v, def = 0.5) => {
  const n = Number(v)
  return isFinite(n) ? Math.min(1, Math.max(0, n)) : def
}

const BAD_ADDRESS = /^(喂|那个谁|你|他|她|它|老头|老登)$/

function hasProfile(p) {
  return Boolean(p && (p.address || (p.style && p.style.length) || (p.agreements && p.agreements.length) || (p.boundaries && p.boundaries.length)))
}

export class MemoryLayer {
  constructor(file, scopeId) {
    this.file = file
    this.scopeId = scopeId
    this.data = loadStore(file, scopeId)
    this.dirty = false
  }

  save(force = false) {
    if (!this.dirty && !force) return false
    try {
      saveStore(this.file, this.data)
      this.dirty = false
      return true
    } catch {
      return false
    }
  }

  backup() {
    try { backupStore(this.file) } catch { /* 备份失败不拦写入 */ }
  }

  // ---------------- 写入 ----------------

  /**
   * 事实。同一个事实键 = 同一件事：新版本取代旧版本（旧的标 superseded，仍可回忆）。
   * 没给键：按相似度判断是「又提了一次」还是「新事实」。
   */
  addFact({ subject = 'user', text, key = '', scope, source = {}, confidence = 0.6, importance = 0.5, tEvent = '', sticky = false, now = Date.now() } = {}) {
    const t = String(text || '').trim().slice(0, FACT_MAX)
    if (!t) return null
    const subj = String(subject || 'user')
    const sc = scope || this.scopeId
    const k = String(key || '').trim().slice(0, 40)

    if (k) {
      const prev = this.data.facts.find(
        (f) => f.key === k && f.subject === subj && f.scope === sc && f.status === 'current',
      )
      if (prev) {
        if (jaccard(prev.text, t) > 0.9) {
          prev.confirm = (prev.confirm || 1) + 1
          prev.tConfirm = now
          this.dirty = true
          return prev
        }
        prev.status = 'superseded'
        prev.replacedAt = now
        prev.validTo = today(new Date(now))
        prev.validFrom ??= formatDate(prev.tRecord || prev.tConfirm || now)
        const next = {
          id: uid('f'), subject: subj, text: t, key: k, scope: sc, source,
          confidence: clamp01(confidence, 0.6), importance: clamp01(importance, 0.5),
          tEvent: tEvent || '', tRecord: now, tConfirm: now, confirm: 1,
          status: 'current', sticky: Boolean(sticky),
          supersedes: prev.id, validFrom: today(new Date(now)), validTo: '',
        }
        prev.replacedBy = next.id
        this.data.facts.push(next)
        this.dirty = true
        return next
      }
    }

    if (!k) {
      const near = this.data.facts.find(
        (f) => f.subject === subj && f.scope === sc && f.status === 'current' && !f.key && jaccard(f.text, t) > 0.72,
      )
      if (near) {
        near.confirm = (near.confirm || 1) + 1
        near.tConfirm = now
        if (jaccard(near.text, t) < 0.95) near.text = t
        this.dirty = true
        return near
      }
    }

    const fact = {
      id: uid('f'), subject: subj, text: t, key: k, scope: sc, source,
      confidence: clamp01(confidence, 0.6), importance: clamp01(importance, 0.5),
      tEvent: tEvent || '', tRecord: now, tConfirm: now, confirm: 1,
      status: 'current', sticky: Boolean(sticky), validFrom: today(new Date(now)), validTo: '',
    }
    this.data.facts.push(fact)
    this.dirty = true
    return fact
  }

  addEvent({ text, scope, participants = [], tEvent = '', importance = 0.5, source = {}, now = Date.now() } = {}) {
    const t = String(text || '').trim().slice(0, EVENT_MAX)
    if (!t) return null
    const sc = scope || this.scopeId
    if (this.data.events.some((e) => e.scope === sc && e.status === 'current' && jaccard(e.text, t) > 0.8)) return null
    const ev = {
      id: uid('e'), text: t, scope: sc, participants: Array.isArray(participants) ? participants.slice(0, 6) : [],
      tEvent: tEvent || today(new Date(now)), tRecord: now, importance: clamp01(importance, 0.5),
      status: 'current', source,
    }
    this.data.events.push(ev)
    this.dirty = true
    return ev
  }

  addPending({ text, scope, due = '', source = {}, now = Date.now() } = {}) {
    const t = String(text || '').trim().slice(0, PENDING_MAX)
    if (!t) return null
    const sc = scope || this.scopeId
    const near = this.data.pending.find((p) => p.scope === sc && p.state === 'open' && jaccard(p.text, t) > 0.7)
    if (near) {
      near.tConfirm = now
      if (due) near.due = due
      this.dirty = true
      return near
    }
    const item = {
      id: uid('p'), text: t, scope: sc, state: 'open', due: String(due || '').slice(0, 10),
      tEvent: today(new Date(now)), tRecord: now, tConfirm: now, lastAskedAt: 0, askedCount: 0, source,
    }
    this.data.pending.push(item)
    this.dirty = true
    return item
  }

  resolvePending(idOrText, state = 'done', now = Date.now()) {
    const q = String(idOrText || '').trim()
    if (!q) return null
    const p = this.data.pending.find((x) => x.id === q) || this.data.pending.find((x) => (x.id || '').startsWith(q)) ||
      this.data.pending.find((x) => String(x.text || '').includes(q))
    if (!p) return null
    p.state = ['done', 'expired', 'dropped'].includes(state) ? state : 'done'
    p.tResolved = now
    this.dirty = true
    return p
  }

  updateProfile(patch = {}, now = Date.now()) {
    const p = this.data.profile
    if (typeof patch.address === 'string') {
      const a = patch.address.trim().slice(0, 24)
      if (a && !BAD_ADDRESS.test(a)) p.address = a
    }
    for (const f of ['style', 'agreements', 'boundaries']) {
      if (!Array.isArray(patch[f])) continue
      for (const v of patch[f]) {
        const s = String(v || '').trim().slice(0, 60)
        if (s && !p[f].includes(s)) p[f].push(s)
      }
      p[f] = p[f].slice(-8)
    }
    p.updatedAt = now
    this.dirty = true
    return p
  }

  delete(id) {
    for (const kind of ['facts', 'events', 'pending']) {
      const i = this.data[kind].findIndex((x) => x.id === id || (x.id || '').startsWith(String(id)))
      if (i >= 0) {
        this.data[kind].splice(i, 1)
        this.dirty = true
        return kind
      }
    }
    return null
  }

  // ---------------- 整理 ----------------

  /** 不删内容：留下信息更全的那条，把确认次数和重要度并过去。 */
  dedupe(threshold = 0.72) {
    const merge = (arr, same) => {
      const removed = new Set()
      for (let i = 0; i < arr.length; i += 1) {
        if (removed.has(arr[i].id)) continue
        for (let j = i + 1; j < arr.length; j += 1) {
          if (removed.has(arr[j].id)) continue
          const a = arr[i]
          const b = arr[j]
          if (a.status !== 'current' || b.status !== 'current') continue
          if (!same(a, b)) continue
          if (jaccard(a.text, b.text) < threshold) continue
          const keep = b.text.length > a.text.length ? b : a
          const drop = keep === a ? b : a
          keep.confirm = Math.max(keep.confirm || 1, drop.confirm || 1) + 1
          keep.importance = Math.max(keep.importance ?? 0.5, drop.importance ?? 0.5)
          keep.tConfirm = Math.max(keep.tConfirm || 0, drop.tConfirm || 0)
          removed.add(drop.id)
        }
      }
      return arr.filter((x) => !removed.has(x.id))
    }

    const beforeF = this.data.facts.length
    const beforeE = this.data.events.length
    this.data.facts = merge(
      this.data.facts,
      (a, b) => (a.subject || '') === (b.subject || '') && (a.key || '') === (b.key || '') && a.scope === b.scope,
    )
    this.data.events = merge(this.data.events, (a, b) => a.scope === b.scope)
    if (beforeF !== this.data.facts.length || beforeE !== this.data.events.length) this.dirty = true
    return { facts: beforeF - this.data.facts.length, events: beforeE - this.data.events.length }
  }

  consolidate(cfg, now = Date.now()) {
    const t = today(new Date(now))
    let expired = 0
    for (const p of this.data.pending) {
      if (p.state !== 'open') continue
      if (p.due && /^\d{4}-\d{2}-\d{2}$/.test(p.due) && p.due < t) {
        p.state = 'expired'
        p.tResolved = now
        expired += 1
        this.dirty = true
      }
    }
    let merged = { facts: 0, events: 0 }
    if (this.data.facts.length > cfg.maxFacts * 0.8 || this.data.events.length > cfg.maxEvents * 0.8) {
      merged = this.dedupe()
    }
    this.data.meta.lastConsolidate = now
    this.dirty = true
    return { expired, ...merged }
  }

  // ---------------- 读取 ----------------

  currentFacts() {
    return this.data.facts.filter((f) => f.status === 'current' && (f.confidence ?? 1) >= 0.5)
  }

  currentEvents() {
    return this.data.events.filter((e) => e.status === 'current')
  }

  openPending() {
    return this.data.pending.filter((p) => p.state === 'open')
  }

  toJSON() {
    return this.data
  }
}

export class MemoryEngine {
  constructor(layers, cfg = {}) {
    this.layers = layers
    this.cfg = cfg
  }

  allFacts() { return this.layers.flatMap((l) => l.currentFacts()) }
  allEvents() { return this.layers.flatMap((l) => l.currentEvents()) }
  allPending() { return this.layers.flatMap((l) => l.openPending()) }

  docs() {
    return [...this.allFacts(), ...this.allEvents(), ...this.allPending()]
  }

  corpusStats() {
    const docs = this.docs()
    const df = new Map()
    for (const d of docs) {
      for (const t of tokens(d.text)) df.set(t, (df.get(t) || 0) + 1)
    }
    return { df, N: docs.length }
  }

  idf(t, stats) {
    const df = stats.df.get(t) || 0
    // df + 0.5 的平滑：只有一两条记忆时，全命中也会算成 0 信息量，把冷启动的召回全掐死。
    return Math.log((stats.N + 1) / (df + 0.5))
  }

  activation(item, now = Date.now()) {
    const imp = Number(item.importance ?? 0.5)
    const half = Number(this.cfg.halfLifeDays ?? 30) * (1 + 2 * imp)
    const anchor = item.tEvent ? Date.parse(`${String(item.tEvent).slice(0, 10)}T00:00:00`) : (item.tConfirm || item.tRecord || now)
    const days = isFinite(anchor) ? Math.max(0, (now - anchor) / DAY) : 0
    return Math.pow(2, -days / half)
  }

  score(item, q, now, { boostRecall = false, stats = null, window = null } = {}) {
    const it = tokens(`${item.text} ${(item.participants || []).join(' ')}`)
    const st = stats || this.corpusStats()
    let matched = 0
    let total = 0
    for (const x of q) {
      // df=0：库里根本没有这个词，它不可能被任何一条记忆命中。
      // 而 idf 公式在 df=0 时给的是全库最大权重 ln((N+1)/0.5)，把它算进分母等于用
      // 「我们没听过这个词」去惩罚真正命中的记忆：问句 13 个词里 10 个是库外词时，
      // rel 从 1.0 被稀释到 0.10，整条记忆直接进不来。所以只有库里出现过的词才进分母。
      if (!(st.df.get(x) > 0)) continue
      const w = Math.max(0, this.idf(x, st))
      total += w
      if (it.has(x)) matched += w
    }
    const rel = total > 0 ? matched / total : 0

    let act = this.activation(item, now)
    if (boostRecall) act = Math.min(1, act * 1.8)

    const imp = Number(item.importance ?? 0.5)
    const conf = Number(item.confidence ?? 0.8)

    let timeBoost = 1
    if (window && item.tEvent) {
      const age = Math.round((now - Date.parse(`${String(item.tEvent).slice(0, 10)}T00:00:00`)) / DAY)
      if (isFinite(age) && age >= window.from && age <= window.to) timeBoost = 1.6
    }

    return rel * (0.55 + 0.25 * act + 0.15 * imp + 0.05 * conf) * timeBoost
  }

  /**
   * 多路召回：先过「问句信息量」这道闸，再按话题打分。
   * 常驻档案不进这个池子，单独注入。
   */
  /** 召回记录只留最近 50 次，用来回答「上次想起了哪几条、为什么」。 */
  recordRecall(record) {
    const layer = this.layers[this.layers.length - 1]
    if (!layer) return
    layer.data.recalls.push(record)
    layer.data.recalls = layer.data.recalls.slice(-50)
    layer.dirty = true
  }

  recall(query, opts = {}) {
    const now = Date.now()
    const q = tokens(String(query || ''))
    const stats = this.corpusStats()
    const minScore = opts.minScore ?? this.cfg.minScore ?? 0.15
    const gateLimit = opts.queryGate ?? this.cfg.queryGate ?? 0.25
    const kFacts = opts.kFacts ?? this.cfg.kFacts ?? 4
    const kEvents = opts.kEvents ?? this.cfg.kEvents ?? 3
    const kPending = opts.kPending ?? this.cfg.kPending ?? 2
    const boostRecall = opts.boostRecall ?? RECALL_CUE.test(String(query || ''))
    const win = opts.window === undefined ? timeWindow(query) : opts.window

    const qInfoSum = [...q].reduce((s, t) => s + Math.max(0, this.idf(t, stats)), 0)
    const qInfo = stats.N > 0 ? qInfoSum / Math.log(stats.N + 1) : 1
    if (!stats.N || !q.size || qInfo < gateLimit) {
      // 被闸挡下的不记录：否则「在吗」会把这 50 条日志刷满，真召回反而看不见
      return {
        facts: [], events: [], pending: [],
        record: { at: now, query: String(query || '').slice(0, 80), picked: [], skipped: [], gated: true, gate: qInfo },
      }
    }

    const pick = (arr, k) => arr
      .map((item) => ({ item, s: this.score(item, q, now, { boostRecall, stats, window: win }) }))
      .filter((x) => x.s >= minScore)
      .sort((a, b) => b.s - a.s)
      .slice(0, Math.max(0, k))

    const facts = pick(this.allFacts(), kFacts)
    const events = pick(this.allEvents(), kEvents)
    const pending = pick(this.allPending(), kPending)

    const record = {
      at: now,
      query: String(query || '').slice(0, 80),
      gate: qInfo,
      picked: [...facts, ...events, ...pending].map((x) => ({ id: x.item.id, text: x.item.text, s: Number(x.s.toFixed(3)) })),
      skipped: this.allFacts()
        .filter((f) => !facts.some((x) => x.item.id === f.id))
        .slice(-8)
        .map((f) => ({ id: f.id, text: f.text, reason: '相关度不足' })),
    }

    this.recordRecall(record)
    return { facts: facts.map((x) => x.item), events: events.map((x) => x.item), pending: pending.map((x) => x.item), record }
  }

  /** 注入渲染：画像常驻 + 相关事实/经历/事项，总字数有预算。 */
  render(query, opts = {}) {
    const budget = Math.max(120, Number(opts.maxChars ?? this.cfg.maxInjectChars ?? 600))
    const { facts, events, pending } = this.recall(query, opts)
    const lines = []
    let used = 0

    const section = (title, items) => {
      if (!items.length) return
      const block = [title, ...items.map((s) => `- ${s}`)]
      const cost = block.reduce((n, s) => n + s.length + 1, 0)
      if (used + cost > budget) return
      lines.push(...block)
      used += cost
    }

    for (const layer of this.layers) {
      const p = layer.data.profile
      if (!hasProfile(p)) continue
      const bits = []
      if (p.address) bits.push(`称呼：${p.address}`)
      if (p.style.length) bits.push(`偏好：${p.style.join('；')}`)
      if (p.agreements.length) bits.push(`约定：${p.agreements.join('；')}`)
      if (p.boundaries.length) bits.push(`边界：${p.boundaries.join('；')}`)
      section(layer.scopeId === 'global' ? '【关于用户】' : '【这个项目的约定】', bits)
    }

    const sticky = this.layers.flatMap((l) => l.data.facts.filter((f) => f.sticky && f.status === 'current')).slice(-2)
    section('【必须记得】', sticky.map((f) => f.text))

    const local = facts.filter((f) => f.scope !== 'global')
    const global = facts.filter((f) => f.scope === 'global')
    section('【项目记忆】', local.map((f) => f.text))
    section('【长期记忆】', global.map((f) => f.text))

    section('【共同经历】', events.map((e) => `${relDay(e.tEvent)}：${e.text}`))

    section('【还没结束的事】', pending.map((p) => {
      const asked = p.lastAskedAt && Date.now() - p.lastAskedAt < 30 * 60 * 1000
      const due = p.due ? `（到期 ${p.due}）` : ''
      return `${p.text}${due}${asked ? '（刚问过，别再追问）' : ''}`
    }))

    if (!lines.length) return ''
    const footer = '（这些是长期记忆：与本轮无关的不要主动提；记不清就问，不要编。）'
    if (used + footer.length + 1 <= budget) lines.push(footer)
    return lines.join('\n')
  }

  stats() {
    const facts = this.allFacts()
    const events = this.allEvents()
    const pending = this.allPending()
    return {
      facts: facts.length,
      events: events.length,
      pending: pending.length,
      sticky: facts.filter((f) => f.sticky).length,
      superseded: this.layers.reduce((n, l) => n + l.data.facts.filter((f) => f.status === 'superseded').length, 0),
    }
  }
}

/**
 * global 层在进程内只加载一份。
 *
 * 每个工作区一个 Memory 实例。如果各自 new 一份 global layer，就会出事：
 *   别的会话早就开着（手里是当时的空副本）→ 这边新记一条全局事实 → 那边看不见；
 *   更糟的是那边下一次 save 会把旧副本写回文件，**把新记的那条抹掉**。
 * 这不算「多写者」——是同一进程内多个实例各持一份副本。所以按文件路径共享一份。
 *
 * 只覆盖同进程：真开两个 DSH 进程仍会各持一份（那在 REQUIREMENTS「单写者」约束之外，
 * 要支持得按文件 mtime 重读）。
 */
const GLOBAL_CACHE = new Map()

function sharedGlobalLayer(file) {
  const key = String(file)
  let layer = GLOBAL_CACHE.get(key)
  if (!layer) {
    layer = new MemoryLayer(file, 'global')
    GLOBAL_CACHE.set(key, layer)
  }
  return layer
}

/**
 * 一个会话看到的记忆：全局层 + 本工作区层。读写都从这里进。
 */
export class Memory {
  constructor({ globalFile, scopeFile, scopeId, cfg = {} }) {
    this.cfg = cfg
    this.scopeId = scopeId
    this.global = sharedGlobalLayer(globalFile)
    this.local = new MemoryLayer(scopeFile, scopeId)
    this.engine = new MemoryEngine([this.global, this.local], cfg)
    this.maybeConsolidate()
  }

  layers() { return [this.global, this.local] }

  save(force = false) {
    let changed = false
    for (const l of this.layers()) changed = l.save(force) || changed
    return changed
  }

  meta() { return this.local.data.meta }

  scopeFor(patch = {}) {
    if (patch.scope === 'global') return 'global'
    if (patch.scope === 'workspace' || patch.scope === 'local') return this.scopeId
    if (patch.subject === 'user') return 'global'
    return this.scopeId
  }

  layerFor(scope) {
    return scope === 'global' ? this.global : this.local
  }

  addFact(patch = {}) {
    const scope = this.scopeFor(patch)
    const layer = this.layerFor(scope)
    const p = this.prepare(patch.text)
    if (!p.ok) return { ok: false, ...p }
    return { ok: true, redacted: Boolean(p.redacted), item: layer.addFact({ ...patch, text: p.text, scope }) }
  }

  addEvent(patch = {}) {
    const scope = patch.scope === 'global' ? 'global' : this.scopeId
    const layer = this.layerFor(scope)
    const p = this.prepare(patch.text)
    if (!p.ok) return { ok: false, ...p }
    return { ok: true, redacted: Boolean(p.redacted), item: layer.addEvent({ ...patch, text: p.text, scope }) }
  }

  addPending(patch = {}) {
    const scope = patch.scope === 'global' ? 'global' : this.scopeId
    const layer = this.layerFor(scope)
    const p = this.prepare(patch.text)
    if (!p.ok) return { ok: false, ...p }
    return { ok: true, redacted: Boolean(p.redacted), item: layer.addPending({ ...patch, text: p.text, scope }) }
  }

  prepare(text) {
    const raw = String(text || '').trim()
    if (!raw) return { ok: false, message: '内容是空的' }
    if (this.cfg.redact === false) return { ok: true, text: raw }
    const r = redactSecrets(raw)
    return { ok: true, text: r.text, redacted: r.hit }
  }

  resolvePending(idOrText, state) {
    for (const l of this.layers()) {
      const p = l.resolvePending(idOrText, state)
      if (p) return p
    }
    return null
  }

  updateProfile(patch) {
    const clean = { ...patch }
    if (this.cfg.redact !== false) {
      if (typeof clean.address === 'string') clean.address = redactSecrets(clean.address).text
      for (const field of ['style', 'agreements', 'boundaries']) {
        if (Array.isArray(clean[field])) clean[field] = clean[field].map((value) => redactSecrets(value).text)
      }
    }
    return this.global.updateProfile(clean)
  }

  delete(id) {
    for (const l of this.layers()) {
      const kind = l.delete(id)
      if (kind) return kind
    }
    return null
  }

  recall(query, opts) { return this.engine.recall(query, opts) }
  render(query, opts) { return this.engine.render(query, opts) }
  stats() { return this.engine.stats() }

  /** 给提炼提示词用：当前事实 / 未结束事项各一份清单。 */
  factLines(n = 15) {
    return this.engine.allFacts().slice(-n).map((f) => `- ${f.text}`).join('\n') || '（无）'
  }

  pendingLines() {
    return this.engine.allPending().map((p) => `- ${p.id}：${p.text}`).join('\n') || '（无）'
  }

  recent(limit = 20) {
    const items = [
      ...this.engine.allFacts().map((x) => ({ ...x, kind: '事实' })),
      ...this.engine.allEvents().map((x) => ({ ...x, kind: '经历' })),
      ...this.engine.allPending().map((x) => ({ ...x, kind: '事项' })),
    ]
    return items.sort((a, b) => (b.tRecord || 0) - (a.tRecord || 0)).slice(0, limit)
  }

  maybeConsolidate(now = Date.now()) {
    const hours = Number(this.cfg.consolidateHours ?? 12)
    if (!(hours > 0)) return null
    const last = this.local.data.meta.lastConsolidate || 0
    if (now - last < hours * 3600 * 1000) return null
    this.local.backup()
    const out = { local: this.local.consolidate(this.cfg, now), global: this.global.consolidate(this.cfg, now) }
    this.save(true)
    return out
  }
}
