import { Notification } from 'electron'
import type { BalanceRow, Settings, Snapshot } from '../shared/types'
import { logger } from './logger'
import { readSnapshots } from './snapshot'
import { store } from './store'
import { buildDailyUsage } from './usage'

/**
 * 系统通知（四类，共用 notice_state 限频；同一类同一天最多 notice_max_per_day 次）：
 * 1. 低余额：remaining < 阈值（原有行为）
 * 2. 余额骤降：一次刷新内跌幅 ≥ drop_alert_percent%
 * 3. 接口连续失败：连续失败次数达到 fail_alert_count
 * 4. 每日预算：当日消耗达到预算的 80% / 100%（每种单位每天各 1 次）
 */

function send(title: string, body: string): boolean {
  try {
    new Notification({ title, body }).show()
    return true
  } catch (e) {
    logger.warn('[notify] 系统通知发送失败：', (e as Error).message)
    return false
  }
}

/** 每天最多提醒 times 次；返回 true 表示可以发 */
function allow(key: string, times: number): boolean {
  return store.getNoticeState(key).count < times
}

/** 取每个账号最近的快照（按 ts 升序，最多保留末尾两条） */
function tailByAccount(snaps: Snapshot[]): Map<string, Snapshot[]> {
  const sorted = snaps.filter((s) => s && s.ok !== undefined).sort((a, b) => a.ts - b.ts)
  const map = new Map<string, Snapshot[]>()
  for (const s of sorted) {
    const arr = map.get(s.account_id) ?? []
    arr.push(s)
    if (arr.length > 40) arr.shift()
    map.set(s.account_id, arr)
  }
  return map
}

/** 低余额（原有） */
function notifyLow(rows: BalanceRow[], settings: Settings): void {
  for (const row of rows) {
    if (!row.ok || !row.lowBalance) continue
    if (row.remaining === null || row.threshold === null) continue
    const account = store.getAccount(row.accountId)
    if (!account || account.notice_enabled === false) continue
    if (!allow(row.accountId, settings.notice_max_per_day)) continue
    if (send('余额不足提醒', '「' + row.name + '」剩余 ' + row.remaining + ' ' + row.unit + '，已低于阈值 ' + row.threshold + '。')) {
      store.bumpNotice(row.accountId)
      logger.info('[notify] 已提醒账号：' + row.name)
    }
  }
}

/** 余额骤降 */
function notifyDrop(rows: BalanceRow[], tails: Map<string, Snapshot[]>, settings: Settings): void {
  if (settings.drop_alert_percent <= 0) return
  for (const row of rows) {
    if (!row.ok || row.remaining === null) continue
    const account = store.getAccount(row.accountId)
    if (!account || account.notice_enabled === false) continue
    const list = tails.get(row.accountId) ?? []
    if (list.length < 2) continue
    const prev = list[list.length - 2]
    if (prev.remaining === null || prev.remaining === undefined || prev.remaining <= 0) continue
    if (!prev.ok) continue
    const drop = ((prev.remaining - row.remaining) / prev.remaining) * 100
    if (drop < settings.drop_alert_percent) continue
    const key = 'drop:' + row.accountId
    if (!allow(key, settings.notice_max_per_day)) continue
    const body =
      '「' + row.name + '」余额从 ' + prev.remaining + ' 降到 ' + row.remaining + ' ' + row.unit +
      '（-' + drop.toFixed(0) + '%），请确认是否有异常调用。'
    if (send('余额骤降提醒', body)) {
      store.bumpNotice(key)
      logger.info('[notify] 余额骤降提醒：' + row.name + ' -' + drop.toFixed(0) + '%')
    }
  }
}

/** 连续失败（接口可能故障） */
function notifyFail(rows: BalanceRow[], tails: Map<string, Snapshot[]>, settings: Settings): void {
  if (settings.fail_alert_count <= 0) return
  for (const row of rows) {
    if (row.ok) continue
    const account = store.getAccount(row.accountId)
    if (!account || account.notice_enabled === false) continue
    const list = tails.get(row.accountId) ?? []
    let fails = 0
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].ok) break
      fails += 1
    }
    if (fails < settings.fail_alert_count) continue
    const key = 'fail:' + row.accountId
    if (!allow(key, 1)) continue
    const body =
      '「' + row.name + '」已连续 ' + fails + ' 次查询失败：' + (row.note || '未知原因') +
      '。可能是平台临时故障或凭据过期。'
    if (send('接口异常提醒', body)) {
      store.bumpNotice(key)
      logger.info('[notify] 连续失败提醒：' + row.name + ' ×' + fails)
    }
  }
}

/** 每日预算（80% / 100%） */
async function notifyBudget(settings: Settings): Promise<void> {
  const budgets = settings.daily_budget
  const units = budgets ? Object.keys(budgets) : []
  if (units.length === 0) return
  let report: Awaited<ReturnType<typeof buildDailyUsage>>
  try {
    report = await buildDailyUsage(1)
  } catch (e) {
    logger.warn('[notify] 预算检查失败：', (e as Error).message)
    return
  }
  for (const u of report.unitTotals) {
    const budget = budgets[u.unit]
    if (!budget || budget <= 0) continue
    const used = u.today ?? 0
    if (used <= 0) continue
    const ratio = used / budget
    if (ratio < 0.8) continue
    const key = 'budget:' + u.unit
    if (!allow(key, 1)) continue
    const over = ratio >= 1
    const body =
      '今日已消耗 ' + used.toFixed(2) + ' ' + u.unit + '，预算 ' + budget + ' ' + u.unit +
      '（已用 ' + (ratio * 100).toFixed(0) + '%）。'
    if (send(over ? '今日预算已超支' : '今日预算提醒', body)) {
      store.bumpNotice(key)
      logger.info('[notify] 预算提醒：' + u.unit + ' ' + (ratio * 100).toFixed(0) + '%')
    }
  }
}

/** 入口：查询完成后调用（异步，内部自行吞异常） */
export async function maybeNotify(rows: BalanceRow[], settings: Settings): Promise<void> {
  if (!settings.notice_enabled) return
  if (!Notification.isSupported()) return
  let tails = new Map<string, Snapshot[]>()
  try {
    tails = tailByAccount(await readSnapshots())
  } catch (e) {
    logger.warn('[notify] 读取快照失败（骤降/失败提醒跳过）：', (e as Error).message)
  }
  notifyLow(rows, settings)
  notifyDrop(rows, tails, settings)
  notifyFail(rows, tails, settings)
  try {
    await notifyBudget(settings)
  } catch (e) {
    logger.warn('[notify] 预算提醒失败：', (e as Error).message)
  }
}
