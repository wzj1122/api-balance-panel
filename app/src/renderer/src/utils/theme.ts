/**
 * 主题解析（渲染进程用）。
 *
 * 约定（与「设置 → 显示 → 主题」和「主题外观」页联动一致）：
 * - 主题标识写的是用户的选择：'dark' / 'light' / 'system'，或设计师主题 slug（如 deep-space-dark）；
 * - 'system' = 跟随系统：按系统深浅色自动落到**经典**的 'dark' / 'light' 两套主题之一；
 * - 界面生效的主题 = 解析后的具体 slug，写进 document.documentElement.dataset.theme。
 */

/** 跟随系统时使用的主题（经典深色 / 经典浅色） */
const SYSTEM_THEME: { dark: string; light: string } = {
  dark: 'dark',
  light: 'light'
}

/**
 * 把主题标识解析成实际生效的主题 slug。
 * @param pref 主题标识（'dark' / 'light' / 'system' / 设计师 slug）
 * @param prefersDark 系统当前是否深色（theme 为 'system' 时才会用到）
 */
export function resolveTheme(pref: string | undefined | null, prefersDark: boolean): string {
  const value = pref && pref.length > 0 ? pref : SYSTEM_THEME.dark
  if (value !== 'system') return value
  return prefersDark ? SYSTEM_THEME.dark : SYSTEM_THEME.light
}
