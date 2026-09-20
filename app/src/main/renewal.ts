import { BrowserWindow, session } from 'electron'
import { SENSENOVA_POOL_USAGE_URL, SENSENOVA_TOKEN_KEY } from '../shared/constants'
import type { Account, CredentialSession } from '../shared/types'
import { logger } from './logger'

/**
 * 静默续期（登录型平台的「会话保活」）。
 *
 * 背景（2026-09-21 实测）：
 * - 商汤：`access_token`/`id_token` 是 180 分钟的 JWT，没有 refresh token；
 *   但会话 Cookie `oauth2_authentication_session` 是**滑动续期**的（每次访问都会顺延），
 *   并且在有会话的情况下加载 `/console`，平台会自己用会话换一份新 token 写进 localStorage。
 * - 小米 MiMo：`api-platform_serviceToken` 是会话级 HttpOnly Cookie，
 *   靠调用余额接口本身续期；上层 `account.xiaomi.com` 的 `passToken` 约 30 天且同样滑动顺延。
 *
 * 因此「续期」= 在**后台隐藏窗口**里，用**持久化的登录分区**重放一次页面动作：
 * 平台看到会话 Cookie 仍然有效，就会自动续期会话并重新签发 token。
 * 全程不弹窗、不需要密码；会话真的失效时返回失败，由上层提示用户重新登录。
 *
 * 只读使用的都是平台自己的页面与官方接口，不做任何签名伪造或鉴权绕过。
 */

/** 一个平台的续期配方 */
export interface RenewalRecipe {
  /** 登录分区名（与 loginToSite 的 'persist:login-' + host 一致） */
  partition: string
  /** 要加载的页面（加载动作本身就会触发会话续期） */
  pageUrl: string
  /** 页面加载后要额外请求的接口（有些平台的续期由这个请求触发，如小米余额接口）；空 = 不需要 */
  apiUrl?: string
  /** 附加请求头（如 Cookie）；缺省则用页面自身的登录态 */
  apiHeaders?: (session: CredentialSession) => Record<string, string>
  /** localStorage 里的登录态键名（用来判断是否拿到了新 token） */
  tokenKey?: string
  /** 登录态校验：返回 null = 可用，否则返回原因 */
  validateToken?: (token: string) => Promise<string | null>
}

/** 续期结果 */
export interface RenewalResult {
  ok: boolean
  /** 新的凭据（token 或 Cookie 串） */
  secret?: string
  /** 新的会话材料（cookie 串等） */
  session?: CredentialSession
  /** 新凭据的过期时间（毫秒；未知为 null） */
  expiresAt?: number | null
  /** 失败原因（人话） */
  error?: string
}

/** 商汤的登录态校验（复用真实额度接口，能通即有效） */
async function validateSenseNovaToken(token: string): Promise<string | null> {
  try {
    const r = await fetch(SENSENOVA_POOL_USAGE_URL, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000)
    })
    if (r.status === 200) return null
    if (r.status === 401 || r.status === 403) return '登录态已失效'
    return '额度接口返回 ' + r.status
  } catch (e) {
    return '校验请求失败：' + (e as Error).message
  }
}

/** 商汤续期配方：加载控制台 → 平台用会话换新 token 写进 localStorage */
export const SENSENOVA_RENEWAL: RenewalRecipe = {
  partition: 'persist:login-platform.sensenova.cn',
  pageUrl: 'https://platform.sensenova.cn/console',
  tokenKey: SENSENOVA_TOKEN_KEY,
  validateToken: validateSenseNovaToken
}

/** 小米 MiMo 续期配方：加载控制台 + 主动请求一次余额接口（续期由这个请求触发） */
export const MIMO_RENEWAL: RenewalRecipe = {
  partition: 'persist:login-platform.xiaomimimo.com',
  pageUrl: 'https://platform.xiaomimimo.com/console/balance',
  apiUrl: 'https://platform.xiaomimimo.com/api/v1/balance'
}

