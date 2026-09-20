/**
 * 全端共用类型定义。
 *
 * 命名约定（重要）：
 * - 落盘结构（Account / Snapshot / Settings）字段一律 snake_case，与 PRD 5.1~5.3 逐字一致；
 * - 运行时传输结构（BalanceResult / BalanceRow / PanelPayload / AppInfo）用 camelCase。
 *
 * 本文件不得 import 任何 node: / electron 模块（渲染进程也要用）。
 */

// ---------- 基础枚举 ----------

/** 支持的账号类型 */
export type AccountType =
  | 'deepseek'
  | 'siliconflow'
  | 'newapi'
  | 'custom'
  | 'mimo'
  | 'mimo-plan'
  | 'minimax'
  | 'zhipu'
  | 'aliyun'
  | 'sensenova'

/** 统一错误码：适配器只抛码，人话文案由主进程 errors.ts 统一产出 */
export type ErrorCode =
  | 'HTTP_401'
  | 'HTTP_403'
  | 'HTTP_404'
  | 'HTTP_429'
  | 'HTTP_5XX'
  | 'HTTP_OTHER'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'CERT'
  | 'BAD_JSON'
  | 'BAD_PATH'
  | 'MISSING_FIELD'
  | 'BAD_URL'
  | 'BAD_HEADER'
  | 'UNKNOWN_TYPE'
  | 'COOKIE_EXPIRED'
  | 'UNKNOWN'

// ---------- Account（落盘，snake_case） ----------

/** 自定义平台的请求配置 */
export interface CustomRequest {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
}
/** 自定义平台的"子项数组"提取配置 */
export interface CustomExtractItem {
  /** 数组所在路径，如 data.plans */
  from: string
  /** 子项名称字段，默认 name */
  name?: string
  remaining?: string
  total?: string
  used?: string
}

/** 自定义平台的取值路径配置 */
export interface CustomExtract {
  /** 点号路径，如 data.balance */
  remaining?: string
  total?: string
  used?: string
  unit?: string
  /** 倍率，默认 1 */
  scale?: number
  note?: string
  items?: CustomExtractItem[]
}

/**
 * 会话凭据（登录型平台的「续期材料」）。
 *
 * 为什么需要它：商汤 / 小米这类平台的登录态是「会话 Cookie + 短期 token」结构，
 * token 只活几小时，但只要有会话 Cookie 就能静默换新的。把会话一起存下来，
 * 就能在 token 过期时自动续期，用户不用反复重新登录。
 *
 * 明文只在主进程内存里，落盘时同样走 safeStorage 加密（account.session_enc）。
 */
export interface CredentialSession {
  /** 抓取时间 */
  ts: number
  /** 会话 Cookie（name=value; name2=value2） */
  cookies: string
  /** localStorage 里的登录态键名，供续期窗口比对 */
  tokenKey: string
  /** 上次抓取时登录态的长度（只用于判断"有没有变化"，不用于还原） */
  tokenLen: number
  /** 格式版本，便于以后调整结构 */
  v: number
}

/** 一个被监控的账号（磁盘上的形态） */
export interface Account {
  id: string
  name: string
  type: AccountType
  /** 默认 true；false 不查询、不展示 */
  enabled: boolean
  /** 一期不用，保留 */
  group?: string
  /** 磁盘上的密文（base64），明文永不落盘 */
  secret_enc: string | null
  /** 界面展示用，如 sk-****1234 */
  secret_masked: string
  /** 续期材料密文（base64）：会话 Cookie 等；登录型平台才有 */
  session_enc?: string | null
  /** 当前凭据的过期时间（毫秒时间戳；null = 未知），用于到期前自动续期 */
  token_expires_at?: number | null
  /** newapi 必填；siliconflow 可选（默认 https://api.siliconflow.cn） */
  base_url?: string
  /** newapi 可选，New-API-User */
  user_id?: string
  /** newapi 换算比率，默认 500000 */
  quota_per_usd?: number
  /** 平台不给总额时手填（DeepSeek）；null = 未填 */
  quota_total?: number | null
  /** 显示单位：CNY / USD / 元 / 积分 */
  unit?: string
  /** custom 必填 */
  request?: CustomRequest
  /** custom 必填 */
  extract?: CustomExtract
  /** custom 倍率，默认 1（custom 以 extract.scale 为准） */
  scale?: number
  /** 低余额阈值，null = 用全局默认 */
  threshold?: number | null
  notice_enabled?: boolean
  /** 用途标签（如 生产 / 测试 / 项目A），最多 8 个 */
  tags?: string[]
  /** 回收站：非空表示已删除（不查询、不显示），可恢复 */
  deleted_at?: number | null
  last_status?: 'ok' | 'error' | null
  last_error?: string | null
  last_ts?: number | null
  created_at: number
  updated_at: number
}

