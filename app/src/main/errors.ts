import type { BalanceResult, ErrorCode } from '../shared/types'

/**
 * 错误码 → 人话文案总表（唯一真源）。
 * 适配器只抛/传错误码，文案统一由这里产出，改文案只改一处。
 */

export const ERROR_TEXT: Record<ErrorCode, (detail?: string) => string> = {
  HTTP_401: () => '密钥错了或过期了，去平台后台重新生成一个',
  HTTP_403: () => '密钥错了或过期了，去平台后台重新生成一个',
  HTTP_404: () => '网址填错了，检查中转站地址（只填域名，不要带 /v1）',
  HTTP_429: () => '查太频繁了，平台限流了，把自动刷新间隔调大一点',
  HTTP_5XX: () => '平台自己挂了，等一会儿再试',
  HTTP_OTHER: (detail) => `平台返回了异常状态（${detail ?? '未知'}），稍后再试`,
  TIMEOUT: () => '连不上平台，检查网络或代理',
  NETWORK: () => '网络不通，检查代理或防火墙',
  CERT: () => '网络不通，检查代理或防火墙（证书校验失败）',
  BAD_URL: () => '网址里有中文或特殊字符，检查一下是不是粘错了',
  BAD_HEADER: () => '请求头里有中文或特殊字符，多半是把说明文字当成密钥粘进去了',
  BAD_JSON: () => '平台返回的不是数据（可能是登录页），多半是 Cookie 过期了',
  BAD_PATH: () => '没在数据里找到余额字段，检查一下"取值路径"填对没',
  MISSING_FIELD: (detail) => `还有必填项没填：${detail ?? '未知字段'}`,
  UNKNOWN_TYPE: () => '未知的平台类型，请重新选择平台',
  COOKIE_EXPIRED: () => '登录已过期，点「登录」重新获取一次 Cookie',
  UNKNOWN: () => '查询失败（下方小字显示原始信息，方便排查）'
}

/** HTTP 状态码 → 错误码 */
export function mapHttpStatus(status: number): ErrorCode {
  if (status === 401) return 'HTTP_401'
  if (status === 403) return 'HTTP_403'
  if (status === 404) return 'HTTP_404'
  if (status === 429) return 'HTTP_429'
  if (status >= 500 && status <= 599) return 'HTTP_5XX'
  return 'HTTP_OTHER'
}

/** fetch 抛出的异常 → 错误码（AbortError → 超时；证书 → CERT；其它 → 网络） */
export function mapFetchError(err: unknown): ErrorCode {
  const name = (err as { name?: string } | null)?.name ?? ''
  const msg = String((err as { message?: string } | null)?.message ?? err ?? '')
  if (name === 'AbortError' || name === 'TimeoutError' || /timed out|timeout/i.test(msg)) {
    return 'TIMEOUT'
  }
  if (/certificate|self-signed|UNABLE_TO_VERIFY|SSL|tls/i.test(msg)) return 'CERT'
  return 'NETWORK'
}

/** 取某个错误码的人话文案 */
export function errorText(code: ErrorCode, detail?: string): string {
  const fn = ERROR_TEXT[code] ?? ERROR_TEXT.UNKNOWN
  return fn(detail)
}

/** 构造一个失败结果（ok:false + note=人话文案） */
export function failResult(code: ErrorCode, detail?: string): BalanceResult {
  return {
    ok: false,
    remaining: null,
    total: null,
    used: null,
    unit: '',
    note: errorText(code, detail),
    items: [],
    ts: Date.now(),
    latencyMs: 0,
    cached: false,
    errorCode: code,
    errorDetail: detail
  }
}

/** 适配器内部抛出的错误：只带码与原始信息，不带中文文案 */
export class AdapterError extends Error {
  public readonly code: ErrorCode
  public readonly detail?: string

  constructor(code: ErrorCode, detail?: string) {
    super(`${code}${detail ? `: ${detail}` : ''}`)
    this.name = 'AdapterError'
    this.code = code
    this.detail = detail
  }
}
