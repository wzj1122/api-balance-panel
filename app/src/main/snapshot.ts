import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { DEFAULT_SETTINGS } from '../shared/constants'
import type { BalanceRow, Snapshot, SnapshotItem } from '../shared/types'
import { applyCorrections } from './corrections'
import { demoSnapshots, isDemo } from './demo'
import { logger } from './logger'
import { SNAPSHOT_FILE, ensureDirs } from './paths'

/**
 * 余额快照：每次查询（成功与失败都记）追加一条，供二期画趋势图。
 * 一期只写不画；靠「保留天数 + 单账号条数上限」防止文件无限变大。
 */

/** 单个账号最多保留的快照条数 */
const MAX_PER_ACCOUNT = 2000
/** 异步写盘节流间隔（毫秒） */
const FLUSH_DELAY = 1000

let cache: Snapshot[] | null = null
let flushTimer: NodeJS.Timeout | null = null
let writing = false

/** 快照文件结构（损坏时整体丢弃重建，快照不是关键数据） */
interface SnapshotFile {
  version: number
  items: Snapshot[]
}

/** 懒加载快照（只在第一次 append 时读盘） */
async function loadAll(): Promise<Snapshot[]> {  if (cache) return cache
  try {
    const text = await fsp.readFile(SNAPSHOT_FILE, 'utf8')
    const data = JSON.parse(text) as SnapshotFile
    cache = Array.isArray(data?.items) ? data.items.filter((s) => s && typeof s.account_id === 'string') : []
  } catch (e) {
    // 读不到 / 坏了就算了，重建一份
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(`[snapshot] snapshots.json 不可用，已重建：${(e as Error).message}`)
    }
    cache = []
  }
  return cache
}

/** 一行结果 → 一条快照 */
function toSnapshot(row: BalanceRow): Snapshot {
  const items: SnapshotItem[] = (row.items ?? []).map((it) => ({
    planName: it.planName,
    remaining: it.remaining ?? null,
    total: it.total ?? null,
    used: it.used ?? null,
    unit: it.unit ?? ''
  }))
  return {
    id: randomUUID(),
    account_id: row.accountId,
    ts: row.ts,
    ok: row.ok,
    remaining: row.remaining ?? null,
    total: row.total ?? null,
    used: row.used ?? null,
    unit: row.unit ?? '',
    note: row.note ?? '',
    items,
    latency_ms: row.latencyMs ?? 0,
    source: row.cached ? 'cache' : 'live'
  }
}

/**
 * 读**原始**快照（不套用校正）。
 * 只有「数据校正」功能需要它：界面要展示"校正前 vs 校正后"，以及按日期换算平移量。
 * 其它业务一律用 readSnapshots()（已套用校正）。
 */
export async function readSnapshotsRaw(): Promise<Snapshot[]> {
  if (isDemo()) return demoSnapshots()
  return loadAll()
}

/**
 * 读取全部快照（内存缓存优先；失败返回空数组，由调用方处理）。
 *
 * 这里是**所有历史统计的唯一出口**（每日使用、平台用量、使用报告、日历、趋势图、耗尽预估），
 * 因此「手动校正」统一在这一层套用：校正账本一改，上面全部自动跟着对。
 * 原始 snapshots.json 一行不动，撤销校正 = 删账本条目，随时可还原。
 */
export async function readSnapshots(): Promise<Snapshot[]> {
  if (isDemo()) return demoSnapshots()

  const all = await loadAll()
  if (all.length === 0) return all
  return applyCorrections(all)
}

/** 追加一批结果（同步改内存，异步落盘，不阻塞查询返回） */
export function append(rows: BalanceRow[]): void {
  // 演示模式不落盘
  if (isDemo()) return

  if (!rows || rows.length === 0) return
  void (async (): Promise<void> => {
    try {
      const all = await loadAll()
      for (const row of rows) all.push(toSnapshot(row))
      prune(DEFAULT_SETTINGS.snapshot_retention_days)
      scheduleFlush()
    } catch (e) {
      logger.error('[snapshot] 追加快照失败：', (e as Error).message)
    }
  })()
}

/**
 * 裁剪：超过保留天数的删掉；每个账号只留最新 MAX_PER_ACCOUNT 条。
 * 调用方需要先 loadAll()。
 */
export function prune(days: number = DEFAULT_SETTINGS.snapshot_retention_days): void {
  if (!cache) return
  const keepDays = days > 0 ? days : DEFAULT_SETTINGS.snapshot_retention_days
  const deadline = Date.now() - keepDays * 24 * 60 * 60 * 1000

  let list = cache.filter((s) => (s.ts ?? 0) >= deadline)

  const byAccount = new Map<string, Snapshot[]>()
  for (const s of list) {
    const arr = byAccount.get(s.account_id)
    if (arr) arr.push(s)
    else byAccount.set(s.account_id, [s])
  }

  const kept: Snapshot[] = []
  for (const arr of byAccount.values()) {
    arr.sort((a, b) => a.ts - b.ts)
    if (arr.length > MAX_PER_ACCOUNT) kept.push(...arr.slice(arr.length - MAX_PER_ACCOUNT))
    else kept.push(...arr)
  }
  kept.sort((a, b) => a.ts - b.ts)
  cache = kept
}

/** 节流落盘：1 秒内的多次追加只写一次 */
function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flush()
  }, FLUSH_DELAY)
}

/** 立即把内存里的快照写到磁盘（原子写：tmp + rename） */
export async function flush(): Promise<void> {
  if (!cache || writing) return
  writing = true
  try {
    ensureDirs()
    const tmp = `${SNAPSHOT_FILE}.tmp`
    const payload: SnapshotFile = { version: 1, items: cache }
    await fsp.writeFile(tmp, JSON.stringify(payload), 'utf8')
    await fsp.rename(tmp, SNAPSHOT_FILE)
  } catch (e) {
    logger.error('[snapshot] 写盘失败：', (e as Error).message)
  } finally {
    writing = false
  }
}

/** 读某个账号的快照（二期画趋势图用；一期保留接口） */
export async function listByAccount(accountId: string): Promise<Snapshot[]> {
  const all = await loadAll()
  return all.filter((s) => s.account_id === accountId)
}

/** 当前快照总条数（自检 / 设置页展示用） */

/** 删除某账号的全部快照（账号被删除时可调用；当前不在 UI 暴露） */
export async function removeByAccount(accountId: string): Promise<void> {
  const all = await loadAll()
  cache = all.filter((s) => s.account_id !== accountId)
  await flush()
}

/** 判断快照文件是否存在（避免无谓的读盘） */
