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

/** 已用百分比：used / total 钳到 [0,100]；算不出返回 null（界面不画进度条） */

/** 进度条颜色档位：≥90 红 / ≥70 黄 / 否则绿 */
export function pctLevel(pct: number | null | undefined): 'ok' | 'warn' | 'danger' {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return 'ok'
  if (pct >= 90) return 'danger'
  if (pct >= 70) return 'warn'
  return 'ok'
}
