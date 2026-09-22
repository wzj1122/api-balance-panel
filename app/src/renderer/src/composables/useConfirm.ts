/**
 * 统一对话框（替代原生 window.confirm / window.prompt）。
 *
 * 用法：
 *   const { confirm, prompt, ConfirmHost } = useConfirm()
 *   // App.vue 模板里放一次 <ConfirmHost />（模块级单例，同一时刻只弹一个）
 *   if (!(await confirm('确定删除？', { danger: true }))) return
 *   const v = await prompt('输入名称：', '默认值') // 取消返回 null
 *
 * ConfirmHost 是宿主组件：模块级单例状态驱动，只需在 App.vue 挂一次；
 * 新的请求会先把上一个未决对话框按「取消」结掉，保证同一时刻只弹一个。
 */
import { defineComponent, h, reactive } from 'vue'
import ConfirmDialog from '@renderer/components/ConfirmDialog.vue'

export interface ConfirmOptions {
  title?: string
  /** 危险操作：确认按钮用 danger 红色 */
  danger?: boolean
}

interface DialogState {
  open: boolean
  title: string
  message: string
  danger: boolean
  withInput: boolean
  defaultValue: string
  resolve: ((value: boolean | string | null) => void) | null
}

/** 模块级单例状态：整个渲染层同一时刻只弹一个对话框 */
const state = reactive<DialogState>({
  open: false,
  title: '',
  message: '',
  danger: false,
  withInput: false,
  defaultValue: '',
  resolve: null
})

/** 新请求到来时，把上一个未决对话框按「取消」结掉（防 Promise 泄漏） */
function settlePrevious(): void {
  const prev = state.resolve
  if (!prev) return
  state.resolve = null
  prev(state.withInput ? null : false)
}

function settle(value: boolean | string | null): void {
  const r = state.resolve
  state.resolve = null
  state.open = false
  r?.(value)
}

const ConfirmHost = defineComponent({
  name: 'ConfirmHost',
  setup() {
    return () =>
      h(ConfirmDialog, {
        open: state.open,
        title: state.title,
        message: state.message,
        danger: state.danger,
        withInput: state.withInput,
        defaultValue: state.defaultValue,
        onConfirm: (value: string) => settle(state.withInput ? value : true),
        onCancel: () => settle(state.withInput ? null : false)
      })
  }
})

export interface UseConfirmApi {
  /** 确认框：确认 = true，取消 = false */
  confirm: (message: string, opts?: ConfirmOptions) => Promise<boolean>
  /** 输入框：确认 = 输入内容（可为空串），取消 = null */
  prompt: (message: string, defaultValue?: string) => Promise<string | null>
  /** 宿主组件：放在模板里（App.vue 挂一次） */
  ConfirmHost: typeof ConfirmHost
}

export function useConfirm(): UseConfirmApi {
  function confirm(message: string, opts?: ConfirmOptions): Promise<boolean> {
    settlePrevious()
    return new Promise<boolean>((resolve) => {
      state.open = true
      state.title = opts?.title ?? '确认'
      state.message = message
      state.danger = opts?.danger ?? false
      state.withInput = false
      state.defaultValue = ''
      state.resolve = (v) => resolve(v === true)
    })
  }

  function prompt(message: string, defaultValue = ''): Promise<string | null> {
    settlePrevious()
    return new Promise<string | null>((resolve) => {
      state.open = true
      state.title = '输入'
      state.message = message
      state.danger = false
      state.withInput = true
      state.defaultValue = defaultValue
      state.resolve = (v) => resolve(typeof v === 'string' ? v : null)
    })
  }

  return { confirm, prompt, ConfirmHost }
}
