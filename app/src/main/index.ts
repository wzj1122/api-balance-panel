import { app } from 'electron'
import { applyAutoStart, refreshAutoStart } from './autostart'
import { isSecure } from './crypto'
import { registerIpc } from './ipc'
import { logger } from './logger'
import { DATA_DIR, ensureDirs } from './paths'
import { scheduler } from './scheduler'
import { store } from './store'
import { runDueMonitors } from './monitor'
import { refresh, keepAliveSessions, startKeepAlive, stopKeepAlive } from './query'
import { createTray, destroyTray, updateTray } from './tray'
import { createWindow, isAutoStartLaunch, setQuitting, showMainWindow } from './window'

/**
 * 应用入口（主进程）。
 *
 * 铁律：所有联网请求只在主进程发起；渲染进程永远拿不到密钥明文，也永不直接发 HTTP 请求。
 */

// 单实例：只允许一个面板在跑，第二个实例直接退出并聚焦已有窗口
const gotSingleLock = app.requestSingleInstanceLock()
if (!gotSingleLock) {
  logger.warn('[app] 已有实例在运行，本次启动退出')
  app.quit()
} else {
  app.on('second-instance', () => {
    // 点快捷方式/托盘/其他方式再次启动：不新开实例，把已有主窗口唤到前台
    // （showMainWindow 会处理 restore + show + focus，覆盖「最小化」和「隐藏到托盘」两种状态）
    showMainWindow()
  })

  // Windows 下系统通知需要显式 AppUserModelId
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.api-balance-panel.app')
  }

  /** 接口监控定时器 */
let monitorTimer: NodeJS.Timeout | null = null

// 崩溃与未捕获异常：全部落到日志里，便于事后排查
process.on('uncaughtException', (err) => {
  logger.error('[crash] 主进程未捕获异常：' + (err?.stack || err?.message || String(err)))
})
process.on('unhandledRejection', (reason) => {
  logger.error('[crash] 未处理的 Promise 拒绝：' + String(reason))
})

void app.whenReady().then(() => {
    ensureDirs()
    logger.info(`[app] 启动，数据目录：${DATA_DIR}`)

    // 加载配置（内部含损坏恢复：recovered / reset 会体现在 store.getConfigStatus()）
    store.load()
    const status = store.getConfigStatus()
    if (status !== 'ok') {
      logger.warn(`[app] 配置状态：${status === 'recovered' ? '已从上一次备份恢复' : '已重置为默认配置'}`)
    }
    if (!isSecure()) {
      logger.warn('[app] 当前系统不支持加密存储，密钥以弱保护方式保存在本机（界面会显示黄色横幅）')
    }

    const win = createWindow()

    // 渲染进程崩溃 / 无响应也记一笔
    win.webContents.on('render-process-gone', (_e, details) => {
      logger.error('[crash] 界面进程异常退出：' + details.reason + '（exitCode=' + details.exitCode + '）')
    })
    win.on('unresponsive', () => logger.warn('[window] 主窗口无响应'))

    // 创托盘（点击退出时由它触发 setQuitting(true) + app.quit）
    createTray(() => {
      setQuitting(true)
      app.quit()
    })

    // 接口监控：每分钟检查一次是否有目标到期（真实调用用户填写的接口）
    monitorTimer = setInterval(() => {
      void runDueMonitors().catch((e: unknown) => logger.warn('[monitor] 定时检查失败：' + (e as Error).message))
    }, 60 * 1000)


    // 校准开机自启：配置里开着、但系统启动项被清理过（换机 / 被优化软件删掉）会自动补写
    refreshAutoStart(store.getSettings().launch_at_login)

    // T03：注册全部业务 IPC 通道 + 启动定时刷新
    registerIpc()
    scheduler.start(store.getSettings().refresh_seconds)

    // 窗口隐藏/最小化时暂停刷新，回到前台立刻补刷（受 pause_when_hidden 控制）
    // 例外：开机自启是「后台常驻」启动，窗口自始至终没显示过，必须照常刷新，否则开机后余额永远不更新
    const silentLaunch = isAutoStartLaunch()
    const pauseIfSet = (): void => {
      if (!silentLaunch && store.getSettings().pause_when_hidden) {
        scheduler.pause()
        updateTray(undefined, true)
      }
    }
    const resumeIfSet = (): void => {
      if (store.getSettings().pause_when_hidden) {
        void scheduler.resume()
        updateTray(undefined, false)
      }
    }
    win.on('hide', pauseIfSet)
    win.on('show', resumeIfSet)
    win.on('minimize', pauseIfSet)
    win.on('restore', resumeIfSet)
    // 托盘提示同步真实的暂停状态（开机自启常驻时不应显示「已暂停刷新」）
    updateTray(undefined, scheduler.isPaused())

    // 会话保活：登录型平台（商汤 / 小米 MiMo）的 token 只有几小时，
    // 这里每 5 分钟检查一次、临期就用会话静默换新，窗口隐藏/最小化时同样运行。
    // （2026-09-22 从 20 分钟缩到 5 分钟：商汤的会话是"绝对到期、无法续期"的，
    //   必须能在到期前 15 分钟那一刻准点提醒，否则用户会在毫无预告的情况下失联。）
    setTimeout(() => {
      void keepAliveSessions().catch((e: unknown) => logger.warn('[keepalive] 首轮保活失败：' + (e as Error).message))
    }, 20 * 1000)
    startKeepAlive()
  })

  app.on('window-all-closed', () => {
    // 关窗只隐藏到托盘，退出走托盘菜单；这里保留空 listener 防止平台默认退出
  })

  app.on('before-quit', () => {
    setQuitting(true)
    scheduler.stop()
    stopKeepAlive()
    if (monitorTimer) clearInterval(monitorTimer)
    destroyTray()
    logger.info('[app] 退出')
  })
}
