<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { REFRESH_OPTIONS, DEFAULT_CREDITS_PER_CNY } from '@shared/constants'
import type { AutoStartStatus } from '@shared/ipc'
import type { AppInfo, Settings } from '@shared/types'
import { creditsToCny, hasCreditRate, rateText } from '@shared/cost'
import { fmtMoney } from '@shared/format'
import { exportBackup, getAutoStartStatus, importBackup, openDataDir } from '@renderer/api/ipc'
import { useConfirm } from '@renderer/composables/useConfirm'
import InfoTip from './InfoTip.vue'
import SelectMenu from './SelectMenu.vue'

const { confirm } = useConfirm()

const props = defineProps<{
  settings: Settings | null
  appInfo: AppInfo | null
  /** 当前账号使用到的单位（用于每日预算输入行） */
  units: string[]
}>()

const emit = defineEmits<{
  (e: 'save', patch: Partial<Settings>): Promise<{ ok: boolean; error?: string }>
}>()

const local = reactive({
  refresh_seconds: 300,
  pause_when_hidden: true,
  default_threshold: 20,
  notice_enabled: true,
  notice_max_per_day: 1,
  launch_at_login: false,
  /** 主题标识：'dark' / 'light' / 'system'，也可能是设计师主题 slug */
  theme: 'dark' as string,
  drop_alert_percent: 30,
  fail_alert_count: 3,
  /** 积分 → 金额折算：多少积分算 1 元（0 = 不折算） */
  credits_per_cny: DEFAULT_CREDITS_PER_CNY,
  daily_budget: {} as Record<string, number>
})

const dataDirMsg = ref('')
const backupMsg = ref('')
const savedFlash = ref(false)
let savedTimer: ReturnType<typeof setTimeout> | null = null

/** 开机自启：主进程回读到的**真实**系统状态（不是配置里的期望值） */
const autoStart = ref<AutoStartStatus | null>(null)
const autoStartMsg = ref('')
const autoStartBusy = ref(false)

async function loadAutoStart(): Promise<void> {
  const r = await getAutoStartStatus()
  autoStart.value = r.ok ? r.data : null
  autoStartMsg.value = r.ok ? '' : r.error
}
onMounted(() => { void loadAutoStart() })

/** 开关切换：立即落盘 + 立即写/删系统启动项，写入完成后再回读真实状态显示 */
async function onToggleAutoStart(e: Event): Promise<void> {
  const on = (e.target as HTMLInputElement).checked
  autoStartBusy.value = true
  try {
    local.launch_at_login = on
    // emit('save') 返回父组件 saveSettings 的 Promise，await 之后系统启动项已经写完
    await emit('save', { launch_at_login: on })
    await loadAutoStart()
  } finally {
    autoStartBusy.value = false
  }
}

/** 主题：点一下立即生效并保存（与「主题外观」页同一套主题，双向联动） */
async function pickTheme(t: string): Promise<void> {
  const prev = local.theme
  local.theme = t
  const r = await emit('save', { theme: t })
  // 保存失败要回滚选择、不再亮「已保存」（失败详情由 App 层统一 alert）
  if (r && r.ok === false) {
    local.theme = prev
    return
  }
  savedFlash.value = true
  if (savedTimer) clearTimeout(savedTimer)
  savedTimer = setTimeout(() => { savedFlash.value = false }, 1800)
}

function init() {
  const s = props.settings
  if (s) {
    local.refresh_seconds = s.refresh_seconds
    local.pause_when_hidden = s.pause_when_hidden
    local.default_threshold = s.default_threshold
    local.notice_enabled = s.notice_enabled
    local.notice_max_per_day = s.notice_max_per_day
    local.launch_at_login = s.launch_at_login
    // 主题标识原样带入：'dark' / 'light' / 'system' 或设计师主题 slug（与「主题外观」页共用同一个字段）
    local.theme = s.theme
    local.drop_alert_percent = s.drop_alert_percent ?? 30
    local.fail_alert_count = s.fail_alert_count ?? 3
    local.credits_per_cny = s.credits_per_cny ?? DEFAULT_CREDITS_PER_CNY
    local.daily_budget = { ...(s.daily_budget ?? {}) }
  }
  dataDirMsg.value = ''
}

watch(() => props.settings, init, { immediate: true })

/** 预算输入行：账号用到的单位 + 已设过预算的单位 */
const budgetUnits = computed(() => {
  const set = new Set<string>()
  for (const u of props.units) if (u) set.add(u)
  for (const k of Object.keys(local.daily_budget)) set.add(k)
  return Array.from(set)
})

