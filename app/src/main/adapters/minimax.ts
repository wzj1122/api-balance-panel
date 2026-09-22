import { MINIMAX_ACCOUNT_URL, MINIMAX_BACKEND, MINIMAX_BACKEND_CN } from '../../shared/constants'
import type { BalanceItem } from '../../shared/types'
import { AdapterError, mapHttpStatus } from '../errors'
import { request } from '../http'
import type { Adapter } from './types'
import { assertNotExpired, dig, num, okResult, safeJson } from './util'

/**
 * MiniMax 开放平台余额（Cookie + X-Group-Id 头）。
 *
 * 实测抓包（2026-09-09，控制台账户钱包页）：
 *   1. GET /backend/account（Cookie）→ account_info.group_id
 *   2. GET /account/query_balance
 *         （Cookie + X-Group-Id 头，少了这个头接口直接报 system error）
 *         → available_amount / cash_balance / voucher_balance / credit_balance / owed_amount
 *
 * MiniMax 分 .com（国际站）与 .cn（国内站）两套镜像接口，登录落在哪个域就自动用哪个域：
 * 先试 .com，返回未登录再试 .cn。余额口径：可用额度 = 现金 + 代金券 + 授信 − 欠费。
 */
export const minimaxAdapter: Adapter = async (account, ctx) => {
  const cookie = ctx.getSecret(account)
  if (!cookie) throw new AdapterError('MISSING_FIELD', 'Cookie')

  // 1) 找能用的后端域 + 主体 group_id
  const bases: Array<{ base: string; accountUrl: string }> = [
    { base: MINIMAX_BACKEND, accountUrl: MINIMAX_ACCOUNT_URL },
    { base: MINIMAX_BACKEND_CN, accountUrl: MINIMAX_BACKEND_CN + '/backend/account' }
  ]
  let lastErr = ''
  let groupId = ''
  let base = ''
  for (const b of bases) {
    const r1 = await request(b.accountUrl, { headers: { Cookie: cookie, Accept: 'application/json' } })
    if (r1.status === 401 || r1.status === 403) { lastErr = 'HTTP ' + r1.status; continue }
    if (r1.status !== 200) { lastErr = mapHttpStatus(r1.status); continue }
    const j1 = safeJson(r1.text, b.accountUrl)
    const resp1 = (dig(j1, 'base_resp.status_code') ?? 0) as number
    if (resp1 !== 0) { lastErr = String(dig(j1, 'base_resp.status_msg') ?? resp1); continue }
    const gid = dig(j1, 'account_info.group_id')
    if (typeof gid === 'string' && gid) { groupId = gid; base = b.base; break }
  }
  if (!base || !groupId) {
    throw new AdapterError('COOKIE_EXPIRED', '登录态校验失败（' + (lastErr || 'not login') + '），请重新登录')
  }

  // 2) 余额（必须带 X-Group-Id）
  const headers: Record<string, string> = {
    Cookie: cookie,
    'X-Group-Id': groupId,
    Accept: 'application/json',
    'Accept-Language': 'zh-CN'
  }
  const r2 = await request(base + '/account/query_balance', { headers })
  assertNotExpired(r2, '请重新登录 MiniMax')
  if (r2.status !== 200) throw new AdapterError(mapHttpStatus(r2.status), r2.text.slice(0, 160))
  const j2 = safeJson(r2.text, base + '/account/query_balance')
  const resp2 = (dig(j2, 'base_resp.status_code') ?? 0) as number
  if (resp2 !== 0) {
    const msg = String(dig(j2, 'base_resp.status_msg') ?? '')
    throw new AdapterError('BAD_PATH', 'MiniMax 钱包接口返回异常（' + (msg || 'code ' + resp2) + '），稍后重试')
  }
  const available = num(dig(j2, 'available_amount'))
  const cash = num(dig(j2, 'cash_balance'))
  const voucher = num(dig(j2, 'voucher_balance'))
  const credit = num(dig(j2, 'credit_balance'))
  const owed = num(dig(j2, 'owed_amount'))
  if (available === null) throw new AdapterError('BAD_PATH', '钱包接口没有 available_amount 字段，请把响应发我们排查')

  const items: BalanceItem[] = [
    { planName: '现金', remaining: cash, total: null, used: null, unit: 'CNY' },
    { planName: '代金券', remaining: voucher, total: null, used: null, unit: 'CNY' }
  ]
  if (credit !== null && credit !== 0) items.push({ planName: '授信', remaining: credit, total: null, used: null, unit: 'CNY' })
  if (owed !== null && owed !== 0) items.push({ planName: '欠费', remaining: owed, total: null, used: null, unit: 'CNY' })

  const noteParts: string[] = []
  if (voucher !== null && voucher !== 0) noteParts.push('代金券 ' + voucher)
  if (owed !== null && owed > 0) noteParts.push('欠费 ' + owed)
  return okResult({
    remaining: available,
    total: null,
    used: null,
    unit: 'CNY',
    note: noteParts.join(' · '),
    items
  })
}
