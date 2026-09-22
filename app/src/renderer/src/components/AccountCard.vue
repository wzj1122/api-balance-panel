<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { AccountType, BalanceRow, DailyAccount, Snapshot } from '@shared/types'
import { PROVIDER_META } from '@shared/constants'
import { fmtAgo, fmtNumber, pctLevel } from '@shared/format'
import { listSnapshots } from '@renderer/api/ipc'
import TrendChart from './TrendChart.vue'

const props = defineProps<{
  row: BalanceRow
  /** 该账号是否正在刷新（禁用单卡刷新按钮） */
  refreshing?: boolean
  /** 每日统计同源的账号数据：余额耗尽预估 + 累计总额（进度条分母） */
  forecast?: DailyAccount | null
  /** 该账号是否正在静默续期 */
  renewing?: boolean
  /** 该账号是否正在重新登录（卡片按钮） */
  relogging?: boolean
}>()

const emit = defineEmits<{
  (e: 'refresh', id: string): void
  (e: 'edit', id: string): void
  (e: 'remove', id: string): void
  /** 静默续期登录（用保存的会话换新凭据） */
  (e: 'renew', id: string): void
  /** 一键重新登录（需要输密码那种，卡片上直接开登录窗口） */
  (e: 'relogin', id: string): void
  /** 跳到「数据校正」页（带该账号） */
  (e: 'correct', id: string): void
}>()

/** 卡片备注里带「已手动校正」时给个小标记（点了直接去校正页） */
const adjusted = computed(() => /已手动校正/.test(props.row.note ?? ''))

/**
 * 登录型平台：会话会过期、需要重新登录。
 * 除了 SenseNova / Xiaomi MIMO，siliconflow / MiniMax / bigmodel 也是"登录抓凭据"型，
 * 所以卡片上都给「重新登录」按钮（用户 2026-09-22 要求：基本上所有模型都可能要重登）。
 */
const LOGIN_TYPES = new Set<AccountType>(['sensenova', 'mimo', 'mimo-plan', 'siliconflow', 'minimax', 'zhipu'])
const canRelogin = computed(() => LOGIN_TYPES.has(props.row.type))

/** 支持"静默续期"的平台（只有小米 MiMo 系有会话保活链路；商汤会话 3 小时绝对到期，2026-09-22 起停用续期） */
const RENEWABLE = new Set<AccountType>(['mimo', 'mimo-plan'])
const canRenew = computed(() => RENEWABLE.has(props.row.type))

/** 续期按钮状态：正在续期 / 提示文案 */
const renewing = computed(() => props.renewing === true)
const renewTitle = computed(() =>
  renewing.value
    ? '正在静默续期…'
    : '续期登录（用已有会话自动换新凭据，不需要重新输密码）'
)

/** 重新登录按钮状态 */
const relogging = computed(() => props.relogging === true)
const reloginTitle = computed(() =>
  relogging.value
    ? '正在等待你在登录窗口里完成登录…'
    : '重新登录（打开这个平台的登录页，登录完成后自动保存并刷新）'
)

/** 平台品牌色映射（驱动卡片点缀色） */
const PLATFORM_COLORS: Record<AccountType, string> = {
  deepseek: 'var(--p-deepseek)',
  siliconflow: 'var(--p-siliconflow)',
  newapi: 'var(--p-newapi)',
  custom: 'var(--p-custom)',
  mimo: 'var(--p-mimo)',
  'mimo-plan': 'var(--p-mimo-plan)',
  minimax: 'var(--p-minimax)',
  zhipu: 'var(--p-zhipu)',
  aliyun: 'var(--p-aliyun)',
  sensenova: 'var(--p-sensenova)'
}

/** 平台显示名，如「DeepSeek」（PROVIDER_META[t].label） */
const typeLabel = computed(() => (PROVIDER_META[props.row.type]?.label ?? props.row.type))

