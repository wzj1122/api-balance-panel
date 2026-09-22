import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'

/**
 * 数据目录与文件常量。
 *
 * 注意：Electron 的 userData 取的是 package.json 的 **productName**（打包后是 `%APPDATA%\API 余额面板\`），
 * 开发模式没有 productName 时才会退回 `name`（api-balance-panel）。改这两个字段都会导致老配置"找不到"，
 * 所以一期定名后不再改。
 */

/** app 尚未初始化时的兜底目录，避免模块加载期就崩 */
function fallbackDir(): string {
  return path.join(os.homedir(), '.api-balance-panel')
}

function resolveDataDir(): string {
  try {
    return app.getPath('userData')
  } catch {
    return fallbackDir()
  }
}

/** 数据根目录：打包后 Windows 下是 %APPDATA%\API 余额面板\ */
export const DATA_DIR: string = resolveDataDir()

/** 主配置文件 */
export const CONFIG_FILE: string = path.join(DATA_DIR, 'config.json')
/** 上一版配置（只留 1 份） */
export const CONFIG_BAK: string = path.join(DATA_DIR, 'config.json.bak')
/** 原子写的临时文件 */
export const CONFIG_TMP: string = path.join(DATA_DIR, 'config.json.tmp')
/** 快照文件 */
export const SNAPSHOT_FILE: string = path.join(DATA_DIR, 'snapshots.json')
/** 日志目录 */
export const LOG_DIR: string = path.join(DATA_DIR, 'logs')
/** 日志文件 */
export const LOG_FILE: string = path.join(LOG_DIR, 'main.log')

/**
 * 确保数据目录与日志目录存在。
 * 必须在 app.whenReady 之后、任何读写之前调用一次。
 */
export function ensureDirs(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.mkdirSync(LOG_DIR, { recursive: true })
}

/** 生成损坏配置的归档文件名（不删除，留给用户自己救） */
export function corruptFileName(ts: number = Date.now()): string {
  return path.join(DATA_DIR, `config.corrupt-${ts}.json`)
}
