import type {
  AccountType,
  DailyAccount,
  DailyUsageReport,
  PlatformUsageReport,
  PlatformUsageRow,
  ReportPeriod,
  Snapshot,
  UsageReport,
  UsageReportUnit
} from '../shared/types'
import { fmtNumber } from '../shared/format'
import { PROVIDER_META } from '../shared/constants'
import { logger } from './logger'
import { readSnapshots } from './snapshot'
import { store } from './store'

/**
 * 每日使用状况统计 + 余额耗尽预估。
 *
 * 数据源：snapshots.json（每次查询成功都会落一条，含 used / remaining / unit）。
 * - 用量型账号（套餐，有 used 累计值）→ 当日消耗 = 当日最后 used − 当日最早 used（累计增量）
 * - 余额型账号 → 当日消耗 = 参考值 − 当日最后 remaining；参考值取该日之前最后一次剩余，
 *   没有就用当日第一次（缺点：中途充值会掩盖消耗，只作参考，界面有说明）
 * - 日均消耗 = 近 7 天有效日均（少于 2 个有效日 → 无法推算）
 * - 耗尽天数 = 剩余 / 日均；用量型剩余 = total − latest used，没有 total 就用 latest remaining
 */

const DAY_MS = 24 * 60 * 60 * 1000

interface DaySlice {
  start: number
  end: number
  label: string
}

export function daySlices(days: number): DaySlice[] {
  const out: DaySlice[] = []
  const now = Date.now()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * DAY_MS)
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    const end = start + DAY_MS
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    out.push({ start, end, label: mm + '-' + dd })
  }
  return out
}

/** 数组里第一个/最后一个非空 used（都算不到返回 null） */
function usedAt(list: Snapshot[], wantFirst: boolean): number | null {
  return usedSnapAt(list, wantFirst)?.used ?? null
}

/** 数组里第一个/最后一个含有效 used 的快照（带时间戳，跨期判定用） */
function usedSnapAt(list: Snapshot[], wantFirst: boolean): { ts: number; used: number } | null {
  const seq = wantFirst ? list : list.slice().reverse()
  for (const s of seq) {
    if (s.used !== null && s.used !== undefined && Number.isFinite(s.used)) return { ts: s.ts, used: s.used }
  }
  return null
}

/** 该时刻之前最后一条快照（带时间戳与剩余，跨期判定用）；没有返回 null */
function refSnapshot(list: Snapshot[], beforeTs: number): { ts: number; remaining: number | null } | null {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].ts < beforeTs) {
      const v = list[i].remaining
      return { ts: list[i].ts, remaining: v !== null && v !== undefined && Number.isFinite(v) ? v : null }
    }
  }
  return null
}

/**
 * 判断账号是否真的是「用量型」（用 used 累计值算消耗）。
 *
 * 判定标准（实测踩过的坑）：
 * - 阿里云账号的 `used` 有值但**长期恒定**（92.03 不动），若据此算消耗 → 当天消耗恒为 0，
 *   真实的余额下降（例如代金券掉的 207.97）被完全忽略；
 * - 真正的用量型（如小米 MiMo 套餐）是**余额基本不动、used 一路增长**。
 *
 * 所以：只有「余额几乎不变 且 used 明显在增长」才按用量型处理，其余一律按余额（remaining）算。
 */
export function isUsageBased(list: Snapshot[]): boolean {
  const rem = list.map((s) => s.remaining).filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v))
  const used = list.map((s) => s.used).filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v))
  if (used.length < 2) return false
  const span = (arr: number[]): number => (arr.length < 2 ? 0 : Math.max(...arr) - Math.min(...arr))
  const relSpan = (arr: number[]): number => {
    if (arr.length < 2) return 0
    const mx = Math.max(...arr)
    const mn = Math.min(...arr)
    return (mx - mn) / Math.max(Math.abs(mx), Math.abs(mn), 1)
  }
  const usedGrows = used[used.length - 1] > used[0]
  const remSpan = span(rem)
  const remRel = relSpan(rem)
  // 用量型：余额基本不动（相对波动 < 1%）+ used 明显增长（相对 > 1%）
  return remRel < 0.01 && usedGrows && relSpan(used) > 0.01
}

/**
 * 跨期（停机）判定：**不能**用「刷新间隔 × 3」当阈值 —— 那会把"跨零点那次刷新"也算成停机。
 * 例如刷新间隔 5 分钟、最后一条在 23:57、次日第一条在 00:02，间隔也才 5 分钟；但若最后一条在
 * 23:30、次日第一条在 00:30，间隔 1 小时就会被误判 → 当天消耗被整段剥离，报表数字直接失真。
 *
 * 现在的口径：
 * - 硬下限 **2 小时**：跨零点那种 1 小时左右的正常空档不再算停机；
 * - 动态下限 **刷新间隔 × 3**（刷新间隔调大时同步放宽，例如 30 分钟刷新 → 90 分钟）。
 * 真正的停机（关软件几小时/几天）间隔远大于这个值，仍能被正确识别。
 */
export function gapLimitMs(): number {
  const seconds = store.getSettings().refresh_seconds || 300
  return Math.max(2 * 60 * 60 * 1000, seconds * 3 * 1000)
}

