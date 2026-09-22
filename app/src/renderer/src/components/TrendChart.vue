<script setup lang="ts">
import { computed } from 'vue'
import { useId } from 'vue'
import { fmtClock, fmtNumber } from '@shared/format'

/**
 * 用量趋势折线图（纯 SVG 手绘，不引入图表库）。
 * 面积渐变 + 虚线网格 + 关键点；颜色继承父级 --card-acc。
 *
 * 2026-09-22 改版（用户要求）：横轴固定为 1 小时 / 6 小时 / 24 小时三个可选时间窗
 * （给定 spanMs 后 x 轴 = [endTs − spanMs, endTs]，不再按数据自适应），
 * 并显示 4~6 个均匀时间刻度（HH:mm），不再是"只有首尾两个时间"。
 * 不传 spanMs 时保持旧行为（按数据范围自适应），兼容其它调用方。
 */

interface TrendPoint {
  ts: number
  remaining: number | null
}

const props = defineProps<{
  data: TrendPoint[]
  /** 固定横轴窗口（毫秒）：1h / 6h / 24h；缺省 = 按数据自适应（旧行为） */
  spanMs?: number | null
  /** 窗口右端时间戳（毫秒）；缺省用最后一个数据点 */
  endTs?: number | null
}>()

const gradId = 'tc-' + useId().replace(/[^a-zA-Z0-9_-]/g, '')

/** 固定视口：宽 320 高 120，配合 preserveAspectRatio="none" 自适应拉伸 */
const W = 320
const H = 120

/** 刻度数量：1h / 6h / 24h 各 5 个（首尾 + 中间 3 个），均匀分布 */
const TICK_COUNT = 5

const raw = computed(() =>
  props.data
    .filter((p) => p && Number.isFinite(p.ts) && typeof p.remaining === 'number' && Number.isFinite(p.remaining))
    .map((p) => ({ ts: p.ts, remaining: p.remaining as number }))
)

/** 固定窗口 [start, end]；无 spanMs 时为 null（自适应模式） */
const win = computed(() => {
  if (!props.spanMs || props.spanMs <= 0) return null
  const last = raw.value.length > 0 ? raw.value[raw.value.length - 1].ts : Date.now()
  const end = typeof props.endTs === 'number' && Number.isFinite(props.endTs) ? props.endTs : last
  return { start: end - props.spanMs, end, span: props.spanMs }
})

/** 只画窗口内的点（固定轴模式） */
const pts = computed(() => {
  const list = raw.value
  const w = win.value
  if (!w) return list
  return list.filter((p) => p.ts >= w.start && p.ts <= w.end)
})

const enough = computed(() => pts.value.length >= 2)

const range = computed(() => {
  const list = pts.value
  if (list.length === 0) return null
  let minV = list[0].remaining
  let maxV = list[0].remaining
  for (const p of list) {
    if (p.remaining < minV) minV = p.remaining
    if (p.remaining > maxV) maxV = p.remaining
  }
  return { minV, maxV }
})

const mapped = computed(() => {
  const r = range.value
  const w = win.value
  if (!r || !enough.value) return []
  // y 轴上下各留 12% padding，避免折线贴边
  const pad = (r.maxV - r.minV) * 0.12 || Math.abs(r.maxV) * 0.12 || 1
  const yMin = r.minV - pad
  const yMax = r.maxV + pad
  if (w) {
    // 固定轴：x = 时间在窗口内的位置（与数据疏密无关）
    return pts.value.map((p) => {
      const x = Math.max(0, Math.min(W, ((p.ts - w.start) / w.span) * W))
      const y = H - ((p.remaining - yMin) / (yMax - yMin)) * H
      return { x, y }
    })
  }
  // 自适应轴（旧行为）
  const first = pts.value[0].ts
  const last = pts.value[pts.value.length - 1].ts
  const xSpan = last - first
  return pts.value.map((p) => {
    const x = xSpan > 0 ? ((p.ts - first) / xSpan) * W : W / 2
    const y = H - ((p.remaining - yMin) / (yMax - yMin)) * H
    return { x, y }
  })
})

const linePoints = computed(() => mapped.value.map((p) => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' '))

/** 面积路径：折线首尾闭合到底部 */
const areaPath = computed(() => {
  const m = mapped.value
  if (m.length === 0) return ''
  const head = 'M' + m[0].x.toFixed(1) + ' ' + m[0].y.toFixed(1)
  const mid = m
    .slice(1)
    .map((p) => 'L' + p.x.toFixed(1) + ' ' + p.y.toFixed(1))
    .join(' ')
  const tail = 'L' + m[m.length - 1].x.toFixed(1) + ' ' + H + ' L' + m[0].x.toFixed(1) + ' ' + H + ' Z'
  return head + ' ' + mid + ' ' + tail
})

const firstTs = computed(() => pts.value[0]?.ts ?? 0)
const lastTs = computed(() => pts.value[pts.value.length - 1]?.ts ?? 0)
const yMaxLabel = computed(() => range.value?.maxV ?? 0)
const yMinLabel = computed(() => range.value?.minV ?? 0)

