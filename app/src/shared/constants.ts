import type { AccountType, ProviderMeta, Settings } from './types'

/** newapi 换算比率默认值：1 美元 = 500000 站点点数（沿用 Python 原型） */
export const DEFAULT_QUOTA_PER_USD = 500000

/** 硅基流动默认站点地址（base_url 留空时用这个） */
export const DEFAULT_SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn'

/**
 * 积分 → 金额折算默认值：多少积分算 1 元。
 *
 * 默认 111111，即 **1 元 ≈ 11.11 万积分 / 100 万积分 ≈ 9 元**。
 * 由来（按 DeepSeek flash **高峰时段**价反推，2025-09 实测口径）：
 * - 某窗口总 Token 8.3M = 输入 8.1M（缓存命中 7M + 未命中 1.1M）+ 输出 160.6K
 * - 折人民币 = 7M×0.04 + 1.1M×2 + 0.1606M×8 ≈ 0.28 + 2.20 + 1.28 ≈ 3.76 元
 *   反推单位成本 ≈ 0.45 元/百万 Token（缓存命中率高时更低，故取 ~0.9 元/百万 Token 作保守上限）
 * - 平台把 1 元额度记为 10 万级积分，故 1 元 ≈ 11.11 万积分
 *
 * 只是**估算基线**（用于把不同单位放到同一把尺子上比较），不是平台官方汇率，
 * 可在「设置 → 成本折算」里改；设 0 表示不折算。
 */
export const DEFAULT_CREDITS_PER_CNY = 111111

/** 全局设置默认值。任何字段缺失/越界都会回落到这里（见 store.ts 的 normalizeSettings） */
export const DEFAULT_SETTINGS: Settings = {
  refresh_seconds: 300,
  pause_when_hidden: true,
  default_threshold: 20,
  default_threshold_relay: 2,
  notice_enabled: true,
  notice_max_per_day: 1,
  concurrency: 8,
  timeout_ms: 15000,
  cache_seconds: 60,
  snapshot_retention_days: 30,
  theme: 'dark',
  launch_at_login: false,
  daily_budget: {},
  drop_alert_percent: 30,
  fail_alert_count: 3,
  credits_per_cny: DEFAULT_CREDITS_PER_CNY,
  onboarded: false,
  bg_enabled: false,
  bg_file: '',
  bg_fit: 'cover',
  bg_dim: 35,
  bg_blur: 0,
  card_translucent: true,
  glass_enabled: true,
  glass_blur: 16,
  glass_alpha: 0.72
}

/** 设置弹窗的刷新间隔下拉选项（秒）：1 / 5 / 15 / 30 / 60 分钟 */
export const REFRESH_OPTIONS: number[] = [60, 300, 900, 1800, 3600]

/**
 * 四个平台的表单元数据。
 * 新增平台 = 这里加一条 + src/main/adapters 加一个文件并注册，界面无需改代码。
 */
