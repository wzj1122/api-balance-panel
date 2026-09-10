<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { MonitorCheck, MonitorInput, MonitorStat, MonitorView } from '@shared/types'
import { fmtAgo, fmtClock } from '@shared/format'
import { listMonitorChecks, listMonitors, listKeys, removeMonitor, revealKey, runMonitors, saveMonitor, testMonitor } from '@renderer/api/ipc'
import BaseModal from './BaseModal.vue'
import InfoTip from './InfoTip.vue'

interface Row { monitor: MonitorView; stat: MonitorStat }

const loading = ref(false)
const running = ref(false)
const error = ref('')
const note = ref('')
const rows = ref<Row[]>([])
const runMsg = ref('')

/** 编辑弹窗状态 */
const dialogOpen = ref(false)
const editingId = ref<string | null>(null)

const DEFAULT_BODY =
  '{\n  "model": "deepseek-chat",\n  "messages": [{ "role": "user", "content": "ping" }],\n  "max_tokens": 1\n}'

interface MonitorForm {
  name: string
  url: string
  method: 'GET' | 'POST'
  secret: string
  body: string
  headerText: string
  interval_minutes: number
  timeout_ms: number
}

/** 表单字段单源：新建/编辑共用默认值，以后加字段只需改这一处 */
function emptyForm(): MonitorForm {
  return {
    name: '',
    url: '',
    method: 'POST',
    secret: '',
    body: DEFAULT_BODY,
    headerText: '',
    interval_minutes: 10,
    timeout_ms: 20000
  }
}

const form = ref<MonitorForm>(emptyForm())
const testMsg = ref('')
/** Key 列表（可直接选一个 Key 作为监控目标） */
const keyOptions = ref<{ id: string; name: string; type: string; baseUrl: string }[]>([])
const pickedKey = ref('')

async function loadKeyOptions() {
  const r = await listKeys()
  if (!r.ok) return
  keyOptions.value = r.data.rows
    .filter((row) => row.type === 'deepseek' || row.type === 'newapi' || row.type === 'custom')
    .map((row) => ({ id: row.id, name: row.name, type: row.type, baseUrl: row.baseUrl }))
}

/** 选中 Key 后自动填名称 / 调用地址 / 密钥 */
async function applyPickedKey(id: string) {
  if (!id) return
  const row = keyOptions.value.find((k) => k.id === id)
  if (!row) return
  const base = (row.baseUrl || (row.type === 'deepseek' ? 'https://api.deepseek.com' : '')).replace(/\/+$/, '')
  form.value.name = row.name
  form.value.method = 'POST'
  form.value.url = base ? base + (row.type === 'newapi' ? '/v1/chat/completions' : '/chat/completions') : ''
  const res = await revealKey(row.id)
  if (res.ok) form.value.secret = res.data
  testMsg.value = '已从 Key 列表填入「' + row.name + '」，可直接试跑或保存'
}
const testing = ref(false)
const saving = ref(false)

/** 展开的历史 */
const historyFor = ref<string | null>(null)
const history = ref<MonitorCheck[]>([])
const historyLoading = ref(false)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const r = await listMonitors(30)
    if (r.ok) {
      rows.value = r.data.monitors
      note.value = r.data.note
    } else {
      error.value = r.error
    }
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
  void loadKeyOptions()
})

function openAdd() {
  editingId.value = null
  form.value = emptyForm()
  testMsg.value = ''
  dialogOpen.value = true
}

function openEdit(m: MonitorView) {
  editingId.value = m.id
  form.value = {
    ...emptyForm(),
    name: m.name,
    url: m.url,
    method: m.method,
    body: m.body || DEFAULT_BODY,
    headerText: Object.entries(m.headers || {})
      .map(([k, v]) => k + ': ' + v)
      .join('\n'),
    interval_minutes: m.interval_minutes,
    timeout_ms: m.timeout_ms
  }
  testMsg.value = ''
  dialogOpen.value = true
}

/** 把「每行一个 Header: value」解析成对象 */
function parseHeaders(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of (form.value.headerText || '').split('\n')) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const k = line.slice(0, idx).trim()
    const v = line.slice(idx + 1).trim()
    if (k) out[k] = v
  }
  return out
}

function buildInput(): MonitorInput {
  return {
    id: editingId.value ?? undefined,
    name: form.value.name,
    url: form.value.url,
    method: form.value.method,
    body: form.value.body,
    headers: parseHeaders(),
    secret: form.value.secret,
    interval_minutes: form.value.interval_minutes,
    timeout_ms: form.value.timeout_ms,
    enabled: true
  }
}

