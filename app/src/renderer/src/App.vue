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
import CorrectionView from '@renderer/components/CorrectionView.vue'
import PlatformUsage from '@renderer/components/PlatformUsage.vue'
import HelpPane from '@renderer/components/HelpPane.vue'
import UsageReportView from '@renderer/components/UsageReportView.vue'
import BudgetBar from '@renderer/components/BudgetBar.vue'
import OnboardingGuide from '@renderer/components/OnboardingGuide.vue'
import { backgroundData, backgroundForTheme, checkAccountSibling, addAccountSibling, listDailyUsage, reloginAccount, renewAccount, setDemoMode } from '@renderer/api/ipc'
import { useConfirm } from '@renderer/composables/useConfirm'
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
/**
 * 正在「点击登录」处理的账号 id 集合（卡片上那个大按钮的处理中态）。
 * 2026-10-03 起：原来的「静默续期」小按钮勾掉了，续期也走这条统一入口。
 */
const reloggingIds = ref<Set<string>>(new Set())
/** 续期 / 重新登录的结果提示（顶部小字，几秒后自动消失） */
const renewMsg = ref('')
/** 统一对话框（替代原生 window.confirm）；ConfirmHost 挂在模板里，全应用只此一份 */
const { confirm, ConfirmHost } = useConfirm()
/** 跳到「数据校正」页时预选的账号 */
const correctionAccountId = ref('')

/** 顶部横幅提示（8 秒后自动消失）：替代原 window.alert 的失败提示（根组件没有独立消息区） */
function showBanner(text: string): void {
  renewMsg.value = text
  setTimeout(() => { if (renewMsg.value === text) renewMsg.value = '' }, 8000)
}

/** 打开数据校正页（可带账号预选）：其它页面的「校正」入口统一走这里 */
function openCorrection(accountId?: string): void {
  correctionAccountId.value = accountId ?? ''
  view.value = 'correction'
}

/**
 * 卡片上的「点击登录」= 唯一入口，逻辑统一在这里：
 *
 * 1. **先试静默续期**（`renewAccount`：用分区里/保存的会话换新凭据，不弹窗、不用输密码）；
 *    能用就直接刷新，用户什么都不用做 —— 这正是用户 2026-10-03 的要求：
 *    "明明可以自动续期，别非得让我点按钮"。
 * 2. 续不上（或该平台不支持续期）才打开登录窗口，登录完成后自动保存并刷新。
 *
 * 以前卡片上有 🔑「重新登录」和 ↻「续期登录」两个小图标，用户得自己判断该点哪个；
 * 现在两个小按钮都删了，只剩这一个动作，判断交给程序。
 */
async function onRelogin(id: string): Promise<void> {
  const acc = accounts.value.find((a) => a.id === id)
  const name = acc?.name ?? '账号'
  const next = new Set(reloggingIds.value)
  next.add(id)
  reloggingIds.value = next
  try {
    renewMsg.value = name + '：正在尝试自动续期…'
    const rn = await renewAccount(id)
    if (rn.ok && rn.data?.ok) {
      renewMsg.value = name + ' 已自动续期成功，不需要重新登录' +
        (rn.data.expiresAt ? '（新凭据有效至 ' + new Date(rn.data.expiresAt).toLocaleString('zh-CN') + '）' : '')
      await refreshOne(id)
      return
    }
    // 续不上：直接把登录窗口打开（不用用户再去别处找入口）
    renewMsg.value = name + '：自动续期没成功，已打开登录窗口——登录完成会自动保存并刷新'
    const r = await reloginAccount(id)
    if (r.ok && r.data?.ok) {
      const hint = r.data.renewHint ? '（' + r.data.renewHint + '）' : ''
      renewMsg.value = name + ' 登录成功' + hint
      await refreshOne(id)
    } else {
      const why = r.ok ? r.data?.error || '未获取到凭据' : r.error
      renewMsg.value = '登录未完成：' + why
    }
  } finally {
    const done = new Set(reloggingIds.value)
    done.delete(id)
    reloggingIds.value = done
    setTimeout(() => { renewMsg.value = '' }, 8000)
  }
}

