<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { AccountInput, AccountType, AccountView, DailyAccount } from '@shared/types'
import { usePanel } from '@renderer/composables/usePanel'
import Sidebar, { type SidebarView } from '@renderer/components/Sidebar.vue'
import TitleBar from '@renderer/components/TitleBar.vue'
import SummaryBar from '@renderer/components/SummaryBar.vue'
import AccountCard from '@renderer/components/AccountCard.vue'
import EmptyState from '@renderer/components/EmptyState.vue'
import AccountDialog from '@renderer/components/AccountDialog.vue'
import SettingsDialog from '@renderer/components/SettingsDialog.vue'
import UsageStats from '@renderer/components/UsageStats.vue'
import KeysView from '@renderer/components/KeysView.vue'
import LogView from '@renderer/components/LogView.vue'
import ThemeView from '@renderer/components/ThemeView.vue'
import PlatformUsage from '@renderer/components/PlatformUsage.vue'
import HelpPane from '@renderer/components/HelpPane.vue'
import UsageReportView from '@renderer/components/UsageReportView.vue'
import BudgetBar from '@renderer/components/BudgetBar.vue'
import OnboardingGuide from '@renderer/components/OnboardingGuide.vue'
import { backgroundData, backgroundForTheme, listDailyUsage, setDemoMode } from '@renderer/api/ipc'
import { resolveTheme } from '@renderer/utils/theme'

const {
  accounts,
  rows,
  settings,
  appInfo,
  loading,
  refreshingIds,
  lastUpdated,
  configBanner,
  loadAll,
  refreshAll,
  refreshOne,
  saveAccount,
  removeAccount,
  saveSettings
} = usePanel()

const view = ref<SidebarView>('dashboard')
const showAdd = ref(false)
const editingAccount = ref<AccountView | null>(null)
const dialogError = ref<string | null>(null)
/** 概览页卡片上的余额耗尽预估（按账号 id 索引） */
const forecastMap = ref<Map<string, DailyAccount> | null>(null)
/** 每日预算条数据：每个单位的今日消耗 + 当前余额合计 */
const budgetRows = ref<{ unit: string; today: number | null; remaining: number | null }[]>([])
/** 演示模式（内存沙箱，不写真实数据） */
const demoOn = ref(false)
/** 新手引导是否显示 */
const showOnboard = ref(false)

// 主题：设置驱动（深色 / 浅色 / 跟随系统 / 设计师主题），写入 data-theme
// - 深色 / 浅色 = 直接切到对应的经典主题（与「主题外观」页里的「深色（默认）」「浅色（默认）」是同一套）
// - 跟随系统 = 按系统深浅色，在经典深色与经典浅色之间自动选择
const darkMedia = window.matchMedia('(prefers-color-scheme: dark)')

function applyTheme(pref: string | undefined): void {
  const resolved = resolveTheme(pref, darkMedia.matches)
  document.documentElement.dataset.theme = resolved
  try { localStorage.setItem('panel-theme', resolved) } catch { /* 忽略 */ }
}

watch(
  () => settings.value?.theme,
  async (t) => {
    applyTheme(t)
    if (!t || !settings.value) return
    // 每套主题自带背景：切换主题时自动换用对应的内置背景
    const r = await backgroundForTheme(t)
    if (r.ok && r.data.name && settings.value.bg_file !== r.data.name) {
      void saveSettings({ bg_file: r.data.name })
    }
  },
  { immediate: true }
)

// 系统主题变化时，仅在「跟随系统」下实时切换
darkMedia.addEventListener('change', () => {
  if (settings.value?.theme === 'system') applyTheme('system')
})

/** 背景图 data URL（启用且选中文件时加载） */
const bgDataUrl = ref('')

async function loadBgImage() {
  const s = settings.value
  if (!s || !s.bg_enabled || !s.bg_file) {
    bgDataUrl.value = ''
    return
  }
  const r = await backgroundData(s.bg_file)
  bgDataUrl.value = r.ok && r.data.dataUrl ? r.data.dataUrl : ''
}

watch(() => [settings.value?.bg_enabled, settings.value?.bg_file], () => { void loadBgImage() }, { immediate: true })

