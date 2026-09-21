import { IPC } from '@shared/ipc'
import type { AutoStartStatus, PanelApi, RefreshPayload } from '@shared/ipc'
import type {
  AccountInput,
  AccountView,
  AppInfo,
  BalanceRow,
  CorrectionView,
  DailyUsageReport,
  FxInfo,
  KeyBulkAction,
  KeyListReport,
  KeyVaultInput,
  LogLevel,
  MonitorCheck,
  MonitorInput,
  MonitorReport,
  MonitorView,
  PanelPayload,
  PlatformUsageReport,
  ReportPeriod,
  Settings,
  Snapshot,
  UsageReport
} from '@shared/types'

/**
 * 渲染进程统一走 window.api（preload 暴露的白名单方法）。
 * 这里把任意调用包成 { ok, data, error }，界面拿到结果先判 ok 再取 data，
 * 省得每处都 try/catch。window.api 不存在时给出明确的中文提示。
 */

export type RpcOk<T> = { ok: true; data: T; error: null }
export type RpcFail = { ok: false; data: null; error: string }
export type RpcResult<T> = RpcOk<T> | RpcFail

/** 取 preload 桥，拿不到就返回 null（不抛错，由调用方决定提示语） */
function getApi(): PanelApi | null {
  const api = (window as unknown as { api?: PanelApi }).api
  return api && typeof api === 'object' ? api : null
}

const NO_BRIDGE = '预加载桥未就绪：window.api 不存在，无法与主进程通信。请重启应用。'

/**
 * 按 IPC 通道名分发到对应的 window.api 方法，并统一包装成 { ok, data, error }。
 * 通道名用 shared/ipc.ts 的 IPC 常量，避免拼错字符串。
 */
