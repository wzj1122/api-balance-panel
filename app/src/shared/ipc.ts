import type {
  AccountInput,
  AccountView,
  AppInfo,
  BalanceRow,
  KeyBulkAction,
  KeyListReport,
  KeyVaultInput,
  LogLevel,
  MonitorCheck,
  MonitorInput,
  MonitorReport,
  MonitorView,
  DailyUsageReport,
  PlatformUsageReport,
  ReportPeriod,
  UsageReport,
  FxInfo,
  PanelPayload,
  Settings,
  Snapshot
} from './types'

/**
 * 全部 IPC 通道名常量（命名规则：域:动作）。
 * 主进程与渲染进程共用，改这里两边一起变，不会漏改。
 */
export const IPC = {
  /** invoke：取启动信息（版本 / 数据目录 / 加密可用性 / 配置状态） */
  APP_INFO: 'app:info',
  /** invoke：账号列表（不含密文） */
  ACCOUNT_LIST: 'account:list',
  /** invoke：新增或编辑账号 */
  ACCOUNT_SAVE: 'account:save',
  /** invoke：删除账号 */
  ACCOUNT_REMOVE: 'account:remove',
  /** invoke：刷新余额，ids 为空 = 全部启用账号 */
  BALANCE_REFRESH: 'balance:refresh',
  /** main → renderer 推送：单账号完成即推 */
  BALANCE_ROW: 'balance:row',
  /** main → renderer 推送：整批完成 */
  BALANCE_UPDATED: 'balance:updated',
  /** invoke：读设置 */
  SETTINGS_GET: 'settings:get',
  /** invoke：局部更新设置 */
  SETTINGS_SAVE: 'settings:save',
  /** invoke：打开配置所在目录 */
  APP_OPEN_DATA_DIR: 'app:openDataDir',
  /** invoke：打开内置浏览器登录某站点，返回抓到的 Cookie 字符串 */
  ACCOUNT_LOGIN: 'account:login',
  /** invoke：取实时汇率（成本折算用，只发货币代码，不带账号信息） */
  FX_GET: 'fx:get',
  /** invoke：取某账号的余额快照（趋势图用） */
  SNAPSHOT_LIST: 'snapshot:list',
  /** invoke：每日使用状况统计（主进程按快照聚合） */
  SNAPSHOT_DAILY: 'snapshot:daily',
  /** invoke：平台用量统计（按平台类型 × 单位聚合） */
  SNAPSHOT_PLATFORM: 'snapshot:platform',
  /** invoke：AI 使用报告（只基于金额） */
  REPORT_USAGE: 'report:usage',
  /** invoke：切换演示模式 */
  DEMO_TOGGLE: 'demo:toggle',
  /** invoke：导出 / 导入配置备份 */
  BACKUP_EXPORT: 'backup:export',
  BACKUP_IMPORT: 'backup:import',
  /** invoke：接口监控（用户自填 Key + 地址的正式可用性监控） */
  MONITOR_LIST: 'monitor:list',
  MONITOR_SAVE: 'monitor:save',
  MONITOR_REMOVE: 'monitor:remove',
  MONITOR_RUN: 'monitor:run',
  MONITOR_TEST: 'monitor:test',
  MONITOR_HISTORY: 'monitor:history',
  /** 自绘标题栏的窗口控制 */
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_TOGGLE_MAX: 'window:toggle-max',
  WINDOW_CLOSE: 'window:close',
  WINDOW_GET_STATE: 'window:get-state',
  /** 主进程 → 渲染进程：窗口最大化状态变化 */
  WINDOW_STATE: 'window:state',
  /** Key 管理：汇总列表 + 审计 */
  KEY_LIST: 'key:list',
  /** Key 管理：批量操作（启用/停用/删除/恢复/彻底删除/打标签） */
  KEY_BULK: 'key:bulk',
  /** Key 管理：取密钥明文（仅本地复制用） */
  KEY_SECRET: 'key:secret',
  /** Key 库（独立记录）：保存 / 删除 */
  KEY_VAULT_SAVE: 'key:vault-save',
  KEY_VAULT_REMOVE: 'key:vault-remove',
  /** 运行日志：读取 / 清空 / 导出 / 打开目录 / 切换级别 */
  LOG_LIST: 'log:list',
  LOG_CLEAR: 'log:clear',
  LOG_EXPORT: 'log:export',
  LOG_OPEN_DIR: 'log:open-dir',
  LOG_SET_LEVEL: 'log:set-level',
  /** 自定义背景图：列表 / 导入 / 删除 / 取数据 */
  BG_LIST: 'bg:list',
  BG_IMPORT: 'bg:import',
  BG_REMOVE: 'bg:remove',
  BG_DATA: 'bg:data',
  /** 主题对应的内置默认背景 */
  BG_FOR_THEME: 'bg:for-theme'
} as const

/** 刷新余额的入参 */
export interface RefreshPayload {
  ids?: string[]
  force?: boolean
}

/**
 * preload 通过 contextBridge 暴露给渲染进程的白名单 API。
 * 只暴露方法，不暴露 ipcRenderer 本体，也不暴露任何 Node 模块。
 */