/** 进度条分母：套餐类用 API 给的总额；其余用「累计总额」（余额每上升一次累加，充值后自动新一轮） */
const denominator = computed<number | null>(() => {
  const r = props.row
  const apiTotal = r.total
  if (apiTotal !== null && apiTotal !== undefined && Number.isFinite(apiTotal) && apiTotal > 0) return apiTotal
  const f = props.forecast
  if (f && f.creditTotal !== null && f.creditTotal !== undefined && f.creditTotal > 0) return f.creditTotal
  return null
})

/** 进度条：余额占总额的比例（余额越少条越短） */
const meta = computed(() => {
  const r = props.row
  if (!r.ok) return null
  const den = denominator.value
  if (den === null || r.remaining === null || r.remaining === undefined) return { pct: null, level: 'ok', pctText: null }
  const ratio = Math.max(0, Math.min(1, r.remaining / den))
  return { pct: ratio * 100, level: pctLevel(ratio * 100), pctText: Math.round(ratio * 100) }
})

const forecast = computed(() => {
  const f = props.forecast
  if (!f || f.forecastDaysLeft === null || f.forecastDaysLeft === undefined || !f.estEmptyTs) return null
  if (f.forecastDaysLeft > 365) return null
  const d = new Date(f.estEmptyTs)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const daysLeft = Math.max(1, Math.ceil(f.forecastDaysLeft))
  const cls = f.forecastDaysLeft < 3 ? 'danger' : f.forecastDaysLeft < 7 ? 'warn' : 'ok'
  return { text: '预计 ' + mm + '-' + dd + ' 耗尽 · 约剩 ' + daysLeft + ' 天', cls }
})

const agoText = computed(() => {
  const r = props.row
  const base = fmtAgo(r.ts)
  if (!base || base === '-') return ''
  return r.cached ? base + ' · 缓存' : base
})

/**
 * 趋势弹窗（2026-09-22 改版，用户要求）：
 * 趋势图不再内嵌在卡片里（卡片 overflow:hidden 会裁剪），改为点「趋势」按钮弹出的
 * 固定 420px 悬浮窗（可比卡片宽），点弹窗外部 / Esc 关闭。
 * 弹窗内容 = 模型（账号名 + 平台）+ 剩余余额 + 时间跨度选择（1 小时 / 6 小时 / 24 小时）+ 趋势图。
 */
const trendOpen = ref(false)
const trendBtnEl = ref<HTMLElement | null>(null)
const popupEl = ref<HTMLElement | null>(null)
const popPos = ref({ left: 0, top: 0 })
/** 固定时间轴选项（小时）：用户指定只保留这三个刻度 */
const SPANS = [1, 6, 24] as const
const spanH = ref<(typeof SPANS)[number]>(1)
/** 弹窗打开/切换跨度时的轴右端时间戳（轴固定到“现在”，不随数据末点漂移） */
const popEndTs = ref(Date.now())
const spanMs = computed(() => spanH.value * 3600000)
/** 已拉取的快照（只保留 ok=true 的），重复打开不重拉 */
const trend = ref<Snapshot[]>([])
const trendLoading = ref(false)

const trendPoints = computed(() => {
  const raw = trend.value.filter((s) => s && s.remaining !== null && s.remaining !== undefined && Number.isFinite(s.remaining))
  // 同一时间戳的重复快照去掉
  const seen = new Set<number>()
  const uniq = raw.filter((s) => (seen.has(s.ts) ? false : (seen.add(s.ts), true)))
  if (uniq.length === 0) return []
  // 只画「当前这一轮」：从最近一次余额上升（充值）之后开始，避免充值的跳变让人误读
  let start = 0
  for (let k = 1; k < uniq.length; k++) {
    const prev = uniq[k - 1].remaining as number
    const cur = uniq[k].remaining as number
    if (cur > prev + 1e-9) start = k
  }
  let use = uniq.slice(start)
  if (use.length < 2) use = uniq.slice(-30)
  // 点太多就等间隔抽稀，保证曲线平滑（时间窗内的过滤交给 TrendChart 按固定轴裁剪）
  if (use.length > 200) {
    const step = Math.ceil(use.length / 200)
    use = use.filter((_, k) => k % step === 0 || k === use.length - 1)
  }
  return use.map((s) => ({ ts: s.ts, remaining: s.remaining as number }))
})

