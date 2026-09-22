import crypto from 'node:crypto'
import os from 'node:os'
import { safeStorage } from 'electron'
import { logger } from './logger'

/**
 * 密钥加解密。
 *
 * 首选 Electron safeStorage（Windows 走 DPAPI，系统级加密）；
 * 不可用时降级为「本机弱混淆」——这不是加密，只能防止别人不小心看到明文，
 * 界面必须弹黄色横幅提示用户。
 *
 * 方案与版本会写进 config.json 的 crypto.scheme / crypto.version，
 * 未来换方案只需在 SCHEMES 里加一条，旧配置不用迁移也能读。
 */

/** 支持的加密方案 */
export type CryptoScheme = 'safeStorage-v1' | 'obfuscate-v1'

/** 当前配置里记录的 scheme 版本号 */
export const CRYPTO_VERSION = 1

interface SchemeImpl {
  encrypt(plain: string): string
  decrypt(enc: string): string
}

/** safeStorage 是否可用（缓存结果，避免反复调用系统 API） */
let secureCache: boolean | null = null

export function isSecure(): boolean {
  if (secureCache !== null) return secureCache
  try {
    secureCache = safeStorage.isEncryptionAvailable()
  } catch (e) {
    secureCache = false
    logger.warn('[crypto] safeStorage 检测失败，按不可用处理：', (e as Error).message)
  }
  if (!secureCache) {
    logger.warn('[crypto] 当前系统不支持加密存储，密钥将降级为「本机弱混淆」保存')
  }
  return secureCache
}

/** 当前应该使用哪个方案 */
export function currentScheme(): CryptoScheme {
  return isSecure() ? 'safeStorage-v1' : 'obfuscate-v1'
}

/** 本机弱混淆用的固定盐：主机名 + 用户名（换台机器就解不出来，符合"本机"语义） */
function localSalt(): Buffer {
  let material = 'api-balance-panel'
  try {
    material += `|${os.hostname()}`
  } catch {
    // 忽略
  }
  try {
    material += `|${os.userInfo().username}`
  } catch {
    // 忽略
  }
  return crypto.createHash('sha256').update(material, 'utf8').digest()
}

/** base64( XOR(plain, 本机盐) ) —— 明文已作废提示：这不是加密 */
function obfuscate(plain: string): string {
  const salt = localSalt()
  const buf = Buffer.from(plain, 'utf8')
  const out = Buffer.alloc(buf.length)
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ salt[i % salt.length]
  }
  return out.toString('base64')
}

/** obfuscate 的逆运算 */
function deobfuscate(enc: string): string {
  const salt = localSalt()
  const buf = Buffer.from(enc, 'base64')
  const out = Buffer.alloc(buf.length)
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ salt[i % salt.length]
  }
  return out.toString('utf8')
}

const SCHEMES: Record<CryptoScheme, SchemeImpl> = {
  'safeStorage-v1': {
    encrypt(plain: string): string {
      return safeStorage.encryptString(plain).toString('base64')
    },
    decrypt(enc: string): string {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'))
    }
  },
  'obfuscate-v1': {
    encrypt(plain: string): string {
      return obfuscate(plain)
    },
    decrypt(enc: string): string {
      return deobfuscate(enc)
    }
  }
}

/**
 * 用当前最佳方案加密，返回 base64 密文。
 * 注意：调用方要把 currentScheme() 一起写进 config.json，否则将来解不开。
 */
export function encrypt(plain: string): string {
  if (!plain) return ''
  return SCHEMES[currentScheme()].encrypt(plain)
}

/**
 * 解密。scheme 缺省时按当前方案处理（旧配置文件没有这个字段也能读）。
 * 解密失败不抛异常，返回空串 + 日志，避免启动时因为一个账号崩掉整个应用。
 */
export function decrypt(enc: string | null | undefined, scheme: CryptoScheme = currentScheme()): string {
  if (!enc) return ''
  try {
    return SCHEMES[scheme].decrypt(enc)
  } catch (e) {
    logger.error(`[crypto] 解密失败（scheme=${scheme}）：`, (e as Error).message)
    return ''
  }
}

/**
 * 双方案解密回退：主方案解不开时自动试另一种（环境变化 / 换机后旧配置不用迁移也能读）。
 * store / keyvault / monitor 共用，替代此前各写一份的 fallback。
 */
export function decryptWithFallback(enc: string | null | undefined, scheme: CryptoScheme = currentScheme()): string {
  const plain = decrypt(enc, scheme)
  if (plain || !enc) return plain
  const other: CryptoScheme = scheme === 'safeStorage-v1' ? 'obfuscate-v1' : 'safeStorage-v1'
  return decrypt(enc, other)
}
