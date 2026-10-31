// 参数：全部有默认值；要改就在 <DSH_HOME>/deep-memory/config.json 里写同名字段。
// 这里不提供设置页——第一版先把闭环跑通，界面等真用起来再说。

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { memoryRoot } from './store.js'

export const DEFAULTS = {
  // 总开关。关掉 = 不注入、不接工具、不提炼。
  enabled: true,

  // 每多少轮试一次后台提炼。0 = 关闭自动提炼（只靠 remember 工具手记）。
  extractEveryTurns: 6,
  // 两次提炼之间至少隔这么久（防止一轮轮连着烧 token）。
  extractMinIntervalMs: 10 * 60 * 1000,
  // 一次提炼最多送多少条历史消息、总共多少字。
  transcriptMessages: 30,
  transcriptChars: 6000,

  // 注入预算：条数 + 总字数，超了就不带（下次再说，不是丢）。
  maxInjectChars: 600,
  kFacts: 4,
  kEvents: 3,
  kPending: 2,

  // 三道闸：问句信息量、单条分数、时间半衰期。
  queryGate: 0.25,
  minScore: 0.15,
  halfLifeDays: 30,

  // 容量：只影响"还收不收新的"，从不自动删。
  maxFacts: 300,
  maxEvents: 300,
  maxPending: 60,

  // 多久整理一次（过期事项、去重）。
  consolidateHours: 12,

  // 写入前把密钥/token 替换成 [已隐去]。
  redact: true,
}

const CACHE = { path: '', mtime: 0, cfg: null }

function clampNum(v, def, lo, hi) {
  const n = Number(v)
  if (!isFinite(n)) return def
  return Math.min(hi, Math.max(lo, n))
}

export function normalizeConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const out = { ...DEFAULTS }
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled
  out.extractEveryTurns = Math.round(clampNum(r.extractEveryTurns, DEFAULTS.extractEveryTurns, 0, 100))
  out.extractMinIntervalMs = clampNum(r.extractMinIntervalMs, DEFAULTS.extractMinIntervalMs, 0, 7 * 86400000)
  out.transcriptMessages = Math.round(clampNum(r.transcriptMessages, DEFAULTS.transcriptMessages, 4, 200))
  out.transcriptChars = Math.round(clampNum(r.transcriptChars, DEFAULTS.transcriptChars, 400, 40000))
  out.maxInjectChars = Math.round(clampNum(r.maxInjectChars, DEFAULTS.maxInjectChars, 120, 4000))
  out.kFacts = Math.round(clampNum(r.kFacts, DEFAULTS.kFacts, 0, 20))
  out.kEvents = Math.round(clampNum(r.kEvents, DEFAULTS.kEvents, 0, 20))
  out.kPending = Math.round(clampNum(r.kPending, DEFAULTS.kPending, 0, 20))
  out.queryGate = clampNum(r.queryGate, DEFAULTS.queryGate, 0, 1)
  out.minScore = clampNum(r.minScore, DEFAULTS.minScore, 0, 1)
  out.halfLifeDays = clampNum(r.halfLifeDays, DEFAULTS.halfLifeDays, 1, 3650)
  out.maxFacts = Math.round(clampNum(r.maxFacts, DEFAULTS.maxFacts, 10, 5000))
  out.maxEvents = Math.round(clampNum(r.maxEvents, DEFAULTS.maxEvents, 10, 5000))
  out.maxPending = Math.round(clampNum(r.maxPending, DEFAULTS.maxPending, 1, 500))
  out.consolidateHours = clampNum(r.consolidateHours, DEFAULTS.consolidateHours, 0, 24 * 30)
  if (typeof r.redact === 'boolean') out.redact = r.redact
  return out
}

export function loadConfig(force = false) {
  try {
    const file = join(memoryRoot(), 'config.json')
    const st = existsSync(file) ? statSync(file) : null
    const mtime = st ? st.mtimeMs : 0
    if (!force && CACHE.cfg && CACHE.path === file && CACHE.mtime === mtime) return CACHE.cfg
    let raw = {}
    if (st) {
      try { raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { raw = {} }
    }
    const cfg = normalizeConfig(raw)
    CACHE.path = file
    CACHE.mtime = mtime
    CACHE.cfg = cfg
    return cfg
  } catch {
    return normalizeConfig({})
  }
}
