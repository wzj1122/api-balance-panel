<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { AccountView, CorrectionView } from '@shared/types'
import { fmtNumber } from '@shared/format'
import { correctionApply, correctionClear, correctionRemove, correctionView } from '@renderer/api/ipc'
import { providerLabel } from '@renderer/utils/text'
import { useFlash } from '@renderer/composables/useFlash'
import { useConfirm } from '@renderer/composables/useConfirm'
import InfoTip from './InfoTip.vue'
import SelectMenu from './SelectMenu.vue'

/**
 * 数据校正（主入口）。
 *
 * 三种安全操作（都能撤销，原始快照不动）：
 * ① 改某天的用量：把某账号某天的消耗改成实际值（内部换算成"那日起整体平移 delta"）
 * ② 回退到某次快照：让余额回到某条历史快照的值（该时刻起整体平移，后续消耗照常算得准）
 * ③ 手动平移 / 设为指定值：进阶用，等价于上面两种的底层操作
 *
 * 为什么只提供"从某一时刻起整体平移"：相邻快照的**差值**决定了每天消耗，
 * 整体平移不改变差值 ⇒ 之后每天的消耗依旧准确；只改单点会让那天的消耗变成黑洞。
 */

const props = defineProps<{
  accounts: AccountView[]
  /** 从其它页面跳转过来时预选的账号 */
  initialAccountId?: string
}>()

const selectedId = ref('')
const viewData = ref<CorrectionView | null>(null)
const loading = ref(false)

/** 提示（成功 flash 自动 5 秒消失；失败 fail 常驻到下一次提示） */
const { msg, err, flash, fail } = useFlash(5000)
const { confirm } = useConfirm()

/** 每日编辑表：日期 + 当前值 + 输入的新值 */
interface DayRow {
  ts: number
  label: string
  /** 该日当前消耗（校正后） */
  current: number | null
  /** 当日余额（校正后） */
  remaining: number | null
  /** 用户输入的新消耗（空 = 未改） */
  input: string
}
const dayRows = ref<DayRow[]>([])
const savingDay = ref<number | null>(null)
const savingDayOnly = ref<number | null>(null)
const ignoringDay = ref<number | null>(null)

/** 回退：选中的历史快照 + 目标余额输入 */
const rollbackTs = ref<number | null>(null)
const rollbackInput = ref('')
const rollbackBusy = ref(false)

const accounts = computed(() => props.accounts.filter((a) => !a.deleted_at))

/** 取某账号的校正视图并把快照整理成"按天"编辑表 */
async function load(accountId?: string): Promise<void> {
  const id = accountId ?? selectedId.value
  if (!id) {
    viewData.value = null
    dayRows.value = []
    return
  }
  loading.value = true
  try {
    const r = await correctionView(id)
    if (!r.ok) { fail(r.error); return }
    viewData.value = r.data
    // 按本地日期聚合快照：每天取最后一条余额 + 首末差当作当天消耗
    const byDay = new Map<number, { ts: number; remaining: number | null; first: number | null }>()
    for (const p of r.data.points) {
      const d = new Date(p.ts)
      d.setHours(0, 0, 0, 0)
      const key = d.getTime()
      const cur = byDay.get(key)
      if (!cur) byDay.set(key, { ts: p.ts, remaining: p.remaining, first: p.remaining })
      else cur.remaining = p.remaining
    }
    const keys = Array.from(byDay.keys()).sort((a, b) => b - a)
    const rows: DayRow[] = []
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      const cur = byDay.get(key)
      if (!cur) continue
      // 当天消耗 = 前一天的收盘余额 − 当天收盘余额（与统计口径一致的近似展示）
      const prevDay = byDay.get(keys[i + 1])
      const prevClose = prevDay ? prevDay.remaining : cur.first
      const consumption =
        prevClose !== null && cur.remaining !== null ? Math.round(Math.max(0, prevClose - cur.remaining) * 10000) / 10000 : null
      rows.push({
        ts: key,
        label: new Date(key).toLocaleDateString('zh-CN'),
        current: consumption,
        remaining: cur.remaining,
        input: ''
      })
    }
    dayRows.value = rows
    rollbackTs.value = r.data.points.length > 0 ? r.data.points[r.data.points.length - 1].ts : null
    rollbackInput.value = ''
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (props.initialAccountId && accounts.value.some((a) => a.id === props.initialAccountId)) {
    selectedId.value = props.initialAccountId
  } else if (accounts.value.length > 0) {
    selectedId.value = accounts.value[0].id
  }
  void load()
})