/**
 * 「另一个方式」自动检测（用户 2026-10-03 要求）。
 *
 * 背景：Xiaomi MIMO 的余额与 TokenPlan 是两个账号类型，但**共用同一份登录状态**。
 * 以前只在「添加账号」弹窗里有个勾选框（添加时才看得到），用户早就加过余额卡、后来才开的
 * 套餐订阅，就永远收不到提醒。现在改成：概览页自动检测 + 一键添加。
 */
const siblingHint = ref<{ accountId: string; type: AccountType; label: string; name: string } | null>(null)
const siblingBusy = ref(false)
/** 已检测过的账号（同一次运行只查一次，避免每次刷新都打接口） */
const siblingChecked = new Set<string>()
/** 用户点过「以后再说」的账号 */
const siblingMuted = ref<Set<string>>(new Set())

async function checkSibling(): Promise<void> {
  if (demoOn.value) return
  const list = accounts.value.filter((a) => !a.deleted_at)
  const types = new Set(list.map((a) => a.type))
  // 两个都有了就不用提醒
  if (types.has('mimo') && types.has('mimo-plan')) {
    siblingHint.value = null
    return
  }
  const src = list.find((a) => (a.type === 'mimo' || a.type === 'mimo-plan') && !siblingChecked.has(a.id) && !siblingMuted.value.has(a.id))
  if (!src) return
  siblingChecked.add(src.id)
  try {
    const r = await checkAccountSibling(src.id)
    if (!r.ok || !r.data?.available || !r.data.type) return
    siblingHint.value = { accountId: src.id, type: r.data.type, label: r.data.name, name: src.name }
  } catch {
    // 检测失败不打扰用户（下次启动再试）
    siblingChecked.delete(src.id)
  }
}

/** 一键添加「另一个方式」：主进程直接复用这张卡的登录凭据，不用再登录一次 */
async function onSiblingAdd(): Promise<void> {
  const hint = siblingHint.value
  if (!hint || siblingBusy.value) return
  siblingBusy.value = true
  try {
    const r = await addAccountSibling(hint.accountId)
    if (r.ok && r.data?.ok) {
      siblingHint.value = null
      showBanner('已添加「' + r.data.name + '」卡片（共用同一登录状态，无需重新登录）')
      await loadAll()
      await refreshAll()
    } else {
      showBanner('添加失败：' + (r.ok ? r.data?.error || '未知原因' : r.error))
    }
  } finally {
    siblingBusy.value = false
  }
}

function dismissSibling(): void {
  const hint = siblingHint.value
  if (hint) {
    const next = new Set(siblingMuted.value)
    next.add(hint.accountId)
    siblingMuted.value = next
  }
  siblingHint.value = null
}

// 账号列表一变（启动 / 保存 / 删除）就顺手检测一次「另一个方式」
watch(accounts, () => { void checkSibling() }, { deep: false })

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
  // API 令牌 = 用 API Key 访问的平台；登录态型（siliconflow、SenseNova 等）属于套餐/额度
  { key: 'token', label: 'API 令牌', types: ['deepseek', 'newapi', 'custom'] },
  { key: 'wallet', label: '钱包余额', types: ['siliconflow', 'mimo', 'minimax', 'zhipu', 'aliyun'] },
  // 套餐 / 额度类：Xiaomi MIMO TokenPlan、SenseNova Token Plan（都是「额度池」口径）
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

/** 传给 SettingsDialog 的单位列表（computed 缓存引用，避免每次渲染都生成新数组） */
const budgetUnits = computed(() => budgetRows.value.map((b) => b.unit))

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

