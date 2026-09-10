<script setup lang="ts">
import { computed } from 'vue'
import type { DailyUsageReport } from '@shared/types'
import { fmtNumber } from '@shared/format'

const props = defineProps<{ report: DailyUsageReport }>()
const emit = defineEmits<{ (e: 'select-day', ts: number): void }>()

/** 主单位：近 7 天合计最大的单位（日历颜色/数值基准） */
const majorUnit = computed(() => {
  const u = props.report.unitTotals
  if (u.length === 0) return ''
  return [...u].sort((a, b) => (b.total7 ?? -1) - (a.total7 ?? -1))[0].unit
})

const majorTotals = computed(() => props.report.unitTotals.find((u) => u.unit === majorUnit.value) ?? null)

/** 主单位每日最大（颜色归一化） */
const maxVal = computed(() => {
  const ut = majorTotals.value
  if (!ut) return 0
  return Math.max(0, ...ut.days.filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v)))
})

function level(v: number | null): number {
  if (v === null || v === undefined || !Number.isFinite(v)) return 0
  if (v <= 0) return 0
  const max = maxVal.value
  if (max <= 0) return 1
  const ratio = v / max
  if (ratio >= 0.6) return 3
  if (ratio >= 0.25) return 2
  return 1
}

function trimZeros(s: string): string {
  return s.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.$/, '')
}

/** 日历格子里的小字数值（短格式） */
function shortNum(v: number): string {
  if (!Number.isFinite(v)) return ''
  if (v >= 1000) return String(Math.round(v))
  if (v >= 100) return String(Math.round(v))
  if (v >= 10) return trimZeros(v.toFixed(1))
  if (v >= 1) return trimZeros(v.toFixed(2))
  if (v === 0) return '0'
  return v.toFixed(3).replace(/\.?0+$/, '')
}

interface CalCell { ts: number; inRange: boolean; val: number | null; day: number; recharge: boolean; gap: number | null }

/** 日历格子的类名：blank（无数据）/ lvl-1..3（颜色深浅） */
function cellClass(c: CalCell): string {
  const parts = ['cal-cell']
  if (!c.inRange) parts.push('blank')
  else parts.push('lvl-' + level(c.val))
  return parts.join(' ')
}
interface CalMonth {
  key: string
  title: string
  lead: number
  cells: CalCell[]
  total: number | null
  peakDay: string | null
  peakVal: number | null
  peakAccount: { name: string; sum: number } | null
}

const monthBlocks = computed<CalMonth[]>(() => {
  const r = props.report
  if (!r || r.days.length === 0) return []
  const ut = majorTotals.value
  const tsIndex = new Map<number, number>()
  r.days.forEach((d, i) => tsIndex.set(d.ts, i))
  const seen = new Set<string>()
  const months: CalMonth[] = []
  for (const d of r.days) {
    const dt = new Date(d.ts)
    const key = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0')
    if (seen.has(key)) continue
    seen.add(key)
    const first = new Date(dt.getFullYear(), dt.getMonth(), 1)
    const lead = first.getDay() === 0 ? 6 : first.getDay() - 1
    const daysInMonth = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate()
    const cells: CalCell[] = []
    for (let day = 1; day <= daysInMonth; day++) {
      const ts = new Date(dt.getFullYear(), dt.getMonth(), day).getTime()
      const idx = tsIndex.get(ts)
      const val = idx !== undefined && ut ? ut.days[idx] : null
      const gap = idx !== undefined && ut ? (ut.gapDays?.[idx] ?? null) : null
      const recharge =
        idx !== undefined && r.accounts.some((a) => a.rechargeFlags && a.rechargeFlags[idx] === true)
      cells.push({ ts, inRange: idx !== undefined, val, day, recharge, gap })
    }
    const valid = cells.filter((c) => c.val !== null && c.val !== undefined && Number.isFinite(c.val))
    const total = valid.length ? valid.reduce((a, c) => a + (c.val as number), 0) : null
    let peak: CalCell | null = null
    for (const c of valid) if (!peak || (c.val as number) > (peak.val as number)) peak = c
    let peakAcc: { name: string; sum: number } | null = null
    const unit = majorUnit.value
    for (const a of r.accounts) {
      if (!a.unit || a.unit !== unit) continue
      let sum = 0
      let has = false
      for (const c of valid) {
        const idx = tsIndex.get(c.ts as number)
        if (idx !== undefined) {
          const v = a.days[idx]
          if (v !== null && v !== undefined) { sum += v; has = true }
        }
      }
      if (has && (!peakAcc || sum > peakAcc.sum)) peakAcc = { name: a.name, sum }
    }
    months.push({
      key,
      title: dt.getMonth() + 1 + ' 月',
      lead,
      cells,
      total,
      peakDay: peak ? String(peak.day).padStart(2, '0') : null,
      peakVal: peak ? (peak.val as number) : null,
      peakAccount: peakAcc
    })
  }
  return months
})
</script>

