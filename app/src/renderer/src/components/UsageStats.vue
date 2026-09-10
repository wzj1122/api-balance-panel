<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { DailyAccount, DailyUsageReport } from '@shared/types'
import { PROVIDER_META } from '@shared/constants'
import { fmtNumber } from '@shared/format'
import { listDailyUsage } from '@renderer/api/ipc'
import { downloadCsv, todayStamp } from '@renderer/utils/csv'
import BaseModal from './BaseModal.vue'
import UsageCalendar from './UsageCalendar.vue'

const loading = ref(false)
const error = ref('')
const report = ref<DailyUsageReport | null>(null)
const range = ref<7 | 30>(7)
const exporting = ref(false)
const selectedTs = ref<number | null>(null)

/** 弹窗：某一天各账号用量明细（从已拉取的报告里索引） */
const selectedDay = computed(() => {
  const ts = selectedTs.value
  const r = report.value
  if (ts === null || !r) return null
  const idx = r.days.findIndex((d) => d.ts === ts)
  if (idx < 0) return null
  const dt = new Date(ts)
  const rows = r.accounts.map((a) => ({ name: a.name, type: a.type, unit: a.unit, value: a.days[idx] }))
  const units = r.unitTotals
    .map((u) => ({ unit: u.unit, value: u.days[idx] }))
    .filter((u) => u.value !== null && u.value !== undefined)
  const hasAny = rows.some((x) => x.value !== null && x.value !== undefined)
  const week = ['日', '一', '二', '三', '四', '五', '六'][dt.getDay()]
  return {
    title: dt.getMonth() + 1 + ' 月 ' + dt.getDate() + ' 日',
    weekday: '星期' + week,
    rows,
    units,
    hasAny
  }
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    const r = await listDailyUsage(range.value)
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
  return !!r && r.days.length > 0 && r.accounts.length > 0
})

const todayChips = computed(() =>
  (report.value?.unitTotals ?? [])
    .map((u) => ({ unit: u.unit, value: u.today }))
    .filter((c) => c.value !== null && c.value !== undefined && Number.isFinite(c.value))
)

const topToday = computed<DailyAccount | null>(() => {
  let best: DailyAccount | null = null
  for (const a of report.value?.accounts ?? []) {
    if (a.today === null || a.today === undefined) continue
    if (!best || a.today > (best.today as number)) best = a
  }
  return best
})

const mostAtRisk = computed<DailyAccount | null>(() => {
  const accs = (report.value?.accounts ?? []).filter(
    (a) =>
      a.estEmptyTs !== null &&
      a.estEmptyTs !== undefined &&
      a.forecastDaysLeft !== null &&
      a.forecastDaysLeft !== undefined &&
      a.forecastDaysLeft < 90
  )
  if (accs.length === 0) return null
  return accs.reduce((a, b) => ((b.estEmptyTs as number) < (a.estEmptyTs as number) ? b : a))
})

const barCharts = computed(() => {
  const r = report.value
  if (!r) return []
  return r.unitTotals
    .filter((u) => u.days.some((v) => v !== null && v !== undefined))
    .map((u) => {
      const vals = u.days.map((v) => (v === null || v === undefined ? null : v))
      const max = Math.max(0, ...vals.filter((v): v is number => v !== null))
      // 即使整段时间消耗为 0，也画一条基线，避免图表看起来"空白"
      const bars = vals.map((v) => (v === null ? null : { h: max > 0 ? Math.max(3, (v / max) * 62) : 3, v }))
      return { unit: u.unit, bars, hasData: max > 0, total: vals.reduce<number>((sum, v) => sum + (v ?? 0), 0) }
    })
})

function typeLabel(t: string): string {
  const m = PROVIDER_META[t as keyof typeof PROVIDER_META]
  return m?.label ?? t
}

function fcastCell(a: DailyAccount): { text: string; cls: string } {
  if (a.forecastDaysLeft === null || a.forecastDaysLeft === undefined) return { text: '—', cls: '' }
  if (a.forecastDaysLeft > 365) return { text: '余量充足', cls: 'ok' }
  const cls = a.forecastDaysLeft < 3 ? 'danger' : a.forecastDaysLeft < 14 ? 'warn' : ''
  const d = a.estEmptyTs ? new Date(a.estEmptyTs) : null
  const md = d ? String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') : ''
  return { text: '约 ' + Math.ceil(a.forecastDaysLeft) + ' 天' + (md ? '（' + md + '）' : ''), cls }
}