/** 一次保存多个账号（MiMo 余额 + 套餐）：逐条落盘，中途失败如实告知已保存几条（已落盘的不回滚） */
async function onSaveBoth(payloads: AccountInput[]) {
  let saved = 0
  for (const p of payloads) {
    const r = await saveAccount(p)
    if (!r.ok) {
      dialogError.value = (saved > 0 ? `前 ${saved} 个账号已保存；` : '') + '保存失败：' + (r.error ?? '未知原因')
      return
    }
    saved++
  }
  showAdd.value = false
  dialogError.value = null
}

async function onRemove(id: string) {
  const acc = accounts.value.find((a) => a.id === id)
  if (!acc) return
  const ok = await confirm('确定删除账号「' + acc.name + '」？此操作不可恢复。', { title: '删除账号', danger: true })
  if (!ok) return
  const r = await removeAccount(id)
  if (!r.ok && r.error) showBanner('删除失败：' + r.error)
}

async function onSettingsSave(patch: Parameters<typeof saveSettings>[0]) {
  const r = await saveSettings(patch)
  if (!r.ok && r.error) showBanner('保存失败：' + r.error)
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
        <div v-if="renewMsg" class="banner ok banner-top">{{ renewMsg }}</div>
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
            <!-- 「另一个方式」自动检测提醒：MiMo 余额 ⇄ TokenPlan 共用同一登录状态 -->
            <div v-if="siblingHint" class="banner warn sibling-banner">
              <span class="sibling-text">
                检测到「{{ siblingHint.name }}」这张卡上还有
                <strong>{{ siblingHint.type === 'mimo-plan' ? 'Xiaomi MIMO TokenPlan（用量 / 额度 / 有效期）' : 'Xiaomi MIMO 余额（现金 / 赠送）' }}</strong>
                可用，但面板里还没有对应卡片。两者共用同一个登录状态，点一下就能加上，不用重新登录。
              </span>
              <span class="sibling-ops">
                <button class="btn primary" type="button" :disabled="siblingBusy" @click="onSiblingAdd">
                  {{ siblingBusy ? '添加中…' : '一键添加' }}
                </button>
                <button class="btn" type="button" :disabled="siblingBusy" @click="dismissSibling">以后再说</button>
              </span>
            </div>
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
                      :relogging="reloggingIds.has(row.accountId)"
                      :forecast="forecastMap?.get(row.accountId) ?? null"
                      @refresh="refreshOne"
                      @relogin="onRelogin"
                      @correct="openCorrection(row.accountId)"
                      @edit="openEdit"
                      @remove="onRemove"
                    />
                  </TransitionGroup>
                </template>
              </section>
            </div>
          </template>
        </template>

        <UsageStats v-else-if="view === 'usage'" :settings="settings" @correct="openCorrection" />

        <PlatformUsage v-else-if="view === 'platform'" :settings="settings" />

        <KeysView v-else-if="view === 'keys'" :rows="rows" @edit="openEdit" />

        <UsageReportView v-else-if="view === 'report'" />

        <HelpPane v-else-if="view === 'help'" />

        <LogView v-else-if="view === 'logs'" />

        <ThemeView v-else-if="view === 'theme'" :settings="settings" @save="onSettingsSave" />

        <CorrectionView
          v-else-if="view === 'correction'"
          :accounts="accounts"
          :initial-account-id="correctionAccountId"
        />

        <SettingsDialog
          v-else-if="view === 'settings'"
          :settings="settings"
          :app-info="appInfo"
          :units="budgetUnits"
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

    <!-- 统一对话框宿主（confirm / prompt 共用，全应用只挂一次） -->
    <ConfirmHost />
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
  /* 显式 max-content：避免内容多的卡片（阿里云/siliconflow）脚注被裁 */
  grid-auto-rows: max-content;
  gap: var(--gap);
  align-content: start;
}

/* 「另一个方式」自动检测提醒条（MiMo 余额 ⇄ TokenPlan） */
.sibling-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.sibling-text {
  min-width: 0;
  flex: 1 1 320px;
  line-height: 1.5;
}

.sibling-ops {
  display: flex;
  gap: 8px;
  flex: none;
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