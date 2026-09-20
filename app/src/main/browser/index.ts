import { BrowserWindow, session, type Session } from 'electron'
import {
  MINIMAX_ACCOUNT_URL,
  MINIMAX_BACKEND,
  MINIMAX_BACKEND_CN,
  SENSENOVA_POOL_USAGE_URL
} from '../../shared/constants'
import type { CredentialSession } from '../../shared/types'
import { logger } from '../logger'

/**
 * 浏览器自动化 —— 用 Electron 自带的 Chromium 完成「登录 + 抓 Cookie」。
 *
 * 设计取舍：
 * - 不引入 Playwright：Electron 本身就是 Chromium，用 BrowserWindow 即可，安装包体积不变。
 * - 直接打开各平台的登录表单页（小米账号 / MiniMax unified-login / 智谱 login），不用手动跳转。
 * - 登录完成后自动检测（进入控制台 URL + 会话校验通过）并关闭窗口，无需手动关。
 * - 不存账号密码：只抓登录后的 Cookie（加密存进账号的 secret 字段），过期后界面提示重新登录。
 */

export interface LoginResult {
  ok: boolean
  cookie?: string
  error?: string
  /** 续期材料（会话 Cookie 串等）；登录成功且配置了 collectSession 时才有 */
  session?: CredentialSession | null
}

export interface LoginSuccessRule {
  /** 命中这些 host 说明已进入登录后的页面（开始校验，通过即自动关闭窗口） */
  hosts: string[]
  /** 可选：路径前缀也要匹配（如 /console/，避免在登录中间页就触发） */
  pathPrefix?: string
}

export interface LoginOptions {
  /** 登录表单页地址 */
  url: string
  /** 平台显示名（窗口标题与日志） */
  name: string
  /** 额外按这些 URL 抓 Cookie（接口域与登录域不同的平台，如 MiniMax 的 www 域） */
  extraUrls?: string[]
  /** 抓完 Cookie 后立即校验：返回 null = 通过；返回字符串 = 失败原因 */
  validate?: (cookie: string) => Promise<string | null>
  /** 自动关闭规则：窗口进入这些地址后开始轮询校验，通过就自动关窗 */
  success?: LoginSuccessRule
  /** 登录态存在 localStorage 里的键名（商汤等平台：额度接口只认 Bearer token，Cookie 无效） */
  tokenKey?: string
  /** 抓完 token 后立即校验（与 validate 二选一，tokenKey 存在时用它） */
  validateToken?: (token: string) => Promise<string | null>
  /**
   * 登录成功后采集「续期材料」（会话 Cookie 串等）。
   * 登录型平台的 token 只活几小时，但有会话 Cookie 就能静默换新；
   * 把登录这一刻的会话存下来，之后就能自动续期，用户不用反复重新登录。
   */
  collectSession?: (info: { cookie: string; token: string }) => Promise<CredentialSession | null>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 从专属 session 里按一组 URL 抓 Cookie（name+domain 去重） */
async function collectCookies(ses: Session, urls: string[]): Promise<string> {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const u of urls) {
    const cookies = await ses.cookies.get({ url: u })
    for (const cc of cookies) {
      const key = cc.name + '\u0000' + (cc.domain ?? '')
      if (seen.has(key)) continue
      seen.add(key)
      parts.push(cc.name + '=' + cc.value)
    }
  }
  return parts.join('; ')
}

/**
 * 从登录窗口页面里读 localStorage 的登录态（tokenKey）。
 * 用于「额度接口只认 Bearer token」的平台（商汤日日新）：Cookie 抓了也没用，必须拿 token。
 * 读不到（没登录 / 还没写进去）返回空串，由调用方继续轮询。
 */
async function collectToken(win: BrowserWindow, key: string): Promise<string> {
  try {
    const v = await win.webContents.executeJavaScript(
      `(() => { try { return localStorage.getItem(${JSON.stringify(key)}) || '' } catch (e) { return '' } })()`,
      true
    )
    return typeof v === 'string' ? v : ''
  } catch {
    // 页面还在加载 / 已销毁：当作暂时读不到
    return ''
  }
}

