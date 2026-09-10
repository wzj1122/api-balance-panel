import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { maskSecret } from '../shared/format'
import type { Monitor, MonitorCheck, MonitorInput, MonitorReport, MonitorStat, MonitorView } from '../shared/types'
import { CRYPTO_VERSION, currentScheme, decrypt, encrypt } from './crypto'
import { logger } from './logger'
import { DATA_DIR } from './paths'

/**
 * 接口监控（用户自填 API Key + 调用地址，面板定期**真实调用**该接口）。
 *
 * - 与「余额轮询可用性」不同：这里是你指定要监控的线上接口（例如某个 LLM 的 chat/completions）。
 * - 每次检查都是一次真实请求，LLM 接口会产生极少量费用，默认请求体已把 max_tokens 压到 1。
 * - Key 与账号密钥使用同一套本机加密（safeStorage），明文不落盘。
 * - 窗口隐藏/最小化时仍会继续检查（监控工具需要连续数据）；可在目标上单独暂停。
 */

const MONITORS_FILE = path.join(DATA_DIR, 'monitors.json')
const HISTORY_FILE = path.join(DATA_DIR, 'monitor-history.json')
const MAX_PER_MONITOR = 1000
const MAX_TOTAL = 6000

const DEFAULT_CHAT_BODY =
  '{"model":"deepseek-chat","messages":[{"role":"user","content":"ping"}],"max_tokens":1}'

interface MonitorsFile {
  version: number
  crypto?: { scheme: string; version: number }
  monitors: Monitor[]
}

let monitorsCache: Monitor[] | null = null
let historyCache: MonitorCheck[] | null = null

function loadMonitors(): Monitor[] {
  if (monitorsCache) return monitorsCache
  try {
    const raw = JSON.parse(fs.readFileSync(MONITORS_FILE, 'utf8')) as MonitorsFile
    monitorsCache = Array.isArray(raw?.monitors) ? raw.monitors : []
  } catch {
    monitorsCache = []
  }
  return monitorsCache
}

function saveMonitors(): void {
  if (!monitorsCache) return
  const payload: MonitorsFile = {
    version: 1,
    crypto: { scheme: currentScheme(), version: CRYPTO_VERSION },
    monitors: monitorsCache
  }
  try {
    fs.writeFileSync(MONITORS_FILE, JSON.stringify(payload, null, 2), 'utf8')
  } catch (e) {
    logger.warn('[monitor] 写入监控配置失败：' + (e as Error).message)
  }
}

function loadHistory(): MonitorCheck[] {
  if (historyCache) return historyCache
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) as { entries?: MonitorCheck[] }
    historyCache = Array.isArray(raw?.entries) ? raw.entries : []
  } catch {
    historyCache = []
  }
  return historyCache
}

function saveHistory(): void {
  if (!historyCache) return
  if (historyCache.length > MAX_TOTAL) historyCache = historyCache.slice(-MAX_TOTAL)
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({ version: 1, entries: historyCache }), 'utf8')
  } catch (e) {
    logger.warn('[monitor] 写入监控历史失败：' + (e as Error).message)
  }
}

function appendCheck(check: MonitorCheck): void {
  const list = loadHistory()
  list.push(check)
  // 单个目标最多保留 MAX_PER_MONITOR 条
  let count = 0
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].monitorId === check.monitorId) {
      count += 1
      if (count > MAX_PER_MONITOR) list.splice(i, 1)
    }
  }
  saveHistory()
}


export function toMonitorView(m: Monitor): MonitorView {
  const { secret_enc, ...rest } = m
  return { ...rest, has_secret: !!secret_enc }
}

function safeDecrypt(enc: string | null, scheme: string): string {
  if (!enc) return ''
  try {
    return decrypt(enc, scheme as Parameters<typeof decrypt>[1])
  } catch {
    try {
      return decrypt(enc)
    } catch (e) {
      logger.warn('[monitor] 解密密钥失败：' + (e as Error).message)
      return ''
    }
  }
}

