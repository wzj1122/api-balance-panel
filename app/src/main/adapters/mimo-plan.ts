import {
  MIMO_PLAN_DETAIL_URL,
  MIMO_PLAN_PRICES,
  MIMO_PLAN_URL,
  MIMO_PLAN_USAGE_DETAIL_URL
} from '../../shared/constants'
import type { BalanceItem, PlanModelUsage, PlanUsageInfo } from '../../shared/types'
import { AdapterError, mapHttpStatus } from '../errors'
import { request } from '../http'
import type { Adapter } from './types'
import { assertNotExpired, dig, num, okResult, round6, safeJson } from './util'

/**
 * 小米 MiMo Token Plan 套餐（Cookie，与「小米 MiMo」余额共用同一登录状态）。
 *
 * 实测抓包（2026-10-03，控制台 /console/plan-manage，用户本人 Lite 套餐）：
 *   1. GET  /api/v1/tokenPlan/detail → data.planCode / planName / currentPeriodEnd /
 *      expired / enableAutoRenew / hasAutoRenewSubscribed
 *   2. GET  /api/v1/tokenPlan/usage  → data.usage.items[]（plan_total_token 的 used / limit / percent）
 *      （还有 data.monthUsage，是「本月」窗口，官方页面上「当前套餐用量」用的是 usage 那条）
 *   3. POST /api/v1/usage/token-plan/list?api-platform_ph=<Cookie 里那个值>
 *      body {year, month} → data[] 每行 = 某天的某个模型：
 *      { date, model, totalToken, inputHitToken, inputMissToken, outputToken,
 *        requestCount, inputAudioDuration }
 *      只给 year 时按「月 × 模型」聚合；缺少 api-platform_ph 参数一律 401（实测）。
 *
 * 两套口径**不能相加**，界面也要分开显示：
 * - 套餐额度 = Credits（官方进度条口径，`percent` 就是它），
 *   按用户给的价格「百分比 × 套餐价」折算成人民币；
 * - 使用详情 = Tokens（按模型拆分），是另一个计数器。
 *   实测同一天：额度已用 163,970,998 Credits（4%）而模型 Token 合计 65,157,997 Tokens。
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

  // 2) 额度用量（used / limit / percent）
  const r2 = await request(MIMO_PLAN_URL, { headers })
  assertNotExpired(r2, '请点「登录 MiMo」重新登录一次')
  if (r2.status !== 200) throw new AdapterError(mapHttpStatus(r2.status), r2.text.slice(0, 160))
  const j2 = safeJson(r2.text, MIMO_PLAN_URL)
  const scale = 0.000001
  const usageItems = dig(j2, 'data.usage.items')
  let used: number | null = null
  let limit: number | null = null
  let pct: number | null = null
  if (Array.isArray(usageItems)) {
    const list = usageItems as Array<Record<string, unknown>>
    // 优先取官方的「套餐月总量」条目，取不到再退回第一条有上限的
    const it = list.find((x) => x.name === 'plan_total_token' && (num(x.limit) ?? 0) > 0)
      ?? list.find((x) => (num(x.limit) ?? 0) > 0)
    used = num(it?.used, scale)
    limit = num(it?.limit, scale)
    const p = num(it?.percent)
    pct = p === null ? null : p * 100
  }
  if (used === null || limit === null) {
    throw new AdapterError('BAD_PATH', '套餐用量接口返回的结构变了，请把 F12 Network 里 tokenPlan/usage 的响应发我们排查')
  }
  const remain = Math.round((limit - used) * 1e6) / 1e6
  const date = periodEnd.slice(0, 10)

  // 3) 价目表 → 按百分比折算金额（用户口径：百分比 × 该版本价格）
  const entry = MIMO_PLAN_PRICES[planCode]
  const cyclePrice = entry ? entry.price : null
  const fmtCny = (v: number): string => (Math.round(v * 100) / 100).toFixed(2)
  const priceNote = entry
    ? entry.name + ' ¥' + fmtCny(entry.price) + (entry.months >= 12 ? '/年（月均 ¥' + fmtCny(entry.price / entry.months) + '）' : '/月')
    : planName + '（价目表未收录该套餐码）'
  const frac = limit > 0 ? used / limit : 0
  // 折算口径按用户要求走**官方百分比**（4.0% × ¥39 = ¥1.56），而不是自己拿 used/limit 再算一遍，
  // 这样界面上的「已用 4.0%」和「已用 ¥1.56」永远自洽
  const pctFraction = pct === null || pct < 0 ? frac : pct / 100
  const usedCny = cyclePrice === null ? null : round6(pctFraction * cyclePrice)
  const remainCny = usedCny === null || cyclePrice === null ? null : round6(cyclePrice - usedCny)

  // 4) 分模型 Token 用量（独立口径；取不到不影响整体成功，卡片只显示额度部分）
  const detail = await fetchModelUsage(cookie, periodEnd, planCode)

  const plan: PlanUsageInfo = {
    planCode,
    planName,
    periodEnd: date,
    expired: d1.expired === true,
    autoRenew: d1.hasAutoRenewSubscribed === true || d1.enableAutoRenew === true,
    price: cyclePrice,
    priceNote,
    percent: pct === null ? round6(frac * 100) : round6(pct),
    usedCny,
    remainCny,
    tokenWindow: detail.window,
    totalTokens: detail.totalTokens,
    requestCount: detail.requestCount,
    models: detail.models
  }

  const items: BalanceItem[] = [
    { planName, remaining: remain, total: limit, used, unit: 'M Credits', note: '有效期至 ' + date }
  ]
  return okResult({
    remaining: remain,
    total: limit,
    used,
    unit: 'M Credits',
    note: planName + ' · 有效期至 ' + date,
    items,
    plan
  })
}

interface DetailRow {
  date: string
  model: string
  totalToken: number
  inputHitToken: number
  inputMissToken: number
  outputToken: number
  requestCount: number
}

interface ModelUsageResult {
  window: string
  totalTokens: number | null
  requestCount: number | null
  models: PlanModelUsage[]
}

/** 一次「使用详情」最多查几个月（年付套餐会跨很多月，别把刷新拖垮） */
const MAX_MONTHS = 3