/**
 * 安装「登录态探针」（文档创建前注入，随每次导航自动重装）。
 *
 * 解决两个现实问题：
 * 1. 有些平台登录后**不一定把 token 写进 localStorage**（或换了键名），
 *    但页面自己肯定会带着 `Authorization: Bearer <token>` 去请求接口 —— 顺手记下来；
 * 2. 页面切换/重定向瞬间 executeJavaScript 可能读不到，这时用记下来的值兜底。
 *
 * 只读取请求头，不改动页面行为；值不会写进日志。
 */
const TOKEN_PROBE_SOURCE = [
  '(() => {',
  '  try {',
  '    if (window.__dshProbeInstalled) return;',
  '    window.__dshProbeInstalled = true;',
  '    window.__dshAuthToken = window.__dshAuthToken || "";',
  '    var HDRS = ["authorization", "Authorization"];',
  '    var pick = function (h) {',
  '      try {',
  '        if (!h) return "";',
  '        var i, k, raw = "";',
  '        for (i = 0; i < HDRS.length && !raw; i++) {',
  '          k = HDRS[i];',
  '          raw = typeof h.get === "function" ? (h.get(k) || "") : (h[k] || "");',
  '        }',
  '        if (!raw) return "";',
  '        return String(raw).split(" ").slice(-1)[0];', // 去掉 "Bearer " 前缀
  '      } catch (e) { return ""; }',
  '    };',
  '    var save = function (t) { if (t && t.length > 20) window.__dshAuthToken = t; };',
  '    var of = window.fetch;',
  '    if (of) {',
  '      window.fetch = function () {',
  '        try { save(pick((arguments[1] || {}).headers)); } catch (e) {}',
  '        return of.apply(this, arguments);',
  '      };',
  '    }',
  '    var oo = XMLHttpRequest.prototype.setRequestHeader;',
  '    if (oo) {',
  '      XMLHttpRequest.prototype.setRequestHeader = function (name, value) {',
  '        try {',
  '          if (String(name).toLowerCase() === "authorization") save(String(value).split(" ").slice(-1)[0]);',
  '        } catch (e) {}',
  '        return oo.call(this, name, value);',
  '      };',
  '    }',
  '  } catch (e) {}',
  '})()'
].join('\n')

// 自检：上面的源码在实现里必须没有残留转义错误（多行模板里写正则很容易翻车，这里用断言锁死）
if (TOKEN_PROBE_SOURCE.includes('\\\\')) {
  throw new Error('TOKEN_PROBE_SOURCE 含有双重转义，注入后会失效')
}

/** 读探针记下来的登录态（拿不到返回空串） */
async function readProbedToken(win: BrowserWindow): Promise<string> {
  try {
    const v = await win.webContents.executeJavaScript(
      `(() => { try { return window.__dshAuthToken || '' } catch (e) { return '' } })()`,
      true
    )
    return typeof v === 'string' ? v : ''
  } catch {
    return ''
  }
}

/** 列出页面上像是登录态的键名（只读键名与长度，不含值，便于排查"键名变了"） */
async function describeTokenKeys(win: BrowserWindow): Promise<string> {
  try {
    const v = await win.webContents.executeJavaScript(
      `(() => {
        try {
          const out = []
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i) || ''
            if (/token|auth|jwt|session/i.test(k)) out.push(k + '(' + String(localStorage.getItem(k) || '').length + ')')
          }
          return out.join(', ') || '（没有像登录态的键）'
        } catch (e) { return 'ERR:' + e.message }
      })()`,
      true
    )
    return typeof v === 'string' ? v : ''
  } catch {
    return '（页面已关闭，读不到）'
  }
}

/**
 * 打开登录窗口（直达登录表单页）。
 * 登录成功（URL 回到控制台 + 校验通过）时自动关闭窗口并返回凭据；
 * 凭据有二选一：Cookie（默认）或 localStorage 里的 token（tokenKey，商汤等平台）。
 * 校验失败的凭据不会返回（避免存坏数据），未配置成功规则时保持手动关闭。
 */
