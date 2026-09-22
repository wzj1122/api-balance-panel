<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { LogLevel } from '@shared/types'
import { clearLogs, exportLogs, openLogDir, readLogs, setLogLevel } from '@renderer/api/ipc'
import { formatBytes } from '@renderer/utils/text'
import { useFlash } from '@renderer/composables/useFlash'
import { useConfirm } from '@renderer/composables/useConfirm'
import InfoTip from './InfoTip.vue'

interface Entry { ts: number; level: LogLevel; text: string }

const { msg, flash } = useFlash()
const { confirm } = useConfirm()

const entries = ref<Entry[]>([])
const level = ref<LogLevel>('info')
const files = ref<{ name: string; size: number; mtime: number }[]>([])
const filterLevel = ref<'all' | LogLevel>('all')
const keyword = ref('')
const autoRefresh = ref(true)
const loading = ref(false)
const expanded = ref<Set<string>>(new Set())
let timer: ReturnType<typeof setInterval> | null = null

async function load(showLoading = false) {
  if (showLoading) loading.value = true
  try {
    const r = await readLogs({
      limit: 800,
      level: filterLevel.value === 'all' ? undefined : filterLevel.value,
      keyword: keyword.value.trim() || undefined
    })
    if (r.ok) {
      // 无变化时不动列表：避免每 2 秒把 800 行整体重渲染
      const next = r.data.entries
      const same =
        next.length === entries.value.length &&
        (entries.value.length === 0 ||
          (next[0].ts === entries.value[0].ts &&
            next[next.length - 1].ts === entries.value[entries.value.length - 1].ts))
      if (!same) entries.value = next
      level.value = r.data.level
      files.value = r.data.files
    }
  } finally {
    if (showLoading) loading.value = false
  }
}

onMounted(() => {
  void load(true)
  timer = setInterval(() => { if (autoRefresh.value) void load() }, 2000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })

async function onLevelChange(v: LogLevel) {
  const r = await setLogLevel(v)
  if (r.ok) {
    level.value = r.data.level
    flash('日志级别已切换为 ' + r.data.level + (v === 'debug' ? '（会记录请求级细节，重启后恢复 info）' : ''))
    await load()
  } else {
    flash('切换日志级别失败：' + r.error)
  }
}

async function onClear() {
  if (!(await confirm('清空当前日志？已轮转的历史文件不受影响。', { title: '清空日志', danger: true }))) return
  const r = await clearLogs()
  if (r.ok) { flash('日志已清空'); await load() }
  else flash('清空失败：' + r.error)
}

async function onExport() {
  const r = await exportLogs()
  if (r.ok && r.data.ok) flash('已导出到：' + (r.data.path ?? ''))
  else flash('导出失败：' + (r.data?.error ?? r.error ?? ''))
}

async function onOpenDir() {
  const r = await openLogDir()
  if (!r.ok || !r.data.ok) flash('打开目录失败')
}

function timeText(ts: number): string {
  const d = new Date(ts)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3)
}

/** 展开状态按条目内容记（此前用数组下标，筛选/刷新后展开会错位到别的行） */
function entryKey(e: Entry): string {
  return e.ts + '|' + e.level + '|' + e.text
}

function toggle(key: string) {
  const s = new Set(expanded.value)
  if (s.has(key)) s.delete(key)
  else s.add(key)
  expanded.value = s
}

const counts = computed(() => {
  const c: Record<string, number> = { debug: 0, info: 0, warn: 0, error: 0 }
  for (const e of entries.value) c[e.level] = (c[e.level] ?? 0) + 1
  return c
})
</script>