/** 从 Cookie 串里取 api-platform_ph（平台把它当查询参数用；Cookie 值带首尾引号，要去掉） */
function phFromCookie(cookie: string): string {
  const m = /(?:^|;\s*)api-platform_ph=([^;]*)/.exec(cookie)
  return m ? m[1].trim().replace(/^"|"$/g, '') : ''
}

/** 平台的三分类（与官方「使用详情」页签一致） */
function categoryOf(model: string): string {
  const m = model.toLowerCase()
  if (m.includes('-asr')) return '语音识别模型'
  if (m.includes('-tts')) return '语音合成模型'
  return '语言模型'
}

/** 'YYYY-MM-DD HH:mm:ss' → UTC 零点（平台所有时间都是 UTC） */
function parseUtcDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return Number.isFinite(d.getTime()) ? d : null
}

/** UTC 日期 → 'YYYY-MM-DD'，便于与接口返回的 date 字符串直接比较 */
function ymd(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 往前推 N 个月（UTC） */
function minusMonths(d: Date, months: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, d.getUTCDate()))
}

/**
 * 拉取「使用详情」并按模型汇总。
 *
 * 统计窗口 = 本计费周期（由 currentPeriodEnd 反推起点：月付 = 往前 1 个月，年付 = 12 个月）。
 * 端点只支持按「年 + 月」查，所以按月份逐月取（最多 3 个月），再按日期过滤到周期起点之后。
 * 任何一步失败都**不抛**：额度数据已经拿到了，明细只是锦上添花。
 */
