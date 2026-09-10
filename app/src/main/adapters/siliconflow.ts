import type { Account, BalanceItem } from '../../shared/types'
import { AdapterError } from '../errors'
import { request } from '../http'
import type { Adapter } from './types'
import { dig, num, okResult, round6 } from './util'

/**
 * 硅基流动 SiliconFlow（Cookie + x-subject-id 版）。
 *
 * 背景（官方公告 2026-08-11，见 docs/更新公告）：API Key 版余额接口
 * GET /v1/user/info 已于 2026-08-14 正式下线（返回 20092 deprecated），
 * 官方称"后续将适时提供账户层面替代 API"，截至当前尚未上线。
 *
 * 实测抓包（2026-09-09，控制台 /me/expensebill）确认的可用链路：
 *   1. GET  /me/expensebill（带 Cookie）→ HTML 内嵌 window.SF_SUBJECT_ID='…'
 *   2. GET  /walletd-server/api/v1/subject/profile/peek
 *          （头：Cookie + x-subject-id）→ data.financialInfo 余额（1 元 = 1e12 单位）
 *   3. GET  /walletd-server/api/v1/subject/wallets?pageSize=15&stage=3 → 代金券列表
 *   4. GET  /walletd-server/api/v1/subject/wallets?pageSize=15&stage=2 → 资源包列表（可选）
 */

/** 平台金额单位：接口返回整数，1 元 = 1e12 单位 */
const YUAN_SCALE = 1_000_000_000_000

export const SILICONFLOW_BASE = 'https://cloud.siliconflow.cn'
export const SILICONFLOW_PAGE = SILICONFLOW_BASE + '/me/expensebill'
export const SILICONFLOW_PROFILE =
  SILICONFLOW_BASE + '/walletd-server/api/v1/subject/profile/peek'
export function SILICONFLOW_WALLETS(stage: number, pageSize = 15): string {
  return (
    SILICONFLOW_BASE +
    '/walletd-server/api/v1/subject/wallets?pageSize=' +
    pageSize +
    '&stage=' +
    stage
  )
}

/** 平台金额整数 → 元（round6 保留 6 位小数） */
function yuan(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? round6(n / YUAN_SCALE) : null
}

/** 从控制台页面 HTML 提取当前主体 id：window.SF_SUBJECT_ID = '…' */
export function parseSubjectId(html: string): string | null {
  const m = html.match(/window\.SF_SUBJECT_ID\s*=\s*'([A-Za-z0-9]+)'/)
  if (m) return m[1]
  const m2 = html.match(/"subjectId"\s*:\s*"([A-Za-z0-9]+)"/)
  return m2 ? m2[1] : null
}

/** 解析 profile/peek 的财务信息（金额已折算为元） */
export function parseFinancial(j: unknown): {
  balance: number | null
  available: number | null
  recharged: number | null
  used: number | null
  creditLine: number | null
} | null {
  const fin = dig(j, 'data.financialInfo')
  if (!fin || typeof fin !== 'object') return null
  return {
    balance: yuan(dig(fin, 'balance')),
    available: yuan(dig(fin, 'available')),
    recharged: yuan(dig(fin, 'recharged')),
    used: yuan(dig(fin, 'used')),
    creditLine: yuan(dig(fin, 'remainingCreditLine'))
  }
}

export interface WalletEntry {
  name: string
  remaining: number | null
  cap: number | null
  used: number | null
  status: number
}

/** 解析代金券 / 资源包列表（wallets 接口，status: 0=可用 1=已用尽） */
export function parseWallets(j: unknown): WalletEntry[] | null {
  const arr = dig(j, 'data.wallets')
  if (!Array.isArray(arr)) return null
  const out: WalletEntry[] = []
  for (const w of arr) {
    if (!w || typeof w !== 'object') continue
    let name = ''
    const raw = dig(w, 'name')
    if (typeof raw === 'string') {
      try {
        const o = JSON.parse(raw) as Record<string, unknown>
        const cn = o['zh-cn'] ?? o['zh-CN']
        name = typeof cn === 'string' ? cn : raw
      } catch {
        name = raw
      }
    }
    out.push({
      name,
      remaining: yuan(dig(w, 'balance')),
      cap: yuan(dig(w, 'cap')),
      used: yuan(dig(w, 'used')),
      status: num(dig(w, 'status')) ?? 0
    })
  }
  return out
}

/** 响应文本是否像被重定向到了 SSO 登录页 */
function isLoginWall(text: string): boolean {
  return /account\.siliconflow\.cn|passport|登录/.test(text.slice(0, 4000))
}

