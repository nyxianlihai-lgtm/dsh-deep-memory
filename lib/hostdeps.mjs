// 从宿主那棵树里取 @deepseek-ai/dsh-tools 的 defineTool 和 dsh-llm 的 createUserMessage。
//
// 为什么不能直接 import：
//   DSH 桌面版 profile 默认 autoInstallPeers: false，peer 依赖不会装进插件树；
//   裸 import 会让整条插件 failed to import、DSH 直接把 bundle 条目摘掉。
// 策略：宿主树优先 -> 自己依赖兜底 -> 本地等价实现保底。任何一步失败都不许抛。
//
// 这段思路来自 dsh-fish-memory 的 lib/hostdeps.mjs（MIT），按本项目需要做了裁剪。

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai')

function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)
  const appdata = process.env.APPDATA
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(npm, '@deepseek-ai'))
    try {
      for (const n of readdirSync(join(npm, '@deepseek-ai'))) {
        push(join(npm, '@deepseek-ai', n, 'node_modules', '@deepseek-ai'))
      }
    } catch { /* 没有就算了 */ }
  }
  push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const p of readdirSync(join(dshHome, 'profiles'))) {
      push(join(dshHome, 'profiles', p, 'node_modules', '@deepseek-ai'))
    }
  } catch { /* 没有就算了 */ }
  push(SELF_MODULES)
  return out
}

function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string'
      ? dot
      : (dot?.import || dot?.default || pkg.module || pkg.main)
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch {
    return null
  }
}

async function fromHostTree(name, log) {
  const fails = []
  for (const root of candidateRoots()) {
    if (root === SELF_MODULES) continue
    const url = entryUrlFor(root, name)
    if (!url) continue
    try {
      const mod = await import(url)
      log(`${name}：从宿主树取到（${url.replace(/^file:\/\/\//, '')}）`)
      return mod
    } catch (e) {
      fails.push(`${e?.code || 'ERR'}:${root}`)
    }
  }
  if (fails.length) log(`${name}：宿主树里都不行（${fails.slice(0, 3).join(' ')}）`)
  return null
}

function localDefineTool(options, log) {
  log?.(`dsh-tools 拿不到 —— 用本地等价实现顶上（工具 ${options.name}）`)
  return options
}

export async function loadHostDeps() {
  const notes = []
  const log = (m) => notes.push(m)

  // 测试/排障：强制走本地等价实现，不去宿主树里翻
  if (process.env.DSH_MEMORY_NO_HOSTDEPS === '1') {
    log('DSH_MEMORY_NO_HOSTDEPS=1 —— 用本地等价实现')
    return {
      defineTool: (options) => localDefineTool(options, log),
      createUserMessage: (payload) => ({
        id: randomUUID(),
        role: 'user',
        content: Array.isArray(payload && payload.content) ? payload.content : [],
        ...(payload && payload.source !== undefined ? { source: payload.source } : {}),
      }),
      notes,
    }
  }

  let defineTool = null
  let dtMod = null
  try {
    dtMod = await fromHostTree('dsh-tools', log)
    if (!dtMod) {
      try {
        dtMod = await import('@deepseek-ai/dsh-tools')
        log('dsh-tools：宿主树里没有，用自己依赖里那份')
      } catch (e) {
        log(`dsh-tools 拿不到（${e?.code || ''}）—— 用本地等价实现顶上`)
        dtMod = null
      }
    }
    defineTool = dtMod?.defineTool || ((options) => localDefineTool(options, log))
  } catch (e) {
    log(`dsh-tools 加载异常：${e?.message || e}`)
    defineTool = (options) => localDefineTool(options, log)
  }

  let createUserMessage = null
  let llmMod = null
  try {
    llmMod = await fromHostTree('dsh-llm', log)
    if (!llmMod) {
      try {
        llmMod = await import('@deepseek-ai/dsh-llm')
        log('dsh-llm：宿主树里没有，用自己依赖里那份')
      } catch (e) {
        log(`dsh-llm 拿不到（${e?.code || ''}）—— 用本地等价实现顶上`)
        llmMod = null
      }
    }
    createUserMessage = llmMod?.createUserMessage || ((payload) => {
      const p = payload && typeof payload === 'object' ? payload : {}
      const msg = { id: randomUUID(), role: 'user', content: Array.isArray(p.content) ? p.content : [] }
      if (p.source !== undefined) msg.source = p.source
      return msg
    })
  } catch (e) {
    log(`dsh-llm 加载异常：${e?.message || e}`)
    createUserMessage = (payload) => ({ id: randomUUID(), role: 'user', content: payload?.content || [] })
  }

  return { defineTool, createUserMessage, notes }
}
