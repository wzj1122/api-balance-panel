import { MIMO_PLAN_DETAIL_URL, MIMO_PLAN_URL } from '../../shared/constants'
import type { BalanceItem } from '../../shared/types'
import { AdapterError, mapHttpStatus } from '../errors'
import { request } from '../http'
import type { Adapter } from './types'
import { assertNotExpired, dig, num, okResult, safeJson } from './util'

/**
 * 小米 MiMo Token Plan 套餐（Cookie，与「小米 MiMo」余额共用同一登录状态）。
 *
 * 实测抓包（2026-09-09，控制台 /console/plan-manage）：
 *   1. GET /api/v1/tokenPlan/detail → data.planName / currentPeriodEnd / planCode
 *   2. GET /api/v1/tokenPlan/usage  → data.usage.items[]（used / limit，取 limit>0 的那条）
 *
 * 额度单位沿用 M Credits（百万 Credits），如 4,100,000,000 → 4100。
 */
export const mimoPlanAdapter: Adapter = async (account, ctx) => {
  const cookie = ctx.getSecret(account)
  if (!cookie) throw new AdapterError('MISSING_FIELD', 'Cookie')

  const headers = { Cookie: cookie, Accept: 'application/json' }

  // 1) 套餐详情（名称 + 有效期）
  const r1 = await request(MIMO_PLAN_DETAIL_URL, { headers })
  assertNotExpired(r1, '请点「登录 MiMo」重新登录一次')
  if (r1.status !== 200) throw new AdapterError(mapHttpStatus(r1.status), r1.text.slice(0, 160))
  const d1 = (dig(safeJson(r1.text, MIMO_PLAN_DETAIL_URL), 'data') as Record<string, unknown>) ?? {}
  const planCode = typeof d1.planCode === 'string' ? d1.planCode : ''
  const planName = typeof d1.planName === 'string' && d1.planName ? d1.planName : '套餐'
  const periodEnd = typeof d1.currentPeriodEnd === 'string' ? d1.currentPeriodEnd : ''
  if (!planCode) {
    throw new AdapterError('BAD_PATH', '没有查到生效中的套餐（可能未开通），或者平台页面结构变了')
  }

  // 2) 用量（used / limit）
  const r2 = await request(MIMO_PLAN_URL, { headers })
  assertNotExpired(r2, '请点「登录 MiMo」重新登录一次')
  if (r2.status !== 200) throw new AdapterError(mapHttpStatus(r2.status), r2.text.slice(0, 160))
  const j2 = safeJson(r2.text, MIMO_PLAN_URL)
  const usageItems = dig(j2, 'data.usage.items')
  const scale = 0.000001
  let used: number | null = null
  let limit: number | null = null
  if (Array.isArray(usageItems)) {
    const it = (usageItems as Array<Record<string, unknown>>).find((x) => (num(x.limit) ?? 0) > 0)
    used = num(it?.used, scale)
    limit = num(it?.limit, scale)
  }
  if (used === null || limit === null) {
    throw new AdapterError('BAD_PATH', '套餐用量接口返回的结构变了，请把 F12 Network 里 tokenPlan/usage 的响应发我们排查')
  }
  const remain = Math.round((limit - used) * 1e6) / 1e6
  const date = periodEnd.slice(0, 10)
  const items: BalanceItem[] = [
    { planName, remaining: remain, total: limit, used, unit: 'M Credits', note: '有效期至 ' + date }
  ]
  return okResult({
    remaining: remain,
    total: limit,
    used,
    unit: 'M Credits',
    note: planName + ' · 有效期至 ' + date,
    items
  })
}