export const siliconflowAdapter: Adapter = async (account: Account, ctx) => {
  const cookie = ctx.getSecret(account)
  if (!cookie) {
    throw new AdapterError('COOKIE_EXPIRED', '还没有登录 Cookie：请点「登录获取 Cookie」在控制台登录一次。')
  }
  if (/^sk-[A-Za-z0-9]+/.test(cookie.trim())) {
    throw new AdapterError(
      'COOKIE_EXPIRED',
      '检测到保存的还是旧版 API Key：官方已下线 API Key 查余额接口，请点「登录获取 Cookie」改用登录方式。'
    )
  }

  // 1) 抓控制台页面 → 主体 id（x-subject-id）
  const page = await request(SILICONFLOW_PAGE, {
    headers: {
      Cookie: cookie,
      'Accept-Language': 'zh-CN',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36'
    }
  })
  if (page.status === 401 || page.status === 403) {
    throw new AdapterError('COOKIE_EXPIRED', '登录已失效（' + page.status + '），请重新登录。')
  }
  const subjectId = parseSubjectId(page.text)
  if (!subjectId) {
    if (isLoginWall(page.text)) {
      throw new AdapterError('COOKIE_EXPIRED', '登录已失效（被重定向到登录页），请重新登录。')
    }
    throw new AdapterError(
      'BAD_PATH',
      '控制台页面结构变了，没找到 SF_SUBJECT_ID；请把 F12 Network 里任意一个请求发给我们排查。'
    )
  }
  const headers: Record<string, string> = {
    Cookie: cookie,
    'X-Subject-Id': subjectId,
    Accept: 'application/json',
    'Accept-Language': 'zh-CN'
  }

  // 2) 余额（profile/peek）
  const prof = await request(SILICONFLOW_PROFILE, { headers })
  if (prof.status === 401 || prof.status === 403) {
    throw new AdapterError('COOKIE_EXPIRED', '登录已失效（' + prof.status + '），请重新登录。')
  }
  let fin: ReturnType<typeof parseFinancial> = null
  try {
    fin = parseFinancial(JSON.parse(prof.text))
  } catch {
    fin = null
  }
  if (!fin) {
    throw new AdapterError('BAD_PATH', '余额接口返回异常（HTTP ' + prof.status + '），请反馈排查。')
  }
  const balance = fin.available ?? fin.balance ?? 0
  const recharged = fin.recharged ?? balance
  const usedFin = fin.used ?? Math.max(0, recharged - balance)
  const creditLine = fin.creditLine ?? 0
  const items: BalanceItem[] = [
    {
      planName: '现金余额',
      remaining: balance,
      total: recharged,
      used: usedFin,
      unit: 'CNY',
      note: creditLine > 0 ? '可透支额度 ¥' + creditLine : undefined
    }
  ]

  // 3) 代金券（失败不致命，不影响主余额展示）
  let couponRemain = 0
  let couponCap = 0
  let couponUsed = 0
  let couponUsable = 0
  let couponTotal = 0
  try {
    const w3 = await request(SILICONFLOW_WALLETS(3), { headers })
    const list = parseWallets(JSON.parse(w3.text))
    if (list) {
      couponTotal = list.length
      for (const c of list) {
        couponRemain += c.remaining ?? 0
        couponCap += c.cap ?? 0
        couponUsed += c.used ?? 0
        if (c.status === 0 && (c.remaining ?? 0) > 0) couponUsable++
      }
      if (couponTotal > 0) {
        items.push({
          planName: '代金券 ' + couponUsable + ' 张可用',
          remaining: round6(couponRemain),
          total: round6(couponCap),
          used: round6(couponUsed),
          unit: 'CNY',
          note:
            couponTotal > couponUsable
              ? '共 ' + couponTotal + ' 张（含已用尽 ' + (couponTotal - couponUsable) + ' 张）'
              : undefined
        })
      }
    }
  } catch {
    /* 忽略：代金券查询失败不影响主余额 */
  }

  // 4) 资源包（可选，失败忽略；接口可能返回空列表）
  try {
    const w1 = await request(SILICONFLOW_WALLETS(2), { headers })
    const packs = parseWallets(JSON.parse(w1.text)) ?? []
    if (packs.length > 0) {
      items.push({
        planName: '资源包 ' + packs.length + ' 个生效中',
        remaining: round6(packs.reduce((s, p) => s + (p.remaining ?? 0), 0)),
        total: round6(packs.reduce((s, p) => s + (p.cap ?? 0), 0)),
        used: null,
        unit: 'CNY'
      })
    }
  } catch {
    /* 忽略 */
  }

  // 代金券计入"可用余额"（用户口径：券也是钱，一起算）
  let remaining = balance
  let total = recharged
  let used = usedFin
  if (couponTotal > 0) {
    remaining = round6(balance + couponRemain)
    total = round6(recharged + couponCap)
    used = round6(total - remaining)
  }

  return okResult({
    remaining,
    total,
    used,
    unit: 'CNY',
    note: couponTotal > 0 ? '来源：控制台余额接口（已含代金券）' : '来源：控制台余额接口（Cookie）',
    items
  })
}
