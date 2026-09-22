import type { PanelApi } from '@shared/ipc'
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
import type { AutoStartStatus, RefreshPayload } from '@shared/ipc'

/**
 * 渲染进程统一走 window.api（preload 暴露的白名单方法）。
 *
 * 这里把每次调用包成 { ok, data, error }，界面拿到结果先判 ok 再取 data，
 * 省得每处都 try/catch。window.api 不存在时给出明确的中文提示。
 *
 * 架构说明（v1.6.0 起）：每个封装函数**直调**对应的 window.api 方法，
 * 不再经过「通道名 switch」镜像分发——此前同一通道要在 IPC 常量 / PanelApi /
 * preload / switch case / 封装函数五处同步维护，account:relogin 的断链
 * （switch 漏 case 导致功能整个失效）正是镜像漂移的直接产物。
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

/** 统一 RPC 包装：调用一个 window.api 方法并包成 { ok, data, error } */
async function rpc<T>(call: (api: PanelApi) => Promise<T>): Promise<RpcResult<T>> {
  const api = getApi()
  if (!api) return { ok: false, data: null, error: NO_BRIDGE }
  try {
    return { ok: true, data: await call(api), error: null }
  } catch (e) {
    return { ok: false, data: null, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 订阅辅助：无桥时返回空的取消订阅函数 */
function subscribe<T>(bind: (api: PanelApi, cb: (v: T) => void) => () => void, cb: (v: T) => void): () => void {
  const api = getApi()
  if (!api) return () => {}
  return bind(api, cb)
}

// ---------- 账号 / 面板 ----------

export function getAppInfo(): Promise<RpcResult<AppInfo>> {
  return rpc((a) => a.getAppInfo())
}

export function listAccounts(): Promise<RpcResult<AccountView[]>> {
  return rpc((a) => a.listAccounts())
}

/** 纯保存账号（不做后续刷新）；需要「保存后重载并刷新」的用 usePanel().saveAccount */
export function saveAccount(input: AccountInput): Promise<RpcResult<AccountView>> {
  return rpc((a) => a.saveAccount(input))
}

export function removeAccount(id: string): Promise<RpcResult<{ ok: boolean }>> {
  return rpc((a) => a.removeAccount(id))
}

export function refreshBalances(payload?: RefreshPayload): Promise<RpcResult<PanelPayload>> {
  return rpc((a) => a.refreshBalances(payload))
}

export function getSettings(): Promise<RpcResult<Settings>> {
  return rpc((a) => a.getSettings())
}

export function saveSettings(patch: Partial<Settings>): Promise<RpcResult<Settings>> {
  return rpc((a) => a.saveSettings(patch))
}

/** 打开配置所在目录 */
export function openDataDir(): Promise<RpcResult<{ ok: boolean }>> {
  return rpc((a) => a.openDataDir())
}

/** 订阅单条余额结果；返回取消订阅函数（无桥时返回空函数） */
export function subscribeRow(callback: (row: BalanceRow) => void): () => void {
  return subscribe((a, cb) => a.onBalanceRow(cb), callback)
}

/** 订阅整批余额结果；返回取消订阅函数（无桥时返回空函数） */
export function subscribeUpdated(callback: (payload: PanelPayload) => void): () => void {
  return subscribe((a, cb) => a.onBalanceUpdated(cb), callback)
}

// ---------- 登录 / 续期 ----------

export interface LoginResult {
  ok: boolean
  cookie?: string
  error?: string
  canRenew?: boolean
  renewHint?: string
}

/** 打开内置浏览器登录站点，返回抓到的 Cookie（mimo 等需登录的平台） */
export function loginSite(
  url: string,
  name: string,
  platform?: string,
  extraUrls?: string[],
  accountId?: string
): Promise<RpcResult<LoginResult>> {
  return rpc((a) => a.loginSite({ url, name, platform, extraUrls, accountId }))
}

/** 静默续期登录（用保存的会话换新凭据，不弹窗） */
export function renewAccount(id: string): Promise<RpcResult<{ ok: boolean; error: string; needLogin: boolean; expiresAt: number | null }>> {
  return rpc((a) => a.renewAccount(id))
}

/** 一键重新登录（卡片按钮）：打开该平台的登录窗口，成功后主进程自动写回账号 */
export function reloginAccount(id: string): Promise<RpcResult<LoginResult>> {
  return rpc((a) => a.reloginAccount(id))
}

// ---------- 数据校正 ----------

/** 读某账号的校正视图 */
export function correctionView(accountId: string, limit = 400): Promise<RpcResult<CorrectionView>> {
  return rpc((a) => a.correctionView({ accountId, limit }))
}

/** 新增校正：改某天用量 / 平移 / 设为指定值 */
export function correctionApply(payload: {
  accountId: string
  mode: 'day' | 'dayBalance' | 'dayIgnore' | 'set' | 'offset'
  fromTs?: number
  dayTs?: number
  value: number
  note?: string
}): Promise<RpcResult<{ ok: boolean; correctionId: string; offset: number; message: string }>> {
  return rpc((a) => a.correctionApply(payload))
}

/** 撤销一条校正 */
export function correctionRemove(id: string): Promise<RpcResult<{ ok: boolean }>> {
  return rpc((a) => a.correctionRemove(id))
}

/** 清空某账号的全部校正（一键还原） */
export function correctionClear(accountId: string): Promise<RpcResult<{ ok: boolean; removed: number }>> {
  return rpc((a) => a.correctionClear(accountId))
}

// ---------- 统计 / 报告 ----------

/** 每日使用状况统计（含余额耗尽预估） */
export function listDailyUsage(days: number = 30): Promise<RpcResult<DailyUsageReport>> {
  return rpc((a) => a.listDailyUsage({ days }))
}

export function listPlatformUsage(days: number = 30): Promise<RpcResult<PlatformUsageReport>> {
  return rpc((a) => a.listPlatformUsage({ days }))
}

/** AI 使用报告（只基于金额） */
export function getUsageReport(period: ReportPeriod = 'day'): Promise<RpcResult<UsageReport>> {
  return rpc((a) => a.getUsageReport({ period }))
}

/** 取实时汇率（成本折算用） */
export function getFx(): Promise<RpcResult<FxInfo>> {
  return rpc((a) => a.getFx())
}

/** 取某账号的余额快照（趋势图用） */
export function listSnapshots(accountId: string): Promise<RpcResult<Snapshot[]>> {
  return rpc((a) => a.listSnapshots(accountId))
}

// ---------- 演示 / 备份 ----------

/** 切换演示模式（内存沙箱） */
export function setDemoMode(on: boolean): Promise<RpcResult<{ ok: boolean; demo: boolean }>> {
  return rpc((a) => a.setDemoMode(on))
}

/** 导出配置备份 */
export function exportBackup(includeHistory: boolean = true): Promise<RpcResult<{ ok: boolean; path?: string; error?: string }>> {
  return rpc((a) => a.exportBackup({ includeHistory }))
}

/** 导入配置备份 */
export function importBackup(): Promise<RpcResult<{ ok: boolean; message: string }>> {
  return rpc((a) => a.importBackup())
}

// ---------- 接口监控 ----------

/** 接口监控报告（目标 + 统计） */
export function listMonitors(days: number = 30): Promise<RpcResult<MonitorReport>> {
  return rpc((a) => a.listMonitors({ days }))
}

/** 新增 / 编辑监控目标 */
export function saveMonitor(input: MonitorInput): Promise<RpcResult<MonitorView>> {
  return rpc((a) => a.saveMonitor(input))
}

/** 删除监控目标 */
export function removeMonitor(id: string): Promise<RpcResult<boolean>> {
  return rpc((a) => a.removeMonitor(id))
}

/** 立即检查（省略 id = 全部启用目标） */
export function runMonitors(id?: string): Promise<RpcResult<MonitorCheck[]>> {
  return rpc((a) => a.runMonitors(id ? { id } : {}))
}

/** 用表单配置试跑一次（不保存） */
export function testMonitor(input: MonitorInput): Promise<RpcResult<MonitorCheck>> {
  return rpc((a) => a.testMonitor(input))
}

/** 某个目标的检查历史 */
export function listMonitorChecks(id: string, limit: number = 200): Promise<RpcResult<MonitorCheck[]>> {
  return rpc((a) => a.listMonitorChecks({ id, limit }))
}

// ---------- 运行日志 ----------

export interface LogEntryView { ts: number; level: LogLevel; text: string }
export interface LogListResult {
  entries: LogEntryView[]
  level: LogLevel
  files: { name: string; size: number; mtime: number }[]
}

export function readLogs(opts?: { limit?: number; level?: LogLevel; keyword?: string }): Promise<RpcResult<LogListResult>> {
  return rpc((a) => a.readLogs(opts ?? {}))
}

export function clearLogs(): Promise<RpcResult<{ ok: boolean }>> {
  return rpc((a) => a.clearLogs())
}

export function exportLogs(): Promise<RpcResult<{ ok: boolean; path?: string; error?: string }>> {
  return rpc((a) => a.exportLogs())
}

export function openLogDir(): Promise<RpcResult<{ ok: boolean }>> {
  return rpc((a) => a.openLogDir())
}

export function setLogLevel(level: LogLevel): Promise<RpcResult<{ level: LogLevel }>> {
  return rpc((a) => a.setLogLevel(level))
}

// ---------- Key 管理 ----------

export function listKeys(): Promise<RpcResult<KeyListReport>> {
  return rpc((a) => a.listKeys())
}

export function bulkKeys(ids: string[], action: KeyBulkAction, tags?: string[]): Promise<RpcResult<{ affected: number }>> {
  return rpc((a) => a.bulkKeys({ ids, action, tags }))
}

/** 取密钥明文（仅用于本机复制） */
export function revealKey(id: string, source: 'account' | 'vault' = 'account'): Promise<RpcResult<string>> {
  return rpc((a) => a.revealKey({ id, source }))
}

/** 保存 Key 库记录（不会创建账号） */
export function saveVaultKey(input: KeyVaultInput): Promise<RpcResult<{ ok: boolean; id: string }>> {
  return rpc((a) => a.saveVaultKey(input))
}

/** 删除 Key 库记录 */
export function removeVaultKey(id: string): Promise<RpcResult<{ ok: boolean }>> {
  return rpc((a) => a.removeVaultKey(id))
}

// ---------- 自定义背景 ----------

export function listBackgrounds(): Promise<RpcResult<{ files: { name: string; size: number; builtin: boolean }[] }>> {
  return rpc((a) => a.listBackgrounds())
}

export function importBackground(): Promise<RpcResult<{ ok: boolean; name?: string; error?: string }>> {
  return rpc((a) => a.importBackground())
}

export function removeBackground(name: string): Promise<RpcResult<{ ok: boolean }>> {
  return rpc((a) => a.removeBackground(name))
}

export function backgroundData(name: string): Promise<RpcResult<{ ok: boolean; dataUrl?: string; error?: string }>> {
  return rpc((a) => a.backgroundData(name))
}

/** 主题对应的内置默认背景 */
export function backgroundForTheme(theme: string): Promise<RpcResult<{ name: string | null }>> {
  return rpc((a) => a.backgroundForTheme(theme))
}

// ---------- 系统 / 窗口 ----------

/** 开机自启的真实状态（主进程回读系统启动项，不是配置里的期望值） */
export function getAutoStartStatus(): Promise<RpcResult<AutoStartStatus>> {
  return rpc((a) => a.getAutoStartStatus())
}

/** 自绘标题栏：最小化 */
export function windowMinimize(): Promise<RpcResult<void>> {
  return rpc((a) => a.windowMinimize())
}

export function windowToggleMaximize(): Promise<RpcResult<{ maximized: boolean }>> {
  return rpc((a) => a.windowToggleMaximize())
}

/** 自绘标题栏：关闭（隐藏到托盘） */
export function windowClose(): Promise<RpcResult<void>> {
  return rpc((a) => a.windowClose())
}

export function getWindowState(): Promise<RpcResult<{ maximized: boolean }>> {
  return rpc((a) => a.getWindowState())
}

/** 订阅窗口最大化状态变化（无桥时返回空函数） */
export function subscribeWindowState(callback: (state: { maximized: boolean }) => void): () => void {
  return subscribe((a, cb) => a.onWindowState(cb), callback)
}

export type { AppInfo, AccountView, BalanceRow, PanelPayload, Settings, AccountInput }
