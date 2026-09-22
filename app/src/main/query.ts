import { Notification } from 'electron'
import { IPC } from '../shared/ipc'
import type { RefreshPayload } from '../shared/ipc'
import type { Account, BalanceResult, BalanceRow, CredentialSession, PanelPayload } from '../shared/types'
import { getAdapter } from './adapters'
import { totalOffset } from './corrections'
import { AdapterError, failResult, mapFetchError } from './errors'
import { logger } from './logger'
import { maybeNotify } from './notify'
import { isDemo, demoRows } from './demo'
import { updateTray } from './tray'
import { runPool } from './runPool'
import { renewCredential, msUntilExpiry, sessionExpiryMs, supportsRenewal } from './renewal'
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

/** 构造适配器上下文（凭据读写都走 store，明文只在主进程内存） */
function adapterCtx() {
  return {
    getSecret: (a: Account): string => store.getSecret(a),
    getSession: (a: Account): CredentialSession | null => store.getSession(a),
    saveRenewed: (a: Account, token: string, session: CredentialSession | null): void => {
      store.saveCredential(a.id, { secret: token, session })
      logger.info(`[query] ${a.name} 已回写续期后的凭据`)
    }
  }
}

/**
 * 续期冷却：同一账号失败后 5 分钟内不再重试。
 *
 * 为什么需要：续期现在会**真实校验**结果（renewal.ts 里用余额接口验），失败时不再谎报成功；
 * 而查询链路在"凭据临期"和"查询 401"两处都会触发续期，保活每 20 分钟还会再来一次。
 * 没有冷却的话，一个已经失效的会话会被反复拿去开隐藏窗口试（每次 6~10 秒），
 * 白白消耗网络与资源。成功的续期会清掉冷却。
 */
const renewCooldown = new Map<string, number>()
const RENEW_COOLDOWN_MS = 5 * 60 * 1000

/**
 * 给某个账号做一次静默续期，成功则落盘并返回 true。
 * @param reason 'expired' 到期/失败后自动续期；'manual' 用户点卡片按钮；'startup' 启动时预热
 */
export async function renewForAccount(account: Account, reason: 'expired' | 'manual' | 'startup'): Promise<boolean> {
  if (!supportsRenewal(account.type)) return false
  // 手动点按钮时不受冷却限制（用户明确要求重试）
  const until = renewCooldown.get(account.id) ?? 0
  if (reason !== 'manual' && Date.now() < until) {
    logger.info(`[query] ${account.name} 续期冷却中（${Math.ceil((until - Date.now()) / 1000)} 秒后再试），跳过本次`)
    return false
  }
  const session = store.getSession(account)
  const r = await renewCredential(account.type, session, { reason })
  // 无论成功失败都把最新的会话材料存下来（失败时也更新，便于下次判断会话是否已失效）
  if (r.session) store.saveCredential(account.id, { session: r.session })
  if (!r.ok || !r.secret) {
    if (r.session) store.saveCredential(account.id, { tokenExpiresAt: 0 })
    if (reason !== 'manual') renewCooldown.set(account.id, Date.now() + RENEW_COOLDOWN_MS)
    return false
  }
  renewCooldown.delete(account.id)
  store.saveCredential(account.id, { secret: r.secret, session: r.session ?? session, tokenExpiresAt: r.expiresAt ?? null })
  invalidateCache(account.id)
  logger.info(`[query] ${account.name} 静默续期成功（${reason}），凭据有效期至 ${r.expiresAt ? new Date(r.expiresAt).toLocaleString('zh-CN') : '未知'}`)
  return true
}

