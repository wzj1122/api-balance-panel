import path from 'node:path'
import { BrowserWindow } from 'electron'
import { logger } from './logger'

/**
 * 主窗口。
 *
 * 安全约定（配合 preload）：
 * - nodeIntegration: false —— 渲染进程没有 Node 权限，拿不到 fs / 密钥；
 * - contextIsolation: true —— 渲染进程只能通过 contextBridge 白名单调主进程；
 * - 使用无边框窗口（frame: false）+ 渲染层自绘标题栏，窗口控制通过 window:* IPC 完成。
 * 关窗行为：默认拦截 → 隐藏到托盘；调用 setQuitting(true) 后才真退。
 */

let mainWindow: BrowserWindow | null = null

/** 退出标志：托盘菜单点「退出」时置 true，让 close 事件不再拦截 */
let isQuitting = false

export function setQuitting(value: boolean): void {
  isQuitting = value
}

/**
 * 是否本次启动来自「开机自启」。
 * 由 autostart 写入系统启动项时带上 `--open-at-login`；这种启动不弹窗口，
 * 只常驻托盘后台刷新（用户点托盘或快捷方式再显示主面板）。
 */
export function isAutoStartLaunch(argv: string[] = process.argv): boolean {
  return argv.includes('--open-at-login')
}

export function createWindow(): BrowserWindow {
  // 开机自启：直接后台常驻，不抢用户的开机画面
  const silent = isAutoStartLaunch()
  if (silent) logger.info('[window] 开机自启启动：主窗口保持隐藏，仅常驻托盘')
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    title: 'API 余额面板',
    backgroundColor: '#16181d',
    // 无边框：标题栏由渲染层自绘（含最小化/最大化/关闭）
    frame: false,
    // 保留系统贴边分屏（Aero Snap）与投影
    thickFrame: true,
    // 等 ready-to-show 再显示，避免白屏闪
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    }
  })

  win.once('ready-to-show', () => {
    if (silent) {
      logger.info('[window] 开机自启启动，不显示窗口（托盘常驻）')
      return
    }
    win.show()
    logger.info('[window] 主窗口已显示')
  })

  // 开发期把渲染进程的 console 转发到主进程日志，排查问题时能直接看终端
  // Electron 44 起用事件对象取参（旧的多参数签名已废弃）
  win.webContents.on('console-message', (details) => {
    const text = `[renderer] ${details.message} (${details.sourceId}:${details.lineNumber})`
    if (details.level === 'error') logger.error(text)
    else if (details.level === 'warning') logger.warn(text)
    else logger.info(text)
  })

  win.webContents.on('did-fail-load', (_event, code, desc) => {
    logger.error(`[window] 页面加载失败：${code} ${desc}`)
  })

  // × 不退出，缩到托盘（除非 isQuitting 已经置 true）
  win.on('close', (e) => {
    if (isQuitting) return
    e.preventDefault()
    win.hide()
    logger.info('[window] 主窗口已隐藏到托盘')
  })

  win.on('closed', () => {
    mainWindow = null
  })

  // 最大化状态变化推给渲染层，用于切换标题栏按钮图标
  const pushState = (): void => {
    if (win.isDestroyed()) return
    win.webContents.send('window:state', { maximized: win.isMaximized() })
  }
  win.on('maximize', pushState)
  win.on('unmaximize', pushState)

  // 开发模式由 electron-vite 注入 ELECTRON_RENDERER_URL；生产模式加载打包后的 html
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow = win
  return win
}

/** 取主窗口（没有则返回 null） */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/** 把主窗口显示到前台（从托盘菜单 / 托盘左键单击调用） */
export function showMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

/** 标题栏按钮：最小化 */
export function minimizeWindow(): void {
  mainWindow?.minimize()
}

/** 标题栏按钮：最大化 / 还原；返回切换后的最大化状态 */
export function toggleMaximizeWindow(): boolean {
  if (!mainWindow) return false
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
  return mainWindow.isMaximized()
}

/** 标题栏按钮：关闭（走原有 close 拦截逻辑 → 隐藏到托盘） */
export function closeWindow(): void {
  mainWindow?.close()
}

/** 当前是否最大化（标题栏初始化用） */
export function isWindowMaximized(): boolean {
  return mainWindow ? mainWindow.isMaximized() : false
}