export const PROVIDER_META: Record<AccountType, ProviderMeta> = {
  deepseek: {
    type: 'deepseek',
    label: 'DeepSeek',
    needSecret: true,
    needBaseUrl: false,
    needUserId: false,
    needRequest: false,
    needLogin: false,
    defaultUnit: 'CNY',
    defaultThreshold: DEFAULT_SETTINGS.default_threshold,
    secretHint: '在 platform.deepseek.com 后台生成，以 sk- 开头。只存本机，不会上传。'
  },
  siliconflow: {
    type: 'siliconflow',
    label: 'siliconflow',
    needSecret: true,
    needBaseUrl: false,
    needUserId: false,
    needRequest: false,
    needLogin: true,
    defaultUnit: 'CNY',
    defaultThreshold: DEFAULT_SETTINGS.default_threshold,
    secretHint: '官方已下线 API Key 余额接口（2026-08-14 起 /v1/user/info 返回 20092），点击下方「登录」进控制台登录一次，之后自动抓余额。'
  },
  newapi: {
    type: 'newapi',
    label: 'New API / One API 中转站',
    needSecret: true,
    needBaseUrl: true,
    needUserId: false,
    needRequest: false,
    needLogin: false,
    defaultUnit: 'USD',
    defaultThreshold: DEFAULT_SETTINGS.default_threshold_relay,
    secretHint: '在站点后台生成的令牌（一般 sk- 开头）。只填站点域名，不要带 /v1。'
  },
  custom: {
    type: 'custom',
    label: '自定义（抓包填写）',
    needSecret: false,
    needBaseUrl: false,
    needUserId: false,
    needRequest: true,
    needLogin: false,
    defaultUnit: '元',
    defaultThreshold: DEFAULT_SETTINGS.default_threshold,
    secretHint: '凭证（Cookie / Authorization 等）直接填在下面的「请求头」里。'
  },
  mimo: {
    type: 'mimo',
    label: 'Xiaomi MIMO',
    needSecret: true,
    needBaseUrl: false,
    needUserId: false,
    needRequest: false,
    needLogin: true,
    defaultUnit: 'CNY',
    defaultThreshold: DEFAULT_SETTINGS.default_threshold,
    secretHint: '点击下方「登录 MiMo 获取 Cookie」，在弹出的浏览器里登录一次，之后自动刷新，约 24 小时过期需重新登录。'
  },
  'mimo-plan': {
    type: 'mimo-plan',
    label: 'Xiaomi MIMO TokenPlan',
    needSecret: true,
    needBaseUrl: false,
    needUserId: false,
    needRequest: false,
    needLogin: true,
    defaultUnit: 'M Credits',
    defaultThreshold: 100,
    secretHint: '和「小米 MiMo」共用同一个登录状态：点「登录 MiMo 获取 Cookie」登录一次即可，显示套餐用量/额度与有效期。'
  },
  minimax: {
    type: 'minimax',
    label: 'MiniMax',
    needSecret: true,
    needBaseUrl: false,
    needUserId: false,
    needRequest: false,
    needLogin: true,
    defaultUnit: 'CNY',
    defaultThreshold: DEFAULT_SETTINGS.default_threshold,
    secretHint: '点击「登录 MiniMax」进控制台（platform.minimaxi.com）登录一次，之后自动抓余额（现金+代金券+授信−欠费）。'
  },
  zhipu: {
    type: 'zhipu',
    label: 'bigmodel',
    needSecret: true,
    needBaseUrl: false,
    needUserId: false,
    needRequest: false,
    needLogin: true,
    defaultUnit: 'CNY',
    defaultThreshold: DEFAULT_SETTINGS.default_threshold,
    secretHint: '点击「登录智谱」在开放平台（bigmodel.cn）登录一次，之后自动抓余额。'
  },
  aliyun: {
    type: 'aliyun',
    label: '阿里云百炼',
    needSecret: true,
    needBaseUrl: false,
    needUserId: false,
    needRequest: false,
    needLogin: false,
    defaultUnit: 'CNY',
    defaultThreshold: DEFAULT_SETTINGS.default_threshold,
    secretHint: '在阿里云 RAM 控制台创建只读 AccessKey（授权 AliyunBSSReadOnlyAccess），格式：AccessKey ID|AccessKey Secret，例如 LTAIabc123|你的秘密。只存本机加密。'
  },
  sensenova: {
    type: 'sensenova',
    label: 'SenseNova',
    needSecret: true,
    needBaseUrl: false,
    needUserId: false,
    needRequest: false,
    needLogin: true,
    defaultUnit: '积分',
    defaultThreshold: 6000,
    secretHint: '点击「登录」在商汤开放平台登录一次，自动获取登录态（额度接口只认登录态，不认 API Key）；登录态约 3 小时过期，过期后重新登录即可。'
  }
}

/** 账号类型顺序（界面下拉与 PROVIDERS 注册表共用；含历史类型，store 校验依赖它） */
export const ACCOUNT_TYPES: AccountType[] = ['deepseek', 'siliconflow', 'newapi', 'custom', 'mimo', 'mimo-plan', 'minimax', 'zhipu', 'aliyun', 'sensenova']

/**
 * 新增账号时**可选**的平台类型（界面下拉用）。
 * `newapi` / `custom` 两个选项已按用户要求从界面移除（2026-09-22），
 * 但类型本身保留在 ACCOUNT_TYPES 里：store 校验与适配器仍接受它们，
 * 已配置过的账号照常读写、查询不受影响，只是不能再新建。
 */
export const ACCOUNT_TYPE_OPTIONS: AccountType[] = ACCOUNT_TYPES.filter((t) => t !== 'newapi' && t !== 'custom')

/** DeepSeek 官方余额接口地址（固定，用户不可配） */
export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'

/** 小米 MiMo 登录页（小米账号统一登录，直达登录表单；登录完成自动检测并关闭窗口） */
export const MIMO_LOGIN_URL = 'https://account.xiaomi.com/fe/service/login/password?_group=DEFAULT&sid=api-platform&qs=%253Fcallback%253Dhttps%25253A%25252F%25252Fplatform.xiaomimimo.com%25252Fsts%25253Fsign%25253DM7gfywevl3CG5YTTcZDifhK6IK8%2525253D%252526followup%25253Dhttps%2525253A%2525252F%2525252Fplatform.xiaomimimo.com%2525252Fconsole%2525252Fbalance%2526sid%253Dapi-platform%2526_group%253DDEFAULT&callback=https%3A%2F%2Fplatform.xiaomimimo.com%2Fsts%3Fsign%3DM7gfywevl3CG5YTTcZDifhK6IK8%253D%26followup%3Dhttps%253A%252F%252Fplatform.xiaomimimo.com%252Fconsole%252Fbalance&_sign=iV9Q5kxBqXGdbkb6kmapXvJrkZM%3D&_locale=zh_CN'
/** 硅基流动控制台（登录 / Cookie 来源，登录后跳转到 cloud.siliconflow.cn） */
export const SILICONFLOW_LOGIN_URL = 'https://cloud.siliconflow.cn'

