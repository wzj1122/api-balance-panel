/**
 * 剪贴板复制统一入口：navigator.clipboard.writeText + try/catch + 成功 / 失败提示。
 * 收敛 KeysView 里三处手写复制（copySecret / copyAs / copyShare）。
 */

/**
 * 返回统一的 `copy(text, okMsg)`：
 * - 成功：提示 okMsg，返回 true；
 * - 失败：提示失败原因，返回 false。
 *
 * `notify` 为消息出口（一般传 useFlash 的 flash）；不传则静默（仍返回布尔值）。
 */
export function useClipboard(notify?: (text: string) => void): (text: string, okMsg: string) => Promise<boolean> {
  async function copy(text: string, okMsg: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text)
      notify?.(okMsg)
      return true
    } catch (e) {
      notify?.('复制失败：' + (e instanceof Error ? e.message : String(e)))
      return false
    }
  }
  return copy
}