function budgetOf(unit: string): number | '' {
  const v = local.daily_budget[unit]
  return v === undefined || v === null ? '' : v
}

function setBudget(unit: string, value: string | number): void {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) {
    const next = { ...local.daily_budget }
    delete next[unit]
    local.daily_budget = next
    return
  }
  local.daily_budget = { ...local.daily_budget, [unit]: n }
}

const refreshOptions = computed(() => REFRESH_OPTIONS.map((o) => ({ value: o, label: refreshLabel(o) })))

/** 折算率的人话解释：输入框里是「多少积分算 1 元」，这里反过来说给用户听 */
const creditRateLabel = computed(() => rateText(local.credits_per_cny))
/** 现场算一遍「100 万积分 ≈ ? 元」，让用户填完立刻能核对（按 DeepSeek 高峰价反推时约 9 元） */
const millionCreditsCny = computed(() => {
  if (!hasCreditRate(local.credits_per_cny)) return ''
  const v = creditsToCny(1e6, local.credits_per_cny)
  return v === null ? '' : '100 万积分 ≈ ' + fmtMoney(v)
})

/** 一键恢复默认（按 DeepSeek 高峰价反推的估算基线） */
function resetCreditRate(): void {
  local.credits_per_cny = DEFAULT_CREDITS_PER_CNY
}

function refreshLabel(sec: number): string {
  const m = sec / 60
  return Number.isInteger(m) ? m + ' 分钟' : (sec / 60).toFixed(1) + ' 分钟'
}

async function onSave() {
  const r = await emit('save', {
    refresh_seconds: local.refresh_seconds,
    pause_when_hidden: local.pause_when_hidden,
    default_threshold: local.default_threshold,
    notice_enabled: local.notice_enabled,
    notice_max_per_day: local.notice_max_per_day,
    launch_at_login: local.launch_at_login,
    theme: local.theme,
    drop_alert_percent: local.drop_alert_percent,
    fail_alert_count: local.fail_alert_count,
    credits_per_cny: Number.isFinite(local.credits_per_cny) ? Math.max(0, local.credits_per_cny) : 0,
    daily_budget: JSON.parse(JSON.stringify(local.daily_budget ?? {}))
  })
  // 按真实结果提示：保存失败不再亮「✓ 已保存」（失败 alert 由 App 层统一给出）
  if (r && r.ok === false) return
  savedFlash.value = true
  if (savedTimer) clearTimeout(savedTimer)
  savedTimer = setTimeout(() => { savedFlash.value = false }, 1800)
}

async function onOpenDir() {
  dataDirMsg.value = '正在打开配置目录…'
  const r = await openDataDir()
  dataDirMsg.value = r.ok ? '已打开配置目录' : '打开失败：' + r.error
}

async function onExport() {
  backupMsg.value = '正在导出…'
  const r = await exportBackup(true)
  backupMsg.value = r.ok && r.data.ok ? '已导出到：' + (r.data.path ?? '') : '导出未完成：' + (r.data?.error ?? r.error ?? '')
}

async function onImport() {
  const sure = await confirm('导入备份会覆盖当前全部账号与设置（原配置会自动另存一份）。确定继续？', { title: '导入备份', danger: true })
  if (!sure) return
  backupMsg.value = '正在导入…'
  const r = await importBackup()
  const msg = r.ok ? r.data.message : '导入失败：' + (r.error ?? '')
  backupMsg.value = msg
  if (r.ok && r.data.ok) {
    // 原 window.alert(msg) 改为就近消息区（backupMsg）提示；稍等再整体刷新，让提示可见
    setTimeout(() => { window.location.reload() }, 1500)
  }
}
</script>

