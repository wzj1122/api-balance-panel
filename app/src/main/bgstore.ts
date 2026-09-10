import fs from 'node:fs'
import path from 'node:path'
import { app, dialog } from 'electron'
import { logger } from './logger'
import { DATA_DIR } from './paths'

/**
 * 自定义背景图仓库：图片统一复制到数据目录 backgrounds/ 下，
 * 渲染层通过 data URL 使用（避免 file:// 与 CSP 兼容问题，也不依赖原图位置）。
 */

const BG_DIR = path.join(DATA_DIR, 'backgrounds')

/** 内置背景目录（随安装包发布） */
function builtinDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'backgrounds')
    : path.join(__dirname, '..', '..', 'resources', 'backgrounds')
}

/** 主题 → 内置默认背景文件名（默认黑/白对应 dark/light，其余按主题 slug） */
export function backgroundForTheme(theme: string): string | null {
  const name = theme === 'dark' ? 'builtin-dark.png' : theme === 'light' ? 'builtin-light.png' : theme + '.png'
  try {
    return fs.existsSync(path.join(builtinDir(), name)) ? name : null
  } catch {
    return null
  }
}

/** 内置背景列表 */
function listBuiltin(): { name: string; size: number; builtin: boolean }[] {
  try {
    const dir = builtinDir()
    if (!fs.existsSync(dir)) return []
    return fs
      .readdirSync(dir)
      .filter((f) => ALLOWED.includes(path.extname(f).toLowerCase()))
      .map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size, builtin: true }))
  } catch {
    return []
  }
}
const ALLOWED = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']
const MAX_BYTES = 8 * 1024 * 1024

function ensureDir(): void {
  fs.mkdirSync(BG_DIR, { recursive: true })
}

export function listBackgrounds(): { name: string; size: number; builtin: boolean }[] {
  try {
    ensureDir()
    const user = fs
      .readdirSync(BG_DIR)
      .filter((f) => ALLOWED.includes(path.extname(f).toLowerCase()))
      .map((f) => ({ name: f, size: fs.statSync(path.join(BG_DIR, f)).size, builtin: false }))
    // 内置背景排在前面
    return [...listBuiltin(), ...user]
  } catch {
    return []
  }
}

export async function importBackground(): Promise<{ ok: boolean; name?: string; error?: string }> {
  try {
    const res = await dialog.showOpenDialog({
      title: '选择背景图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
    })
    if (res.canceled || res.filePaths.length === 0) return { ok: false, error: '已取消' }
    const src = res.filePaths[0]
    const ext = path.extname(src).toLowerCase()
    if (!ALLOWED.includes(ext)) return { ok: false, error: '不支持的图片格式' }
    const size = fs.statSync(src).size
    if (size > MAX_BYTES) return { ok: false, error: '图片太大（超过 8MB），请压缩后再导入' }
    ensureDir()
    const base = path.basename(src, path.extname(src)).replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40)
    const name = base + '-' + Date.now().toString(36) + ext
    fs.copyFileSync(src, path.join(BG_DIR, name))
    logger.info('[bg] 已导入背景图：' + name)
    return { ok: true, name }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function removeBackground(name: string): boolean {
  try {
    const target = path.join(BG_DIR, path.basename(name))
    if (!fs.existsSync(target)) return false
    fs.rmSync(target)
    logger.info('[bg] 已删除背景图：' + name)
    return true
  } catch {
    return false
  }
}

export function backgroundData(name: string): { ok: boolean; dataUrl?: string; error?: string } {
  try {
    const safe = path.basename(name)
    const builtin = path.join(builtinDir(), safe)
    const target = fs.existsSync(builtin) ? builtin : path.join(BG_DIR, safe)
    if (!fs.existsSync(target)) return { ok: false, error: '背景图不存在' }
    const buf = fs.readFileSync(target)
    const ext = path.extname(target).toLowerCase()
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : ext === '.bmp' ? 'image/bmp' : 'image/jpeg'
    return { ok: true, dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64') }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
