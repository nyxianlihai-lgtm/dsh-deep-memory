// 诊断日志：只写给排查用，任何失败都不许影响对话。

import { appendFileSync, existsSync, mkdirSync, statSync, truncateSync } from 'node:fs'
import { join } from 'node:path'
import { memoryRoot } from './store.js'

const MAX = 512 * 1024

export function diag(msg) {
  try {
    const dir = memoryRoot()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'diag.log')
    if (existsSync(file) && statSync(file).size > MAX) truncateSync(file, 0)
    const line = '[' + new Date().toISOString() + '] ' + String(msg == null ? '' : msg) + '\n'
    appendFileSync(file, line, 'utf8')
  } catch { /* 日志写不进去就算了 */ }
}