/**
 * 打开时按最近使用情况自动选轴（用户指定规则）：
 * - 当日没有使用 → 24 小时
 * - 近三小时没有使用（但当日用过）→ 6 小时
 * - 近三小时内有使用 → 1 小时
 * “使用”的判定：快照序列里最近一次余额下降（或 used 上升）的时间。
 */
function autoSpan(): (typeof SPANS)[number] {
  const list = trend.value
  let last = 0
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1]
    const cur = list[i]
    const usedUp = typeof cur.used === 'number' && typeof prev.used === 'number' && cur.used > prev.used
    const remDown =
      typeof cur.remaining === 'number' && typeof prev.remaining === 'number' && cur.remaining < prev.remaining
    if (usedUp || remDown) last = Math.max(last, cur.ts)
  }
  if (!last) return 24
  const day0 = new Date()
  day0.setHours(0, 0, 0, 0)
  if (last < day0.getTime()) return 24 // 当日没有使用
  if (last < Date.now() - 3 * 3600000) return 6 // 近三小时没有使用
  return 1 // 有使用
}

function setSpan(h: (typeof SPANS)[number]): void {
  spanH.value = h
  popEndTs.value = Date.now()
}

async function toggleTrend(ev: MouseEvent): Promise<void> {
  if (trendOpen.value) {
    closeTrend()
    return
  }
  const btn = (ev.currentTarget as HTMLElement | null) ?? null
  trendBtnEl.value = btn
  const rect = btn?.getBoundingClientRect()
  const POP_W = 420
  // 悬浮窗右缘贴按钮右缘，越界向左收；先给按钮下方位置，渲染后再防溢出
  const left = Math.max(12, Math.min((rect?.right ?? window.innerWidth) - POP_W, window.innerWidth - POP_W - 12))
  popPos.value = { left, top: rect ? rect.bottom + 8 : 80 }
  popEndTs.value = Date.now()
  trendOpen.value = true
  if (trend.value.length === 0 && !trendLoading.value) {
    trendLoading.value = true
    try {
      const r = await listSnapshots(props.row.accountId)
      if (r.ok) trend.value = r.data.filter((s) => s.ok)
    } finally {
      trendLoading.value = false
    }
  }
  // 数据到位后按规则自动选轴（用户手动切换过也遵循——只在打开那一刻自动）
  spanH.value = autoSpan()
  await nextTick()
  // 底部放不下 → 翻到按钮上方
  const h = popupEl.value?.offsetHeight ?? 0
  if (rect && h > 0 && popPos.value.top + h > window.innerHeight - 12) {
    popPos.value = { ...popPos.value, top: Math.max(12, rect.top - h - 8) }
  }
  // 横向再夹一次（渲染后实际宽度恒为 420，但视口可能很窄）
  popPos.value = { ...popPos.value, left: Math.max(12, Math.min(popPos.value.left, window.innerWidth - POP_W - 12)) }
}

function closeTrend(): void {
  trendOpen.value = false
}

function onDocDown(ev: MouseEvent): void {
  const t = ev.target as Node | null
  if (!t) return
  // 点在弹窗内 / 趋势按钮上 → 不关（按钮自己的 click 负责开/关切换）
  if (popupEl.value?.contains(t)) return
  if (trendBtnEl.value?.contains(t)) return
  closeTrend()
}

function onEsc(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') closeTrend()
}

watch(trendOpen, (open) => {
  if (open) {
    document.addEventListener('mousedown', onDocDown, true)
    window.addEventListener('keydown', onEsc)
  } else {
    document.removeEventListener('mousedown', onDocDown, true)
    window.removeEventListener('keydown', onEsc)
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocDown, true)
  window.removeEventListener('keydown', onEsc)
})
</script>

