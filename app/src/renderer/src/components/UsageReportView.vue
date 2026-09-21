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

/** 当前查看的单位（多单位时用顶部小标签切换，避免"数值大的单位盖掉另一个"） */
const activeUnit = ref('')

const units = computed(() => report.value?.totalByUnit ?? [])
/** 当前单位的完整明细：平台构成 / 最多账号 / 时段分布 / 充值 都跟着它走 */
const detail = computed(() => {
  const list = report.value?.unitDetails ?? []
  if (list.length === 0) return null
  return list.find((u) => u.unit === activeUnit.value) ?? list[0]
})

/** 主数值 = 当前单位合计（修复：以前读错了字段，顶部大数字一直是 undefined） */
const total = computed(() => detail.value?.total ?? 0)
const unit = computed(() => detail.value?.unit ?? report.value?.unit ?? '')

function typeLabel(t: string): string {
  const m = PROVIDER_META[t as keyof typeof PROVIDER_META]
  return m?.label ?? t
}

const deltaText = computed(() => {
  const d = detail.value?.deltaPct
  if (d === null || d === undefined) return null
  const up = d >= 0
  return { text: (up ? '↑ ' : '↓ ') + Math.abs(d).toFixed(0) + '%', up }
})

const peakHour = computed(() => {
  const hours = detail.value?.activeHours ?? []
  let best: { hour: number; value: number } | null = null
  for (const h of hours) if (!best || h.value > best.value) best = h
  return best && best.value > 0 ? best.hour : null
})

/** 统计格单源：分享卡片（canvas）与页面 hero-grid 共用同一份数据，改口径只动这一处 */
const statCells = computed<{ k: string; v: string }[]>(() => {
  const d = detail.value
  if (!d) return []
  return [
    { k: '活跃天数', v: d.activeDays + ' / ' + d.totalDays + ' 天' },
    { k: '日均消耗', v: d.avgDaily === null ? '—' : fmtNumber(d.avgDaily) },
    { k: '涉及平台', v: String(d.platformShare.length) + ' 个' },
    { k: '高峰时段', v: peakHour.value === null ? '—' : String(peakHour.value).padStart(2, '0') + ':00' }
  ]
})