<template>
  <section class="settings-pane">
    <div class="pane-head">
      <h2>设置</h2>
      <button class="btn ghost" type="button" @click="onSave">保存设置</button>
    </div>
    <div class="pane-scroll">

      <div class="sec">
        <div class="sec-title">刷新</div>
        <div class="field-inline">
          <span class="f-label">自动刷新间隔</span>
          <SelectMenu v-model="local.refresh_seconds" :options="refreshOptions" />
          <InfoTip text="刷新间隔越短，每日统计与时段分布越精确（5 分钟可定位到小时级），但请求也更频繁。" />
        </div>
        <div class="field-inline">
          <span class="f-label">窗口隐藏时暂停</span>
          <label class="switch">
            <input v-model="local.pause_when_hidden" type="checkbox" />
            <span class="sw-track"><span class="sw-thumb"></span></span>
          </label>
        </div>
      </div>

      <div class="sec">
        <div class="sec-title">
          每日预算与告警
          <InfoTip text="按单位设置每天最多花多少：达到 80% 和 100% 各提醒一次。余额骤降 = 单次刷新内余额跌幅超过设定百分比；接口异常 = 连续查询失败达到设定次数。" />
        </div>
        <div v-if="budgetUnits.length === 0" class="hint">还没有账号，添加账号后这里会出现对应的单位。</div>
        <div v-for="u in budgetUnits" :key="u" class="field-inline">
          <span class="f-label">每日预算 · {{ u }}</span>
          <span class="inline-input">
            <input
              class="input mini"
              type="number"
              min="0"
              step="1"
              :value="budgetOf(u)"
              @input="setBudget(u, ($event.target as HTMLInputElement).value)"
            />
            每天上限（留空 = 不限）
          </span>
        </div>
        <div class="field-inline">
          <span class="f-label">余额骤降告警</span>
          <span class="inline-input">
            单次跌幅超过
            <input v-model.number="local.drop_alert_percent" class="input mini" type="number" min="0" max="100" />
            % 时提醒（0 = 关闭）
          </span>
        </div>
        <div class="field-inline">
          <span class="f-label">接口异常告警</span>
          <span class="inline-input">
            连续失败
            <input v-model.number="local.fail_alert_count" class="input mini" type="number" min="0" max="50" />
            次时提醒（0 = 关闭）
          </span>
        </div>
      </div>

      <div class="sec">
        <div class="sec-title">
          成本折算
          <InfoTip text="账号可能用不同单位记账（积分 / 元）。「平台用量」页要把它们放到同一把尺子上比较，就得有一个折算率。默认值按 DeepSeek flash 高峰价反推（输入缓存命中 0.04 / 未命中 2 / 输出 8 元每百万 Token），只是估算基线，不是平台官方汇率。填 0 = 不折算。" />
        </div>
        <div class="field-inline">
          <span class="f-label">积分折算率</span>
          <span class="inline-input">
            <input
              v-model.number="local.credits_per_cny"
              class="input rate-input"
              type="number"
              min="0"
              step="1000"
              placeholder="0 = 不折算"
            />
            积分 = 1 元
            <button class="btn ghost mini" type="button" @click="resetCreditRate">恢复默认</button>
          </span>
        </div>
        <div class="hint">
          {{ creditRateLabel }}<template v-if="millionCreditsCny">（{{ millionCreditsCny }}）</template>。
          默认 111111 是按 DeepSeek flash 高峰价反推的估算：某窗口 8.1M 输入（缓存命中 7M）+ 160.6K 输出 ≈ 3.76 元，
          折算约 0.45 元/百万 Token，取 ~0.9 元/百万 Token 作保守上限 → 100 万积分 ≈ 9 元。
          这个数只影响「折合人民币（估算）」列与对比条排序，<strong>不会改动任何原始数据</strong>。
        </div>
      </div>

      <div class="sec">
        <div class="sec-title">提醒</div>
        <div class="field-inline">
          <span class="f-label">低余额默认阈值</span>
          <span class="inline-input">
            低于
            <input v-model.number="local.default_threshold" class="input mini" type="number" />
            时提醒
            <InfoTip text="每个账号还能单独设阈值。每日使用状况页会按近 7 天日均消耗给出建议值（约 3 天用量）。" />
          </span>
        </div>
        <div class="field-inline">
          <span class="f-label">系统通知</span>
          <label class="switch">
            <input v-model="local.notice_enabled" type="checkbox" />
            <span class="sw-track"><span class="sw-thumb"></span></span>
          </label>
        </div>
        <div class="field-inline">
          <span class="f-label">每日最多提醒</span>
          <span class="inline-input">
            <input v-model.number="local.notice_max_per_day" class="input mini" type="number" />
            次 / 账号
          </span>
        </div>
      </div>


      <div class="sec">
        <div class="sec-title">显示</div>
        <div class="field-inline">
          <span class="f-label">主题</span>
          <div class="seg">
            <button type="button" :class="{ on: local.theme === 'dark' }" @click="pickTheme('dark')">深色</button>
            <button type="button" :class="{ on: local.theme === 'light' }" @click="pickTheme('light')">浅色</button>
            <button type="button" :class="{ on: local.theme === 'system' }" @click="pickTheme('system')">跟随系统</button>
          </div>
          <span class="hint-inline">点一下立即生效并保存：「深色 / 浅色」就是「主题外观」里的经典深色 / 经典浅色；「跟随系统」按 Windows 深浅色自动在这两套之间切换。</span>
        </div>
      </div>

      <div class="sec">
        <div class="sec-title">系统</div>
        <div class="field-inline">
          <span class="f-label">开机自启</span>
          <label class="switch">
            <input
              type="checkbox"
              :checked="local.launch_at_login"
              :disabled="autoStartBusy"
              @change="onToggleAutoStart"
            />
            <span class="sw-track"><span class="sw-thumb"></span></span>
          </label>
          <span class="hint-inline">点一下立即写入系统启动项，无需再点「保存设置」</span>
        </div>
        <p v-if="autoStartMsg" class="hint err-hint">{{ autoStartMsg }}</p>
        <p
          v-else-if="autoStart"
          class="hint"
          :class="{ 'err-hint': local.launch_at_login && autoStart.packaged && !autoStart.registered, 'ok-hint': autoStart.registered && !autoStart.disabledBySystem }"
        >
          {{ autoStart.message }}
        </p>
      </div>

      <div class="sec">
        <div class="sec-title">数据</div>
        <div class="field-inline">
          <span class="f-label">配置文件</span>
          <button class="btn ghost" type="button" @click="onOpenDir">打开所在文件夹</button>
        </div>
        <div class="field-inline">
          <span class="f-label">备份与恢复</span>
          <button class="btn ghost" type="button" @click="onExport">导出备份</button>
          <button class="btn ghost" type="button" @click="onImport">导入备份</button>
          <InfoTip text="导出会把配置与历史一并打包成 JSON（密钥仍是本机加密后的密文）。换电脑导入后，账号与设置会恢复，但密钥需要用新机器的系统账号重新填写。" />
        </div>
        <div v-if="backupMsg" class="hint">{{ backupMsg }}</div>
        <div v-if="dataDirMsg" class="hint">{{ dataDirMsg }}</div>
        <div class="field-inline">
          <span class="f-label">密钥加密</span>
          <span class="inline-input">
            {{
              appInfo?.secure
                ? '已启用（safeStorage 本机加密）'
                : '当前环境不支持加密，密钥以明文保存'
            }}
          </span>
        </div>
      </div>

      <div class="sec">
        <div class="sec-title">关于</div>
        <div class="field-inline">
          <span class="f-label">版本</span>
          <span class="inline-input num">{{ appInfo?.version ?? '—' }}</span>
        </div>
        <p class="declare">
          本程序所有请求直连你填的平台地址，不做任何中转上报。密钥仅保存在你自己的电脑上。
        </p>
      </div>

      <p v-if="savedFlash" class="saved-ok">✓ 已保存</p>
    </div>
  </section>
