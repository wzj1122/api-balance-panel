<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { DailyAccount, DailyUsageReport, Settings } from '@shared/types'
import { fmtNumber } from '@shared/format'
import { compareWeight } from '@shared/cost'
import { getFx, listDailyUsage } from '@renderer/api/ipc'
import { downloadCsv, todayStamp } from '@renderer/utils/csv'
import { providerLabel } from '@renderer/utils/text'
import BaseModal from './BaseModal.vue'
import UsageCalendar from './UsageCalendar.vue'

const loading = ref(false)
const error = ref('')
const report = ref<DailyUsageReport | null>(null)
const range = ref<7 | 30>(7)
const exporting = ref(false)
const selectedTs = ref<number | null>(null)

const props = defineProps<{ settings: Settings | null }>()

/** 积分折算率（多少积分算 1 元）；0 / 缺省 = 不折算 */
const creditsPerCny = computed(() => props.settings?.credits_per_cny ?? 0)
/** 美元汇率（仅当报表里出现美元单位时才去取，主进程 1 小时缓存） */
const usdRate = ref(0)

/** 跳到「数据校正」页（带着账号）——历史数据不对时一步到位 */
const emit = defineEmits<{ (e: 'correct', accountId: string): void }>()

/** 逐日列的表头说明（所有日期列共用）：讲清「黄 / 充值 / —」分别代表什么 */
const DAY_COL_TIP = '逐日消耗。写着「充值」= 当天余额反而增加（疑似充值），当日消耗算不出来；「—」= 该日没有采样数据。'

/** 弹窗：某一天各账号用量明细（从已拉取的报告里索引） */
const selectedDay = computed(() => {
  const ts = selectedTs.value
  const r = report.value
  if (ts === null || !r) return null
  const idx = r.days.findIndex((d) => d.ts === ts)
  if (idx < 0) return null
  const dt = new Date(ts)
  const rows = r.accounts.map((a) => ({
    name: a.name,
    type: a.type,
    unit: a.unit,
    value: a.days[idx],
    gap: a.gapDays?.[idx] ?? null
  }))
  // 当日合计：该日逐日值 + 该日停机期间（合计里包含停机区间）
  const units = r.unitTotals
    .map((u) => {
      const v = u.days[idx]
      const g = u.gapDays?.[idx] ?? null
      const has = (v !== null && v !== undefined) || (g !== null && g !== undefined)
      return { unit: u.unit, value: v, gap: g, total: has ? (v ?? 0) + (g ?? 0) : null }
    })
    .filter((u) => u.total !== null)
  const hasAny = rows.some((x) => x.value !== null && x.value !== undefined)
  const hasGap = rows.some((x) => x.gap !== null && x.gap !== undefined)
  const week = ['日', '一', '二', '三', '四', '五', '六'][dt.getDay()]
  return {
    title: dt.getMonth() + 1 + ' 月 ' + dt.getDate() + ' 日',
    weekday: '星期' + week,
    rows,
    units,
    hasAny,
    hasGap
  }
})

/** 窗口内「停机期间消耗」按单位汇总（单位不同不能相加，分开列） */
const gapNotes = computed(() =>
  (report.value?.unitTotals ?? [])
    .filter((u) => (u.gapTotal ?? 0) > 0)
    .map((u) => ({ unit: u.unit, value: u.gapTotal }))
)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const r = await listDailyUsage(range.value)
    if (r.ok) {
      report.value = r.data
      // 报表里有美元单位 → 取一次汇率（供「今日消耗最多」折算比较；主进程 1 小时缓存）
      if (r.data.accounts.some((a) => a.unit === 'USD') && usdRate.value <= 0) {
        const fx = await getFx()
        if (fx.ok) usdRate.value = fx.data.rate
      }
    } else error.value = r.error
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

/**
 * 「今日消耗最多」：**先折算成金额再比**（2026-09-22 用户要求）。
 * 积分型（商汤）按折算率折元、美元按汇率折元，否则「4000 积分 > 3 元」会选错人；
 * **显示仍用原单位原值**（商汤显示积分）。
 * 主进程已按同一权重排序，这里取「第一个有今日数据的」即为折算金额最大者；
 * 自己再算一遍权重兜底（不依赖排序口径），折不了时回退原值保持旧行为。
 */
