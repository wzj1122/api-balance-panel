<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { loginSite } from '@renderer/api/ipc'
import {
  ACCOUNT_TYPES,
  DEFAULT_QUOTA_PER_USD,
  DEFAULT_SILICONFLOW_BASE_URL,
  MIMO_LOGIN_URL,
  MINIMAX_LOGIN_URL,
  PROVIDER_META,
  SENSENOVA_CONSOLE_URL,
  SILICONFLOW_LOGIN_URL,
  ZHIPU_LOGIN_URL
} from '@shared/constants'
import type { AccountInput, AccountType, AccountView, CustomRequest } from '@shared/types'
import BaseModal from './BaseModal.vue'

const props = defineProps<{
  open: boolean
  /** null = 新增；否则为编辑该账号 */
  account: AccountView | null
  /** 服务端返回的保存错误，父组件传入 */
  error?: string | null
  /** 已存在的账号类型（用于「一键添加另一种方式」提示） */
  existingTypes?: AccountType[]
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'save', payload: AccountInput): void
  /** 一次保存两个账号（MiMo 余额 + 套餐，共用同一 Cookie） */
  (e: 'save-both', payloads: AccountInput[]): void
}>()

interface HeaderRow {
  key: string
  value: string
}

const form = reactive({
  id: undefined as string | undefined,
  name: '',
  type: 'deepseek' as AccountType,
  enabled: true,
  threshold: 20 as number | null,
  secret: '',
  ak_id: '',
  ak_secret: '',
  quota_total: null as number | null,
  base_url: '',
  user_id: '',
  quota_per_usd: DEFAULT_QUOTA_PER_USD,
  unit: 'CNY',
  url: '',
  method: 'GET' as 'GET' | 'POST',
  body: '',
  headers: [{ key: '', value: '' }] as HeaderRow[],
  ex_remaining: '',
  ex_total: '',
  ex_used: '',
  ex_unit: '元',
  ex_scale: 1
})

/** 校验错误：字段名 -> 文案 */
const errors = reactive<Record<string, string>>({})
const reveal = ref(false)
/** MiMo 登录中 / 登录结果提示 */
const loginBusy = ref(false)
const loginStatus = ref('')
/** 勾选后保存时同时创建「另一个方式」的 MiMo 账号 */
const addBoth = ref(false)

/** 是否缺少另一种方式（mimo 缺套餐 / mimo-plan 缺余额），用于提示 */
const otherMissing = () => {
  const ts = props.existingTypes ?? []
  if (form.type === 'mimo') return !ts.includes('mimo-plan')
  if (form.type === 'mimo-plan') return !ts.includes('mimo')
  return false
}
/** 另一种方式的类型 */
const otherType = (): AccountType | null => {
  if (form.type === 'mimo') return 'mimo-plan'
  if (form.type === 'mimo-plan') return 'mimo'
  return null
}

const isEdit = () => !!props.account
const meta = () => PROVIDER_META[form.type]

function initForm() {
  const a = props.account
  const type = (a?.type ?? 'deepseek') as AccountType
  const m = PROVIDER_META[type]
  form.id = a?.id
  form.name = a?.name ?? ''
  form.type = type
  form.enabled = a?.enabled ?? true
  form.threshold = a?.threshold ?? m.defaultThreshold
  form.secret = ''
  form.ak_id = ''
  form.ak_secret = ''
  form.quota_total = a?.quota_total ?? null
  form.base_url = a?.base_url ?? (type === 'siliconflow' ? DEFAULT_SILICONFLOW_BASE_URL : '')
  form.user_id = a?.user_id ?? ''
  form.quota_per_usd = a?.quota_per_usd ?? DEFAULT_QUOTA_PER_USD
  form.unit = a?.unit ?? m.defaultUnit
  form.url = a?.request?.url ?? ''
  form.method = a?.request?.method ?? 'GET'
  form.body = a?.request?.body ?? ''
  form.headers = a?.request?.headers
    ? Object.entries(a.request.headers).map(([key, value]) => ({ key, value }))
    : [{ key: '', value: '' }]
  form.ex_remaining = a?.extract?.remaining ?? ''
  form.ex_total = a?.extract?.total ?? ''
  form.ex_used = a?.extract?.used ?? ''
  form.ex_unit = a?.extract?.unit ?? m.defaultUnit
  form.ex_scale = a?.extract?.scale ?? 1
  Object.keys(errors).forEach((k) => delete errors[k])
  reveal.value = false
  loginStatus.value = ''
}