<template>
  <!-- 已停用：灰色卡片，不查询 -->
  <article v-if="!row.enabled" class="card disabled" :style="{ '--card-acc': PLATFORM_COLORS[row.type] }">
    <header class="head">
      <span class="dot-p" :style="{ background: 'var(--card-acc)' }"></span>
      <span class="name">{{ row.name }}</span>
      <span class="tag">{{ typeLabel }}</span>
      <span class="ops">
        <button class="icon-btn" type="button" title="编辑（重新启用）" @click="emit('edit', row.accountId)">
          <svg class="ico" viewBox="0 0 16 16" width="14" height="14">
            <path
              fill="currentColor"
              d="M11.7 2.3a1 1 0 0 1 1.4 0l.6.6a1 1 0 0 1 0 1.4l-7.5 7.5-3 1 1-3 7.5-7.5Z"
            />
          </svg>
        </button>
        <button class="icon-btn danger" type="button" title="删除" @click="emit('remove', row.accountId)">
          <svg class="ico" viewBox="0 0 16 16" width="14" height="14">
            <path
              fill="currentColor"
              d="M6 2h4l1 1h3v1.5H2V3h3l1-1Zm-2 4h8l-.6 8.5a1 1 0 0 1-1 .9H5.6a1 1 0 0 1-1-.9L4 6Z"
            />
          </svg>
        </button>
      </span>
    </header>
    <div class="disabled-note">
      <svg class="ico muted" viewBox="0 0 16 16" width="13" height="13">
        <path
          fill="currentColor"
          d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 2a4.5 4.5 0 0 1 3.6 7.2L4.3 4.4A4.5 4.5 0 0 1 8 3.5Zm0 9a4.5 4.5 0 0 1-3.6-7.2l7.3 7.3A4.5 4.5 0 0 1 8 12.5Z"
        />
      </svg>
      已停用 · 不参与查询
    </div>
    <footer class="foot">
      <span class="note">编辑可重新启用</span>
      <span class="time">{{ fmtAgo(row.ts) }}</span>
    </footer>
  </article>

  <!-- 失败态 -->
  <article v-else-if="!row.ok" class="card bad">
    <header class="head">
      <span class="dot-p err"></span>
      <span class="name">{{ row.name }}</span>
      <span class="tag">{{ typeLabel }}</span>
      <span class="ops">
        <button
          class="icon-btn"
          type="button"
          title="重试"
          :disabled="refreshing"
          @click="emit('refresh', row.accountId)"
        >
          <svg class="ico" :class="{ spin: refreshing }" viewBox="0 0 16 16" width="14" height="14">
            <path
              fill="currentColor"
              d="M8 3a5 5 0 1 0 4.6 3H11a3.5 3.5 0 1 1-.9-2.3L9.2 4.4H12V2L9.6 2.2A5 5 0 0 0 8 3Z"
            />
          </svg>
        </button>
        <button class="icon-btn" type="button" title="编辑（修复）" @click="emit('edit', row.accountId)">
          <svg class="ico" viewBox="0 0 16 16" width="14" height="14">
            <path
              fill="currentColor"
              d="M11.7 2.3a1 1 0 0 1 1.4 0l.6.6a1 1 0 0 1 0 1.4l-7.5 7.5-3 1 1-3 7.5-7.5Z"
            />
          </svg>
        </button>
        <button class="icon-btn danger" type="button" title="删除" @click="emit('remove', row.accountId)">
          <svg class="ico" viewBox="0 0 16 16" width="14" height="14">
            <path
              fill="currentColor"
              d="M6 2h4l1 1h3v1.5H2V3h3l1-1Zm-2 4h8l-.6 8.5a1 1 0 0 1-1 .9H5.6a1 1 0 0 1-1-.9L4 6Z"
            />
          </svg>
        </button>
      </span>
    </header>
    <div class="fail-box">
      <span class="badge err">查询失败</span>
      <svg class="ico" viewBox="0 0 16 16" width="18" height="18">
        <path
          fill="currentColor"
          d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm-.75 3.5h1.5v4.5h-1.5V5Zm0 6h1.5v1.5h-1.5V11Z"
        />
      </svg>
      <span class="fail-reason">{{ row.note || '查询失败' }}</span>
    </div>
    <div v-if="row.errorDetail" class="fail-detail">详情：{{ row.errorDetail }}</div>
    <footer class="foot">
      <span class="note"></span>
      <span class="time">{{ fmtAgo(row.ts) }}</span>
    </footer>
  </article>

  <!-- 成功态 -->
  <article v-else class="card" :class="{ low: row.lowBalance }" :style="{ '--card-acc': PLATFORM_COLORS[row.type] }">
    <header class="head">
      <span class="dot-p" :style="{ background: 'var(--card-acc)' }"></span>
      <span class="name">{{ row.name }}</span>
      <span class="tag">{{ typeLabel }}</span>
      <span class="ops">
        <button
          class="icon-btn"
          type="button"
          title="趋势（弹出时间跨度 1 / 6 / 24 小时）"
          :class="{ active: trendOpen }"
          @click="toggleTrend"
        >
          <svg class="ico" viewBox="0 0 16 16" width="14" height="14">
            <polyline
              points="2 12 5 7 9 10 14 4"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <button
          class="icon-btn"
          type="button"
          title="刷新此账号"
          :disabled="refreshing"
          @click="emit('refresh', row.accountId)"
        >
          <svg class="ico" :class="{ spin: refreshing }" viewBox="0 0 16 16" width="14" height="14">
            <path
              fill="currentColor"
              d="M8 3a5 5 0 1 0 4.6 3H11a3.5 3.5 0 1 1-.9-2.3L9.2 4.4H12V2L9.6 2.2A5 5 0 0 0 8 3Z"
            />
          </svg>
        </button>
        <button
          v-if="adjusted"
          class="icon-btn warn-ico"
          type="button"
          title="该账号数据已手动校正，点这里去「数据校正」页查看/撤销"
          @click="emit('correct', row.accountId)"
        >
          <svg class="ico" viewBox="0 0 16 16" width="14" height="14">
            <path
              fill="currentColor"
              d="M8 1.6 15 14H1L8 1.6Zm0 3.9-4.4 7.9h8.8L8 5.5Zm-.8 2.2h1.6v3.4H7.2V7.7Zm0 4.2h1.6v1.6H7.2v-1.6Z"
            />
          </svg>
        </button>
        <button
          v-if="canRenew"
          class="icon-btn"
          type="button"
          :title="renewTitle"
          :disabled="renewing"
          @click="emit('renew', row.accountId)"
        >
          <svg class="ico" :class="{ spin: renewing }" viewBox="0 0 16 16" width="14" height="14">
            <path
              fill="currentColor"
              d="M8 2a6 6 0 0 1 5.7 4.1l.9-.9a.8.8 0 1 1 1.1 1.1l-2.3 2.3a.8.8 0 0 1-1.1 0L10 6.3a.8.8 0 0 1 1.1-1.1l1 1A4.4 4.4 0 0 0 8 3.6 4.4 4.4 0 0 0 3.6 8 .8.8 0 1 1 2 8a6 6 0 0 1 6-6Zm-4.4 7.6 2.3 2.3a.8.8 0 0 1-1.1 1.1l-1-1A4.4 4.4 0 0 0 8 12.4 4.4 4.4 0 0 0 12.4 8a.8.8 0 1 1 1.6 0 6 6 0 0 1-10.4 4.1l-.9.9a.8.8 0 0 1-1.1-1.1l.8-.8Z"
            />
          </svg>
        </button>
        <button
          v-if="canRelogin"
          class="icon-btn"
          :class="{ 'relogin-busy': relogging }"
          type="button"
          :title="reloginTitle"
          :disabled="relogging"
          @click="emit('relogin', row.accountId)"
        >
          <!-- 用"钥匙"图标和旁边那个"刷新箭头"区分开，避免用户点错 -->
          <svg class="ico" :class="{ spin: relogging }" viewBox="0 0 16 16" width="14" height="14">
            <path
              fill="currentColor"
              d="M10.5 1a4.5 4.5 0 0 0-4.35 3.4L1.5 9.05A1 1 0 0 0 1.2 9.7v3.1c0 .44.36.8.8.8h3.1a1 1 0 0 0 .7-.29l1.2-1.2h1.3a.8.8 0 0 0 .8-.8v-1.3l.85-.85A4.5 4.5 0 1 0 10.5 1Zm1.6 3.9a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4Z"
            />
          </svg>
        </button>
        <button class="icon-btn" type="button" title="编辑" @click="emit('edit', row.accountId)">
          <svg class="ico" viewBox="0 0 16 16" width="14" height="14">
            <path
              fill="currentColor"
              d="M11.7 2.3a1 1 0 0 1 1.4 0l.6.6a1 1 0 0 1 0 1.4l-7.5 7.5-3 1 1-3 7.5-7.5Z"
            />
          </svg>
        </button>
        <button class="icon-btn danger" type="button" title="删除" @click="emit('remove', row.accountId)">
          <svg class="ico" viewBox="0 0 16 16" width="14" height="14">
            <path
              fill="currentColor"
              d="M6 2h4l1 1h3v1.5H2V3h3l1-1Zm-2 4h8l-.6 8.5a1 1 0 0 1-1 .9H5.6a1 1 0 0 1-1-.9L4 6Z"
            />
          </svg>
        </button>
      </span>
    </header>

    <div class="balance" :class="{ low: row.lowBalance }">
      <div class="balance-line">
        <span class="amount num">{{ fmtNumber(row.remaining) }}</span>
        <span class="unit">{{ row.unit }}</span>
      </div>
      <span v-if="row.lowBalance" class="badge warn">低余额</span>
    </div>

    <div v-if="meta && meta.pct !== null" class="bar" :title="denominator !== null ? '余额占累计总额的比例；每次充值后自动进入新一轮' : ''">
      <div class="track">
        <div class="fill" :class="meta.level" :style="{ width: meta.pct + '%' }"></div>
      </div>
      <div class="bar-row">
        <span v-if="denominator !== null">余额 {{ fmtNumber(row.remaining) }} / 累计 {{ fmtNumber(denominator) }} {{ row.unit }}</span>
        <span v-else>余额 {{ fmtNumber(row.remaining) }} {{ row.unit }}</span>
        <span v-if="denominator !== null" class="pct" :class="meta.level">{{ meta.pctText }}%</span>
      </div>
    </div>

    <ul v-if="row.items && row.items.length" class="items">
      <li v-for="it in row.items" :key="it.planName" class="item">
        <div class="it-main">
          <span class="it-name">{{ it.planName }}</span>
          <span class="it-val num">
            {{ fmtNumber(it.remaining) }} / {{ fmtNumber(it.total) }} {{ it.unit }}
          </span>
        </div>
        <span v-if="it.note" class="it-note">{{ it.note }}</span>
      </li>
    </ul>

    <p v-if="forecast" class="fcast" :class="forecast.cls">{{ forecast.text }}</p>

    <footer class="foot">
      <span class="note">{{ row.note }}</span>
      <span class="time">{{ agoText }}</span>
    </footer>
  </article>

  <!-- 趋势悬浮窗（Teleport 到 body：卡片 overflow:hidden 会裁剪内嵌内容） -->
  <Teleport to="body">
    <div
      v-if="trendOpen"
      ref="popupEl"
      class="trend-pop"
      :style="{ left: popPos.left + 'px', top: popPos.top + 'px', '--card-acc': PLATFORM_COLORS[row.type] }"
    >
      <div class="tp-head">
        <span class="tp-dot" :style="{ background: 'var(--card-acc)' }"></span>
        <span class="tp-name">{{ row.name }}</span>
        <span class="tp-tag">{{ typeLabel }}</span>
        <span class="tp-bal">
          <span class="tp-bal-label">剩余余额</span>
          <span class="num tp-bal-val">{{ fmtNumber(row.remaining) }} {{ row.unit }}</span>
        </span>
        <button class="tp-close" type="button" title="关闭（Esc）" @click="closeTrend">×</button>
      </div>
      <div class="tp-seg" role="tablist" aria-label="时间跨度">
        <button
          v-for="h in SPANS"
          :key="h"
          type="button"
          :class="{ on: spanH === h }"
          @click="setSpan(h)"
        >{{ h }} 小时</button>
      </div>
      <span v-if="trendLoading" class="trend-loading">趋势加载中…</span>
      <TrendChart v-else :data="trendPoints" :span-ms="spanMs" :end-ts="popEndTs" />
      <div class="tp-foot">打开时按最近使用自动选轴（近三小时有用 → 1 小时；当日有用 → 6 小时；当日没用 → 24 小时）</div>
    </div>
  </Teleport>
