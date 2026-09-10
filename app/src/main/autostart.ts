import { app } from 'electron'
import { logger } from './logger'

/**
 * 开机自启封装。
 *
 * 只在打包（app.isPackaged）后真正写入系统登录项 / 注册表 Run 键；开发模式直接跳过，
 * 避免把开发用的 electron.exe 注册进系统开机启动项，污染用户环境。
 * 失败只 warn 不抛出：设置项已经落盘成功，自启注册失败不能反过来让 IPC 报错。
 */
export function applyAutoStart(enabled: boolean): void {
  if (!app.isPackaged) {
    logger.info(`[autostart] 开发模式跳过开机自启（目标 ${enabled ? '开' : '关'}）`)
    return
  }
  try {
    app.setLoginItemSettings({ openAtLogin: enabled })
    logger.info(`[autostart] 已${enabled ? '开启' : '关闭'}开机自启`)
  } catch (e) {
    logger.warn(`[autostart] 设置开机自启失败：${(e as Error).message}`)
  }
}