interface DailyDetail {
  /** 与 days 对齐的当日消耗（跨期部分已剥离） */
  values: (number | null)[]
  /** 与 days 对齐：该日疑似充值 */
  rechargeFlags: boolean[]
  /** 与 days 对齐：该日被单独标记的「停机期间消耗」，null = 无 */
  gapDays: (number | null)[]
  /** 窗口内「停机期间消耗」合计 */
  gapTotal: number
}

/**
 * 单账号逐日消耗明细。
 *
 * - values：当日真实消耗。若「当天第一条快照」距「上一条快照」超过 gapMs（软件没在运行），
 *   这段下降不计入当天，改记入 gapDays —— 否则关几天再打开会把整段消耗堆到重启那天。
 * - gapDays/gapTotal：跨期（停机）消耗，单独标记，不参与日均、预估与预算判断。
 */
/** 保留 4 位小数（统计口径统一用它，避免浮点毛刺） */
function round4(v: number): number {
  return Math.round(v * 10000) / 10000
}

export function dailyConsumedDetailed(
  list: Snapshot[],
  slices: DaySlice[],
  hasUsed: boolean,
  gapMs: number
): DailyDetail {
  const values: (number | null)[] = []
  const rechargeFlags: boolean[] = []
  const gapDays: (number | null)[] = []
  let gapTotal = 0

  for (const sl of slices) {
    const inDay = list.filter((s) => s.ts >= sl.start && s.ts < sl.end)
    if (inDay.length === 0) {
      values.push(null)
      rechargeFlags.push(false)
      gapDays.push(null)
      continue
    }
    const ref = refSnapshot(list, sl.start)

    if (hasUsed) {
      // 用量型（套餐累计值）：当日消耗 = 当日首末 used 之差，天然不含停机期
      const first = usedSnapAt(inDay, true)
      const last = usedSnapAt(inDay, false)
      values.push(first === null || last === null ? null : Math.max(0, round4(last.used - first.used)))
      rechargeFlags.push(false)
      // 停机期间用量：当天首条 used − 当天之前最后一条 used（间隔过大才标记）
      let gap: number | null = null
      const before = list.filter((s) => s.ts < sl.start)
      const refUsed = usedSnapAt(before, false)
      if (first && refUsed && first.ts - refUsed.ts > gapMs) {
        const d = first.used - refUsed.used
        if (d > 1e-9) gap = round4(d)
      }
      gapDays.push(gap)
      if (gap !== null) gapTotal += gap
      continue
    }

    // 余额型：按快照逐段累加。遇到余额上升（充值）就把这一天切开，
    // 充值那一段不计消耗，其余段照常累加 —— 这样充值当天也能看到真实消耗。
    const firstSnap = inDay.find(
      (s) => s.remaining !== null && s.remaining !== undefined && Number.isFinite(s.remaining)
    )
    let gap: number | null = null
    let useRefAsBase = true
    if (ref && ref.remaining !== null && firstSnap && firstSnap.ts - ref.ts > gapMs) {
      const d = ref.remaining - (firstSnap.remaining as number)
      if (d > 1e-9) gap = round4(d)
      useRefAsBase = false // 跨期段不计入当天消耗
    }
    const refVal = useRefAsBase && ref ? ref.remaining : null
    const dayList = inDay.filter((s) => s.remaining !== null && s.remaining !== undefined && Number.isFinite(s.remaining))
    let prev: number | null = null
    let consumed = 0
    let sawRecharge = false
    let hasValue = false
    /**
     * 先把「读取闪断」找出来再累加。
     *
     * 实测场景（阿里云 9/16 17:50）：读到 7.78，5 分钟后同一账号又回到 215.75 —— 这是**瞬时错误读数**，
     * 不是真的消耗。旧口径会把它累加成 207.97 的消耗（报告里那个虚高数字就是这么来的）。
     *
     * 判定：某一跳的下降幅度 ≥ 当日余额波动的一半，且几分钟内又回升到接近跳前水平 ⇒ 视为闪断，
     * 该跳不计入消耗（回升那一跳本来也不计）。真实消耗（跌了不回来）不受影响。
     */
    const dayVals = dayList.map((s) => s.remaining as number)
    const daySpan = dayVals.length > 0 ? Math.max(...dayVals) - Math.min(...dayVals) : 0
    const glitchIdx = new Set<number>()
    for (let i = 1; i < dayList.length; i++) {
      const a = dayList[i - 1].remaining as number
      const b = dayList[i].remaining as number
      const fall = a - b
      if (!(fall > 0)) continue
      if (daySpan > 0 && fall < daySpan * 0.5) continue
      // 往后 12 条内是否回升到接近跳前
      let recovered = false
      for (let k = i + 1; k < Math.min(dayList.length, i + 12); k++) {
        if ((dayList[k].remaining as number) >= a - Math.max(0.01, Math.abs(a) * 0.002)) { recovered = true; break }
      }
      if (recovered) glitchIdx.add(i)
    }

    for (let i = 0; i < dayList.length; i++) {
      const s = dayList[i]
      const cur = s.remaining as number
      if (prev === null) {
        if (refVal === null || !Number.isFinite(refVal)) {
          // 没有可用基准（或跨期已剥离）：以当天第一条为起点
          prev = cur
          hasValue = true
          continue
        }
        prev = refVal
      }
      hasValue = true
      if (cur > prev + 1e-9) {
        sawRecharge = true
      } else if (!glitchIdx.has(i)) {
        consumed += prev - cur
      }
      prev = cur
    }
    if (!hasValue) {
      values.push(null)
      rechargeFlags.push(false)
    } else {
      values.push(Math.max(0, round4(consumed)))
      rechargeFlags.push(sawRecharge)
    }
    if (glitchIdx.size > 0 && process.env.DSH_USAGE_DIAG === '1') {
      logger.info(`[usage-diag] ${list[0]?.account_id?.slice(0, 8)} 某日忽略 ${glitchIdx.size} 处读取闪断（波动 ${daySpan}）`)
    }
    gapDays.push(gap)
    if (gap !== null) gapTotal += gap
  }
  return { values, rechargeFlags, gapDays, gapTotal: round4(gapTotal) }
}

