import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { ACCOUNT_TYPES, DEFAULT_QUOTA_PER_USD, DEFAULT_SETTINGS, PROVIDER_META } from '../shared/constants'
import { isPlainObject, maskSecret, normalizeTags, numOrNull } from '../shared/format'
import type { Account, AccountInput, AccountType, CredentialSession, Settings, AccountView } from '../shared/types'
import { CRYPTO_VERSION, currentScheme, decrypt, decryptWithFallback, encrypt } from './crypto'
import type { CryptoScheme } from './crypto'
import { logger } from './logger'
import { setDefaultTimeoutMs } from './http'
import { demoAccounts, isDemo } from './demo'
import { CONFIG_BAK, CONFIG_FILE, CONFIG_TMP, corruptFileName, ensureDirs } from './paths'

/**
 * 配置读写（config.json）。
 *
 * 可靠性三件套：
 * 1. 原子写：先写 config.json.tmp 并 fsync，再 rename 覆盖，断电也不会写坏；
 * 2. 单份备份：覆盖前把当前 config.json 复制为 config.json.bak；
 * 3. 损坏恢复：读取失败 → 回滚 .bak（status='recovered'）→ 仍失败则用默认配置（status='reset'），
 *    坏文件重命名为 config.corrupt-<时间戳>.json，不删除，留给用户自己救。
 */

/** 磁盘上的完整配置结构 */
interface AppConfig {
  version: number
  crypto: { scheme: CryptoScheme; version: number }
  settings: Settings
  accounts: Account[]
  /** 每日提醒计数：accountId -> { date, count } */
  notice_state: Record<string, NoticeState>
}

/** 单账号的提醒状态（按自然日计数） */
interface NoticeState {
  date: string
  count: number
}

const CONFIG_VERSION = 1

/** .bak 备份节流：高频保存（每账号每次刷新都写）不再每次整文件复制，最多 10 分钟备一次 */
let lastBakAt = 0
const BAK_MIN_INTERVAL_MS = 10 * 60 * 1000

/**
 * 一份全新的默认配置。
 * scheme 这里写死 'safeStorage-v1'：模块初始化时 app 可能还没 ready，
 * 此时探测 safeStorage 会得到错误的 false；真正加密时（saveAccount）会按 currentScheme() 刷新。
 */
function defaultConfig(): AppConfig {
  return {
    version: CONFIG_VERSION,
    crypto: { scheme: 'safeStorage-v1', version: CRYPTO_VERSION },
    settings: { ...DEFAULT_SETTINGS },
    accounts: [],
    notice_state: {}
  }
}

// ---------- 归一化（逐字段兜底，保证界面拿到的永远是合法对象，不白屏） ----------

