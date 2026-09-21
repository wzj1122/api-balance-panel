import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Correction, CorrectionInput, Snapshot } from '../shared/types'
import { logger } from './logger'
import { DATA_DIR, ensureDirs } from './paths'

/**
 * 数据校正账本（corrections.json）。
 *
 * 为什么用「账本 + 读出口套用」而不是直接改 snapshots.json：
 * 1. **可撤销**：原始快照一行不动，撤销 = 删掉账本里的那一条，历史立刻还原；
 * 2. **一处生效到处生效**：每日使用、平台用量、使用报告、日历、趋势图、耗尽预估
 *    全都读 `readSnapshots()`，在那一层套用即可，不用改七处；
 * 3. **不会被打回原形**：平台下一轮刷新又写进一条错快照也没关系，读出时照样套用校正。
 *
 * 语义（两种校正）：
 * - offset：从 fromTs 起，把该账号快照的 remaining/used 整体 +value（"某一刻起余额差了多少"）
 * - set   ：从 fromTs 起，把该账号快照的剩余**设为** value（用于"我知道某天真实余额是多少"）
 *
 * ⚠️ 一致性要求：offset 必须是**同一账号全量快照的平移量**（不要只改某一小段），
 * 否则相邻快照的"差值"会突变，消耗就会算错。界面上只提供两种安全操作：
 * ①改某天用量（= 该日期起平移 delta）②回退到某次快照（= 该时刻起平移）。
 */

const CORRECTION_FILE = path.join(DATA_DIR, 'corrections.json')

interface CorrectionFile {
  version: number
  items: Correction[]
}

let cache: Correction[] | null = null

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** 归一化一条校正（非法项丢弃） */
function normalize(raw: unknown): Correction | null {
  if (!isPlainObject(raw)) return null
  const accountId = typeof raw.accountId === 'string' ? raw.accountId : ''
  const fromTs = numOrNull(raw.fromTs)
  const kind = raw.kind === 'set' ? 'set' : raw.kind === 'ignore' ? 'ignore' : 'offset'
  // ignore 不需要数值（统一记 0）
  const value = kind === 'ignore' ? 0 : numOrNull(raw.value)
  if (!accountId || fromTs === null || value === null) return null
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : randomUUID(),
    accountId,
    fromTs,
    toTs: numOrNull(raw.toTs),
    kind,
    value,
    unit: typeof raw.unit === 'string' ? raw.unit : '',
    note: typeof raw.note === 'string' ? raw.note : '',
    createdAt: numOrNull(raw.createdAt) ?? Date.now()
  }
}

/** 读账本（懒加载 + 内存缓存） */
export function loadCorrections(): Correction[] {
  if (cache) return cache
  try {
    const text = fs.readFileSync(CORRECTION_FILE, 'utf8')
    const data = JSON.parse(text) as CorrectionFile
    const items = Array.isArray(data?.items) ? data.items.map(normalize).filter((x): x is Correction => !!x) : []
    cache = items
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(`[correction] corrections.json 不可用，已按空账本处理：${(e as Error).message}`)
    }
    cache = []
  }
  return cache
}

/** 落盘（原子写） */
function save(): void {
  if (!cache) return
  ensureDirs()
  try {
    const text = JSON.stringify({ version: 1, items: cache } satisfies CorrectionFile, null, 2)
    const tmp = CORRECTION_FILE + '.tmp'
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, CORRECTION_FILE)
  } catch (e) {
    logger.error('[correction] 保存校正账本失败：' + (e as Error).message)
    throw e
  }
}

/**
 * 某账号在某时刻的「净平移量」（offset 累加；set 不参与平移）。
 * 只看在这个时刻**仍然生效**的校正：fromTs <= ts，且（无 toTs 或 ts < toTs）。
 * @param list 可选：指定账本（默认读全局账本；测试用）
 */
export function offsetFor(accountId: string, ts: number, list?: Correction[]): number {
  let sum = 0
  for (const c of list ?? loadCorrections()) {
    if (c.accountId !== accountId) continue
    if (c.fromTs > ts) continue
    if (typeof c.toTs === 'number' && ts >= c.toTs) continue
    if (c.kind === 'offset') sum += c.value
  }
  return Math.round(sum * 1e6) / 1e6
}

/** 该账号当前（最新时刻）的净平移量，用于卡片实时数字 */
export function totalOffset(accountId: string, list?: Correction[]): number {
  return offsetFor(accountId, Date.now(), list)
}

/** 某账号是否被校正过 */
export function hasCorrection(accountId: string): boolean {
  return loadCorrections().some((c) => c.accountId === accountId)
}

/**
 * 把校正套用到一批快照上（返回新数组，不修改入参）。
 * - remaining：从 fromTs 起把余额整体 +offset（offset 为账本里该时刻之后的累计平移量）
 * - used：用量型账号，按相反的差值平移（保持 consumed 增量不变）
 * - total：同步平移，避免进度条分母突变
 * @param injected 可选：指定账本（默认读全局账本；测试用）
 */
