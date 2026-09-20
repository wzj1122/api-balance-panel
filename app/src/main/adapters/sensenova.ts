import { SENSENOVA_POOL_USAGE_URL } from '../../shared/constants'
import type { BalanceItem } from '../../shared/types'
import { AdapterError, mapHttpStatus } from '../errors'
import { request } from '../http'
import type { Adapter } from './types'
import { num, okResult } from './util'

/**
 * 商汤 日日新（SenseNova）· Token Plan 额度。
 *
 * 口径（2026-09 实测 platform.sensenova.cn/console「账户总览」）：
 *   GET /lite/console/v1/tokenplan/pool-usage   Authorization: Bearer <登录态 access_token>
 *   → {
 *       plan:  { id, name, type },
 *       pools: [{
 *         name: '通用积分池' | 'Flash-Lite积分池',
 *         pool_type: 'default' | 'dedicated',
 *         window_5h: { limit, used, remaining, reset_at },   // 5 小时窗口，重置后恢复
 *         window_7d: { limit, used, remaining, reset_at }    // 周额度（7 天）
 *       }]
 *     }
 *
 * 为什么是「5 小时 + 周额度」两个口径：
 *   - 5 小时窗口 = 短时用量限制（例如 60,000 分/5 小时），决定你「现在还能不能用、能用多少」；
 *   - 周额度   = 7 天总量（例如 600,000 分/周），决定本周总共还能花多少。
 *   两者都会自动重置，卡片主数值取「5 小时窗口剩余」（最贴近当下的可用量），
 *   周额度剩余作为 total/进度条与备注展示；Flash-Lite 有独立积分池时单独列一行。
 *
 * 鉴权：额度接口只认控制台登录态（Bearer JWT），Cookie 无效（实测 401）；
 * 因此 secret 里存的是「登录获取的 access_token」，过期后界面会提示重新登录。
 */

/** 接口里的数值都是字符串（"60000" / "248.06624"），统一按 number 解析 */
interface Window5h {
  limit?: unknown
  used?: unknown
  remaining?: unknown
  reset_at?: unknown
}

interface Pool {
  name?: unknown
  pool_type?: unknown
  window_5h?: Window5h
  window_7d?: Window5h
  grant_balance?: unknown
  nearest_grant_expiry?: unknown
}

/** 秒级时间戳（字符串）→ 本地时间文案 */
export function fmtResetAt(v: unknown): string {
  const ts = num(v)
  if (ts === null || ts <= 0) return ''
  const d = new Date(ts * 1000)
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`
}

export const sensenovaAdapter: Adapter = async (account, ctx) => {
  const token = ctx.getSecret(account)
  if (!token) {
    throw new AdapterError('MISSING_FIELD', '登录态（请点「登录」在商汤开放平台登录一次）')
  }

  const r = await request(SENSENOVA_POOL_USAGE_URL, {
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json'
    }
  })
  if (r.status === 401 || r.status === 403) {
    throw new AdapterError('COOKIE_EXPIRED', '登录态已过期，请重新点「登录」')
  }
  if (r.status !== 200) {
    throw new AdapterError(mapHttpStatus(r.status), r.text.slice(0, 160))
  }

  let json: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(r.text)
    if (!parsed || typeof parsed !== 'object') throw new Error('不是对象')
    json = parsed as Record<string, unknown>
  } catch {
    throw new AdapterError('BAD_JSON', SENSENOVA_POOL_USAGE_URL)
  }

  const poolsRaw = json.pools
  const pools = Array.isArray(poolsRaw) ? (poolsRaw as Pool[]) : []
  if (pools.length === 0) {
    throw new AdapterError('BAD_PATH', '额度接口没有返回积分池（可能账号还没开通 Token Plan）')
  }

  // 主池：优先 default（通用积分池），没有就取第一个
  const main = pools.find((p) => String(p?.pool_type ?? '') === 'default') ?? pools[0]
  const w5 = (main?.window_5h ?? {}) as Window5h
  const w7 = (main?.window_7d ?? {}) as Window5h

  const remain5 = num(w5.remaining)
  const limit5 = num(w5.limit)
  const used5 = num(w5.used)
  const remain7 = num(w7.remaining)
  const limit7 = num(w7.limit)
  const used7 = num(w7.used)

  if (remain5 === null && remain7 === null) {
    throw new AdapterError('BAD_PATH', '额度接口没有 window_5h / window_7d 字段，平台结构可能变了')
  }

  const planName = typeof json.plan === 'object' && json.plan !== null
    ? String((json.plan as Record<string, unknown>).name ?? 'Token Plan')
    : 'Token Plan'
  const unit = '积分'
  const reset5 = fmtResetAt(w5.reset_at)
  const reset7 = fmtResetAt(w7.reset_at)

  const items: BalanceItem[] = []

  // 主数值行：5 小时窗口
  items.push({
    planName: '5 小时窗口剩余',
    remaining: remain5,
    total: limit5,
    used: used5,
    unit,
    note: reset5 ? '重置时间 ' + reset5 : undefined
  })
  // 周额度行
  items.push({
    planName: '周额度剩余（7 天）',
    remaining: remain7,
    total: limit7,
    used: used7,
    unit,
    note: reset7 ? '重置时间 ' + reset7 : undefined
  })
  // 其他积分池（如 Flash-Lite 专属池）单独列出
  for (const p of pools) {
    if (p === main) continue
    const name = String(p?.name ?? '专属积分池')
    const p5 = (p?.window_5h ?? {}) as Window5h
    const p7 = (p?.window_7d ?? {}) as Window5h
    items.push({
      planName: name,
      remaining: num(p5.remaining) ?? num(p7.remaining),
      total: num(p5.limit) ?? num(p7.limit),
      used: num(p5.used) ?? num(p7.used),
      unit,
      note: '5h ' + (fmtResetAt(p5.reset_at) || '—') + ' · 7d ' + (fmtResetAt(p7.reset_at) || '—')
    })
  }

  const noteParts = [planName]
  if (reset5) noteParts.push('5 小时窗口 ' + reset5 + ' 重置')
  if (pools.length > 1) noteParts.push(pools.length + ' 个积分池')

  return okResult({
    // 主数值 = 5 小时窗口剩余（最贴近"现在还能用多少"），进度条分母用 5 小时上限
    remaining: remain5 ?? remain7,
    total: limit5 ?? limit7,
    used: used5 ?? used7,
    unit,
    note: noteParts.join(' · '),
    items
  })
}