const topToday = computed<DailyAccount | null>(() => {
  const list = report.value?.accounts ?? []
  const w = (a: DailyAccount): number =>
    compareWeight(a.today, a.unit, creditsPerCny.value, usdRate.value) ?? Number.NEGATIVE_INFINITY
  let best: DailyAccount | null = null
  for (const a of list) {
    if (a.today === null || a.today === undefined) continue
    if (!best || w(a) > w(best)) best = a
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

/**
 * 逐日单元格的悬浮说明：把「这格为什么是红的 / 为什么写『充值』」讲到具体数字。
 * 表格只用红色一种强调色，所以原因全靠悬浮提示说清楚。
 */
function dayCellTitle(a: DailyAccount, i: number, v: number | null): string {
  const day = report.value?.days[i]?.label ?? ''
  const parts: string[] = [day]
  const gap = a.gapDays?.[i] ?? null
  if (a.rechargeFlags[i]) {
    parts.push('疑似充值：当天余额反而增加，当日消耗无法计算，这一格不代表用量')
  } else if (v === null) {
    parts.push('该日没有采样数据')
  } else {
    parts.push('消耗 ' + fmtNumber(v) + ' ' + (a.unit || ''))
  }
  if (gap !== null && gap !== undefined && gap > 0) {
    parts.push('停机期间另有 ' + fmtNumber(gap) + ' ' + (a.unit || '') + '（软件未运行，无法按天归属，已计入「合计（含停机）」）')
  }
  return parts.join(' · ')
}

/** 预计耗尽：只在"快用完了"（< 3 天）标红；其余保持普通字色，不再有黄色档位（用户反馈太乱） */
function fcastCell(a: DailyAccount): { text: string; cls: string } {
  if (a.forecastDaysLeft === null || a.forecastDaysLeft === undefined) return { text: '—', cls: '' }
  if (a.forecastDaysLeft > 365) return { text: '余量充足', cls: '' }
  const cls = a.forecastDaysLeft < 3 ? 'danger' : ''
  const d = a.estEmptyTs ? new Date(a.estEmptyTs) : null
  const md = d ? String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') : ''
  return { text: '约 ' + Math.ceil(a.forecastDaysLeft) + ' 天' + (md ? '（' + md + '）' : ''), cls }
}

function exportCsv() {
  const r = report.value
  if (!r || r.accounts.length === 0) return
  const rows: (string | number | null | undefined)[][] = []
  rows.push(['账号', '类型', '单位', '剩余', '今日', '7日均', '合计(含停机)', '停机期间', '逐日合计', '预计耗尽(天)', ...r.days.map((d) => d.label)])
  for (const a of r.accounts) {
    rows.push([
      a.name,
      providerLabel(a.type),
      a.unit,
      a.remaining ?? '',
      a.today ?? '',
      a.avg7 === null || a.avg7 === undefined ? '' : a.avg7.toFixed(4),
      a.totalAll ?? '',
      a.gapTotal || '',
      a.totalDaily ?? '',
      a.forecastDaysLeft === null || a.forecastDaysLeft === undefined ? '' : a.forecastDaysLeft.toFixed(1),
      ...a.days.map((v) => (v === null || v === undefined ? '' : String(v)))
    ])
  }
  for (const u of r.unitTotals) {
    rows.push([
      '合计（' + u.unit + '）',
      '',
      u.unit,
      '',
      u.today ?? '',
      u.total7 ?? '',
      u.totalAll ?? '',
      u.gapTotal || '',
      u.totalDaily ?? '',
      '',
      ...u.days.map((v) => (v === null || v === undefined ? '' : String(v)))
    ])
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
            <div class="chip-label">今日消耗最多（按折算金额比较）</div>
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

        <div v-if="gapNotes.length" class="gap-note">
          <span class="gap-ico" title="软件未运行期间">⏸</span>
          <span>检测到<strong>停机期间消耗</strong>（软件未运行，无法按天归属）：</span>
          <b v-for="g in gapNotes" :key="g.unit" class="num gap-val">{{ fmtNumber(g.value) }} {{ g.unit }}</b>
          <span class="muted">已<strong>计入下方「合计（含停机）」</strong>，但不计入日均、耗尽预估与预算判断。</span>
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
              <span v-for="d in report.days" :key="d.ts">{{ d.label }}</span>
            </div>
          </div>
        </div>

        <div class="table-wrap">
          <table class="usage-table">
            <thead>
              <tr>
                <th class="tl">账号</th>
                <th>剩余</th>
                <th v-for="d in report.days" :key="d.ts" :title="DAY_COL_TIP">{{ d.label }}</th>
                <th>今日</th>
                <th title="近 7 天有效日的日均消耗（不含停机期间）">7日均</th>
                <th title="软件未运行期间的余额下降；已计入下方「合计」，但不计入日均与耗尽预估">停机期间</th>
                <th title="整段范围合计 = 逐日之和 + 停机期间消耗（这段时间实际掉了多少）">合计（含停机）</th>
                <th>建议阈值</th>
                <th>预计耗尽</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="a in report.accounts" :key="a.accountId">
                <td class="tl">
                  <span class="acc-name">{{ a.name }}</span>
                  <span class="muted">{{ providerLabel(a.type) }}</span>
                  <button class="link-btn" type="button" title="这一天的数据不对？去「数据校正」页修改" @click="emit('correct', a.accountId)">校正</button>
                </td>
                <td class="num">{{ fmtNumber(a.remaining) }} <span class="muted">{{ a.unit }}</span></td>
                <td
                  v-for="(v, i) in a.days"
                  :key="i"
                  class="num"
                  :class="{ dim: v === null, recharge: a.rechargeFlags[i] }"
                  :title="dayCellTitle(a, i, v)"
                >
                  {{ v === null ? (a.rechargeFlags[i] ? '充值' : '—') : fmtNumber(v) }}
                </td>
                <td class="num today">{{ a.today === null ? '—' : fmtNumber(a.today) }}</td>
                <td class="num">{{ a.avg7 === null ? '—' : fmtNumber(a.avg7) }}</td>
                <td class="num gap" :class="{ dim: !a.gapTotal }" :title="a.gapTotal ? '软件未运行期间的消耗，已计入合计（但不计入日均与预估）' : ''">
                  {{ a.gapTotal ? fmtNumber(a.gapTotal) : '—' }}
                </td>
                <td class="num strong" :title="'逐日合计 ' + fmtNumber(a.totalDaily) + ' + 停机期间 ' + fmtNumber(a.gapTotal) + ' = ' + fmtNumber(a.totalAll)">
                  {{ fmtNumber(a.totalAll) }}
                </td>
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
                <td class="num strong gap" :title="u.gapTotal ? '已计入右侧「合计（含停机）」' : ''">{{ u.gapTotal ? fmtNumber(u.gapTotal) : '—' }}</td>
                <td class="num strong" :title="'逐日合计 ' + fmtNumber(u.totalDaily) + ' + 停机期间 ' + fmtNumber(u.gapTotal) + ' = ' + fmtNumber(u.totalAll)">
                  {{ u.totalAll === null ? '—' : fmtNumber(u.totalAll) }}
                </td>
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
        <div v-if="!selectedDay.hasAny && !selectedDay.hasGap" class="dd-empty">这一天没有用量记录</div>
        <table v-else class="dd-table">
          <thead>
            <tr><th class="tl">账号</th><th>单位</th><th>用量</th><th title="软件未运行期间的余额下降；已计入合计">停机期间</th><th title="用量 + 停机期间">合计</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in selectedDay.rows" :key="r.name">
              <td class="tl">{{ r.name }} <span class="muted">{{ providerLabel(r.type) }}</span></td>
              <td class="muted">{{ r.unit || '—' }}</td>
              <td class="num">{{ r.value === null ? '—' : fmtNumber(r.value) }}</td>
              <td class="num gap" :class="{ dim: !r.gap }">{{ r.gap ? fmtNumber(r.gap) : '—' }}</td>
              <td class="num strong">{{ fmtNumber((r.value ?? 0) + (r.gap ?? 0)) }}</td>
            </tr>
          </tbody>
          <tfoot v-if="selectedDay.units.length">
            <tr v-for="u in selectedDay.units" :key="u.unit">
              <td class="tl strong">合计（{{ u.unit }}）</td>
              <td></td>
              <td class="num strong">{{ u.value === null ? '—' : fmtNumber(u.value) }}</td>
              <td class="num strong gap">{{ u.gap ? fmtNumber(u.gap) : '—' }}</td>
              <td class="num strong">{{ fmtNumber(u.total) }}</td>
            </tr>
          </tfoot>
        </table>
        <p v-if="selectedDay.hasGap" class="dd-note">
          该日的「停机期间」列是上次关闭软件到本次打开之间的余额下降，无法精确按天归属：它<strong>已计入当日合计</strong>，但不计入日均与耗尽预估。
        </p>
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
/* .seg / .gap-note 基础样式统一在 global.css */
.scroll { flex: 1; overflow-y: auto; padding: 8px var(--pad-lg) 40px; }
.chips { display: flex; flex-wrap: wrap; gap: var(--gap); margin: 10px 0 18px; }
.chip { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 12px 18px; min-width: 150px; box-shadow: var(--shadow-sm); display: flex; flex-direction: column; gap: 4px; }
.chip-label { font-size: var(--fs-foot); color: var(--tx3); font-weight: 500; letter-spacing: 0.3px; }
.chip-value { font-size: 18px; font-weight: 700; color: var(--tx-strong); display: flex; flex-direction: column; gap: 2px; line-height: 1.3; }
.chip-multi { font-size: 15px; }
.chip-value .strong { font-size: 15px; }
.chip-sub { font-size: var(--fs-foot); color: var(--tx3); font-weight: 600; }
/* 「最可能先耗尽」也改成普通字色（不再用红色强调） */
.danger-num { color: var(--tx-strong); }
.charts { display: flex; flex-wrap: wrap; gap: var(--gap); margin-bottom: 20px; }
.chart-card { flex: 1 1 300px; min-width: 280px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px 10px; box-shadow: var(--shadow-sm); }
.chart-title .ct-total { color: var(--acc); font-weight: 700; margin-left: 6px; }
.chart-title .ct-none { color: var(--tx3); margin-left: 6px; }
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
/* 「充值」格：跟其它数字一样普通显示，不做任何强调（用户要求：不需要突出显示） */
.usage-table td.recharge { font-size: 11.5px; }
.usage-table td.suggested { color: var(--tx2); }
.usage-table td.num { font-variant-numeric: tabular-nums; }
.usage-table td.strong { font-weight: 700; color: var(--tx); }
.usage-table td.fcast { font-weight: 600; }
/* 「预计耗尽」「停机期间」列：一律普通字色，不标红、不加粗（用户要求：不需要突出显示） */
.usage-table td.gap, .dd-table td.gap { font-variant-numeric: tabular-nums; }
.usage-table tfoot td { border-bottom: none; background: var(--acc-soft); }
.acc-name { display: block; font-weight: 600; color: var(--tx); }
.muted { color: var(--tx3); font-size: var(--fs-foot); }
.hint-box { margin: 30px auto; max-width: 520px; text-align: center; color: var(--tx3); font-size: var(--fs-sub); line-height: 1.8; padding: 22px; background: var(--card); border: 1px dashed var(--line-strong); border-radius: 14px; }
.hint-box.err { color: var(--err); border-color: var(--err-line); }
.note-line { margin-top: 14px; font-size: var(--fs-foot); color: var(--tx3); }

/* 「校正」小链接：跳到数据校正页 */
.link-btn {
  margin-left: 8px;
  background: transparent;
  border: none;
  color: var(--acc);
  font-size: 11.5px;
  cursor: pointer;
  padding: 1px 6px;
  border-radius: 6px;
  transition: background var(--dur) ease;
}
.link-btn:hover { background: var(--acc-soft); }

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