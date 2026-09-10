<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { fmtClock } from '@shared/format'
import { getWindowState, subscribeWindowState, windowClose, windowMinimize, windowToggleMaximize } from '@renderer/api/ipc'

const props = defineProps<{
  busy: boolean
  lastUpdated: number | null
  refreshMinutes: number
  hasFailure: boolean
  version: string
}>()

const emit = defineEmits<{
  (e: 'refresh'): void
  (e: 'add-account'): void
}>()

const maximized = ref(false)
let unsub: (() => void) | null = null

onMounted(async () => {
  const r = await getWindowState()
  if (r.ok) maximized.value = r.data.maximized
  unsub = subscribeWindowState((s) => { maximized.value = s.maximized })
})

onBeforeUnmount(() => { if (unsub) unsub() })

const updatedText = computed(() => {
  const t = props.lastUpdated
  if (!t) return '尚未刷新'
  return '更新于 ' + fmtClock(t)
})

async function onToggle() {
  const r = await windowToggleMaximize()
  if (r.ok) maximized.value = r.data.maximized
}

function onMinimize() {
  void windowMinimize()
}

function onClose() {
  void windowClose()
}

// 双击拖拽区 = 最大化/还原（与系统行为一致）
function onDblClick(e: MouseEvent) {
  const el = e.target as HTMLElement
  if (el.closest('button')) return
  void onToggle()
}
</script>

<template>
  <header class="titlebar" @dblclick="onDblClick">
    <div class="tb-brand">
      <div class="tb-logo" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none">
          <path d="M3 15l4-5 4 3 6-8" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M15 5h4v4" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
      <span class="tb-name">API 余额面板</span>
      <span class="tb-ver">v{{ version }}</span>
    </div>

    <div class="tb-status">
      <span class="tb-dot" :class="{ busy: busy, bad: hasFailure }"></span>
      <span>{{ updatedText }}</span>
      <span class="tb-sep">·</span>
      <span>每 {{ refreshMinutes }} 分钟自动刷新</span>
      <span v-if="hasFailure" class="tb-warn">有账号查询失败</span>
    </div>

    <div class="tb-actions">
      <button class="tb-btn" type="button" :disabled="busy" title="立即刷新" @click="emit('refresh')">
        <svg class="ico" :class="{ spin: busy }" viewBox="0 0 16 16" width="14" height="14">
          <path fill="currentColor" d="M8 3a5 5 0 1 0 4.6 3H11a3.5 3.5 0 1 1-.9-2.3L9.2 4.4H12V2L9.6 2.2A5 5 0 0 0 8 3Z" />
        </svg>
        <span>刷新</span>
      </button>
      <button class="tb-btn primary" type="button" @click="emit('add-account')">
        <svg class="ico" viewBox="0 0 16 16" width="13" height="13">
          <path fill="currentColor" d="M7.2 2h1.6v5.2H14v1.6H8.8V14H7.2V8.8H2V7.2h5.2V2Z" />
        </svg>
        <span>添加账号</span>
      </button>
    </div>

    <div class="tb-win">
      <button class="win-btn" type="button" title="最小化" @click="onMinimize">
        <svg viewBox="0 0 12 12" width="11" height="11"><path d="M1.5 6h9" stroke="currentColor" stroke-width="1.2" /></svg>
      </button>
      <button class="win-btn" type="button" :title="maximized ? '还原' : '最大化'" @click="onToggle">
        <svg v-if="!maximized" viewBox="0 0 12 12" width="11" height="11">
          <rect x="1.6" y="1.6" width="8.8" height="8.8" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.2" />
        </svg>
        <svg v-else viewBox="0 0 12 12" width="11" height="11">
          <rect x="1.6" y="3.6" width="6.8" height="6.8" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2" />
          <path d="M3.8 3.6V2.4A1 1 0 0 1 4.8 1.4h5.8v5.8a1 1 0 0 1-1 1h-1.2" fill="none" stroke="currentColor" stroke-width="1.2" />
        </svg>
      </button>
      <button class="win-btn close" type="button" title="关闭（最小化到托盘）" @click="onClose">
        <svg viewBox="0 0 12 12" width="11" height="11"><path d="M2.2 2.2l7.6 7.6M9.8 2.2l-7.6 7.6" stroke="currentColor" stroke-width="1.2" /></svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  flex: none;
  height: 42px;
  display: flex;
  align-items: center;
  gap: 14px;
  padding-left: 12px;
  background: var(--bar-bg);
  backdrop-filter: blur(14px);
  border-bottom: 1px solid var(--line);
  /* 整条标题栏可拖动窗口 */
  -webkit-app-region: drag;
  user-select: none;
}

.tb-brand { display: flex; align-items: center; gap: 8px; flex: none; }
.tb-logo {
  width: 24px; height: 24px; border-radius: 7px;
  background: var(--acc-grad);
  display: inline-flex; align-items: center; justify-content: center;
  box-shadow: 0 2px 8px rgba(79, 140, 255, 0.35);
}
.tb-name { font-size: 13px; font-weight: 700; color: var(--tx-strong); letter-spacing: 0.2px; }
.tb-ver { font-size: 10.5px; color: var(--tx3); }

.tb-status { min-width: 0; display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--tx3); overflow: hidden; white-space: nowrap; }
.tb-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); flex: none; box-shadow: 0 0 0 3px var(--ok-soft); }
.tb-dot.busy { background: var(--acc); box-shadow: 0 0 0 3px var(--acc-soft); animation: pulse 1.1s ease-in-out infinite; }
.tb-dot.bad { background: var(--err); box-shadow: 0 0 0 3px var(--err-soft); }
@keyframes pulse { 50% { opacity: 0.35; } }
.tb-sep { opacity: 0.5; }
.tb-warn { color: var(--err); font-weight: 600; }

.tb-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; -webkit-app-region: no-drag; }
.tb-btn {
  display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel2);
  color: var(--tx2); font-size: 12px; font-weight: 500; cursor: pointer;
  transition: background var(--dur) ease, color var(--dur) ease, border-color var(--dur) ease;
}
.tb-btn:hover:not(:disabled) { background: var(--panel); color: var(--tx); border-color: var(--line-strong); }
.tb-btn:disabled { opacity: 0.55; cursor: default; }
.tb-btn.primary {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  background: transparent;
  border-color: transparent;
  color: var(--on-acc, #fff);
  font-weight: 600;
}
.tb-btn.primary::before {
  content: '';
  position: absolute;
  inset: 1px;
  border-radius: inherit;
  background: var(--acc-grad);
  z-index: -1;
}
.tb-btn.primary > * { position: relative; z-index: 1; }
.tb-btn.primary:hover { filter: brightness(1.06); color: var(--on-acc, #fff); background: transparent; }
.ico.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.tb-win { display: flex; align-items: stretch; height: 100%; -webkit-app-region: no-drag; }
.win-btn {
  width: 46px; height: 100%;
  display: inline-flex; align-items: center; justify-content: center;
  border: none; background: transparent; color: var(--tx2); cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.win-btn:hover { background: var(--panel2); color: var(--tx); }
.win-btn.close:hover { background: #e81123; color: #fff; }
</style>
