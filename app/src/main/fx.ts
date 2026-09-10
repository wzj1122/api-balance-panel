import { dig } from './adapters/util'
import { request } from './http'
import { logger } from './logger'
import type { FxInfo } from '../shared/types'

/**
 * 实时汇率获取器（成本折算用）。
 *
 * 隐私：请求只带货币代码 USD/CNY，不带任何账号信息、密钥或 Cookie。
 * 缓存：1 小时内复用，避免频繁联网；并发去重，同一时刻只发一个请求。
 * 兜底：联网失败 → 用上次缓存；连缓存都没有 → 用内置固定汇率 7.2。
 *       任何情况都不向渲染进程抛错（汇率拿不到不阻断界面）。
 */

/** 汇率接口：1 USD 兑多少 CNY */
const FX_URL = 'https://open.er-api.com/v6/latest/USD'
/** 内置兜底汇率（联网失败且无缓存时用） */
const FALLBACK_RATE = 7.2
/** 汇率缓存有效期：1 小时 */
const CACHE_TTL = 3600_000

let cache: FxInfo | null = null
let inflight: Promise<FxInfo> | null = null

export function getFx(): Promise<FxInfo> {
  // 缓存未过期直接复用
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return Promise.resolve(cache)
  }
  // 并发去重：已有请求在途，就等它，不重复发
  if (inflight) return inflight

  const promise = (async (): Promise<FxInfo> => {
    try {
      const res = await request(FX_URL, { timeoutMs: 8000 })
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`HTTP ${res.status}`)
      }
      const json = JSON.parse(res.text) as unknown
      const rate = Number(dig(json, 'rates.CNY'))
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error('返回里没有有效的 CNY 汇率')
      }
      cache = { rate, ts: Date.now(), source: 'live' }
      logger.info(`[fx] 实时汇率已更新：1 USD = ${rate} CNY`)
      return cache
    } catch (e) {
      if (cache) {
        logger.warn(`[fx] 汇率获取失败，使用上次缓存：${(e as Error).message}`)
        return { ...cache, source: 'cache' }
      }
      logger.warn(`[fx] 汇率获取失败，使用内置兜底：${(e as Error).message}`)
      return { rate: FALLBACK_RATE, ts: 0, source: 'fallback' }
    } finally {
      inflight = null
    }
  })()

  inflight = promise
  return promise
}
