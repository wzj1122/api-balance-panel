import { app, ipcMain, Notification, shell } from 'electron'
import { MIMO_BALANCE_URL } from '../shared/constants'
import { IPC } from '../shared/ipc'
import type { RefreshPayload } from '../shared/ipc'
import type { AccountInput, AppInfo, MonitorInput, ReportPeriod, Settings, LogLevel, KeyVaultInput } from '../shared/types'
import { applyAutoStart, getAutoStartStatus } from './autostart'
import { backgroundData, backgroundForTheme, importBackground, listBackgrounds, removeBackground } from './bgstore'
import { exportBackup, importBackup } from './backup'
import { buildMonitorReport, listChecks, removeMonitor, removeMonitorsBySecret, runMonitors, saveMonitor, testMonitor } from './monitor'
import { cookieHas, loginToSite, validateByUrl, validateMinimaxCookie, type LoginOptions } from './browser'
import { isSecure } from './crypto'
import { removeVaultKey, revealVaultKey, saveVaultKey } from './keyvault'
import { buildKeyList } from './keys'
import { isDemo, setDemo } from './demo'
import { getFx } from './fx'
import { clearLogs, exportLogs, getLogLevel, listLogFiles, logger, readLogs, setLogLevel } from './logger'
import { CONFIG_FILE, DATA_DIR, LOG_DIR } from './paths'
import { invalidateCache, refresh } from './query'
import { closeWindow, isWindowMaximized, minimizeWindow, toggleMaximizeWindow } from './window'
import { scheduler } from './scheduler'
import { buildDailyUsage, buildPlatformUsage, buildUsageReport } from './usage'
import { listByAccount, removeByAccount } from './snapshot'
import { store, toView } from './store'

/**
 * 主进程 IPC 注册（T03）。
 * 每个通道都套一层 try/catch：任何未预期异常都转成带中文信息的错误抛回给
 * 渲染进程（safeInvoke 会显示出来），而不是让主进程静默吞掉或崩溃。
 */

/** 把 handler 的异常统一转成可读的 Error（renderer 的 safeInvoke 会展示 message） */
function wrap<T>(name: string, fn: (payload: unknown) => T | Promise<T>): void {
  ipcMain.handle(name, async (_event, payload) => {
    try {
      return await fn(payload)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logger.error(`[ipc] ${name} 处理失败：`, msg)
      throw new Error(msg)
    }
  })
}

/** 校验入参是普通对象，不是就抛（防止手误传 null/undefined） */
function asRecord(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>
  }
  return {}
}

/**
 * 账号被删除后的收尾：清掉它的历史快照与关联的监控目标。
 * 否则可用性监控 / 每日统计会继续用旧快照显示这个已经不存在的账号。
 */
async function cleanupAccountArtifacts(accountId: string, secret: string): Promise<void> {
  try {
    await removeByAccount(accountId)
  } catch (e) {
    logger.warn('[cleanup] 清理快照失败：' + (e as Error).message)
  }
  if (secret) {
    try {
      removeMonitorsBySecret(secret)
    } catch (e) {
      logger.warn('[cleanup] 清理监控目标失败：' + (e as Error).message)
    }
  }
}