watch(
  () => [props.open, props.account] as const,
  ([open]) => {
    if (open) initForm()
  },
  { immediate: true }
)

function onTypeChange() {
  const m = PROVIDER_META[form.type]
  form.threshold = m.defaultThreshold
  form.unit = m.defaultUnit
  form.ex_unit = m.defaultUnit
  if (form.type === 'siliconflow') form.base_url = DEFAULT_SILICONFLOW_BASE_URL
  else if (form.type !== 'newapi') form.base_url = ''
  if (form.type === 'newapi') form.quota_per_usd = DEFAULT_QUOTA_PER_USD
}

function toggleReveal() {
  if (!reveal.value) {
    const ok = window.confirm('确定显示明文密钥？明文会显示在屏幕上，请确认旁边没有他人。')
    if (!ok) return
  }
  reveal.value = !reveal.value
}

/** 平台 → 登录页（Cookie / 登录态来源） */
const LOGIN_URLS: Partial<Record<AccountType, string>> = {
  mimo: MIMO_LOGIN_URL,
  'mimo-plan': MIMO_LOGIN_URL,
  siliconflow: SILICONFLOW_LOGIN_URL,
  minimax: MINIMAX_LOGIN_URL,
  zhipu: ZHIPU_LOGIN_URL,
  sensenova: SENSENOVA_CONSOLE_URL
}

/** 该平台的凭据叫法：商汤日日新的额度接口只认登录态，不认 Cookie */
const loginCredentialLabel = computed(() => (form.type === 'sensenova' ? '登录态' : '登录 Cookie'))

/** 登录说明补充（各平台凭据有效期不同） */
const loginHintExtra = computed(() => {
  if (form.type === 'sensenova') return '额度接口只认登录态（不认 API Key），登录态约 3 小时过期，过期后点「重新登录」即可。'
  if (form.type === 'mimo' || form.type === 'mimo-plan') return 'Cookie 约 24 小时过期，过期后点「重新登录」即可。'
  return 'Cookie 由程序自动保存，失效后卡片会提示重新登录。'
})

/** 打开内置浏览器登录平台（MiMo / MiMo 套餐 / 硅基流动 / MiniMax / 智谱 / 商汤日日新），
 *  登录完成后抓取凭据（Cookie 或登录态 token）填入 secret */
async function doLogin() {
  loginBusy.value = true
  loginStatus.value = ''
  const loginUrl = LOGIN_URLS[form.type] ?? SILICONFLOW_LOGIN_URL
  // MiniMax 控制台与钱包接口域名不同，两个域名的 Cookie 都要抓
  const extraUrls = form.type === 'minimax' ? ['https://www.minimaxi.com'] : undefined
  // 编辑已有账号时把 id 传过去：主进程登录成功后会顺手把「续期材料」存进该账号，
  // 之后就能自动续期，不用反复重新登录
  const r = await loginSite(loginUrl, meta().label, form.type, extraUrls, form.id || undefined)
  loginBusy.value = false
  if (r.ok && r.data?.cookie) {
    form.secret = r.data.cookie
    const renewHint = r.data.canRenew ? '（已保存续期材料，之后会自动延长登录有效期）' : ''
    loginStatus.value = form.type === 'sensenova'
      ? '已获取登录态，保存后自动抓取额度' + renewHint
      : '已获取 Cookie，保存后自动抓取余额' + renewHint
  } else {
    // 失败时把原因写清楚（含"账号侧复验未通过"这类信息），并主动提示用户看这一行：
    // 以前登录失败后窗口一关就没下文了，用户只看到卡片一直"等待登录"，不知道发生了什么。
    loginStatus.value = '✗ ' + (r.ok ? r.data?.error || '未获取到登录凭据' : r.error)
  }
}

