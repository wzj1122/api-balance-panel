<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { AccountType, BalanceRow, KeyAuditItem, KeyRow } from '@shared/types'
import { KEY_PRESETS, KEY_PRESET_OPTIONS, PROVIDER_META, credentialKind } from '@shared/constants'
import { fmtAgo, fmtNumber } from '@shared/format'
import { bulkKeys, listKeys, removeVaultKey, revealKey, saveAccount, saveVaultKey } from '@renderer/api/ipc'
import BaseModal from './BaseModal.vue'
import InfoTip from './InfoTip.vue'
import SelectMenu from './SelectMenu.vue'
import MonitorPanel from './MonitorPanel.vue'

const props = defineProps<{ rows: BalanceRow[] }>()
const emit = defineEmits<{ (e: 'edit', id: string): void }>()

const tab = ref<'keys' | 'monitor'>('keys')
const loading = ref(false)
const error = ref('')
const all = ref<KeyRow[]>([])
const deleted = ref<KeyRow[]>([])
const tags = ref<string[]>([])
const audit = ref<KeyAuditItem[]>([])
const note = ref('')
const selected = ref<Set<string>>(new Set())
const search = ref('')
const groupBy = ref<'platform' | 'tag'>('platform')
const filterTag = ref('')
const showAllKinds = ref(false)
const collapsed = ref<Set<string>>(new Set())
/** 当前展开「复制」菜单的行 id */
const openCopy = ref('')
const msg = ref('')
const showDeleted = ref(false)
const showExport = ref(false)

// 新建 Key
const addOpen = ref(false)
const addForm = ref({ type: 'deepseek', name: '', base_url: '', secret: '', tags: '' })
const addMsg = ref('')
const addHint = computed(() => KEY_PRESETS.find((p) => p.type === addForm.value.type)?.hint ?? '')

// 导出
const shareFormat = ref<'md' | 'json'>('md')
const shareWithSecret = ref(false)
const shareConfirmed = ref(false)
const shareResult = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const r = await listKeys()
    if (r.ok) {
      all.value = r.data.rows
      deleted.value = r.data.deleted
      tags.value = r.data.tags
      audit.value = r.data.audit
      note.value = r.data.note
    } else error.value = r.error
  } finally { loading.value = false }
}
onMounted(load)

/** 只保留 API Key 型凭据（Cookie 型账号不属于 Key 管理） */
const keyRows = computed(() => (showAllKinds.value ? all.value : all.value.filter((r) => credentialKind(r.type) === 'apiKey')))

const balanceMap = computed(() => {
  const m = new Map<string, BalanceRow>()
  for (const r of props.rows) m.set(r.accountId, r)
  return m
})

const visible = computed(() => {
  const kw = search.value.trim().toLowerCase()
  return keyRows.value.filter((r) => {
    if (filterTag.value && !r.tags.includes(filterTag.value)) return false
    if (kw && !(r.name.toLowerCase().includes(kw) || r.secretMasked.toLowerCase().includes(kw))) return false
    return true
  })
})