/** 近 7 天有效日均；有效日 < minCount 返回 null */
function avgRecent(days: (number | null)[], minCount: number): number | null {
  const last7 = days.slice(-7).filter((v): v is number => v !== null && Number.isFinite(v))
  if (last7.length < minCount) return null
  return last7.reduce((a, b) => a + b, 0) / last7.length
}

export async function buildDailyUsage(days: number = 30): Promise<DailyUsageReport> {
  let all: Snapshot[] = []
  try {
    all = await readSnapshots()
  } catch (e) {
    logger.error('[usage] 读取快照失败：', (e as Error).message)
    return { days: [], accounts: [], unitTotals: [], note: '读取历史数据失败：' + (e as Error).message }
  }
  const okOnly = all
    .filter((s) => s && s.ok)
    .sort((a, b) => a.ts - b.ts)
  if (okOnly.length === 0) {
    return { days: [], accounts: [], unitTotals: [], note: '还没有历史数据：请先让面板跑几轮刷新，明天再来就是完整的一天' }
  }

  const slices = daySlices(Math.min(Math.max(Math.round(days), 1), 90))
  const gapMs = gapLimitMs()

  const byAccount = new Map<string, Snapshot[]>()
  for (const s of okOnly) {
    const arr = byAccount.get(s.account_id)
    if (arr) arr.push(s)
    else byAccount.set(s.account_id, [s])
  }

  const now = Date.now()
  const accounts: DailyAccount[] = []
  for (const [accountId, list] of byAccount) {
    const latest = list[list.length - 1]
    const acc = store.getAccount(accountId)
    // 已删除（回收站）的账号不再出现在统计里
    if (acc && acc.deleted_at) continue
    const type: AccountType = acc?.type ?? 'custom'
    const name = acc?.name ?? accountId
    const unit = latest.unit || ''
    const hasUsed = isUsageBased(list)
    const detail = dailyConsumedDetailed(list, slices, hasUsed, gapMs)
    const daysVals = detail.values
    const today = daysVals.length > 0 ? daysVals[daysVals.length - 1] : null
    const avg7 = avgRecent(daysVals, 2)

    // 剩余量（用量型 = total − used；否则 latest remaining）
    let remaining: number | null = null
    if (hasUsed) {
      const lu = usedAt(list, false)
      const lt = latest.total !== null && latest.total !== undefined && Number.isFinite(latest.total) ? latest.total : null
      if (lu !== null && lt !== null) remaining = Math.max(0, lt - lu)
      else if (latest.remaining !== null && latest.remaining !== undefined && Number.isFinite(latest.remaining)) remaining = latest.remaining
    } else if (latest.remaining !== null && latest.remaining !== undefined && Number.isFinite(latest.remaining)) {
      remaining = latest.remaining
    }

    // 累计总额（进度条分母）：余额上升 = 充值，把增量累加；同时记住这一轮从哪一刻开始
    let creditTotal: number | null = null
    let cycleStartTs: number | null = null
    {
      let prevRem: number | null = null
      let sum = 0
      let started = false
      for (const s of list) {
        const rem = s.remaining
        if (rem === null || rem === undefined || !Number.isFinite(rem)) continue
        if (!started) {
          sum = rem
          started = true
          prevRem = rem
          cycleStartTs = s.ts
          continue
        }
        const prev = prevRem as number
        if (rem > prev + 1e-9) {
          sum += rem - prev
          cycleStartTs = s.ts
        }
        prevRem = rem
      }
      creditTotal = started && sum > 0 ? Math.round(sum * 10000) / 10000 : null
    }
    // 套餐型（有 API 给的总额）优先用 API 的总额
    if (hasUsed) {
      const apiTotal = latest.total
      if (apiTotal !== null && apiTotal !== undefined && Number.isFinite(apiTotal) && apiTotal > 0) {
        creditTotal = apiTotal
      }
    }

    let forecastDaysLeft: number | null = null
    let estEmptyTs: number | null = null
    if (remaining !== null && remaining > 0 && avg7 !== null && avg7 > 0) {
      forecastDaysLeft = remaining / avg7
      estEmptyTs = now + forecastDaysLeft * DAY_MS
    }

    accounts.push({
      accountId,
      name,
      type,
      unit,
      hasUsed,
      remaining,
      rechargeFlags: detail.rechargeFlags,
      gapDays: detail.gapDays,
      gapTotal: detail.gapTotal,
      totalAll: (() => {
        const vals = daysVals.filter((v): v is number => v !== null && Number.isFinite(v))
        const daily = vals.length > 0 ? round4(vals.reduce((a, b) => a + b, 0)) : null
        return daily === null && detail.gapTotal === 0 ? null : round4((daily ?? 0) + detail.gapTotal)
      })(),
      totalDaily: (() => {
        const vals = daysVals.filter((v): v is number => v !== null && Number.isFinite(v))
        return vals.length > 0 ? round4(vals.reduce((a, b) => a + b, 0)) : null
      })(),
      suggestedThreshold: avg7 !== null && avg7 > 0 ? Math.round(avg7 * 3 * 100) / 100 : null,
      creditTotal,
      cycleStartTs,
      days: daysVals,
      today,
      avg7,
      forecastDaysLeft,
      estEmptyTs
    })
  }
  accounts.sort((a, b) => (b.today ?? 0) - (a.today ?? 0) || a.name.localeCompare(b.name, 'zh'))

  // 按单位合计
  const unitMap = new Map<
    string,
    {
      days: (number | null)[]
      today: number | null
      total7: number | null
      totalAll: number | null
      totalDaily: number | null
      gapDays: (number | null)[]
      gapTotal: number
    }
  >()
  for (const a of accounts) {
    if (!a.unit) continue
    let u = unitMap.get(a.unit)
    if (!u) {
      u = {
        days: slices.map(() => null),
        today: null,
        total7: null,
        totalAll: null,
        totalDaily: null,
        gapDays: slices.map(() => null),
        gapTotal: 0
      }
      unitMap.set(a.unit, u)
    }
    u.days = u.days.map((prev, i) => (a.days[i] === null ? prev : (prev ?? 0) + (a.days[i] as number)))
    u.gapDays = u.gapDays.map((prev, i) => (a.gapDays[i] === null ? prev : (prev ?? 0) + (a.gapDays[i] as number)))
    u.today = (u.today ?? 0) + (a.today ?? 0)
    u.gapTotal += a.gapTotal
  }
  for (const u of unitMap.values()) {
    const last7 = u.days.slice(-7).filter((v): v is number => v !== null && Number.isFinite(v))
    u.total7 = last7.length >= 2 ? last7.reduce((a, b) => a + b, 0) : null
    // 合计口径：整段范围的逐日之和 + 停机期间消耗（= 这段时间总共掉了多少）
    const all = u.days.filter((v): v is number => v !== null && Number.isFinite(v))
    u.totalDaily = all.length > 0 ? round4(all.reduce((a, b) => a + b, 0)) : null
    u.totalAll = u.totalDaily === null && u.gapTotal === 0 ? null : round4((u.totalDaily ?? 0) + u.gapTotal)
  }
  const unitTotals: DailyUsageReport['unitTotals'] = Array.from(unitMap.entries()).map(([unit, v]) => ({
    unit,
    days: v.days,
    today: v.today === 0 && v.today !== null && v.days.every((x) => x === null) ? null : v.today,
    total7: v.total7,
    totalAll: v.totalAll,
    totalDaily: v.totalDaily,
    gapDays: v.gapDays,
    gapTotal: round4(v.gapTotal)
  }))
  unitTotals.sort((a, b) => (b.total7 ?? -1) - (a.total7 ?? -1) || a.unit.localeCompare(b.unit))

  const note = accounts.some((a) => a.avg7 === null && a.days.some((v) => v !== null))
    ? '部分账号历史数据不足，无法预估耗尽日期'
    : ''

  return {
    days: slices.map((s) => ({ label: s.label, ts: s.start })),
    accounts,
    unitTotals,
    note,
  }
}