export function saveMonitor(input: MonitorInput): MonitorView {
  const list = loadMonitors()
  const now = Date.now()
  const existing = input.id ? list.find((m) => m.id === input.id) ?? null : null
  let secretEnc = existing ? existing.secret_enc : null
  let secretMasked = existing ? existing.secret_masked : ''
  let secretScheme = existing ? existing.secret_scheme : currentScheme()
  if (typeof input.secret === 'string' && input.secret.trim().length > 0) {
    secretEnc = encrypt(input.secret.trim())
    secretMasked = maskSecret(input.secret.trim())
    secretScheme = currentScheme()
  }
  const monitor: Monitor = {
    id: existing ? existing.id : randomUUID(),
    name: input.name?.trim() || (existing ? existing.name : '未命名监控'),
    url: (input.url || '').trim(),
    method: input.method === 'GET' ? 'GET' : 'POST',
    body: typeof input.body === 'string' ? input.body : existing ? existing.body : DEFAULT_CHAT_BODY,
    headers: input.headers && typeof input.headers === 'object' ? input.headers : existing ? existing.headers : {},
    secret_enc: secretEnc,
    secret_masked: secretMasked,
    secret_scheme: secretScheme,
    interval_minutes: clampInt(input.interval_minutes ?? existing?.interval_minutes ?? 10, 1, 1440),
    timeout_ms: clampInt(input.timeout_ms ?? existing?.timeout_ms ?? 20000, 1000, 120000),
    enabled: typeof input.enabled === 'boolean' ? input.enabled : existing ? existing.enabled : true,
    created_at: existing ? existing.created_at : now,
    updated_at: now
  }
  if (!monitor.url) throw new Error('请填写调用地址')
  const idx = list.findIndex((m) => m.id === monitor.id)
  if (idx >= 0) list[idx] = monitor
  else list.push(monitor)
  saveMonitors()
  logger.info('[monitor] 已保存监控目标：' + monitor.name)
  return toMonitorView(monitor)
}

export function removeMonitor(id: string): boolean {
  const list = loadMonitors()
  const idx = list.findIndex((m) => m.id === id)
  if (idx < 0) return false
  list.splice(idx, 1)
  saveMonitors()
  historyCache = loadHistory().filter((c) => c.monitorId !== id)
  saveHistory()
  return true
}

function clampInt(v: number, min: number, max: number): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

/** 把 {{key}} 占位替换成真实密钥 */
function subst(template: string, key: string): string {
  if (!template) return template
  return template.split('{{key}}').join(key)
}

/** 执行一次真实调用 */
export async function runCheck(monitor: Monitor): Promise<MonitorCheck> {
  const key = safeDecrypt(monitor.secret_enc, monitor.secret_scheme)
  const headers: Record<string, string> = { Accept: 'application/json' }
  for (const [k, v] of Object.entries(monitor.headers || {})) {
    if (k) headers[k] = subst(String(v ?? ''), key)
  }
  const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization' || k.toLowerCase() === 'x-api-key')
  if (key && !hasAuth) headers.Authorization = 'Bearer ' + key
  const method = monitor.method === 'GET' ? 'GET' : 'POST'
  let body: string | undefined
  if (method === 'POST') {
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json'
    body = subst(monitor.body || DEFAULT_CHAT_BODY, key)
  }
  const started = Date.now()
  try {
    const res = await fetch(monitor.url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(clampInt(monitor.timeout_ms, 1000, 120000))
    })
    const latency = Date.now() - started
    const text = await res.text()
    const ok = res.status >= 200 && res.status < 300
    return {
      monitorId: monitor.id,
      ts: Date.now(),
      ok,
      status: res.status,
      latency_ms: latency,
      error: ok ? '' : 'HTTP ' + res.status + '：' + text.slice(0, 200)
    }
  } catch (e) {
    return {
      monitorId: monitor.id,
      ts: Date.now(),
      ok: false,
      status: 0,
      latency_ms: Date.now() - started,
      error: (e as Error).message || '请求失败'
    }
  }
}

/** 立即检查指定目标（省略 id = 检查全部启用的目标） */
export async function runMonitors(id?: string): Promise<MonitorCheck[]> {
  const targets = loadMonitors().filter((m) => (id ? m.id === id : m.enabled))
  const out: MonitorCheck[] = []
  for (const m of targets) {
    const check = await runCheck(m)
    appendCheck(check)
    out.push(check)
    logger.info('[monitor] ' + m.name + ' → ' + (check.ok ? 'OK ' + check.latency_ms + 'ms' : '失败：' + check.error.slice(0, 80)))
  }
  return out
}

/** 定时入口：只跑到了间隔的目标 */
export async function runDueMonitors(): Promise<void> {
  const history = loadHistory()
  const lastTs = new Map<string, number>()
  for (const c of history) {
    const prev = lastTs.get(c.monitorId) ?? 0
    if (c.ts > prev) lastTs.set(c.monitorId, c.ts)
  }
  const now = Date.now()
  for (const m of loadMonitors()) {
    if (!m.enabled) continue
    const last = lastTs.get(m.id) ?? 0
    if (now - last < clampInt(m.interval_minutes, 1, 1440) * 60 * 1000) continue
    try {
      const check = await runCheck(m)
      appendCheck(check)
    } catch (e) {
      logger.warn('[monitor] 检查失败：' + (e as Error).message)
    }
  }
}

export function listChecks(monitorId: string, limit: number = 200): MonitorCheck[] {
  return loadHistory()
    .filter((c) => c.monitorId === monitorId)
    .slice(-Math.max(1, Math.min(1000, limit)))
}