// ---------- 渲染进程视角（不含任何明文/密文） ----------

/** 传给渲染进程的账号视图：类型层面就删掉了 secret_enc */
export type AccountView = Omit<Account, 'secret_enc'> & { has_secret: boolean }

/** 新增/编辑账号的入参 */
export interface AccountInput {
  /** 有 = 编辑，无 = 新增 */
  id?: string
  name: string
  type: AccountType
  enabled: boolean
  /** 留空 / undefined = 不修改密钥（编辑场景） */
  secret?: string
  base_url?: string
  user_id?: string
  quota_per_usd?: number
  quota_total?: number | null
  unit?: string
  request?: CustomRequest
  extract?: CustomExtract
  threshold?: number | null
  notice_enabled?: boolean
  tags?: string[]
}

// ---------- 余额结果（运行时，camelCase） ----------

/** 子项明细，如 DeepSeek 的赠送余额 / 充值余额 */
export interface BalanceItem {
  planName: string
  remaining: number | null
  total: number | null
  used: number | null
  unit: string
  /** 选填说明文字（如「现金 ¥7.81 · 可透支 ¥0」） */
  note?: string
}

/** 一次查询的结果 */
export interface BalanceResult {
  ok: boolean
  remaining: number | null
  total: number | null
  /** 未取到时由 total - remaining 推导 */
  used: number | null
  unit: string
  /** 备注 / 失败时的人话原因 */
  note: string
  items: BalanceItem[]
  /** 查询时刻（毫秒） */
  ts: number
  latencyMs: number
  cached: boolean
  /** ok=false 时必有 */
  errorCode?: ErrorCode
  /** 原始信息小字（仅供排查，界面用小字展示） */
  errorDetail?: string
}

/** 一行卡片数据 = 结果 + 账号信息 */
export interface BalanceRow extends BalanceResult {
  accountId: string
  name: string
  type: AccountType
  enabled: boolean
  threshold: number | null
  /** 成功且 remaining < threshold */
  lowBalance: boolean
}

/** 全量刷新后推给界面的一批数据 */
export interface PanelPayload {
  rows: BalanceRow[]
  ts: number
  refreshSeconds: number
}

// ---------- Snapshot（落盘，snake_case） ----------

export interface SnapshotItem {
  planName: string
  remaining: number | null
  total: number | null
  used: number | null
  unit: string
}

export interface Snapshot {
  id: string
  account_id: string
  ts: number
  ok: boolean
  remaining: number | null
  total: number | null
  used: number | null
  unit: string
  note: string
  items: SnapshotItem[]
  latency_ms: number
  source: 'live' | 'cache'
}

// ---------- Settings（落盘，snake_case） ----------

export interface Settings {
  /** 默认 300（已拍板） */
  refresh_seconds: number
  pause_when_hidden: boolean
  /** 官方平台默认阈值（已拍板 20） */
  default_threshold: number
  /** 中转站默认阈值（已拍板 2） */
  default_threshold_relay: number
  notice_enabled: boolean
  notice_max_per_day: number
  concurrency: number
  timeout_ms: number
  cache_seconds: number
  snapshot_retention_days: number
  /** 主题标识：'dark' / 'light' / 'system'，或设计师主题 slug（如 deep-space-dark） */
  theme: string
  launch_at_login: boolean

  // ---------- 每日预算 ----------
  /** 每日预算上限：单位 → 金额（0 或缺省 = 不限） */
  daily_budget: Record<string, number>

  // ---------- 可用性监控 ----------

  // ---------- 提醒增强 ----------
  /** 余额骤降告警阈值（百分比，0 = 关闭） */
  drop_alert_percent: number
  /** 连续失败多少次后告警（0 = 关闭） */
  fail_alert_count: number

  // ---------- 新手引导 ----------
  /** 是否已完成首次引导 */
  onboarded: boolean

  // ---------- 背景与卡片 ----------
  /** 是否启用自定义背景图 */
  bg_enabled: boolean
  /** 背景文件名（存在数据目录 backgrounds/ 下） */
  bg_file: string
  /** 填充方式 */
  bg_fit: 'cover' | 'contain' | 'repeat'
  /** 蒙版强度（0-80，越大越压暗/提亮，保证文字可读） */
  bg_dim: number
  /** 背景模糊（0-20px） */
  bg_blur: number
  /** 卡片半透明（默认开，卡片 85% 不透明，让背景透出来） */
  card_translucent: boolean
  /** 液态玻璃（毛玻璃）效果：背景透过界面并高斯模糊 */
  glass_enabled: boolean
  /** 玻璃模糊半径（px） */
  glass_blur: number
  /** 玻璃通透度：越小越透（0.3~0.95） */
  glass_alpha: number
}


