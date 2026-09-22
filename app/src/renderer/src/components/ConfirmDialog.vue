<script setup lang="ts">
import { ref, watch } from 'vue'
import BaseModal from './BaseModal.vue'

/**
 * 统一确认 / 输入对话框（基于 BaseModal）：
 * - 标题 + 正文（\n 渲染成换行）+ 「确认 / 取消」两个按钮；
 * - danger = true 时确认按钮用 danger 红色（危险操作）；
 * - withInput = true 时进入输入模式（单行输入框，确认时回传输入值）。
 *
 * 样式放在 global.css（BaseModal 用 <Teleport>，按项目约定模态框样式必须全局，
 * 见 global.css「模态框」一节的说明）。
 */
const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    /** 正文，支持多行（\n 渲染成换行） */
    message: string
    /** 危险操作：确认按钮红色 */
    danger?: boolean
    /** 输入模式：显示单行输入框，确认时回传输入值 */
    withInput?: boolean
    defaultValue?: string
    confirmText?: string
    cancelText?: string
  }>(),
  { danger: false, withInput: false, defaultValue: '', confirmText: '确认', cancelText: '取消' }
)

const emit = defineEmits<{
  (e: 'confirm', value: string): void
  (e: 'cancel'): void
}>()

const input = ref('')
watch(
  () => props.open,
  (v) => {
    if (v) input.value = props.defaultValue
  },
  { immediate: true }
)

function onConfirm() {
  emit('confirm', input.value)
}
function onCancel() {
  emit('cancel')
}
</script>

<template>
  <BaseModal :open="open" :title="title" :close-on-mask="false" @close="onCancel">
    <p class="confirm-msg">{{ message }}</p>
    <input
      v-if="withInput"
      v-model="input"
      class="input confirm-input"
      type="text"
      @keyup.enter="onConfirm"
    />
    <template #footer>
      <button class="btn ghost" type="button" @click="onCancel">{{ cancelText }}</button>
      <button class="btn" :class="danger ? 'danger' : 'primary'" type="button" @click="onConfirm">{{ confirmText }}</button>
    </template>
  </BaseModal>
</template>