export interface PanelApi {
  getAppInfo(): Promise<AppInfo>
  listAccounts(): Promise<AccountView[]>
  saveAccount(input: AccountInput): Promise<AccountView>
  removeAccount(id: string): Promise<{ ok: boolean }>
  refreshBalances(payload?: RefreshPayload): Promise<PanelPayload>
  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): Promise<Settings>
  openDataDir(): Promise<{ ok: boolean }>
  /** 打开内置浏览器登录站点，返回抓到的 Cookie（用于 mimo 等需登录的平台） */
  loginSite(payload: {
    url: string
    name: string
    /** 平台类型（如 minimax），用于主进程选择抓完后的即时校验 */
    platform?: string
    /** 额外按这些 URL 一起抓 Cookie（接口域与登录域不同的平台，如 MiniMax 的 www.minimaxi.com） */
    extraUrls?: string[]
  }): Promise<{ ok: boolean; cookie?: string; error?: string }>
  /** 取实时汇率（成本折算用） */
  getFx(): Promise<FxInfo>
  /** 取某账号的余额快照（趋势图用） */
  listSnapshots(accountId: string): Promise<Snapshot[]>
  /** 每日使用状况统计（含余额耗尽预估） */
  listDailyUsage(payload?: { days?: number }): Promise<DailyUsageReport>

  /** 平台用量统计 */
  listPlatformUsage(payload?: { days?: number }): Promise<PlatformUsageReport>

  /** AI 使用报告（只基于金额） */
  getUsageReport(payload?: { period?: ReportPeriod }): Promise<UsageReport>

  /** 切换演示模式（内存沙箱，不写任何真实数据） */
  setDemoMode(on: boolean): Promise<{ ok: boolean; demo: boolean }>

  /** 导出配置备份 */
  exportBackup(payload?: { includeHistory?: boolean }): Promise<{ ok: boolean; path?: string; error?: string }>

  /** 导入配置备份 */
  importBackup(): Promise<{ ok: boolean; message: string }>

  /** 接口监控报告（目标 + 统计） */
  listMonitors(payload?: { days?: number }): Promise<MonitorReport>

  /** 新增 / 编辑监控目标 */
  saveMonitor(input: MonitorInput): Promise<MonitorView>

  /** 删除监控目标 */
  removeMonitor(id: string): Promise<boolean>

  /** 立即检查（省略 id = 全部启用目标） */
  runMonitors(payload?: { id?: string }): Promise<MonitorCheck[]>

  /** 用表单配置试跑一次（不保存） */
  testMonitor(input: MonitorInput): Promise<MonitorCheck>

  /** 某个目标的检查历史 */
  listMonitorChecks(payload: { id: string; limit?: number }): Promise<MonitorCheck[]>

  /** 自绘标题栏：最小化 */
  windowMinimize(): Promise<void>

  /** 自绘标题栏：最大化 / 还原（返回切换后的状态） */
  windowToggleMaximize(): Promise<{ maximized: boolean }>

  /** 自绘标题栏：关闭（隐藏到托盘） */
  windowClose(): Promise<void>

  /** 自绘标题栏：当前最大化状态 */
  getWindowState(): Promise<{ maximized: boolean }>

  /** 订阅窗口状态变化；返回取消订阅函数 */
  onWindowState(callback: (state: { maximized: boolean }) => void): () => void

  /** Key 管理汇总列表（含回收站与安全审计） */
  listKeys(): Promise<KeyListReport>

  /** 批量操作：返回受影响数量 */
  bulkKeys(payload: { ids: string[]; action: KeyBulkAction; tags?: string[] }): Promise<{ affected: number }>

  /** 取密钥明文（仅用于本机复制）；source=account 取账号密钥，vault 取 Key 库密钥 */
  revealKey(payload: { id: string; source?: 'account' | 'vault' }): Promise<string>

  /** 保存 Key 库记录（不创建账号） */
  saveVaultKey(input: KeyVaultInput): Promise<{ ok: boolean; id: string }>

  /** 删除 Key 库记录 */
  removeVaultKey(id: string): Promise<{ ok: boolean }>

  /** 读取运行日志（可按级别/关键字过滤） */
  readLogs(payload?: { limit?: number; level?: LogLevel; keyword?: string }): Promise<{ entries: { ts: number; level: LogLevel; text: string }[]; level: LogLevel; files: { name: string; size: number; mtime: number }[] }>

  /** 清空日志（内存 + 当前文件） */
  clearLogs(): Promise<{ ok: boolean }>

  /** 导出日志到文件（内容已脱敏） */
  exportLogs(): Promise<{ ok: boolean; path?: string; error?: string }>

  /** 在文件管理器里打开日志目录 */
  openLogDir(): Promise<{ ok: boolean }>

  /** 临时切换日志级别（debug 可看到请求级细节） */
  setLogLevel(level: LogLevel): Promise<{ level: LogLevel }>

  /** 已导入的背景图列表 */
  listBackgrounds(): Promise<{ files: { name: string; size: number }[] }>

  /** 导入背景图（弹文件选择，复制到数据目录） */
  importBackground(): Promise<{ ok: boolean; name?: string; error?: string }>

  /** 删除背景图 */
  removeBackground(name: string): Promise<{ ok: boolean }>

  /** 取背景图数据（data URL） */
  backgroundData(name: string): Promise<{ ok: boolean; dataUrl?: string; error?: string }>

  /** 某主题对应的内置默认背景文件名（没有则 name 为 null） */
  backgroundForTheme(theme: string): Promise<{ name: string | null }>
  /** 订阅单条结果，返回取消订阅函数 */
  onBalanceRow(callback: (row: BalanceRow) => void): () => void
  /** 订阅整批结果，返回取消订阅函数 */
  onBalanceUpdated(callback: (payload: PanelPayload) => void): () => void
}
