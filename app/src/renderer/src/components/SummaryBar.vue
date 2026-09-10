<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { BalanceRow, FxInfo } from '@shared/types'
import { fmtNumber } from '@shared/format'
import { getFx } from '@renderer/api/ipc'

const props = defineProps<{
  rows: BalanceRow[]
  totalAccounts: number
}>()

/** 已启用且在监控中的账号数 */
const monitored = computed(() => props.rows.length)

/** 查询失败的账号数 */
const failures = computed(() => props.rows.filter((r) => !r.ok).length)

/** 按单位分组合计剩余（只合计成功且有剩余值的） */
const byUnit = computed<{ unit: string; sum: number }[]>(() => {
  const map = new Map<string, number>()
  for (const r of props.rows) {
    if (r.ok && typeof r.remaining === 'number') {
      map.set(r.unit, (map.get(r.unit) ?? 0) + r.remaining)
    }
  }
  return Array.from(map.entries()).map(([unit, sum]) => ({ unit, sum }))
})

/** 人民币单位集合：这些单位直接视作 CNY，不做汇率换算 */
const RMB_UNITS = new Set(['CNY', '元'])

/** 实时汇率（懒拉；主进程内部有 1 小时缓存与兜底） */
const fx = ref<FxInfo | null>(null)

/** USD 剩余合计（成功且有数值的账号） */
const usdSum = computed(() =>
  props.rows.reduce(
    (acc, r) => (r.ok && r.unit === 'USD' && typeof r.remaining === 'number' ? acc + r.remaining : acc),
    0
  )
)

/** 人民币剩余合计 */
const rmbSum = computed(() =>
  props.rows.reduce(
    (acc, r) => (r.ok && RMB_UNITS.has(r.unit) && typeof r.remaining === 'number' ? acc + r.remaining : acc),
    0
  )
)

/** 折算成人民币的总剩余（人民币 + USD × 汇率） */
const converted = computed(() => rmbSum.value + usdSum.value * (fx.value?.rate ?? 0))

const fxNote = computed(() => {
  if (!fx.value) return ''
  return fx.value.source === 'live' ? '实时汇率' : fx.value.source === 'cache' ? '上次汇率' : '内置汇率'
})

async function fetchFx(): Promise<void> {
  const r = await getFx()
  if (r.ok) fx.value = r.data
}

onMounted(() => {
  void fetchFx()
})

// 出现 USD 账号且汇率还没拿到时，补拉一次（懒拉，不频繁请求）
watch(usdSum, (v) => {
  if (v > 0 && !fx.value) void fetchFx()
})
</script>

<template>
  <section class="summary">
    <div class="chip">
      <div class="chip-label"><span class="mini-dot total"></span>账号总数</div>
      <div class="chip-value num">{{ totalAccounts }}</div>
    </div>

    <div v-for="g in byUnit" :key="g.unit" class="chip">
      <div class="chip-label"><span class="mini-dot unit-dot"></span>合计剩余 {{ g.unit }}</div>
      <div class="chip-value num">{{ fmtNumber(g.sum) }}</div>
    </div>

    <div v-if="usdSum > 0" class="chip fx">
      <div class="chip-label"><span class="mini-dot fx-dot"></span>成本折算</div>
      <div class="chip-value strong num">约 ¥{{ fmtNumber(converted) }}</div>
      <div class="chip-note">
        {{ fxNote }} 1$≈{{ fx ? fx.rate.toFixed(4) : '—' }}¥<template v-if="fx && fx.source !== 'live'">（未联网）</template>
      </div>
    </div>

    <div class="chip">
      <div class="chip-label"><span class="mini-dot err-dot"></span>查询失败</div>
      <div class="chip-value num" :class="{ danger: failures > 0 }">{{ failures }}</div>
    </div>

    <div class="chip ghost">
      <div class="chip-label"><span class="mini-dot ghost-dot"></span>监控中</div>
      <div class="chip-value num">{{ monitored }}</div>
    </div>
  </section>
</template>

<style scoped>
.summary {
  flex: 0 0 auto;
  display: flex;
  gap: var(--gap);
  flex-wrap: wrap;
  padding: 14px var(--pad-lg);
  background: var(--bar-bg-soft);
  border-bottom: 1px solid var(--line);
}

.chip {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 12px 18px;
  min-width: 118px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  box-shadow: var(--shadow-sm);
  transition: transform 0.15s var(--ease), border-color 0.15s ease;
}

.chip:hover {
  transform: translateY(-1px);
  border-color: var(--line-strong);
}

.chip.ghost {
  background: rgba(255, 255, 255, 0.02);
  border-style: dashed;
  box-shadow: none;
}

.chip-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-foot);
  color: var(--tx3);
  letter-spacing: 0.3px;
  font-weight: 500;
}

.mini-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}

.mini-dot.total {
  background: var(--acc);
  box-shadow: 0 0 0 3px var(--acc-soft);
}

.mini-dot.unit-dot {
  background: var(--ok);
  box-shadow: 0 0 0 3px var(--ok-soft);
}

.mini-dot.fx-dot {
  background: var(--acc-grad);
  box-shadow: 0 0 0 3px var(--acc-soft);
}

.mini-dot.err-dot {
  background: var(--err);
  box-shadow: 0 0 0 3px var(--err-soft);
}

.mini-dot.ghost-dot {
  background: var(--tx3);
  box-shadow: 0 0 0 3px rgba(92, 104, 124, 0.2);
}

.chip-value {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.25;
  color: var(--tx-strong);
}

.chip-value.danger {
  color: var(--err);
}

.chip-value.strong {
  background: var(--acc-grad);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.chip-note {
  font-size: var(--fs-foot);
  color: var(--tx3);
  margin-top: 1px;
  white-space: nowrap;
}
</style>