function addHeader() {
  form.headers.push({ key: '', value: '' })
}
function removeHeader(i: number) {
  form.headers.splice(i, 1)
}

function recordFromHeaders(rows: HeaderRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rows) {
    if (r.key.trim()) out[r.key.trim()] = r.value
  }
  return out
}

function validate(): boolean {
  Object.keys(errors).forEach((k) => delete errors[k])
  if (!form.name.trim()) errors.name = '请填写显示名称'

  const m = meta()
  if (m.needSecret) {
    const hasExisting = isEdit() && props.account?.has_secret
    if (form.type === 'aliyun') {
      if ((!form.ak_id.trim() || !form.ak_secret.trim()) && !hasExisting) {
        errors.secret = '请填写 AccessKey ID 与 AccessKey Secret'
      }
    } else if (!form.secret.trim() && !hasExisting) {
      errors.secret = m.needLogin ? '请先点「' + (form.type === 'sensenova' ? '登录并获取' : '登录') + '」获取' + (form.type === 'sensenova' ? '登录态' : 'Cookie') : '请填写密钥 / 令牌'
    }
  }

  if (form.type === 'newapi') {
    if (!form.base_url.trim()) errors.base_url = '请填写站点地址（只填域名，不要带 /v1）'
    if (!(form.quota_per_usd > 0)) errors.quota_per_usd = '换算比率需大于 0'
    if (!form.unit.trim()) errors.unit = '请填写显示单位'
  }

  if (form.type === 'custom') {
    if (!form.url.trim()) errors.url = '请填写请求地址'
    if (!form.ex_remaining.trim()) errors.ex_remaining = '请填写剩余余额的取值路径'
    if (!(form.ex_scale > 0)) errors.ex_scale = '倍率需大于 0'
    if (!form.ex_unit.trim()) errors.ex_unit = '请填写单位'
  }

  return Object.keys(errors).length === 0
}

function buildPayload(): AccountInput {
  const m = meta()
  const input: AccountInput = {
    name: form.name.trim(),
    type: form.type,
    enabled: form.enabled,
    threshold: form.threshold
  }
  if (isEdit() && form.id) input.id = form.id
  if (form.secret.trim()) input.secret = form.secret.trim()
  if (form.type === 'aliyun' && form.ak_id.trim() && form.ak_secret.trim()) {
    input.secret = form.ak_id.trim() + '|' + form.ak_secret.trim()
  }

  switch (form.type) {
    case 'deepseek':
      input.quota_total = form.quota_total
      input.unit = m.defaultUnit
      break
    case 'siliconflow':
      input.base_url = form.base_url.trim() || DEFAULT_SILICONFLOW_BASE_URL
      input.unit = m.defaultUnit
      break
    case 'newapi':
      input.base_url = form.base_url.trim()
      input.user_id = form.user_id.trim() || undefined
      input.quota_per_usd = form.quota_per_usd
      input.unit = form.unit.trim() || m.defaultUnit
      break
    case 'custom': {
      input.unit = form.ex_unit.trim()
      const request: CustomRequest = {
        url: form.url.trim(),
        method: form.method,
        headers: recordFromHeaders(form.headers)
      }
      const body = form.body.trim()
      if (body) request.body = body
      input.request = request
      input.extract = {
        remaining: form.ex_remaining.trim(),
        total: form.ex_total.trim() || undefined,
        used: form.ex_used.trim() || undefined,
        unit: form.ex_unit.trim(),
        scale: form.ex_scale,
        items: []
      }
      break
    }
  }
  return input
}

/** 生成「另一种方式」的账号（mimo ⇄ 套餐 共用同一 Cookie） */
function buildSecondaryPayload(type: AccountType): AccountInput {
  const m = PROVIDER_META[type]
  const suffix = type === 'mimo' ? '余额' : '套餐'
  return {
    name: form.name.trim().slice(0, 7) + '·' + suffix,
    type,
    enabled: true,
    threshold: m.defaultThreshold,
    unit: m.defaultUnit,
    secret: form.secret.trim() || undefined
  }
}

