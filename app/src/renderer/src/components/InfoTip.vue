<script setup lang="ts">
import { ref } from 'vue'

defineProps<{ text: string }>()

const open = ref(false)
</script>

<template>
  <span
    class="info-tip"
    role="button"
    tabindex="0"
    @mouseenter="open = true"
    @mouseleave="open = false"
    @click.stop="open = !open"
  >
    <span class="tip-icon">?</span>
    <Transition name="tip">
      <span v-if="open" class="tip-bubble">{{ text }}</span>
    </Transition>
  </span>
</template>

<style scoped>
.info-tip {
  position: relative;
  display: inline-flex;
  align-items: center;
  vertical-align: middle;
  cursor: help;
  outline: none;
}

.tip-icon {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  border: 1px solid var(--line-strong);
  color: var(--tx3);
  font-size: 10.5px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all var(--dur) ease;
}

.info-tip:hover .tip-icon {
  color: var(--acc);
  border-color: var(--acc);
  background: var(--acc-soft);
}

.tip-bubble {
  position: absolute;
  top: 22px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 60;
  width: max-content;
  max-width: 250px;
  padding: 8px 11px;
  border-radius: 9px;
  background: var(--panel);
  border: 1px solid var(--line-strong);
  box-shadow: var(--shadow);
  color: var(--tx2);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.65;
  text-align: left;
  white-space: normal;
  cursor: default;
}

.tip-enter-active, .tip-leave-active { transition: opacity 0.14s ease, transform 0.14s ease; }
.tip-enter-from, .tip-leave-to { opacity: 0; transform: translateX(-50%) translateY(-3px); }
</style>