function numOr(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function strOr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/** 设置项归一化：缺字段补默认，越界拉回范围 */
function normalizeSettings(raw: unknown): Settings {
  const src = isPlainObject(raw) ? raw : {}
  const d = DEFAULT_SETTINGS
  const refresh = numOr(src.refresh_seconds, d.refresh_seconds)
  return {
    refresh_seconds: refresh > 0 ? clamp(refresh, 15, 86400) : d.refresh_seconds,
    pause_when_hidden: boolOr(src.pause_when_hidden, d.pause_when_hidden),
    default_threshold: Math.max(0, numOr(src.default_threshold, d.default_threshold)),
    default_threshold_relay: Math.max(0, numOr(src.default_threshold_relay, d.default_threshold_relay)),
    notice_enabled: boolOr(src.notice_enabled, d.notice_enabled),
    notice_max_per_day: clamp(numOr(src.notice_max_per_day, d.notice_max_per_day), 0, 10),
    concurrency: clamp(numOr(src.concurrency, d.concurrency), 1, 32),
    timeout_ms: clamp(numOr(src.timeout_ms, d.timeout_ms), 1000, 120000),
    cache_seconds: clamp(numOr(src.cache_seconds, d.cache_seconds), 0, 3600),
    snapshot_retention_days: clamp(numOr(src.snapshot_retention_days, d.snapshot_retention_days), 1, 365),
    theme: typeof src.theme === 'string' && src.theme.length > 0 && src.theme.length <= 40 ? src.theme : 'dark',
    launch_at_login: boolOr(src.launch_at_login, d.launch_at_login),
    daily_budget: normalizeBudget(src.daily_budget, d.daily_budget),
    drop_alert_percent: clamp(numOr(src.drop_alert_percent, d.drop_alert_percent), 0, 100),
    fail_alert_count: clamp(numOr(src.fail_alert_count, d.fail_alert_count), 0, 50),
    credits_per_cny: clamp(numOr(src.credits_per_cny, d.credits_per_cny), 0, 1e9),
    onboarded: boolOr(src.onboarded, d.onboarded),
    bg_enabled: boolOr(src.bg_enabled, d.bg_enabled),
    bg_file: typeof src.bg_file === 'string' ? src.bg_file : d.bg_file,
    bg_fit: src.bg_fit === 'contain' || src.bg_fit === 'repeat' ? src.bg_fit : 'cover',
    bg_dim: clamp(numOr(src.bg_dim, d.bg_dim), 0, 80),
    bg_blur: clamp(numOr(src.bg_blur, d.bg_blur), 0, 20),
    card_translucent: boolOr(src.card_translucent, d.card_translucent),
    glass_enabled: boolOr(src.glass_enabled, d.glass_enabled),
    glass_blur: clamp(numOr(src.glass_blur, d.glass_blur), 0, 40),
    glass_alpha: clamp(numOr(src.glass_alpha, d.glass_alpha), 0.45, 0.95)
  }
}

/** 每日预算归一化：单位 → 正数金额，非法项丢弃 */
function normalizeBudget(raw: unknown, fallback: Record<string, number>): Record<string, number> {
  if (!isPlainObject(raw)) return { ...fallback }
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw)) {
    const n = typeof v === 'number' ? v : Number(v)
    if (k.length > 0 && k.length <= 24 && Number.isFinite(n) && n > 0) out[k] = Math.min(n, 1e9)
  }
  return out
}

/** 单条账号归一化；类型非法或没名字就返回 null（调用方丢弃并记录 warn） */
function normalizeAccount(raw: unknown): Account | null {
  if (!isPlainObject(raw)) return null
  const type = strOr(raw.type) as AccountType
  if (!ACCOUNT_TYPES.includes(type)) return null
  const now = Date.now()
  const meta = PROVIDER_META[type]

  const account: Account = {
    id: strOr(raw.id) || randomUUID(),
    name: strOr(raw.name) || '未命名账号',
    type,
    enabled: boolOr(raw.enabled, true),
    secret_enc: typeof raw.secret_enc === 'string' && raw.secret_enc ? raw.secret_enc : null,
    secret_masked: strOr(raw.secret_masked),
    session_enc: typeof raw.session_enc === 'string' && raw.session_enc ? raw.session_enc : null,
    token_expires_at: numOrNull(raw.token_expires_at),
    deleted_at: typeof raw.deleted_at === 'number' ? raw.deleted_at : null,
    created_at: numOr(raw.created_at, now),
    updated_at: numOr(raw.updated_at, now)
  }

  if (Array.isArray(raw.tags)) account.tags = normalizeTags(raw.tags)
  if (typeof raw.base_url === 'string') account.base_url = raw.base_url
  if (typeof raw.user_id === 'string') account.user_id = raw.user_id
  if (raw.quota_per_usd !== undefined && raw.quota_per_usd !== null) {
    account.quota_per_usd = numOr(raw.quota_per_usd, DEFAULT_QUOTA_PER_USD)
  } else {
    account.quota_per_usd = DEFAULT_QUOTA_PER_USD
  }
  account.quota_total = numOrNull(raw.quota_total)
  account.unit = strOr(raw.unit, meta.defaultUnit) || meta.defaultUnit
  // 结构来自用户手改的 config.json，只在类型层面做一次断言，真正的校验留给适配器
  if (isPlainObject(raw.request)) account.request = raw.request as unknown as Account['request']
  if (isPlainObject(raw.extract)) account.extract = raw.extract as unknown as Account['extract']
  account.threshold = numOrNull(raw.threshold)
  account.notice_enabled = boolOr(raw.notice_enabled, true)
  account.last_status = raw.last_status === 'ok' || raw.last_status === 'error' ? raw.last_status : null
  account.last_error = typeof raw.last_error === 'string' ? raw.last_error : null
  account.last_ts = numOrNull(raw.last_ts)

  return account
}

