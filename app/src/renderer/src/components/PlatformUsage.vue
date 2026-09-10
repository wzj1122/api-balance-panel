<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { PlatformUsageReport } from '@shared/types'
import { PROVIDER_META } from '@shared/constants'
import { fmtNumber } from '@shared/format'
import { listPlatformUsage } from '@renderer/api/ipc'
import { downloadCsv, todayStamp } from '@renderer/utils/csv'

const loading = ref(false)
const error = ref('')
const report = ref<PlatformUsageReport | null>(null)
const range = ref<7 | 30>(7)
const exporting = ref(false)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const r = await listPlatformUsage(range.value)
    if (r.ok) report.value = r.data
    else error.value = r.error
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

onMounted(load)

function setRange(v: 7 | 30) {
  range.value = v
  void load()
}

const hasData = computed(() => {
  const r = report.value
  return !!r && r.days.length > 0 && r.platforms.length > 0
})

function typeLabel(t: string): string {
  const m = PROVIDER_META[t as keyof typeof PROVIDER_META]
  return m?.label ?? t
}

const totalByUnit = computed(() =>
  (report.value?.unitTotals ?? [])
    .map((u) => ({
      unit: u.unit,
      total: u.days.filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v)).reduce((a, b) => a + b, 0),
    }))
    .filter((x) => x.total > 0)
)

const topPlatform = computed(() => {
  const ps = report.value?.platforms ?? []
  let best: PlatformUsageReport['platforms'][number] | null = null
  for (const p of ps) if (!best || (p.total ?? -1) > (best.total ?? -1)) best = p
  return best
})

const maxTotal = computed(() => {
  const ps = report.value?.platforms ?? []
  return Math.max(0, ...ps.map((p) => p.total ?? 0))
})

function barPct(total: number | null): number {
  if (total === null || total === undefined || maxTotal.value <= 0) return 0
  return Math.max(2, Math.round((total / maxTotal.value) * 100))
}

function exportCsv() {
  const r = report.value
  if (!r || r.platforms.length === 0) return
  const rows: (string | number | null | undefined)[][] = []
  rows.push(['平台', '类型', '单位', '今日', '7日均', '合计', ...r.days.map((d) => d.label)])
  for (const p of r.platforms) {
    rows.push([
      typeLabel(p.type),
      p.type,
      p.unit,
      p.today ?? '',
      p.avg7 === null || p.avg7 === undefined ? '' : p.avg7.toFixed(4),
      p.total ?? '',
      ...p.days.map((v) => (v === null || v === undefined ? '' : String(v)))
    ])
  }
  for (const u of r.unitTotals) {
    const sum = u.days.reduce<number>((s, v) => s + (v ?? 0), 0)
    rows.push(['合计（' + u.unit + '）', '', u.unit, u.today ?? '', u.total7 ?? '', sum || '', ...u.days.map((v) => (v === null || v === undefined ? '' : String(v)))])
  }
  downloadCsv('平台用量-' + todayStamp() + '.csv', rows)
  exporting.value = true
  setTimeout(() => { exporting.value = false }, 1500)
}
</script>