export function loginToSite(opts: LoginOptions): Promise<LoginResult> {
  return new Promise((resolve) => {
    let host = opts.url
    try {
      host = new URL(opts.url).hostname
    } catch {
      // 解析不出就用兜底分区名
    }
    const partition = 'persist:login-' + host
    const ses = session.fromPartition(partition)

    const win = new BrowserWindow({
      width: 920,
      height: 720,
      title: '登录 ' + opts.name + '（登录完成后自动关闭）',
      autoHideMenuBar: true,
      backgroundColor: '#16181d',
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true
      }
    })

    const urls = opts.extraUrls && opts.extraUrls.length ? [opts.url, ...opts.extraUrls] : [opts.url]
    /** 本次要抓的凭据类型：配了 tokenKey 就抓 token，否则抓 Cookie */
    const wantToken = typeof opts.tokenKey === 'string' && opts.tokenKey.length > 0

    // 文档创建前注入探针：每次导航/重定向后都会自动重装（只读 Authorization 头）
    if (wantToken) {
      const injectProbe = (): void => {
        void win.webContents.executeJavaScript(TOKEN_PROBE_SOURCE, true).catch(() => {})
      }
      win.webContents.on('did-start-navigation', injectProbe)
      win.webContents.on('did-finish-load', injectProbe)
      // 注入到"每次新文档创建前"，保证页面自己的首屏请求也能被记到
      try {
        win.webContents.on('did-start-loading', injectProbe)
      } catch { /* 忽略 */ }
    }

    /**
     * 主动重载控制器（login-window → 控制台 场景的关键兜底）。
     *
     * 实测（2026-09-20）：商汤的会话是 HttpOnly Cookie，`access_token` 只是页面启动时
     * 用会话换取并写进 localStorage 的缓存。如果用户在这条链路的某一跳之后才完成登录，
     * 页面可能不会主动再写一次 token。这时主动 reload 一次控制台，平台就会拿会话 Cookie
     * 换取并写回 token（不会让用户重新登录，也不会顶掉浏览器里的登录态）。
     */
    let reloads = 0
    const CONSENT_RELOAD_LIMIT = 2

    /** 最近一次"看到了登录态但校验没过"的原因（关窗时用来给出准确提示） */
    let lastValidationError = ''

    /** 取当前凭据（token 或 Cookie），并做即时校验；返回 null = 通过 */
    const grabCredential = async (): Promise<{ value: string; error: string | null }> => {
      if (wantToken) {
        const key = opts.tokenKey as string
        let token = await collectToken(win, key)
        let from = 'localStorage.' + key
        if (!token) {
          // 兜底：页面自己请求接口时带的 Authorization 头
          token = await readProbedToken(win)
          from = '网络请求头(Authorization)'
        }
        if (!token) {
          const keys = await describeTokenKeys(win)
          return { value: '', error: '还在等待登录…（没读到登录态；页面上的候选键：' + keys + '）' }
        }
        const err = opts.validateToken ? await opts.validateToken(token) : null
        if (err) {
          lastValidationError = err
          return { value: token, error: err }
        }
        logger.info(`[browser] ${opts.name} 已读到登录态（来源 ${from}，长度 ${token.length}）并通过接口校验`)
        return { value: token, error: null }
      }
      const cookie = await collectCookies(ses, urls)
      if (!cookie) return { value: '', error: '还没抓到登录 Cookie' }
      const err = opts.validate ? await opts.validate(cookie) : null
      return { value: cookie, error: err }
    }

    let settled = false
    let autoClosing = false
    let matchedAt = 0
    /** 已经校验通过的凭据（先落定再关窗，避免关窗途中的竞态） */
    let pendingCredential = ''
    /** 轮询里最近一次的状态（写进日志，便于排查"卡在哪一步"） */
    let lastNote = ''
    let lastNoteAt = 0
    const startedAt = Date.now()

    const closeWin = () => {
      try { win.close() } catch { /* 已关闭 */ }
    }

    // 轮询：URL 进入登录成功页后开始校验，通过就自动关窗
    const poll = async () => {
      // 注意：不再要求必须有 success 规则——平台只要能用「真实接口校验」就能自动关窗
      if (settled || autoClosing) return
      let u = ''
      try { u = win.webContents.getURL() } catch { return }
      let parsed: URL | null = null
      try { parsed = new URL(u) } catch { return }
      // 不再限制窗口停留在哪个域名/路径：登录流程常在小米账号页、验证页之间跳转，
      // 只要会话里出现可用凭据（validate 会用真实接口验证）就关窗。
      if (Date.now() - startedAt < 1500) return
      autoClosing = true
      matchedAt = Date.now()
      logger.info('[browser] ' + opts.name + ' 开始校验登录状态…')
      while (!settled) {
        try {
          const { value, error } = await grabCredential()
          if (value && error === null) {
            try { win.setTitle('登录 ' + opts.name + '（校验通过，即将自动关闭）') } catch { /* 忽略 */ }
            // 先落定结果再关窗：避免"正在关窗时用户手动点了 ×"导致凭据读不到
            settled = true
            pendingCredential = value
            await sleep(400) // 留一点时间给最后一批凭据落盘
            closeWin()
            return
          }
          // 每 5 秒把"当前在哪一步"记一次日志，方便用户/开发者定位卡点（不含凭据内容）
          const now = Date.now()
          if (error && now - lastNoteAt > 5000) {
            lastNoteAt = now
            lastNote = error
            let u = ''
            try { u = win.webContents.getURL() } catch { /* 忽略 */ }
            logger.info(`[browser] ${opts.name} 等待登录中…（当前页面：${u || '未知'}；${error}）`)
            // 已经处在控制台（说明登录已完成）却读不到登录态 → 主动重载一次，让平台把 token 写回 localStorage
            if (wantToken && reloads < CONSENT_RELOAD_LIMIT && u.includes(new URL(opts.url).hostname + '/console')) {
              reloads++
              logger.info(`[browser] ${opts.name} 已在控制台但读不到登录态，主动重载一次以取回登录态（第 ${reloads} 次）`)
              try { void win.loadURL(opts.url) } catch { /* 忽略 */ }
            }
          }
        } catch (e) {
          logger.warn('[browser] 自动校验失败：' + (e as Error).message)
        }
        if (Date.now() - matchedAt > (loginRounds === 1 ? 20000 : 60000)) {
          // 第一轮（复用会话）只等 20 秒：会话还有效的话早就换回 token 了；
          // 超过就清空凭据、进入正常的登录流程，避免用户干等。
          if (loginRounds < MAX_LOGIN_ROUNDS) {
            logger.info(`[browser] ${opts.name} 复用会话未成功（20 秒内没拿到可用登录态），改为清空凭据后正常登录`)
            try { win.setTitle('登录 ' + opts.name + '：请登录（登录完成后窗口会自动关闭）') } catch { /* 忽略 */ }
            matchedAt = Date.now()
            autoClosing = false
            openWith(true)
            return
          }
          let lastUrl = ''
          try { lastUrl = win.webContents.getURL() } catch { /* 忽略 */ }
          logger.warn(`[browser] ${opts.name} 自动检测超时（最后停在：${lastUrl}；${lastNote || '未读到登录态'}）`)
          try { win.setTitle('登录 ' + opts.name + '（还没检测到登录成功：请在窗口里完成登录，进入控制台后会自动关闭）') } catch { /* 忽略 */ }
          break
        }
        await sleep(900)
      }
      autoClosing = false
      try { win.setTitle('登录 ' + opts.name + '（暂未检测到登录成功，可手动关闭或重试）') } catch { /* 忽略 */ }
    }
    const timer = setInterval(() => { void poll() }, 800)

    /** 登录成功后组装续期材料（会话 Cookie + 登录态元信息）；采集失败不影响登录本身 */
    const buildSession = async (credential: string): Promise<CredentialSession | null> => {
      if (!opts.collectSession) return null
      try {
        const s = await opts.collectSession({ cookie: credential, token: credential })
        if (s) {
          logger.info('[browser] ' + opts.name + ' 已采集续期材料（会话 Cookie ' + s.cookies.split('; ').filter(Boolean).length + ' 个）')
        }
        return s
      } catch (e) {
        logger.warn('[browser] ' + opts.name + ' 采集续期材料失败：' + (e as Error).message)
        return null
      }
    }

    win.on('closed', () => {
      clearInterval(timer)
      // 只有"校验通过后主动关窗"这一种情况可以跳过：那时已准备好凭据
      if (settled && pendingCredential) return
      const alreadyValidated = pendingCredential
      settled = true
      void (async () => {
        try {
          if (wantToken) {
            let token = alreadyValidated
            // 关窗后再兜底读一次（页面刚销毁时可能读不到，读不到就用轮询阶段拿到的）
            if (!token) token = await collectToken(win, opts.tokenKey as string)
            if (!token) token = await readProbedToken(win)
            if (!token) {
              const keys = await describeTokenKeys(win)
              logger.warn('[browser] ' + opts.name + ' 关窗时没读到登录态；页面候选键：' + keys)
              resolve({
                ok: false,
                error: '没有读到登录态（' + keys + '）。请确认在弹出的窗口里已经登录进控制台（看到账户总览页）后再关闭窗口'
              })
              return
            }
            if (opts.validateToken) {
              const err = await opts.validateToken(token)
              if (err) {
                logger.warn('[browser] ' + opts.name + ' 登录态校验未通过：' + err)
                resolve({ ok: false, error: err + (lastValidationError && lastValidationError !== err ? '（最近一次：' + lastValidationError + '）' : '') })
                return
              }
            }
            logger.info('[browser] ' + opts.name + ' 登录完成，已获取登录态（token 长度 ' + token.length + '）')
            resolve({ ok: true, cookie: token, session: await buildSession(token) })
            return
          }
          const cookieStr = await collectCookies(ses, urls)
          if (!cookieStr) {
            resolve({ ok: false, error: '没有抓到登录 Cookie，请确认已经登录成功后再关闭窗口' })
            return
          }
          logger.info('[browser] ' + opts.name + ' 登录完成，抓到 ' + cookieStr.split('; ').length + ' 个 Cookie（来源 ' + urls.length + ' 个域名）')
          if (opts.validate) {
            const err = await opts.validate(cookieStr)
            if (err) {
              logger.warn('[browser] ' + opts.name + ' Cookie 校验未通过：' + err)
              resolve({ ok: false, error: err })
              return
            }
          }
          resolve({ ok: true, cookie: cookieStr, session: await buildSession(cookieStr) })
        } catch (e) {
          resolve({ ok: false, error: '读取登录凭据失败：' + (e as Error).message })
        }
      })()
    })

    /**
     * 打开页面（两种策略，最多走两轮）：
     * A. 先**复用**分区里的既有会话（上次登录留下的 Cookie）→ 平台若认这个会话，会自己换出新 token，
     *    轮询读到并通过校验就自动关窗，**用户不用输密码**。这是延长登录有效期的关键。
     * B. 复用失败（没有会话 Cookie / 会话已失效 / 旧 token 校验不通过）→ 清空凭据重开一次，
     *    让用户正常登录（清空是为了避免过期 token 让校验"假通过"，这个坑真实发生过）。
     */
    let loginRounds = 0
    const MAX_LOGIN_ROUNDS = 2

    const openWith = (clearFirst: boolean): void => {
      loginRounds++
      const go = (): void => {
        try {
          void win.loadURL(opts.url)
        } catch (e) {
          logger.warn('[browser] 加载登录页失败：' + (e as Error).message)
        }
      }
      if (!clearFirst) {
        logger.info('[browser] 先尝试复用登录分区里的既有会话（不清空凭据）')
        go()
        return
      }
      void ses
        .clearStorageData({ storages: ['cookies', 'localstorage'] })
        .then(() => logger.info('[browser] 已清空登录窗口的历史凭据（Cookie + localStorage），等待正常登录'))
        .catch((e: unknown) => logger.warn('[browser] 清空历史凭据失败：' + (e as Error).message))
        .finally(go)
    }

    void (async () => {
      let hasSessionCookie = false
      try {
        const all = await ses.cookies.get({})
        hasSessionCookie = all.some(
          (c) => c.name.startsWith('oauth2_') || c.name.startsWith('api-platform_') || c.name === 'passToken'
        )
      } catch { /* 读不到就当没有，走清空路径 */ }
      logger.info('[browser] 打开登录窗口：' + opts.name + '（' + opts.url + '）' + (hasSessionCookie ? ' · 检测到既有会话，先试静默续期' : ''))
      openWith(!hasSessionCookie)
    })()
  })
}

