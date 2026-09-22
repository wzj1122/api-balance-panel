import { ZHIPU_ACCOUNT_URL } from '../../shared/constants'
import { AdapterError, mapHttpStatus } from '../errors'
import { request } from '../http'
import type { Adapter } from './types'
import { assertNotExpired, dig, num, okResult, safeJson } from './util'

/**
 * 智谱 AI（bigmodel.cn）余额（Cookie + Authorization JWT）。
 *
 * 实测抓包（2026-09-09，财务中心 /finance-center/finance/overview）：
 *   GET https://bigmodel.cn/api/biz/customer/accountSet
 *     头：Cookie + Authorization: <bigmodel_token_production 这个 Cookie 的值（JWT，无前缀）>
 *     响应 data.basicCustomerInfo.balance（¥，字符串）
 *
 * 注意：Authorization 不是 Bearer、也没有「token 」前缀，就是那个 JWT 本身。
 */
function tokenFromCookie(cookie: string): string | null {
  const m = cookie.match(/(?:^|;\s*)bigmodel_token_production=([^;]+)/)
  return m ? m[1] : null
}

export const zhipuAdapter: Adapter = async (account, ctx) => {
  const cookie = ctx.getSecret(account)
  if (!cookie) throw new AdapterError('MISSING_FIELD', 'Cookie')
  const token = tokenFromCookie(cookie)
  if (!token) {
    throw new AdapterError('COOKIE_EXPIRED', '登录状态里没有 bigmodel_token_production 令牌，请点「登录智谱」重新登录一次')
  }
  const r = await request(ZHIPU_ACCOUNT_URL, {
    headers: {
      Cookie: cookie,
      Authorization: token,
      Accept: 'application/json',
      'Accept-Language': 'zh',
      Referer: 'https://bigmodel.cn/finance-center/finance/overview'
    }
  })
  assertNotExpired(r, '请重新登录智谱')
  if (r.status !== 200) throw new AdapterError(mapHttpStatus(r.status), r.text.slice(0, 160))
  const j = safeJson(r.text, ZHIPU_ACCOUNT_URL)
  const code = dig(j, 'code')
  if (code !== 200 && String(code) !== '200') {
    if (code === 401 || code === 1001) throw new AdapterError('COOKIE_EXPIRED', '智谱返回未授权，请重新登录')
    throw new AdapterError('BAD_PATH', '智谱接口返回异常（code ' + String(code) + '）')
  }
  const info = dig(j, 'data.basicCustomerInfo') as Record<string, unknown> | undefined
  const balance = num(info?.balance)
  const credit = num(info?.availableCreditBalance)
  if (balance === null) throw new AdapterError('BAD_PATH', '智谱返回里没有 balance 字段，请把响应发我们排查')
  const items =
    credit !== null && credit > 0
      ? [{ planName: '可用授信', remaining: credit, total: null, used: null, unit: 'CNY' }]
      : []
  return okResult({
    remaining: balance,
    total: null,
    used: null,
    unit: 'CNY',
    note: credit !== null && credit > 0 ? '余额 ¥' + balance + ' · 可用授信 ' + credit : '余额 ¥' + balance,
    items
  })
}
