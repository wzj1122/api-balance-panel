/**
 * 两端共用的纯函数格式化工具（移植自 Python 原型 web/index.html 的 fmt / ago）。
 * 不得 import 任何 node: / electron 模块。
 */

/** 数字格式化：null/NaN → "-"，≥1亿 → 亿，≥1万 → 万，≥100 → 2 位，<1 → 4 位 */
export function fmtNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '-'
  const a = Math.abs(n)
  if (a >= 1e8) return (n / 1e8).toFixed(2) + ' 亿'
  if (a >= 1e4) return (n / 1e4).toFixed(2) + ' 万'
  if (a >= 100) return n.toFixed(2)
  return n.toFixed(a < 1 ? 4 : 2)
}

/**
 * 金额格式化（元）：null/NaN → "-"。
 * 与 fmtNumber 的区别：金额常见小数位（几块钱、几毛钱），所以 <100 一律保留 2 位，
 * 极小值再补到 4 位，避免一堆折算结果全变成 "0.0000"。
 */
export function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-'
  const a = Math.abs(n)
  if (a >= 1e8) return (n / 1e8).toFixed(2) + ' 亿元'
  if (a >= 1e4) return (n / 1e4).toFixed(2) + ' 万元'
  if (a >= 0.01) return n.toFixed(2) + ' 元'
  return n.toFixed(4) + ' 元'
}

/** 相对时间：刚刚 / X 秒前 / X 分钟前 / X 小时前（照原型，不引入 dayjs） */
export function fmtAgo(ts: number | null | undefined, now: number = Date.now()): string {
  if (!ts) return '-'
  const s = Math.floor(now / 1000 - ts / 1000)
  if (s < 10) return '刚刚'
  if (s < 60) return s + ' 秒前'
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前'
  return Math.floor(s / 3600) + ' 小时前'
}

/** 本地时间 HH:mm:ss（24 小时制） */
export function fmtClock(ts: number | null | undefined): string {
  if (!ts) return '--:--:--'
  const d = new Date(ts)
  const p = (v: number): string => String(v).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 密钥掩码：长度 ≤ 8 全 *，否则 前3 + **** + 后4（如 sk-****1234） */
export function maskSecret(s: string | null | undefined): string {
  if (!s) return ''
  if (s.length <= 8) return '*'.repeat(s.length)
  return s.slice(0, 3) + '****' + s.slice(-4)
}

// ---------- 数据归一化小工具（store / keyvault / corrections 共用，避免各写一份） ----------

/** 纯对象判定（不认数组 / null） */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 数值归一化：null / undefined / 空串 / 非有限数 → null */
export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** 标签归一化：字符串数组，去重、去空、单个 ≤ 16 字、最多 8 个 */
export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const v of raw) {
    const s = String(v ?? '').trim().slice(0, 16)
    if (s && !out.includes(s)) out.push(s)
    if (out.length >= 8) break
  }
  return out
}

/** 已用百分比：used / total 钳到 [0,100]；算不出返回 null（界面不画进度条） */

/** 进度条颜色档位：≥90 红 / ≥70 黄 / 否则绿 */
export function pctLevel(pct: number | null | undefined): 'ok' | 'warn' | 'danger' {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return 'ok'
  if (pct >= 90) return 'danger'
  if (pct >= 70) return 'warn'
  return 'ok'
}