</template>

<style scoped>
.settings-pane { display: flex; flex-direction: column; height: 100%; }
.pane-head { flex: none; display: flex; align-items: center; justify-content: space-between; padding: 20px var(--pad-lg) 6px; }
.pane-head h2 { font-size: 19px; font-weight: 700; color: var(--tx-strong); margin: 0; }
.pane-scroll { flex: 1; overflow-y: auto; padding: 12px var(--pad-lg) 40px; max-width: 820px; margin: 0 auto; width: 100%; }
.sec { margin-bottom: 16px; padding-bottom: 14px; border-bottom: none;
 box-shadow: inset 0 -1px 0 var(--line-soft); }
.sec:last-child { border-bottom: none; margin-bottom: 8px; }
.sec-title { display: flex; align-items: center; gap: 8px; font-size: var(--fs-sub); color: var(--tx); font-weight: 600; margin-bottom: 10px; }
.sec-title::before { content: ''; width: 3px; height: 12px; border-radius: 2px; background: var(--acc-grad); }
.field-inline { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
.f-label { font-size: var(--fs-sub); color: var(--tx2); font-weight: 500; min-width: 128px; flex: none; }
.inline-input { font-size: var(--fs-sub); color: var(--tx2); display: inline-flex; align-items: center; gap: 6px; }
.input.mini { width: 120px; }
/* 积分折算率：数值有 6 位以上，输入框要宽一点 */
.rate-input { width: 150px; }
.hint { font-size: var(--fs-foot); color: var(--tx3); margin: 4px 0 8px; line-height: 1.7; }
.hint-inline { font-size: var(--fs-foot); color: var(--tx3); line-height: 1.7; }
.hint.err-hint { color: var(--warn); }
.hint.ok-hint { color: var(--ok); }
/* .seg 基础样式在 global.css；这里只留差异（按钮更宽） */
.seg button { padding: 5px 14px; }
.declare { font-size: var(--fs-sub); color: var(--tx3); line-height: 1.7; border-left: 2px solid var(--line-strong); padding-left: 12px; margin-top: 4px; }
.saved-ok { color: var(--ok); font-size: var(--fs-sub); font-weight: 600; margin-top: 4px; }
</style>