export async function buildPlatformUsage(days: number = 30): Promise<PlatformUsageReport> {
  let all: Snapshot[] = []
  try {
    all = await readSnapshots()
  } catch (e) {
    logger.error('[usage] 读取快照失败：', (e as Error).message)
    return { days: [], platforms: [], unitTotals: [], note: '读取历史数据失败：' + (e as Error).message }
  }
  const okOnly = all.filter((s) => s && s.ok).sort((a, b) => a.ts - b.ts)
  if (okOnly.length === 0) {
    return { days: [], platforms: [], unitTotals: [], note: '还没有历史数据：请先让面板跑几轮刷新' }
  }

  const slices = daySlices(Math.min(Math.max(Math.round(days), 1), 90))
  const gapMs = gapLimitMs()

  // 账号级逐日消耗（口径与 buildDailyUsage 一致）
  const byAccount = new Map<string, Snapshot[]>()
  for (const s of okOnly) {
    const arr = byAccount.get(s.account_id)
    if (arr) arr.push(s)
    else byAccount.set(s.account_id, [s])
  }

  interface AccRow {
    type: AccountType
    unit: string
    hasUsed: boolean
    days: (number | null)[]
    gapDays: (number | null)[]
    gapTotal: number
  }
  const accRows: AccRow[] = []
  for (const [accountId, list] of byAccount) {
    const latest = list[list.length - 1]
    const acc = store.getAccount(accountId)
    // 已删除（回收站）的账号不再出现在统计里
    if (acc && acc.deleted_at) continue
    const type: AccountType = acc?.type ?? 'custom'
    const unit = latest.unit || ''
    const hasUsed = isUsageBased(list)
    const detail = dailyConsumedDetailed(list, slices, hasUsed, gapMs)
    accRows.push({ type, unit, hasUsed, days: detail.values, gapDays: detail.gapDays, gapTotal: detail.gapTotal })
  }

  // 按 (平台类型 × 单位) 聚合：组内账号同日值相加
  const platMap = new Map<string, PlatformUsageRow & { count: number; gapDays: (number | null)[] }>()
  for (const row of accRows) {
    const key = row.type + '\u0000' + row.unit
    let rec = platMap.get(key)
    if (!rec) {
      rec = {
        type: row.type,
        unit: row.unit,
        hasUsed: row.hasUsed,
        days: slices.map(() => null),
        today: null,
        total: null,
        avg7: null,
        gapTotal: 0,
        count: 0,
        gapDays: slices.map(() => null)
      }
      platMap.set(key, rec)
    }
    rec.count += 1
    rec.days = rec.days.map((prev, i) =>
      row.days[i] === null ? prev : (prev ?? 0) + (row.days[i] as number)
    )
    rec.gapDays = rec.gapDays.map((prev, i) =>
      row.gapDays[i] === null ? prev : (prev ?? 0) + (row.gapDays[i] as number)
    )
    rec.gapTotal += row.gapTotal
  }

  const platforms: PlatformUsageRow[] = []
  for (const rec of platMap.values()) {
    rec.today = rec.days.length > 0 ? rec.days[rec.days.length - 1] : null
    const sum = rec.days.filter((v): v is number => v !== null && Number.isFinite(v)).reduce((a, b) => a + b, 0)
    const dailySum = rec.days.some((v) => v !== null) ? round4(sum) : null
    // 合计口径：逐日之和 + 停机期间消耗（= 这段时间该平台总共掉了多少）
    const total = dailySum === null && rec.gapTotal === 0 ? null : round4((dailySum ?? 0) + rec.gapTotal)
    rec.total = total
    rec.avg7 = avgRecent(rec.days, 2)
    platforms.push({
      type: rec.type,
      unit: rec.unit,
      hasUsed: rec.hasUsed,
      days: rec.days,
      today: rec.today,
      total: rec.total,
      totalDaily: dailySum,
      avg7: rec.avg7,
      gapTotal: round4(rec.gapTotal)
    })
  }
  platforms.sort((a, b) => (b.total ?? -1) - (a.total ?? -1) || a.type.localeCompare(b.type))

  // 按单位合计
  const unitMap = new Map<
    string,
    {
      days: (number | null)[]
      today: number | null
      total7: number | null
      totalAll: number | null
      totalDaily: number | null
      gapDays: (number | null)[]
      gapTotal: number
    }
  >()
  for (const p of platforms) {
    if (!p.unit) continue
    let u = unitMap.get(p.unit)
    if (!u) {
      u = {
        days: slices.map(() => null),
        today: null,
        total7: null,
        totalAll: null,
        totalDaily: null,
        gapDays: slices.map(() => null),
        gapTotal: 0
      }
      unitMap.set(p.unit, u)
    }
    u.days = u.days.map((prev, i) => (p.days[i] === null ? prev : (prev ?? 0) + (p.days[i] as number)))
    u.today = (u.today ?? 0) + (p.today ?? 0)
    u.gapTotal += p.gapTotal
  }
  for (const u of unitMap.values()) {
    const last7 = u.days.slice(-7).filter((v): v is number => v !== null && Number.isFinite(v))
    u.total7 = last7.length >= 2 ? last7.reduce((a, b) => a + b, 0) : null
    const all = u.days.filter((v): v is number => v !== null && Number.isFinite(v))
    u.totalDaily = all.length > 0 ? round4(all.reduce((a, b) => a + b, 0)) : null
    u.totalAll = u.totalDaily === null && u.gapTotal === 0 ? null : round4((u.totalDaily ?? 0) + u.gapTotal)
  }
  const unitTotals: PlatformUsageReport['unitTotals'] = Array.from(unitMap.entries()).map(([unit, v]) => ({
    unit,
    days: v.days,
    today: v.today === 0 && v.days.every((x) => x === null) ? null : v.today,
    total7: v.total7,
    totalAll: v.totalAll,
    totalDaily: v.totalDaily,
    gapDays: v.gapDays,
    gapTotal: round4(v.gapTotal)
  }))
  unitTotals.sort((a, b) => (b.total7 ?? -1) - (a.total7 ?? -1) || a.unit.localeCompare(b.unit))

  const note = platforms.some((p) => p.avg7 === null && p.days.some((v) => v !== null))
    ? '部分平台历史数据不足，7 日均值为空（至少需要 2 天有效记录）'
    : ''

  return {
    days: slices.map((s) => ({ label: s.label, ts: s.start })),
    platforms,
    unitTotals,
    note,
  }
}