<template>
  <div class="cal-wrap">
    <div v-for="m in monthBlocks" :key="m.key" class="cal-card">
      <div class="cal-head">
        <span class="cal-title">{{ m.title }}</span>
        <span v-if="m.total !== null" class="cal-meta">每月消耗合计 <b class="num">{{ fmtNumber(m.total) }} {{ majorUnit }}</b></span>
        <span v-if="m.peakVal !== null" class="cal-meta">消耗最多 <b class="num">{{ m.peakDay }} 日 · {{ fmtNumber(m.peakVal) }}</b></span>
        <span v-if="m.peakAccount" class="cal-meta">最多账号 <b>{{ m.peakAccount.name }}</b> <span class="num">{{ fmtNumber(m.peakAccount.sum) }} {{ majorUnit }}</span></span>
      </div>
      <div class="cal-week">
        <span v-for="w in ['一', '二', '三', '四', '五', '六', '日']" :key="w" class="cal-w">{{ w }}</span>
      </div>
      <div class="cal-grid">
        <span v-for="i in m.lead" :key="'b' + i" class="cal-cell blank"></span>
        <button
          v-for="c in m.cells"
          :key="c.ts"
          class="cal-cell"
          :class="cellClass(c)"
          :disabled="!c.inRange || (c.val === null && !c.gap)"
          type="button"
          :title="c.gap ? '停机期间消耗 ' + shortNum(c.gap) + ' ' + majorUnit + '（软件未运行，不计入当天）' : ''"
          @click="emit('select-day', c.ts)"
        >
          <span class="cal-day">{{ c.day }}<span v-if="c.recharge" class="cal-flag" title="疑似充值">⚡</span><span v-if="c.gap" class="cal-flag gap" title="含停机期间消耗">⏸</span></span>
          <span v-if="c.val !== null && c.inRange" class="cal-val">{{ shortNum(c.val) }}</span>
          <span v-else-if="c.gap" class="cal-val gap-val">⏸ {{ shortNum(c.gap) }}</span>
        </button>
      </div>
    </div>
    <p class="cal-note">格子颜色越深表示当天消耗越多（按 {{ majorUnit || '主单位' }} 归一化）；点击有数据的天查看当日明细。余额型账号按「剩余变化」估算，充值会掩盖消耗。<br />带 <b class="gap-mark">⏸</b> 标记的日子表示检测到<strong>停机期间消耗</strong>（上次关闭软件到本次打开之间的余额下降）：这段消耗无法按天归属，因此不画进颜色深浅、也不计入日均与耗尽预估。</p>
  </div>
</template>

<style scoped>
.cal-wrap { margin: 10px 0 6px; }
.cal-card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; margin-bottom: 14px; box-shadow: var(--shadow-sm); }
.cal-head { display: flex; flex-wrap: wrap; gap: 6px 18px; align-items: baseline; margin-bottom: 12px; }
.cal-title { font-size: 15px; font-weight: 700; color: var(--tx-strong); }
.cal-meta { font-size: var(--fs-foot); color: var(--tx3); }
.cal-meta b { color: var(--tx); font-weight: 600; }
.cal-meta .num, .cal-head .num { font-variant-numeric: tabular-nums; }
.cal-week { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; margin-bottom: 6px; }
.cal-w { text-align: center; font-size: 11px; color: var(--tx3); }
.cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; }
.cal-cell { position: relative; min-height: 52px; border-radius: 10px; border: 1px solid var(--line); background: var(--card); color: var(--tx2); font-size: 12px; display: flex; flex-direction: column; align-items: center; padding: 5px 2px 3px; gap: 2px; cursor: pointer; transition: transform var(--dur) ease, border-color var(--dur) ease; }
.cal-cell.blank { visibility: hidden; border: none; }
.cal-cell:not(:disabled):hover { border-color: var(--acc); transform: translateY(-1px); }
.cal-cell:disabled { cursor: default; }
.cal-cell.lvl-1 { background: rgba(79, 140, 255, 0.16); border-color: rgba(79, 140, 255, 0.25); }
.cal-cell.lvl-2 { background: rgba(79, 140, 255, 0.4); border-color: rgba(79, 140, 255, 0.45); color: #fff; }
.cal-cell.lvl-3 { background: rgba(79, 140, 255, 0.72); border-color: rgba(79, 140, 255, 0.8); color: #fff; }
.cal-cell.lvl-2 .cal-val, .cal-cell.lvl-3 .cal-val { opacity: 0.92; }
.cal-day { font-weight: 600; font-size: 12.5px; }
.cal-val { font-size: 10.5px; font-variant-numeric: tabular-nums; opacity: 0.85; }
.cal-flag { font-size: 10px; margin-left: 2px; }
/* 停机期间（软件未运行）消耗标记 */
.cal-flag.gap { color: var(--warn); }
.cal-val.gap-val { color: var(--warn); font-weight: 600; opacity: 1; }
.cal-cell.lvl-2 .cal-val.gap-val, .cal-cell.lvl-3 .cal-val.gap-val { color: #ffe3ad; }
.gap-mark { color: var(--warn); }
.cal-note { font-size: var(--fs-foot); color: var(--tx3); margin-top: 8px; line-height: 1.7; }
</style>