watch(selectedId, (id) => { void load(id) })
/** 外部跳转过来（带账号）时也重新加载 */
watch(() => props.initialAccountId, (id) => {
  if (id && accounts.value.some((a) => a.id === id)) {
    selectedId.value = id
    void load(id)
  }
})

/** ① 保存某天的新用量（影响该日起的整体平移） */
async function saveDay(row: DayRow): Promise<void> {
  const raw = row.input.trim()
  if (raw === '') return
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) { fail('请输入不小于 0 的数字'); return }
  savingDay.value = row.ts
  try {
    const r = await correctionApply({ accountId: selectedId.value, mode: 'day', dayTs: row.ts, value })
    if (!r.ok) { fail(r.error); return }
    flash(r.data.message)
    await load()
  } finally {
    savingDay.value = null
  }
}

/**
 * ①b 只改这一天（推荐）：把该天余额整体修正，让当天消耗变成目标值；
 * 之后的日期完全不受影响（用于"某次刷新读到错的余额"这类瞬时异常）。
 */
async function saveDayOnly(row: DayRow): Promise<void> {
  const raw = row.input.trim()
  if (raw === '') return
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) { fail('请输入不小于 0 的数字'); return }
  savingDayOnly.value = row.ts
  try {
    const r = await correctionApply({ accountId: selectedId.value, mode: 'dayBalance', dayTs: row.ts, value })
    if (!r.ok) { fail(r.error); return }
    flash(r.data.message)
    await load()
  } finally {
    savingDayOnly.value = null
  }
}

/** ①c 忽略这天：把该天异常读数从统计里剔除（比"改成某个数字"更彻底） */
async function ignoreDay(row: DayRow): Promise<void> {
  if (!(await confirm('忽略 ' + row.label + ' 的数据？该天将不计入消耗统计（可在下方账本里撤销）。', { title: '忽略这天' }))) return
  ignoringDay.value = row.ts
  try {
    const r = await correctionApply({ accountId: selectedId.value, mode: 'dayIgnore', dayTs: row.ts, value: 0 })
    if (!r.ok) { fail(r.error); return }
    flash(r.data.message)
    await load()
  } finally {
    ignoringDay.value = null
  }
}

/** 撤销单条校正 */
async function undo(id: string): Promise<void> {
  if (!(await confirm('撤销这条校正？该账号这一段的历史会立即还原成平台原始数据。', { title: '撤销校正' }))) return
  const r = await correctionRemove(id)
  if (!r.ok) { fail(r.error); return }
  flash('已撤销')
  await load()
}

/** 一键还原该账号全部校正 */
async function undoAll(): Promise<void> {
  if (!(await confirm('还原该账号的全部校正？历史会立即变回平台原始数据（原始快照一直没被改动）。', { title: '全部还原' }))) return
  const r = await correctionClear(selectedId.value)
  if (!r.ok) { fail(r.error); return }
  flash(`已还原 ${r.data.removed} 条校正`)
  await load()
}

/** ② 回退到选中的那次快照（余额回到当时的值） */
const rollbackPreview = computed(() => {
  const v = viewData.value
  if (!v || rollbackTs.value === null) return null
  const point = v.points.find((p) => p.ts === rollbackTs.value)
  if (!point) return null
  const target = point.remaining ?? 0
  const cur = v.points.length > 0 ? v.points[v.points.length - 1].remaining : null
  const delta = cur === null ? 0 : Math.round((target - cur) * 1e6) / 1e6
  return { point, target, cur, delta }
})

