import { createHmac, randomUUID } from 'node:crypto'
import type { Account, BalanceItem } from '../../shared/types'
import { AdapterError, mapHttpStatus } from '../errors'
import { request } from '../http'
import { getLogLevel, logger } from '../logger'
import type { Adapter } from './types'
import { okResult, round6 } from './util'

/**
 * 阿里云百炼：账号余额走 BSS OpenAPI（AccessKey 签名，无需 Cookie）。
 *
 * 控制台那种 data/api.json 调用要过 AWSC 反自动化签名（collina），在 Node 里无法复刻；
 * 但官方 BSS OpenAPI（bssapi.aliyuncs.com, V2017-12-14）提供同名只读接口，
 * 只需 AccessKey（建议 RAM 只读 + AliyunBSSReadOnlyAccess）：
 *   - QueryAccountBalance         资金账户（可用额度 / 现金余额 / 可透支）
 *   - QueryCashCoupons           代金券（balance=剩余，status=Available）
 *   - QuerySavingsPlansInstance  节省计划（restPoolValue=剩余池值）
 * 密钥格式（账号配置 secret）："AccessKey Id|AccessKey Secret"
 *
 * 注意端点用 business.aliyuncs.com（官方 SDK 默认、且 bssapi.aliyuncs.com
 * 在部分网络下 DNS 解析不了）；业务错误常带非 200 状态，必须先看响应体 Code。
 */

const ALIYUN_BSS_ENDPOINT = 'https://business.aliyuncs.com/'
const ALIYUN_BSS_VERSION = '2017-12-14'

/** RFC3986 编码（阿里云签名规范：! ' ( ) * 必须转义为大写 %XX） */
function pctEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

/** RPC 签名：HMAC-SHA1(secret + '&', 'GET&%2F&' + 规范化查询串)，输出 Base64 */
export function signRpc(secret: string, params: Record<string, string>): string {
  const keys = Object.keys(params).sort()
  const canon = keys.map((k) => pctEncode(k) + '=' + pctEncode(params[k])).join('&')
  const stringToSign = 'GET&%2F&' + pctEncode(canon)
  return createHmac('sha1', secret + '&').update(stringToSign, 'utf8').digest('base64')
}

/** 构造带签名的 GET URL（全部参数入 query） */
export function buildBssUrl(
  akId: string,
  akSecret: string,
  action: string,
  extra: Record<string, string> = {}
): string {
  const params: Record<string, string> = {
    AccessKeyId: akId,
    Action: action,
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: ALIYUN_BSS_VERSION,
    ...extra
  }
  params.Signature = signRpc(akSecret, params)
  const qs = Object.keys(params)
    .sort()
    .map((k) => pctEncode(k) + '=' + pctEncode(params[k]))
    .join('&')
  return ALIYUN_BSS_ENDPOINT + '?' + qs
}

/** BSS 返回的错误码 → 本地错误码（文案由 errors.ts 统一给） */
function mapBssError(code: string): 'HTTP_401' | 'HTTP_403' | 'UNKNOWN' {
  if (/InvalidAccessKey|SignatureDoesNotMatch|InvalidSecurity|IncompleteSignature|MissingParameter|MissingSecurityToken/i.test(code)) {
    return 'HTTP_401'
  }
  if (/Forbidden|NotAuthorized|NoPermission|AccessDenied/i.test(code)) {
    return 'HTTP_403'
  }
  return 'UNKNOWN'
}

/** 把阿里云错误码翻译成看得懂的中文（卡片「详情」行展示） */
function bssErrorZh(code: string, message?: string): string {
  const raw = message && message.trim() ? '（' + message.trim() + '）' : ''
  if (/InvalidAccessKeyId.NotFound/i.test(code)) {
    return 'AccessKey 不存在：ID 填错，或刚创建还没生效，等 2~3 分钟再刷新' + raw
  }
  if (/InvalidAccessKeyId/i.test(code)) {
    return 'AccessKey ID 无效：检查是否复制完整（LTAI 开头）' + raw
  }
  if (/SignatureDoesNotMatch/i.test(code)) {
    return '签名不匹配：多数是 AccessKey ID 和 Secret 填反了或少复制了字符' + raw
  }
  if (/MissingParameter|MissingAccessKeyId/i.test(code)) {
    return 'AccessKey 没填完整：ID 和 Secret 都要填' + raw
  }
  if (/Forbidden|NotAuthorized|AccessDenied|NoPermission/i.test(code)) {
    return 'AccessKey 权限不足：去 RAM 给该用户添加 AliyunBSSReadOnlyAccess 再试' + raw
  }
  return code + (message ? '：' + message : '')
}

