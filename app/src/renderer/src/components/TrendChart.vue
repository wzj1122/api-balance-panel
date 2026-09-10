<script setup lang="ts">
import { computed } from 'vue'
import { useId } from 'vue'
import { fmtClock, fmtNumber } from '@shared/format'

/**
 * 用量趋势折线图（纯 SVG 手绘，不引入图表库）。
 * 面积渐变 + 虚线网格 + 关键点；颜色继承卡片 --card-acc。
 */

interface TrendPoint {
  ts: number
  remaining: number | null
}

const props = defineProps<{
  data: TrendPoint[]
}>()

const gradId = 'tc-' + useId().replace(/[^a-zA-Z0-9_-]/g, '')

/** 固定视口：宽 320 高 120，配合 preserveAspectRatio="none" 自适应拉伸 */
const W = 320
const H = 120

const pts = computed(() =>
  props.data
    .filter((p) => p && Number.isFinite(p.ts) && typeof p.remaining === 'number' && Number.isFinite(p.remaining))
    .map((p) => ({ ts: p.ts, remaining: p.remaining as number }))
)

const enough = computed(() => pts.value.length >= 2)

const range = computed(() => {
  const list = pts.value
  if (list.length === 0) return null
  let minTs = list[0].ts
  let maxTs = list[0].ts
  let minV = list[0].remaining
  let maxV = list[0].remaining
  for (const p of list) {
    if (p.ts < minTs) minTs = p.ts
    if (p.ts > maxTs) maxTs = p.ts
    if (p.remaining < minV) minV = p.remaining
    if (p.remaining > maxV) maxV = p.remaining
  }
  return { minTs, maxTs, minV, maxV }
})

const mapped = computed(() => {
  const r = range.value
  if (!r || !enough.value) return []
  // y 轴上下各留 12% padding，避免折线贴边
  const pad = (r.maxV - r.minV) * 0.12 || Math.abs(r.maxV) * 0.12 || 1
  const yMin = r.minV - pad
  const yMax = r.maxV + pad
  const xSpan = r.maxTs - r.minTs
  return pts.value.map((p) => {
    const x = xSpan > 0 ? ((p.ts - r.minTs) / xSpan) * W : W / 2
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

const firstTs = computed(() => range.value?.minTs ?? 0)
const lastTs = computed(() => range.value?.maxTs ?? 0)
const yMaxLabel = computed(() => range.value?.maxV ?? 0)
const yMinLabel = computed(() => range.value?.minV ?? 0)

/** HH:mm（fmtClock 带秒，这里截掉秒） */
function fmtHm(ts: number): string {
  return fmtClock(ts).slice(0, 5)
}
</script>

<template>
  <div v-if="!enough" class="trend-empty">数据不足，多刷新几次后再看</div>
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
          <line x1="0" y1="0" x2="0" y2="120" class="grid" />
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
    <div class="x-axis">
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
</style>
