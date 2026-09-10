import type { BalanceItem } from '../../shared/types'
import { AdapterError, mapHttpStatus } from '../errors'
import { request } from '../http'
import type { Adapter } from './types'
import { dig, num, okResult, safeJson } from './util'

/**
 * 万能适配器：自己填 URL / Header / 请求体，再填提取路径。
 * 任何平台（包括商汤、各种小众中转站）抓一次包填进来就能用，不用改代码。
 *
 * request: { url, method, headers, body }
 * extract: { remaining, total, used, unit, scale, note, items[] }
 */
export const customAdapter: Adapter = async (account) => {
  const req = account.request
  if (!req || !req.url) throw new AdapterError('MISSING_FIELD', '请求地址')

  const headers: Record<string, string> = { ...(req.headers ?? {}) }
  // 与原型一致：没有显式指定 Accept 时补一个，避免某些站点返回 XML/HTML
  const hasAccept = Object.keys(headers).some((k) => k.toLowerCase() === 'accept')
  if (!hasAccept) headers.Accept = 'application/json'

  const { status, text } = await request(req.url, {
    method: req.method ?? 'GET',
    headers,
    body: req.body
  })
  if (status !== 200) throw new AdapterError(mapHttpStatus(status), text.slice(0, 160))

  const data = safeJson(text, req.url)
  const ex = account.extract ?? {}
  const sc = typeof ex.scale === 'number' ? ex.scale : 1

  const remaining = num(dig(data, ex.remaining), sc)
  const total = num(dig(data, ex.total), sc)
  const used = num(dig(data, ex.used), sc)

  // 三个关键字段全都取不到 → 取值路径八成填错了（界面提示"没在数据里找到余额字段"）
  if (remaining === null && total === null && used === null) {
    throw new AdapterError('BAD_PATH', 'remaining / total / used')
  }

  const items: BalanceItem[] = []
  for (const sub of ex.items ?? []) {
    const src = dig(data, sub.from)
    if (Array.isArray(src)) {
      src.forEach((it, i) => {
        items.push({
          planName: String(dig(it, sub.name ?? 'name') ?? `#${i}`),
          remaining: num(dig(it, sub.remaining), sc),
          total: num(dig(it, sub.total), sc),
          used: num(dig(it, sub.used), sc),
          unit: ex.unit ?? ''
        })
      })
    }
  }

  return okResult({
    remaining,
    total,
    used,
    unit: ex.unit ?? '',
    note: ex.note ?? '',
    items
  })
}