</template>

<style scoped>
.card {
  position: relative;
  background: var(--card-grad);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--pad);
  display: flex;
  flex-direction: column;
  min-height: 168px;
  box-shadow: var(--shadow-sm);
  transition: transform 0.16s var(--ease), box-shadow 0.16s var(--ease),
    border-color 0.16s ease, opacity 0.16s ease;
  overflow: hidden;
}

.card::before {
  content: '';
  position: absolute;
  inset: 0 0 auto 0;
  height: 2px;
  background: var(--card-acc);
  opacity: 0.75;
  transition: opacity 0.16s ease;
}

.card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow);
  border-color: var(--line-strong);
}

.card:hover::before {
  opacity: 1;
}

.card.low {
  border-color: rgba(251, 191, 36, 0.42);
}

.card.low::before {
  background: var(--warn);
}

.card.bad {
  background: var(--err-bg);
  border-color: rgba(248, 113, 113, 0.4);
}

.card.bad::before {
  background: var(--err);
}

.card.disabled {
  background: var(--panel2);
  border-style: dashed;
  border-color: var(--line);
  opacity: 0.62;
  min-height: 120px;
}

.card.disabled::before {
  display: none;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  min-width: 0;
}

.dot-p {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--card-acc) 22%, transparent);
}

.dot-p.err {
  background: var(--err);
  box-shadow: 0 0 0 3px var(--err-soft);
}