/** 整个配置归一化 */
function normalizeConfig(raw: unknown): AppConfig {
  const src = isPlainObject(raw) ? raw : {}
  const accounts: Account[] = []
  const rawAccounts = Array.isArray(src.accounts) ? src.accounts : []
  rawAccounts.forEach((item, index) => {
    const acc = normalizeAccount(item)
    if (acc) accounts.push(acc)
    else logger.warn(`[store] config.json 第 ${index + 1} 条账号不合法，已丢弃`)
  })

  const noticeState: Record<string, NoticeState> = {}
  if (isPlainObject(src.notice_state)) {
    for (const [id, value] of Object.entries(src.notice_state)) {
      if (isPlainObject(value)) {
        noticeState[id] = { date: strOr(value.date), count: numOr(value.count, 0) }
      }
    }
  }

  const scheme: CryptoScheme = src.crypto && isPlainObject(src.crypto) && strOr(src.crypto.scheme) === 'obfuscate-v1'
    ? 'obfuscate-v1'
    : 'safeStorage-v1'

  return {
    version: numOr(src.version, CONFIG_VERSION),
    crypto: { scheme, version: CRYPTO_VERSION },
    settings: normalizeSettings(src.settings),
    accounts,
    notice_state: noticeState
  }
}

// ---------- Store ----------

export class Store {
  private config: AppConfig = defaultConfig()
  private status: 'ok' | 'recovered' | 'reset' = 'ok'
  private loaded = false

  /** 当前内存里的配置（只读用途，外部不要改） */
  get raw(): AppConfig {
    return this.config
  }

  /** 配置状态：ok 正常 / recovered 已从备份恢复 / reset 已重置为默认 */
  getConfigStatus(): 'ok' | 'recovered' | 'reset' {
    return this.status
  }

  /**
   * 从磁盘加载配置。
   * 正常 → 归一化；损坏 → 回滚 .bak（recovered）；连 .bak 也坏 → 默认配置（reset）。
   */
  load(): AppConfig {
    ensureDirs()
    this.loaded = true

    if (!fs.existsSync(CONFIG_FILE)) {
      this.config = defaultConfig()
      this.status = 'ok'
      this.save()
      return this.config
    }

    const parsed = this.readFile(CONFIG_FILE)
    if (parsed !== null) {
      this.config = normalizeConfig(parsed)
      this.status = 'ok'
      return this.config
    }

    // 主配置坏了：先归档，再尝试备份
    const archived = this.archiveCorrupt()
    const fromBak = fs.existsSync(CONFIG_BAK) ? this.readFile(CONFIG_BAK) : null
    if (fromBak !== null) {
      this.config = normalizeConfig(fromBak)
      this.status = 'recovered'
      logger.warn(`[store] config.json 读取失败，已回滚到上一次备份（坏文件已另存为 ${archived ?? '未知'}）`)
      this.save()
      return this.config
    }

    this.config = defaultConfig()
    this.status = 'reset'
    logger.error(`[store] config.json 与备份都不可用，已重置为默认配置（坏文件已另存为 ${archived ?? '未知'}）`)
    this.save()
    return this.config
  }

  /** 读一个 JSON 文件，失败返回 null */
  private readFile(file: string): unknown | null {
    try {
      const text = fs.readFileSync(file, 'utf8')
      const data: unknown = JSON.parse(text)
      if (!isPlainObject(data)) throw new Error('顶层不是对象')
      return data
    } catch (e) {
      logger.warn(`[store] 读取失败 ${file}：${(e as Error).message}`)
      return null
    }
  }

  /** 把坏掉的主配置另存为 config.corrupt-<ts>.json（不删除） */
  private archiveCorrupt(): string | null {
    try {
      const target = corruptFileName()
      fs.renameSync(CONFIG_FILE, target)
      return target
    } catch (e) {
      logger.error(`[store] 归档损坏配置失败：${(e as Error).message}`)
      return null
    }
  }

