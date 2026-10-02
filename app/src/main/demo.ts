import type { Account, AccountType, BalanceRow, PlanUsageInfo, Snapshot } from '../shared/types'

/**
 * 演示模式：内置示例账号与最近 30 天的示例快照。
 *
 * 全部数据只存在于内存中——不写 config.json、不写 snapshots.json、不发起任何网络请求，
 * 关闭演示模式或退出应用即彻底消失，绝不会污染真实数据。
 */

let on = false

export function isDemo(): boolean {
  return on
}

export function setDemo(value: boolean): void {
  on = value
  if (!on) snapshotCache = null
}

interface DemoDef {
  id: string
  name: string
  type: AccountType
  unit: string
  start: number
  daily: number
  baseUrl?: string
  unstable?: boolean
}

const DEFS: DemoDef[] = [
  { id: 'demo-deepseek', name: '示例 · DeepSeek', type: 'deepseek', unit: 'CNY', start: 92.5, daily: 1.6 },
  { id: 'demo-siliconflow', name: '示例 · siliconflow', type: 'siliconflow', unit: 'CNY', start: 48.0, daily: 2.4, unstable: true },
  { id: 'demo-mimo', name: '示例 · Xiaomi MIMO', type: 'mimo', unit: 'CNY', start: 30.0, daily: 0.8 },
  { id: 'demo-minimax', name: '示例 · MiniMax', type: 'minimax', unit: 'CNY', start: 16.0, daily: 0.6 },
  { id: 'demo-zhipu', name: '示例 · bigmodel', type: 'zhipu', unit: 'CNY', start: 20.0, daily: 0.35 },
  { id: 'demo-mimo-plan', name: '示例 · MIMO TokenPlan', type: 'mimo-plan', unit: 'M Credits', start: 4100, daily: 42 }
]

const DAY_MS = 24 * 60 * 60 * 1000
const SAMPLE_PER_DAY = 8

/** 确定性伪随机：同一天同一序号永远得到同一结果，界面数值不会乱跳 */
function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

let snapshotCache: Snapshot[] | null = null

/** 最近 30 天的示例快照（每天 8 个采样点，含一次充值和少量失败） */
export function demoSnapshots(): Snapshot[] {
  if (snapshotCache) return snapshotCache
  const out: Snapshot[] = []
  const now = Date.now()
  const startDay = new Date(now)
  startDay.setHours(0, 0, 0, 0)
  const day0 = startDay.getTime() - 29 * DAY_MS
  const stepMs = DAY_MS / SAMPLE_PER_DAY
  for (const def of DEFS) {
    let remaining = def.start
    for (let d = 0; d < 30; d++) {
      for (let k = 0; k < SAMPLE_PER_DAY; k++) {
        const ts = day0 + d * DAY_MS + k * stepMs + Math.floor(noise(d * 31 + k) * 60000)
        if (ts > now) continue
        const jitter = 1 + (noise(d * 131 + k * 7) - 0.5) * 0.35
        const spend = (def.daily / SAMPLE_PER_DAY) * jitter
        remaining = Math.max(0.2, remaining - spend)
        // 第 12 天充值一次，用于演示「疑似充值」标注
        if (d === 12 && k === 0) remaining += def.daily * 6
        const fail = !!def.unstable && d % 11 === 5 && k === 3
        out.push({
          id: def.id + '-' + ts,
          account_id: def.id,
          ts,
          ok: !fail,
          remaining: fail ? null : Math.round(remaining * 100) / 100,
          total: null,
          used: def.unit === 'M Credits' ? Math.round((def.start - remaining) * 100) / 100 : null,
          unit: def.unit,
          note: fail ? '示例：平台返回 503（演示数据）' : '',
          items: [],
          latency_ms: Math.round(180 + noise(d * 17 + k * 3) * 900)
        })
      }
    }
  }
  snapshotCache = out
  return out
}

/** 演示账号（Account 形状；没有密钥） */
export function demoAccounts(): Account[] {
  const now = Date.now()
  return DEFS.map((def) => ({
    id: def.id,
    name: def.name,
    type: def.type,
    enabled: true,
    secret_enc: null,
    secret_masked: '演示模式（无密钥）',
    base_url: def.baseUrl,
    unit: def.unit,
    threshold: def.unit === 'M Credits' ? 300 : 20,
    notice_enabled: false,
    last_status: 'ok',
    last_error: null,
    last_ts: now,
    created_at: now,
    updated_at: now
  }))
}

/** 演示模式下的套餐明细（形状与 mimo-plan 适配器返回的 plan 一致，方便预览新卡片样式） */
function demoPlan(def: DemoDef, remaining: number): PlanUsageInfo | null {
  if (def.type !== 'mimo-plan') return null
  const used = Math.round((def.start - remaining) * 1e6) / 1e6
  const frac = def.start > 0 ? used / def.start : 0
  const price = 39
  return {
    planCode: 'lite',
    planName: 'Lite',
    periodEnd: new Date(Date.now() + 29 * DAY_MS).toISOString().slice(0, 10),
    expired: false,
    autoRenew: true,
    price,
    priceNote: 'Lite ¥39.00/月',
    percent: Math.round(frac * 10000) / 100,
    usedCny: Math.round(frac * price * 100) / 100,
    remainCny: Math.round((1 - frac) * price * 100) / 100,
    tokenWindow: '本计费周期（演示数据）',
    totalTokens: 65157997,
    requestCount: 173,
    models: [
      {
        model: 'mimo-v2.6-flash',
        category: '语言模型',
        totalTokens: 65157997,
        inputHitTokens: 64879680,
        inputMissTokens: 181638,
        outputTokens: 96679,
        requestCount: 173
      },
      {
        model: 'mimo-v2.5-pro',
        category: '语言模型',
        totalTokens: 12188648,
        inputHitTokens: 11070912,
        inputMissTokens: 1052817,
        outputTokens: 64919,
        requestCount: 207
      },
      {
        model: 'mimo-v2.5-tts',
        category: '语音合成模型',
        totalTokens: 486000,
        inputHitTokens: 0,
        inputMissTokens: 486000,
        outputTokens: 0,
        requestCount: 12
      }
    ]
  }
}

/** 当前余额行（带轻微抖动，让每次刷新看起来在动） */
export function demoRows(): BalanceRow[] {
  const now = Date.now()
  const phase = (now % 60000) / 60000
  return DEFS.map((def) => {
    // 用快照最后一条作为当前余额基准
    const snaps = demoSnapshots().filter((s) => s.account_id === def.id && s.ok)
    const last = snaps.length > 0 ? snaps[snaps.length - 1].remaining ?? def.start : def.start
    const drift = 1 - phase * 0.002
    const remaining = def.unit === 'M Credits' ? Math.round(last * drift) : Math.round(last * drift * 100) / 100
    const low = (def.unit === 'M Credits' ? 300 : 20) > remaining
    return {
      accountId: def.id,
      name: def.name,
      type: def.type,
      enabled: true,
      threshold: def.unit === 'M Credits' ? 300 : 20,
      lowBalance: low,
      ok: true,
      remaining,
      total: def.unit === 'M Credits' ? def.start : null,
      used: def.unit === 'M Credits' ? Math.round((def.start - remaining) * 100) / 100 : null,
      unit: def.unit,
      items: [],
      note: '演示数据',
      latencyMs: 260,
      ts: now,
      cached: false,
      plan: demoPlan(def, remaining)
    }
  })
}