// ---------- 可用性监控 ----------

// ---------- AI 使用报告（只基于金额） ----------

export type ReportPeriod = 'day' | 'week' | 'month'

export interface UsageReport {
  period: ReportPeriod
  title: string
  fromTs: number
  toTs: number
  /** 主单位（合计最大的单位） */
  unit: string
  totalByUnit: { unit: string; value: number }[]
  /** 各平台占比（同一单位内） */
  platformShare: { type: string; unit: string; value: number; pct: number }[]
  topAccount: { name: string; value: number; unit: string } | null
  topDay: { label: string; value: number; unit: string } | null
  /** 上一个等长周期的合计（同主单位），无数据为 null */
  prevTotal: number | null
  /** 环比百分比（正=比上期多花），无对比为 null */
  deltaPct: number | null
  /** 24 小时消耗分布（主单位，按快照采样间隔推断） */
  activeHours: { hour: number; value: number }[]
  /** 有消耗的天数 / 统计天数 */
  activeDays: number
  totalDays: number
  avgDaily: number | null
  /** 疑似充值事件 */
  recharges: { ts: number; name: string; amount: number; unit: string }[]
  /** 趣味里程碑文案 */
  milestones: string[]
  /** 采样精度（分钟）——时段分布的可靠度取决于它 */
  sampleMinutes: number
}

// ---------- 接口监控（用户自填 Key + 地址，定期真实调用） ----------

export interface Monitor {
  id: string
  name: string
  /** 调用地址（完整 URL） */
  url: string
  method: 'GET' | 'POST'
  /** POST 请求体（JSON 字符串，支持 {{key}} 占位） */
  body: string
  /** 自定义请求头（值支持 {{key}} 占位） */
  headers: Record<string, string>
  /** 密文，明文永不落盘 */
  secret_enc: string | null
  secret_masked: string
  secret_scheme: string
  /** 检查间隔（分钟） */
  interval_minutes: number
  timeout_ms: number
  enabled: boolean
  created_at: number
  updated_at: number
}

/** 渲染进程视角（不含密文） */
export type MonitorView = Omit<Monitor, 'secret_enc'> & { has_secret: boolean }

export interface MonitorInput {
  id?: string
  name: string
  url: string
  method: 'GET' | 'POST'
  body?: string
  headers?: Record<string, string>
  /** 留空 = 不修改密钥（编辑场景） */
  secret?: string
  interval_minutes?: number
  timeout_ms?: number
  enabled?: boolean
}

/** 一次检查结果 */
export interface MonitorCheck {
  monitorId: string
  ts: number
  ok: boolean
  /** HTTP 状态码，0 = 请求未发出（超时/网络错误） */
  status: number
  latency_ms: number
  error: string
}

export interface MonitorStat {
  monitorId: string
  total: number
  okCount: number
  successRate: number | null
  avgLatency: number | null
  p95Latency: number | null
  lastTs: number | null
  lastOk: boolean | null
  lastStatus: number | null
  lastError: string
  lastFailTs: number | null
  consecutiveFails: number
  checksToday: number
  /** 近 N 天每日可用率 */
  days: { label: string; ts: number; ok: number; total: number; rate: number | null }[]
}

export interface MonitorReport {
  monitors: { monitor: MonitorView; stat: MonitorStat }[]
  note: string
}
// ---------- Key 管理 ----------

/** 一行 key 的汇总信息（渲染层再合并余额/可用率） */
export interface KeyRow {
  id: string
  name: string
  type: AccountType
  enabled: boolean
  secretMasked: string
  hasSecret: boolean
  /** 密钥指纹（前 12 位，用于查重；不可逆） */
  fingerprint: string
  tags: string[]
  unit: string
  threshold: number | null
  baseUrl: string
  lastStatus: 'ok' | 'error' | null
  lastError: string
  lastTs: number | null
  createdAt: number
  updatedAt: number
  /** 是否在回收站 */
  deleted: boolean
  deletedAt: number | null
  /**
   * 来源：
   * - account：在「添加账号」里用 API Key 建的（会参与余额查询，自动出现在这里，单向同步）
   * - vault：在 Key 管理里新建的独立 Key（只做整理/复制用，不会变成账号，也不查询）
   */
  source: 'account' | 'vault'
}

/** 独立 Key 库的新增/编辑入参 */
export interface KeyVaultInput {
  id?: string
  name: string
  type: string
  base_url?: string
  secret?: string
  tags?: string[]
  enabled?: boolean
}

/** 安全审计条目 */
export type KeyAuditKind = 'stale' | 'unused' | 'duplicate' | 'format'

export interface KeyAuditItem {
  id: string
  kind: KeyAuditKind
  /** 严重度：warn 提示 / info 参考 */
  level: 'warn' | 'info'
  message: string
}

