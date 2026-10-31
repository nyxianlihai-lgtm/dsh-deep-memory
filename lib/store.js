// 存储层：只管文件在哪、怎么安全地读写，不掺业务。
//
// 目录（独立工作区，和 QQ-pet / 其它插件都不共享）：
//   <DSH_HOME>/deep-memory/
//     config.json              可选，覆盖默认参数
//     global.json              全局层：用户画像 + 跨项目事实
//     ws-<slug>-<hash>.json    工作区层：某个 cwd 的项目记忆
//     session-<id>.json        拿不到 cwd 时的退化层
//     sessions.json            会话 -> 层 的映射（用于工具调用时找回自己的库）
//     backup/<日期>/*.json     每天首次写入前的一份
//     diag.log                 诊断（截断到 512 KB）

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export const VERSION = 1
export const DAY = 86400000

/** DSH 家目录。每次读环境变量——测试里改 DSH_HOME 就能完全隔离。 */
export function dshHome() {
  const env = process.env.DSH_HOME
  return env && String(env).trim() ? resolve(String(env).trim()) : join(homedir(), '.dsh')
}

export function memoryRoot() {
  return join(dshHome(), 'deep-memory')
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

export function storeFile(name) {
  return join(ensureDir(memoryRoot()), String(name) + '.json')
}

/**
 * 工作区标识：同一个目录永远同一个 key，大小写不敏感（Windows），
 * 换机器/换用户目录不影响判重（只用路径本身算，不写死盘符以外的东西）。
 */
export function workspaceScope(cwd) {
  const abs = resolve(String(cwd && String(cwd).trim() ? cwd : process.cwd()))
  const norm = process.platform === 'win32' ? abs.toLowerCase() : abs
  const hash = createHash('sha1').update(norm).digest('hex').slice(0, 8)
  const slug = basename(abs).replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'ws'
  return slug + '-' + hash
}

export function sanitizeSid(sid) {
  return String(sid || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'unknown'
}

/** 工作区根目录放这个空文件 = 这个工作区不要记忆（含 global 用户偏好）。 */
export const OFF_MARKER = '.dsh-memory-off'

/**
 * 这个工作区是不是被标记了「不要记忆」。
 *
 * 从 cwd 往上逐级找，命中任意一层就关掉——这样在 `src/xxx` 子目录里开会话也躲不掉，
 * 不会因为换个子目录就又把记忆放出来。找不到就往盘符根为止。
 */
export function memoryDisabled(cwd) {
  try {
    let dir = resolve(String(cwd && String(cwd).trim() ? cwd : process.cwd()))
    for (let i = 0; i < 24; i += 1) {
      if (existsSync(join(dir, OFF_MARKER))) return true
      const up = dirname(dir)
      if (up === dir) break
      dir = up
    }
  } catch { /* 读不了就当没标记 */ }
  return false
}

export function sessionFileFor(sid) {
  return storeFile('session-' + sanitizeSid(sid))
}

export function blankStore(scope) {
  return {
    version: VERSION,
    scope,
    createdAt: Date.now(),
    profile: { address: '', style: [], agreements: [], boundaries: [], updatedAt: 0 },
    facts: [],
    events: [],
    pending: [],
    recalls: [],
    meta: { lastExtractAt: 0, lastConsolidate: 0, extractRuns: 0, turns: {} },
  }
}

function arrOfObjects(v) {
  return Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) : []
}

function strArr(v, max = 8) {
  return Array.isArray(v)
    ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 60)).slice(-max)
    : []
}

/** 读坏文件也不抛：从空库开始，不让插件把宿主搞崩。 */
export function loadStore(file, scope) {
  const base = blankStore(scope)
  try {
    if (!existsSync(file)) return base
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    if (!raw || typeof raw !== 'object') return base
    const data = { ...base, ...raw }
    data.version = VERSION
    data.profile = {
      address: typeof raw.profile?.address === 'string' ? raw.profile.address.slice(0, 24) : '',
      style: strArr(raw.profile?.style),
      agreements: strArr(raw.profile?.agreements),
      boundaries: strArr(raw.profile?.boundaries),
      updatedAt: Number(raw.profile?.updatedAt) || 0,
    }
    data.facts = arrOfObjects(raw.facts)
    data.events = arrOfObjects(raw.events)
    data.pending = arrOfObjects(raw.pending)
    data.recalls = arrOfObjects(raw.recalls).slice(-50)
    data.meta = {
      lastExtractAt: Number(raw.meta?.lastExtractAt) || 0,
      lastConsolidate: Number(raw.meta?.lastConsolidate) || 0,
      extractRuns: Number(raw.meta?.extractRuns) || 0,
      turns: raw.meta?.turns && typeof raw.meta.turns === 'object' ? raw.meta.turns : {},
    }
    return data
  } catch {
    return base
  }
}

/** 原子写：先写 .tmp 再 rename，进程被砍也不会留下半个 JSON。 */
export function saveStore(file, data) {
  ensureDir(memoryRoot())
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(data), 'utf8')
  renameSync(tmp, file)
  return file
}

/** 每天首次写入前留一份；只留最近 14 天。 */
export function backupStore(file) {
  try {
    if (!existsSync(file)) return ''
    const dir = join(ensureDir(memoryRoot()), 'backup', new Date().toISOString().slice(0, 10))
    mkdirSync(dir, { recursive: true })
    const dst = join(dir, basename(file))
    if (!existsSync(dst)) copyFileSync(file, dst)
    const root = join(memoryRoot(), 'backup')
    const days = readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
    for (const d of days.slice(0, Math.max(0, days.length - 14))) {
      try { rmSync(join(root, d), { recursive: true, force: true }) } catch { /* 删不掉就算了 */ }
    }
    return dst
  } catch {
    return ''
  }
}

// ---------- 会话 -> 层 ----------

export function loadSessionMap() {
  const file = join(memoryRoot(), 'sessions.json')
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    const sessions = raw && typeof raw.sessions === 'object' && raw.sessions ? raw.sessions : {}
    return { version: VERSION, sessions }
  } catch {
    return { version: VERSION, sessions: {} }
  }
}

export function saveSessionMap(map) {
  const file = join(memoryRoot(), 'sessions.json')
  const entries = Object.entries(map.sessions || {})
    .sort((a, b) => (Number(b[1]?.at) || 0) - (Number(a[1]?.at) || 0))
    .slice(0, 800)
  const out = { version: VERSION, sessions: Object.fromEntries(entries) }
  try {
    saveStore(file, out)
    map.sessions = out.sessions
  } catch { /* 映射丢了不致命，下次挂载会重建 */ }
  return out
}