export function registerIpc(): void {
  // 启动信息（版本 / 数据目录 / 加密可用性 / 配置状态 / 通知是否可用）
  wrap(IPC.APP_INFO, (): AppInfo => {
    return {
      version: app.getVersion(),
      dataDir: DATA_DIR,
      configPath: CONFIG_FILE,
      secure: isSecure(),
      configStatus: store.getConfigStatus(),
      noticeSupported: Notification.isSupported()
    }
  })

  // 账号列表（不含密文）
  wrap(IPC.ACCOUNT_LIST, () => store.listAccounts().map(toView))

  // 新增 / 编辑账号
  wrap(IPC.ACCOUNT_SAVE, (payload) => {
    const input = asRecord(payload) as unknown as AccountInput
    if (!input || !input.name || !input.type) {
      throw new Error('账号名称和平台类型是必填项')
    }
    const account = store.saveAccount(input)
    // 账号变了，缓存里可能残留旧结果，清掉
    invalidateCache(account.id)
    return toView(account)
  })

  // 删除账号
  wrap(IPC.ACCOUNT_REMOVE, async (payload) => {
    // 兼容两种传参：preload 传 { id }，旧调用传裸字符串
    const id = typeof payload === 'string' ? payload : String((asRecord(payload) as { id?: string }).id ?? '')
    const secret = store.revealSecret(id)
    const ok = store.removeAccount(id)
    if (ok) await cleanupAccountArtifacts(id, secret)
    return ok
  })

  // 刷新余额（ids 为空 = 全部启用账号）
  wrap(IPC.BALANCE_REFRESH, (payload) => {
    const p = asRecord(payload) as unknown as RefreshPayload
    return refresh(p)
  })

  // 读设置
  wrap(IPC.SETTINGS_GET, () => store.getSettings())

  // 开机自启的真实状态（回读系统启动项，界面据此显示，而不是照抄配置）
  wrap(IPC.APP_AUTOSTART_STATUS, () => getAutoStartStatus())

  // 局部更新设置；刷新间隔变了就热重启定时器
  wrap(IPC.SETTINGS_SAVE, (payload) => {
    const patch = asRecord(payload) as unknown as Partial<Settings>
    const before = store.getSettings()
    const after = store.saveSettings(patch)
    if (after.refresh_seconds !== before.refresh_seconds) {
      scheduler.reset(after.refresh_seconds)
    }
    if (after.launch_at_login !== before.launch_at_login) {
      // 写系统启动项并把真实结果记进日志；界面随后会用 APP_AUTOSTART_STATUS 回读显示
      const st = applyAutoStart(after.launch_at_login)
      if (after.launch_at_login && !st.registered && st.packaged) {
        logger.warn('[autostart] 已开启但系统启动项未写入成功，请查看界面提示')
      }
    }
    return after
  })

  // 打开配置所在目录
  wrap(IPC.APP_OPEN_DATA_DIR, async () => {
    const err = await shell.openPath(DATA_DIR)
    return { ok: !err }
  })

  // 打开内置浏览器登录站点，返回抓到的 Cookie（mimo 等需登录的平台）
  wrap(IPC.ACCOUNT_LOGIN, async (payload) => {
    const p = asRecord(payload) as unknown as { url?: string; name?: string; platform?: string; extraUrls?: string[] }
    if (typeof p.url !== 'string' || !p.url) throw new Error('缺少登录地址')
    // 各平台的「自动关闭」规则：进入控制台 URL 后校验会话，通过即自动关窗
    const rules: Partial<
      Record<
        string,
        {
          success?: LoginOptions['success']
          extra?: string[]
          validate?: (c: string) => Promise<string | null>
        }
      >
    > = {
      mimo: {
        // 登录页在 account.xiaomi.com（小米账号中心），但余额接口需要 platform 域的登录态，
        // 所以必须把这些域名的 Cookie 一并抓下来，否则校验永远 401。
        extra: ['https://platform.xiaomimimo.com', 'https://xiaomimimo.com'],
        validate: validateByUrl(MIMO_BALANCE_URL)
      },
      'mimo-plan': {
        extra: ['https://platform.xiaomimimo.com', 'https://xiaomimimo.com'],
        validate: validateByUrl(MIMO_BALANCE_URL)
      },
      minimax: {
        success: { hosts: ['platform.minimaxi.com', 'platform.minimax.cn'], pathPrefix: '/console/' },
        extra: [
          'https://www.minimaxi.com',
          'https://www.minimax.cn',
          'https://platform.minimaxi.com',
          'https://platform.minimax.cn'
        ],
        validate: validateMinimaxCookie
      },
      zhipu: {
        success: { hosts: ['bigmodel.cn'], pathPrefix: '/console/' },
        validate: cookieHas('bigmodel_token_production')
      }
    }
    const rule = p.platform ? rules[p.platform] : undefined
    const extraUrls = Array.from(
      new Set([
        ...(Array.isArray(p.extraUrls) ? p.extraUrls.filter((x): x is string => typeof x === 'string') : []),
        ...(rule?.extra ?? [])
      ])
    )
    return loginToSite({
      url: p.url,
      name: typeof p.name === 'string' && p.name ? p.name : '站点',
      extraUrls,
      success: rule?.success,
      validate: rule?.validate
    })
  })

  // 每日使用状况统计（主进程按快照聚合，返回报告）
  wrap(IPC.SNAPSHOT_DAILY, async (payload) => {
    const p = asRecord(payload) as { days?: number }
    const days = typeof p.days === 'number' && Number.isFinite(p.days) ? Math.round(p.days) : 30
    return buildDailyUsage(days)
  })
  // 平台用量统计（按平台类型 × 单位聚合）
  wrap(IPC.SNAPSHOT_PLATFORM, async (payload) => {
    const p = asRecord(payload) as { days?: number }
    const days = typeof p.days === 'number' && Number.isFinite(p.days) ? Math.round(p.days) : 30
    return buildPlatformUsage(days)
  })

  // AI 使用报告（只基于金额消耗）
  wrap(IPC.REPORT_USAGE, async (payload) => {
    const p = asRecord(payload) as { period?: ReportPeriod }
    const period: ReportPeriod = p.period === 'week' || p.period === 'month' ? p.period : 'day'
    return buildUsageReport(period)
  })


  // 演示模式开关（内存沙箱）
  wrap(IPC.DEMO_TOGGLE, async (payload) => {
    const p = asRecord(payload) as { on?: boolean }
    setDemo(p.on === true)
    return { ok: true, demo: isDemo() }
  })

  // 配置备份 / 恢复
  wrap(IPC.BACKUP_EXPORT, async (payload) => {
    const p = asRecord(payload) as { includeHistory?: boolean }
    return exportBackup(p.includeHistory !== false)
  })

  wrap(IPC.BACKUP_IMPORT, async () => importBackup())

  // 接口监控（用户自填 Key + 地址，定期真实调用）
  wrap(IPC.MONITOR_LIST, async (payload) => {
    const p = asRecord(payload) as { days?: number }
    const days = typeof p.days === 'number' && Number.isFinite(p.days) ? Math.round(p.days) : 30
    return buildMonitorReport(days)
  })

  wrap(IPC.MONITOR_SAVE, async (payload) => saveMonitor(asRecord(payload) as unknown as MonitorInput))

  wrap(IPC.MONITOR_REMOVE, async (payload) => removeMonitor(String(payload ?? '')))

  wrap(IPC.MONITOR_RUN, async (payload) => {
    const p = asRecord(payload) as { id?: string }
    return runMonitors(typeof p.id === 'string' && p.id.length > 0 ? p.id : undefined)
  })

  wrap(IPC.MONITOR_TEST, async (payload) => testMonitor(asRecord(payload) as unknown as MonitorInput))

  // Key 管理（汇总 + 审计 + 批量 + 明文复制）
  wrap(IPC.KEY_LIST, async () => buildKeyList()),

  wrap(IPC.KEY_BULK, async (payload) => {
    const p = asRecord(payload) as { ids?: unknown; action?: unknown; tags?: unknown }
    const ids = Array.isArray(p.ids) ? p.ids.map((x) => String(x)) : []
    const action = String(p.action ?? '')
    let affected = 0
    if (action === 'purge') {
      for (const id of ids) {
        const secret = store.revealSecret(id)
        if (store.purgeAccount(id)) {
          affected += 1
          await cleanupAccountArtifacts(id, secret)
        }
      }
    } else if (action === 'delete') {
      // 移入回收站：账号不再查询，监控目标一并停掉（避免继续消耗）
      for (const id of ids) {
        const secret = store.revealSecret(id)
        if (store.softDelete(id)) {
          affected += 1
          if (secret) {
            try { removeMonitorsBySecret(secret) } catch { /* 忽略 */ }
          }
        }
      }
    } else if (action === 'restore') {
      for (const id of ids) if (store.restoreAccount(id)) affected += 1
    } else if (action === 'enable' || action === 'disable') {
      affected = store.bulkPatch(ids, { enabled: action === 'enable' })
    } else if (action === 'tag') {
      const tags = Array.isArray(p.tags) ? p.tags.map((x) => String(x)) : []
      affected = store.bulkPatch(ids, { tags })
    } else {
      throw new Error('未知的批量操作：' + action)
    }
    invalidateCache()
    return { affected }
  }),

  wrap(IPC.KEY_SECRET, async (payload) => {
    // 兼容旧调用（直接传 id 字符串 = 账号），新调用传 { id, source }
    if (typeof payload === 'string') return store.revealSecret(payload)
    const p = asRecord(payload) as { id?: string; source?: string }
    const id = String(p.id ?? '')
    return p.source === 'vault' ? revealVaultKey(id) : store.revealSecret(id)
  }),

  wrap(IPC.KEY_VAULT_SAVE, async (payload) => {
    const input = asRecord(payload) as unknown as KeyVaultInput
    const saved = saveVaultKey(input)
    return { ok: true, id: saved.id }
  }),

  wrap(IPC.KEY_VAULT_REMOVE, async (payload) => ({ ok: removeVaultKey(String(payload ?? '')) })),

  // 运行日志
  wrap(IPC.LOG_LIST, async (payload) => {
    const p = asRecord(payload) as { limit?: number; level?: LogLevel; keyword?: string }
    return {
      entries: readLogs({ limit: p.limit, level: p.level, keyword: p.keyword }),
      level: getLogLevel(),
      files: listLogFiles()
    }
  }),

  wrap(IPC.LOG_CLEAR, async () => {
    clearLogs()
    logger.info('[log] 日志已清空')
    return { ok: true }
  }),

  wrap(IPC.LOG_EXPORT, async () => exportLogs()),

  wrap(IPC.LOG_OPEN_DIR, async () => {
    const r = await shell.openPath(LOG_DIR)
    return { ok: r === '' }
  }),

  wrap(IPC.LOG_SET_LEVEL, async (payload) => {
    const p = asRecord(payload) as { level?: LogLevel }
    const level: LogLevel = p.level === 'debug' || p.level === 'warn' || p.level === 'error' ? p.level : 'info'
    setLogLevel(level)
    return { level }
  }),

  // 自定义背景图
  wrap(IPC.BG_LIST, async () => ({ files: listBackgrounds() })),

  wrap(IPC.BG_IMPORT, async () => importBackground()),

  wrap(IPC.BG_REMOVE, async (payload) => ({ ok: removeBackground(String(payload ?? '')) })),

  wrap(IPC.BG_DATA, async (payload) => backgroundData(String(payload ?? ''))),

  wrap(IPC.BG_FOR_THEME, async (payload) => ({ name: backgroundForTheme(String(payload ?? '')) })),

  // 自绘标题栏的窗口控制
  wrap(IPC.WINDOW_MINIMIZE, async () => {
    minimizeWindow()
  }),

  wrap(IPC.WINDOW_TOGGLE_MAX, async () => ({ maximized: toggleMaximizeWindow() })),

  wrap(IPC.WINDOW_CLOSE, async () => {
    closeWindow()
  }),

  wrap(IPC.WINDOW_GET_STATE, async () => ({ maximized: isWindowMaximized() })),

  wrap(IPC.MONITOR_HISTORY, async (payload) => {
    const p = asRecord(payload) as { id?: string; limit?: number }
    const limit = typeof p.limit === 'number' && Number.isFinite(p.limit) ? Math.round(p.limit) : 200
    return listChecks(String(p.id ?? ''), limit)
  })

  // 实时汇率（成本折算用；主进程内部含 1 小时缓存与兜底，不抛错）
  wrap(IPC.FX_GET, () => getFx())

  // 某账号的余额快照（趋势图用）
  wrap(IPC.SNAPSHOT_LIST, (payload) => {
    const id = asRecord(payload).id
    if (typeof id !== 'string' || !id) throw new Error('缺少账号 id')
    return listByAccount(id)
  })

  logger.info('[ipc] 全部业务 IPC 通道已注册')
}