.name {
  font-size: var(--fs-name);
  font-weight: 600;
  color: var(--tx);
  flex: 1 1 auto;
  min-width: 0;
  /* 名称尽量完整显示：允许折行，最多两行（超出省略） */
  white-space: normal;
  word-break: break-all;
  line-height: 1.35;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.tag {
  color: var(--tx2);
  font-size: var(--fs-foot);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 2px 9px;
  white-space: nowrap;
  flex: none;
}

.badge {
  margin-left: 6px;
  font-size: var(--fs-foot);
  border-radius: 999px;
  padding: 2px 9px;
  font-weight: 600;
  flex: none;
}

.badge.warn {
  color: var(--warn);
  background: var(--warn-soft);
  border: 1px solid var(--line-strong);
}

.badge.err {
  color: var(--err);
  background: var(--err-soft);
  border: 1px solid var(--line-strong);
}

.ops {
  margin-left: auto;
  display: flex;
  gap: 2px;
  flex: none;
}

.icon-btn {
  background: transparent;
  border: none;
  color: var(--tx3);
  cursor: pointer;
  padding: 5px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.14s ease, color 0.14s ease;
}

/* 正在「重新登录」时给个视觉提示（等用户在登录窗口里操作，可能要好一会儿） */
.icon-btn.relogin-busy {
  color: var(--acc);
  background: var(--acc-soft);
}

.icon-btn:hover:not(:disabled) {
  color: var(--card-acc, var(--acc));
  background: var(--panel2);
}

.icon-btn.danger:hover:not(:disabled) {
  color: var(--err);
  background: var(--err-soft);
}

.icon-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.icon-btn.active {
  color: var(--card-acc, var(--acc));
  background: var(--acc-soft);
}

/* 已手动校正的提示按钮：用警示色，点它去「数据校正」页 */
.icon-btn.warn-ico {
  color: var(--warn);
}

.icon-btn.warn-ico:hover:not(:disabled) {
  color: var(--warn);
  background: var(--warn-soft);
}

.balance {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  margin: 2px 0 4px;
}

.balance-line {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.balance .badge,
.fail-box .badge {
  margin-left: 0;
}

.amount {
  font-size: var(--fs-big);
  font-weight: 750;
  line-height: 1.15;
  color: var(--tx-strong);
}

.balance.low .amount {
  color: var(--warn);
}

.unit {
  font-size: 13px;
  color: var(--tx2);
  font-weight: 500;
}

.bar {
  margin: 8px 0 4px;
}

.bar-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--fs-foot);
  color: var(--tx3);
}

