/**
 * 文本 / 展示类公共工具（renderer 专用）。
 * 收敛各组件里逐字重复的本地实现：文件大小格式化、平台名映射、日期戳。
 */
import { PROVIDER_META } from '@shared/constants'
import type { AccountType } from '@shared/types'

/** 统一文件大小格式：> 1MB 保留 1 位小数 + ' MB'，否则四舍五入整数 + ' KB' */
export function formatBytes(n: number): string {
  return n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB'
}

/** 平台类型 → 展示名（取不到映射时原样返回） */
export function providerLabel(t: string): string {
  return PROVIDER_META[t as AccountType]?.label ?? t
}

/** 日期戳（yyyy-MM-dd，本地时区）；不传 = 今天 */
export function dateStamp(d: Date = new Date()): string {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}