async function applyRollback(): Promise<void> {
  const v = viewData.value
  if (!v || rollbackTs.value === null) return
  const preview = rollbackPreview.value
  if (!preview || preview.delta === 0) { fail('当前余额与该快照一致，无需回退'); return }
  const custom = rollbackInput.value.trim()
  const target = custom === '' ? preview.target : Number(custom)
  if (!Number.isFinite(target)) { fail('余额数值不合法'); return }
  const delta = Math.round((target - (preview.cur ?? 0)) * 1e6) / 1e6
  if (delta === 0) { fail('当前余额与该目标一致，无需回退'); return }
  if (!(await confirm(
    `确认回退？\n\n账号：${v.name}\n回退到：${new Date(rollbackTs.value).toLocaleString('zh-CN')}\n` +
    `该时刻余额：${preview.point.remaining}\n当前余额：${preview.cur}\n` +
    `⇒ 该时刻起整体平移 ${delta}（后续每天的消耗算法不变，仍然准确）`,
    { title: '确认回退' }
  ))) return
  rollbackBusy.value = true
  try {
    const r = await correctionApply({
      accountId: selectedId.value,
      mode: 'offset',
      fromTs: rollbackTs.value,
      value: delta,
      note: `回退到 ${new Date(rollbackTs.value).toLocaleString('zh-CN')} 的余额`
    })
    if (!r.ok) { fail(r.error); return }
    flash(`已回退：该时刻起整体平移 ${delta}`)
    await load()
  } finally {
    rollbackBusy.value = false
  }
}

/** 快照下拉选项（最近优先，最多 200 条） */
const pointOptions = computed(() =>
  (viewData.value?.points ?? [])
    .slice()
    .reverse()
    .slice(0, 200)
    .map((p) => ({
      value: p.ts,
      // 「（已校正）」直接拼进 label：SelectMenu 只渲染 label，独立的 suffix 字段没有消费者
      label:
        new Date(p.ts).toLocaleString('zh-CN') +
        ' · ' +
        (p.remaining === null ? '无数据' : fmtNumber(p.remaining)) +
        (p.adjusted ? '（已校正）' : '')
    }))
)
</script>

