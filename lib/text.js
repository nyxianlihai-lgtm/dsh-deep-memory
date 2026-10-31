// 时间、相似度、脱敏、id —— 都是纯函数，方便单测。

import { tokens } from './tokenize.js'

export const DAY = 86400000

const pad2 = (n) => String(n).padStart(2, '0')

/** 本地日期（不是 UTC）——凌晨 0-8 点用 UTC 会记成前一天。 */
export function today(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}

export function formatDate(ms) {
  return today(new Date(ms))
}

export function dayKey(ms) {
  return formatDate(ms)
}

export function uid(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** 「上次/之前/还记得」这类追问，降低时间衰减。 */
export const RECALL_CUE = /上次|上回|之前|那次|那天|以前|还记得|记不记得|说过|提过|刚才|刚刚|前面|那次会议/

/** 问句里的时间词 -> 天数区间（from 天前 ~ to 天前）。 */
export const TIME_CUES = [
  { re: /今天|今日|今儿|刚刚|刚才/, from: 0, to: 0 },
  { re: /昨天|昨日|昨晚/, from: 1, to: 1 },
  { re: /前天/, from: 2, to: 2 },
  { re: /这几天|最近|前几天|这一阵|前阵子/, from: 0, to: 7 },
  { re: /上周|上星期/, from: 7, to: 14 },
  { re: /上个月/, from: 28, to: 62 },
]

export function timeWindow(query) {
  const s = String(query || '')
  for (const c of TIME_CUES) if (c.re.test(s)) return c
  return null
}

/**
 * 绝对日期 -> 人话，但**自带绝对日期**，模型不用做任何换算：
 *   今天 / 昨天（10-30）/ 5 天前（10-26 周日）/ 上周五（10-23）/ 去年 10-30
 */
export function relDay(dateStr, now = new Date()) {
  const raw = String(dateStr || '').slice(0, 10)
  const d = Date.parse(`${raw}T00:00:00`)
  if (!isFinite(d)) return raw
  const todayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const diff = Math.round((todayMs - d) / DAY)
  const dt = new Date(d)
  const md = `${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`
  const wk = '日一二三四五六'[dt.getDay()]
  const sameYear = dt.getFullYear() === now.getFullYear()

  if (diff === 0) return '今天'
  if (diff === 1) return `昨天（${md}）`
  if (diff === 2) return `前天（${md}）`
  if (diff > 2 && diff <= 6) return `${diff} 天前（${md} 周${wk}）`
  if (diff >= 7 && diff <= 13) return `上周${wk}（${md}）`
  if (diff >= 14 && diff <= 27) return `${Math.round(diff / 7)} 周前（${md}）`
  if (diff > 27 && sameYear) return `${dt.getMonth() + 1} 月 ${dt.getDate()} 日`
  if (!sameYear) return `去年 ${dt.getMonth() + 1} 月 ${dt.getDate()} 日`
  return md
}

export function jaccard(a, b) {
  const A = tokens(a)
  const B = tokens(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter += 1
  return inter / (A.size + B.size - inter)
}

/** 写入前脱敏：密钥、token、密码一律不落盘。 */
export function redactSecrets(text) {
  const before = String(text == null ? '' : text)
  let out = before
  out = out.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[已隐去]')
  out = out.replace(/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}\b/g, '[已隐去]')
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[已隐去]')
  out = out.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[已隐去]')
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, 'Bearer [已隐去]')
  out = out.replace(
    /((?:api[_-]?key|access[_-]?token|secret|password|passwd|pwd)\s*[:=]\s*)["']?[^\s"',;]{6,}/gi,
    '$1[已隐去]',
  )
  return { text: out, hit: out !== before }
}
