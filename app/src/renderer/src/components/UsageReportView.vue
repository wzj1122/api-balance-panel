<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { ReportPeriod, UsageReport } from '@shared/types'
import { PROVIDER_META } from '@shared/constants'
import { fmtClock, fmtNumber } from '@shared/format'
import { getUsageReport } from '@renderer/api/ipc'
import InfoTip from './InfoTip.vue'

const loading = ref(false)
const error = ref('')
const report = ref<UsageReport | null>(null)
const period = ref<ReportPeriod>('month')
const cardMsg = ref('')

const PERIODS: { id: ReportPeriod; label: string }[] = [
  { id: 'day', label: '日报' },
  { id: 'week', label: '周报' },
  { id: 'month', label: '月报' }
]

async function load() {
  loading.value = true
  error.value = ''
  try {
    const r = await getUsageReport(period.value)
    if (r.ok) report.value = r.data
    else error.value = r.error
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

onMounted(load)

function setPeriod(p: ReportPeriod) {
  period.value = p
  void load()
}

const hasData = computed(() => !!report.value && report.value.totalByUnit.length > 0)

const total = computed(() => (report.value && report.value.totalByUnit.length > 0 ? report.value.totalByUnit[0].value : 0))

function typeLabel(t: string): string {
  const m = PROVIDER_META[t as keyof typeof PROVIDER_META]
  return m?.label ?? t
}

const deltaText = computed(() => {
  const d = report.value?.deltaPct
  if (d === null || d === undefined) return null
  const up = d >= 0
  return { text: (up ? '↑ ' : '↓ ') + Math.abs(d).toFixed(0) + '%', up }
})

const peakHour = computed(() => {
  const hours = report.value?.activeHours ?? []
  let best: { hour: number; value: number } | null = null
  for (const h of hours) if (!best || h.value > best.value) best = h
  return best && best.value > 0 ? best.hour : null
})

/** 统计格单源：分享卡片（canvas）与页面 hero-grid 共用同一份数据，改口径只动这一处 */
const statCells = computed<{ k: string; v: string }[]>(() => {
  const r = report.value
  if (!r) return []
  return [
    { k: '活跃天数', v: r.activeDays + ' / ' + r.totalDays + ' 天' },
    { k: '日均消耗', v: r.avgDaily === null ? '—' : fmtNumber(r.avgDaily) },
    { k: '涉及平台', v: String(r.platformShare.length) + ' 个' },
    { k: '高峰时段', v: peakHour.value === null ? '—' : String(peakHour.value).padStart(2, '0') + ':00' }
  ]
})

const maxHour = computed(() => {
  const hours = report.value?.activeHours ?? []
  return Math.max(1, ...hours.map((h) => h.value))
})

/** 生成分享卡片（canvas 绘制后导出 PNG） */
function makeCard() {
  const r = report.value
  if (!r) return
  const W = 900
  const H = 1340
  const canvas = document.createElement('canvas')
  canvas.width = W * 2
  canvas.height = H * 2
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.scale(2, 2)
  // 背景
  const bg = ctx.createLinearGradient(0, 0, W, H)
  bg.addColorStop(0, '#0d1220')
  bg.addColorStop(0.55, '#131a2b')
  bg.addColorStop(1, '#0a0f1a')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)
  // 光斑
  const glow = ctx.createRadialGradient(700, 150, 20, 700, 150, 420)
  glow.addColorStop(0, 'rgba(79,140,255,0.42)')
  glow.addColorStop(1, 'rgba(79,140,255,0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, W, 620)
  const glow2 = ctx.createRadialGradient(180, 980, 20, 180, 980, 380)
  glow2.addColorStop(0, 'rgba(34,211,238,0.28)')
  glow2.addColorStop(1, 'rgba(34,211,238,0)')
  ctx.fillStyle = glow2
  ctx.fillRect(0, 620, W, H - 620)
  // 顶部品牌
  ctx.fillStyle = '#8fb4ff'
  ctx.font = '600 26px system-ui, "Microsoft YaHei", sans-serif'
  ctx.fillText('API 余额面板 · ' + r.title, 64, 96)
  ctx.fillStyle = '#5c6b85'
  ctx.font = '400 22px system-ui, "Microsoft YaHei", sans-serif'
  const d = new Date(r.fromTs)
  const d2 = new Date(r.toTs)
  ctx.fillText(period.value === 'day' ? fmtDate(d) : fmtDate(d) + ' — ' + fmtDate(d2), 64, 134)
  // 总消耗
  ctx.fillStyle = '#ffffff'
  ctx.font = '800 112px system-ui, "Microsoft YaHei", sans-serif'
  ctx.fillText(fmtNumber(total.value), 60, 320)
  ctx.fillStyle = '#7f8ca3'
  ctx.font = '600 34px system-ui, "Microsoft YaHei", sans-serif'
  ctx.fillText(r.unit || '', 66, 370)
  if (deltaText.value) {
    ctx.fillStyle = deltaText.value.up ? '#ff9d7a' : '#5ee0b0'
    ctx.font = '700 30px system-ui, "Microsoft YaHei", sans-serif'
    ctx.fillText('较上期 ' + deltaText.value.text, 66, 424)
  }
  // 数据格（与页面 hero-grid 共用 statCells，见 script 中定义）
  const cells = statCells.value
  cells.forEach((c, i) => {
    const x = 60 + (i % 2) * 400
    const y = 500 + Math.floor(i / 2) * 116
    ctx.fillStyle = 'rgba(255,255,255,0.045)'
    roundRect(ctx, x, y, 360, 96, 18)
    ctx.fill()
    ctx.fillStyle = '#6b7891'
    ctx.font = '500 22px system-ui, "Microsoft YaHei", sans-serif'
    ctx.fillText(c.k, x + 26, y + 38)
    ctx.fillStyle = '#eaf0fb'
    ctx.font = '700 32px system-ui, "Microsoft YaHei", sans-serif'
    ctx.fillText(c.v, x + 26, y + 76)
  })
  // 平台占比
  ctx.fillStyle = '#8fb4ff'
  ctx.font = '600 26px system-ui, "Microsoft YaHei", sans-serif'
  ctx.fillText('消耗构成', 64, 780)
  const shares = r.platformShare.slice(0, 4)
  shares.forEach((s, i) => {
    const y = 824 + i * 64
    ctx.fillStyle = '#c9d4e6'
    ctx.font = '500 26px system-ui, "Microsoft YaHei", sans-serif'
    ctx.fillText(typeLabel(s.type), 64, y + 22)
    const barW = 460
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    roundRect(ctx, 330, y, barW, 26, 13)
    ctx.fill()
    const grad = ctx.createLinearGradient(330, 0, 330 + barW, 0)
    grad.addColorStop(0, '#4f8cff')
    grad.addColorStop(1, '#22d3ee')
    ctx.fillStyle = grad
    roundRect(ctx, 330, y, Math.max(14, (barW * s.pct) / 100), 26, 13)
    ctx.fill()
    ctx.fillStyle = '#8b98ad'
    ctx.font = '600 22px system-ui, "Microsoft YaHei", sans-serif'
    ctx.fillText(s.pct.toFixed(0) + '%', 810, y + 21)
  })
  // 里程碑
  const ms = r.milestones.slice(0, 3)
  // 里程碑上移，与页脚留出安全间距（原来从 y=1100 起会压到 1164 的页脚）
  ms.forEach((m, i) => {
    ctx.fillStyle = '#7f8ca3'
    ctx.font = '400 24px system-ui, "Microsoft YaHei", sans-serif'
    ctx.fillText('· ' + m, 64, 1140 + i * 34)
  })
  // 页脚
  ctx.fillStyle = '#4a5568'
  ctx.font = '400 20px system-ui, "Microsoft YaHei", sans-serif'
  ctx.fillText('数据来自本机余额快照 · 由 API 余额面板生成', 64, H - 40)
  // 下载
  const url = canvas.toDataURL('image/png')
  const a = document.createElement('a')
  a.href = url
  a.download = 'AI使用报告-' + r.title.replace(/\s/g, '') + '-' + fmtDate(new Date()) + '.png'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  cardMsg.value = '分享卡片已保存到下载目录 ✓'
  setTimeout(() => { cardMsg.value = '' }, 2600)
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

function fmtDate(d: Date): string {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}
</script>

<template>
  <section class="report-pane">
    <div class="head">
      <h2>
        AI 使用报告
        <InfoTip text="报告只基于本机记录的余额消耗金额（各平台接口不提供按模型 / Token 的调用明细）。时段分布由快照采样推断，采样越密越准（默认 5 分钟刷新时可定位到小时级）。" />
      </h2>
      <div class="tools">
        <div class="seg">
          <button v-for="p in PERIODS" :key="p.id" type="button" :class="{ on: period === p.id }" @click="setPeriod(p.id)">
            {{ p.label }}
          </button>
        </div>
        <button class="btn ghost" type="button" :disabled="loading" @click="load">刷新</button>
        <button class="btn primary" type="button" :disabled="!hasData" @click="makeCard">生成分享卡片</button>
      </div>
    </div>

    <div class="scroll">
      <div v-if="loading && !report"><div class="sk-wrap"><div class="skeleton sk-card"></div><div class="skeleton sk-row"></div><div class="skeleton sk-row short"></div></div></div>
      <div v-else-if="error" class="hint-box err">{{ error }}</div>

      <template v-else-if="report">
        <div v-if="cardMsg" class="probe-msg">{{ cardMsg }}</div>

        <div class="hero-card">
          <div class="hero-label">{{ report.title }} · {{ report.unit || '—' }}</div>
          <div class="hero-value num">{{ fmtNumber(total) }}</div>
          <div class="hero-sub">
            <span v-if="deltaText" class="delta" :class="{ up: deltaText.up }">较上期 {{ deltaText.text }}</span>
            <span v-else class="muted">暂无上期对比数据</span>
          </div>
          <div class="hero-grid">
            <div v-for="c in statCells" :key="c.k" class="hg-item">
              <div class="hg-k">{{ c.k }}</div>
              <div class="hg-v num">{{ c.v }}</div>
            </div>
          </div>
        </div>

        <div class="two-col">
          <div class="panel">
            <div class="panel-title">消耗构成</div>
            <div v-if="report.platformShare.length === 0" class="muted small">本期没有消耗记录</div>
            <div v-for="s in report.platformShare" :key="s.type + s.unit" class="share-row">
              <span class="share-name">{{ typeLabel(s.type) }}</span>
              <span class="share-track"><span class="share-fill" :style="{ width: s.pct + '%' }"></span></span>
              <span class="share-num num">{{ fmtNumber(s.value) }}</span>
              <span class="share-pct num">{{ s.pct.toFixed(0) }}%</span>
            </div>
          </div>

          <div class="panel">
            <div class="panel-title">
              时段分布
              <InfoTip text="把相邻两次快照之间的余额下降归到对应小时。刷新间隔越短越精确；默认 5 分钟刷新时可准确到小时级，30 分钟刷新只能粗略参考。" />
            </div>
            <div class="hours">
              <div v-for="h in report.activeHours" :key="h.hour" class="hour-col" :title="String(h.hour).padStart(2, '0') + ':00 消耗 ' + fmtNumber(h.value)">
                <div class="hour-bar" :style="{ height: Math.max(2, Math.round((h.value / maxHour) * 100)) + '%' }"></div>
                <span class="hour-label" v-if="h.hour % 6 === 0">{{ h.hour }}</span>
                <span class="hour-label" v-else></span>
              </div>
            </div>
            <div class="small muted">采样精度：约 {{ report.sampleMinutes }} 分钟/次</div>
          </div>
        </div>

        <div class="panel" v-if="report.milestones.length">
          <div class="panel-title">这段时间的你</div>
          <ul class="ms-list">
            <li v-for="(m, i) in report.milestones" :key="i">{{ m }}</li>
          </ul>
        </div>

        <div class="panel" v-if="report.recharges.length">
          <div class="panel-title">疑似充值记录</div>
          <ul class="ms-list">
            <li v-for="(rc, i) in report.recharges" :key="i">
              {{ fmtClock(rc.ts) }} · {{ rc.name }} 增加 {{ fmtNumber(rc.amount) }} {{ rc.unit }}
            </li>
          </ul>
        </div>

        <p class="note-line">报告全部基于本机余额快照计算，不含任何模型调用明细（平台接口不提供）。</p>
      </template>

      <div v-else class="hint-box">还没有历史数据：让面板跑几轮刷新，积累一两天后报告就有内容了。</div>
    </div>
  </section>
</template>

<style scoped>
.report-pane { display: flex; flex-direction: column; height: 100%; }
.head { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; padding: 20px var(--pad-lg) 8px; }
.head h2 { font-size: 19px; font-weight: 700; color: var(--tx-strong); margin: 0; display: flex; align-items: center; gap: 8px; }
.tools { display: flex; align-items: center; gap: 8px; }
.seg { display: inline-flex; gap: 4px; background: var(--panel2); border: 1px solid var(--line); border-radius: 10px; padding: 3px; }
.seg button { border: none; background: transparent; color: var(--tx2); font-size: var(--fs-sub); font-weight: 500; padding: 5px 12px; border-radius: 8px; cursor: pointer; transition: background var(--dur) ease, color var(--dur) ease; }
.seg button.on { background: var(--card); color: var(--acc); font-weight: 600; box-shadow: var(--shadow-sm); }
.scroll { flex: 1; overflow-y: auto; padding: 8px var(--pad-lg) 40px; }
.probe-msg { margin: 6px 0 10px; padding: 8px 12px; border-radius: 10px; background: var(--ok-soft); color: var(--tx); font-size: 12.5px; }
.hero-card { position: relative; background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 22px 26px; box-shadow: var(--shadow-sm); overflow: hidden; background-image: linear-gradient(120deg, var(--acc-soft) 0%, transparent 60%); }
.hero-label { font-size: 12px; color: var(--tx3); font-weight: 600; letter-spacing: 0.4px; }
.hero-value { font-size: 46px; font-weight: 800; color: var(--tx-strong); line-height: 1.15; margin: 4px 0 2px; font-variant-numeric: tabular-nums; }
.hero-sub { font-size: 12.5px; color: var(--tx3); }
.delta { font-weight: 700; color: var(--ok); }
.delta.up { color: var(--err); }
.hero-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin-top: 18px; }
.hg-item { background: var(--panel2); border-radius: 12px; padding: 10px 14px; }
.hg-k { font-size: 11.5px; color: var(--tx3); }
.hg-v { font-size: 18px; font-weight: 700; color: var(--tx); font-variant-numeric: tabular-nums; }
.two-col { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: var(--gap); margin-top: var(--gap); }
.panel { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px 18px; box-shadow: var(--shadow-sm); }
.panel-title { font-size: var(--fs-foot); color: var(--tx3); font-weight: 600; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
.share-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.share-name { width: 96px; flex: none; font-size: 12.5px; color: var(--tx); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.share-track { flex: 1; height: 16px; background: var(--track); border-radius: 999px; overflow: hidden; }
.share-fill { display: block; height: 100%; border-radius: 999px; background: var(--acc-grad); }
.share-num { width: 74px; text-align: right; font-size: 12px; color: var(--tx2); font-variant-numeric: tabular-nums; }
.share-pct { width: 40px; text-align: right; font-size: 11.5px; color: var(--tx3); font-variant-numeric: tabular-nums; }
.hours { display: flex; align-items: flex-end; gap: 2px; height: 110px; }
.hour-col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; }
.hour-bar { width: 100%; background: var(--acc-grad); border-radius: 3px 3px 0 0; min-height: 2px; transition: height 0.4s var(--ease); }
.hour-label { font-size: 9.5px; color: var(--tx3); height: 12px; }
.ms-list { margin: 0; padding-left: 18px; }
.ms-list li { font-size: 12.5px; color: var(--tx2); line-height: 1.9; }
.ms-list li::marker { color: var(--acc); }
.hint-box { margin: 30px auto; max-width: 520px; text-align: center; color: var(--tx3); font-size: var(--fs-sub); line-height: 1.8; padding: 22px; background: var(--card); border: 1px dashed var(--line-strong); border-radius: 14px; }
.hint-box.err { color: var(--err); border-color: var(--err-line); }
.note-line { margin-top: 14px; font-size: var(--fs-foot); color: var(--tx3); }
.muted { color: var(--tx3); }
.small { font-size: 11.5px; }
</style>