function checkText(c: { ok: boolean; status: number; latency_ms: number; error: string }): string {
  if (c.ok) return '✓ HTTP ' + c.status + ' · ' + c.latency_ms + ' ms'
  if (c.status === 0) return '✗ ' + (c.error || '请求失败')
  return '✗ HTTP ' + c.status + ' · ' + (c.error || '').slice(0, 60)
}

async function doTest() {
  testing.value = true
  testMsg.value = '正在试跑…（这是一次真实请求）'
  try {
    const r = await testMonitor(buildInput())
    testMsg.value = r.ok ? checkText(r.data) : '试跑失败：' + r.error
  } finally {
    testing.value = false
  }
}

async function doSave() {
  if (!form.value.url.trim()) {
    testMsg.value = '请先填写调用地址'
    return
  }
  saving.value = true
  try {
    const r = await saveMonitor(buildInput())
    if (r.ok) {
      dialogOpen.value = false
      await load()
    } else {
      testMsg.value = '保存失败：' + r.error
    }
  } finally {
    saving.value = false
  }
}

async function runNow(id?: string) {
  running.value = true
  runMsg.value = id ? '正在检查…' : '正在检查全部目标…'
  try {
    const r = await runMonitors(id)
    if (r.ok) {
      const ok = r.data.filter((c) => c.ok).length
      runMsg.value = '检查完成：' + ok + ' / ' + r.data.length + ' 次成功'
      await load()
    } else {
      runMsg.value = '检查失败：' + r.error
    }
  } finally {
    running.value = false
  }
}

/** 从行数据构造 MonitorInput（与 buildInput 同一字段表；headers 深拷贝为普通对象） */
function monitorToInput(m: MonitorView): MonitorInput {
  return {
    id: m.id,
    name: m.name,
    url: m.url,
    method: m.method,
    body: m.body,
    headers: JSON.parse(JSON.stringify(m.headers || {})),
    interval_minutes: m.interval_minutes,
    timeout_ms: m.timeout_ms,
    enabled: !m.enabled
  }
}

async function toggleEnabled(m: MonitorView) {
  // 注意：m 来自响应式行数据，直接传 IPC 会因 Proxy 无法结构化克隆而失败，
  // monitorToInput 里已把 headers 深拷贝成普通对象。
  const r = await saveMonitor(monitorToInput(m))
  if (r.ok) await load()
  else runMsg.value = '操作失败：' + r.error
}

async function doRemove(m: MonitorView) {
  const sure = window.confirm('删除监控目标「' + m.name + '」？历史记录会一并删除。')
  if (!sure) return
  const r = await removeMonitor(m.id)
  if (r.ok) await load()
}

async function openHistory(id: string) {
  if (historyFor.value === id) {
    historyFor.value = null
    return
  }
  historyFor.value = id
  historyLoading.value = true
  try {
    const r = await listMonitorChecks(id, 60)
    history.value = r.ok ? [...r.data].reverse() : []
  } finally {
    historyLoading.value = false
  }
}

function pctText(v: number | null): string {
  return v === null ? '—' : (v * 100).toFixed(v >= 0.995 ? 0 : 1) + '%'
}

function latencyText(v: number | null): string {
  return v === null ? '—' : Math.round(v) + ' ms'
}

function statusOf(stat: MonitorStat): 'ok' | 'warn' | 'down' | 'none' {
  if (stat.total === 0) return 'none'
  if (stat.consecutiveFails >= 3 || (stat.successRate !== null && stat.successRate < 0.5)) return 'down'
  if (stat.consecutiveFails > 0 || (stat.successRate !== null && stat.successRate < 0.98)) return 'warn'
  return 'ok'
}

function statusText(stat: MonitorStat): string {
  const s = statusOf(stat)
  if (s === 'none') return '尚未检查'
  if (s === 'down') return '不可用'
  if (s === 'warn') return '有波动'
  return '正常'
}

function dayClass(rate: number | null): string {
  if (rate === null) return 'none'
  if (rate >= 0.99) return 'full'
  if (rate >= 0.6) return 'part'
  return 'low'
}

const enabledCount = computed(() => rows.value.filter((r) => r.monitor.enabled).length)
const okCount = computed(() => rows.value.filter((r) => r.stat.lastOk === true).length)
</script>