/** 小米 MiMo 现金余额接口（Cookie 方式） */
export const MIMO_BALANCE_URL = 'https://platform.xiaomimimo.com/api/v1/balance'
/** 小米 MiMo Token Plan 用量接口（Cookie 方式） */
export const MIMO_PLAN_URL = 'https://platform.xiaomimimo.com/api/v1/tokenPlan/usage'
/** 小米 MiMo Token Plan 套餐详情（Cookie 方式：套餐名 + 有效期） */
export const MIMO_PLAN_DETAIL_URL = 'https://platform.xiaomimimo.com/api/v1/tokenPlan/detail'
/** MiniMax 统一登录页（直达登录表单；登录完成自动检测并关闭窗口） */
export const MINIMAX_LOGIN_URL = 'https://account.minimax.cn/unified-login?login_redirect=%2Foauth2%2Fauthorize%3Fclient_id%3Dplatform-minimax%26redirect_uri%3Dhttps%253A%252F%252Fwww.minimax.cn%252Fauth%252Fcallback%26response_type%3Dcode%26state%3DeyJyZWRpcmVjdF91cmkiOiJodHRwczovL3BsYXRmb3JtLm1pbmltYXguY24vY29uc29sZS9wZXJzb25hbC1pbmZvIiwiY3NyZiI6IjU2NWRmN2M2LTA0ODUtNDczZC04NmEyLTEwZWY1OTI3YTBiMSJ9'
/** MiniMax 后端域名（钱包接口所在，.com 国际站 / .cn 国内站镜像） */
export const MINIMAX_BACKEND = 'https://www.minimaxi.com'
/** MiniMax 国内站后端域名（.cn 镜像，接口同构） */
export const MINIMAX_BACKEND_CN = 'https://www.minimax.cn'
/** MiniMax 主体信息（取 group_id） */
export const MINIMAX_ACCOUNT_URL = MINIMAX_BACKEND + '/backend/account'
/** 智谱 开放平台登录页（直达登录表单；登录完成自动检测并关闭窗口） */
export const ZHIPU_LOGIN_URL = 'https://bigmodel.cn/login?redirect=%2Fconsole%2Foverview'
/** 智谱 账户信息接口（余额） */
export const ZHIPU_ACCOUNT_URL = 'https://bigmodel.cn/api/biz/customer/accountSet'

// ---------------- 商汤 日日新（SenseNova） ----------------

/**
 * 控制台地址。未登录时会自动跳到商汤账号登录页，登录完成后回到控制台。
 * 额度数据只认 localStorage 里的 OAuth access_token（Bearer 方式），Cookie 无效（实测返回 401）。
 */
export const SENSENOVA_CONSOLE_URL = 'https://platform.sensenova.cn/console'
/** Token Plan 双积分池额度：pools[].window_5h / window_7d（5 小时窗口 + 周额度） */
export const SENSENOVA_POOL_USAGE_URL = 'https://platform.sensenova.cn/lite/console/v1/tokenplan/pool-usage'
/** 登录态在 localStorage 里的键名 */
export const SENSENOVA_TOKEN_KEY = 'access_token'

/**
 * 登录型平台的「登录分区」配置（**登录窗口与静默续期必须用同一个分区**）。
 *
 * 背景（2026-09-22 实测定位的 Bug）：
 * - 登录窗口原来按 `new URL(loginUrl).hostname` 建分区，小米的登录页在 `account.xiaomi.com`，
 *   于是登录态落在 `persist:login-account.xiaomi.com`；
 * - 而静默续期（renewal.ts）用的是 `persist:login-platform.xiaomimimo.com` —— 两个分区互不相通，
 *   续期永远拿不到能用的会话 Cookie（实测该分区只有 2026-09-09 的旧 passToken，从没被登录刷新过）；
 * - 商汤同理：分区里只有百度统计 Cookie，没有任何 `oauth2_authentication_session` 之类的会话 Cookie，
 *   续期脚本因此永远换不回 token。
 *
 * 现在把「分区 host」写在这里作为唯一口径，登录（ipc.ts）与续期（renewal.ts）都从这里取，避免再次漂移。
 */
