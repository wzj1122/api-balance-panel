import fs from 'node:fs'
import path from 'node:path'
import { LOG_DIR, LOG_FILE } from './paths'

/**
 * 统一日志：
 * - 级别：debug / info / warn / error（默认 info，可在「运行日志」页临时切到 debug）
 * - 输出：内存环形缓冲（供界面查看）+ 文件追加（按 2MB 轮转，保留最近 8 个文件）
 * - 脱敏：写入前统一过滤密钥、Cookie、Authorization、手机号、邮箱（日志可安全外发）
 * - 兼容：logger.info('文本') 与 logger.warn('文本', 额外信息) 两种调用都支持
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const MAX_BUFFER = 3000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const KEEP_FILES = 8

export interface LogEntry {
  ts: number
  level: LogLevel
  text: string
}

let minLevel: LogLevel = 'info'
export function setLogLevel(level: LogLevel): void {
  minLevel = level
  write('info', '[log] 日志级别已切换为 ' + level)
}
export function getLogLevel(): LogLevel {
  return minLevel
}

/** 脱敏：任何密钥/凭据都不应出现在日志里 */
export function sanitize(input: string): string {
  let s = input
  s = s.replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
  s = s.replace(/(cookie|authorization|api[-_]?key|apikey|access[-_]?key|secret|token)(\s*[:=]\s*)([^\s,;'"]{6,})/gi, '$1$2***')
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***@***')
  s = s.replace(/\b1[3-9]\d{9}\b/g, '1**********')
  return s
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function joinArgs(args: unknown[]): string {
  return args
    .map((a) => stringify(a))
    .filter((s) => s.length > 0)
    .join(' ')
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}

function stamp(ts: number): string {
  const d = new Date(ts)
  return (
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3)
  )
}

const buffer: LogEntry[] = []

/** 启动时把上次运行的最后 400 行读进缓冲，界面能看到重启前的记录 */
function loadTail(): void {
  try {
    if (!fs.existsSync(LOG_FILE)) return
    const text = fs.readFileSync(LOG_FILE, 'utf8')
    const lines = text.split('\n').filter((l) => l.trim().length > 0).slice(-400)
    for (const line of lines) {
      const m = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\] \[(\w+)\] (.*)$/)
      if (!m) continue
      const ts = new Date(m[1].replace(' ', 'T')).getTime()
      buffer.push({ ts: Number.isFinite(ts) ? ts : Date.now(), level: m[2] as LogLevel, text: m[3] })
    }
  } catch {
    /* 忽略：日志读不出来不影响运行 */
  }
}
loadTail()

function rotate(): void {
  try {
    if (!fs.existsSync(LOG_FILE)) return
    const size = fs.statSync(LOG_FILE).size
    if (size < MAX_FILE_BYTES) return
    const rotated = path.join(LOG_DIR, 'main-' + Date.now() + '.log')
    fs.renameSync(LOG_FILE, rotated)
    const files = fs
      .readdirSync(LOG_DIR)
      .filter((f) => /^main(-\d+)?\.log$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(LOG_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const old of files.slice(KEEP_FILES)) {
      try { fs.rmSync(path.join(LOG_DIR, old.f)) } catch { /* 忽略 */ }
    }
  } catch {
    /* 忽略轮转失败，继续写 */
  }
}

function write(level: LogLevel, text: string): void {
  const safe = sanitize(text)
  buffer.push({ ts: Date.now(), level, text: safe })
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER)
  if (ORDER[level] < ORDER[minLevel]) return
  const line = '[' + stamp(Date.now()) + '] [' + level.toUpperCase() + '] ' + safe + '\n'
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    rotate()
    fs.appendFileSync(LOG_FILE, line, 'utf8')
  } catch {
    /* 文件写不了也不能影响主流程 */
  }
  const console_ = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  console_(line.trimEnd())
}

export const logger = {
  debug: (...args: unknown[]): void => write('debug', joinArgs(args)),
  info: (...args: unknown[]): void => write('info', joinArgs(args)),
  warn: (...args: unknown[]): void => write('warn', joinArgs(args)),
  error: (...args: unknown[]): void => write('error', joinArgs(args))
}

/** 界面读取：可按级别与关键字过滤 */
export function readLogs(opts?: { limit?: number; level?: LogLevel; keyword?: string }): LogEntry[] {
  const limit = Math.min(Math.max(opts?.limit ?? 500, 1), MAX_BUFFER)
  const min = opts?.level ? ORDER[opts.level] : 0
  const kw = (opts?.keyword ?? '').trim().toLowerCase()
  let list = buffer.filter((e) => ORDER[e.level] >= min)
  if (kw) list = list.filter((e) => e.text.toLowerCase().includes(kw))
  return list.slice(-limit)
}

export function clearLogs(): void {
  buffer.length = 0
  try {
    fs.writeFileSync(LOG_FILE, '', 'utf8')
  } catch { /* 忽略 */ }
}

/** 导出：把当前缓冲 + 磁盘日志合并成一个文件，返回路径 */
export function exportLogs(): { ok: boolean; path?: string; error?: string } {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    const target = path.join(LOG_DIR, 'export-' + Date.now() + '.log')
    const head = [
      'API 余额面板 日志导出' + '\n',
      '导出时间：' + new Date().toLocaleString('zh-CN') + '\n',
      '当前级别：' + minLevel + '\n',
      '说明：内容已脱敏（密钥/Cookie/Authorization 均已替换为 ***）\n',
      '='.repeat(60) + '\n'
    ].join('')
    fs.writeFileSync(target, head, 'utf8')
    for (const e of buffer) {
      fs.appendFileSync(target, '[' + stamp(e.ts) + '] [' + e.level.toUpperCase() + '] ' + e.text + '\n', 'utf8')
    }
    return { ok: true, path: target }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function listLogFiles(): { name: string; size: number; mtime: number }[] {
  try {
    return fs
      .readdirSync(LOG_DIR)
      .filter((f) => f.endsWith('.log'))
      .map((f) => {
        const st = fs.statSync(path.join(LOG_DIR, f))
        return { name: f, size: st.size, mtime: st.mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return []
  }
}