async function fetchModelUsage(cookie: string, periodEnd: string, planCode: string): Promise<ModelUsageResult> {
  const empty = (window: string): ModelUsageResult => ({ window, totalTokens: null, requestCount: null, models: [] })
  const ph = phFromCookie(cookie)
  if (!ph) return empty('未取到 api-platform_ph，无法查询')

  const end = parseUtcDate(periodEnd)
  const monthsBack = MIMO_PLAN_PRICES[planCode]?.months ?? 1
  const now = new Date()
  let start: Date | null = end ? minusMonths(end, monthsBack) : null
  // 周期起点算不出来（或明显不合理）→ 退回本自然月
  if (start && (start.getTime() > now.getTime() || now.getTime() - start.getTime() > 400 * 86400000)) start = null
  if (!start) start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

  // 该周期的月份列表（UTC），最多 MAX_MONTHS 个
  const months: { y: number; m: number }[] = []
  let cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  while (cur.getTime() <= now.getTime() && months.length < MAX_MONTHS) {
    months.push({ y: cur.getUTCFullYear(), m: cur.getUTCMonth() + 1 })
    cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1))
  }
  if (months.length === 0) months.push({ y: now.getUTCFullYear(), m: now.getUTCMonth() + 1 })

  // 周期起点早于已查的最早月份 → 说明被 MAX_MONTHS 截断了，口径说明要如实写
  const truncated = months[0].y > start.getUTCFullYear() || (months[0].y === start.getUTCFullYear() && months[0].m > start.getUTCMonth() + 1)
  const startYmd = ymd(start)

  const url = MIMO_PLAN_USAGE_DETAIL_URL + '?api-platform_ph=' + encodeURIComponent(ph)
  const rows: DetailRow[] = []
  /** 是否至少有一个月的明细真的取回来了（区分「这周期没用」和「接口没通」） */
  let got = false
  for (const mo of months) {
    const r = await request(url, {
      method: 'POST',
      headers: { Cookie: cookie, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ year: mo.y, month: mo.m })
    })
    if (r.status !== 200) continue // 401/400 都不致命：少一个月好过整张卡失败
    let j: unknown
    try {
      j = safeJson(r.text, MIMO_PLAN_USAGE_DETAIL_URL)
    } catch {
      continue
    }
    const list = dig(j, 'data')
    if (!Array.isArray(list)) continue
    got = true
    for (const raw of list as Array<Record<string, unknown>>) {
      const date = typeof raw.date === 'string' ? raw.date : ''
      const model = typeof raw.model === 'string' ? raw.model : ''
      if (!date || !model) continue
      // 只保留周期起点之后的数据（含起点当天）
      if (date.length >= 10 && date.slice(0, 10) < startYmd) continue
      rows.push({
        date,
        model,
        totalToken: num(raw.totalToken) ?? 0,
        inputHitToken: num(raw.inputHitToken) ?? 0,
        inputMissToken: num(raw.inputMissToken) ?? 0,
        outputToken: num(raw.outputToken) ?? 0,
        requestCount: num(raw.requestCount) ?? 0
      })
    }
  }

  const byModel = new Map<string, PlanModelUsage>()
  let total = 0
  let requests = 0
  for (const r of rows) {
    total += r.totalToken
    requests += r.requestCount
    const hit = byModel.get(r.model)
    if (hit) {
      hit.totalTokens += r.totalToken
      hit.inputHitTokens += r.inputHitToken
      hit.inputMissTokens += r.inputMissToken
      hit.outputTokens += r.outputToken
      hit.requestCount += r.requestCount
    } else {
      byModel.set(r.model, {
        model: r.model,
        category: categoryOf(r.model),
        totalTokens: r.totalToken,
        inputHitTokens: r.inputHitToken,
        inputMissTokens: r.inputMissToken,
        outputTokens: r.outputToken,
        requestCount: r.requestCount
      })
    }
  }
  const models = Array.from(byModel.values()).sort((a, b) => b.totalTokens - a.totalTokens)
  const window = truncated
    ? `近 ${months.length} 个月（周期跨月太多，已截断）`
    : '本计费周期（' + startYmd.slice(5) + ' 起）'
  if (!got) return empty(window + ' · 明细接口没通')
  return { window, totalTokens: total, requestCount: requests, models }
}