function exportCsv() {
  const r = report.value
  if (!r || r.accounts.length === 0) return
  const rows: (string | number | null | undefined)[][] = []
  rows.push(['账号', '类型', '单位', '剩余', '今日', '7日均', '预计耗尽(天)', ...r.days.map((d) => d.label)])
  for (const a of r.accounts) {
    rows.push([
      a.name,
      typeLabel(a.type),
      a.unit,
      a.remaining ?? '',
      a.today ?? '',
      a.avg7 === null || a.avg7 === undefined ? '' : a.avg7.toFixed(4),
      a.forecastDaysLeft === null || a.forecastDaysLeft === undefined ? '' : a.forecastDaysLeft.toFixed(1),
      ...a.days.map((v) => (v === null || v === undefined ? '' : String(v)))
    ])
  }
  for (const u of r.unitTotals) {
    rows.push(['合计（' + u.unit + '）', '', u.unit, '', u.today ?? '', u.total7 ?? '', '', ...u.days.map((v) => (v === null || v === undefined ? '' : String(v)))])
  }
  downloadCsv('每日使用-' + todayStamp() + '.csv', rows)
  exporting.value = true
  setTimeout(() => { exporting.value = false }, 1500)
}
</script>

<template>
  <section class="usage-pane">
    <div class="head">
      <h2>每日使用状况</h2>
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

      <template v-else-if="report && report.accounts.length > 0">
        <template v-if="range === 7">
        <div class="chips">
          <div class="chip">
            <div class="chip-label">今日消耗</div>
            <div class="chip-value num" v-if="todayChips.length">
              <span v-for="c in todayChips" :key="c.unit" class="chip-multi">{{ fmtNumber(c.value) }} {{ c.unit }}</span>
            </div>
            <div class="chip-value" v-else>暂无数据</div>
          </div>
          <div class="chip">
            <div class="chip-label">今日消耗最多</div>
            <div class="chip-value" v-if="topToday">
              <span class="strong">{{ topToday.name }}</span>
              <span class="chip-sub num">{{ fmtNumber(topToday.today) }} {{ topToday.unit }}</span>
            </div>
            <div class="chip-value" v-else>暂无数据</div>
          </div>
          <div class="chip" v-if="mostAtRisk">
            <div class="chip-label">最可能先耗尽</div>
            <div class="chip-value danger-num">
              <span class="strong">{{ mostAtRisk.name }}</span>
              <span class="chip-sub num">{{ fcastCell(mostAtRisk).text }}</span>
            </div>
          </div>
        </div>

        <div class="charts">
          <div v-for="bc in barCharts" :key="bc.unit" class="chart-card">
            <div class="chart-title">
              每日消耗合计 · {{ bc.unit }}
              <span class="ct-total">共 {{ fmtNumber(bc.total) }}</span>
              <span v-if="!bc.hasData" class="ct-none">（近 {{ range }} 天没有消耗记录）</span>
            </div>
            <div class="bars2">
              <div v-for="(b, i) in bc.bars" :key="i" class="bar-col" :title="report.days[i] ? report.days[i].label + ' 消耗 ' + (b ? fmtNumber(b.v) : '无记录') : ''">
                <div
                  class="bar-fill"
                  :class="{ zero: !b || !b.v }"
                  :style="{ height: (b ? Math.max(4, Math.round((b.h / 62) * 100)) : 0) + '%' }"
                ></div>
              </div>
            </div>
            <div class="bar-labels" :style="{ gridTemplateColumns: 'repeat(' + bc.bars.length + ', 1fr)' }">
              <span v-for="(d, i) in report.days" :key="d.ts">{{ d.label }}</span>
            </div>
          </div>
        </div>

        <div class="table-wrap">
          <table class="usage-table">
            <thead>
              <tr>
                <th class="tl">账号</th>
                <th>剩余</th>
                <th v-for="(d, i) in report.days" :key="d.ts">{{ d.label }}</th>
                <th>今日</th>
                <th>7日均</th>
                <th>建议阈值</th>
                <th>预计耗尽</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="a in report.accounts" :key="a.accountId">
                <td class="tl">
                  <span class="acc-name">{{ a.name }}</span>
                  <span class="muted">{{ typeLabel(a.type) }}</span>
                </td>
                <td class="num">{{ fmtNumber(a.remaining) }} <span class="muted">{{ a.unit }}</span></td>
                <td v-for="(v, i) in a.days" :key="i" class="num" :class="{ dim: v === null, recharge: a.rechargeFlags[i] }">
                  {{ v === null ? (a.rechargeFlags[i] ? '充值' : '—') : fmtNumber(v) }}
                </td>
                <td class="num today">{{ a.today === null ? '—' : fmtNumber(a.today) }}</td>
                <td class="num">{{ a.avg7 === null ? '—' : fmtNumber(a.avg7) }}</td>
                <td class="num suggested">
                  {{ a.suggestedThreshold === null ? '—' : fmtNumber(a.suggestedThreshold) }}
                </td>
                <td class="fcast" :class="fcastCell(a).cls">{{ fcastCell(a).text }}</td>
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
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>

        <p v-if="report.note" class="note-line">{{ report.note }}。余额型账号按「剩余变化」估算，充值会掩盖消耗，仅供参考。</p>
        </template>
        <UsageCalendar v-else :report="report" @select-day="selectedTs = $event" />
      </template>

      <div v-else class="hint-box">
        {{ report?.note || '还没有历史数据：先让面板跑几轮刷新，明天再来看完整的每日统计。' }}
      </div>
    </div>

    <BaseModal :open="!!selectedDay" title="当日用量" @close="selectedTs = null">
      <div class="day-detail" v-if="selectedDay">
        <div class="dd-head">
          {{ selectedDay.title }}
          <span class="dd-sub">{{ selectedDay.weekday }}</span>
        </div>
        <div v-if="!selectedDay.hasAny" class="dd-empty">这一天没有用量记录</div>
        <table v-else class="dd-table">
          <thead>
            <tr><th class="tl">账号</th><th>单位</th><th>用量</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in selectedDay.rows" :key="r.name">
              <td class="tl">{{ r.name }} <span class="muted">{{ typeLabel(r.type) }}</span></td>
              <td class="muted">{{ r.unit || '—' }}</td>
              <td class="num">{{ r.value === null ? '—' : fmtNumber(r.value) }}</td>
            </tr>
          </tbody>
          <tfoot v-if="selectedDay.units.length">
            <tr v-for="u in selectedDay.units" :key="u.unit">
              <td class="tl strong">合计（{{ u.unit }}）</td>
              <td></td>
              <td class="num strong">{{ fmtNumber(u.value) }}</td>
            </tr>
          </tfoot>
        </table>
        <p class="dd-note">余额型账号按「剩余变化」估算，充值会掩盖消耗，仅供参考。</p>
      </div>
    </BaseModal>
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
.danger-num { color: var(--err); }
.charts { display: flex; flex-wrap: wrap; gap: var(--gap); margin-bottom: 20px; }
.chart-card { flex: 1 1 300px; min-width: 280px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px 10px; box-shadow: var(--shadow-sm); }
.chart-title .ct-total { color: var(--acc); font-weight: 700; margin-left: 6px; }
.chart-title .ct-none { color: var(--warn); font-weight: 600; margin-left: 6px; }
.chart-title { font-size: var(--fs-foot); color: var(--tx3); font-weight: 600; margin-bottom: 8px; }
.bars2 { display: flex; align-items: flex-end; gap: 4px; height: 64px; padding: 2px 0 0; }
.bar-col { flex: 1; display: flex; align-items: flex-end; justify-content: center; height: 100%; }
.bar-fill { width: 60%; max-width: 16px; min-height: 3px; border-radius: 4px 4px 2px 2px; background: var(--acc-grad); transition: height 0.35s var(--ease); }
.bar-fill.zero { background: var(--track); min-height: 3px; }
.bar-labels { display: grid; margin-top: 4px; }
.bar-labels span { font-size: 10px; color: var(--tx3); text-align: center; }
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
.usage-table td.recharge { color: var(--warn); font-weight: 600; font-size: 11.5px; }
.usage-table td.suggested { color: var(--tx2); }
.usage-table td.num { font-variant-numeric: tabular-nums; }
.usage-table td.strong { font-weight: 700; color: var(--tx); }
.usage-table td.fcast { font-weight: 600; }
.usage-table td.fcast.warn { color: var(--warn); }
.usage-table td.fcast.danger { color: var(--err); }
.usage-table td.fcast.ok { color: var(--ok); }
.usage-table tfoot td { border-bottom: none; background: var(--acc-soft); }
.acc-name { display: block; font-weight: 600; color: var(--tx); }
.muted { color: var(--tx3); font-size: var(--fs-foot); }
.hint-box { margin: 30px auto; max-width: 520px; text-align: center; color: var(--tx3); font-size: var(--fs-sub); line-height: 1.8; padding: 22px; background: var(--card); border: 1px dashed var(--line-strong); border-radius: 14px; }
.hint-box.err { color: var(--err); border-color: var(--err-line); }
.note-line { margin-top: 14px; font-size: var(--fs-foot); color: var(--tx3); }

.day-detail { font-size: var(--fs-sub); }
.dd-head { font-size: 15px; font-weight: 700; color: var(--tx-strong); margin-bottom: 12px; display: flex; align-items: baseline; gap: 10px; }
.dd-sub { font-size: var(--fs-foot); font-weight: 500; color: var(--tx3); }
.dd-empty { padding: 18px 4px; text-align: center; color: var(--tx3); border: 1px dashed var(--line-strong); border-radius: 10px; }
.dd-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sub); }
.dd-table th, .dd-table td { padding: 7px 10px; border-bottom: none;
 box-shadow: inset 0 -1px 0 var(--line-soft); text-align: right; }
.dd-table th.tl, .dd-table td.tl { text-align: left; }
.dd-table th { color: var(--tx2); font-weight: 600; font-size: var(--fs-foot); }
.dd-table .num { font-variant-numeric: tabular-nums; }
.dd-table tfoot td { border-bottom: none; background: var(--acc-soft); font-weight: 700; color: var(--tx); }
.dd-table .strong { font-weight: 700; color: var(--tx); }
.dd-note { margin-top: 10px; font-size: var(--fs-foot); color: var(--tx3); }
</style>