<script setup lang="ts">
export type SidebarView = 'dashboard' | 'usage' | 'platform' | 'keys' | 'report' | 'logs' | 'theme' | 'settings' | 'help'

defineProps<{
  view: SidebarView
  /** 概览页显示失败账号红点 */
  failCount: number
  version: string
}>()
const emit = defineEmits<{
  (e: 'select', v: SidebarView): void
}>()

const items: { id: SidebarView; label: string; icon: string }[] = [
  { id: 'dashboard', label: '概览', icon: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z' },
  { id: 'usage', label: '每日使用状况', icon: 'M3 13h3v6H3zM8 7h3v12H8zM13 10h3v9h-3zM18 4h3v15h-3z' },
  { id: 'platform', label: '平台用量', icon: 'M4 19V9h3v10H4zM10.5 19V5h3v14h-3zM17 19v-7h3v7h-3z' },
  { id: 'keys', label: 'Key 管理', icon: 'M12.6 2a5.4 5.4 0 0 0-5.2 4H5.2A2.2 2.2 0 0 0 3 8.2v9.6A2.2 2.2 0 0 0 5.2 20h9.6a2.2 2.2 0 0 0 2.2-2.2v-2.2h-.9a3.4 3.4 0 0 1 0-6.8h.9V6.2A2.2 2.2 0 0 0 14.8 4h-1.1A5.4 5.4 0 0 0 12.6 2Zm0 2.2a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4Zm4.6 6.6h3.2a1 1 0 0 1 0 2h-3.2a1 1 0 0 1 0-2Z' },
  { id: 'report', label: '使用报告', icon: 'M6 2h9l5 5v15H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm8 1.5V8h4.5L14 3.5ZM8 12h8v1.8H8V12Zm0 4h8v1.8H8V16Zm0-8h4v1.8H8V8Z' },
  { id: 'logs', label: '运行日志', icon: 'M5 2h14a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Zm2.5 4v1.8h9V6h-9Zm0 4v1.8h9V10h-9Zm0 4v1.8h5.5V14H7.5Z' },
  { id: 'theme', label: '主题外观', icon: 'M12 2.6a9.4 9.4 0 0 0 0 18.8c1.2 0 2-.8 2-1.9 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.9-1.8h1.4A4.7 4.7 0 0 0 21 10.6C21 6.2 17 2.6 12 2.6Zm-5 9.2a1.4 1.4 0 1 1 0-2.8 1.4 1.4 0 0 1 0 2.8Zm2.6-3.6a1.4 1.4 0 1 1 0-2.8 1.4 1.4 0 0 1 0 2.8Zm4.8 0a1.4 1.4 0 1 1 0-2.8 1.4 1.4 0 0 1 0 2.8Zm2.6 3.6a1.4 1.4 0 1 1 0-2.8 1.4 1.4 0 0 1 0 2.8Z' },
  { id: 'settings', label: '设置', icon: 'M8 10.5A2.5 2.5 0 1 0 8 5.5a2.5 2.5 0 0 0 0 5Zm6.3-2a4.7 4.7 0 0 0-.1-.9l1.4-1.1-1.4-2.4-1.6.7q-.5-.4-1.1-.6L10.9.6H8.4l-.4 1.8q-.6.2-1.1.6l-1.6-.7-1.4 2.4 1.4 1.1q-.1.4-.1.9t.1.9l-1.4 1.1 1.4 2.4 1.6-.7q.5.4 1.1.6l.4 1.8h2.5l.4-1.8q.6-.2 1.1-.6l1.6.7 1.4-2.4-1.4-1.1q.1-.4.1-.9Z' },
  { id: 'help', label: '使用说明', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 2.2A6.8 6.8 0 1 1 5.2 12 6.8 6.8 0 0 1 12 5.2Zm-.8 10.6h1.6v1.6h-1.6Zm.1-2.6h1.4c0-1.4 1-1.9 1.6-2.6a2.7 2.7 0 0 0-4.9-1.3l1.3.5A1.4 1.4 0 0 1 10.9 11c0 .8 1.2 1 1.3 2.2Z' }
]
</script>

<template>
  <aside class="sidebar">
    <nav class="nav">
      <button
        v-for="it in items"
        :key="it.id"
        class="nav-item"
        :class="{ active: view === it.id }"
        type="button"
        @click="emit('select', it.id)"
      >
        <svg class="ico" viewBox="0 0 24 24" width="16" height="16"><path :d="it.icon" fill="currentColor" /></svg>
        <span class="nav-label">{{ it.label }}</span>
        <span v-if="it.id === 'dashboard' && failCount > 0" class="fail-dot" :title="failCount + ' 个账号查询失败'">{{ failCount }}</span>
      </button>
    </nav>

    <div class="foot">v{{ version }}</div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: var(--sidebar-w);
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--bar-bg);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border-right: 1px solid var(--line);
  padding: 12px 12px;
}



.nav { flex: 1; display: flex; flex-direction: column; gap: 3px; margin-top: 2px; }

.nav-item {
  position: relative; display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px;
  border: none; border-radius: 10px; background: transparent; color: var(--tx2);
  font-size: var(--fs-sub); font-weight: 500; cursor: pointer;
  transition: background var(--dur) ease, color var(--dur) ease;
}

.nav-item:hover { background: var(--panel2); color: var(--tx); }

.nav-item.active { background: var(--acc-soft); color: var(--acc); font-weight: 600; }

.nav-item.active::before {
  content: ''; position: absolute; left: -12px; top: 8px; bottom: 8px; width: 3px;
  border-radius: 2px; background: var(--acc-grad);
}

.ico { flex: none; }
.nav-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.fail-dot {
  margin-left: auto; min-width: 17px; height: 17px; padding: 0 5px; border-radius: 999px;
  background: var(--err); color: #fff; font-size: 10.5px; font-weight: 700;
  display: inline-flex; align-items: center; justify-content: center;
}

.foot { padding: 10px 8px 2px; font-size: var(--fs-foot); color: var(--tx3); }
</style>
