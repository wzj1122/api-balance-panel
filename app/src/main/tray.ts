import path from 'node:path'
import { app, Menu, nativeImage, Tray } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import type { BalanceRow } from '../shared/types'
import { logger } from './logger'
import { showMainWindow } from './window'

/**
 * 系统托盘。
 *
 * 图标路径解析：打包后取 process.resourcesPath（electron-builder extraResources），
 * 开发期从 out/main/ 往上两级回到 app/resources/。
 *
 * 图标：统一使用软件主图标（icon.png），有查询失败或低余额时染成红色作告警。
 * 行为：左键单击 = 显示主面板；右键菜单 = 仅「显示主面板 / 退出」。
 * tooltip 动态显示最低余额账号或失败数量。
 */

let tray: Tray | null = null
let currentRows: BalanceRow[] = []
let paused = false
let onQuitRef: (() => void) | null = null
/** 正常态托盘图标（软件主图标）与警告态（主图标染红） */
let iconNormal: Electron.NativeImage | null = null
let iconAlert: Electron.NativeImage | null = null

/** 把图标染成红色系（仅改颜色、保留形状与透明度，用于失败/低余额告警态） */
function tintRed(img: Electron.NativeImage): Electron.NativeImage {
  const size = img.getSize()
  if (size.width <= 0 || size.height <= 0) return img
  const buf = img.toBitmap() // BGRA 顺序
  for (let i = 0; i + 3 < buf.length; i += 4) {
    if (buf[i + 3] > 0) {
      buf[i] = 56 // B
      buf[i + 1] = 64 // G
      buf[i + 2] = 226 // R
    }
  }
  return nativeImage.createFromBitmap(buf, size)
}

function renderTray(): void {
  if (!tray) return
  const enabled = currentRows.filter((r) => r.enabled)
  const fails = enabled.filter((r) => !r.ok)
  let tip = 'API 余额面板'
  if (enabled.length === 0) {
    tip += ' · 还没有账号'
  } else if (fails.length > 0) {
    tip += ' · ' + fails.length + ' 个账号查询失败'
  } else {
    const withBalance = enabled.filter((r) => r.ok && r.remaining !== null && r.remaining !== undefined)
    if (withBalance.length > 0) {
      const lowest = withBalance.reduce((a, b) => ((b.remaining as number) < (a.remaining as number) ? b : a))
      tip += ' · 最低 ' + lowest.name + ' ' + lowest.remaining + ' ' + lowest.unit
    }
  }
  if (paused) tip += ' · 已暂停刷新'
  tray.setToolTip(tip)
  // 有查询失败或低余额时换成警告态图标（红色）
  const alert = fails.length > 0 || enabled.some((r) => r.lowBalance)
  const icon = alert ? iconAlert : iconNormal
  if (icon && !icon.isEmpty()) tray.setImage(icon)

  const items: MenuItemConstructorOptions[] = [
    { label: '🪟  显示主面板', click: () => showMainWindow() },
    {
      label: '✖  退出',
      click: () => {
        if (onQuitRef) onQuitRef()
      }
    }
  ]
  tray.setContextMenu(Menu.buildFromTemplate(items))
}

/** 查询完成后刷新托盘（rows 省略时只更新暂停状态） */
export function updateTray(rows?: BalanceRow[], nextPaused?: boolean): void {
  if (rows) currentRows = rows
  if (typeof nextPaused === 'boolean') paused = nextPaused
  renderTray()
}

export function createTray(onQuit: () => void): void {
  if (tray) return
  onQuitRef = onQuit
  const iconDir = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '..', '..', 'resources')
  const loadIcon = (name: string): Electron.NativeImage | null => {
    const img = nativeImage.createFromPath(path.join(iconDir, name))
    if (img.isEmpty()) {
      logger.warn('[tray] 托盘图标加载失败：' + path.join(iconDir, name))
      return null
    }
    const resized = img.resize({ width: 16, height: 16 })
    return resized.isEmpty() ? img : resized
  }
  iconNormal = loadIcon('icon.png')
  iconAlert = iconNormal ? tintRed(iconNormal) : null
  if (!iconNormal) iconNormal = nativeImage.createEmpty()
  tray = new Tray(iconNormal)
  tray.on('click', () => showMainWindow())
  renderTray()
  logger.info('[tray] 系统托盘已创建')
}

export function destroyTray(): void {
  if (!tray) return
  tray.destroy()
  tray = null
  logger.info('[tray] 系统托盘已销毁')
}
