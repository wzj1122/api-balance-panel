/**
 * 单位 → 金额折算（纯函数，两端共用；不得 import node: / electron）。
 *
 * **只对「积分」类单位折算**（用户 2026-09-22 明确要求）：
 * DeepSeek / 硅基流动 / MiniMax / 智谱 / 阿里云这些都是直接用人民币或美元记账，
 * 本身就能直接看，不需要再折算一遍；只有商汤这类「积分」型平台才需要把积分换成钱来对比。
 * 以后新增积分型平台（或商汤的其它积分池）会自动走同一套逻辑，不用改界面。
 *
 * 折算率来自用户设置（credits_per_cny = 多少积分算 1 元），默认见
 * constants.ts 的 DEFAULT_CREDITS_PER_CNY（按 DeepSeek 高峰价反推的估算基线）。
 * 折算结果一律是**估算**，界面必须带「≈ / 估算」字样，不能当成真实扣费。
 */

/** 「积分」类单位（平台额度积分）——只有这类单位才做「积分 → 元」折算（比较时统一小写） */
const CREDIT_UNITS = ['积分', 'points', 'point', 'credit', 'credits']

/** 单位是不是「积分」型（决定要不要显示折合人民币） */
export function isCreditUnit(unit: string): boolean {
  const u = String(unit ?? '').trim().toLowerCase()
  return u.length > 0 && CREDIT_UNITS.includes(u)
}

/** 折算率是否可用（<=0 或非有限值 = 用户关掉了折算） */
export function hasCreditRate(creditsPerCny: number | null | undefined): boolean {
  return typeof creditsPerCny === 'number' && Number.isFinite(creditsPerCny) && creditsPerCny > 0
}

/** 积分 → 元的估算值；折算率不可用或值非法时返回 null（调用方不显示即可） */
export function creditsToCny(value: number | null | undefined, creditsPerCny: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  if (!hasCreditRate(creditsPerCny)) return null
  return value / (creditsPerCny as number)
}

/**
 * 只有「积分」型单位才有的人民币估算值（其它单位一律返回 null）。
 *
 * 参数 unit 是必须的：即使将来某个单位名没见过，也不会被误当成积分去折算
 * —— 宁可留空，也不要显示一个来路不明的金额。
 */
export function creditCny(
  value: number | null | undefined,
  unit: string,
  creditsPerCny: number | null | undefined
): number | null {
  if (!isCreditUnit(unit)) return null
  return creditsToCny(value, creditsPerCny)
}

/** 折算率的中文说明（设置页与页脚共用，避免两处口径写歪） */
export function rateText(creditsPerCny: number | null | undefined): string {
  if (!hasCreditRate(creditsPerCny)) return '未启用积分折算'
  const n = creditsPerCny as number
  const perYuan = n >= 1e4 ? (n / 1e4).toFixed(2) + ' 万积分' : n.toFixed(0) + ' 积分'
  return '1 元 ≈ ' + perYuan + '（100 万积分 ≈ ' + (1e6 / n).toFixed(1) + ' 元）'
}

/** 美元单位（跨单位比较时折成人民币用） */
const USD_UNITS = ['USD', 'usd', '$', '美元']

/**
 * 跨单位**比较用**的金额权重（单位：人民币元）——只用来排序 / 选“最多”，**不用于展示**。
 *
 * 口径（2026-09-22 用户要求）：
 * - 积分型单位 → 按折算率折成人民币（商汤的积分必须折算后才能和元比）；
 * - 美元单位 → 按实时汇率折成人民币；
 * - 元 / CNY 等本身就是金额 → 原值；
 * - 折不了（积分没设折算率、汇率未知、没见过的单位）→ 回退原值，保持旧行为不比错。
 *
 * 展示仍一律用原单位原值：折算只发生在比较的“后台”。
 */
export function compareWeight(
  value: number | null | undefined,
  unit: string,
  creditsPerCny: number | null | undefined,
  usdRate?: number | null
): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  const cny = creditCny(value, unit, creditsPerCny)
  if (cny !== null) return cny
  if (USD_UNITS.includes(String(unit ?? '').trim()) && typeof usdRate === 'number' && usdRate > 0) {
    return value * usdRate
  }
  return value
}