<template>
  <div class="monitor">
    <div class="mtools">
      <button class="btn primary" type="button" @click="openAdd">+ 添加监控目标</button>
      <button class="btn ghost" type="button" :disabled="running || rows.length === 0" @click="runNow()">
        {{ running ? '检查中…' : '立即检查全部' }}
      </button>
      <button class="btn ghost" type="button" :disabled="loading" @click="load">刷新</button>
      <InfoTip text="这里监控的是你自己填写的接口：面板按设定间隔真实调用该地址，记录成功/失败、HTTP 状态与响应耗时，算出可用率与延迟。LLM 接口会产生极少量费用（默认请求体已把 max_tokens 设为 1）。窗口最小化后仍会继续检查。" />
      <span class="mstat" v-if="rows.length > 0">
        {{ enabledCount }} 个监控中 · {{ okCount }} 个最近正常
      </span>
    </div>

    <div v-if="runMsg" class="probe-msg">{{ runMsg }}</div>
    <div v-if="error" class="hint-box err">{{ error }}</div>

    <div v-if="rows.length === 0 && !loading" class="hint-box">
      {{ note || '还没有监控目标：点「添加监控目标」，填写调用地址与 API Key，面板会按间隔真实调用它。' }}
    </div>

    <div v-for="r in rows" :key="r.monitor.id" class="mcard" :class="{ off: !r.monitor.enabled }">
      <div class="mhead">
        <span class="dot" :class="statusOf(r.stat)"></span>
        <span class="mname">{{ r.monitor.name }}</span>
        <span class="mbadge" :class="statusOf(r.stat)">{{ statusText(r.stat) }}</span>
        <span v-if="!r.monitor.enabled" class="mbadge paused">已暂停</span>
        <span class="mmeta">{{ r.monitor.method }}</span>
        <span class="murl" :title="r.monitor.url">{{ r.monitor.url }}</span>
        <span class="mops">
          <button class="btn ghost tiny" type="button" :disabled="running" @click="runNow(r.monitor.id)">检查</button>
          <button class="btn ghost tiny" type="button" @click="openEdit(r.monitor)">编辑</button>
          <button class="btn ghost tiny" type="button" @click="toggleEnabled(r.monitor)">
            {{ r.monitor.enabled ? '暂停' : '启用' }}
          </button>
          <button class="btn ghost tiny danger" type="button" @click="doRemove(r.monitor)">删除</button>
        </span>
      </div>

      <div class="mgrid">
        <div class="mfield">
          <span class="mk">最近检查</span>
          <span class="mv" v-if="r.stat.lastTs !== null">
            <span :class="r.stat.lastOk ? 'ok-text' : 'bad-text'">
              {{ r.stat.lastOk ? '✓ HTTP ' + r.stat.lastStatus : '✗ ' + (r.stat.lastStatus === 0 ? '请求失败' : 'HTTP ' + r.stat.lastStatus) }}
            </span>
            <span class="muted"> · {{ fmtAgo(r.stat.lastTs) }}</span>
          </span>
          <span class="mv muted" v-else>尚未检查</span>
        </div>
        <div class="mfield">
          <span class="mk">可用率</span>
          <span class="mv num">{{ pctText(r.stat.successRate) }}</span>
        </div>
        <div class="mfield">
          <span class="mk">平均 / P95</span>
          <span class="mv num">{{ latencyText(r.stat.avgLatency) }} / {{ latencyText(r.stat.p95Latency) }}</span>
        </div>
        <div class="mfield">
          <span class="mk">连续失败</span>
          <span class="mv num" :class="{ 'bad-text': r.stat.consecutiveFails > 0 }">{{ r.stat.consecutiveFails }}</span>
        </div>
        <div class="mfield">
          <span class="mk">今日 / 总计</span>
          <span class="mv num">{{ r.stat.checksToday }} / {{ r.stat.total }} 次</span>
        </div>
        <div class="mfield">
          <span class="mk">间隔</span>
          <span class="mv num">每 {{ r.monitor.interval_minutes }} 分钟</span>
        </div>
        <div class="mfield">
          <span class="mk">密钥</span>
          <span class="mv">{{ r.monitor.has_secret ? r.monitor.secret_masked : '未设置' }}</span>
        </div>
      </div>

      <div v-if="r.stat.lastError" class="merr">{{ r.stat.lastError }}</div>

      <div class="mfoot">
        <span class="mk">近 30 天</span>
        <span class="daystrip">
          <span
            v-for="d in r.stat.days"
            :key="d.ts"
            class="daycell"
            :class="dayClass(d.rate)"
            :title="d.label + '：' + (d.total === 0 ? '未检查' : d.ok + '/' + d.total + ' 成功')"
          ></span>
        </span>
        <button class="btn ghost tiny" type="button" @click="openHistory(r.monitor.id)">
          {{ historyFor === r.monitor.id ? '收起记录' : '检查记录' }}
        </button>
      </div>

      <div v-if="historyFor === r.monitor.id" class="mhistory">
        <div v-if="historyLoading" class="muted small">加载中…</div>
        <div v-else-if="history.length === 0" class="muted small">还没有检查记录</div>
        <table v-else class="hist-table">
          <thead>
            <tr><th class="tl">时间</th><th>结果</th><th>耗时</th><th class="tl">说明</th></tr>
          </thead>
          <tbody>
            <tr v-for="c in history" :key="c.ts">
              <td class="tl num">{{ fmtClock(c.ts) }}</td>
              <td :class="c.ok ? 'ok-text' : 'bad-text'">{{ c.ok ? '成功' : '失败' }}</td>
              <td class="num">{{ c.latency_ms }} ms</td>
              <td class="tl muted">{{ c.ok ? 'HTTP ' + c.status : (c.status === 0 ? c.error : 'HTTP ' + c.status + ' · ' + c.error) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <BaseModal :open="dialogOpen" :title="editingId ? '编辑监控目标' : '添加监控目标'" @close="dialogOpen = false">
      <div class="form">
        <label class="frow">
          <span class="flabel">从 Key 列表选择（可选）</span>
          <select v-model="pickedKey" class="input" @change="applyPickedKey(pickedKey)">
            <option value="">— 手动填写 —</option>
            <option v-for="k in keyOptions" :key="k.id" :value="k.id">{{ k.name }}（{{ k.type }}）</option>
          </select>
          <span class="fhelp">选一个已保存的 Key，会自动填入名称、调用地址与密钥。</span>
        </label>
        <label class="frow">
          <span class="flabel">名称</span>
          <input v-model="form.name" class="input" placeholder="例如：DeepSeek 对话接口" />
        </label>
        <label class="frow">
          <span class="flabel">调用地址</span>
          <input v-model="form.url" class="input" placeholder="https://api.deepseek.com/chat/completions" />
        </label>
        <div class="frow">
          <span class="flabel">请求方法</span>
          <div class="seg">
            <button type="button" :class="{ on: form.method === 'POST' }" @click="form.method = 'POST'">POST</button>
            <button type="button" :class="{ on: form.method === 'GET' }" @click="form.method = 'GET'">GET</button>
          </div>
          <InfoTip text="LLM 接口用 POST + 最小对话体（max_tokens=1）；只想测连通性可以用 GET（很多平台提供 /models 之类的只读接口，0 费用）。" />
        </div>
        <label class="frow">
          <span class="flabel">API Key</span>
          <input v-model="form.secret" class="input" type="password" :placeholder="editingId ? '留空 = 不修改已保存的密钥' : 'sk-...'" />
        </label>
        <label class="frow" v-if="form.method === 'POST'">
          <span class="flabel">请求体</span>
          <textarea v-model="form.body" class="input area" rows="7"></textarea>
        </label>
        <label class="frow">
          <span class="flabel">自定义请求头</span>
          <textarea v-model="form.headerText" class="input area" rows="3" placeholder="每行一个，例如&#10;x-api-key: {{key}}&#10;X-Group-Id: 123"></textarea>
        </label>
        <p class="fhelp">支持 <code v-text="'{{key}}'"></code> 占位符，会替换成上面的 API Key。默认会自动带上 <code>Authorization: Bearer &lt;key&gt;</code>（若你自定义了 Authorization / x-api-key 则不重复添加）。</p>
        <div class="frow">
          <span class="flabel">检查间隔</span>
          <span class="inline-input">
            每
            <input v-model.number="form.interval_minutes" class="input mini" type="number" min="1" max="1440" />
            分钟一次，超时
            <input v-model.number="form.timeout_ms" class="input mini" type="number" min="1000" max="120000" step="1000" />
            ms
          </span>
        </div>
        <p v-if="testMsg" class="ftest" :class="{ ok: testMsg.startsWith('✓') }">{{ testMsg }}</p>
      </div>
      <template #footer>
        <button class="btn ghost" type="button" :disabled="testing" @click="doTest">
          {{ testing ? '试跑中…' : '试跑一次' }}
        </button>
        <span class="spacer"></span>
        <button class="btn ghost" type="button" @click="dialogOpen = false">取消</button>
        <button class="btn primary" type="button" :disabled="saving" @click="doSave">保存</button>
      </template>
    </BaseModal>
  </div>
</template>

<style scoped>
.monitor { padding: 4px 0 20px; }
.mtools { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.mstat { font-size: 12px; color: var(--tx3); margin-left: auto; }
.probe-msg { margin: 6px 0 10px; padding: 8px 12px; border-radius: 10px; background: var(--acc-soft); color: var(--tx2); font-size: 12.5px; }
.mcard { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px 18px; margin-bottom: 12px; box-shadow: var(--shadow-sm); }
.mcard.off { opacity: 0.62; }
.mhead { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--tx3); }
.dot.ok { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); }
.dot.warn { background: var(--warn); box-shadow: 0 0 0 3px var(--warn-soft); }
.dot.down { background: var(--err); box-shadow: 0 0 0 3px var(--err-soft); }
.mname { font-size: 14px; font-weight: 700; color: var(--tx-strong); }
.mbadge { font-size: 11px; font-weight: 600; padding: 2px 9px; border-radius: 999px; color: var(--tx3); background: var(--panel2); }
.mbadge.ok { color: var(--ok); background: var(--ok-soft); }
.mbadge.warn { color: var(--warn); background: var(--warn-soft); }
.mbadge.down { color: var(--err); background: var(--err-soft); }
.mbadge.paused { color: var(--tx3); background: var(--panel2); }
.mmeta { font-size: 11px; font-weight: 700; color: var(--tx3); background: var(--panel2); border-radius: 6px; padding: 2px 7px; }
.murl { font-size: 12px; color: var(--tx3); max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, Consolas, monospace; }
.mops { margin-left: auto; display: flex; gap: 6px; }
.btn.tiny { padding: 3px 10px; font-size: 12px; }
.btn.tiny.danger { color: var(--err); }
.mgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px 16px; margin: 12px 0 4px; }
.mfield { display: flex; flex-direction: column; gap: 2px; }
.mk { font-size: 11px; color: var(--tx3); }
.mv { font-size: 13px; color: var(--tx); }
.mv.num { font-variant-numeric: tabular-nums; }
.ok-text { color: var(--ok); font-weight: 600; }
.bad-text { color: var(--err); font-weight: 600; }
.muted { color: var(--tx3); }
.merr { margin-top: 8px; font-size: 12px; color: var(--err); word-break: break-all; background: var(--err-soft); border-radius: 8px; padding: 7px 10px; }
.mfoot { display: flex; align-items: center; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
.daystrip { display: inline-flex; gap: 2px; align-items: center; }
.daycell { width: 7px; height: 16px; border-radius: 2px; background: var(--track); display: inline-block; }
.daycell.full { background: var(--ok); }
.daycell.part { background: var(--warn); }
.daycell.low { background: var(--err); }
.daycell.none { background: var(--track); opacity: 0.5; }
.mhistory { margin-top: 10px; border-top: 1px solid var(--line-soft); padding-top: 10px; }
.hist-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.hist-table th, .hist-table td {
  box-sizing: border-box; padding: 5px 8px; border-bottom: none;
 box-shadow: inset 0 -1px 0 var(--line-soft); text-align: right; white-space: nowrap; }
.hist-table th { color: var(--tx3); font-weight: 600; font-size: 11px; }
.hist-table .tl { text-align: left; }
.hist-table .num { font-variant-numeric: tabular-nums; }
.hint-box { margin: 24px auto; max-width: 560px; text-align: center; color: var(--tx3); font-size: 13px; line-height: 1.8; padding: 22px; background: var(--card); border: 1px dashed var(--line-strong); border-radius: 14px; }
.hint-box.err { color: var(--err); border-color: var(--err-line); }
.small { font-size: 11.5px; }
.form { display: flex; flex-direction: column; gap: 12px; }
.frow { display: flex; flex-direction: column; gap: 6px; }
.flabel { font-size: 12px; font-weight: 600; color: var(--tx2); }
.input { width: 100%; }
.input.area { font-family: ui-monospace, Consolas, monospace; font-size: 12px; line-height: 1.6; resize: vertical; }
.input.mini { width: 110px; }
.seg { display: inline-flex; gap: 4px; background: var(--panel2); border: 1px solid var(--line); border-radius: 10px; padding: 3px; align-self: flex-start; }
.seg button { border: none; background: transparent; color: var(--tx2); font-size: 12px; font-weight: 500; padding: 5px 14px; border-radius: 8px; cursor: pointer; }
.seg button.on { background: var(--card); color: var(--acc); font-weight: 600; box-shadow: var(--shadow-sm); }
.fhelp { font-size: 11.5px; color: var(--tx3); line-height: 1.7; margin: 0; }
.fhelp code { background: var(--panel2); border: 1px solid var(--line); border-radius: 5px; padding: 1px 5px; font-size: 11px; }
.ftest { font-size: 12.5px; color: var(--err); background: var(--err-soft); border-radius: 8px; padding: 8px 11px; margin: 0; word-break: break-all; }
.ftest.ok { color: var(--ok); background: var(--ok-soft); }
.spacer { flex: 1; }
</style>