/** 单账号查询；force 为 true 时跳过缓存 */
async function queryAccount(accountInput: Account, force: boolean): Promise<BalanceRow> {
  let account = accountInput
  const settings = store.getSettings()

  if (!force) {
    const hit = cache.get(account.id)
    if (hit && Date.now() - hit.at < settings.cache_seconds * 1000) {
      return { ...hit.row, cached: true }
    }
  }

  const started = Date.now()

  // 凭据临期（或已过期）→ 先静默续期，避免"正好卡在过期那一刻"报一次失败
  if (supportsRenewal(account.type)) {
    let left = msUntilExpiry(account)
    // token 解不出到期时间（商汤）→ 退回用会话 Cookie 的到期时间判断，别等到 401 才续
    if (left === null) {
      const se = await sessionExpiryMs(account.type)
      if (se !== null) left = se - Date.now()
    }
    if (left !== null && left < 15 * 60 * 1000) {
      logger.info(`[query] ${account.name} 凭据${left <= 0 ? '已过期' : '将在 ' + Math.round(left / 60000) + ' 分钟后过期'}，先静默续期`)
      await renewForAccount(account, 'expired')
      account = store.getAccount(account.id) ?? account
    }
  }

  let result: BalanceResult
  try {
    const adapter = getAdapter(account.type)
    result = await adapter(account, adapterCtx())
  } catch (e) {
    const code = e instanceof AdapterError ? e.code : mapFetchError(e)
    const detail = e instanceof AdapterError ? e.detail : String((e as Error)?.message ?? e)
    logger.warn(`[query] ${account.name} 查询失败：${code}${detail ? ` ${detail}` : ''}`)
    result = failResult(code, detail)
    // 凭据过期且该平台支持静默续期：后台续一次再重试（用户不用手动重新登录）
    if (code === 'COOKIE_EXPIRED' && (await renewForAccount(account, 'expired'))) {
      try {
        const fresh = store.getAccount(account.id) ?? account
        result = await getAdapter(account.type)(fresh, adapterCtx())
        logger.info(`[query] ${account.name} 续期后重试成功`)
      } catch (e2) {
        const code2 = e2 instanceof AdapterError ? e2.code : mapFetchError(e2)
        const detail2 = e2 instanceof AdapterError ? e2.detail : String((e2 as Error)?.message ?? e2)
        logger.warn(`[query] ${account.name} 续期后仍失败：${code2}${detail2 ? ` ${detail2}` : ''}`)
        result = failResult(code2, detail2)
      }
    }
  }
  result.latencyMs = Date.now() - started

  // 手动校正：卡片实时数字也套用同一套校正（否则刷新后又会显示平台那个错值）
  const adjust = totalOffset(account.id)
  if (adjust !== 0) {
    const shift = (v: number | null | undefined): number | null =>
      v === null || v === undefined || !Number.isFinite(v) ? (v ?? null) : Math.round((v + adjust) * 1e6) / 1e6
    result = {
      ...result,
      remaining: shift(result.remaining),
      total: shift(result.total),
      used: result.used === null || result.used === undefined ? result.used : Math.round((result.used - adjust) * 1e6) / 1e6,
      items: (result.items ?? []).map((it) => ({
        ...it,
        remaining: shift(it.remaining),
        total: shift(it.total),
        used: it.used === null || it.used === undefined ? it.used : Math.round((it.used - adjust) * 1e6) / 1e6
      })),
      note: (result.note ? result.note + ' · ' : '') + '已手动校正 ' + (adjust > 0 ? '+' : '') + adjust
    }
  }

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

// ---------- 后台保活（会话预热） ----------

/** 保活定时器 */
let keepAliveTimer: NodeJS.Timeout | null = null
/** 已经提醒过"会话即将到期"的账号（按到期时间戳去重，避免重复轰炸） */
const warnedExpiry = new Map<string, number>()
/** 提前多久提醒"该重新登录了" */
const EXPIRY_WARN_MS = 15 * 60 * 1000

/**
 * 扫描所有登录型账号，把「即将过期 / 已过期 / 从未记录过期时间」的凭据续一遍。
 * 由 main/index.ts 定时调用：**窗口隐藏或最小化时同样运行**（保活就是要一直跑）。
 *
 * 2026-09-22 增补（商汤实测教训）：有些平台的会话是**绝对到期、无法续期**的
 * （商汤 `oauth2_authentication_session` = 登录 + 3 小时，reload 也不顺延，且没有 refresh token）。
 * 那种情况下再怎么续也没用，但**绝不能让它静默失效**——所以到期前 15 分钟先提醒一次，
 * 让用户主动重新登录（新版登录点一下「只重新登录」即可）。
 *
 * @param maxAgeMs 距离过期还有多久就续（默认 60 分钟）
 */
export async function keepAliveSessions(maxAgeMs = 60 * 60 * 1000): Promise<number> {
  if (isDemo()) return 0
  const targets = store.listAccounts().filter((a) => a.enabled && !a.deleted_at && supportsRenewal(a.type))
  let renewed = 0
  for (const acc of targets) {
    const left = msUntilExpiry(acc)
    // 会话（Cookie）的到期时间：商汤这类平台靠它判断"还能撑多久"，也是硬上限
    const sessionExp = await sessionExpiryMs(acc.type)
    const sessionLeft = sessionExp === null ? null : sessionExp - Date.now()

    // 到期前提醒（每个到期时间只提醒一次）：绝对到期的会话救不回来，至少别让用户毫无预告地失联
    if (sessionLeft !== null && sessionExp !== null && sessionLeft > 0 && sessionLeft < EXPIRY_WARN_MS) {
      if (warnedExpiry.get(acc.id) !== sessionExp) {
        warnedExpiry.set(acc.id, sessionExp)
        logger.warn(`[keepalive] ${acc.name} 的登录会话将在约 ${Math.max(1, Math.round(sessionLeft / 60000))} 分钟后到期，需要重新登录`)
        notifyExpiry(acc, sessionLeft)
      }
    } else if (sessionLeft === null || sessionLeft > EXPIRY_WARN_MS) {
      warnedExpiry.delete(acc.id) // 重新登录后会话变了，允许下次再提醒
    }

    /**
     * 要不要现在续：
     * - token 到期时间已知（能解出 JWT exp）→ 按它判断；
     * - token 到期时间未知（商汤的 token 解不出 exp）→ 退回用**会话到期时间**判断，
     *   这样"会话还剩不到 1 小时"时才去续一次（此刻平台还能换出新 token），
     *   而不是每 20 分钟白跑一趟隐藏窗口。
     */
    const needRenew = left !== null
      ? left < maxAgeMs
      : sessionLeft !== null
        ? sessionLeft < maxAgeMs
        : Boolean(store.getSession(acc))
    if (!needRenew) continue
    try {
      if (await renewForAccount(acc, 'startup')) renewed++
    } catch (e) {
      logger.warn(`[keepalive] ${acc.name} 续期异常：${(e as Error).message}`)
    }
  }
  if (renewed > 0) logger.info(`[keepalive] 本轮续期 ${renewed} 个账号`)
  return renewed
}

/** 会话到期提醒（系统通知；失败不影响保活） */
function notifyExpiry(account: Account, leftMs: number): void {
  try {
    if (!Notification.isSupported()) return
    const min = Math.max(1, Math.round(leftMs / 60000))
    new Notification({
      title: account.name + ' 需要重新登录',
      body: `登录会话约 ${min} 分钟后到期（该平台的会话无法自动续期）。请打开面板，在账号编辑里点「只重新登录」重登一次。`,
      silent: false
    }).show()
  } catch { /* 通知失败不影响主流程 */ }
}

/** 启动保活定时器（应用启动 / 退出时调用一次） */
export function startKeepAlive(intervalMs = 5 * 60 * 1000): void {
  if (keepAliveTimer) return
  keepAliveTimer = setInterval(() => {
    void keepAliveSessions().catch((e: unknown) => logger.warn('[keepalive] 保活失败：' + (e as Error).message))
  }, intervalMs)
  logger.info(`[keepalive] 会话保活已启动（每 ${Math.round(intervalMs / 60000)} 分钟检查一次，窗口隐藏时同样运行）`)
}

export function stopKeepAlive(): void {
  if (keepAliveTimer) clearInterval(keepAliveTimer)
  keepAliveTimer = null
}
