/**
 * 单位 → 金额折算（纯函数，两端共用；不得 import node: / electron）。
 *
 * 为什么需要它：账号可能用不同单位记账（如「积分」「CNY」「USD」），
 * **不同单位不能直接相加**，但界面上把它们并排画成「对比条」时，
 * 必须放到同一把尺子上，否则 100 万积分和 1 元会被当成同一量级的数字。
 *
 * 折算率来自用户设置（credits_per_cny = 多少积分算 1 元），默认见
 * constants.ts 的 DEFAULT_CREDITS_PER_CNY（按 DeepSeek 高峰价反推的估算基线）。
 * 折算结果一律是**估算**，界面必须带「≈ / 估算」字样，不能当成真实扣费。
 */

/** 「积分」类单位（平台额度积分）——只有这类单位才做「积分 → 元」折算（比较时统一小写） */
const CREDIT_UNITS = ['积分', 'points', 'point', 'credit', 'credits']

/** 「元」类单位：本身就是人民币，折算值 = 原值（比较时统一小写） */
const CNY_UNITS = ['cny', 'rmb', '元', '¥', '￥']

/** 「美元」类单位：折算成人民币还需要汇率，暂不折算（比较时统一小写） */
const USD_UNITS = ['usd', '$', '美元']

/** 单位归类：credit = 需要按积分折算；cny = 已经是人民币；other = 不认识（不折算） */
export function unitKind(unit: string): 'credit' | 'cny' | 'other' {
  const u = String(unit ?? '').trim().toLowerCase()
  if (!u) return 'other'
  if (CNY_UNITS.includes(u)) return 'cny'
  if (USD_UNITS.includes(u)) return 'other'
  if (CREDIT_UNITS.includes(u)) return 'credit'
  return 'other'
}

/** 折算率是否可用（<=0 或非有限值 = 用户关掉了折算） */
export function hasCreditRate(creditsPerCny: number | null | undefined): boolean {
  return typeof creditsPerCny === 'number' && Number.isFinite(creditsPerCny) && creditsPerCny > 0
}

/** 积分 → 元的估算值；折算率不可用或单位不认识时返回 null（调用方显示原值即可） */
export function creditsToCny(value: number | null | undefined, creditsPerCny: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  if (!hasCreditRate(creditsPerCny)) return null
  return value / (creditsPerCny as number)
}

/**
 * 任意单位金额 → 人民币估算值，用于把不同单位放到同一把尺子（排序 / 对比条宽度）。
 * - 「元」类：原值
 * - 「积分」类：按折算率估算
 * - 其它 / 折算率不可用：null（调用方退回原值排序，不硬凑）
 */
export function toCnyEstimate(
  value: number | null | undefined,
  unit: string,
  creditsPerCny: number | null | undefined
): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  const kind = unitKind(unit)
  if (kind === 'cny') return value
  if (kind === 'credit') return creditsToCny(value, creditsPerCny)
  return null
}

/** 折算率的中文说明（设置页与页脚共用，避免两处口径写歪） */
export function rateText(creditsPerCny: number | null | undefined): string {
  if (!hasCreditRate(creditsPerCny)) return '未启用积分折算'
  const n = creditsPerCny as number
  const perYuan = n >= 1e4 ? (n / 1e4).toFixed(2) + ' 万积分' : n.toFixed(0) + ' 积分'
  return '1 元 ≈ ' + perYuan + '（100 万积分 ≈ ' + (1e6 / n).toFixed(1) + ' 元）'
}
