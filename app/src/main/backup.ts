import fs from 'node:fs'
import { app, dialog } from 'electron'
import { logger } from './logger'
import { CONFIG_FILE, SNAPSHOT_FILE } from './paths'
import { store } from './store'
import { getMainWindow } from './window'

/**
 * 配置备份 / 恢复。
 *
 * 导出：把 config.json 原样（密钥仍是本机加密后的密文）打包成 JSON，可含历史快照。
 * 导入：校验备份文件 → 先把当前配置另存为 config.json.pre-import.bak → 覆盖 → 重新加载。
 * 说明：换电脑后 safeStorage 密钥不同，密文需要用原机器的系统账号解密，
 * 因此导入后可能需要重新填写各平台的密钥（账号与设置会保留）。
 */

interface BackupFile {
  kind?: string
  version?: number
  exportedAt?: number
  app?: string
  config?: unknown
  snapshots?: unknown
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes())
}

export async function exportBackup(
  includeHistory: boolean
): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const win = getMainWindow()
    const options = {
      title: '导出配置备份',
      defaultPath: 'api-balance-backup-' + stamp() + '.json',
      filters: [{ name: 'JSON 备份', extensions: ['json'] }]
    }
    const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (res.canceled || !res.filePath) return { ok: false, error: '已取消' }
    const payload: BackupFile = {
      kind: 'api-balance-panel-backup',
      version: 1,
      exportedAt: Date.now(),
      app: app.getVersion(),
      config: JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')),
      snapshots: includeHistory ? readSnapshotsFile() : null
    }
    fs.writeFileSync(res.filePath, JSON.stringify(payload, null, 2), 'utf8')
    logger.info('[backup] 已导出备份：' + res.filePath)
    return { ok: true, path: res.filePath }
  } catch (e) {
    logger.error('[backup] 导出失败：' + (e as Error).message)
    return { ok: false, error: (e as Error).message }
  }
}

function readSnapshotsFile(): unknown {
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'))
  } catch {
    return null
  }
}

export async function importBackup(): Promise<{ ok: boolean; message: string }> {
  try {
    const win = getMainWindow()
    const openOptions = {
      title: '选择备份文件',
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: 'JSON 备份', extensions: ['json'] }]
    }
    const res = win ? await dialog.showOpenDialog(win, openOptions) : await dialog.showOpenDialog(openOptions)
    if (res.canceled || res.filePaths.length === 0) return { ok: false, message: '已取消' }
    const raw = fs.readFileSync(res.filePaths[0], 'utf8')
    const parsed = JSON.parse(raw) as BackupFile
    if (!parsed || parsed.kind !== 'api-balance-panel-backup' || typeof parsed.config !== 'object' || parsed.config === null) {
      return { ok: false, message: '这不是本应用的备份文件' }
    }
    fs.copyFileSync(CONFIG_FILE, CONFIG_FILE + '.pre-import.bak')
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(parsed.config, null, 2), 'utf8')
    store.load()
    const accounts = store.listAccounts().length
    logger.info('[backup] 已导入备份，账号数 ' + accounts)
    return {
      ok: true,
      message: '已导入 ' + accounts + ' 个账号与全部设置（原配置已另存为 config.json.pre-import.bak）。建议重启应用后生效。'
    }
  } catch (e) {
    logger.error('[backup] 导入失败：' + (e as Error).message)
    return { ok: false, message: '导入失败：' + (e as Error).message }
  }
}
