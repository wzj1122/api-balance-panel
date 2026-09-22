/**
 * 「消息 + N 秒自动消失」统一提示逻辑。
 * 收敛 KeysView / LogView / ThemeView / CorrectionView 四份几乎相同的本地实现。
 */
import { ref, type Ref } from 'vue'

export interface FlashApi {
  /** 成功 / 普通提示（timeoutMs 后自动清空） */
  msg: Ref<string>
  /** 错误提示（不自动清空，下一次 flash / fail 时覆盖） */
  err: Ref<string>
  /** 显示一条提示，timeoutMs 后自动消失 */
  flash: (text: string) => void
  /** 显示一条错误提示（保留到下一次提示） */
  fail: (text: string) => void
  /** 立即清空两条提示 */
  clear: () => void
}

export function useFlash(timeoutMs = 3000): FlashApi {
  const msg = ref('')
  const err = ref('')

  function flash(text: string): void {
    msg.value = text
    err.value = ''
    setTimeout(() => { if (msg.value === text) msg.value = '' }, timeoutMs)
  }

  function fail(text: string): void {
    err.value = text
    msg.value = ''
  }

  function clear(): void {
    msg.value = ''
    err.value = ''
  }

  return { msg, err, flash, fail, clear }
}