// ---------- AI 使用报告（只基于金额消耗） ----------

/** 报告周期窗口（自然日 / 本周一至今 / 本月 1 日至今） */
function periodWindow(period: ReportPeriod, now: number): { from: number; to: number; title: string } {
  const d = new Date(now)
  if (period === 'day') {
    return {
      from: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(),
      to: now,
      title: '今日使用报告'
    }
  }
  if (period === 'week') {
    const wd = d.getDay() === 0 ? 6 : d.getDay() - 1
    return {
      from: new Date(d.getFullYear(), d.getMonth(), d.getDate() - wd).getTime(),
      to: now,
      title: '本周使用报告'
    }
  }
  return {
    from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(),
    to: now,
    title: '本月使用报告'
  }
}

/** 窗口内的消耗流水（按相邻快照差分累加） */
interface Flows {
  byUnit: Map<string, number>
  byPlatform: Map<string, number>
  byAccount: Map<string, { name: string; unit: string; value: number }>
  byDay: Map<string, number>
  hours: Map<string, number[]>
  recharges: { ts: number; name: string; amount: number; unit: string }[]
  daysWithUse: Set<string>
}

function emptyFlows(): Flows {
  return {
    byUnit: new Map(),
    byPlatform: new Map(),
    byAccount: new Map(),
    byDay: new Map(),
    hours: new Map(),
    recharges: [],
    daysWithUse: new Set()
  }
}