/** 固定窗口模式的均匀刻度（时间戳 + 在轴上的位置比例） */
const ticks = computed(() => {
  const w = win.value
  if (!w) return []
  const out: { ts: number; frac: number }[] = []
  for (let i = 0; i < TICK_COUNT; i++) {
    const frac = i / (TICK_COUNT - 1)
    out.push({ ts: w.start + frac * w.span, frac })
  }
  return out
})

/** 刻度标签（HH:mm）；自适应模式为空 → 界面退回首尾两个时间 */
const tickLabels = computed(() => ticks.value.map((t) => fmtHm(t.ts)))

/** 固定窗口内没有任何快照时，给一句针对性的空态文案 */
const emptyText = computed(() => {
  if (win.value && raw.value.length > 0 && pts.value.length === 0) return '该时段暂无数据（换个时间范围或等下次刷新）'
  return '数据不足，多刷新几次后再看'
})

/** HH:mm（fmtClock 带秒，这里截掉秒） */
function fmtHm(ts: number): string {
  return fmtClock(ts).slice(0, 5)
}

/** 刻度标签定位：首/中/尾分别贴边/居中/右对齐，保证与网格线对齐 */
function tickStyle(i: number): Record<string, string> {
  const n = ticks.value.length
  const frac = n > 1 ? i / (n - 1) : 0
  const transform = i === 0 ? 'none' : i === n - 1 ? 'translateX(-100%)' : 'translateX(-50%)'
  return { left: (frac * 100).toFixed(4) + '%', transform }
}
</script>

<template>
  <div v-if="!enough" class="trend-empty">{{ emptyText }}</div>
  <div v-else class="trend-chart" :style="{ '--tc-acc': 'inherit' }">
    <div class="plot">
      <div class="y-axis">
        <span class="num">{{ fmtNumber(yMaxLabel) }}</span>
        <span class="num">{{ fmtNumber(yMinLabel) }}</span>
      </div>
      <div class="plot-svg-wrap">
        <svg class="plot-svg" viewBox="0 0 320 120" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient :id="gradId" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="var(--tc)" stop-opacity="0.32" />
              <stop offset="1" stop-color="var(--tc)" stop-opacity="0" />
            </linearGradient>
          </defs>
          <line x1="0" y1="40" x2="320" y2="40" class="grid" />
          <line x1="0" y1="80" x2="320" y2="80" class="grid" />
          <!-- 固定窗口模式：每个时间刻度一条竖向网格线，方便对照时间 -->
          <line
            v-for="(t, i) in ticks"
            :key="'tg' + i"
            :x1="t.frac * 320"
            y1="0"
            :x2="t.frac * 320"
            y2="120"
            class="grid"
          />
          <line x1="0" y1="120" x2="320" y2="120" class="grid" />
          <path :d="areaPath" class="area" :fill="'url(#' + gradId + ')'" />
          <polyline :points="linePoints" class="line" />
          <circle
            v-for="(p, i) in mapped"
            :key="i"
            :cx="p.x"
            :cy="p.y"
            r="2.2"
            class="dot"
          />
          <circle :cx="mapped[mapped.length - 1].x" :cy="mapped[mapped.length - 1].y" r="3.4" class="last-dot" />
        </svg>
      </div>
    </div>
    <!-- 固定窗口模式：均匀多刻度；自适应模式：沿用首尾两个时间 -->
    <div v-if="tickLabels.length" class="x-axis fixed">
      <span v-for="(lb, i) in tickLabels" :key="i" :style="tickStyle(i)">{{ lb }}</span>
    </div>
    <div v-else class="x-axis">
      <span>{{ fmtHm(firstTs) }}</span>
      <span>{{ fmtHm(lastTs) }}</span>
    </div>
  </div>
</template>

<style scoped>
.trend-empty {
  font-size: var(--fs-sub);
  color: var(--tx3);
  text-align: center;
  padding: 18px 0;
}

.trend-chart {
  display: flex;
  flex-direction: column;
  gap: 5px;
  /* 颜色继承父级卡片强调色；兜底主色 */
  --tc: var(--card-acc, var(--acc));
}

.plot {
  display: flex;
  gap: 8px;
  height: 112px;
}

.y-axis {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  font-size: var(--fs-foot);
  color: var(--tx3);
  min-width: 46px;
  text-align: right;
}

.plot-svg-wrap {
  flex: 1;
  min-width: 0;
}

.plot-svg {
  display: block;
  width: 100%;
  height: 100%;
}

.grid {
  stroke: rgba(255, 255, 255, 0.06);
  stroke-width: 1;
  stroke-dasharray: 3 5;
}

.line {
  fill: none;
  stroke: var(--tc);
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.area {
  vector-effect: non-scaling-stroke;
}

.dot {
  fill: var(--tc);
}

.last-dot {
  fill: var(--tc);
  stroke: rgba(255, 255, 255, 0.75);
  stroke-width: 1.4;
  vector-effect: non-scaling-stroke;
}

.x-axis {
  display: flex;
  justify-content: space-between;
  font-size: var(--fs-foot);
  color: var(--tx3);
  padding-left: 54px;
}

/* 固定窗口模式：标签按刻度位置绝对定位，与竖向网格线一一对齐 */
.x-axis.fixed {
  position: relative;
  height: 14px;
}

.x-axis.fixed > span {
  position: absolute;
  top: 0;
  white-space: nowrap;
}
</style>