/** Cookie 里出现某名字即视为登录成功（mimo / 智谱的会话标识） */
/**
 * 通用校验：拿 Cookie 真实请求一次业务接口，能通才算登录成功。
 * 好处是完全不依赖 Cookie 名字与登录后跳转路径——平台改名/改版都不受影响。
 */
export function validateByUrl(url: string, opts?: { okStatuses?: number[] }): (cookie: string) => Promise<string | null> {
  const okSet = new Set(opts?.okStatuses ?? [200])
  return async (cookie) => {
    try {
      const r = await fetch(url, {
        headers: { Cookie: cookie, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000)
      })
      if (okSet.has(r.status)) return null
      if (r.status === 401 || r.status === 403) return '还在等待登录…（接口返回 ' + r.status + '）'
      return '接口返回 ' + r.status + '，请确认已登录成功'
    } catch (e) {
      return '校验请求失败：' + (e as Error).message
    }
  }
}

export function cookieHas(name: string): (cookie: string) => Promise<string | null> {
  return async (cookie) => (cookie.indexOf(name + '=') >= 0 ? null : '还在等待登录…')
}

/**
 * 商汤日日新登录态校验：用抓到的 token 真实调一次额度接口，能通才算登录成功。
 * 这样不依赖页面上出现的任何文案，也不怕平台改版。
 */
