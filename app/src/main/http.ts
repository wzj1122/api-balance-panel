import { DEFAULT_SETTINGS } from '../shared/constants'
import { AdapterError } from './errors'

/**
 * 极简 HTTP 客户端（Node 18+ 原生 fetch，不装 axios）。
 *
 * 铁律：
 * 1. 所有联网请求只在主进程发起，渲染进程永远不直接发请求；
 * 2. 非 2xx **不抛异常**，原样返回 {status, text} 交给适配器判断；
 * 3. 请求前做 URL / Header 非 ASCII 预检（原型踩过的真实坑，必须保留）。
 */

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  headers?: Record<string, string>
  body?: string
  /** 超时毫秒，缺省用设置里的 15000 */
  timeoutMs?: number
}

export interface HttpResponse {
  status: number
  text: string
}

/** 判断字符串里是否含非 ASCII 字符 */
function hasNonAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) return true
  }
  return false
}

/**
 * 非 ASCII 预检。
 * 抓包时很容易把中文备注一起粘进 URL 或 Header，浏览器/Node 会因为编码直接崩，
 * 这里提前拦下来，给人看得懂的提示。
 */
export function assertAscii(url: string, headers?: Record<string, string>): void {
  if (!url) throw new AdapterError('BAD_URL', url)
  if (hasNonAscii(url)) {
    throw new AdapterError('BAD_URL', '网址里有中文或特殊字符')
  }
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (hasNonAscii(k) || hasNonAscii(String(v))) {
      throw new AdapterError('BAD_HEADER', `${k} 的值里有中文或特殊字符（以“${String(v).slice(0, 12)}”开头）`)
    }
  }
}

/**
 * 发一个请求，返回 {status, text}。
 * 非 2xx 不抛；网络异常 / 超时向外抛（由上层 mapFetchError 归类）。
 */
export async function request(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_SETTINGS.timeout_ms

  assertAscii(url, options.headers)

  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: options.headers ?? {},
    body: options.body,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow'
  })

  const text = await response.text()
  return { status: response.status, text }
}
