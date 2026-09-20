import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { PanelApi, RefreshPayload, AutoStartStatus } from '../shared/ipc'
import type {
  AccountInput,
  AccountView,
  AppInfo,
  BalanceRow,
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
} from '../shared/types'

/**
 * 预加载脚本：渲染进程与主进程之间唯一的桥。
 *
 * 安全约定：
 * 1. 只暴露方法，不暴露 ipcRenderer 本体、不暴露任何 Node 模块；
 * 2. 不把回调函数直接跨进程传递，统一用 ipcRenderer.on 包一层；
 * 3. 出参里永远不会出现密钥明文（AccountView 类型层面已删掉 secret_enc）。
 *
 * 说明：下面每个方法都是对 ipcMain.handle 的一层薄封装，
 * 通道处理函数在 T03（src/main/ipc.ts）注册，注册前调用会 reject。
 */

const api: PanelApi = {
  getAppInfo(): Promise<AppInfo> {
    return ipcRenderer.invoke(IPC.APP_INFO)
  },

  listAccounts(): Promise<AccountView[]> {
    return ipcRenderer.invoke(IPC.ACCOUNT_LIST)
  },

  saveAccount(input: AccountInput): Promise<AccountView> {
    return ipcRenderer.invoke(IPC.ACCOUNT_SAVE, input)
  },

  removeAccount(id: string): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(IPC.ACCOUNT_REMOVE, { id })
  },

  refreshBalances(payload?: RefreshPayload): Promise<PanelPayload> {
    return ipcRenderer.invoke(IPC.BALANCE_REFRESH, payload ?? {})
  },

  getSettings(): Promise<Settings> {
    return ipcRenderer.invoke(IPC.SETTINGS_GET)
  },

  saveSettings(patch: Partial<Settings>): Promise<Settings> {
    return ipcRenderer.invoke(IPC.SETTINGS_SAVE, patch)
  },

  openDataDir(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(IPC.APP_OPEN_DATA_DIR)
  },

  loginSite(payload: { url: string; name: string; platform?: string; extraUrls?: string[]; accountId?: string }): Promise<{ ok: boolean; cookie?: string; error?: string; canRenew?: boolean }> {
    return ipcRenderer.invoke(IPC.ACCOUNT_LOGIN, payload)
  },

  /** 静默续期登录（用保存的会话换新凭据） */
  renewAccount(id: string): Promise<{ ok: boolean; error: string; needLogin: boolean; expiresAt: number | null }> {
    return ipcRenderer.invoke(IPC.ACCOUNT_RENEW, { id })
  },

  getFx(): Promise<FxInfo> {
    return ipcRenderer.invoke(IPC.FX_GET)
  },

  listSnapshots(accountId: string): Promise<Snapshot[]> {
    return ipcRenderer.invoke(IPC.SNAPSHOT_LIST, { id: accountId })
  },

  listDailyUsage(payload?: { days?: number }): Promise<DailyUsageReport> {
    return ipcRenderer.invoke(IPC.SNAPSHOT_DAILY, payload ?? {})
  },

  listPlatformUsage(payload?: { days?: number }): Promise<PlatformUsageReport> {
    return ipcRenderer.invoke(IPC.SNAPSHOT_PLATFORM, payload ?? {})
  },

  getUsageReport(payload?: { period?: ReportPeriod }): Promise<UsageReport> {
    return ipcRenderer.invoke(IPC.REPORT_USAGE, payload ?? {})
  },

  setDemoMode(on: boolean): Promise<{ ok: boolean; demo: boolean }> {
    return ipcRenderer.invoke(IPC.DEMO_TOGGLE, { on })
  },

  exportBackup(payload?: { includeHistory?: boolean }): Promise<{ ok: boolean; path?: string; error?: string }> {
    return ipcRenderer.invoke(IPC.BACKUP_EXPORT, payload ?? {})
  },

  importBackup(): Promise<{ ok: boolean; message: string }> {
    return ipcRenderer.invoke(IPC.BACKUP_IMPORT)
  },

  listMonitors(payload?: { days?: number }): Promise<MonitorReport> {
    return ipcRenderer.invoke(IPC.MONITOR_LIST, payload ?? {})
  },

  saveMonitor(input: MonitorInput): Promise<MonitorView> {
    return ipcRenderer.invoke(IPC.MONITOR_SAVE, input)
  },

  removeMonitor(id: string): Promise<boolean> {
    return ipcRenderer.invoke(IPC.MONITOR_REMOVE, id)
  },

  runMonitors(payload?: { id?: string }): Promise<MonitorCheck[]> {
    return ipcRenderer.invoke(IPC.MONITOR_RUN, payload ?? {})
  },

  testMonitor(input: MonitorInput): Promise<MonitorCheck> {
    return ipcRenderer.invoke(IPC.MONITOR_TEST, input)
  },

  listMonitorChecks(payload: { id: string; limit?: number }): Promise<MonitorCheck[]> {
    return ipcRenderer.invoke(IPC.MONITOR_HISTORY, payload)
  },

  windowMinimize(): Promise<void> {
    return ipcRenderer.invoke(IPC.WINDOW_MINIMIZE)
  },

  windowToggleMaximize(): Promise<{ maximized: boolean }> {
    return ipcRenderer.invoke(IPC.WINDOW_TOGGLE_MAX)
  },

  windowClose(): Promise<void> {
    return ipcRenderer.invoke(IPC.WINDOW_CLOSE)
  },

  getWindowState(): Promise<{ maximized: boolean }> {
    return ipcRenderer.invoke(IPC.WINDOW_GET_STATE)
  },

  listKeys(): Promise<KeyListReport> {
    return ipcRenderer.invoke(IPC.KEY_LIST)
  },

  bulkKeys(payload: { ids: string[]; action: KeyBulkAction; tags?: string[] }): Promise<{ affected: number }> {
    return ipcRenderer.invoke(IPC.KEY_BULK, payload)
  },

  revealKey(payload: { id: string; source?: 'account' | 'vault' }): Promise<string> {
    return ipcRenderer.invoke(IPC.KEY_SECRET, payload)
  },

  saveVaultKey(input: KeyVaultInput): Promise<{ ok: boolean; id: string }> {
    return ipcRenderer.invoke(IPC.KEY_VAULT_SAVE, input)
  },

  removeVaultKey(id: string): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(IPC.KEY_VAULT_REMOVE, id)
  },

  readLogs(payload?: { limit?: number; level?: LogLevel; keyword?: string }): Promise<{ entries: { ts: number; level: LogLevel; text: string }[]; level: LogLevel; files: { name: string; size: number; mtime: number }[] }> {
    return ipcRenderer.invoke(IPC.LOG_LIST, payload ?? {})
  },

  clearLogs(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(IPC.LOG_CLEAR)
  },

  exportLogs(): Promise<{ ok: boolean; path?: string; error?: string }> {
    return ipcRenderer.invoke(IPC.LOG_EXPORT)
  },

  openLogDir(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(IPC.LOG_OPEN_DIR)
  },

  setLogLevel(level: LogLevel): Promise<{ level: LogLevel }> {
    return ipcRenderer.invoke(IPC.LOG_SET_LEVEL, { level })
  },

  listBackgrounds(): Promise<{ files: { name: string; size: number }[] }> {
    return ipcRenderer.invoke(IPC.BG_LIST)
  },

  importBackground(): Promise<{ ok: boolean; name?: string; error?: string }> {
    return ipcRenderer.invoke(IPC.BG_IMPORT)
  },

  removeBackground(name: string): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(IPC.BG_REMOVE, name)
  },

  backgroundData(name: string): Promise<{ ok: boolean; dataUrl?: string; error?: string }> {
    return ipcRenderer.invoke(IPC.BG_DATA, name)
  },

  backgroundForTheme(theme: string): Promise<{ name: string | null }> {
    return ipcRenderer.invoke(IPC.BG_FOR_THEME, theme)
  },

  /** 开机自启的真实状态（主进程回读系统启动项） */
  getAutoStartStatus(): Promise<AutoStartStatus> {
    return ipcRenderer.invoke(IPC.APP_AUTOSTART_STATUS)
  },

  onWindowState(callback: (state: { maximized: boolean }) => void): () => void {
    const handler = (_e: Electron.IpcRendererEvent, state: { maximized: boolean }): void => callback(state)
    ipcRenderer.on(IPC.WINDOW_STATE, handler)
    return () => {
      ipcRenderer.removeListener(IPC.WINDOW_STATE, handler)
    }
  },

  /** 订阅单条结果；返回取消订阅函数，避免重复绑定 */
  onBalanceRow(callback: (row: BalanceRow) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, row: BalanceRow): void => callback(row)
    ipcRenderer.on(IPC.BALANCE_ROW, listener)
    return () => {
      ipcRenderer.removeListener(IPC.BALANCE_ROW, listener)
    }
  },

  /** 订阅整批结果；返回取消订阅函数 */
  onBalanceUpdated(callback: (payload: PanelPayload) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: PanelPayload): void => callback(payload)
    ipcRenderer.on(IPC.BALANCE_UPDATED, listener)
    return () => {
      ipcRenderer.removeListener(IPC.BALANCE_UPDATED, listener)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('[preload] contextBridge 暴露失败：', error)
  }
} else {
  // 理论上不会走到（window.ts 强制 contextIsolation: true），留个兜底方便排查
  ;(globalThis as unknown as { api: PanelApi }).api = api
}
