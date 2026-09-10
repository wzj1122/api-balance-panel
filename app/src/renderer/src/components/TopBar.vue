<script setup lang="ts">
import { computed } from 'vue'
import { fmtClock } from '@shared/format'

const props = defineProps<{
  /** 是否有刷新在进行（整批或全部） */
  busy: boolean
  lastUpdated: number | null
  /** 自动刷新间隔（分钟） */
  refreshMinutes: number
  /** 是否有失败账号，用于状态点变红 */
  hasFailure: boolean
}>()

const emit = defineEmits<{
  (e: 'refresh'): void
  (e: 'add-account'): void
}>()

const updatedText = computed(() => (props.lastUpdated ? fmtClock(props.lastUpdated) : '—'))
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <div class="logo" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
          <path
            d="M3 15l4-5 4 3 6-8"
            stroke="#fff"
            stroke-width="2.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path d="M15 5h4v4" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
      <div class="brand-text">
        <h1 class="title">API 余额面板</h1>
        <div class="status">
          <span class="dot" :class="{ bad: hasFailure }"></span>
          <span>更新于 {{ updatedText }} · 每 {{ refreshMinutes }} 分钟自动刷新</span>
        </div>
      </div>
    </div>

    <div class="actions">
      <button class="btn ghost" type="button" :disabled="busy" @click="emit('refresh')">
        <svg class="ico" :class="{ spin: busy }" viewBox="0 0 16 16" width="14" height="14">
          <path
            fill="currentColor"
            d="M8 3a5 5 0 1 0 4.6 3H11a3.5 3.5 0 1 1-.9-2.3L9.2 4.4H12V2L9.6 2.2A5 5 0 0 0 8 3Z"
          />
        </svg>
        {{ busy ? '刷新中' : '刷新' }}
      </button>
      <button class="btn primary" type="button" @click="emit('add-account')">
        <svg class="ico" viewBox="0 0 16 16" width="14" height="14">
          <path fill="currentColor" d="M7.2 7.2V3h1.6v4.2H13v1.6H8.8V13H7.2V8.8H3V7.2h4.2Z" />
        </svg>
        添加账号
      </button>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  height: var(--topbar-h);
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 var(--pad-lg);
  background: var(--bar-bg);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border-bottom: 1px solid var(--line);
  z-index: 10;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.logo {
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: 10px;
  background: var(--acc-grad);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 14px rgba(79, 140, 255, 0.35);
}

.brand-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.title {
  font-size: var(--fs-title);
  font-weight: 650;
  letter-spacing: 0.2px;
  color: var(--tx-strong);
  margin: 0;
  line-height: 1.3;
  white-space: nowrap;
}

.status {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: var(--fs-foot);
  color: var(--tx3);
  white-space: nowrap;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.ico {
  flex: none;
}

.spin {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