/** 统计报告（成功率 / 延迟 / 连续失败 / 每日可用率） */
export function buildMonitorReport(days: number = 30): MonitorReport {
  const monitors = loadMonitors()
  const history = loadHistory()
  const dayCount = Math.min(Math.max(Math.round(days), 1), 90)
  const DAY = 24 * 60 * 60 * 1000
  const today = new Date()
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const slices: { label: string; ts: number }[] = []
  for (let i = dayCount - 1; i >= 0; i--) {
    const start = startOfDay - i * DAY
    const d = new Date(start)
    slices.push({
      label: String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'),
      ts: start
    })
  }
  const out: MonitorReport['monitors'] = []
  for (const m of monitors) {
    const list = history.filter((c) => c.monitorId === m.id).sort((a, b) => a.ts - b.ts)
    const total = list.length
    const okCount = list.filter((c) => c.ok).length
    const lat = list.filter((c) => c.ok).map((c) => c.latency_ms).sort((a, b) => a - b)
    const last = total > 0 ? list[total - 1] : null
    let lastFailTs: number | null = null
    for (let i = total - 1; i >= 0; i--) {
      if (!list[i].ok) { lastFailTs = list[i].ts; break }
    }
    let consecutiveFails = 0
    for (let i = total - 1; i >= 0; i--) {
      if (list[i].ok) break
      consecutiveFails += 1
    }
    const stats: MonitorStat = {
      monitorId: m.id,
      total,
      okCount,
      successRate: total > 0 ? okCount / total : null,
      avgLatency: lat.length > 0 ? lat.reduce((a, b) => a + b, 0) / lat.length : null,
      p95Latency: lat.length > 0 ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] : null,
      lastTs: last ? last.ts : null,
      lastOk: last ? last.ok : null,
      lastStatus: last ? last.status : null,
      lastError: last ? last.error : '',
      lastFailTs,
      consecutiveFails,
      checksToday: list.filter((c) => c.ts >= startOfDay).length,
      days: slices.map((s) => {
        const inDay = list.filter((c) => c.ts >= s.ts && c.ts < s.ts + DAY)
        const ok = inDay.filter((c) => c.ok).length
        return { label: s.label, ts: s.ts, ok, total: inDay.length, rate: inDay.length > 0 ? ok / inDay.length : null }
      })
    }
    out.push({ monitor: toMonitorView(m), stat: stats })
  }
  out.sort((a, b) => {
    if (b.stat.consecutiveFails !== a.stat.consecutiveFails) return b.stat.consecutiveFails - a.stat.consecutiveFails
    const ra = a.stat.successRate === null ? 2 : a.stat.successRate
    const rb = b.stat.successRate === null ? 2 : b.stat.successRate
    return ra - rb || a.monitor.name.localeCompare(b.monitor.name, 'zh')
  })
  const note = monitors.length === 0 ? '还没有监控目标：添加一个「调用地址 + API Key」，面板会按间隔真实调用它并记录可用性' : ''
  return { monitors: out, note }
}

/** 用表单里的临时配置试跑一次（不保存、不计入统计）；编辑场景复用已保存的密钥 */
export async function testMonitor(input: MonitorInput): Promise<MonitorCheck> {
  const now = Date.now()
  const existing = input.id ? loadMonitors().find((m) => m.id === input.id) ?? null : null
  const typed = typeof input.secret === 'string' ? input.secret.trim() : ''
  const temp: Monitor = {
    id: 'test',
    name: input.name || '测试',
    url: (input.url || '').trim(),
    method: input.method === 'GET' ? 'GET' : 'POST',
    body: input.body || DEFAULT_CHAT_BODY,
    headers: input.headers ?? {},
    secret_enc: typed ? encrypt(typed) : existing ? existing.secret_enc : null,
    secret_masked: '',
    secret_scheme: typed ? currentScheme() : existing ? existing.secret_scheme : currentScheme(),
    interval_minutes: 10,
    timeout_ms: clampInt(input.timeout_ms ?? 20000, 1000, 120000),
    enabled: true,
    created_at: now,
    updated_at: now
  }
  if (!temp.url) throw new Error('请填写调用地址')
  return runCheck(temp)
}

/**
 * 删除账号时清理关联的监控目标：
 * 监控目标里存的密钥与被删账号相同（通常是从 Key 列表选择时复制过来的），按密钥精确匹配删除，
 * 避免留下「已删除的 Key」还在被监控的孤儿记录。
 */
export function removeMonitorsBySecret(secret: string): number {
  if (!secret) return 0
  const list = loadMonitors()
  const doomed: string[] = []
  const keep = list.filter((m) => {
    const s = safeDecrypt(m.secret_enc, m.secret_scheme)
    if (s && s === secret) {
      doomed.push(m.id)
      return false
    }
    return true
  })
  if (doomed.length === 0) return 0
  monitorsCache = keep
  saveMonitors()
  historyCache = loadHistory().filter((c) => !doomed.includes(c.monitorId))
  saveHistory()
  logger.info('[monitor] 已随账号删除清理 ' + doomed.length + ' 个监控目标')
  return doomed.length
}
