/**
 * CSV 导出公共工具（renderer 专用，不涉及主进程/Electron API）。
 * 供 UsageStats / PlatformUsage 等组件复用的导出能力：
 * 单元格转义、带 UTF-8 BOM 的下载触发、日期戳文件名。
 */

/** 转义单个 CSV 单元格（含逗号/引号/换行的字段加引号包裹） */
export function csvCell(s: string | number | null | undefined): string {
  const t = String(s ?? '')
  return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t
}

/** 触发一次 CSV 下载（带 UTF-8 BOM，Excel 直接打开不乱码；lines 中每行会被逐格转义） */
export function downloadCsv(filename: string, lines: readonly (readonly (string | number | null | undefined)[])[]): void {
  const body = lines.map((row) => row.map(csvCell).join(',')).join('\r\n')
  const blob = new Blob(['\ufeff' + body], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** 今天的日期戳（yyyy-MM-dd），用于导出文件名 */
export function todayStamp(): string {
  const now = new Date()
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
}