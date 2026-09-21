<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { PlatformUsageReport, Settings } from '@shared/types'
import { PROVIDER_META } from '@shared/constants'
import { fmtNumber, fmtMoney } from '@shared/format'
import { creditsToCny, hasCreditRate, rateText, toCnyEstimate, unitKind } from '@shared/cost'
import { listPlatformUsage } from '@renderer/api/ipc'
import { downloadCsv, todayStamp } from '@renderer/utils/csv'

/**
 * 「积分」和「元」是大数量级差异的两个单位：直接并排画对比条会得出"积分花得多得多"的错误印象。
 * 所以这里把每个单位都折算成人民币估算值，用同一把尺子排序 / 定宽，
 * 折算率来自「设置 → 成本折算」（默认按 DeepSeek 高峰价反推，见 shared/constants.ts）。
 */
const props = defineProps<{ settings: Settings | null }>()

const loading = ref(false)
const error = ref('')
const report = ref<PlatformUsageReport | null>(null)
const range = ref<7 | 30>(7)
const exporting = ref(false)

/** 积分折算率（多少积分算 1 元）；0 / 缺省 = 不折算 */
const creditsPerCny = computed(() => props.settings?.credits_per_cny ?? 0)
const rateOn = computed(() => hasCreditRate(creditsPerCny.value))
/** 折算率说明文案（设置页与页脚共用同一函数，口径不会写歪） */
const rateLabel = computed(() => rateText(creditsPerCny.value))

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

/** 某个数值折算成人民币估算值（单位是「元」直接返回原值；单位是「积分」按折算率；其它返回 null） */
function toCny(value: number | null | undefined, unit: string): number | null {
  return toCnyEstimate(value, unit, creditsPerCny.value)
}

/** 折算文案：'≈ 7.43 元'；算不出或数值为 0 返回空串（界面不显示多余的 ≈ 0.00 元） */
function cnyText(value: number | null | undefined, unit: string): string {
  const v = toCny(value, unit)
  if (v === null || v === 0) return ''
  return '≈ ' + fmtMoney(v)
}

/** 单位合计行没有现成的「逐日和」字段（totalAll 含停机），这里现算一次给折算列用 */
function unitDaySum(days: (number | null)[]): number | null {
  const vals = (days ?? []).filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v))
  return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : null
}

const totalByUnit = computed(() =>
  (report.value?.unitTotals ?? [])
    .map((u) => ({
      unit: u.unit,
      total: u.days.filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v)).reduce((a, b) => a + b, 0),
      /** 同口径的人民币估算值（无法折算时 null） */
      cny: toCnyEstimate(
        u.days.filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v)).reduce((a, b) => a + b, 0),
        u.unit,
        creditsPerCny.value
      )
    }))
    .filter((x) => x.total > 0)
    .sort((a, b) => (b.cny ?? Number.NEGATIVE_INFINITY) - (a.cny ?? Number.NEGATIVE_INFINITY) || b.total - a.total)
)

/** 可折算部分的合计（把「积分」和「元」真正加到一起，给出唯一一个可比的总额） */
const totalCny = computed(() => {
  const vals = totalByUnit.value.map((x) => x.cny).filter((v): v is number => v !== null && Number.isFinite(v))
  return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : null
})

/** 存在「积分」这类需要折算才可比的单位（决定是否提示折算率 / 是否可能折算失败） */
const hasCreditUnit = computed(() => totalByUnit.value.some((x) => unitKind(x.unit) === 'credit'))
/** 有单位没法折算（既不是元也不是积分，折算率也没开）——按原值排序，要如实说明 */
const hasUnconvertible = computed(() => totalByUnit.value.some((x) => x.cny === null))

/**
 * 平台对比：按期人民币估算值排序 + 定宽。
 * 修复：以前 barPct 用「原值 / 最大值」，1 积分和 1 元被当成同一量级，积分条永远满格、
 * 金额条几乎看不见，等于没在比。
 */
