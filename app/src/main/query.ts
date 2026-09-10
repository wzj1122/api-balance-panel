import { IPC } from '../shared/ipc'
import type { RefreshPayload } from '../shared/ipc'
import type { Account, BalanceResult, BalanceRow, PanelPayload } from '../shared/types'
import { getAdapter } from './adapters'
import { AdapterError, failResult, mapFetchError } from './errors'
import { logger } from './logger'
import { maybeNotify } from './notify'
import { isDemo, demoRows } from './demo'
import { updateTray } from './tray'
import { runPool } from './runPool'
import * as snapshot from './snapshot'
import { store } from './store'
import { getMainWindow } from './window'

/**
 * 余额查询核心：缓存 + 并发池 + 适配器分发 + 逐条推送。
 *
 * 铁律：
 * 1. 明文密钥只在主进程内存里存在（store.getSecret），绝不跨 IPC；
 * 2. 单个账号失败不影响其它（每账号独立 try/catch 兜底为 failResult）；
 * 3. 每完成一条立刻推 balance:row，全量完成后推 balance:updated + 写快照 + 判断提醒。
 */

interface CacheEntry {
  row: BalanceRow
  at: number
}

/** 结果缓存：key=accountId，命中时长由设置 cache_seconds 决定 */
const cache = new Map<string, CacheEntry>()

function push(channel: string, payload: unknown): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

/** 单账号查询；force 为 true 时跳过缓存 */
async function queryAccount(account: Account, force: boolean): Promise<BalanceRow> {
  const settings = store.getSettings()

  if (!force) {
    const hit = cache.get(account.id)
    if (hit && Date.now() - hit.at < settings.cache_seconds * 1000) {
      return { ...hit.row, cached: true }
    }
  }

  const started = Date.now()
  let result: BalanceResult
  try {
    const adapter = getAdapter(account.type)
    result = await adapter(account, { getSecret: (a) => store.getSecret(a) })
  } catch (e) {
    const code = e instanceof AdapterError ? e.code : mapFetchError(e)
    const detail = e instanceof AdapterError ? e.detail : String((e as Error)?.message ?? e)
    logger.warn(`[query] ${account.name} 查询失败：${code}${detail ? ` ${detail}` : ''}`)
    result = failResult(code, detail)
  }
  result.latencyMs = Date.now() - started

  const threshold =
    account.threshold ??
    (account.type === 'newapi' ? settings.default_threshold_relay : settings.default_threshold)

  const row: BalanceRow = {
    ...result,
    accountId: account.id,
    name: account.name,
    type: account.type,
    enabled: account.enabled,
    threshold: threshold ?? null,
    lowBalance:
      result.ok && result.remaining !== null && threshold !== null && result.remaining < threshold
  }

  cache.set(account.id, { row, at: Date.now() })
  store.updateLastResult(account.id, result.ok, result.ok ? '' : result.note, result.ts)

  // 每完成一条立刻推给界面，用户不用等全部刷完
  push(IPC.BALANCE_ROW, row)
  return row
}

/** 简易并发池：最多 limit 个任务同时在跑，任何一个失败不影响其它 */
// runPool 抽到了 ./runPool.ts（纯函数，便于独立验证），这里直接复用

/** 刷新余额：ids 为空 = 全部启用账号；force=true 跳过缓存 */
export async function refresh(payload?: RefreshPayload): Promise<PanelPayload> {
  const { ids, force } = payload ?? {}
  // 演示模式：返回内置示例数据，不查询、不写快照、不发通知
  if (isDemo()) {
    const rows = demoRows()
    const panel: PanelPayload = {
      rows,
      ts: Date.now(),
      refreshSeconds: store.getSettings().refresh_seconds
    }
    push(IPC.BALANCE_UPDATED, panel)
    updateTray(rows)
    return panel
  }
  const settings = store.getSettings()

  let targets = store.listAccounts().filter((a) => a.enabled)
  if (ids && ids.length > 0) {
    const idSet = new Set(ids)
    targets = targets.filter((a) => idSet.has(a.id))
  }

  const started = Date.now()
  const rows = await runPool(
    targets.map((a) => () => queryAccount(a, Boolean(force))),
    settings.concurrency
  )

  // 关键：推给渲染界的 rows 必须是"全量"，否则单账号刷新会把其它账号的卡片冲掉
  //（渲染端收到 balance:updated 会整体替换列表）。未在本批刷新内的启用账号，
  // 从结果缓存里补齐；缓存冷（刚启动就点单刷）才补一次查询。
  if (ids && ids.length > 0) {
    const hitSet = new Set(rows.map((r) => r.accountId))
    for (const a of store.listAccounts().filter((acc) => acc.enabled && !hitSet.has(acc.id))) {
      const cached = cache.get(a.id)
      if (cached) rows.push({ ...cached.row, cached: true })
      else rows.push(await queryAccount(a, false))
    }
  }
  logger.info(`[query] 刷新完成：${rows.length} 个账号，耗时 ${Date.now() - started}ms`)

  const panel: PanelPayload = { rows, ts: Date.now(), refreshSeconds: settings.refresh_seconds }

  snapshot.append(rows)
  void maybeNotify(rows, settings)
  updateTray(rows)

  push(IPC.BALANCE_UPDATED, panel)
  return panel
}

/** 清空结果缓存（账号删除 / 设置变更时调用，避免残留） */
export function invalidateCache(accountId?: string): void {
  if (accountId) cache.delete(accountId)
  else cache.clear()
}