/** 平台 → 续期配方（没有配方的平台不支持静默续期） */
export function renewalRecipeFor(type: string): RenewalRecipe | null {
  if (type === 'sensenova') return SENSENOVA_RENEWAL
  if (type === 'mimo' || type === 'mimo-plan') return MIMO_RENEWAL
  return null
}

/** 支持静默续期的平台 */
export function supportsRenewal(type: string): boolean {
  return renewalRecipeFor(type) !== null
}

/** 从会话 Cookie 串里解析出给某个 URL 用的 Cookie 头（简版：不区分域，按名去重） */
function cookieHeaderFrom(session: CredentialSession | null): string {
  return session?.cookies ?? ''
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 读窗口页面里的 localStorage 值（拿不到返回空串） */
async function readLocal(win: BrowserWindow, key: string): Promise<string> {
  try {
    const v = await win.webContents.executeJavaScript(
      `(() => { try { return localStorage.getItem(${JSON.stringify(key)}) || '' } catch (e) { return '' } })()`,
      true
    )
    return typeof v === 'string' ? v : ''
  } catch {
    return ''
  }
}

/** 采集该分区/页面当前的全部 Cookie（用于回写会话材料） */
async function collectAllCookies(ses: Electron.Session, urls: string[]): Promise<string> {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const u of urls) {
    const list = await ses.cookies.get({ url: u }).catch(() => [])
    for (const c of list) {
      const k = c.name + '\u0000' + (c.domain ?? '')
      if (seen.has(k)) continue
      seen.add(k)
      parts.push(c.name + '=' + c.value)
    }
  }
  return parts.join('; ')
}

/**
 * 执行一次静默续期。
 *
 * @param type 平台类型（决定配方）
 * @param session 已保存的会话材料（可为 null：此时靠分区里残留的 Cookie 试一次）
 * @param opts.reason 日志里标注触发原因（'expired' 到期自动 / 'manual' 手动点击 / 'startup' 启动预热）
 * @param opts.preserveExistingCookies 是否保留分区里已有的 Cookie（登录刚成功时用 true，避免把新会话清掉）
 */