/** 拆解 "AccessKey Id|AccessKey Secret" */
function splitAk(raw: string): { id: string; secret: string } | null {
  const idx = raw.indexOf('|')
  if (idx <= 0) return null
  const id = raw.slice(0, idx).trim()
  const secret = raw.slice(idx + 1).trim()
  if (!id || !secret) return null
  return { id, secret }
}

/** 发一次 BSS 调用，返回解析后的 JSON；失败抛适配器错误 */
async function bssCall(
  url: string
): Promise<Record<string, unknown>> {
  const res = await request(url, { headers: { Accept: 'application/json' } })
  let obj: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(res.text)
    if (parsed && typeof parsed === 'object') obj = parsed as Record<string, unknown>
  } catch {
    /* 非 JSON（登录页/网关页）→ 走下方兜底 */
  }
  if (obj) {
    const code = String(obj.Code ?? obj.code ?? '')
    if (code) {
      if (code === 'Success' || code === '200') return obj
      // 阿里云业务错误常带非 200 状态（如 InvalidAccessKeyId → 404），必须先看 Code
      const local = mapBssError(code)
      const zh = bssErrorZh(code, String(obj.Message ?? obj.message ?? ''))
      if (local === 'UNKNOWN') {
        throw new AdapterError('UNKNOWN', zh)
      }
      throw new AdapterError(local, zh)
    }
  }
  // 没有 JSON Code：按 HTTP 状态归类
  if (res.status !== 200) {
    throw new AdapterError(mapHttpStatus(res.status), 'HTTP ' + res.status)
  }
  throw new AdapterError('BAD_JSON', 'HTTP ' + res.status)
}

function n(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const x = Number(v)
  return Number.isFinite(x) ? x : null
}

/**
 * 取字段（大小写不敏感）：
 * 阿里云 RPC 响应字段是 PascalCase（AvailableAmount），SDK 文档是小驼峰，
 * 两种写法都兼容，避免线上真实字段名对不上。
 */
function fld(obj: Record<string, unknown>, ...names: string[]): unknown {
  for (const nm of names) {
    const v = obj[nm]
    if (v !== undefined && v !== null) return v
  }
  const lower: Record<string, unknown> = {}
  for (const k of Object.keys(obj)) lower[k.toLowerCase()] = obj[k]
  for (const nm of names) {
    const v = lower[nm.toLowerCase()]
    if (v !== undefined && v !== null) return v
  }
  return undefined
}