export interface LoginPlatformRule {
  /** 登录窗口所在分区的主机名（= 续期脚本用的分区；必须是真正持有会话 Cookie 的那个域） */
  partitionHost: string
  /** 登录成功判定的页面规则（进入这些 host + 路径即视为"登录后"） */
  success?: { hosts: string[]; pathPrefix?: string }
  /** 额外按这些 URL 抓 Cookie（会话 Cookie 可能分布在多个域） */
  extra: string[]
  /** 登录态存放在 localStorage 的键名（商汤这类只认 Bearer token 的平台） */
  tokenKey?: string
  /** 续期材料里记录 token 键名用（与 tokenKey 一致即可） */
  sessionTokenKey?: string
  /** 采集续期材料要读的域名（缺省用 extra） */
  cookieUrls?: string[]
}

export const LOGIN_RULES: Record<string, LoginPlatformRule> = {
  mimo: {
    // 关键：分区挂在 platform.xiaomimimo.com 上。登录页虽然跳到 account.xiaomi.com，
    // 但回调会回到 platform.xiaomimimo.com/sts 并在**这个域**下发会话 Cookie，
    // 只有分区不变，续期才能读到同一份会话。
    partitionHost: 'platform.xiaomimimo.com',
    extra: ['https://platform.xiaomimimo.com', 'https://xiaomimimo.com'],
    cookieUrls: ['https://platform.xiaomimimo.com', 'https://xiaomimimo.com', 'https://account.xiaomi.com']
  },
  'mimo-plan': {
    partitionHost: 'platform.xiaomimimo.com',
    extra: ['https://platform.xiaomimimo.com', 'https://xiaomimimo.com'],
    cookieUrls: ['https://platform.xiaomimimo.com', 'https://xiaomimimo.com', 'https://account.xiaomi.com']
  },
  minimax: {
    partitionHost: 'platform.minimaxi.com',
    success: { hosts: ['platform.minimaxi.com', 'platform.minimax.cn'], pathPrefix: '/console/' },
    extra: [
      'https://www.minimaxi.com',
      'https://www.minimax.cn',
      'https://platform.minimaxi.com',
      'https://platform.minimax.cn'
    ]
  },
  zhipu: {
    partitionHost: 'bigmodel.cn',
    success: { hosts: ['bigmodel.cn'], pathPrefix: '/console/' },
    extra: []
  },
  sensenova: {
    // 商汤的额度接口只认登录态（Bearer token，存在 localStorage.access_token），Cookie 抓了也没用，
    // 但**续期要靠分区里的会话 Cookie**（oauth2_*）在隐藏窗口里换回新 token，所以分区同样必须是
    // platform.sensenova.cn，登录与续期共用一份会话。
    partitionHost: 'platform.sensenova.cn',
    tokenKey: SENSENOVA_TOKEN_KEY,
    sessionTokenKey: SENSENOVA_TOKEN_KEY,
    extra: [],
    cookieUrls: ['https://platform.sensenova.cn', 'https://iam.sensecoreapi.cn']
  }
}

/** 登录分区名（登录窗口与续期脚本共用；host 必须与 LOGIN_RULES[*].partitionHost 一致） */
export function loginPartition(partitionHost: string): string {
  return 'persist:login-' + partitionHost
}

/**
 * 凭据类型鉴别：
 * - apiKey：用 API Key / 令牌访问（DeepSeek、New API 中转站、自定义）→ 属于「Key 管理」的范畴
 * - cookie：登录 Cookie / 登录态型（MiMo / MiniMax / 智谱 / 硅基流动 / 商汤日日新）
 * - accessKey：云厂商 AK/SK（阿里云百炼）
 */
export type CredentialKind = 'apiKey' | 'cookie' | 'accessKey'

export function credentialKind(type: AccountType): CredentialKind {
  if (type === 'deepseek' || type === 'newapi' || type === 'custom') return 'apiKey'
  if (type === 'aliyun') return 'accessKey'
  return 'cookie'
}

/** 新建 Key 时的平台预设（选中后自动填调用地址；含历史类型，供已有 Key 的地址回查） */
export const KEY_PRESETS: { type: AccountType; label: string; base_url: string; hint: string }[] = [
  {
    type: 'deepseek',
    label: 'DeepSeek',
    base_url: 'https://api.deepseek.com',
    hint: '在 DeepSeek 开放平台 → API Keys 创建，密钥以 sk- 开头'
  },
  {
    type: 'newapi',
    label: 'New API / One API 中转站',
    base_url: '',
    hint: '填你的中转站域名（不要带 /v1），令牌一般以 sk- 开头'
  },
  {
    type: 'custom',
    label: '自定义（抓包 / 自建服务）',
    base_url: '',
    hint: '自定义请求地址与取值路径，适合自建或小众平台'
  }
]

/** 新建 Key 下拉里**可选**的预设（newapi / custom 已按用户要求从界面移除，仅历史 Key 保留回查） */
export const KEY_PRESET_OPTIONS = KEY_PRESETS.filter((p) => p.type !== 'newapi' && p.type !== 'custom')