const platformBars = computed(() => {
  const ps = report.value?.platforms ?? []
  const rows = ps.map((p) => ({
    p,
    cny: toCny(p.total, p.unit),
    /** 无折算率时退回原值，保证「同类单位之间」仍然可比（同单位内部数值量级一致） */
    weigh: toCny(p.total, p.unit) ?? p.total ?? 0
  }))
  rows.sort((a, b) => b.weigh - a.weigh)
  const max = Math.max(0, ...rows.map((r) => r.weigh))
  return rows.map((r) => ({ ...r, pct: max > 0 ? Math.max(2, Math.round((r.weigh / max) * 100)) : 0 }))
})

const topPlatform = computed(() => platformBars.value[0] ?? null)

/** 窗口内「停机期间消耗」按单位汇总（软件未运行期间的余额下降，单独标记） */
const gapNotes = computed(() =>
  (report.value?.unitTotals ?? [])
    .filter((u) => (u.gapTotal ?? 0) > 0)
    .map((u) => ({ unit: u.unit, value: u.gapTotal }))
)

function exportCsv() {
  const r = report.value
  if (!r || r.platforms.length === 0) return
  const rows: (string | number | null | undefined)[][] = []
  rows.push(['平台', '类型', '单位', '今日', '7日均', '合计(含停机)', '折算人民币(估算)', '停机期间', '逐日合计', ...r.days.map((d) => d.label)])
  // 与界面同序（按折算值），导出的表也一眼看出谁更贵
  for (const { p } of platformBars.value) {
    rows.push([
      typeLabel(p.type),
      p.type,
      p.unit,
      p.today ?? '',
      p.avg7 === null || p.avg7 === undefined ? '' : p.avg7.toFixed(4),
      p.total ?? '',
      cnyText(p.total, p.unit).replace('≈ ', '') || '',
      p.gapTotal ? p.gapTotal : '',
      p.totalDaily ?? '',
      ...p.days.map((v) => (v === null || v === undefined ? '' : String(v)))
    ])
  }
  for (const u of r.unitTotals) {
    const total = u.days.filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v)).reduce((a, b) => a + b, 0)
    rows.push([
      '合计（' + u.unit + '）',
      '',
      u.unit,
      u.today ?? '',
      u.total7 ?? '',
      u.totalAll ?? '',
      cnyText(total, u.unit).replace('≈ ', '') || '',
      u.gapTotal || '',
      u.totalDaily ?? '',
      ...u.days.map((v) => (v === null || v === undefined ? '' : String(v)))
    ])
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
          <!-- 唯一一个「跨单位可比」的口径：把积分按折算率并到元上，才谈得上比较 -->
          <div class="chip" v-if="totalCny !== null">
            <div class="chip-label">
              折合人民币（估算）
              <InfoTip :text="'按「设置 → 成本折算」的折算率换算：' + rateLabel + '。积分和元数量级差很多，不折算就没法比；折算值只是同尺子基线的估算，不代表真实扣费。'" />
            </div>
            <div class="chip-value num accent">≈ {{ fmtMoney(totalCny) }}</div>
            <div class="chip-sub" v-if="hasCreditUnit">积分按 {{ rateLabel }} 折算</div>
          </div>
          <div class="chip">
            <div class="chip-label">消耗最多平台（按折算值）</div>
            <div class="chip-value" v-if="topPlatform">
              <span class="strong">{{ typeLabel(topPlatform.p.type) }}</span>
              <span class="chip-sub num">{{ fmtNumber(topPlatform.p.total) }} {{ topPlatform.p.unit }}</span>
              <span class="chip-sub num" v-if="cnyText(topPlatform.p.total, topPlatform.p.unit)">{{ cnyText(topPlatform.p.total, topPlatform.p.unit) }}</span>
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

        <!-- 换算口径必须写在界面上：否则用户不知道对比条是按什么排的 -->
        <div class="rate-note" :class="{ off: !rateOn, bad: rateOn && hasUnconvertible }">
          <span class="rate-ico">⇄</span>
          <template v-if="rateOn">
            <span>对比条与「消耗最多平台」都已按<strong>折合人民币</strong>排序定宽（积分 : 元 = 原值不同量级，直接比会失真）。</span>
            <b class="rate-val">{{ rateLabel }}</b>
            <span class="muted">折算值仅为估算（默认按 DeepSeek 高峰价反推），可在「设置 → 成本折算」修改。</span>
          </template>
          <template v-else>
            <span>未启用积分折算，对比条按<strong>各单位原值</strong>画：积分与金额之间不可比，请分开看。</span>
            <span class="muted">去「设置 → 成本折算」填「多少积分算 1 元」即可启用跨单位对比。</span>
          </template>
        </div>

        <div v-if="gapNotes.length" class="gap-note">
          <span class="gap-ico" title="软件未运行期间">⏸</span>
          <span>检测到<strong>停机期间消耗</strong>（软件未运行，无法按天归属）：</span>
          <b v-for="g in gapNotes" :key="g.unit" class="num gap-val">{{ fmtNumber(g.value) }} {{ g.unit }}</b>
          <span class="muted">已单独标记，不计入每日均值与合计口径之外的其他指标。</span>
        </div>

        <div class="bars-card">
          <div class="bars-title">平台消耗对比（近 {{ range }} 天 · 按折合人民币排序）</div>
          <div class="bar-row" v-for="b in platformBars" :key="b.p.type + b.p.unit">
            <div class="bar-info">
              <span class="bar-name">{{ typeLabel(b.p.type) }}</span>
              <span class="bar-type-muted">{{ b.p.type }}</span>
            </div>
            <div class="bar-track">
              <div class="bar-fill" :style="{ width: b.pct + '%' }"></div>
            </div>
            <div class="bar-num num">
              <span class="bar-orig">{{ fmtNumber(b.p.total) }} {{ b.p.unit }}</span>
              <span class="bar-cny" v-if="cnyText(b.p.total, b.p.unit)">{{ cnyText(b.p.total, b.p.unit) }}</span>
            </div>
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
                <th title="逐日之和 + 停机期间消耗（这段时间该平台总共掉了多少）">合计（含停机）</th>
                <th title="按「设置 → 成本折算」的折算率换算成人民币，用于跨平台比较（估算值）">折合人民币</th>
                <th title="软件未运行期间的余额下降；已计入左侧合计">停机期间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in report.platforms" :key="p.type + p.unit">
                <td class="tl"><span class="acc-name">{{ typeLabel(p.type) }}</span><span class="muted">{{ p.type }}</span></td>
                <td class="muted">{{ p.unit || '—' }}</td>
                <td v-for="(v, i) in p.days" :key="i" class="num" :class="{ dim: v === null }">{{ v === null ? '—' : fmtNumber(v) }}</td>
                <td class="num today">{{ p.today === null ? '—' : fmtNumber(p.today) }}</td>
                <td class="num">{{ p.avg7 === null ? '—' : fmtNumber(p.avg7) }}</td>
                <td class="num strong" :title="'逐日合计 ' + fmtNumber(p.totalDaily) + ' + 停机期间 ' + fmtNumber(p.gapTotal) + ' = ' + fmtNumber(p.total)">
                  {{ p.total === null ? '—' : fmtNumber(p.total) }}
                </td>
                <td class="num cny" :class="{ dim: !cnyText(p.total, p.unit) }">{{ cnyText(p.total, p.unit) || '—' }}</td>
                <td class="num gap" :class="{ dim: !p.gapTotal }">{{ p.gapTotal ? fmtNumber(p.gapTotal) : '—' }}</td>
              </tr>
            </tbody>
            <tfoot v-if="report.unitTotals.length">
              <tr v-for="u in report.unitTotals" :key="u.unit">
                <td class="tl strong">合计（{{ u.unit }}）</td>
                <td></td>
                <td v-for="(v, i) in u.days" :key="i" class="num strong">{{ v === null ? '—' : fmtNumber(v) }}</td>
                <td class="num strong">{{ u.today === null ? '—' : fmtNumber(u.today) }}</td>
                <td class="num strong">{{ u.total7 === null ? '—' : fmtNumber(u.total7) }}</td>
                <td class="num strong" :title="'逐日合计 ' + fmtNumber(u.totalDaily) + ' + 停机期间 ' + fmtNumber(u.gapTotal) + ' = ' + fmtNumber(u.totalAll)">
                  {{ u.totalAll === null ? '—' : fmtNumber(u.totalAll) }}
                </td>
                <td class="num strong cny" :class="{ dim: !cnyText(unitDaySum(u.days), u.unit) }">{{ cnyText(unitDaySum(u.days), u.unit) || '—' }}</td>
                <td class="num strong gap">{{ u.gapTotal ? fmtNumber(u.gapTotal) : '—' }}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <p v-if="report.note" class="note-line">{{ report.note }}</p>
        <p class="note-line">
          「折合人民币」是把不同单位的消耗放到同一把尺子上的估算口径：
          <template v-if="rateOn">{{ rateLabel }}（默认按 DeepSeek 高峰价反推；可在「设置 → 成本折算」修改）</template>
          <template v-else>当前未启用折算，只有「元」类单位会直接显示金额</template>
          。不同单位<strong>不能直接相加</strong>，积分和金额的数量级差很多，所以对比条按折算值排序定宽。
        </p>
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
.chip-value.accent { color: var(--acc); }
/* 换算口径说明条：折算开着是蓝色信息条，关掉是警示色，避免用户以为"数字不对" */
.rate-note {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  margin: 0 0 14px; padding: 10px 14px;
  background: var(--acc-soft); border: 1px solid var(--line);
  border-radius: 12px; font-size: var(--fs-foot); color: var(--tx2);
}
.rate-note.off { background: var(--warn-soft, rgba(255, 176, 32, 0.12)); border-color: var(--warn-line, rgba(255, 176, 32, 0.35)); }
.rate-note.bad { background: var(--warn-soft, rgba(255, 176, 32, 0.12)); border-color: var(--warn-line, rgba(255, 176, 32, 0.35)); }
.rate-ico { font-size: 13px; color: var(--acc); }
.rate-note.off .rate-ico, .rate-note.bad .rate-ico { color: var(--warn); }
.rate-val { color: var(--acc); font-variant-numeric: tabular-nums; }
.bars-card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px 18px; margin-bottom: 18px; box-shadow: var(--shadow-sm); }
.bars-title { font-size: var(--fs-foot); color: var(--tx3); font-weight: 600; margin-bottom: 10px; }
.bar-row { display: flex; align-items: center; gap: 12px; margin-bottom: 9px; }
.bar-info { width: 92px; flex: none; display: flex; flex-direction: column; gap: 1px; }
.bar-name { font-size: var(--fs-sub); font-weight: 600; color: var(--tx); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar-type-muted { font-size: 10.5px; color: var(--tx3); }
.bar-track { flex: 1; height: 22px; background: var(--panel2); border-radius: 999px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 999px; background: var(--acc-grad); min-width: 6px; transition: width 0.5s var(--ease); }
.bar-num { flex: none; min-width: 132px; text-align: right; font-size: var(--fs-sub); font-weight: 600; color: var(--tx); font-variant-numeric: tabular-nums; display: flex; flex-direction: column; gap: 1px; }
/* 金额估算值单独一行小字：原值（积分）不能直接和别家的元比，折算值才是可比数字 */
.bar-cny { font-size: 10.5px; font-weight: 600; color: var(--acc); }
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
.usage-table td.cny { color: var(--acc); }
.usage-table td.cny.dim { color: var(--tx3); }
.usage-table td.strong { font-weight: 700; color: var(--tx); }
.usage-table tfoot td { border-bottom: none; background: var(--acc-soft); }
/* 停机期间（软件未运行）消耗 */
.usage-table td.gap { color: var(--warn); font-weight: 600; }
.usage-table td.gap.dim { color: var(--tx3); font-weight: 400; }
.gap-note {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  margin: 0 0 14px; padding: 10px 14px;
  background: var(--warn-soft, rgba(255, 176, 32, 0.12));
  border: 1px solid var(--warn-line, rgba(255, 176, 32, 0.35));
  border-radius: 12px; font-size: var(--fs-foot); color: var(--tx2);
}
.gap-ico { font-size: 13px; }
.gap-val { color: var(--warn); font-variant-numeric: tabular-nums; }
.th-day.faint { color: transparent; }
.acc-name { display: block; font-weight: 600; color: var(--tx); }
.muted { color: var(--tx3); font-size: var(--fs-foot); }
.hint-box { margin: 30px auto; max-width: 520px; text-align: center; color: var(--tx3); font-size: var(--fs-sub); line-height: 1.8; padding: 22px; background: var(--card); border: 1px dashed var(--line-strong); border-radius: 14px; }
.hint-box.err { color: var(--err); border-color: var(--err-line); }
.note-line { margin-top: 14px; font-size: var(--fs-foot); color: var(--tx3); }
</style>