/** 分组：按平台 或 按自定义分类（标签） */
const groups = computed(() => {
  const map = new Map<string, { key: string; label: string; rows: KeyRow[] }>()
  for (const r of visible.value) {
    if (groupBy.value === 'platform') {
      const k = r.type
      const label = (PROVIDER_META[r.type]?.label ?? r.type) as string
      if (!map.has(k)) map.set(k, { key: k, label, rows: [] })
      map.get(k)!.rows.push(r)
    } else {
      const list = r.tags.length > 0 ? r.tags : ['未分类']
      for (const t of list) {
        if (!map.has(t)) map.set(t, { key: t, label: t, rows: [] })
        map.get(t)!.rows.push(r)
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => b.rows.length - a.rows.length || a.label.localeCompare(b.label, 'zh'))
})

const groupOptions = [
  { value: 'platform', label: '按平台分组' },
  { value: 'tag', label: '按分类分组' }
]

function typeLabel(t: string): string {
  const m = PROVIDER_META[t as keyof typeof PROVIDER_META]
  return m?.label ?? t
}

function balanceText(r: KeyRow): string {
  const b = balanceMap.value.get(r.id)
  if (!b || !b.ok || b.remaining === null) return '—'
  return fmtNumber(b.remaining) + ' ' + b.unit
}

function toggleSel(id: string) {
  const s = new Set(selected.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  selected.value = s
}
function toggleGroup(k: string) {
  const s = new Set(collapsed.value)
  if (s.has(k)) s.delete(k)
  else s.add(k)
  collapsed.value = s
}

function flash(text: string) {
  msg.value = text
  setTimeout(() => { if (msg.value === text) msg.value = '' }, 3000)
}

async function doBulk(action: 'enable' | 'disable' | 'delete' | 'restore' | 'purge' | 'tag', tagValue?: string) {
  const ids = Array.from(selected.value)
  if (ids.length === 0) return
  if (action === 'purge' && !window.confirm('彻底删除 ' + ids.length + ' 个 Key？不可恢复。')) return
  const r = await bulkKeys(ids, action, tagValue ? [tagValue] : undefined)
  if (r.ok) {
    flash('已处理 ' + r.data.affected + ' 个 Key')
    selected.value = new Set()
    await load()
  } else flash('操作失败：' + r.error)
}

function setCategory() {
  const v = window.prompt('设置所属分类（可输入新分类名，逗号分隔多个；留空则清空分类）：', filterTag.value || '')
  if (v === null) return
  const list = v.split(',').map((x) => x.trim()).filter(Boolean)
  void doBulk('tag', list.join(','))
}

function renameCategory(oldName: string) {
  const v = window.prompt('把分类「' + oldName + '」重命名为：', oldName)
  if (v === null || !v.trim() || v.trim() === oldName) return
  const ids = keyRows.value.filter((r) => r.tags.includes(oldName)).map((r) => r.id)
  const next = v.trim()
  void (async () => {
    for (const id of ids) {
      const row = all.value.find((r) => r.id === id)
      if (!row) continue
      const tags2 = row.tags.map((t) => (t === oldName ? next : t))
      await saveAccount({ id, enabled: true, name: row.name, type: row.type as AccountType, tags: tags2 })
    }
    flash('分类已重命名')
    await load()
  })()
}

async function copySecret(r: KeyRow) {
  const res = await revealKey(r.id, r.source)
  if (!res.ok || !res.data) { flash('读取密钥失败'); return }
  await navigator.clipboard.writeText(res.data)
  flash('已复制「' + r.name + '」的密钥')
}

function apiBase(r: KeyRow): string {
  if (r.baseUrl) return r.baseUrl.replace(/\/+$/, '')
  const preset = KEY_PRESETS.find((p) => p.type === r.type)
  return (preset?.base_url ?? 'https://your-site').replace(/\/+$/, '')
}

function curlExample(r: KeyRow, secret: string): string {
  return 'curl ' + apiBase(r) + '/chat/completions -H "Authorization: Bearer ' + secret + '" -H "Content-Type: application/json" -d \'{"model":"MODEL","messages":[{"role":"user","content":"hi"}]}\''
}

function envName(r: KeyRow): string {
  return r.type.toUpperCase().replace(/-/g, '_') + '_API_KEY'
}

async function copyAs(r: KeyRow, fmt: 'env' | 'json' | 'curl') {
  const res = await revealKey(r.id, r.source)
  if (!res.ok || !res.data) { flash('读取密钥失败'); return }
  const secret = res.data
  const text =
    fmt === 'env'
      ? envName(r) + '=' + secret
      : fmt === 'json'
        ? JSON.stringify({ name: r.name, type: r.type, category: r.tags, apiKey: secret, baseUrl: apiBase(r) }, null, 2)
        : curlExample(r, secret)
  await navigator.clipboard.writeText(text)
  flash('已复制为 ' + fmt.toUpperCase() + ' 格式')
}

async function cloneKey(r: KeyRow) {
  const res = await revealKey(r.id, r.source)
  if (!res.ok) { flash('克隆失败：' + res.error); return }
  // 克隆结果只进 Key 库：不创建账号、不参与余额查询（单向关系）
  const r2 = await saveVaultKey({
    name: r.name + ' · 副本',
    type: r.type,
    base_url: r.baseUrl || undefined,
    secret: res.data || undefined,
    tags: r.tags
  })
  flash(r2.ok ? '已克隆到 Key 库（不会同步为账号）' : '克隆失败：' + r2.error)
  await load()
}

async function removeKey(r: KeyRow) {
  if (r.source === 'vault') {
    if (!window.confirm('从 Key 库删除「' + r.name + '」？')) return
    const res = await removeVaultKey(r.id)
    if (res.ok) { flash('已从 Key 库删除'); await load() }
    return
  }
  if (!window.confirm('把账号「' + r.name + '」移入回收站？可随时恢复。')) return
  const res = await bulkKeys([r.id], 'delete')
  if (res.ok) { flash('已移入回收站'); await load() }
}

function openAdd() {
  addForm.value = { type: 'deepseek', name: '', base_url: KEY_PRESETS[0].base_url, secret: '', tags: filterTag.value }
  addMsg.value = ''
  addOpen.value = true
}

function onPresetChange(t: string) {
  const preset = KEY_PRESETS.find((p) => p.type === t)
  addForm.value.base_url = preset?.base_url ?? ''
}

async function submitAdd() {
  if (!addForm.value.name.trim()) { addMsg.value = '请填写名称'; return }
  if (!addForm.value.secret.trim()) { addMsg.value = '请填写 API Key'; return }
  const tagsList = addForm.value.tags.split(',').map((x) => x.trim()).filter(Boolean)
  // 关键：Key 管理里新建的 Key 存进 Key 库，**不会**同步成账号（单向关系）
  const r = await saveVaultKey({
    name: addForm.value.name.trim(),
    type: addForm.value.type,
    base_url: addForm.value.base_url.trim() || undefined,
    secret: addForm.value.secret.trim(),
    tags: tagsList
  })
  if (r.ok) {
    addOpen.value = false
    flash('已新建 Key「' + addForm.value.name + '」')
    await load()
  } else addMsg.value = '保存失败：' + r.error
}

async function buildShare(): Promise<string> {
  const list = selected.value.size > 0 ? keyRows.value.filter((r) => selected.value.has(r.id)) : visible.value
  const withSecret = shareWithSecret.value && shareConfirmed.value
  const items: { name: string; type: string; tags: string; mask: string; balance: string; secret?: string }[] = []
  for (const r of list) {
    let secret: string | undefined
    if (withSecret) {
      const res = await revealKey(r.id, r.source)
      secret = res.ok ? res.data : ''
    }
    items.push({ name: r.name, type: typeLabel(r.type), tags: r.tags.join('/'), mask: r.secretMasked, balance: balanceText(r), secret })
  }
  if (shareFormat.value === 'json') {
    return JSON.stringify({ exportedAt: new Date().toISOString(), containsSecret: withSecret, keys: items }, null, 2)
  }
  const head = '| 平台 | 名称 | 分类 | 密钥 | 余额 |'
  const body = items.map((i) => '| ' + i.type + ' | ' + i.name + ' | ' + i.tags + ' | ' + (withSecret ? i.secret : i.mask) + ' | ' + i.balance + ' |')
  return ['# API Key 清单', '', '导出时间：' + new Date().toLocaleString('zh-CN'), withSecret ? '⚠️ 本文件包含密钥明文，请谨慎保管' : '（不含密钥明文，仅展示掩码）', '', head, '|---|---|---|---|---|', ...body].join('\n')
}

async function doShare() { shareResult.value = await buildShare() }
async function copyShare() {
  if (!shareResult.value) await doShare()
  await navigator.clipboard.writeText(shareResult.value)
  flash('已复制到剪贴板')
}
function downloadShare() {
  const blob = new Blob([shareResult.value], { type: shareFormat.value === 'json' ? 'application/json' : 'text/markdown' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'api-keys-' + new Date().toISOString().slice(0, 10) + (shareFormat.value === 'json' ? '.json' : '.md')
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
  flash('已导出文件')
}
function auditFor(id: string): KeyAuditItem[] { return audit.value.filter((a) => a.id === id) }
</script>
<template>
  <section class="keys-pane">
    <div class="head">
      <h2>
        Key 管理
        <InfoTip text="这里只管理「用 API Key 访问」的凭据（DeepSeek）。Cookie 登录型平台（Xiaomi MIMO、MiniMax、bigmodel、siliconflow、SenseNova）与阿里云 AK/SK 请在概览页管理。" />
      </h2>
      <div class="tabs">
        <button type="button" :class="{ on: tab === 'keys' }" @click="tab = 'keys'">Key 列表</button>
        <button type="button" :class="{ on: tab === 'monitor' }" @click="tab = 'monitor'">接口监控</button>
      </div>
      <div class="tools" v-if="tab === 'keys'">
        <button class="btn primary" type="button" @click="openAdd">+ 新建 Key</button>
        <button class="btn ghost" type="button" :disabled="loading" @click="load">刷新</button>
      </div>
    </div>

    <MonitorPanel v-if="tab === 'monitor'" class="mon-wrap" />

    <div v-else class="scroll">
      <div v-if="msg" class="msg">{{ msg }}</div>
      <div v-if="error" class="hint-box err">{{ error }}</div>

      <div v-if="audit.length" class="audit">
        <div class="audit-head">安全审计 · {{ audit.length }} 条提示</div>
        <div v-for="(a, i) in audit.slice(0, 6)" :key="i" class="audit-item" :class="a.level">
          <span class="audit-kind">{{ a.kind === 'stale' ? '长期未用' : a.kind === 'unused' ? '零消耗' : a.kind === 'duplicate' ? '重复密钥' : '格式异常' }}</span>
          <span>{{ a.message }}</span>
        </div>
      </div>

      <div class="filters">
        <input v-model="search" class="input" placeholder="搜索名称或密钥掩码…" />
        <SelectMenu v-model="groupBy" :options="groupOptions" />
        <select v-model="filterTag" class="input mini">
          <option value="">全部分类</option>
          <option v-for="t in tags" :key="t" :value="t">{{ t }}</option>
        </select>
        <label class="kinds"><input v-model="showAllKinds" type="checkbox" /> 显示全部凭据类型</label>
      </div>

      <div v-if="selected.size > 0" class="bulkbar">
        <span>已选 {{ selected.size }} 个 Key</span>
        <button class="btn ghost tiny" type="button" @click="doBulk('enable')">启用</button>
        <button class="btn ghost tiny" type="button" @click="doBulk('disable')">停用</button>
        <button class="btn ghost tiny" type="button" @click="setCategory">设置分类</button>
        <button class="btn ghost tiny danger" type="button" @click="doBulk('delete')">移入回收站</button>
        <button class="btn ghost tiny" type="button" @click="selected = new Set()">取消选择</button>
      </div>

      <div v-for="g in groups" :key="g.key" class="group">
        <div class="group-head">
          <button class="caret-btn" type="button" @click="toggleGroup(g.key)">
            <svg class="caret" :class="{ open: !collapsed.has(g.key) }" viewBox="0 0 16 16" width="12" height="12">
              <path d="M6 4l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span class="group-label">{{ g.label }}</span>
            <span class="group-count num">{{ g.rows.length }}</span>
          </button>
          <button v-if="groupBy === 'tag' && g.key !== '未分类'" class="btn ghost tiny" type="button" @click="renameCategory(g.key)">重命名分类</button>
        </div>

        <div v-if="!collapsed.has(g.key)" class="table-wrap">
          <table class="usage-table">
            <colgroup>
              <col style="width: 46px" />
              <col />
              <col style="width: 104px" />
              <col style="width: 72px" />
              <col style="width: 132px" />
              <col style="width: 146px" />
              <col style="width: 122px" />
              <col style="width: 98px" />
              <col style="width: 216px" />
            </colgroup>
            <thead>
              <tr>
                <th class="ck"></th>
                <th class="tl">名称</th>
                <th class="tl">平台</th>
                <th class="tl">来源</th>
                <th class="tl">分类</th>
                <th class="tl">密钥</th>
                <th>余额</th>
                <th>最后刷新</th>
                <th class="tl">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in g.rows" :key="r.id" :class="{ off: !r.enabled }">
                <td class="ck"><input type="checkbox" :checked="selected.has(r.id)" @change="toggleSel(r.id)" /></td>
                <td class="tl"><span class="kname">{{ r.name }}</span><span v-for="(a, i) in auditFor(r.id).slice(0, 1)" :key="i" class="kflag" :title="a.message">!</span></td>
                <td class="tl">{{ typeLabel(r.type) }}</td>
                <td class="tl"><span class="src" :class="r.source">{{ r.source === 'account' ? '账号' : 'Key 库' }}</span></td>
                <td class="tl"><span v-for="t in r.tags" :key="t" class="ktag">{{ t }}</span><span v-if="!r.tags.length" class="muted">—</span></td>
                <td class="tl mono">{{ r.secretMasked || '未设置' }}</td>
                <td class="num">{{ balanceText(r) }}</td>
                <td class="num muted">{{ r.lastTs ? fmtAgo(r.lastTs) : '—' }}</td>
                <td class="tl ops">
                  <div class="copy-menu">
                    <button class="btn ghost tiny" type="button" @click.stop="openCopy = openCopy === r.id ? '' : r.id">
                      复制 ▾
                    </button>
                    <div v-if="openCopy === r.id" class="copy-list">
                      <button type="button" @click="copySecret(r); openCopy = ''">明文密钥</button>
                      <button type="button" @click="copyAs(r, 'env'); openCopy = ''">.env 格式</button>
                      <button type="button" @click="copyAs(r, 'json'); openCopy = ''">JSON 配置</button>
                      <button type="button" @click="copyAs(r, 'curl'); openCopy = ''">curl 命令</button>
                    </div>
                  </div>
                  <button class="btn ghost tiny" type="button" @click="cloneKey(r)">克隆</button>
                  <button class="btn ghost tiny" type="button" @click="emit('edit', r.id)">编辑</button>
                  <button class="btn ghost tiny danger" type="button" @click="removeKey(r)">删除</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-if="groups.length === 0" class="hint-box">
        {{ note || '还没有 API Key：点右上角「+ 新建 Key」添加（DeepSeek）' }}
      </div>

      <!-- 导出独立区块 -->
      <div class="export-card">
        <button class="export-head" type="button" @click="showExport = !showExport">
          <span class="export-title">导出 / 分享 Key 清单</span>
          <span class="muted">（独立区域，默认只导出元信息，不含密钥）</span>
          <span class="export-toggle">{{ showExport ? '收起' : '展开' }}</span>
        </button>
        <div v-if="showExport" class="export-body">
          <div class="erow">
            <label><input v-model="shareFormat" type="radio" value="md" /> Markdown 表格</label>
            <label><input v-model="shareFormat" type="radio" value="json" /> JSON</label>
          </div>
          <div class="erow warn-row">
            <label><input v-model="shareWithSecret" type="checkbox" @change="shareConfirmed = false" /> 包含密钥明文（有泄露风险）</label>
          </div>
          <div v-if="shareWithSecret" class="danger-box">
            <p>⚠️ 明文密钥可被直接使用并产生费用。请确认接收方可信、传输方式安全（不要发到公开群聊）。</p>
            <label><input v-model="shareConfirmed" type="checkbox" /> 我已确认风险，仍要包含明文</label>
          </div>
          <div class="erow">
            <span class="muted">范围：{{ selected.size > 0 ? '选中的 ' + selected.size + ' 个 Key' : '当前列表的 ' + visible.length + ' 个 Key' }}</span>
            <button class="btn primary tiny" type="button" @click="doShare">生成内容</button>
            <button class="btn ghost tiny" type="button" :disabled="!shareResult" @click="copyShare">复制</button>
            <button class="btn ghost tiny" type="button" :disabled="!shareResult" @click="downloadShare">下载文件</button>
          </div>
          <textarea v-if="shareResult" class="share-out" readonly :value="shareResult"></textarea>
        </div>
      </div>

      <div class="recycle">
        <button class="btn ghost" type="button" @click="showDeleted = !showDeleted">回收站（{{ deleted.length }}）{{ showDeleted ? '收起' : '展开' }}</button>
        <div v-if="showDeleted && deleted.length" class="rec-list">
          <div v-for="r in deleted" :key="r.id" class="rec-item">
            <span class="kname">{{ r.name }}</span>
            <span class="muted">{{ typeLabel(r.type) }} · 删除于 {{ r.deletedAt ? fmtAgo(r.deletedAt) : '—' }}</span>
            <span class="rec-ops">
              <button class="btn ghost tiny" type="button" @click="selected = new Set([r.id]); doBulk('restore')">恢复</button>
              <button class="btn ghost tiny danger" type="button" @click="selected = new Set([r.id]); doBulk('purge')">彻底删除</button>
            </span>
          </div>
        </div>
      </div>
    </div>

    <BaseModal :open="addOpen" title="新建 API Key" @close="addOpen = false">
      <div class="addform">
        <label class="frow">
          <span class="flabel">平台</span>
          <select v-model="addForm.type" class="input" @change="onPresetChange(addForm.type)">
            <option v-for="p in KEY_PRESET_OPTIONS" :key="p.type" :value="p.type">{{ p.label }}</option>
          </select>
          <span class="fhint">{{ addHint }}</span>
        </label>
        <label class="frow">
          <span class="flabel">名称</span>
          <input v-model="addForm.name" class="input" placeholder="例如：DeepSeek 生产 Key" />
        </label>
        <label class="frow">
          <span class="flabel">调用地址</span>
          <input v-model="addForm.base_url" class="input" placeholder="https://api.deepseek.com" />
        </label>
        <label class="frow">
          <span class="flabel">API Key</span>
          <input v-model="addForm.secret" class="input" type="password" placeholder="sk-..." />
        </label>
        <label class="frow">
          <span class="flabel">分类（可选）</span>
          <input v-model="addForm.tags" class="input" placeholder="生产, 项目A（逗号分隔，可新建分类）" />
        </label>
        <p v-if="addMsg" class="fmsg">{{ addMsg }}</p>
      </div>
      <template #footer>
        <button class="btn ghost" type="button" @click="addOpen = false">取消</button>
        <button class="btn primary" type="button" @click="submitAdd">保存 Key</button>
      </template>
    </BaseModal>
  </section>
</template>

<style scoped>
.keys-pane { display: flex; flex-direction: column; height: 100%; }
.head { flex: none; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 20px var(--pad-lg) 8px; }
.head h2 { font-size: 19px; font-weight: 700; color: var(--tx-strong); margin: 0; display: flex; align-items: center; gap: 8px; }
.tabs { display: inline-flex; gap: 4px; background: var(--panel2); border: 1px solid var(--line); border-radius: 10px; padding: 3px; }
.tabs button { border: none; background: transparent; color: var(--tx2); font-size: var(--fs-sub); font-weight: 500; padding: 5px 14px; border-radius: 8px; cursor: pointer; }
.tabs button.on { background: var(--card); color: var(--acc); font-weight: 600; box-shadow: var(--shadow-sm); }
.tools { margin-left: auto; display: flex; gap: 8px; }
.mon-wrap { flex: 1; overflow-y: auto; padding: 0 var(--pad-lg); }
.scroll { flex: 1; overflow-y: auto; padding: 8px var(--pad-lg) 40px; }
.msg { margin: 6px 0 10px; padding: 8px 12px; border-radius: 10px; background: var(--ok-soft); color: var(--tx); font-size: 12.5px; }
.audit { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 12px 16px; margin-bottom: 14px; box-shadow: var(--shadow-sm); }
.audit-head { font-size: 12px; color: var(--tx3); font-weight: 600; margin-bottom: 8px; }
.audit-item { display: flex; gap: 10px; align-items: baseline; font-size: 12.5px; color: var(--tx2); padding: 4px 0; }
.audit-kind { flex: none; font-size: 11px; font-weight: 700; padding: 1px 8px; border-radius: 999px; background: var(--panel2); color: var(--tx3); }
.audit-item.warn .audit-kind { background: var(--warn-soft); color: var(--warn); }
.audit-item.info .audit-kind { background: var(--acc-soft); color: var(--acc); }
.filters { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.filters .input { min-width: 200px; }
.input.mini { width: 140px; }
.kinds { font-size: 12px; color: var(--tx3); display: inline-flex; align-items: center; gap: 5px; }
.seg.small { padding: 2px; }
.seg.small button { padding: 4px 10px; font-size: 12px; }
.bulkbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 12px; margin-bottom: 10px; border-radius: 10px; background: var(--acc-soft); font-size: 12.5px; color: var(--tx); }
.group { margin-bottom: 14px; }
.group-head { display: flex; align-items: center; gap: 10px; }
.caret-btn { display: flex; align-items: center; gap: 8px; background: transparent; border: none; cursor: pointer; color: var(--tx2); font-size: 13px; font-weight: 600; padding: 6px 2px; }
.caret { transition: transform 0.2s var(--ease); opacity: 0.7; }
.caret.open { transform: rotate(90deg); }
.group-count { font-size: 11.5px; color: var(--tx3); background: var(--panel2); border-radius: 999px; padding: 1px 9px; }
.table-wrap { background: var(--card); border: none; border-radius: 14px; overflow: auto; box-shadow: inset 0 0 0 1px var(--line), var(--shadow-sm); }
.usage-table { border-collapse: collapse; width: 100%; font-size: var(--fs-sub); table-layout: fixed; }
.usage-table th:not(.ck), .usage-table td:not(.ck):not(.ops) { overflow: hidden; text-overflow: ellipsis; }
.usage-table .ck { overflow: visible; text-align: center; padding: 8px 6px; }
.usage-table .ops { overflow: visible; }
/* 行悬停高亮（保持在单元格之上） */
.usage-table tbody tr:hover td { background: var(--card-hover) !important; }
.usage-table tbody tr:hover td.tl { background: var(--card-hover) !important; }
.copy-menu { position: relative; display: inline-block; }
.copy-list { position: absolute; top: calc(100% + 4px); left: 0; z-index: 30; min-width: 122px; padding: 4px; margin: 0; background: var(--panel); border: 1px solid var(--line-strong); border-radius: 9px; box-shadow: var(--shadow); display: flex; flex-direction: column; }
.copy-list button { border: none; background: transparent; color: var(--tx2); font-size: 12px; text-align: left; padding: 6px 10px; border-radius: 6px; cursor: pointer; white-space: nowrap; }
.copy-list button:hover { background: var(--panel2); color: var(--tx); }
.usage-table th, .usage-table td { padding: 8px 10px; border-bottom: none;
 box-shadow: inset 0 -1px 0 var(--line-soft); white-space: nowrap; text-align: right; }
.usage-table th { position: sticky; top: 0; background: var(--panel2); color: var(--tx2); font-weight: 600; font-size: var(--fs-foot); z-index: 1; }
.usage-table th.tl, .usage-table td.tl { text-align: left; }
.usage-table tbody tr:hover td { background: var(--card-hover); }
.usage-table tr.off td { opacity: 0.55; }
.usage-table .ck { width: 34px; text-align: center; }
.kname { font-weight: 600; color: var(--tx); }
.kflag { display: inline-block; margin-left: 6px; width: 15px; height: 15px; line-height: 15px; text-align: center; border-radius: 50%; background: var(--warn-soft); color: var(--warn); font-size: 11px; font-weight: 700; cursor: help; }
.src { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; background: var(--panel2); color: var(--tx3); }
.src.account { background: var(--ok-soft); color: var(--ok); }
.src.vault { background: var(--acc-soft); color: var(--acc); }
.ktag { display: inline-block; margin-right: 4px; padding: 1px 8px; border-radius: 999px; background: var(--acc-soft); color: var(--acc); font-size: 11px; font-weight: 600; }
.mono { font-family: ui-monospace, Consolas, monospace; color: var(--tx3); }
.ops { display: flex; gap: 4px; flex-wrap: wrap; }
.btn.tiny { padding: 3px 9px; font-size: 11.5px; }
.btn.tiny.danger { color: var(--err); }
.export-card { margin-top: 18px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow-sm); overflow: hidden; }
.export-head { width: 100%; display: flex; align-items: center; gap: 10px; padding: 14px 18px; background: transparent; border: none; cursor: pointer; text-align: left; }
.export-title { font-size: 13.5px; font-weight: 700; color: var(--tx-strong); }
.export-toggle { margin-left: auto; font-size: 12px; color: var(--acc); }
.export-body { padding: 0 18px 16px; display: flex; flex-direction: column; gap: 10px; }
.erow { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 12.5px; color: var(--tx2); }
.erow label { display: inline-flex; align-items: center; gap: 6px; }
.warn-row { color: var(--warn); font-weight: 600; }
.danger-box { border: 1px solid var(--err); background: var(--err-soft); border-radius: 10px; padding: 10px 12px; font-size: 12.5px; }
.danger-box p { margin: 0 0 8px; line-height: 1.7; }
.share-out { width: 100%; min-height: 170px; font-family: ui-monospace, Consolas, monospace; font-size: 12px; background: var(--panel2); border: 1px solid var(--line); border-radius: 10px; padding: 10px; color: var(--tx2); resize: vertical; }
.recycle { margin-top: 16px; }
.rec-list { margin-top: 10px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 10px 14px; }
.rec-item { display: flex; align-items: center; gap: 12px; padding: 6px 0; border-bottom: none;
 box-shadow: inset 0 -1px 0 var(--line-soft); font-size: 12.5px; }
.rec-item:last-child { border-bottom: none; }
.rec-ops { margin-left: auto; display: flex; gap: 6px; }
.muted { color: var(--tx3); }
.hint-box { margin: 24px auto; max-width: 520px; text-align: center; color: var(--tx3); font-size: 13px; line-height: 1.8; padding: 22px; background: var(--card); border: 1px dashed var(--line-strong); border-radius: 14px; }
.hint-box.err { color: var(--err); }
.addform { display: flex; flex-direction: column; gap: 12px; }
.frow { display: flex; flex-direction: column; gap: 6px; }
.flabel { font-size: 12px; font-weight: 600; color: var(--tx2); }
.fhint { font-size: 11.5px; color: var(--tx3); line-height: 1.6; }
.fmsg { font-size: 12.5px; color: var(--err); background: var(--err-soft); border-radius: 8px; padding: 8px 11px; margin: 0; }
</style>