export function applyCorrections(snapshots: Snapshot[], accountId?: string, injected?: Correction[]): Snapshot[] {
  const list = injected ?? loadCorrections()
  if (list.length === 0) return snapshots
  const relevant = accountId ? list.filter((c) => c.accountId === accountId) : list
  if (relevant.length === 0) return snapshots

  const byAccount = new Map<string, Correction[]>()
  for (const c of relevant) {
    const arr = byAccount.get(c.accountId)
    if (arr) arr.push(c)
    else byAccount.set(c.accountId, [c])
  }
  for (const arr of byAccount.values()) arr.sort((a, b) => a.fromTs - b.fromTs)

  return snapshots.map((s) => {
    const arr = byAccount.get(s.account_id)
    if (!arr) return s
    let offset = 0
    let setVal: number | null = null
    let ignored = false
    for (const c of arr) {
      if (c.fromTs > s.ts) continue
      // 有结束时间且已超出 → 这条校正对当前快照不生效（"只改某一天"就靠它）
      if (typeof c.toTs === 'number' && s.ts >= c.toTs) continue
      if (c.kind === 'offset') offset += c.value
      else if (c.kind === 'set') setVal = c.value
      else ignored = true
    }
    // 被「忽略」的时间段：直接当作没有这条数据（统计时既不消耗也不参与差值）
    if (ignored) {
      return { ...s, remaining: null, used: null, total: null, items: [], adjusted: true }
    }
    if (offset === 0 && setVal === null) return s
    const shift = (v: number | null | undefined): number | null => {
      if (v === null || v === undefined || !Number.isFinite(v)) return v ?? null
      return Math.round((v + offset) * 1e6) / 1e6
    }
    const remaining = setVal !== null ? setVal : shift(s.remaining)
    // used 与 remaining 反向：remaining 增加 offset，等价于 used 减少 offset
    const used = s.used === null || s.used === undefined ? s.used : Math.round((s.used - offset) * 1e6) / 1e6
    const total = s.total === null || s.total === undefined ? s.total : shift(s.total)
    const items = (s.items ?? []).map((it) => ({
      ...it,
      remaining: setVal !== null && it === s.items[0] ? setVal : shift(it.remaining),
      total: shift(it.total),
      used: it.used === null || it.used === undefined ? it.used : Math.round((it.used - offset) * 1e6) / 1e6
    }))
    return { ...s, remaining, used, total, items, adjusted: true }
  })
}

/** 列出校正（可按账号过滤），按生效时间倒序 */
export function listCorrections(accountId?: string): Correction[] {
  const all = loadCorrections().slice()
  const list = accountId ? all.filter((c) => c.accountId === accountId) : all
  return list.sort((a, b) => b.fromTs - a.fromTs || b.createdAt - a.createdAt)
}

/** 新增一条校正 */
export function addCorrection(input: CorrectionInput): Correction {
  loadCorrections()
  const item: Correction = {
    id: randomUUID(),
    accountId: input.accountId,
    fromTs: input.fromTs,
    toTs: typeof input.toTs === 'number' ? input.toTs : null,
    kind: input.kind,
    value: input.value,
    unit: input.unit ?? '',
    note: input.note ?? '',
    createdAt: Date.now()
  }
  cache?.push(item)
  save()
  logger.info(
    `[correction] 新增校正：账号 ${item.accountId}，从 ${new Date(item.fromTs).toLocaleString('zh-CN')} 起` +
      (item.toTs ? ` 至 ${new Date(item.toTs).toLocaleString('zh-CN')}` : '（长期）') +
      (item.kind === 'offset' ? ` 平移 ${item.value}` : ` 剩余设为 ${item.value}`) +
      (item.note ? `（${item.note}）` : '')
  )
  return item
}

/** 删除（撤销）一条校正 */
export function removeCorrection(id: string): boolean {
  const list = loadCorrections()
  const idx = list.findIndex((c) => c.id === id)
  if (idx < 0) return false
  const [removed] = list.splice(idx, 1)
  save()
  logger.info(`[correction] 已撤销校正 ${removed.id}（账号 ${removed.accountId}）`)
  return true
}

/** 清空某账号的全部校正（一键还原） */
export function clearCorrections(accountId: string): number {
  const list = loadCorrections()
  const keep = list.filter((c) => c.accountId !== accountId)
  const n = list.length - keep.length
  if (n > 0) {
    cache = keep
    save()
    logger.info(`[correction] 已清空账号 ${accountId} 的 ${n} 条校正`)
  }
  return n
}

/** 演示模式 / 测试用：丢弃内存缓存，强制重新读盘 */
export function resetCorrectionCache(): void {
  cache = null
}