const maxHour = computed(() => {
  const hours = detail.value?.activeHours ?? []
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
  // 单位行同样防溢出（极端情况下单位名很长）
  fitFont(ctx, unit.value || ' ', 600, 34, 20, W - 66 - 64)
  ctx.fillText(unit.value || '', 66, 370)
  // 下方两行（「其它单位」/「较上期」）**各自独占一行、按行高递推 baseline**：
  // 修复：以前两行写死 y=370 / 408 / 424，24px 与 30px 字号的字高都超过 16px 间距，字被压在一起。
  let hy = 370
  // 行距 46：34px 单位行下面接 24/30px 的小字，留出「字底边 + 空隙」，任何主题下都不会叠
  const LINE = 46
  // 多单位时把其它单位也印上，避免"只看到积分、以为 CNY 没算"（每个单位一行，不与下面那行挤同一 baseline）
  if (units.value.length > 1) {
    hy += LINE
    ctx.fillStyle = '#7f8ca3'
    ctx.font = '600 24px system-ui, "Microsoft YaHei", sans-serif'
    const others = units.value.filter((u) => u.unit !== unit.value).map((u) => u.unit + ' ' + fmtNumber(u.value)).join('　·　')
    // 长文本缩字号后再自动换行，绝不越出画布右边（原来固定 24px 单行，单位一多就被裁掉）
    fitFont(ctx, '其它单位：' + others, 600, 24, 15, W - 64 - 66)
    for (const line of wrapText(ctx, '其它单位：' + others, W - 64 - 66)) {
      ctx.fillText(line, 66, hy)
      hy += LINE
    }
    hy -= LINE
  }
  if (deltaText.value) {
    hy += LINE
    ctx.fillStyle = deltaText.value.up ? '#ff9d7a' : '#5ee0b0'
    ctx.font = '700 30px system-ui, "Microsoft YaHei", sans-serif'
    ctx.fillText('较上期 ' + deltaText.value.text, 66, hy)
  }
  // 数据格起始位置跟着上面实际画了几行往下挪，保证不压字（基线 + 字号底边 + 行距）
  const gridTop = Math.max(468, hy + 34)
  // 数据格（与页面 hero-grid 共用 statCells，见 script 中定义）
  const cells = statCells.value
  cells.forEach((c, i) => {
    const x = 60 + (i % 2) * 400
    const y = gridTop + Math.floor(i / 2) * 116
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
  // 平台占比（标题跟着数据格底部走，避免多一行时压到数据格）
  const shareTop = gridTop + 96 + (Math.ceil(cells.length / 2) - 1) * 116 + 52
  ctx.fillStyle = '#8fb4ff'
  ctx.font = '600 26px system-ui, "Microsoft YaHei", sans-serif'
  ctx.fillText('消耗构成 · ' + (unit.value || ''), 64, shareTop)
  const shares = (detail.value?.platformShare ?? []).slice(0, 4)
  shares.forEach((s, i) => {
    const y = shareTop + 44 + i * 64
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
  // 里程碑：贴着占比区底部往下排，最多 3 行，且不越过页脚基线（H-40）
  const ms = r.milestones.slice(0, 3)
  const msTop = Math.min(shareTop + 44 + Math.max(1, shares.length) * 64 + 18, H - 40 - ms.length * 34)
  ms.forEach((m, i) => {
    ctx.fillStyle = '#7f8ca3'
    ctx.font = '400 24px system-ui, "Microsoft YaHei", sans-serif'
    ctx.fillText('· ' + m, 64, msTop + i * 34)
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

/** 缩字号直到整行放得下 maxW（不小于 minPx），返回实际字号（内部已把 ctx.font 设成该字号） */
function fitFont(ctx: CanvasRenderingContext2D, text: string, weight: number, px: number, minPx: number, maxW: number): void {
  let size = px
  const set = (s: number): void => { ctx.font = weight + ' ' + s + 'px system-ui, "Microsoft YaHei", sans-serif' }
  set(size)
  // 逐级缩小（1px 一步，最多降到 minPx）：中文一行放不下就缩小，再放不下才交给 wrapText 换行
  while (size > minPx && ctx.measureText(text).width > maxW) {
    size -= 1
    set(size)
  }
}

/** 按画布宽度把一行文本拆成多行（优先在分隔符处断，断不开就逐字断），返回每行文本 */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  if (ctx.measureText(text).width <= maxW) return [text]
  const lines: string[] = []
  let cur = ''
  for (const ch of text) {
    const next = cur + ch
    if (cur && ctx.measureText(next).width > maxW) {
      lines.push(cur)
      cur = ch
    } else {
      cur = next
    }
  }
  if (cur) lines.push(cur)
  return lines
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
          <div class="hero-label">{{ report.title }} · {{ unit || '—' }}</div>
          <div class="hero-value num">{{ fmtNumber(total) }}</div>
          <div class="hero-sub">
            <span v-if="deltaText" class="delta" :class="{ up: deltaText.up }">较上期 {{ deltaText.text }}</span>
            <span v-else class="muted">暂无上期对比数据</span>
          </div>
          <!-- 多单位：每个单位都给一个数字，避免"积分盖掉 CNY"；点标签切换下方明细 -->
          <div v-if="units.length > 1" class="unit-strip">
            <span class="us-label">各单位：</span>
            <button
              v-for="u in units"
              :key="u.unit"
              class="unit-chip"
              :class="{ on: u.unit === unit }"
              type="button"
              @click="activeUnit = u.unit"
            >
              {{ u.unit }} <b class="num">{{ fmtNumber(u.value) }}</b>
            </button>
            <span class="muted small">（不同单位不能相加，点选可切换下方明细）</span>
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
            <div class="panel-title">消耗构成 · {{ unit }}</div>
            <div v-if="!detail || detail.platformShare.length === 0" class="muted small">本期没有消耗记录</div>
            <div v-for="s in detail?.platformShare ?? []" :key="s.type" class="share-row">
              <span class="share-name">{{ typeLabel(s.type) }}</span>
              <span class="share-track"><span class="share-fill" :style="{ width: s.pct + '%' }"></span></span>
              <span class="share-num num">{{ fmtNumber(s.value) }}</span>
              <span class="share-pct num">{{ s.pct.toFixed(0) }}%</span>
            </div>
          </div>

          <div class="panel">
            <div class="panel-title">
              时段分布 · {{ unit }}
              <InfoTip text="把相邻两次快照之间的余额下降归到对应小时。刷新间隔越短越精确；默认 5 分钟刷新时可准确到小时级，30 分钟刷新只能粗略参考。" />
            </div>
            <div class="hours">
              <div v-for="h in detail?.activeHours ?? []" :key="h.hour" class="hour-col" :title="String(h.hour).padStart(2, '0') + ':00 消耗 ' + fmtNumber(h.value)">
                <div class="hour-bar" :style="{ height: Math.max(2, Math.round((h.value / maxHour) * 100)) + '%' }"></div>
                <span class="hour-label" v-if="h.hour % 6 === 0">{{ h.hour }}</span>
                <span class="hour-label" v-else></span>
              </div>
            </div>
            <div class="small muted">采样精度：约 {{ report.sampleMinutes }} 分钟/次</div>
            <div v-if="detail?.topAccount" class="small muted">
              消耗最多：{{ detail.topAccount.name }} {{ fmtNumber(detail.topAccount.value) }} {{ detail.unit }}
              <template v-if="detail.topDay"> · 单日峰值 {{ detail.topDay.label }} {{ fmtNumber(detail.topDay.value) }}</template>
            </div>
          </div>
        </div>

        <div class="panel" v-if="report.milestones.length">
          <div class="panel-title">这段时间的你</div>
          <ul class="ms-list">
            <li v-for="(m, i) in report.milestones" :key="i">{{ m }}</li>
          </ul>
        </div>

        <div class="panel" v-if="(detail?.recharges?.length ?? 0) > 0">
          <div class="panel-title">疑似充值记录 · {{ unit }}</div>
          <ul class="ms-list">
            <li v-for="(rc, i) in detail?.recharges ?? []" :key="i">
              {{ fmtClock(rc.ts) }} · {{ rc.name }} 增加 {{ fmtNumber(rc.amount) }} {{ rc.unit }}
            </li>
          </ul>
        </div>

        <p class="note-line">报告全部基于本机余额快照计算，不含任何模型调用明细（平台接口不提供）。不同单位的消耗分开统计、互不相加。</p>
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
.hero-card { position: relative; background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 22px 26px; box-shadow: var(--shadow-sm); overflow: hidden; background-image: linear-gradient(120deg, var(--acc-soft) 0%, transparent 60%); margin-bottom: var(--gap); }
.hero-label { font-size: 12px; color: var(--tx3); font-weight: 600; letter-spacing: 0.4px; }
.hero-value { font-size: 46px; font-weight: 800; color: var(--tx-strong); line-height: 1.15; margin: 4px 0 2px; font-variant-numeric: tabular-nums; }
.hero-sub { font-size: 12.5px; color: var(--tx3); }
/* 多单位切换条：每个单位都给一个数字，避免"数值大的单位盖掉另一个" */
.unit-strip { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.us-label { font-size: 12px; color: var(--tx3); }
.unit-chip { background: var(--panel2); border: 1px solid var(--line); color: var(--tx2); border-radius: 999px; padding: 3px 12px; font-size: 12px; cursor: pointer; transition: border-color var(--dur) ease, color var(--dur) ease; }
.unit-chip b { color: var(--tx-strong); margin-left: 4px; }
.unit-chip.on { border-color: var(--acc); color: var(--acc); }
.unit-chip.on b { color: var(--acc); }
.delta { font-weight: 700; color: var(--ok); }
.delta.up { color: var(--err); }
.hero-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin-top: 18px; }
.hg-item { background: var(--panel2); border-radius: 12px; padding: 10px 14px; }
.hg-k { font-size: 11.5px; color: var(--tx3); }
.hg-v { font-size: 18px; font-weight: 700; color: var(--tx); font-variant-numeric: tabular-nums; }
/* 竖向排布统一用 margin-bottom（不用 margin-top）：相邻块间距就是 var(--gap)，
   不会因为 margin 折叠/相邻而出现「有的有间距、有的贴在一起」 */
.two-col { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: var(--gap); margin-bottom: var(--gap); }
/* 顶层卡片：hero / 两列容器 / 说明行都是顶层块，统一 16px 间距；
   .two-col 里的面板由 grid 的 gap 负责，排除掉避免叠加（:not() 用后代选择器，不支持的老内核会整条忽略，届时只是间距照旧，不影响其它样式） */
.panel { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px 18px; box-shadow: var(--shadow-sm); }
.panel:not(.two-col .panel) { margin-bottom: var(--gap); }
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
.note-line { margin: 0 0 var(--gap); font-size: var(--fs-foot); color: var(--tx3); }
.muted { color: var(--tx3); }
.small { font-size: 11.5px; }
</style>