<template>
  <section class="logs-pane">
    <div class="head">
      <h2>
        运行日志
        <InfoTip text="记录主进程与界面的运行情况：余额查询、登录、探测、监控检查、通知、崩溃与异常等。内容已自动脱敏（密钥 / Cookie / Authorization 一律替换为 ***），导出后可以安全发给他人排查问题。" />
      </h2>
      <div class="tools">
        <span class="stat">
          <span class="lv debug">D {{ counts.debug }}</span>
          <span class="lv info">I {{ counts.info }}</span>
          <span class="lv warn">W {{ counts.warn }}</span>
          <span class="lv error">E {{ counts.error }}</span>
        </span>
        <label class="auto"><input v-model="autoRefresh" type="checkbox" /> 自动刷新</label>
        <button class="btn ghost" type="button" :disabled="loading" @click="load(true)">刷新</button>
        <button class="btn ghost" type="button" @click="onExport">导出</button>
        <button class="btn ghost" type="button" @click="onOpenDir">打开目录</button>
        <button class="btn ghost" type="button" @click="onClear">清空</button>
      </div>
    </div>

    <div class="scroll">
      <div v-if="msg" class="msg">{{ msg }}</div>

      <div class="filters">
        <input v-model="keyword" class="input" placeholder="搜索日志内容（如 mimo、余额、探测…）" @keyup.enter="load(true)" />
        <select v-model="filterLevel" class="input mini" @change="load(true)">
          <option value="all">全部级别</option>
          <option value="debug">debug</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
        <span class="cur">当前记录级别：<b>{{ level }}</b></span>
        <button class="btn ghost tiny" type="button" :class="{ on: level === 'debug' }" @click="onLevelChange(level === 'debug' ? 'info' : 'debug')">
          {{ level === 'debug' ? '关闭 debug 详情' : '开启 debug 详情' }}
        </button>
      </div>

      <div class="list">
        <div v-if="entries.length === 0" class="empty">没有日志记录（{{ filterLevel === 'all' ? '等待运行产生' : '当前筛选无结果' }}）</div>
        <div v-for="e in entries" :key="entryKey(e)" class="row" :class="e.level" @click="toggle(entryKey(e))">
          <span class="t">{{ timeText(e.ts) }}</span>
          <span class="lv-tag" :class="e.level">{{ e.level.toUpperCase() }}</span>
          <span class="txt" :class="{ wrap: expanded.has(entryKey(e)) }">{{ e.text }}</span>
        </div>
      </div>

      <div class="files" v-if="files.length">
        <div class="files-head">磁盘日志文件（按 2MB 轮转，保留最近 8 个）</div>
        <div v-for="f in files" :key="f.name" class="file-row">
          <span class="fname">{{ f.name }}</span>
          <span class="fsize num">{{ formatBytes(f.size) }}</span>
          <span class="fmtime muted">{{ new Date(f.mtime).toLocaleString('zh-CN') }}</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.logs-pane { display: flex; flex-direction: column; height: 100%; }
.head { flex: none; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 20px var(--pad-lg) 8px; }
.head h2 { font-size: 19px; font-weight: 700; color: var(--tx-strong); margin: 0; display: flex; align-items: center; gap: 8px; }
.tools { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.stat { display: inline-flex; gap: 6px; font-size: 11.5px; font-weight: 700; }
.lv { padding: 1px 7px; border-radius: 999px; background: var(--panel2); color: var(--tx3); }
.lv.info { color: var(--acc); background: var(--acc-soft); }
.lv.warn { color: var(--warn); background: var(--warn-soft); }
.lv.error { color: var(--err); background: var(--err-soft); }
.auto { font-size: 12px; color: var(--tx3); display: inline-flex; align-items: center; gap: 4px; }
.scroll { flex: 1; overflow-y: auto; padding: 6px var(--pad-lg) 40px; }
.msg { margin: 6px 0 10px; padding: 8px 12px; border-radius: 10px; background: var(--ok-soft); color: var(--tx); font-size: 12.5px; word-break: break-all; }
.filters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.filters .input { min-width: 240px; }
.input.mini { width: 130px; }
.cur { font-size: 12px; color: var(--tx3); }
.cur b { color: var(--acc); }
.btn.tiny { padding: 3px 10px; font-size: 11.5px; }
.list { background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; box-shadow: var(--shadow-sm); }
.row { display: flex; gap: 10px; align-items: flex-start; padding: 5px 12px; border-bottom: none;
 box-shadow: inset 0 -1px 0 var(--line-soft); font-family: ui-monospace, Consolas, monospace; font-size: 12px; cursor: pointer; }
.row:last-child { border-bottom: none; }
.row:hover { background: var(--card-hover); }
.t { flex: none; color: var(--tx3); }
.lv-tag { flex: none; width: 48px; text-align: center; border-radius: 4px; font-size: 10.5px; font-weight: 700; padding: 1px 0; background: var(--panel2); color: var(--tx3); }
.lv-tag.info { color: var(--acc); }
.lv-tag.warn { color: var(--warn); }
.lv-tag.error { color: var(--err); }
.txt { flex: 1; min-width: 0; color: var(--tx2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.txt.wrap { white-space: pre-wrap; word-break: break-all; }
.row.error .txt { color: var(--err); }
.row.warn .txt { color: var(--warn); }
.empty { padding: 26px; text-align: center; color: var(--tx3); font-size: 13px; }
.files { margin-top: 16px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 16px; }
.files-head { font-size: 12px; color: var(--tx3); font-weight: 600; margin-bottom: 8px; }
.file-row { display: flex; gap: 14px; font-size: 12.5px; padding: 4px 0; border-bottom: none;
 box-shadow: inset 0 -1px 0 var(--line-soft); }
.file-row:last-child { border-bottom: none; }
.fname { font-family: ui-monospace, Consolas, monospace; color: var(--tx); min-width: 200px; }
.fsize { color: var(--tx2); }
.muted { color: var(--tx3); }
.num { font-variant-numeric: tabular-nums; }
</style>
