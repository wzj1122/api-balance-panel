<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{
  modelValue: number | string
  options: { value: number | string; label: string }[]
}>()
const emit = defineEmits<{ (e: 'update:modelValue', v: number | string): void }>()

const open = ref(false)
const rootRef = ref<HTMLElement | null>(null)
const current = computed(() => props.options.find((o) => o.value === props.modelValue)?.label ?? '')

function pick(v: number | string) {
  emit('update:modelValue', v)
  open.value = false
}

function onDocClick(e: MouseEvent) {
  if (rootRef.value && !rootRef.value.contains(e.target as Node)) open.value = false
}
onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))
</script>

<template>
  <div ref="rootRef" class="sm" :class="{ open }">
    <button class="sm-btn" type="button" @click="open = !open">
      <span class="sm-label">{{ current }}</span>
      <svg class="sm-caret" viewBox="0 0 12 12" width="10" height="10">
        <path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      </svg>
    </button>
    <Transition name="sm">
      <ul v-if="open" class="sm-list">
        <li
          v-for="o in options"
          :key="String(o.value)"
          class="sm-item"
          :class="{ on: o.value === modelValue }"
          @click="pick(o.value)"
        >
          {{ o.label }}
        </li>
      </ul>
    </Transition>
  </div>
</template>

<style scoped>
.sm { position: relative; display: inline-block; }
.sm-btn {
  display: inline-flex; align-items: center; justify-content: space-between; gap: 10px;
  min-width: 132px; height: 32px; padding: 0 10px 0 12px;
  border: 1px solid var(--line); border-radius: 9px;
  background: var(--bg-2); color: var(--tx); font-size: var(--fs-sub); cursor: pointer;
  transition: border-color var(--dur) ease, box-shadow var(--dur) ease;
}
.sm-btn:hover { border-color: var(--line-strong); }
.sm.open .sm-btn { border-color: var(--acc); box-shadow: 0 0 0 3px var(--acc-soft); }
.sm-caret { color: var(--tx3); transition: transform var(--dur) ease; }
.sm.open .sm-caret { transform: rotate(180deg); }
.sm-list {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 80;
  min-width: 100%; padding: 5px; margin: 0; list-style: none;
  background: var(--panel); border: 1px solid var(--line-strong); border-radius: 11px;
  box-shadow: var(--shadow); max-height: 260px; overflow-y: auto;
}
.sm-item {
  padding: 7px 11px; border-radius: 7px; font-size: var(--fs-sub); color: var(--tx2);
  cursor: pointer; white-space: nowrap; transition: background var(--dur) ease, color var(--dur) ease;
}
.sm-item:hover { background: var(--panel2); color: var(--tx); }
.sm-item.on { background: var(--acc-soft); color: var(--acc); font-weight: 600; }
.sm-enter-active, .sm-leave-active { transition: opacity 0.14s ease, transform 0.14s ease; }
.sm-enter-from, .sm-leave-to { opacity: 0; transform: translateY(-4px); }
</style>
