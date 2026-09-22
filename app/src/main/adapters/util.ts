import type { BalanceItem, BalanceResult } from '../../shared/types'
import { AdapterError } from '../errors'

/**
 * 适配器共用的取值小工具（移植自 Python 原型 server.py 的 dig / num / result）。
 * 语义与原版严格一致，不要自由发挥。
 */

/**
 * 按 a.b.0.c 这样的点号路径从 dict/list 里取值，取不到返回 undefined。
 * 与原型 dig 对齐：list 用下标、dict 用 key、取不到返回 None（此处为 undefined）。
 */
export function dig(obj: unknown, path?: string): unknown {
  if (!path) return undefined
  let cur: unknown = obj
  for (const part of String(path).split('.')) {
    if (cur === null || cur === undefined) return undefined
    if (Array.isArray(cur)) {
      const idx = Number(part)
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined
      cur = cur[idx]
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return cur
}

/**
 * 把接口返回的任意值转成 number，失败返回 null。
 * scale 用于单位换算（差 100 倍填 0.01，差 100 万倍填 0.000001）。
 */
export function num(v: unknown, scale = 1): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return null
  return n * scale
}

/**
 * 解析 JSON 文本；失败抛 BAD_JSON（界面会显示"平台返回的不是数据，多半是 Cookie 过期了"）。
 * url 只用于日志排查，不会泄露密钥。
 */
export function safeJson(text: string, url = ''): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new AdapterError('BAD_JSON', url)
  }
}

/**
 * 401/403 统一判定为「登录已失效」（COOKIE_EXPIRED，触发续期 / 重新登录链路）。
 * hint 是该平台的重新登录指引，会拼进错误详情（说人话，别只报状态码）。
 * 六个登录型适配器共用，替代此前逐文件复制的两行判定。
 */
export function assertNotExpired(res: { status: number }, hint: string): void {
  if (res.status === 401 || res.status === 403) {
    throw new AdapterError('COOKIE_EXPIRED', '登录已失效（' + res.status + '），' + hint)
  }
}

/** 保留 6 位小数（与原型 round(x, 6) 对齐，避免浮点误差） */
export function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6
}

/**
 * 构造一个成功结果。used 缺失时用 total - remaining 推导（与原型 result() 一致）。
 * 注意：total 可能因为平台不提供而为 null，此时 used 也保持 null，交给界面不画进度条。
 */
export function okResult(p: {
  remaining: number | null
  total: number | null
  used?: number | null
  unit?: string
  note?: string
  items?: BalanceItem[]
}): BalanceResult {
  let used = p.used ?? null
  if (used === null && p.remaining !== null && p.total !== null) {
    used = round6(p.total - p.remaining)
  }
  return {
    ok: true,
    remaining: p.remaining,
    total: p.total,
    used,
    unit: p.unit ?? '',
    note: p.note ?? '',
    items: p.items ?? [],
    ts: Date.now(),
    latencyMs: 0,
    cached: false
  }
}