  /** 原子写：备份旧文件 → 写 tmp 并 fsync → rename 覆盖 */
  save(): void {
    ensureDirs()
    try {
      // .bak 备份节流（主文件靠原子写 tmp+fsync+rename 保证不写坏，.bak 只是二重保险）
      if (fs.existsSync(CONFIG_FILE) && Date.now() - lastBakAt >= BAK_MIN_INTERVAL_MS) {
        fs.copyFileSync(CONFIG_FILE, CONFIG_BAK)
        lastBakAt = Date.now()
      }
      const text = JSON.stringify(this.config, null, 2)
      const fd = fs.openSync(CONFIG_TMP, 'w')
      try {
        fs.writeFileSync(fd, text, 'utf8')
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(CONFIG_TMP, CONFIG_FILE)
    } catch (e) {
      logger.error(`[store] 保存配置失败：${(e as Error).message}`)
      throw e
    }
  }

  /** 确保已加载（防止调用方忘了先 load） */
  private ensureLoaded(): void {
    if (!this.loaded) this.load()
  }

  // ---------- 账号 ----------

  listAccounts(): Account[] {
    // 回收站中的账号不参与查询与展示
    // 演示模式：返回内置示例账号（不落盘、不含密钥）
    if (isDemo()) return demoAccounts()

    this.ensureLoaded()
    return this.config.accounts
  }

  getAccount(id: string): Account | null {
    if (isDemo()) return demoAccounts().find((a) => a.id === id) ?? null

    this.ensureLoaded()
    return this.config.accounts.find((a) => a.id === id) ?? null
  }

  /** 新增或更新账号；secret 为空字符串/undefined 表示「不修改密钥」 */
  saveAccount(input: AccountInput): Account {
    this.ensureLoaded()
    const type = input.type
    if (!ACCOUNT_TYPES.includes(type)) {
      throw new Error(`未知的平台类型：${String(type)}`)
    }
    const now = Date.now()
    const existing = input.id ? this.getAccount(input.id) : null

    let secretEnc: string | null = existing ? existing.secret_enc : null
    let secretMasked = existing ? existing.secret_masked : ''
    if (typeof input.secret === 'string' && input.secret.length > 0) {
      secretEnc = encrypt(input.secret)
      secretMasked = maskSecret(input.secret)
      // 方案可能随环境变化，落盘时同步记录当前方案
      this.config.crypto = { scheme: currentScheme(), version: CRYPTO_VERSION }
    }

    const meta = PROVIDER_META[type]
    const account: Account = {
      id: existing ? existing.id : randomUUID(),
      name: input.name?.trim() || (existing ? existing.name : '未命名账号'),
      type,
      enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
      secret_enc: secretEnc,
      secret_masked: secretMasked,
      // 续期材料沿用已有值（由 saveSession 单独更新），避免保存账号时被清掉
      session_enc: existing?.session_enc ?? null,
      token_expires_at: existing?.token_expires_at ?? null,
      created_at: existing ? existing.created_at : now,
      // 回收站状态同样必须保留：否则回收站里的账号一被编辑保存就"复活"成普通账号
      deleted_at: existing?.deleted_at ?? null,
      updated_at: now
    }

    if (Array.isArray(input.tags)) account.tags = normalizeTags(input.tags)
    if (input.base_url !== undefined) account.base_url = input.base_url.trim()
    else if (existing?.base_url !== undefined) account.base_url = existing.base_url

    if (input.user_id !== undefined) account.user_id = input.user_id.trim()
    else if (existing?.user_id !== undefined) account.user_id = existing.user_id

    account.quota_per_usd =
      input.quota_per_usd !== undefined && input.quota_per_usd !== null
        ? numOr(input.quota_per_usd, DEFAULT_QUOTA_PER_USD)
        : (existing?.quota_per_usd ?? DEFAULT_QUOTA_PER_USD)

    account.quota_total = input.quota_total !== undefined ? numOrNull(input.quota_total) : (existing?.quota_total ?? null)
    account.unit = input.unit !== undefined && input.unit ? input.unit : (existing?.unit ?? meta.defaultUnit)

    if (input.request !== undefined) account.request = input.request
    else if (existing?.request !== undefined) account.request = existing.request

    if (input.extract !== undefined) account.extract = input.extract
    else if (existing?.extract !== undefined) account.extract = existing.extract

    account.threshold = input.threshold !== undefined ? numOrNull(input.threshold) : (existing?.threshold ?? null)
    account.notice_enabled =
      input.notice_enabled !== undefined ? Boolean(input.notice_enabled) : (existing?.notice_enabled ?? true)

    account.last_status = existing?.last_status ?? null
    account.last_error = existing?.last_error ?? null
    account.last_ts = existing?.last_ts ?? null

    if (existing) {
      const index = this.config.accounts.findIndex((a) => a.id === existing.id)
      this.config.accounts[index] = account
    } else {
      this.config.accounts.push(account)
    }

    this.save()
    logger.info(`[store] ${existing ? '更新' : '新增'}账号：${account.name}（${account.type}）`)
    return account
  }

  /** 删除账号（快照不删，靠保留期自然淘汰） */
  removeAccount(id: string): boolean {
    this.ensureLoaded()
    const index = this.config.accounts.findIndex((a) => a.id === id)
    if (index < 0) return false
    const [removed] = this.config.accounts.splice(index, 1)
    delete this.config.notice_state[id]
    this.save()
    logger.info(`[store] 删除账号：${removed.name}`)
    return true
  }

  /** 记一次查询结果到账号上（T03 的 query.ts 调用） */
  updateLastResult(id: string, ok: boolean, note: string, ts: number = Date.now()): void {
    this.ensureLoaded()
    const account = this.getAccount(id)
    if (!account) return
    account.last_status = ok ? 'ok' : 'error'
    account.last_error = ok ? null : note
    account.last_ts = ts
    account.updated_at = ts
    this.save()
  }

  /** 解密取出明文密钥（只存在于主进程内存，绝不跨 IPC 传输）；双方案回退统一走 crypto.decryptWithFallback */
  getSecret(account: Account): string {
    const scheme = this.config.crypto?.scheme ?? currentScheme()
    return decryptWithFallback(account.secret_enc, scheme)
  }

  // ---------- 会话凭据（登录型平台的续期材料） ----------

  /** 读会话凭据（没有 / 解不开返回 null） */
  getSession(account: Account): CredentialSession | null {
    const enc = account.session_enc
    if (!enc) return null
    const scheme = this.config.crypto?.scheme ?? currentScheme()
    for (const s of [scheme, scheme === 'safeStorage-v1' ? 'obfuscate-v1' : 'safeStorage-v1'] as CryptoScheme[]) {
      const plain = decrypt(enc, s)
      if (!plain) continue
      try {
        const parsed = JSON.parse(plain) as CredentialSession
        if (parsed && typeof parsed.cookies === 'string') return parsed
      } catch {
        /* 试下一种方案 */
      }
    }
    return null
  }

  /**
   * 保存/更新一个账号的凭据（密钥 + 会话 + 过期时间）。
   * 供「静默续期」回写用：续期成功后把新 token 与新会话一起落盘，下次继续可用。
   */
  saveCredential(id: string, patch: { secret?: string; session?: CredentialSession | null; tokenExpiresAt?: number | null }): boolean {
    this.ensureLoaded()
    const acc = this.config.accounts.find((a) => a.id === id)
    if (!acc) return false
    if (typeof patch.secret === 'string' && patch.secret.length > 0) {
      acc.secret_enc = encrypt(patch.secret)
      acc.secret_masked = maskSecret(patch.secret)
      this.config.crypto = { scheme: currentScheme(), version: CRYPTO_VERSION }
    }
    if (patch.session !== undefined) {
      acc.session_enc = patch.session ? encrypt(JSON.stringify(patch.session)) : null
    }
    if (patch.tokenExpiresAt !== undefined) {
      acc.token_expires_at = patch.tokenExpiresAt
    }
    acc.updated_at = Date.now()
    this.save()
    return true
  }

  // ---------- 设置 ----------

  getSettings(): Settings {
    this.ensureLoaded()
    // 让「设置里的 timeout_ms」对所有 HTTP 请求真正生效（http.ts 的默认超时从这里同步）
    setDefaultTimeoutMs(this.config.settings.timeout_ms)
    return this.config.settings
  }

  /** 局部更新设置，返回归一化后的完整设置 */
  saveSettings(patch: Partial<Settings>): Settings {
    this.ensureLoaded()
    this.config.settings = normalizeSettings({ ...this.config.settings, ...patch })
    setDefaultTimeoutMs(this.config.settings.timeout_ms)
    this.save()
    logger.info('[store] 设置已更新')
    return this.config.settings
  }

  // ---------- 提醒状态（P1-1） ----------

  /** 取某账号今日提醒计数；跨自然日自动归零 */
  getNoticeState(id: string): NoticeState {
    this.ensureLoaded()
    const today = todayKey()
    const state = this.config.notice_state[id]
    if (!state || state.date !== today) return { date: today, count: 0 }
    return state
  }

  /** 提醒次数 +1（同一账号同一天最多 notice_max_per_day 次） */
  bumpNotice(id: string): void {
    this.ensureLoaded()
    const today = todayKey()
    const state = this.config.notice_state[id]
    const count = state && state.date === today ? state.count + 1 : 1
    this.config.notice_state[id] = { date: today, count }
    this.save()
  }
  /** 回收站中的账号 */
  listDeleted(): Account[] {
    this.ensureLoaded()
    return this.config.accounts.filter((a) => !!a.deleted_at)
  }

  /** 移入回收站（软删除） */
  softDelete(id: string): boolean {
    const acc = this.config.accounts.find((a) => a.id === id)
    if (!acc) return false
    acc.deleted_at = Date.now()
    acc.enabled = false
    acc.updated_at = Date.now()
    this.save()
    return true
  }

  /** 从回收站恢复 */
  restoreAccount(id: string): boolean {
    const acc = this.config.accounts.find((a) => a.id === id)
    if (!acc) return false
    acc.deleted_at = null
    acc.enabled = true
    acc.updated_at = Date.now()
    this.save()
    return true
  }

  /** 彻底删除（不可恢复） */
  purgeAccount(id: string): boolean {
    const i = this.config.accounts.findIndex((a) => a.id === id)
    if (i < 0) return false
    this.config.accounts.splice(i, 1)
    this.save()
    return true
  }

  /** 批量设置启用状态 / 标签 */
  bulkPatch(ids: string[], patch: { enabled?: boolean; tags?: string[] }): number {
    const set = new Set(ids)
    let n = 0
    for (const acc of this.config.accounts) {
      if (!set.has(acc.id)) continue
      if (typeof patch.enabled === 'boolean') {
        acc.enabled = patch.enabled
        if (patch.enabled) acc.deleted_at = null
      }
      if (Array.isArray(patch.tags)) acc.tags = normalizeTags(patch.tags)
      acc.updated_at = Date.now()
      n += 1
    }
    if (n > 0) this.save()
    return n
  }

  /** 密钥指纹（不可逆，用于查重）；无密钥返回空串 */
  fingerprint(id: string): string {
    const acc = this.getAccount(id)
    if (!acc) return ''
    const secret = this.getSecret(acc)
    if (!secret) return ''
    return createHash('sha256').update(secret).digest('hex').slice(0, 12)
  }

  /** 取密钥明文（仅本机渲染层复制用） */
  revealSecret(id: string): string {
    const acc = this.getAccount(id)
    if (!acc) return ''
    return this.getSecret(acc)
  }

}

/** 自然日 key（本地时区） */
function todayKey(ts: number = Date.now()): string {
  const d = new Date(ts)
  const p = (v: number): string => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 转成渲染进程视角（类型层面删掉 secret_enc，杜绝密文外泄） */
export function toView(account: Account): AccountView {
  const { secret_enc, ...rest } = account
  return { ...rest, has_secret: Boolean(secret_enc) }
}

/** 全局单例：主进程各处共用同一份配置 */
export const store = new Store()