<template>
  <section class="corr-pane">
    <div class="head">
      <h2>
        数据校正
        <InfoTip text="用于修正明显异常的历史数据（例如网络抖动导致某次刷新读到的余额不对）。原理：从某一时刻起把该账号的余额整体平移，相邻快照的差值不变，所以之后每天的消耗依旧算得准。原始快照不会被修改，随时可以撤销。" />
      </h2>
      <div class="tools">
        <SelectMenu
          v-if="accounts.length"
          :model-value="selectedId"
          :options="accounts.map((a) => ({ value: a.id, label: a.name + '（' + providerLabel(a.type) + '）' }))"
          @update:model-value="(v) => (selectedId = String(v))"
        />
        <button class="btn ghost" type="button" :disabled="loading" @click="load()">刷新</button>
      </div>
    </div>

    <div class="scroll">
      <div v-if="msg" class="flash ok">{{ msg }}</div>
      <div v-if="err" class="flash err">{{ err }}</div>

      <div v-if="accounts.length === 0" class="empty-box">还没有账号，先添加账号再来校正数据。</div>

      <template v-else-if="viewData">
        <div class="summary">
          <span class="cur-acc">{{ viewData.name }} · {{ providerLabel(viewData.type) }}</span>
          <span v-if="viewData.offset !== 0" class="badge on">当前已校正 {{ viewData.offset > 0 ? '+' : '' }}{{ viewData.offset }} {{ viewData.unit }}</span>
          <span v-else class="badge">当前未校正</span>
          <span class="muted">共 {{ viewData.corrections.length }} 条校正记录</span>
          <button v-if="viewData.corrections.length" class="btn ghost tiny danger" type="button" @click="undoAll">全部还原</button>
        </div>

        <!-- ① 改某天用量 -->
        <div class="sec-title">① 改某天用量</div>
        <p class="hint">
          填该账号这一天的实际消耗（0 = 这天其实没花钱）。<b>推荐点「只改这天」</b>：只把这一天的余额修正到目标值，<b>后面的日期完全不受影响</b>
          ——某次刷新因网络读到错的余额时用这个。右边「改这天起」会把该日之后的数据一起平移（少用）。
        </p>
        <div v-if="dayRows.length === 0" class="empty-box">该账号还没有历史快照，先让面板跑几轮刷新。</div>
        <table v-else class="tbl day-tbl">
          <thead>
            <tr>
              <th class="tl">日期</th>
              <th>当天消耗</th>
              <th>当天收盘余额</th>
              <th>改成</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in dayRows.slice(0, 60)" :key="row.ts">
              <td class="tl">{{ row.label }}</td>
              <td class="num strong">{{ row.current === null ? '—' : fmtNumber(row.current) }} <span class="muted">{{ viewData.unit }}</span></td>
              <td class="num muted">{{ row.remaining === null ? '—' : fmtNumber(row.remaining) }}</td>
              <td>
                <input v-model="row.input" class="input mini" type="number" min="0" step="0.01" :placeholder="row.current === null ? '—' : String(row.current)" />
              </td>
              <td class="ops-cell">
                <button class="btn tiny primary" type="button" :disabled="row.input.trim() === '' || savingDayOnly === row.ts" @click="saveDayOnly(row)">
                  {{ savingDayOnly === row.ts ? '处理中…' : '只改这天' }}
                </button>
                <button class="btn tiny ghost" type="button" :disabled="ignoringDay === row.ts" @click="ignoreDay(row)">
                  {{ ignoringDay === row.ts ? '处理中…' : '忽略这天' }}
                </button>
                <button class="btn tiny ghost" type="button" :disabled="row.input.trim() === '' || savingDay === row.ts" @click="saveDay(row)">
                  {{ savingDay === row.ts ? '处理中…' : '改这天起' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="dayRows.length > 60" class="hint">（只显示最近 60 天，更早的数据可用下方「回退」或直接看趋势确认）</p>

        <!-- ② 回退到某次状态 -->
        <div class="sec-title">② 回退到某次状态</div>
        <p class="hint">
          选一条历史快照作为基准（或直接填一个准确的余额），确认后「该时刻起整体平移」：
          余额回到当时的值，后续每天的消耗不受影响（平移不改变相邻差值）。
        </p>
        <div class="field-inline">
          <span class="f-label">回退到</span>
          <SelectMenu
            v-if="rollbackTs !== null"
            :model-value="rollbackTs"
            :options="pointOptions"
            @update:model-value="(v) => (rollbackTs = Number(v))"
          />
          <span class="muted">共 {{ viewData.points.length }} 条快照</span>
        </div>
        <div v-if="rollbackPreview" class="preview">
          <div>该时刻余额：<b class="num">{{ rollbackPreview.point.remaining === null ? '—' : fmtNumber(rollbackPreview.point.remaining) }}</b> {{ viewData.unit }}</div>
          <div>当前余额：<b class="num">{{ rollbackPreview.cur === null ? '—' : fmtNumber(rollbackPreview.cur) }}</b> {{ viewData.unit }}</div>
          <div>将整体平移：<b class="num" :class="{ warn: rollbackPreview.delta !== 0 }">{{ rollbackPreview.delta > 0 ? '+' : '' }}{{ fmtNumber(rollbackPreview.delta) }}</b> {{ viewData.unit }}</div>
          <div class="field-inline">
            <span class="f-label">或直接填准确余额</span>
            <input v-model="rollbackInput" class="input mini" type="number" step="0.01" placeholder="留空 = 用上面的历史余额" />
          </div>
          <button class="btn primary" type="button" :disabled="rollbackBusy" @click="applyRollback">
            {{ rollbackBusy ? '处理中…' : '确认回退' }}
          </button>
        </div>

        <!-- ③ 校正账本 -->
        <div class="sec-title">③ 校正记录（可撤销）</div>
        <div v-if="viewData.corrections.length === 0" class="empty-box">还没有校正记录。</div>
        <table v-else class="tbl">
          <thead>
            <tr><th class="tl">生效时间</th><th>类型</th><th>数值</th><th>影响快照</th><th class="tl">备注</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="c in viewData.corrections" :key="c.id">
              <td class="tl">
                {{ new Date(c.fromTs).toLocaleString('zh-CN') }}
                <span v-if="c.toTs" class="muted">（仅当天）</span>
              </td>
              <td>{{ c.kind === 'offset' ? '整体平移' : c.kind === 'ignore' ? '忽略该段' : '设为指定值' }}</td>
              <td class="num strong">{{ c.kind === 'ignore' ? '—' : (c.value > 0 ? '+' : '') + fmtNumber(c.value) }}</td>
              <td class="num muted">{{ viewData.affected[c.id] ?? 0 }} 条</td>
              <td class="tl note-cell">{{ c.note || '—' }}</td>
              <td><button class="btn ghost tiny danger" type="button" @click="undo(c.id)">撤销</button></td>
            </tr>
          </tbody>
        </table>

        <p class="note-line">
          说明：校正只影响面板显示与统计，<strong>不会改动平台上的任何数据</strong>；原始快照（snapshots.json）也从不被修改，
          校正记录单独存在 <code>corrections.json</code> 里，撤销即还原。日均、耗尽预估、预算判断都会跟着校正后的数据重算。
        </p>
      </template>
    </div>
  </section>
</template>

<style scoped>
.corr-pane { display: flex; flex-direction: column; height: 100%; }
.head { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; padding: 20px var(--pad-lg) 8px; }
.head h2 { font-size: 19px; font-weight: 700; color: var(--tx-strong); margin: 0; display: flex; align-items: center; gap: 8px; }
.tools { display: flex; align-items: center; gap: 8px; }
.scroll { flex: 1; overflow-y: auto; padding: 8px var(--pad-lg) 40px; }
.flash { margin: 6px 0 10px; padding: 8px 12px; border-radius: 10px; font-size: 12.5px; }
.flash.ok { background: var(--ok-soft); color: var(--tx); }
.flash.err { background: var(--err-soft); color: var(--err); }
.summary { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 6px 0 10px; font-size: 12.5px; color: var(--tx2); }
.cur-acc { font-weight: 700; color: var(--tx-strong); }
.badge { font-size: 11.5px; border-radius: 999px; padding: 2px 10px; background: var(--panel2); color: var(--tx3); }
.badge.on { background: var(--warn-soft); color: var(--warn); font-weight: 600; }
.sec-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--tx); margin: 18px 0 8px; }
.sec-title::before { content: ''; width: 3px; height: 12px; border-radius: 2px; background: var(--acc-grad); }
.hint { font-size: 12px; color: var(--tx3); line-height: 1.7; margin: 4px 0 8px; }
.empty-box { padding: 18px; border-radius: 12px; border: 1px dashed var(--line-strong); background: var(--card); color: var(--tx3); font-size: 13px; text-align: center; }
.tbl { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 12px; overflow: hidden; box-shadow: inset 0 0 0 1px var(--line); }
.tbl th { background: var(--panel2); color: var(--tx2); font-size: 12px; font-weight: 600; padding: 8px 10px; text-align: center; }
.tbl td { padding: 7px 10px; font-size: 12.5px; color: var(--tx); text-align: center; box-shadow: inset 0 -1px 0 var(--line-soft); }
.tbl th.tl, .tbl td.tl { text-align: left; }
.day-tbl { max-height: none; }
.input.mini { width: 110px; }
.field-inline { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 8px 0; }
.f-label { font-size: var(--fs-sub); color: var(--tx2); }
.preview { background: var(--panel2); border-radius: 12px; padding: 12px 14px; font-size: 12.5px; color: var(--tx2); display: flex; flex-direction: column; gap: 6px; }
.preview b { color: var(--tx-strong); }
.preview b.warn { color: var(--warn); }
.note-cell { max-width: 320px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ops-cell { display: flex; gap: 6px; justify-content: center; flex-wrap: wrap; }
.btn.tiny.primary { background: var(--acc); color: var(--on-acc); border-color: transparent; }
.btn.tiny.primary:disabled { opacity: 0.5; }
.note-line { margin: 14px 0 var(--gap); font-size: var(--fs-foot, 12px); color: var(--tx3); line-height: 1.8; }
.note-line code { background: var(--panel2); border-radius: 4px; padding: 1px 5px; }
.muted { color: var(--tx3); }
.btn.tiny { padding: 3px 10px; font-size: 11.5px; }
.btn.tiny.danger { color: var(--err); }
</style>
