import { DEFAULT_QUOTA_PER_USD } from '../../shared/constants'
import { AdapterError, mapHttpStatus } from '../errors'
import { request } from '../http'
import type { Adapter } from './types'
import { dig, num, okResult, round6, safeJson } from './util'

/**
 * New API / One API / Veloera 等中转站。
 * 用站点后台生成的令牌（一般 sk- 开头）调 GET {base_url}/api/user/self。
 * quota / used_quota 的单位是「1 美元 = quota_per_usd」站点内部点数，默认 500000。
 * 部分站点需要在请求头额外带 New-API-User（对应账号的 user_id）。
 */
export const newapiAdapter: Adapter = async (account, ctx) => {
  const key = ctx.getSecret(account)
  if (!key) throw new AdapterError('MISSING_FIELD', '令牌')

  const base = (account.base_url || '').replace(/\/+$/, '')
  if (!base) throw new AdapterError('MISSING_FIELD', '站点地址')

  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json'
  }
  // PRD 要求：user_id 非空时追加 New-API-User 头（部分站点鉴权需要）
  if (account.user_id) headers['New-API-User'] = account.user_id

  const url = `${base}/api/user/self`
  const { status, text } = await request(url, { headers })
  if (status !== 200) throw new AdapterError(mapHttpStatus(status), text.slice(0, 160))

  const data = safeJson(text, url) as Record<string, unknown>
  const d = (dig(data, 'data') as Record<string, unknown> | undefined) ?? {}

  const per = account.quota_per_usd && account.quota_per_usd > 0 ? account.quota_per_usd : DEFAULT_QUOTA_PER_USD
  const remaining = num(d.quota, 1 / per)
  const used = num(d.used_quota, 1 / per)
  const total = remaining !== null && used !== null ? round6(remaining + used) : null

  return okResult({
    remaining,
    total,
    used,
    unit: account.unit || 'USD',
    note: `用户：${String(d.username ?? '')}`
  })
}
