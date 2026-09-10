<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'

const props = defineProps<{
  open: boolean
  title: string
  /** 点遮罩是否可关闭，默认 true */
  closeOnMask?: boolean
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

function close() {
  emit('close')
}

function onMaskClick() {
  if (props.closeOnMask !== false) close()
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.open) close()
}

// 打开时挂键盘监听，关闭时移除
watch(
  () => props.open,
  (v) => {
    if (v) window.addEventListener('keydown', onKey)
    else window.removeEventListener('keydown', onKey)
  },
  { immediate: true }
)

onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="open" class="mask" @click.self="onMaskClick">
        <div class="modal" role="dialog" aria-modal="true">
          <header class="modal-head">
            <h2 class="modal-title">{{ title }}</h2>
            <button class="modal-x" type="button" aria-label="关闭" @click="close">×</button>
          </header>
          <div class="modal-body">
            <slot />
          </div>
          <footer v-if="$slots.footer" class="modal-foot">
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
