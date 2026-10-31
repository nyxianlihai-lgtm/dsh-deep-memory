#!/usr/bin/env node
// 把 dsh-deep-memory 的库导出成 viz-kit「记忆星河」要的数据格式。
//
//   node scripts/viz-export.mjs                 # 写到 viz-kit/data.json
//   node scripts/viz-export.mjs --out C:\x.json # 写到别处
//
// 契约（viz-kit/README.md）：{ stars: [{id,kind,text,importance,activation,whenLabel,scope,status,source}], counts }
// importance 决定星星大小，activation 决定亮度——这里算好，前端不重算。
//
// 只读：不写记忆库，只写 viz-kit/data.json。

import { existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadStore, memoryRoot } from '../lib/store.js'
import { loadConfig } from '../lib/config.js'
import { MemoryEngine } from '../lib/memory.js'
import { relDay, formatDate } from '../lib/text.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const KIT = resolve(HERE, '..', 'viz-kit')

const argv = process.argv.slice(2)
const outAt = argv.indexOf('--out')
const OUT = outAt >= 0 && argv[outAt + 1] ? resolve(argv[outAt + 1]) : join(KIT, 'data.json')

const root = memoryRoot()
if (!existsSync(root)) {
  console.error('还没有记忆库：' + root)
  console.error('先让 DSH 跑一轮，或者在插件里 remember 一条。')
  process.exit(1)
}

const files = readdirSync(root)
  .filter((f) => /^(global|ws-.+|session-.+)\.json$/.test(f))
  .sort()

const cfg = loadConfig(true)
const engine = new MemoryEngine([], cfg) // 只用它的 activation()，不需要层

const stars = []

// 同一 id 永远同一位置：画像条目没有稳定 id，用正文算一个
function h32(s) {
  let h = 2166136261
  for (const c of String(s)) {
    h ^= c.charCodeAt(0)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

function whenOf(item) {
  const d = item.tEvent || (item.tRecord ? formatDate(item.tRecord) : '')
  return d ? relDay(d) : ''
}

// 'global' 会被框架翻成「共用」；工作区用目录名，比 ws:xxx-0acbeccb 好读
function scopeName(scope) {
  const s = String(scope || '')
  if (s === 'global') return 'global'
  if (s.startsWith('ws:')) return s.slice(3).replace(/-[0-9a-f]{8}$/, '')
  if (s.startsWith('session:')) return '单次会话'
  return s || 'default'
}

for (const f of files) {
  const data = loadStore(join(root, f), f)
  const scope = scopeName(data.scope)

  // ---- 画像：拆成一颗颗星，常驻所以永远最亮 ----
  const p = data.profile || {}
  const profileLines = []
  if (p.address) profileLines.push('称呼：' + p.address)
  for (const s of p.style || []) profileLines.push('偏好：' + s)
  for (const s of p.agreements || []) profileLines.push('约定：' + s)
  for (const s of p.boundaries || []) profileLines.push('边界：' + s)
  for (const t of profileLines) {
    stars.push({
      id: 'profile:' + scope + ':' + h32(t),
      kind: 'profile',
      text: t,
      scope,
      whenLabel: '',
      importance: 1,
      activation: 1,
      status: 'current',
      source: 'profile',
    })
  }

  // ---- 事实：sticky 单列一种颜色；superseded 也画出来（能看见"被取代"）----
  for (const fact of data.facts || []) {
    stars.push({
      id: fact.id,
      kind: fact.sticky ? 'sticky' : 'fact',
      text: fact.text,
      scope,
      whenLabel: whenOf(fact),
      importance: Number(fact.importance ?? 0.5),
      activation: engine.activation(fact),
      status: fact.status || 'current',
      source: fact.source && fact.source.kind === 'auto' ? 'chat' : 'manual',
    })
  }

  for (const ev of data.events || []) {
    stars.push({
      id: ev.id,
      kind: 'event',
      text: ev.text,
      scope,
      whenLabel: whenOf(ev),
      importance: Number(ev.importance ?? 0.5),
      activation: engine.activation(ev),
      status: ev.status || 'current',
      source: 'chat',
    })
  }

  for (const pd of data.pending || []) {
    stars.push({
      id: pd.id,
      kind: 'pending',
      text: pd.text,
      scope,
      whenLabel: pd.due ? '截止 ' + pd.due : whenOf(pd),
      // pending 本身没存重要度：未结束的事按"还得盯"给中上
      importance: 0.6,
      activation: 1,
      status: pd.state || 'open',
      source: 'manual',
    })
  }
}

const counts = {}
for (const s of stars) counts[s.kind] = (counts[s.kind] || 0) + 1

const payload = {
  generatedAt: new Date().toISOString(),
  today: formatDate(Date.now()),
  counts,
  stars,
}

// 第一次跑：把仓库自带的示例数据留一份，别直接覆盖掉
if (existsSync(OUT)) {
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf8'))
    if (!prev.generatedAt) {
      const sample = OUT.replace(/\.json$/, '.sample.json')
      if (!existsSync(sample)) copyFileSync(OUT, sample)
      console.log('原示例数据已另存：' + sample)
    }
  } catch { /* 坏文件就覆盖 */ }
}

writeFileSync(OUT, JSON.stringify(payload, null, 1), 'utf8')

const byKind = Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(' ')
console.log(`导出 ${stars.length} 颗星 -> ${OUT}`)
console.log('  ' + byKind)
console.log(`  来源文件：${files.join(', ')}`)
console.log('看：node viz-kit/serve.mjs 8080 然后开 http://127.0.0.1:8080')