.pct {
  font-weight: 600;
}

.pct.danger {
  color: var(--err);
}

.pct.warn {
  color: var(--warn);
}

.pct.ok {
  color: var(--ok);
}

.items {
  list-style: none;
  margin: 10px 0 2px;
  border-top: 1px solid var(--line-soft);
  padding-top: 8px;
}

.item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: var(--fs-sub);
  color: var(--tx2);
  margin: 5px 0;
}

.it-main {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: baseline;
}

.it-note {
  font-size: var(--fs-foot);
  color: var(--tx3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.it-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.it-val {
  flex: none;
}

.fcast {
  margin: 12px 0 0;
  align-self: flex-start;
  font-size: var(--fs-foot);
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--line-soft);
}

.fcast.ok {
  color: var(--ok);
  background: var(--ok-soft);
}

.fcast.warn {
  color: var(--warn);
  background: var(--warn-soft);
}

.fcast.danger {
  color: var(--err);
  background: var(--err-soft);
}

.foot {
  margin-top: auto;
  padding-top: 12px;
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: var(--fs-foot);
  color: var(--tx3);
}

.note {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.time {
  flex: none;
}

.fail-box {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--err);
  padding: 6px 4px;
  text-align: center;
}

.fail-reason {
  font-size: 14px;
  font-weight: 500;
  color: var(--err);
  max-width: 90%;
}

.fail-detail {
  font-size: var(--fs-foot);
  color: var(--tx3);
  text-align: center;
  padding: 0 6px;
  word-break: break-all;
}

.disabled-note {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--tx2);
  font-size: var(--fs-sub);
  padding: 8px 2px;
}