<template>
  <section class="usage-pane">
    <div class="head">
      <h2>平台用量</h2>
      <div class="tools">
        <div class="seg">
          <button type="button" :class="{ on: range === 7 }" @click="setRange(7)">近 7 天</button>
          <button type="button" :class="{ on: range === 30 }" @click="setRange(30)">近 30 天</button>
        </div>
        <button class="btn ghost" type="button" :disabled="loading" @click="load">刷新</button>
        <button class="btn ghost" type="button" :disabled="!hasData || exporting" @click="exportCsv">
          {{ exporting ? '已导出 ✓' : '导出 CSV' }}
        </button>
      </div>
    </div>

    <div class="scroll">
      <div v-if="loading && !report"><div class="sk-wrap"><div class="skeleton sk-card"></div><div class="skeleton sk-row"></div><div class="skeleton sk-row short"></div></div></div>
      <div v-else-if="error" class="hint-box err">{{ error }}</div>

      <template v-else-if="report && report.platforms.length > 0">
        <div class="chips">
          <div class="chip">
            <div class="chip-label">近 {{ range }} 天总消耗</div>
            <div class="chip-value num" v-if="totalByUnit.length">
              <span v-for="c in totalByUnit" :key="c.unit" class="chip-multi">{{ fmtNumber(c.total) }} {{ c.unit }}</span>
            </div>
            <div class="chip-value" v-else>暂无数据</div>
          </div>
          <div class="chip">
            <div class="chip-label">消耗最多平台</div>
            <div class="chip-value" v-if="topPlatform">
              <span class="strong">{{ typeLabel(topPlatform.type) }}</span>
              <span class="chip-sub num">{{ fmtNumber(topPlatform.total) }} {{ topPlatform.unit }}</span>
            </div>
            <div class="chip-value" v-else>暂无数据</div>
          </div>
          <div class="chip">
            <div class="chip-label">今日消耗</div>
            <div class="chip-value num" v-if="report.unitTotals.length">
              <template v-for="u in report.unitTotals" :key="u.unit">
                <span v-if="u.today !== null" class="chip-multi">{{ fmtNumber(u.today) }} {{ u.unit }}</span>
              </template>
            </div>
            <div class="chip-value" v-else>暂无数据</div>
          </div>
        </div>

        <div class="bars-card">
          <div class="bars-title">平台消耗对比（近 {{ range }} 天）</div>
          <div class="bar-row" v-for="p in report.platforms" :key="p.type + p.unit">
            <div class="bar-info">
              <span class="bar-name">{{ typeLabel(p.type) }}</span>
              <span class="bar-type-muted">{{ p.type }}</span>
            </div>
            <div class="bar-track">
              <div class="bar-fill" :style="{ width: barPct(p.total) + '%' }"></div>
            </div>
            <div class="bar-num num">{{ fmtNumber(p.total) }} {{ p.unit }}</div>
          </div>
        </div>

        <div class="table-wrap">
          <table class="usage-table">
            <thead>
              <tr>
                <th class="tl">平台</th>
                <th>单位</th>
                <th v-for="(d, i) in report.days" :key="d.ts" class="th-day" :class="{ faint: range === 30 && i % 5 !== 0 }">{{ d.label }}</th>
                <th>今日</th>
                <th>7日均</th>
                <th>合计</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in report.platforms" :key="p.type + p.unit">
                <td class="tl"><span class="acc-name">{{ typeLabel(p.type) }}</span><span class="muted">{{ p.type }}</span></td>
                <td class="muted">{{ p.unit || '—' }}</td>
                <td v-for="(v, i) in p.days" :key="i" class="num" :class="{ dim: v === null }">{{ v === null ? '—' : fmtNumber(v) }}</td>
                <td class="num today">{{ p.today === null ? '—' : fmtNumber(p.today) }}</td>
                <td class="num">{{ p.avg7 === null ? '—' : fmtNumber(p.avg7) }}</td>
                <td class="num strong">{{ p.total === null ? '—' : fmtNumber(p.total) }}</td>
              </tr>
            </tbody>
            <tfoot v-if="report.unitTotals.length">
              <tr v-for="u in report.unitTotals" :key="u.unit">
                <td class="tl strong">合计（{{ u.unit }}）</td>
                <td></td>
                <td v-for="(v, i) in u.days" :key="i" class="num strong">{{ v === null ? '—' : fmtNumber(v) }}</td>
                <td class="num strong">{{ u.today === null ? '—' : fmtNumber(u.today) }}</td>
                <td class="num strong">{{ u.total7 === null ? '—' : fmtNumber(u.total7) }}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>

        <p v-if="report.note" class="note-line">{{ report.note }}</p>
      </template>

      <div v-else class="hint-box">{{ report?.note || '还没有历史数据：先让面板跑几轮刷新，明天再来看完整的平台统计。' }}</div>
    </div>
  </section>
</template>