function dayLabel(ts: number): string {
  const d = new Date(ts)
  return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

/**
 * 把任意时间范围切成逐日「切片」（不含跨期剥离，剥离在账目函数里做）。
 * 与 daySlices 的区别：这里按**给定范围**切，用于报告窗口（含上一个等长周期）。
 */
function slicesBetween(fromTs: number, toTs: number): DaySlice[] {
  const out: DaySlice[] = []
  const first = new Date(fromTs)
  first.setHours(0, 0, 0, 0)
  for (let t = first.getTime(); t < toTs; t += DAY_MS) {
    const dd = new Date(t)
    const mm = String(dd.getMonth() + 1).padStart(2, '0')
    const day = String(dd.getDate()).padStart(2, '0')
    out.push({ start: t, end: t + DAY_MS, label: mm + '-' + day })
  }
  return out
}

/**
 * 某账号在一段时间内的「逐日余额账目」——所有统计（每日使用状况 / 平台用量 / 使用报告）**共用这一份**。
 *
 * 为什么必须共用：以前使用报告用的是另一套「相邻快照差分」口径，两者结果不一致
 * （实测：同一个月，报告算 303.22 CNY，日报只有 64.50 CNY，差 238）。
 * 现在统一：跨期（>gapLimitMs）的下降归到「停机期间」，不堆到某一天；充值（余额上升）不计消耗。
 */
interface BalanceLedger {
  /** 与 slices 对齐：当日消耗（跨期部分已剥离） */
  values: (number | null)[]
  /** 与 slices 对齐：当日停机期间消耗 */
  gapDays: (number | null)[]
  /** 与 slices 对齐：当日疑似充值 */
  rechargeFlags: boolean[]
  /** 与 slices 对齐：当日最后一次有效余额（用于图表基线） */
  lastValues: (number | null)[]
  gapTotal: number
}

/** 为某账号生成逐日账目（slices 需按时间升序，且同一天只有一条切片） */
function balanceLedger(list: Snapshot[], slices: DaySlice[], hasUsed: boolean, gapMs: number): BalanceLedger {
  const detail = dailyConsumedDetailed(list, slices, hasUsed, gapMs)
  const lastValues: (number | null)[] = []
  for (const sl of slices) {
    const inDay = list.filter((s) => s.ts >= sl.start && s.ts < sl.end && s.remaining !== null && Number.isFinite(s.remaining))
    lastValues.push(inDay.length > 0 ? (inDay[inDay.length - 1].remaining as number) : null)
  }
  return {
    values: detail.values,
    gapDays: detail.gapDays,
    rechargeFlags: detail.rechargeFlags,
    lastValues,
    gapTotal: detail.gapTotal
  }
}

/** 窗口内的消耗流水（统一来自逐日账目） */
interface Flows {
  byUnit: Map<string, number>
  byPlatform: Map<string, number>
  byAccount: Map<string, { name: string; unit: string; value: number }>
  byDay: Map<string, number>
  hours: Map<string, number[]>
  recharges: { ts: number; name: string; amount: number; unit: string }[]
  daysWithUse: Set<string>
}


/**
 * 把「逐日账目」归集到各维度（单位 / 平台 / 账号 / 日期 / 时段 / 充值）。
 *
 * 与旧实现的区别（重要）：不再自己按"相邻快照差分"累加，而是直接用账目函数算好的逐日值，
 * 因此与「每日使用状况」页数字**完全一致**；跨期下降不会被打到某一天，充值也不计入消耗。
 *
 * @param slices 窗口切片（须与 label 对齐的日期标签）
 * @param withDetail 是否累计明细维度（false 时只算总量，用于"上一个周期"做环比）
 */
function collectFlowsFromLedger(
  okOnly: Snapshot[],
  slices: DaySlice[],
  gapMs: number,
  flows: Flows,
  withDetail: boolean
): void {
  const byAccount = new Map<string, Snapshot[]>()
  for (const s of okOnly) {
    const arr = byAccount.get(s.account_id)
    if (arr) arr.push(s)
    else byAccount.set(s.account_id, [s])
  }
  for (const [accountId, list] of byAccount) {
    const acc = store.getAccount(accountId)
    // 已删除（回收站）的账号不再出现在统计里
    if (acc && acc.deleted_at) continue
    const type: AccountType = acc?.type ?? 'custom'
    const name = acc?.name ?? accountId
    const unit = list[list.length - 1]?.unit || list[0]?.unit || ''
    if (!unit) continue
    const hasUsed = isUsageBased(list)
    const ledger = balanceLedger(list, slices, hasUsed, gapMs)

    for (let i = 0; i < slices.length; i++) {
      const day = slices[i].label
      const v = ledger.values[i]
      // 当天消耗 = 当日值 + 当日停机期间（合计口径包含停机区间）
      const total = (v ?? 0) + (ledger.gapDays[i] ?? 0)
      if (total <= 0) continue
      flows.byUnit.set(unit, (flows.byUnit.get(unit) ?? 0) + total)
      flows.byDay.set(day, (flows.byDay.get(day) ?? 0) + total)
      flows.daysWithUse.add(day)
      if (withDetail) {
        const pk = type + '\u0000' + unit
        flows.byPlatform.set(pk, (flows.byPlatform.get(pk) ?? 0) + total)
        const prevAcc = flows.byAccount.get(accountId)
        flows.byAccount.set(accountId, { name, unit, value: (prevAcc?.value ?? 0) + total })
        // 时段分布：把当天消耗按"当天最后一条快照所在小时"归属（与旧口径一致，仅小时级近似）
        const lastV = ledger.lastValues[i]
        if (lastV !== null) {
          const hourIdx = new Date(slices[i].end - 1).getHours()
          const arr = flows.hours.get(unit) ?? new Array(24).fill(0)
          // 摊到当天：用当天消耗累加到"当天最后采样点所在小时"，保持不变的口径
          arr[hourIdx] += total
          flows.hours.set(unit, arr)
        }
      }
    }

    // 疑似充值：账目里标记了充值的日子（余额上升）
    if (withDetail) {
      for (let i = 0; i < slices.length; i++) {
        if (!ledger.rechargeFlags[i]) continue
        const prev = i > 0 ? ledger.lastValues[i - 1] : null
        const cur = ledger.lastValues[i]
        const amount = prev !== null && cur !== null ? Math.max(0, cur - prev) : 0
        if (amount > 0 && flows.recharges.length < 20) {
          flows.recharges.push({ ts: slices[i].start, name, amount: Math.round(amount * 10000) / 10000, unit })
        }
      }
    }
  }
}


/** 趣味换算文案（只基于金额） */
function buildMilestones(args: {
  unit: string
  total: number
  platformCount: number
  topPlatform: string
  activeDays: number
  totalDays: number
  peakHour: number | null
  rechargeCount: number
  rechargeSum: number
  avgDaily: number | null
}): string[] {
  const out: string[] = []
  if (args.platformCount > 0) {
    out.push(
      '有 ' + args.platformCount + ' 个平台产生消耗' + (args.topPlatform ? '，主力是 ' + args.topPlatform : '')
    )
  }
  out.push(
    '统计周期内活跃 ' + args.activeDays + ' / ' + args.totalDays + ' 天' + (args.avgDaily !== null ? '，日均 ' + fmtNumber(args.avgDaily) + ' ' + args.unit : '')
  )
  if (args.peakHour !== null) {
    const end = (args.peakHour + 1) % 24
    out.push('使用最集中的时段是 ' + String(args.peakHour).padStart(2, '0') + ':00 - ' + String(end).padStart(2, '0') + ':00')
  }
  if (args.unit === 'CNY' && args.total > 0) {
    const coffee = args.total / 25
    const meals = args.total / 30
    const books = args.total / 89
    const parts: string[] = []
    if (coffee >= 0.5) parts.push('约 ' + coffee.toFixed(1) + ' 杯咖啡（¥25/杯）')
    if (meals >= 0.5) parts.push('约 ' + meals.toFixed(1) + ' 顿外卖（¥30/顿）')
    if (books >= 0.5) parts.push('约 ' + books.toFixed(1) + ' 本技术书（¥89/本）')
    if (parts.length > 0) out.push('这些消耗相当于 ' + parts.join('、'))
  }
  if (args.rechargeCount > 0) {
    out.push('期间有 ' + args.rechargeCount + ' 次疑似充值（合计 ' + fmtNumber(args.rechargeSum) + ' ' + args.unit + '）')
  }
  return out
}

/** AI 使用报告：只基于金额消耗（平台接口不提供按模型/Token 的明细） */
export async function buildUsageReport(period: ReportPeriod = 'day'): Promise<UsageReport> {
  const settings = store.getSettings()
  const sampleMinutes = Math.max(1, Math.round((settings.refresh_seconds || 300) / 60))
  const now = Date.now()
  const win = periodWindow(period, now)
  const span = Math.max(1, win.to - win.from)
  const empty: UsageReport = {
    period,
    title: win.title,
    fromTs: win.from,
    toTs: win.to,
    unit: '',
    total: 0,
    totalByUnit: [],
    unitDetails: [],
    platformShare: [],
    topAccount: null,
    topDay: null,
    prevTotal: null,
    deltaPct: null,
    activeHours: [],
    activeDays: 0,
    totalDays: Math.max(1, Math.ceil(span / DAY_MS)),
    avgDaily: null,
    recharges: [],
    milestones: [],
    sampleMinutes
  }
  let all: Snapshot[] = []
  try {
    all = await readSnapshots()
  } catch (e) {
    return { ...empty, milestones: ['读取历史数据失败：' + (e as Error).message] }
  }
  const okOnly = all.filter((s) => s && s.ok).sort((a, b) => a.ts - b.ts)
  if (okOnly.length === 0) {
    return { ...empty, milestones: ['还没有历史数据：面板每次刷新都会记录快照，跑几轮后再来看报告'] }
  }

  // 统一口径：与「每日使用状况」共用逐日账目（跨期下降归停机期间、充值不计消耗）
  const gapMs = gapLimitMs()
  const curSlices = slicesBetween(win.from, win.to)
  const prevSlices = slicesBetween(win.from - span, win.from)
  const flows = emptyFlows()
  collectFlowsFromLedger(okOnly, curSlices, gapMs, flows, true)
  const prevFlows = emptyFlows()
  collectFlowsFromLedger(okOnly, prevSlices, gapMs, prevFlows, false)

  const round4v = (v: number): number => Math.round(v * 10000) / 10000
  const totalByUnit = Array.from(flows.byUnit.entries())
    .map(([unit, value]) => ({ unit, value: round4v(value) }))
    .sort((a, b) => b.value - a.value)
  const unit = totalByUnit.length > 0 ? totalByUnit[0].unit : ''
  const total = totalByUnit.length > 0 ? totalByUnit[0].value : 0
  const prevSame = unit ? prevFlows.byUnit.get(unit) ?? null : null
  const deltaPct = prevSame !== null && prevSame > 0 ? ((total - prevSame) / prevSame) * 100 : null

  const totalDays = Math.max(1, Math.ceil(span / DAY_MS))

  /**
   * 每个单位各算一套完整明细（关键修复）：不同单位不能相加，
   * 以前只显示"数值最大的那个单位"，导致 CNY 余额账号在报告里完全看不到。
   */
  const unitDetails: UsageReportUnit[] = totalByUnit.map((u) => {
    const uTotal = u.value
    const share: { type: string; value: number; pct: number }[] = []
    for (const [pk, value] of flows.byPlatform) {
      const [type, uu] = pk.split('\u0000')
      if (uu !== u.unit) continue
      share.push({ type, value: round4v(value), pct: uTotal > 0 ? (value / uTotal) * 100 : 0 })
    }
    share.sort((a, b) => b.value - a.value)
    let topAcc: UsageReportUnit['topAccount'] = null
    for (const [, v] of flows.byAccount) {
      if (v.unit !== u.unit) continue
      if (!topAcc || v.value > topAcc.value) topAcc = { name: v.name, value: round4v(v.value), unit: v.unit }
    }
    let topD: UsageReportUnit['topDay'] = null
    for (const [label, value] of flows.byDay) {
      if (value <= 0) continue
      if (!topD || value > topD.value) topD = { label, value: round4v(value), unit: u.unit }
    }
    const hours = flows.hours.get(u.unit) ?? new Array(24).fill(0)
    const activeDays = (() => {
      // 该单位有消耗的天数（各账号当天值相加）
      const perDay = new Map<string, number>()
      for (const [pk, value] of flows.byPlatform) {
        const [, uu] = pk.split('\u0000')
        if (uu !== u.unit) continue
        perDay.set(u.unit, (perDay.get(u.unit) ?? 0) + value)
      }
      let n = 0
      for (const [, v] of flows.byDay) if (v > 0) n++
      return n
    })()
    const unitRecharges = flows.recharges.filter((r) => r.unit === u.unit)
    const prevU = prevFlows.byUnit.get(u.unit) ?? null
    return {
      unit: u.unit,
      total: uTotal,
      prevTotal: prevU,
      deltaPct: prevU !== null && prevU > 0 ? ((uTotal - prevU) / prevU) * 100 : null,
      platformShare: share,
      topAccount: topAcc,
      topDay: topD,
      activeHours: hours.map((value, hour) => ({ hour, value: round4v(value) })),
      recharges: unitRecharges,
      activeDays,
      totalDays,
      avgDaily: uTotal > 0 ? round4v(uTotal / totalDays) : null
    }
  })

  const main = unitDetails[0] ?? null
  const platformShare = (main?.platformShare ?? []).map((s) => ({ ...s, unit }))
  const topAccount = main?.topAccount ?? null
  const topDay = main?.topDay ?? null
  const activeHours = main?.activeHours ?? []
  let peakHour: number | null = null
  let peakVal = 0
  for (const h of activeHours) {
    if (h.value > peakVal) { peakVal = h.value; peakHour = h.hour }
  }
  if (peakVal <= 0) peakHour = null

  const activeDays = main?.activeDays ?? 0
  const avgDaily = main?.avgDaily ?? null
  let rechargeSum = 0
  for (const r of main?.recharges ?? []) rechargeSum += r.amount
  const topPlatformType = platformShare.length > 0 ? platformShare[0].type : ''
  const topPlatformLabel = topPlatformType
    ? (PROVIDER_META as Record<string, { label?: string }>)[topPlatformType]?.label ?? topPlatformType
    : ''

  return {
    period,
    title: win.title,
    fromTs: win.from,
    toTs: win.to,
    unit,
    total,
    totalByUnit,
    unitDetails,
    platformShare,
    topAccount,
    topDay,
    prevTotal: prevSame,
    deltaPct,
    activeHours,
    activeDays,
    totalDays,
    avgDaily,
    recharges: main?.recharges ?? [],
    milestones: buildMilestones({
      unit: unit || '—',
      total,
      platformCount: platformShare.length,
      topPlatform: topPlatformLabel,
      activeDays,
      totalDays,
      peakHour,
      rechargeCount: main?.recharges.length ?? 0,
      rechargeSum,
      avgDaily
    }),
    sampleMinutes
  }
}