// 液态玻璃：模糊半径 / 通透度 / 饱和度
watch(
  () => [settings.value?.glass_enabled, settings.value?.glass_blur, settings.value?.glass_alpha],
  () => {
    const s = settings.value
    const root = document.documentElement
    root.dataset.glass = s && s.glass_enabled === false ? 'off' : 'on'
    root.style.setProperty('--glass-blur', (s?.glass_blur ?? 16) + 'px')
    root.style.setProperty('--glass-alpha', String(s?.glass_alpha ?? 0.72))
    root.style.setProperty('--glass-saturate', '1.8')
  },
  { immediate: true }
)

// 卡片半透明（85%）
watch(() => settings.value?.card_translucent, (on) => {
  document.documentElement.dataset.cardTranslucent = on === false ? 'off' : 'on'
}, { immediate: true })

const refreshMinutes = computed(() => {
  const s = settings.value?.refresh_seconds ?? 300
  return s / 60
})
const busy = computed(() => loading.value || refreshingIds.value.size > 0)
const hasFailure = computed(() => rows.value.some((r) => !r.ok))
const failCount = computed(() => rows.value.filter((r) => !r.ok).length)

/** 概览页分组（可折叠） */
const GROUPS: { key: string; label: string; types: AccountType[] }[] = [
  // API 令牌 = 用 API Key 访问的平台；登录态型（硅基流动、商汤日日新等）属于套餐/额度
  { key: 'token', label: 'API 令牌', types: ['deepseek', 'newapi', 'custom'] },
  { key: 'wallet', label: '钱包余额', types: ['siliconflow', 'mimo', 'minimax', 'zhipu', 'aliyun'] },
  // 套餐 / 额度类：小米 MiMo 套餐、商汤日日新 Token Plan（都是「额度池」口径）
  { key: 'plan', label: '套餐 / 额度', types: ['mimo-plan', 'sensenova'] }
]
const collapsed = ref<Set<string>>(new Set())
/** 兜底：没被任何分组列到的类型（新增平台忘了加分组时）也要显示出来，避免"账号存在但看不到" */
const OTHER_TYPES = computed(() => {
  const known = new Set(GROUPS.flatMap((g) => g.types))
  return Array.from(new Set(rows.value.map((r) => r.type).filter((t) => !known.has(t))))
})
const groupRows = computed(() => {
  const groups = GROUPS.map((g) => ({ ...g, rows: rows.value.filter((r) => g.types.includes(r.type)) }))
  if (OTHER_TYPES.value.length > 0) {
    groups.push({ key: 'other', label: '其他', types: OTHER_TYPES.value as AccountType[],
      rows: rows.value.filter((r) => OTHER_TYPES.value.includes(r.type)) })
  }
  return groups.filter((g) => g.rows.length > 0)
})
function toggleGroup(key: string) {
  const s = new Set(collapsed.value)
  if (s.has(key)) s.delete(key)
  else s.add(key)
  collapsed.value = s
}

async function loadForecast() {
  const r = await listDailyUsage(30)
  if (!r.ok) return
  const m = new Map<string, DailyAccount>()
  for (const a of r.data.accounts) m.set(a.accountId, a)
  forecastMap.value = m
}

/** 今日消耗（按单位）+ 余额合计 → 每日预算条 */
async function loadBudget() {
  const r = await listDailyUsage(1)
  const todayMap = new Map<string, number | null>()
  if (r.ok) for (const u of r.data.unitTotals) todayMap.set(u.unit, u.today)
  const remainMap = new Map<string, number>()
  for (const row of rows.value) {
    if (!row.ok || row.remaining === null || row.remaining === undefined || !row.unit) continue
    remainMap.set(row.unit, (remainMap.get(row.unit) ?? 0) + row.remaining)
  }
  const units = new Set<string>([...todayMap.keys(), ...remainMap.keys()])
  budgetRows.value = Array.from(units).map((u) => ({
    unit: u,
    today: todayMap.get(u) ?? null,
    remaining: remainMap.get(u) ?? null
  }))
}

/** 首次启动（没有账号且没完成过引导）时弹出新手引导 */
function checkOnboard() {
  showOnboard.value = !demoOn.value && accounts.value.length === 0 && settings.value?.onboarded !== true
}