export async function validateSenseNovaToken(token: string): Promise<string | null> {
  try {
    const r = await fetch(SENSENOVA_POOL_USAGE_URL, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000)
    })
    if (r.status === 200) return null
    if (r.status === 401 || r.status === 403) return '还在等待登录…（额度接口返回 ' + r.status + '）'
    return '额度接口返回 ' + r.status + '，请确认已经在控制台里登录成功'
  } catch (e) {
    return '校验请求失败：' + (e as Error).message
  }
}

/**
 * MiniMax 抓完 Cookie 后的即时校验：先试 .com 再试 .cn，任一通过即算成功。
 * 避免把「没真正登录成功」（验证码拦着 / 还没进控制台就关窗）的 Cookie 存进账号。
 */
export async function validateMinimaxCookie(cookie: string): Promise<string | null> {
  const bases = [MINIMAX_BACKEND, MINIMAX_BACKEND_CN]
  let last = ''
  for (const base of bases) {
    try {
      const r = await fetch(base + '/backend/account', {
        headers: { Cookie: cookie, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000)
      })
      const txt = await r.text()
      if (r.status === 200) {
        try {
          const j = JSON.parse(txt) as { base_resp?: { status_code?: number; status_msg?: string } }
          if (j.base_resp && j.base_resp.status_code === 0) return null
          last = String(j.base_resp?.status_msg ?? 'code ' + j.base_resp?.status_code)
        } catch {
          last = '接口返回的不是 JSON'
        }
      } else {
        last = 'HTTP ' + r.status
      }
    } catch {
      last = '网络不通'
    }
  }
  return '接口校验未通过（' + (last || 'not login') + '），请确认窗口里已经登录进控制台后再关闭'
}
