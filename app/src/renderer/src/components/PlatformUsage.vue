<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { PlatformUsageReport, Settings } from '@shared/types'
import { PROVIDER_META } from '@shared/constants'
import { fmtNumber, fmtMoney } from '@shared/format'
import { creditCny, compareWeight, hasCreditRate, isCreditUnit, rateText } from '@shared/cost'
import { getFx, listPlatformUsage } from '@renderer/api/ipc'
import { downloadCsv, todayStamp } from '@renderer/utils/csv'

/**
 * 「折合人民币」只对**积分型**单位（商汤这类）显示。
 *
 * 用户要求（2026-09-22）：DeepSeek / 硅基流动 等平台本来就是元/美元记账，直接看数字就行，
 * 不需要再折算一遍；只有积分和元放在一起对比时才是"没法比"的。所以：
 * - 折算只有一个入口 `creditCny()`，非积分单位一律返回 null → 界面留空；
 * - 以后新增积分型平台会自动走同一套逻辑，不用改界面。
 */
const props = defineProps<{ settings: Settings | null }>()

const loading = ref(false)
const error = ref('')
const report = ref<PlatformUsageReport | null>(null)
const range = ref<7 | 30>(7)
const exporting = ref(false)

/** 积分折算率（多少积分算 1 元）；0 / 缺省 = 不折算 */
const creditsPerCny = computed(() => props.settings?.credits_per_cny ?? 0)
/** 美元汇率（报表里出现美元单位时才取；主进程 1 小时缓存，取不到 = 美元暂按原值参与比较） */
const usdRate = ref(0)
/** 折算率说明文案（设置页与页脚共用同一函数，口径不会写歪） */
const rateLabel = computed(() => rateText(creditsPerCny.value))

async function load() {
  loading.value = true
  error.value = ''
  try {
    const r = await listPlatformUsage(range.value)
    if (r.ok) {
      report.value = r.data
      // 跨币种比较（2026-09-22）：报表里有美元单位 → 取汇率折成人民币参与对比条
      if (r.data.platforms.some((p) => p.unit === 'USD') && usdRate.value <= 0) {
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
  return !!r && r.days.length > 0 && r.platforms.length > 0
})

function typeLabel(t: string): string {
  const m = PROVIDER_META[t as keyof typeof PROVIDER_META]
  return m?.label ?? t
}

/** 折合人民币（估算）：**只有积分型单位**才有值，其它单位返回 null（界面显示空） */
function toCny(value: number | null | undefined, unit: string): number | null {
  return creditCny(value, unit, creditsPerCny.value)
}

/** 折算文案：'≈ 7.43 元'；非积分单位 / 算不出 / 为 0 一律返回空串（界面留空） */
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

const totalByUnit = computed(() => {
  const list = (report.value?.unitTotals ?? [])
    .map((u) => {
      const total = u.days.filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v)).reduce((a, b) => a + b, 0)
      return { unit: u.unit, total, cny: toCny(total, u.unit) }
    })
    .filter((x) => x.total > 0)
  // 排序也按折算金额（跨单位不裸比）；折不了回退原值
  const w = (x: { unit: string; total: number }): number =>
    compareWeight(x.total, x.unit, creditsPerCny.value, usdRate.value) ?? x.total
  return list.sort((a, b) => w(b) - w(a))
})

/**
 * 积分部分的合计（只有一个数、且只算积分型单位）。
 * 只要报表里没有积分型单位，这个卡就整个不显示（用户要求：不要给元/美元再折算一遍）。
 */
const totalCny = computed(() => {
  const vals = totalByUnit.value.map((x) => x.cny).filter((v): v is number => v !== null && Number.isFinite(v))
  return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : null
})

/** 折合人民币卡只在"确实有积分型单位"时出现 */
const showCnyCard = computed(() => totalByUnit.value.some((x) => isCreditUnit(x.unit)))
/** 有积分型单位但没开折算率 → 提示去设置里填（否则不提示，免得打扰） */
const creditRateMissing = computed(() => showCnyCard.value && !hasCreditRate(creditsPerCny.value))

/**
 * 平台对比：**统一折算成金额再比**（2026-09-22 用户要求跨币种也折算）——
 * 积分型按折算率折元、美元按汇率折元，其余（元等）原值即金额；
 * 折不了的回退原值（不比错）。**展示仍用原单位原值**（折算值只作对比条权重）。
 */