<style scoped>
.usage-pane { display: flex; flex-direction: column; height: 100%; }
.head { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; padding: 20px var(--pad-lg) 8px; }
.head h2 { font-size: 19px; font-weight: 700; color: var(--tx-strong); margin: 0; }
.tools { display: flex; align-items: center; gap: 8px; }
.seg { display: inline-flex; gap: 4px; background: var(--panel2); border: 1px solid var(--line); border-radius: 10px; padding: 3px; }
.seg button { border: none; background: transparent; color: var(--tx2); font-size: var(--fs-sub); font-weight: 500; padding: 5px 12px; border-radius: 8px; cursor: pointer; transition: background var(--dur) ease, color var(--dur) ease; }
.seg button.on { background: var(--card); color: var(--acc); font-weight: 600; box-shadow: var(--shadow-sm); }
.scroll { flex: 1; overflow-y: auto; padding: 8px var(--pad-lg) 40px; }
.chips { display: flex; flex-wrap: wrap; gap: var(--gap); margin: 10px 0 18px; }
.chip { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 12px 18px; min-width: 150px; box-shadow: var(--shadow-sm); display: flex; flex-direction: column; gap: 4px; }
.chip-label { font-size: var(--fs-foot); color: var(--tx3); font-weight: 500; letter-spacing: 0.3px; }
.chip-value { font-size: 18px; font-weight: 700; color: var(--tx-strong); display: flex; flex-direction: column; gap: 2px; line-height: 1.3; }
.chip-multi { font-size: 15px; }
.chip-value .strong { font-size: 15px; }
.chip-sub { font-size: var(--fs-foot); color: var(--tx3); font-weight: 600; }
.bars-card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px 18px; margin-bottom: 18px; box-shadow: var(--shadow-sm); }
.bars-title { font-size: var(--fs-foot); color: var(--tx3); font-weight: 600; margin-bottom: 10px; }
.bar-row { display: flex; align-items: center; gap: 12px; margin-bottom: 9px; }
.bar-info { width: 92px; flex: none; display: flex; flex-direction: column; gap: 1px; }
.bar-name { font-size: var(--fs-sub); font-weight: 600; color: var(--tx); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar-type-muted { font-size: 10.5px; color: var(--tx3); }
.bar-track { flex: 1; height: 22px; background: var(--panel2); border-radius: 999px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 999px; background: var(--acc-grad); min-width: 6px; transition: width 0.5s var(--ease); }
.bar-num { flex: none; min-width: 108px; text-align: right; font-size: var(--fs-sub); font-weight: 600; color: var(--tx); font-variant-numeric: tabular-nums; }
.table-wrap { background: var(--card); border: none; border-radius: 14px; overflow: auto; box-shadow: inset 0 0 0 1px var(--line), var(--shadow-sm); }
.usage-table { border-collapse: collapse; width: 100%; font-size: var(--fs-sub); }
.usage-table th, .usage-table td { padding: 8px 10px; border-bottom: none;
 box-shadow: inset 0 -1px 0 var(--line-soft); white-space: nowrap; text-align: right; }
.usage-table th { position: sticky; top: 0; background: var(--panel2); color: var(--tx2); font-weight: 600; font-size: var(--fs-foot); z-index: 1; }
.usage-table .tl { text-align: left; }
/* 只冻结第一列（账号/平台），避免多个粘性列互相重叠挡住操作按钮 */
.usage-table th:first-child, .usage-table td:first-child { position: sticky; left: 0; background: var(--card); z-index: 2; }
.usage-table th:first-child { background: var(--panel2); z-index: 3; }
.usage-table th.tl { min-width: 120px; }
.usage-table tbody tr:hover td { background: var(--card-hover); }
.usage-table td.dim { color: var(--tx3); }
.usage-table td.today { font-weight: 700; color: var(--acc); }
.usage-table td.num { font-variant-numeric: tabular-nums; }
.usage-table td.strong { font-weight: 700; color: var(--tx); }
.usage-table tfoot td { border-bottom: none; background: var(--acc-soft); }
.th-day.faint { color: transparent; }
.acc-name { display: block; font-weight: 600; color: var(--tx); }
.muted { color: var(--tx3); font-size: var(--fs-foot); }
.hint-box { margin: 30px auto; max-width: 520px; text-align: center; color: var(--tx3); font-size: var(--fs-sub); line-height: 1.8; padding: 22px; background: var(--card); border: 1px dashed var(--line-strong); border-radius: 14px; }
.hint-box.err { color: var(--err); border-color: var(--err-line); }
.note-line { margin-top: 14px; font-size: var(--fs-foot); color: var(--tx3); }
</style>