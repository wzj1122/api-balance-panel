import { DEEPSEEK_BALANCE_URL } from '../../shared/constants'
import { AdapterError, mapHttpStatus } from '../errors'
import { request } from '../http'
import type { Adapter } from './types'
import { dig, num, okResult, safeJson } from './util'

/**
 * DeepSeek 官方：有公开余额接口，最简单。
 * GET https://api.deepseek.com/user/balance
 * 响应 balance_infos[0] 里有 total_balance / granted_balance / topped_up_balance / currency。
 * DeepSeek 不给总额，需要总额时由用户在账号里手填 quota_total。
 */
export const deepseekAdapter: Adapter = async (account, ctx) => {
  const key = ctx.getSecret(account)
  if (!key) throw new AdapterError('MISSING_FIELD', 'API Key')

  const { status, text } = await request(DEEPSEEK_BALANCE_URL, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }
  })
  if (status !== 200) throw new AdapterError(mapHttpStatus(status), text.slice(0, 160))

  const data = safeJson(text, DEEPSEEK_BALANCE_URL) as Record<string, unknown>
  const info = (dig(data, 'balance_infos.0') as Record<string, unknown> | undefined) ?? {}
  const unit = (info.currency as string) || 'CNY'

  return okResult({
    remaining: num(info.total_balance),
    total: account.quota_total ?? null,
    used: null,
    unit,
    note: data.is_available ? '可用' : '账户当前不可用',
    items: [
      { planName: '赠送余额', remaining: num(info.granted_balance), total: null, used: null, unit },
      { planName: '充值余额', remaining: num(info.topped_up_balance), total: null, used: null, unit }
    ]
  })
}