export async function safeInvoke<T = unknown>(
  channel: string,
  payload?: unknown
): Promise<RpcResult<T>> {
  const api = getApi()
  if (!api) return { ok: false, data: null, error: NO_BRIDGE }

  try {
    let res: unknown
    switch (channel) {
      case IPC.APP_INFO:
        res = await api.getAppInfo()
        break
      case IPC.ACCOUNT_LIST:
        res = await api.listAccounts()
        break
      case IPC.ACCOUNT_SAVE:
        res = await api.saveAccount(payload as AccountInput)
        break
      case IPC.ACCOUNT_REMOVE:
        res = await api.removeAccount(payload as string)
        break
      case IPC.BALANCE_REFRESH:
        res = await api.refreshBalances(payload as RefreshPayload | undefined)
        break
      case IPC.SETTINGS_GET:
        res = await api.getSettings()
        break
      case IPC.SETTINGS_SAVE:
        res = await api.saveSettings(payload as Partial<Settings>)
        break
      case IPC.APP_OPEN_DATA_DIR:
        res = await api.openDataDir()
        break
      case IPC.ACCOUNT_LOGIN:
        res = await api.loginSite(payload as { url: string; name: string; platform?: string; extraUrls?: string[]; accountId?: string })
        break
      case IPC.ACCOUNT_RENEW:
        res = await api.renewAccount((payload as { id: string }).id)
        break
      case IPC.CORRECTION_VIEW:
        res = await api.correctionView(payload as { accountId: string; limit?: number })
        break
      case IPC.CORRECTION_APPLY:
        res = await api.correctionApply(
          payload as { accountId: string; mode: 'day' | 'dayBalance' | 'dayIgnore' | 'set' | 'offset'; fromTs?: number; dayTs?: number; value: number; note?: string }
        )
        break
      case IPC.CORRECTION_REMOVE:
        res = await api.correctionRemove((payload as { id: string }).id)
        break
      case IPC.CORRECTION_CLEAR:
        res = await api.correctionClear((payload as { accountId: string }).accountId)
        break
      case IPC.FX_GET:
        res = await api.getFx()
        break
      case IPC.SNAPSHOT_LIST:
        res = await api.listSnapshots(payload as string)
        break
      case IPC.SNAPSHOT_DAILY:
        res = await api.listDailyUsage(payload as { days?: number } | undefined)
        break
      case IPC.SNAPSHOT_PLATFORM:
        res = await api.listPlatformUsage(payload as { days?: number } | undefined)
        break
      case IPC.REPORT_USAGE:
        res = await api.getUsageReport(payload as { period?: ReportPeriod } | undefined)
        break
      case IPC.DEMO_TOGGLE:
        res = await api.setDemoMode((payload as { on: boolean }).on)
        break
      case IPC.BACKUP_EXPORT:
        res = await api.exportBackup(payload as { includeHistory?: boolean } | undefined)
        break
      case IPC.BACKUP_IMPORT:
        res = await api.importBackup()
        break
      case IPC.MONITOR_LIST:
        res = await api.listMonitors(payload as { days?: number } | undefined)
        break
      case IPC.MONITOR_SAVE:
        res = await api.saveMonitor(payload as MonitorInput)
        break
      case IPC.MONITOR_REMOVE:
        res = await api.removeMonitor(payload as string)
        break
      case IPC.MONITOR_RUN:
        res = await api.runMonitors(payload as { id?: string } | undefined)
        break
      case IPC.MONITOR_TEST:
        res = await api.testMonitor(payload as MonitorInput)
        break
      case IPC.MONITOR_HISTORY:
        res = await api.listMonitorChecks(payload as { id: string; limit?: number })
        break
      case IPC.KEY_LIST:
        res = await api.listKeys()
        break
      case IPC.KEY_BULK:
        res = await api.bulkKeys(payload as { ids: string[]; action: KeyBulkAction; tags?: string[] })
        break
      case IPC.KEY_SECRET:
        res = await api.revealKey(payload as { id: string; source?: 'account' | 'vault' })
        break
      case IPC.KEY_VAULT_SAVE:
        res = await api.saveVaultKey(payload as KeyVaultInput)
        break
      case IPC.KEY_VAULT_REMOVE:
        res = await api.removeVaultKey(payload as string)
        break
      case IPC.LOG_LIST:
        res = await api.readLogs(payload as { limit?: number; level?: LogLevel; keyword?: string } | undefined)
        break
      case IPC.LOG_CLEAR:
        res = await api.clearLogs()
        break
      case IPC.LOG_EXPORT:
        res = await api.exportLogs()
        break
      case IPC.LOG_OPEN_DIR:
        res = await api.openLogDir()
        break
      case IPC.LOG_SET_LEVEL:
        res = await api.setLogLevel((payload as { level: LogLevel }).level)
        break
      case IPC.BG_LIST:
        res = await api.listBackgrounds()
        break
      case IPC.BG_IMPORT:
        res = await api.importBackground()
        break
      case IPC.BG_REMOVE:
        res = await api.removeBackground(payload as string)
        break
      case IPC.BG_DATA:
        res = await api.backgroundData(payload as string)
        break
      case IPC.BG_FOR_THEME:
        res = await api.backgroundForTheme(payload as string)
        break
      case IPC.APP_AUTOSTART_STATUS:
        res = await api.getAutoStartStatus()
        break
      case IPC.WINDOW_MINIMIZE:
        res = await api.windowMinimize()
        break
      case IPC.WINDOW_TOGGLE_MAX:
        res = await api.windowToggleMaximize()
        break
      case IPC.WINDOW_CLOSE:
        res = await api.windowClose()
        break
      case IPC.WINDOW_GET_STATE:
        res = await api.getWindowState()
        break
      default:
        return { ok: false, data: null, error: `未知的 IPC 通道：${channel}` }
    }
    return { ok: true, data: res as T, error: null }
  } catch (e) {
    return { ok: false, data: null, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 订阅单条余额结果；返回取消订阅函数（无桥时返回空函数） */
export function subscribeRow(callback: (row: BalanceRow) => void): () => void {
  const api = getApi()
  if (!api) return () => {}
  return api.onBalanceRow(callback)
}

/** 订阅整批余额结果；返回取消订阅函数（无桥时返回空函数） */
export function subscribeUpdated(callback: (payload: PanelPayload) => void): () => void {
  const api = getApi()
  if (!api) return () => {}
  return api.onBalanceUpdated(callback)
}

/** 打开配置所在目录 */
export async function openDataDir(): Promise<RpcResult<{ ok: boolean }>> {
  return safeInvoke<{ ok: boolean }>(IPC.APP_OPEN_DATA_DIR)
}

/** 打开内置浏览器登录站点，返回抓到的 Cookie（mimo 等需登录的平台） */
export async function loginSite(
  url: string,
  name: string,
  platform?: string,
  extraUrls?: string[],
  accountId?: string
): Promise<RpcResult<{ ok: boolean; cookie?: string; error?: string; canRenew?: boolean }>> {
  return safeInvoke<{ ok: boolean; cookie?: string; error?: string; canRenew?: boolean }>(IPC.ACCOUNT_LOGIN, {
    url,
    name,
    platform,
    extraUrls,
    accountId
  })
}

/** 静默续期登录（用保存的会话换新凭据，不弹窗） */
export async function renewAccount(id: string): Promise<RpcResult<{ ok: boolean; error: string; needLogin: boolean; expiresAt: number | null }>> {
  return safeInvoke<{ ok: boolean; error: string; needLogin: boolean; expiresAt: number | null }>(IPC.ACCOUNT_RENEW, { id })
}

// ---------- 数据校正 ----------

/** 读某账号的校正视图 */
export async function correctionView(accountId: string, limit = 400): Promise<RpcResult<CorrectionView>> {
  return safeInvoke<CorrectionView>(IPC.CORRECTION_VIEW, { accountId, limit })
}

/** 新增校正：改某天用量 / 平移 / 设为指定值 */
export async function correctionApply(payload: {
  accountId: string
  mode: 'day' | 'dayBalance' | 'dayIgnore' | 'set' | 'offset'
  fromTs?: number
  dayTs?: number
  value: number
  note?: string
}): Promise<RpcResult<{ ok: boolean; correctionId: string; offset: number; message: string }>> {
  return safeInvoke<{ ok: boolean; correctionId: string; offset: number; message: string }>(IPC.CORRECTION_APPLY, payload)
}

/** 撤销一条校正 */
export async function correctionRemove(id: string): Promise<RpcResult<{ ok: boolean }>> {
  return safeInvoke<{ ok: boolean }>(IPC.CORRECTION_REMOVE, { id })
}

/** 清空某账号的全部校正（一键还原） */
export async function correctionClear(accountId: string): Promise<RpcResult<{ ok: boolean; removed: number }>> {
  return safeInvoke<{ ok: boolean; removed: number }>(IPC.CORRECTION_CLEAR, { accountId })
}

/** 取实时汇率（成本折算用） */
export async function listDailyUsage(days: number = 30): Promise<RpcResult<DailyUsageReport>> {
  return safeInvoke<DailyUsageReport>(IPC.SNAPSHOT_DAILY, { days })
}

export async function listPlatformUsage(days: number = 30): Promise<RpcResult<PlatformUsageReport>> {
  return safeInvoke<PlatformUsageReport>(IPC.SNAPSHOT_PLATFORM, { days })
}

/** AI 使用报告（只基于金额） */
export async function getUsageReport(period: ReportPeriod = 'day'): Promise<RpcResult<UsageReport>> {
  return safeInvoke<UsageReport>(IPC.REPORT_USAGE, { period })
}

/** 切换演示模式（内存沙箱） */
export async function setDemoMode(on: boolean): Promise<RpcResult<{ ok: boolean; demo: boolean }>> {
  return safeInvoke<{ ok: boolean; demo: boolean }>(IPC.DEMO_TOGGLE, { on })
}

/** 导出配置备份 */
export async function exportBackup(includeHistory: boolean = true): Promise<RpcResult<{ ok: boolean; path?: string; error?: string }>> {
  return safeInvoke<{ ok: boolean; path?: string; error?: string }>(IPC.BACKUP_EXPORT, { includeHistory })
}

/** 导入配置备份 */
export async function importBackup(): Promise<RpcResult<{ ok: boolean; message: string }>> {
  return safeInvoke<{ ok: boolean; message: string }>(IPC.BACKUP_IMPORT)
}

/** 接口监控报告（目标 + 统计） */
export async function listMonitors(days: number = 30): Promise<RpcResult<MonitorReport>> {
  return safeInvoke<MonitorReport>(IPC.MONITOR_LIST, { days })
}

/** 新增 / 编辑监控目标 */
export async function saveMonitor(input: MonitorInput): Promise<RpcResult<MonitorView>> {
  return safeInvoke<MonitorView>(IPC.MONITOR_SAVE, input)
}

/** 删除监控目标 */
export async function removeMonitor(id: string): Promise<RpcResult<boolean>> {
  return safeInvoke<boolean>(IPC.MONITOR_REMOVE, id)
}

/** 立即检查（省略 id = 全部启用目标） */
export async function runMonitors(id?: string): Promise<RpcResult<MonitorCheck[]>> {
  return safeInvoke<MonitorCheck[]>(IPC.MONITOR_RUN, id ? { id } : {})
}

/** 用表单配置试跑一次（不保存） */
export async function testMonitor(input: MonitorInput): Promise<RpcResult<MonitorCheck>> {
  return safeInvoke<MonitorCheck>(IPC.MONITOR_TEST, input)
}

/** 某个目标的检查历史 */
export async function listMonitorChecks(id: string, limit: number = 200): Promise<RpcResult<MonitorCheck[]>> {
  return safeInvoke<MonitorCheck[]>(IPC.MONITOR_HISTORY, { id, limit })
}

/** 保存账号（Key 管理页的克隆功能用） */
export async function saveAccount(input: AccountInput): Promise<RpcResult<AccountView>> {
  return safeInvoke<AccountView>(IPC.ACCOUNT_SAVE, input)
}

// ---------- 运行日志 ----------

export interface LogEntryView { ts: number; level: LogLevel; text: string }
export interface LogListResult {
  entries: LogEntryView[]
  level: LogLevel
  files: { name: string; size: number; mtime: number }[]
}

export async function readLogs(opts?: { limit?: number; level?: LogLevel; keyword?: string }): Promise<RpcResult<LogListResult>> {
  return safeInvoke<LogListResult>(IPC.LOG_LIST, opts ?? {})
}

export async function clearLogs(): Promise<RpcResult<{ ok: boolean }>> {
  return safeInvoke<{ ok: boolean }>(IPC.LOG_CLEAR)
}

export async function exportLogs(): Promise<RpcResult<{ ok: boolean; path?: string; error?: string }>> {
  return safeInvoke<{ ok: boolean; path?: string; error?: string }>(IPC.LOG_EXPORT)
}

export async function openLogDir(): Promise<RpcResult<{ ok: boolean }>> {
  return safeInvoke<{ ok: boolean }>(IPC.LOG_OPEN_DIR)
}

export async function setLogLevel(level: LogLevel): Promise<RpcResult<{ level: LogLevel }>> {
  return safeInvoke<{ level: LogLevel }>(IPC.LOG_SET_LEVEL, { level })
}

// ---------- Key 管理 ----------

export async function listKeys(): Promise<RpcResult<KeyListReport>> {
  return safeInvoke<KeyListReport>(IPC.KEY_LIST)
}

export async function bulkKeys(ids: string[], action: KeyBulkAction, tags?: string[]): Promise<RpcResult<{ affected: number }>> {
  return safeInvoke<{ affected: number }>(IPC.KEY_BULK, { ids, action, tags })
}

/** 取密钥明文（仅用于本机复制） */
export async function revealKey(id: string, source: 'account' | 'vault' = 'account'): Promise<RpcResult<string>> {
  return safeInvoke<string>(IPC.KEY_SECRET, { id, source })
}

/** 保存 Key 库记录（不会创建账号） */
export async function saveVaultKey(input: KeyVaultInput): Promise<RpcResult<{ ok: boolean; id: string }>> {
  return safeInvoke<{ ok: boolean; id: string }>(IPC.KEY_VAULT_SAVE, input)
}

/** 删除 Key 库记录 */
export async function removeVaultKey(id: string): Promise<RpcResult<{ ok: boolean }>> {
  return safeInvoke<{ ok: boolean }>(IPC.KEY_VAULT_REMOVE, id)
}

// ---------- 自定义背景 ----------

export async function listBackgrounds(): Promise<RpcResult<{ files: { name: string; size: number; builtin: boolean }[] }>> {
  return safeInvoke<{ files: { name: string; size: number; builtin: boolean }[] }>(IPC.BG_LIST)
}

export async function importBackground(): Promise<RpcResult<{ ok: boolean; name?: string; error?: string }>> {
  return safeInvoke<{ ok: boolean; name?: string; error?: string }>(IPC.BG_IMPORT)
}

export async function removeBackground(name: string): Promise<RpcResult<{ ok: boolean }>> {
  return safeInvoke<{ ok: boolean }>(IPC.BG_REMOVE, name)
}

export async function backgroundData(name: string): Promise<RpcResult<{ ok: boolean; dataUrl?: string; error?: string }>> {
  return safeInvoke<{ ok: boolean; dataUrl?: string; error?: string }>(IPC.BG_DATA, name)
}

/** 主题对应的内置默认背景 */
export async function backgroundForTheme(theme: string): Promise<RpcResult<{ name: string | null }>> {
  return safeInvoke<{ name: string | null }>(IPC.BG_FOR_THEME, theme)
}

/** 开机自启的真实状态（主进程回读系统启动项，不是配置里的期望值） */
export async function getAutoStartStatus(): Promise<RpcResult<AutoStartStatus>> {
  return safeInvoke<AutoStartStatus>(IPC.APP_AUTOSTART_STATUS)
}

// ---------- 自绘标题栏的窗口控制 ----------

export async function windowMinimize(): Promise<void> {
  await safeInvoke(IPC.WINDOW_MINIMIZE)
}

export async function windowToggleMaximize(): Promise<RpcResult<{ maximized: boolean }>> {
  return safeInvoke<{ maximized: boolean }>(IPC.WINDOW_TOGGLE_MAX)
}

export async function windowClose(): Promise<void> {
  await safeInvoke(IPC.WINDOW_CLOSE)
}

export async function getWindowState(): Promise<RpcResult<{ maximized: boolean }>> {
  return safeInvoke<{ maximized: boolean }>(IPC.WINDOW_GET_STATE)
}

/** 订阅窗口最大化状态变化（无桥时返回空函数） */
export function subscribeWindowState(callback: (state: { maximized: boolean }) => void): () => void {
  const api = getApi()
  if (!api || typeof api.onWindowState !== 'function') return () => {}
  return api.onWindowState(callback)
}

export async function getFx(): Promise<RpcResult<FxInfo>> {
  return safeInvoke<FxInfo>(IPC.FX_GET)
}

/** 取某账号的余额快照（趋势图用） */
export async function listSnapshots(accountId: string): Promise<RpcResult<Snapshot[]>> {
  return safeInvoke<Snapshot[]>(IPC.SNAPSHOT_LIST, accountId)
}

export type { AppInfo, AccountView, BalanceRow, PanelPayload, Settings, AccountInput }
