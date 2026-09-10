<script setup lang="ts">
import { computed } from 'vue'
import { fmtNumber } from '@shared/format'
import InfoTip from './InfoTip.vue'

const props = defineProps<{
  /** 单位 → 每日预算（空对象 = 未设置） */
  budgets: Record<string, number>
  /** 每个单位：今日已消耗 + 当前余额合计 */
  units: { unit: string; today: number | null; remaining: number | null }[]
}>()

interface Row {
  unit: string
  budget: number
  today: number
  ratio: number
  remainBudget: number
  daysLeft: number | null
  over: boolean
  warn: boolean
}

const rows = computed<Row[]>(() => {
  const out: Row[] = []
  for (const u of props.units) {
    const budget = props.budgets[u.unit]
    if (!budget || budget <= 0) continue
    const today = u.today ?? 0
    const ratio = today / budget
    const daysLeft = u.remaining !== null && u.remaining !== undefined && budget > 0 ? u.remaining / budget : null
    out.push({
      unit: u.unit,
      budget,
      today,
      ratio,
      remainBudget: Math.max(0, budget - today),
      daysLeft,
      over: ratio >= 1,
      warn: ratio >= 0.8 && ratio < 1
    })
  }
  return out
})

const hasBudget = computed(() => Object.keys(props.budgets ?? {}).length > 0)
function barPct(r: Row): number {
  return Math.min(100, Math.round(r.ratio * 100))
}
</script>

<template>
  <div v-if="hasBudget && rows.length > 0" class="budget">
    <div class="budget-head">
      <span class="budget-title">今日预算</span>
      <InfoTip text="在「设置 → 预算与提醒」里按单位设置每天最多花多少。进度条显示今日已消耗占预算的比例，达到 80% 和 100% 时会各提醒一次；「按预算可用」= 当前余额 ÷ 每日预算。" />
    </div>
    <div class="budget-rows">
      <div v-for="r in rows" :key="r.unit" class="budget-row" :class="{ over: r.over, warn: r.warn }">
        <div class="brow-top">
          <span class="brow-unit">{{ r.unit }}</span>
          <span class="brow-num num">
            今日 <b>{{ fmtNumber(r.today) }}</b> / {{ fmtNumber(r.budget) }}
          </span>
          <span class="brow-rest num" v-if="!r.over">剩余额度 {{ fmtNumber(r.remainBudget) }}</span>
          <span class="brow-rest over-text" v-else>已超支 {{ fmtNumber(r.today - r.budget) }}</span>
        </div>
        <div class="brow-bar">
          <div class="brow-fill" :style="{ width: barPct(r) + '%' }"></div>
        </div>
        <div class="brow-foot">
          <span>{{ (r.ratio * 100).toFixed(0) }}%</span>
          <span v-if="r.daysLeft !== null" class="num">按这个节奏，余额还能用约 {{ Math.floor(r.daysLeft) }} 天</span>
          <span v-else class="muted">无余额数据</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.budget {
  flex: none;
  margin: 0 var(--pad-lg) 10px;
  padding: 12px 18px 14px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: var(--shadow-sm);
}

.budget-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.budget-title { font-size: 13px; font-weight: 700; color: var(--tx-strong); }
.budget-rows { display: flex; flex-wrap: wrap; gap: 16px 28px; }
.budget-row { flex: 1 1 260px; min-width: 240px; }
.brow-top { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.brow-unit { font-size: 10.5px; font-weight: 700; color: var(--tx3); letter-spacing: 0.5px; }
.brow-num { font-size: 13px; color: var(--tx); font-variant-numeric: tabular-nums; }
.brow-num b { color: var(--acc); font-weight: 700; }
.budget-row.over .brow-num b { color: var(--err); }
.brow-rest { font-size: 11.5px; color: var(--tx3); font-variant-numeric: tabular-nums; }
.over-text { color: var(--err); font-weight: 600; }
.brow-bar { height: 7px; border-radius: 999px; background: var(--track); overflow: hidden; margin: 6px 0 5px; }
.brow-fill { height: 100%; border-radius: 999px; background: var(--acc-grad); transition: width 0.5s var(--ease); }
.budget-row.warn .brow-fill { background: linear-gradient(90deg, var(--warn), var(--acc-2)); }
.budget-row.over .brow-fill { background: linear-gradient(90deg, var(--err), var(--warn)); }
.brow-foot { display: flex; align-items: baseline; gap: 12px; font-size: 11.5px; color: var(--tx3); }
.brow-foot .num { font-variant-numeric: tabular-nums; }
.muted { color: var(--tx3); }
</style>