.ico.muted {
  opacity: 0.7;
}

.trend-loading {
  font-size: var(--fs-sub);
  color: var(--tx3);
  display: block;
  padding: 10px 0;
  text-align: center;
}

/* ---- 趋势悬浮窗（fixed 定位、固定 420px 宽，可比卡片宽） ---- */
.trend-pop {
  position: fixed;
  z-index: 860;
  width: 420px;
  box-sizing: border-box;
  padding: 12px 14px 10px;
  background: var(--card-grad, var(--panel));
  border: 1px solid var(--line-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tp-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.tp-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}

.tp-name {
  font-weight: 650;
  font-size: var(--fs-sub);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 140px;
}

.tp-tag {
  font-size: var(--fs-foot);
  color: var(--card-acc);
  background: var(--acc-soft);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 1px 8px;
  flex: none;
}

.tp-bal {
  margin-left: auto;
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex: none;
}

.tp-bal-label {
  font-size: var(--fs-foot);
  color: var(--tx3);
}

.tp-bal-val {
  font-weight: 700;
  font-size: var(--fs-sub);
}

.tp-close {
  flex: none;
  margin-left: 6px;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--tx3);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}

.tp-close:hover {
  background: var(--panel2);
  color: var(--tx);
}

.tp-seg {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  background: var(--panel2);
  border: 1px solid var(--line);
  border-radius: 9px;
  align-self: flex-start;
}

.tp-seg button {
  border: none;
  background: transparent;
  color: var(--tx2);
  font-size: var(--fs-foot);
  padding: 3px 10px;
  border-radius: 7px;
  cursor: pointer;
}

.tp-seg button.on {
  background: var(--card-acc);
  color: #fff;
  font-weight: 600;
}

.tp-seg button:not(.on):hover {
  color: var(--tx);
}

.tp-foot {
  font-size: var(--fs-foot);
  color: var(--tx3);
  line-height: 1.5;
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