export const aliyunAdapter: Adapter = async (account: Account, ctx) => {
  const raw = ctx.getSecret(account)
  if (!raw) throw new AdapterError('MISSING_FIELD', 'AccessKey（阿里云百炼）')
  const ak = splitAk(raw)
  if (!ak) {
    throw new AdapterError('MISSING_FIELD', 'AccessKey 应为：AccessKey ID|AccessKey Secret（如 LTAIxxx|密钥）')
  }

  // ---- 资金账户 ----
  const balJson = await bssCall(buildBssUrl(ak.id, ak.secret, 'QueryAccountBalance'))
  const bal = (balJson.Data ?? balJson.data ?? {}) as Record<string, unknown>
  const available = n(fld(bal, 'availableAmount'))
  const cash = n(fld(bal, 'availableCashAmount')) ?? available
  const credit = n(fld(bal, 'mybankCreditAmount')) ?? n(fld(bal, 'creditAmount')) ?? 0
  const currency = String(fld(bal, 'currency') ?? 'CNY').toUpperCase()
  if (available === null) {
    throw new AdapterError('BAD_PATH', 'QueryAccountBalance 响应里没有 availableAmount')
  }
  const items: BalanceItem[] = [
    {
      planName: '资金账户',
      remaining: available,
      total: null,
      used: null,
      unit: currency,
      note:
        '现金 ¥' +
        round6(cash ?? 0) +
        (credit > 0 ? ' · 可透支 ¥' + round6(credit) : '')
    }
  ]

  // ---- 代金券（失败不致命，但失败原因必须说出来，否则用户只会看到"券突然没了"） ----
  let couponRemain = 0
  let couponNominal = 0
  let couponUsed = 0
  let couponUsable = 0
  /** 券查询的诊断信息：空 = 一切正常；非空 = 卡片备注里显示，方便定位"读不到券" */
  let couponWarn = ''
  try {
    const cupJson = await bssCall(buildBssUrl(ak.id, ak.secret, 'QueryCashCoupons'))
    const list = (cupJson.Data ?? cupJson.data ?? {}) as Record<string, unknown>
    const arr = fld(list, 'cashCoupon')
    const coupons = Array.isArray(arr) ? (arr as Record<string, unknown>[]) : []
    const seen: string[] = []
    for (const c of coupons) {
      const status = String(fld(c, 'status') ?? '')
      const nominal = n(fld(c, 'nominalValue')) ?? 0
      const remain = n(fld(c, 'balance')) ?? nominal
      if (getLogLevel() === 'debug') {
        // debug 级别下把每张券的关键字段记进日志（券号这类敏感字段只记前 6 位）
        seen.push(
          `{status=${status} nominal=${nominal} balance=${remain} ` +
            `expiry=${String(fld(c, 'expiryTime') ?? '')} id=${String(fld(c, 'cashCouponId') ?? '').slice(0, 6)}…}`
        )
      }
      // 兼容状态大小写/中英文差异：只排除明确不可用的状态，避免平台改字面量后整批券被丢掉
      const statusLower = status.toLowerCase()
      const unusable = statusLower !== '' && /expired|used|freeze|frozen|作废|已用|过期|冻结/.test(statusLower)
      if (unusable) continue
      couponRemain += remain
      couponNominal += nominal
      couponUsed += nominal - remain
      couponUsable++
    }
    if (couponUsable === 0 && coupons.length > 0) {
      // 有券但一张都没算进来：把状态值带出来，便于判断是状态字面量变了还是券真的过期了
      const statuses = Array.from(new Set(coupons.map((c) => String(fld(c, 'status') ?? '空')))).slice(0, 6)
      couponWarn = '；代金券接口返回 ' + coupons.length + ' 张但无可用券（状态：' + statuses.join('/') + '）'
      logger.warn('[aliyun] QueryCashCoupons 返回 ' + coupons.length + ' 张券，状态：' + statuses.join('、'))
    }
    logger.info(
      `[aliyun] 代金券：接口返回 ${coupons.length} 张，可用 ${couponUsable} 张，剩余合计 ${round6(couponRemain)}`
    )
    if (seen.length > 0) logger.debug('[aliyun] 代金券明细：' + seen.join(' '))
  } catch (e) {
    // 以前这里静默忽略，用户只能看到"券突然读不到"；现在把原因写进日志与卡片备注
    const msg = e instanceof AdapterError ? e.detail || e.code : (e as Error).message
    couponWarn = '；代金券读取失败：' + msg
    logger.warn('[aliyun] QueryCashCoupons 失败：' + msg)
  }

  // ---- 节省计划（失败不致命） ----
  let spCount = 0
  let spRemain = 0
  let spTotal = 0
  try {
    const spJson = await bssCall(
      buildBssUrl(ak.id, ak.secret, 'QuerySavingsPlansInstance', {
        Status: 'NORMAL',
        PageNum: '1',
        PageSize: '50',
        Locale: 'ZH'
      })
    )
    const data = (spJson.Data ?? spJson.data ?? {}) as Record<string, unknown>
    const arr = fld(data, 'items')
    for (const itRaw of Array.isArray(arr) ? (arr as unknown[]) : []) {
      const it = itRaw as Record<string, unknown>
      if (String(fld(it, 'currency') ?? 'CNY') !== 'CNY') continue
      spCount++
      spRemain += n(fld(it, 'restPoolValue')) ?? 0
      spTotal += n(fld(it, 'poolValue')) ?? 0
    }
  } catch {
    /* 忽略 */
  }

  // 代金券计入"可用余额"（与硅基流动口径一致）
  const remaining = round6(available + couponRemain)
  const total = round6(available + couponNominal)
  const used = round6(total - remaining)

  if (couponUsable > 0) {
    items.push({
      planName: '代金券 ' + couponUsable + ' 张可用',
      remaining: round6(couponRemain),
      total: round6(couponNominal),
      used: round6(couponUsed),
      unit: currency
    })
  }
  if (spCount > 0) {
    items.push({
      planName: '节省计划 ' + spCount + ' 个',
      remaining: round6(spRemain),
      total: round6(spTotal),
      used: null,
      unit: currency
    })
  }

  return okResult({
    remaining,
    total,
    used,
    unit: currency,
    note:
      (couponUsable > 0 ? '来源：阿里云 BSS OpenAPI（含代金券）' : '来源：阿里云 BSS OpenAPI') + couponWarn,
    items
  })
}