const platformBars = computed(() => {
  const ps = report.value?.platforms ?? []
  const rows = ps.map((p) => {
    const cny = toCny(p.total, p.unit)
    return {
      p,
      cny,
      /** 权重：跨单位折算成人民币金额；折不了回退原值 */
      weigh: compareWeight(p.total, p.unit, creditsPerCny.value, usdRate.value) ?? 0
    }
  })
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
  rows.push(['平台', '类型', '单位', '今日', '7日均', '合计(含停机)', '折合人民币(仅积分)', '停机期间', '逐日合计', ...r.days.map((d) => d.label)])
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
          <!-- 只有存在积分型单位（商汤这类）时才显示：元/美元本来就能直接看，不再折算一遍 -->
          <div class="chip" v-if="showCnyCard && totalCny !== null">
            <div class="chip-label">
              积分折合人民币（估算）
              <InfoTip :text="'只对积分型单位折算（商汤这类），元 / 美元单位不折算。折算率来自「设置 → 成本折算」：' + rateLabel + '。这是估算值，不代表真实扣费。'" />
            </div>
            <div class="chip-value num">≈ {{ fmtMoney(totalCny) }}</div>
            <div class="chip-sub">{{ rateLabel }}</div>
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

        <!-- 折算口径说明：只在**确实有积分型单位**时才出现，元/美元单位不折算也就不提示 -->
        <div v-if="showCnyCard" class="rate-note">
          <span class="rate-ico">⇄</span>
          <template v-if="creditRateMissing">
            <span><strong>积分</strong>没有折算率：积分型平台不参与对比条定宽（按原值画），也不能和金额直接比。</span>
            <span class="muted">去「设置 → 成本折算」填「多少积分算 1 元」即可启用。</span>
          </template>
          <template v-else>
            <span><strong>积分 / 美元</strong>统一折算成金额参与对比（元单位本身就是金额，直接看数字）。</span>
            <b class="rate-val">{{ rateLabel }}</b>
            <span class="muted">折算值仅为估算，可在「设置 → 成本折算」修改。</span>
          </template>
        </div>

        <div v-if="gapNotes.length" class="gap-note">
          <span class="gap-ico" title="软件未运行期间">⏸</span>
          <span>检测到<strong>停机期间消耗</strong>（软件未运行，无法按天归属）：</span>
          <b v-for="g in gapNotes" :key="g.unit" class="num gap-val">{{ fmtNumber(g.value) }} {{ g.unit }}</b>
          <span class="muted">已单独标记，不计入每日均值与合计口径之外的其他指标。</span>
        </div>

        <div class="bars-card">
          <div class="bars-title">平台消耗对比（近 {{ range }} 天）</div>
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
                <th title="只对积分型单位（商汤这类）按「设置 → 成本折算」的折算率估算；元 / 美元单位不折算，留空">折合人民币</th>
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
                <td class="num cny">{{ cnyText(p.total, p.unit) }}</td>
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
                <td class="num strong cny">{{ cnyText(unitDaySum(u.days), u.unit) }}</td>
                <td class="num strong gap">{{ u.gapTotal ? fmtNumber(u.gapTotal) : '—' }}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <p v-if="report.note" class="note-line">{{ report.note }}</p>
        <p class="note-line">
          「折合人民币」<strong>只对积分型单位</strong>（商汤这类）折算；元 / 美元单位本身就是金额、直接看数字即可，所以那几行留空。
          <template v-if="creditRateMissing">当前还没设积分折算率，去「设置 → 成本折算」填「多少积分算 1 元」即可。</template>
          <template v-else>{{ rateLabel }}（默认按 DeepSeek 高峰价反推，可在「设置 → 成本折算」修改）。</template>
          对比条与排序按<strong>折算金额</strong>统一比较（积分折元、美元按汇率折元），但表格展示仍是各自原单位；积分与金额<strong>不能直接相加</strong>。
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
/* 换算口径说明条：统一成朴素的信息条（不再因为"未启用折算"就整条变警示色） */
.rate-note {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  margin: 0 0 14px; padding: 10px 14px;
  background: var(--panel2); border: 1px solid var(--line);
  border-radius: 12px; font-size: var(--fs-foot); color: var(--tx2);
}
.rate-ico { font-size: 13px; color: var(--tx3); }
.rate-val { color: var(--tx); font-variant-numeric: tabular-nums; }
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
/* 停机期间（软件未运行）消耗：跟其它数字一样普通显示，不做强调（用户要求：不需要突出显示） */
.usage-table td.gap { font-variant-numeric: tabular-nums; }
/* 停机期间说明：普通提示文字，不做底色/边框/变色强调 */
.gap-note {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  margin: 0 0 14px; font-size: var(--fs-foot); color: var(--tx3);
}
.gap-ico { font-size: 13px; }
.gap-val { color: var(--tx2); font-variant-numeric: tabular-nums; }
.th-day.faint { color: transparent; }
.acc-name { display: block; font-weight: 600; color: var(--tx); }
.muted { color: var(--tx3); font-size: var(--fs-foot); }
.hint-box { margin: 30px auto; max-width: 520px; text-align: center; color: var(--tx3); font-size: var(--fs-sub); line-height: 1.8; padding: 22px; background: var(--card); border: 1px dashed var(--line-strong); border-radius: 14px; }
.hint-box.err { color: var(--err); border-color: var(--err-line); }
.note-line { margin-top: 14px; font-size: var(--fs-foot); color: var(--tx3); }
</style>