onMounted(() => {
  void Promise.resolve(loadAll()).then(() => {
    checkOnboard()
    void loadBudget()
  })
  void loadForecast()
})

async function enterDemo() {
  const r = await setDemoMode(true)
  if (!r.ok) return
  demoOn.value = true
  showOnboard.value = false
  view.value = 'dashboard'
  await loadAll()
  await loadForecast()
  await loadBudget()
  // accounts 变化会触发引导检查，这里再兜一次，确保演示模式下不显示引导
  showOnboard.value = false
}

async function exitDemo() {
  const r = await setDemoMode(false)
  if (!r.ok) return
  demoOn.value = false
  await loadAll()
  await loadForecast()
  await loadBudget()
}

function closeOnboard() {
  showOnboard.value = false
  void saveSettings({ onboarded: true })
}
// 切回概览 / 整批刷新完成时顺带刷新预报（数据随时间累计）
watch(view, (v) => { if (v === 'dashboard') void loadForecast() })

// 账号增删后重新判断是否需要引导
watch(accounts, () => checkOnboard())
watch(lastUpdated, () => {
  if (view.value === 'dashboard') void loadForecast()
  void loadBudget()
})

function openAdd() {
  editingAccount.value = null
  dialogError.value = null
  showAdd.value = true
}

function openEdit(id: string) {
  const acc = accounts.value.find((a) => a.id === id)
  if (!acc) return
  editingAccount.value = acc
  dialogError.value = null
  showAdd.value = true
}

async function onSave(payload: AccountInput) {
  const r = await saveAccount(payload)
  if (r.ok) {
    showAdd.value = false
    dialogError.value = null
  } else {
    dialogError.value = r.error
  }
}

/** 一次保存多个账号（MiMo 余额 + 套餐），全部成功才关弹窗 */
async function onSaveBoth(payloads: AccountInput[]) {
  for (const p of payloads) {
    const r = await saveAccount(p)
    if (!r.ok) {
      dialogError.value = r.error ?? '保存失败'
      return
    }
  }
  showAdd.value = false
  dialogError.value = null
}

async function onRemove(id: string) {
  const acc = accounts.value.find((a) => a.id === id)
  if (!acc) return
  const ok = window.confirm('确定删除账号「' + acc.name + '」？此操作不可恢复。')
  if (!ok) return
  const r = await removeAccount(id)
  if (!r.ok && r.error) window.alert('删除失败：' + r.error)
}

async function onSettingsSave(patch: Parameters<typeof saveSettings>[0]) {
  const r = await saveSettings(patch)
  if (!r.ok && r.error) window.alert('保存失败：' + r.error)
  return r
}
</script>