function onSave() {
  if (!validate()) return
  if (addBoth.value && !isEdit() && otherMissing() && otherType()) {
    emit('save-both', [buildPayload(), buildSecondaryPayload(otherType() as AccountType)])
  } else {
    emit('save', buildPayload())
  }
}
</script>

<template>
  <BaseModal :open="open" :title="isEdit() ? '编辑账号' : '添加账号'" @close="emit('close')">
    <div class="field">
      <label class="label">显示名称<span class="req">*</span></label>
      <input
        v-model="form.name"
        class="input"
        maxlength="10"
        placeholder="如：DeepSeek 主号"
      />
      <div class="hint">{{ form.name.length }}/10 · 最多 10 个字，保证卡片上完整显示</div>
      <div v-if="errors.name" class="err-text">⚠ {{ errors.name }}</div>
    </div>

    <div class="field">
      <label class="label">平台类型<span class="req">*</span></label>
      <select v-model="form.type" class="input" :disabled="isEdit()" @change="onTypeChange">
        <option v-for="t in ACCOUNT_TYPES" :key="t" :value="t">{{ PROVIDER_META[t].label }}</option>
      </select>
      <div class="hint">选了类型后，下面只显示需要的字段</div>
    </div>

    <!-- 通用区 -->
    <div class="sep"><span>通用设置</span></div>
    <div class="field-inline">
      <span class="f-label">启用</span>
      <div class="f-control">
        <label class="switch">
          <input v-model="form.enabled" type="checkbox" />
          <span class="sw-track"><span class="sw-thumb"></span></span>
        </label>
        <span class="switch-label">{{ form.enabled ? '已启用' : '已停用' }}</span>
      </div>
    </div>
    <div class="field-inline">
      <span class="f-label">低余额提醒</span>
      <div class="f-control">
        <span class="inline-input">
          剩余低于
          <input v-model.number="form.threshold" class="input mini" type="number" />
          时提醒
        </span>
      </div>
    </div>

    <!-- 密钥 / 令牌 / Cookie（deepseek / siliconflow / newapi / mimo） -->
    <template v-if="meta().needSecret">
      <!-- 需要登录的平台（MiMo / 硅基流动）：登录获取 Cookie -->
      <template v-if="meta().needLogin">
        <div class="field">
          <label class="label">{{ loginCredentialLabel }}<span class="req">*</span></label>
          <div class="login-row">
            <button class="btn" type="button" :disabled="loginBusy" @click="doLogin">
              <svg class="ico" viewBox="0 0 16 16" width="14" height="14">
                <path
                  fill="currentColor"
                  d="M8 3a5 5 0 1 0 4.6 3H11a3.5 3.5 0 1 1-.9-2.3L9.2 4.4H12V2L9.6 2.2A5 5 0 0 0 8 3Z"
                />
              </svg>
              {{ loginBusy ? '等待登录…' : form.secret ? '重新登录' : '登录并获取' }}
            </button>
            <span v-if="form.secret && !loginBusy" class="ok-text">✓ 已获取</span>
          </div>
          <div v-if="loginStatus" class="hint">{{ loginStatus }}</div>
          <div v-if="errors.secret" class="err-text">⚠ {{ errors.secret }}</div>
          <div class="hint">点「登录」会直接打开这个平台的登录页，登录成功后窗口会自动检测并关闭，无需手动操作。{{ loginHintExtra }}</div>
        </div>
      </template>
      <!-- 一键添加另一种方式（MiMo ⇄ 套餐，共用登录状态） -->
      <div v-if="otherMissing() && !isEdit()" class="field add-both">
        <label class="add-both-row">
          <input v-model="addBoth" type="checkbox" />
          <span>
            同时添加另一个方式：{{ otherType() === 'mimo-plan' ? '小米 MiMo 套餐（用量 / 额度 / 有效期）' : '小米 MiMo 余额（现金 / 赠送）' }}
            <span class="hint-inline">（同一个登录状态，无需再登录，保存后一起出现在面板上）</span>
          </span>
        </label>
      </div>
      <!-- 阿里云百炼：AccessKey ID + Secret 两栏 -->
      <template v-else-if="form.type === 'aliyun'">
        <div class="field">
          <label class="label">AccessKey ID<span class="req">*</span></label>
          <input v-model="form.ak_id" class="input" placeholder="LTAI 开头的一串字符" autocomplete="off" />
          <div class="hint">在阿里云 RAM 控制台创建一对 AccessKey。建议权限只勾选 <code>AliyunBSSReadOnlyAccess</code>（只读费用查询），ID 填上面、Secret 填下面。</div>
        </div>
        <div class="field">
          <label class="label">AccessKey Secret<span class="req">*</span></label>
          <div class="secret-row">
            <input
              v-model="form.ak_secret"
              class="input"
              :type="reveal ? 'text' : 'password'"
              :placeholder="isEdit() && account?.secret_masked ? '已保存（留空 = 不修改）' : '你的 AccessKey Secret'"
              autocomplete="off"
            />
            <button class="btn ghost" type="button" @click="toggleReveal">
              {{ reveal ? '隐藏' : '显示' }}
            </button>
          </div>
          <div v-if="errors.secret" class="err-text">⚠ {{ errors.secret }}</div>
          <div class="hint">{{ meta().secretHint }}</div>
        </div>
      </template>
      <!-- 其它平台：密钥 / 令牌输入 -->
      <template v-else>
        <div class="field">
          <label class="label">
            {{ form.type === 'newapi' ? '令牌' : 'API Key' }}<span class="req">*</span>
          </label>
          <div class="secret-row">
            <input
              v-model="form.secret"
              class="input"
              :type="reveal ? 'text' : 'password'"
              :placeholder="isEdit() && account?.secret_masked ? account.secret_masked + '（留空 = 不修改）' : 'sk-...'"
            />
            <button class="btn ghost" type="button" @click="toggleReveal">
              {{ reveal ? '隐藏' : '显示' }}
            </button>
          </div>
          <div v-if="errors.secret" class="err-text">⚠ {{ errors.secret }}</div>
          <div class="hint">{{ meta().secretHint }}</div>
        </div>
      </template>
    </template>

    <!-- DeepSeek：总额选填 -->
    <template v-if="form.type === 'deepseek'">
      <div class="field">
        <label class="label">总额（选填）</label>
        <input v-model.number="form.quota_total" class="input" type="number" placeholder="平台不提供，填了才能算百分比" />
      </div>
    </template>


    <!-- New API 中转站 -->
    <template v-if="form.type === 'newapi'">
      <div class="sep"><span>中转站设置</span></div>
      <div class="field">
        <label class="label">站点地址<span class="req">*</span></label>
        <input v-model="form.base_url" class="input" placeholder="https://你的中转站域名" />
        <div v-if="errors.base_url" class="err-text">⚠ {{ errors.base_url }}</div>
        <div class="hint">只填域名，不要带 /v1</div>
      </div>
      <div class="field">
        <label class="label">用户 ID</label>
        <input v-model="form.user_id" class="input" placeholder="部分站点需要，没有就空着" />
      </div>
      <div class="field-inline">
        <span class="f-label">换算比率</span>
        <div class="f-control">
          <span class="inline-input">
            1 美元 =
            <input v-model.number="form.quota_per_usd" class="input mini" type="number" />
            站点点数
          </span>
          <div v-if="errors.quota_per_usd" class="err-text">⚠ {{ errors.quota_per_usd }}</div>
        </div>
      </div>
      <div class="field">
        <label class="label">显示单位<span class="req">*</span></label>
        <input v-model="form.unit" class="input" placeholder="如 USD" />
        <div v-if="errors.unit" class="err-text">⚠ {{ errors.unit }}</div>
      </div>
    </template>

    <!-- 自定义 -->
    <template v-if="form.type === 'custom'">
      <div class="sep"><span>自定义请求</span></div>
      <div class="field">
        <label class="label">请求地址<span class="req">*</span></label>
        <input v-model="form.url" class="input" placeholder="https://..." />
        <div v-if="errors.url" class="err-text">⚠ {{ errors.url }}</div>
      </div>
      <div class="field-inline">
        <span class="f-label">请求方式</span>
        <div class="f-control">
          <select v-model="form.method" class="input mini">
            <option value="GET">GET</option>
            <option value="POST">POST</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label class="label">请求头</label>
        <div v-for="(h, i) in form.headers" :key="i" class="header-row">
          <input v-model="h.key" class="input" placeholder="Header 名，如 Cookie" />
          <input v-model="h.value" class="input" placeholder="值" />
          <button class="btn ghost icon" type="button" title="删除这一行" @click="removeHeader(i)">✕</button>
        </div>
        <button class="btn link" type="button" @click="addHeader">＋ 加一行</button>
      </div>
      <div class="field">
        <label class="label">请求体（POST 选填）</label>
        <textarea v-model="form.body" class="input" rows="2" placeholder="JSON 或表单内容"></textarea>
      </div>
      <div class="sep"><span>取值路径（点号路径，如 data.balance）</span></div>
      <div class="field">
        <label class="label">剩余<span class="req">*</span></label>
        <input v-model="form.ex_remaining" class="input" placeholder="data.balance" />
        <div v-if="errors.ex_remaining" class="err-text">⚠ {{ errors.ex_remaining }}</div>
      </div>
      <div class="field">
        <label class="label">总额</label>
        <input v-model="form.ex_total" class="input" placeholder="data.totalBalance" />
      </div>
      <div class="field">
        <label class="label">已用</label>
        <input v-model="form.ex_used" class="input" placeholder="data.usedBalance" />
      </div>
      <div class="field-inline">
        <span class="f-label">倍率</span>
        <div class="f-control">
          <input v-model.number="form.ex_scale" class="input mini" type="number" placeholder="1" />
          <span class="hint-inline">差 100 倍填 0.01</span>
          <div v-if="errors.ex_scale" class="err-text">⚠ {{ errors.ex_scale }}</div>
        </div>
      </div>
      <div class="field">
        <label class="label">单位<span class="req">*</span></label>
        <input v-model="form.ex_unit" class="input" placeholder="元 / 积分" />
        <div v-if="errors.ex_unit" class="err-text">⚠ {{ errors.ex_unit }}</div>
      </div>
    </template>

    <div v-if="error" class="banner err">⚠ {{ error }}</div>

    <template #footer>
      <button class="btn ghost" type="button" @click="emit('close')">取消</button>
      <button class="btn primary" type="button" @click="onSave">保存账号</button>
    </template>
  </BaseModal>
