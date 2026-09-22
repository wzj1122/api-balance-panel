import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { maskSecret, normalizeTags } from '../shared/format'
import type { KeyVaultInput } from '../shared/types'
import { CRYPTO_VERSION, currentScheme, decryptWithFallback, encrypt } from './crypto'
import { logger } from './logger'
import { DATA_DIR } from './paths'

/**
 * 独立 Key 库（keys.json）。
 *
 * 与账号的关系是**单向**的：
 * - 在「添加账号」里用 API Key 建的账号会自动出现在 Key 管理列表（由 keys.ts 合并展示）
 * - 在这里新建的 Key 只是留档/整理用，**不会**变成账号、不参与余额查询、不出现在概览页
 *
 * 密钥与账号同样走本机加密（safeStorage），明文不落盘。
 */

const KEYS_FILE = path.join(DATA_DIR, 'keys.json')

export interface VaultKey {
  id: string
  name: string
  type: string
  base_url: string
  secret_enc: string | null
  secret_masked: string
  secret_scheme: string
  tags: string[]
  enabled: boolean
  created_at: number
  updated_at: number
}

interface KeysFile {
  version: number
  crypto?: { scheme: string; version: number }
  keys: VaultKey[]
}

let cache: VaultKey[] | null = null

export function listVaultKeys(): VaultKey[] {
  if (cache) return cache
  try {
    const raw = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')) as KeysFile
    cache = Array.isArray(raw?.keys) ? raw.keys : []
  } catch (e) {
    // 与 store 的 config.json 同一策略：坏文件先改名归档（不删，留给用户自己救）再重建，
    // 避免下一次保存把现场覆盖掉
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      let archived: string | null = null
      try {
        archived = path.join(DATA_DIR, `keys.corrupt-${Date.now()}.json`)
        fs.renameSync(KEYS_FILE, archived)
      } catch {
        archived = null
      }
      logger.error(`[keyvault] keys.json 解析失败，已按空库重建（坏文件另存为 ${archived ?? '未知'}）：${(e as Error).message}`)
    }
    cache = []
  }
  return cache
}

function save(): void {
  if (!cache) return
  const payload: KeysFile = { version: 1, crypto: { scheme: currentScheme(), version: CRYPTO_VERSION }, keys: cache }
  try {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(payload, null, 2), 'utf8')
  } catch (e) {
    logger.warn('[keyvault] 写入失败：' + (e as Error).message)
  }
}

export function saveVaultKey(input: KeyVaultInput): VaultKey {
  const list = listVaultKeys()
  const now = Date.now()
  const existing = input.id ? list.find((k) => k.id === input.id) ?? null : null
  let secretEnc = existing ? existing.secret_enc : null
  let masked = existing ? existing.secret_masked : ''
  let scheme = existing ? existing.secret_scheme : currentScheme()
  if (typeof input.secret === 'string' && input.secret.trim()) {
    secretEnc = encrypt(input.secret.trim())
    masked = maskSecret(input.secret.trim())
    scheme = currentScheme()
  }
  const key: VaultKey = {
    id: existing ? existing.id : randomUUID(),
    name: input.name?.trim() || existing?.name || '未命名 Key',
    type: input.type || existing?.type || 'custom',
    base_url: (input.base_url ?? existing?.base_url ?? '').trim(),
    secret_enc: secretEnc,
    secret_masked: masked,
    secret_scheme: scheme,
    tags: Array.isArray(input.tags) ? normalizeTags(input.tags) : existing?.tags ?? [],
    enabled: typeof input.enabled === 'boolean' ? input.enabled : existing?.enabled ?? true,
    created_at: existing ? existing.created_at : now,
    updated_at: now
  }
  const i = list.findIndex((k) => k.id === key.id)
  if (i >= 0) list[i] = key
  else list.push(key)
  save()
  logger.info('[keyvault] 已保存 Key：' + key.name)
  return key
}

export function removeVaultKey(id: string): boolean {
  const list = listVaultKeys()
  const i = list.findIndex((k) => k.id === id)
  if (i < 0) return false
  list.splice(i, 1)
  save()
  return true
}

export function revealVaultKey(id: string): string {
  const k = listVaultKeys().find((x) => x.id === id)
  if (!k || !k.secret_enc) return ''
  // 双方案解密回退统一走 crypto.decryptWithFallback
  return decryptWithFallback(k.secret_enc, k.secret_scheme as Parameters<typeof decryptWithFallback>[1])
}

export function vaultFingerprint(id: string): string {
  const secret = revealVaultKey(id)
  if (!secret) return ''
  return require('node:crypto').createHash('sha256').update(secret).digest('hex').slice(0, 12) as string
}