export interface KeyListReport {
  rows: KeyRow[]
  deleted: KeyRow[]
  tags: string[]
  audit: KeyAuditItem[]
  note: string
}

export type KeyBulkAction = 'enable' | 'disable' | 'delete' | 'restore' | 'purge' | 'tag'

/** 日志级别（与主进程 logger 一致） */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

// ---------- 其它 ----------

/** 启动信息，界面"关于 / 加密状态"用 */
export interface AppInfo {
  version: string
  dataDir: string
  configPath: string
  /** safeStorage 是否可用 */
  secure: boolean
  /** 配置是否被恢复/重置 */
  configStatus: 'ok' | 'recovered' | 'reset'
  noticeSupported: boolean
}

/** 每日使用状况：单个账号（与 DailyUsageReport.days 对齐，null = 该日无数据） */
export interface DailyAccount {
  accountId: string
  name: string
  type: AccountType
  unit: string
  /** 用量型（有 used 累计值 → 直接算增量）；false = 余额型（按剩余差估算） */
  hasUsed: boolean
  /** 最新已知剩余 */
  remaining: number | null
  /** 与 days 对齐：该日疑似充值（剩余反而增加 → 当日消耗无法计算） */
  rechargeFlags: boolean[]
  /** 与 days 对齐：该日被单独标记的「停机期间消耗」（软件未运行期间的余额下降），null = 无 */
  gapDays: (number | null)[]
  /** 近 N 天「停机期间消耗」合计（不计入 days / 日均 / 耗尽预估 / 预算判断） */
  gapTotal: number
  /** 智能阈值建议（近 7 天日均 × 3；数据不足为 null） */
  suggestedThreshold: number | null
  /** 累计总额（进度条分母）：余额每上升一次就把增量累加进来，充值后自动进入新一轮 */
  creditTotal: number | null
  /** 最近一次余额上升（充值）的时间——趋势图据此只画当前这一轮 */
  cycleStartTs: number | null
  /** 最近 N 天每日消耗 */
  days: (number | null)[]
  /** 今日消耗 */
  today: number | null
  /** 近 7 天日均消耗（有效日 < 2 → null） */
  avg7: number | null
  /** 按日均消耗外推剩余天数（null = 无法推算） */
  forecastDaysLeft: number | null
  /** 预计耗尽时间戳（ms，null = 无法推算） */
  estEmptyTs: number | null
}

/** 每日使用状况报告（主进程按快照聚合） */

/** 平台用量统计（按平台类型 × 单位聚合的每日消耗） */
export interface PlatformUsageRow {
  /** 平台类型（如 deepseek） */
  type: string
  unit: string
  hasUsed: boolean
  /** 与报告 days 对齐的逐日消耗 */
  days: (number | null)[]
  today: number | null
  /** 近 N 天合计（有值日之和） */
  total: number | null
  avg7: number | null
  /** 近 N 天「停机期间消耗」合计（未计入 days / 合计 / 日均） */
  gapTotal: number
}

/** 按单位汇总行（每日使用状况 / 平台用量共用） */
export interface UnitTotalRow {
  unit: string
  days: (number | null)[]
  today: number | null
  total7: number | null
  /** 与 days 对齐：该日「停机期间消耗」合计，null = 无 */
  gapDays: (number | null)[]
  /** 近 N 天「停机期间消耗」合计 */
  gapTotal: number
}

export interface PlatformUsageReport {
  days: { label: string; ts: number }[]
  platforms: PlatformUsageRow[]
  unitTotals: UnitTotalRow[]
  note: string
}
export interface DailyUsageReport {
  /** 日期列头（最近 N 天，含今天）：label = MM-DD */
  days: { label: string; ts: number }[]
  /** 各账号行 */
  accounts: DailyAccount[]
  /** 按单位合计（每单位一行，与 days 对齐） */
  unitTotals: UnitTotalRow[]
  /** 统计备注（如部分账号缺少数据） */
  note: string
}

/** 汇率信息（成本折算用） */
export interface FxInfo {
  /** 1 USD = ? CNY */
  rate: number
  /** 汇率更新时间（毫秒） */
  ts: number
  /** live=本次联网取到 / cache=联网失败用上次缓存 / fallback=无缓存时用内置兜底 */
  source: 'live' | 'cache' | 'fallback'
}

/** 平台元数据：驱动界面动态渲染字段 */
export interface ProviderMeta {
  type: AccountType
  /** 'DeepSeek 官方' */
  label: string
  needSecret: boolean
  needBaseUrl: boolean
  needUserId: boolean
  needRequest: boolean
  /** 是否需要「浏览器登录取 Cookie」按钮（mimo 等无 API Key 的平台） */
  needLogin: boolean
  defaultUnit: string
  defaultThreshold: number
  secretHint: string
}