<template>
  <div class="app">
    <div class="app-bg" :class="'fit-' + (settings?.bg_enabled && bgDataUrl ? (settings?.bg_fit ?? 'cover') : 'none')" :style="bgDataUrl ? { backgroundImage: 'url(' + bgDataUrl + ')', filter: 'blur(' + (settings?.bg_blur ?? 0) + 'px)' } : {}"></div>
    <div class="app-bg-mask" :style="{ opacity: settings?.bg_enabled && bgDataUrl ? (settings?.bg_dim ?? 20) / 100 : 0 }"></div>
    <TitleBar
      :busy="busy"
      :last-updated="lastUpdated"
      :refresh-minutes="refreshMinutes"
      :has-failure="hasFailure"
      :version="appInfo?.version ?? ''"
      @refresh="refreshAll"
      @add-account="openAdd"
    />
    <div class="app-body">
    <Sidebar
      :view="view"
      :fail-count="failCount"
      :version="appInfo?.version ?? ''"
      @select="view = $event"
    />

    <div class="main">

      <div class="content">
        <template v-if="view === 'dashboard'">
          <div v-if="configBanner" class="banner warn banner-top">{{ configBanner }}</div>

          <template v-if="accounts.length === 0">
            <EmptyState @add="openAdd" />
          </template>

          <template v-else>
            <div v-if="demoOn" class="demo-bar">
              <span class="demo-tag">演示模式</span>
              <span>以下为示例数据，只存在内存中，不会写入你的配置</span>
              <button class="btn ghost demo-btn" type="button" @click="exitDemo">退出演示</button>
            </div>
            <SummaryBar :rows="rows" :total-accounts="accounts.length" />
            <BudgetBar :budgets="settings?.daily_budget ?? {}" :units="budgetRows" />
            <div class="groups">
              <section v-for="g in groupRows" :key="g.key" class="group">
                <button class="group-head" type="button" @click="toggleGroup(g.key)">
                  <svg class="caret" :class="{ open: !collapsed.has(g.key) }" viewBox="0 0 16 16" width="12" height="12">
                    <path d="M6 4l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                  <span class="group-label">{{ g.label }}</span>
                  <span class="group-count num">{{ g.rows.length }}</span>
                </button>
                <template v-if="!collapsed.has(g.key)">
                  <TransitionGroup tag="div" name="list" class="grid">
                    <AccountCard
                      v-for="row in g.rows"
                      :key="row.accountId"
                      :row="row"
                      :refreshing="refreshingIds.has(row.accountId)"
                      :forecast="forecastMap?.get(row.accountId) ?? null"
                      @refresh="refreshOne"
                      @edit="openEdit"
                      @remove="onRemove"
                    />
                  </TransitionGroup>
                </template>
              </section>
            </div>
          </template>
        </template>

        <UsageStats v-else-if="view === 'usage'" />

        <PlatformUsage v-else-if="view === 'platform'" />

        <KeysView v-else-if="view === 'keys'" :rows="rows" @edit="openEdit" />

        <UsageReportView v-else-if="view === 'report'" />

        <HelpPane v-else-if="view === 'help'" />

        <LogView v-else-if="view === 'logs'" />

        <ThemeView v-else-if="view === 'theme'" :settings="settings" @save="onSettingsSave" />

        <SettingsDialog
          v-else-if="view === 'settings'"
          :settings="settings"
          :app-info="appInfo"
          :units="budgetRows.map((b) => b.unit)"
          @save="onSettingsSave"
        />
      </div>
    </div>
    </div>

    <AccountDialog
      :open="showAdd"
      :account="editingAccount"
      :error="dialogError"
      :existing-types="accounts.map((a) => a.type)"
      @close="showAdd = false"
      @save="onSave"
      @save-both="onSaveBoth"
    />

    <OnboardingGuide
      :open="showOnboard"
      @close="closeOnboard"
      @add-account="closeOnboard(); openAdd()"
      @demo="enterDemo"
    />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.app-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.demo-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px var(--pad-lg) 0;
  padding: 9px 14px;
  border-radius: 12px;
  background: var(--acc-soft);
  border: 1px solid var(--line-strong);
  color: var(--tx2);
  font-size: 12.5px;
}

.demo-tag {
  font-size: 11px;
  font-weight: 700;
  color: #fff;
  background: var(--acc-grad);
  border-radius: 999px;
  padding: 2px 10px;
  flex: none;
}

.demo-btn {
  margin-left: auto;
  flex: none;
}

.banner-top {
  margin: 12px var(--pad-lg) 0;
  border-radius: var(--radius-sm);
  flex: none;
}

.groups {
  flex: 1;
  overflow-y: auto;
  padding: var(--pad) var(--pad-lg) 32px;
}

.group {
  margin-bottom: 12px;
}

.group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 4px 9px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--tx2);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.3px;
  transition: color var(--dur) ease;
}

.group-head:hover {
  color: var(--tx);
}

.caret {
  flex: none;
  transition: transform 0.2s var(--ease);
  opacity: 0.7;
}

.caret.open {
  transform: rotate(90deg);
}

.group-label {
  flex: none;
}

.group-count {
  flex: none;
  font-size: var(--fs-foot);
  color: var(--tx3);
  background: var(--panel2);
  border-radius: 999px;
  padding: 1px 9px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  /* 显式 max-content：避免内容多的卡片（阿里云/硅基流动）脚注被裁 */
  grid-auto-rows: max-content;
  gap: var(--gap);
  align-content: start;
}

/* 卡片列表过渡（新增/更新时淡入上浮，排序平滑移动） */
.list-enter-active {
  transition: opacity 0.32s var(--ease), transform 0.32s var(--ease);
}

.list-enter-from {
  opacity: 0;
  transform: translateY(10px);
}

.list-move {
  transition: transform 0.35s var(--ease);
}
</style>