</template>

<style scoped>
/* 小节分隔 */
.sep {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: var(--fs-sub);
  font-weight: 600;
  color: var(--tx2);
  margin: 16px 0 12px;
}

.sep::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--line);
}

.sep span {
  white-space: nowrap;
}

/* 行内字段（左侧固定标签 + 右侧控件） */
.field-inline {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.f-label {
  font-size: var(--fs-sub);
  color: var(--tx2);
  font-weight: 500;
  min-width: 84px;
  flex: none;
}

.f-control {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}

.inline-input {
  font-size: var(--fs-sub);
  color: var(--tx2);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.hint-inline {
  font-size: var(--fs-foot);
  color: var(--tx3);
}

.secret-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.secret-row .input {
  flex: 1;
}

.login-row {
  display: flex;
  gap: 10px;
  align-items: center;
}

.add-both {
  margin-top: -4px;
}

.add-both-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: var(--fs-sub);
  color: var(--tx2);
  cursor: pointer;
  line-height: 1.6;
}

.add-both-row input {
  margin-top: 3px;
  accent-color: var(--acc);
  cursor: pointer;
}

.ok-text {
  color: var(--ok);
  font-size: var(--fs-sub);
  font-weight: 500;
}

.header-row {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}

.header-row .input {
  flex: 1;
}

.header-row .btn.icon {
  width: 32px;
  height: 32px;
}
</style>
