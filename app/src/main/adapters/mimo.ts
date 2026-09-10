import { MIMO_BALANCE_URL } from '../../shared/constants'
import type { BalanceItem } from '../../shared/types'
import { AdapterError, mapHttpStatus } from '../errors'
import { request } from '../http'
import type { Adapter } from './types'
import { dig, num, okResult, safeJson } from './util'

/**
 * 小米 MiMo 余额（Cookie）。
 *
 * 没有公开 API Key，余额只能靠登录后的 Cookie 去查：
 * - 现金 / 赠送余额：GET /api/v1/balance → data.balance / cashBalance / giftBalance / currency
 *
 * 套餐用量（Token Plan）已拆到独立的「小米 MiMo 套餐」账号（mimo-plan），
 * 两个账号共用同一份 Cookie：登录一次，余额和套餐各建一张卡。
 */
export const mimoAdapter: Adapter = async (account, ctx) => {
  const cookie = ctx.getSecret(account)
  if (!cookie) throw new AdapterError('MISSING_FIELD', 'Cookie')

  const headers = { Cookie: cookie, Accept: 'application/json' }

  // 现金余额：必须成功，否则整个账号算失败
  const r1 = await request(MIMO_BALANCE_URL, { headers })
  if (r1.status === 401 || r1.status === 403) throw new AdapterError('COOKIE_EXPIRED', String(r1.status))
  if (r1.status !== 200) throw new AdapterError(mapHttpStatus(r1.status), r1.text.slice(0, 160))

  const d = (dig(safeJson(r1.text, MIMO_BALANCE_URL), 'data') as Record<string, unknown>) ?? {}
  const unit = typeof d.currency === 'string' && d.currency ? d.currency : 'CNY'
  const cash = num(d.cashBalance)
  const gift = num(d.giftBalance)
  const balance = num(d.balance)

  const items: BalanceItem[] = []
  if (cash !== null) items.push({ planName: '现金余额', remaining: cash, total: null, used: null, unit })
  if (gift !== null) items.push({ planName: '赠送余额', remaining: gift, total: null, used: null, unit })

  return okResult({
    remaining: balance,
    total: null,
    used: null,
    unit,
    note: '现金 ' + (cash ?? '-') + ' · 赠送 ' + (gift ?? '-'),
    items
  })
}