export async function renewCredential(
  type: string,
  sessionMaterial: CredentialSession | null,
  opts: { reason: 'expired' | 'manual' | 'startup'; preserveExistingCookies?: boolean } = { reason: 'manual' }
): Promise<RenewalResult> {
  const recipe = renewalRecipeFor(type)
  if (!recipe) return { ok: false, error: '该平台不支持静默续期' }

  const ses = session.fromPartition(recipe.partition)
  const urls = ['https://' + new URL(recipe.pageUrl).hostname]
  if (recipe.apiUrl) urls.push('https://' + new URL(recipe.apiUrl).hostname)

  let win: BrowserWindow | null = null
  try {
    // 分区里已有 Cookie（上次登录留下的）默认保留：那些 Cookie 很可能仍在滑动续期，
    // 清掉等于把"还能用很久的会话"扔掉 —— 这正是之前每次都要重登的原因。
    // 只有调用方明确要求（例如会话已被证明失效）才清空重来。
    if (!opts.preserveExistingCookies) {
      const existing = await ses.cookies.get({}).catch(() => [])
      if (existing.length === 0) {
        // 分区是空的：用保存的会话材料把 Cookie 灌回去，再试一次静默续期
        if (sessionMaterial?.cookies) {
          for (const pair of sessionMaterial.cookies.split('; ')) {
            const idx = pair.indexOf('=')
            if (idx <= 0) continue
            const name = pair.slice(0, idx)
            const value = pair.slice(idx + 1)
            for (const u of urls) {
              await ses.cookies.set({ url: u, name, value }).catch(() => { /* 单个失败不致命 */ })
            }
          }
          logger.info(`[renew] ${type} 已把保存的会话 Cookie 灌回分区，尝试静默续期`)
        }
      } else {
        logger.info(`[renew] ${type} 沿用分区里现有的 ${existing.length} 个 Cookie 尝试续期`)
      }
    }

    win = new BrowserWindow({
      width: 420,
      height: 320,
      show: false, // 全程不打扰用户
      skipTaskbar: true,
      webPreferences: {
        partition: recipe.partition,
        nodeIntegration: false,
        contextIsolation: true,
        // 隐藏窗口默认会被节流，续期就废了；这里显式关掉
        backgroundThrottling: false
      }
    })

    // 加载页面（加载动作本身即触发平台的会话续期；跳转链常以 ERR_ABORTED 结束，忽略）
    win.loadURL(recipe.pageUrl).catch(() => { /* 忽略 */ })

    // 有些平台靠接口请求触发续期（小米余额接口就是）
    if (recipe.apiUrl) {
      const headers = recipe.apiHeaders ? recipe.apiHeaders(sessionMaterial ?? { ts: 0, cookies: '', tokenKey: '', tokenLen: 0, v: 1 }) : {}
      const cookie = cookieHeaderFrom(sessionMaterial)
      void fetch(recipe.apiUrl, {
        headers: { Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
        signal: AbortSignal.timeout(12000)
      }).catch(() => { /* 忽略：续期主要靠页面动作 */ })
    }

    if (recipe.tokenKey) {
      const key = recipe.tokenKey
      // 轮询等新 token：最多 25 秒
      for (let i = 0; i < 25; i++) {
        await sleep(1000)
        const token = await readLocal(win, key)
        if (!token) continue
        if (recipe.validateToken) {
          const err = await recipe.validateToken(token)
          if (err) continue
        }
        const cookies = await collectAllCookies(ses, urls)
        logger.info(`[renew] ${type} 静默续期成功（${opts.reason}，token 长度 ${token.length}，Cookie ${cookies.split('; ').filter(Boolean).length} 个）`)
        return {
          ok: true,
          secret: token,
          expiresAt: jwtExpiry(token),
          session: { ts: Date.now(), cookies, tokenKey: key, tokenLen: token.length, v: 1 }
        }
      }
      // token 没刷新出来：可能是会话真的过期了
      const cookies = await collectAllCookies(ses, urls)
      logger.warn(`[renew] ${type} 静默续期失败（${opts.reason}）：没读到新的登录态（Cookie ${cookies.split('; ').filter(Boolean).length} 个）`)
      return { ok: false, error: '会话已失效，需要重新登录一次', session: { ts: Date.now(), cookies, tokenKey: key, tokenLen: 0, v: 1 } }
    }

    // 无 tokenKey 的平台（小米）：续期靠"用分区 Cookie 真实发一次业务请求"，由外层适配器验证结果
    await sleep(6000)
    const cookies = await collectAllCookies(ses, urls)
    if (!cookies) {
      logger.warn(`[renew] ${type} 静默续期失败（${opts.reason}）：分区里没有可用 Cookie`)
      return { ok: false, error: '会话已失效，需要重新登录一次' }
    }
    logger.info(`[renew] ${type} 已刷新分区会话（${opts.reason}，Cookie ${cookies.split('; ').filter(Boolean).length} 个），交由适配器验证`)
    return { ok: true, session: { ts: Date.now(), cookies, tokenKey: '', tokenLen: 0, v: 1 } }
  } catch (e) {
    logger.warn(`[renew] ${type} 续期异常：${(e as Error).message}`)
    return { ok: false, error: (e as Error).message }
  } finally {
    try { win?.destroy() } catch { /* 已销毁 */ }
  }
}

/** 解析 JWT 的过期时间（毫秒）；解析不出返回 null */
export function jwtExpiry(token: string): number | null {
  try {
    const part = String(token).split('.')[1]
    if (!part) return null
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const payload = JSON.parse(json) as { exp?: number }
    return typeof payload.exp === 'number' && payload.exp > 0 ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

/** 距过期还有多久（毫秒）；未知返回 null */
export function msUntilExpiry(account: Account): number | null {
  const exp = account.token_expires_at
  if (typeof exp !== 'number' || exp <= 0) return null
  return exp - Date.now()
}
