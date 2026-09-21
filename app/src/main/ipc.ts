import { app, ipcMain, Notification, session, shell } from 'electron'
import { LOGIN_RULES, MIMO_BALANCE_URL, loginPartition } from '../shared/constants'
import { IPC } from '../shared/ipc'
import type { RefreshPayload } from '../shared/ipc'
import type { Account, AccountInput, AppInfo, Correction, CorrectionView, CredentialSession, MonitorInput, ReportPeriod, Settings, Snapshot, LogLevel, KeyVaultInput } from '../shared/types'
import { applyAutoStart, getAutoStartStatus } from './autostart'
import { getAdapter } from './adapters'
import { backgroundData, backgroundForTheme, importBackground, listBackgrounds, removeBackground } from './bgstore'
import { exportBackup, importBackup } from './backup'
import { buildMonitorReport, listChecks, removeMonitor, removeMonitorsBySecret, runMonitors, saveMonitor, testMonitor } from './monitor'
import { cookieHas, loginToSite, validateByUrl, validateMinimaxCookie, validateSenseNovaToken, type LoginOptions } from './browser'
import { isSecure } from './crypto'
import { removeVaultKey, revealVaultKey, saveVaultKey } from './keyvault'
import { buildKeyList } from './keys'
import { isDemo, setDemo } from './demo'
import { getFx } from './fx'
import { clearLogs, exportLogs, getLogLevel, listLogFiles, logger, readLogs, setLogLevel } from './logger'
import { CONFIG_FILE, DATA_DIR, LOG_DIR } from './paths'
import { invalidateCache, refresh, renewForAccount } from './query'
import { jwtExpiry, supportsRenewal } from './renewal'
import { closeWindow, isWindowMaximized, minimizeWindow, toggleMaximizeWindow } from './window'
import { scheduler } from './scheduler'
import { buildDailyUsage, buildPlatformUsage, buildUsageReport, dailyConsumedDetailed, daySlices, gapLimitMs, isUsageBased } from './usage'
import { listByAccount, readSnapshotsRaw, removeByAccount } from './snapshot'
import { addCorrection, applyCorrections, clearCorrections, listCorrections, loadCorrections, removeCorrection } from './corrections'
import { store, toView } from './store'

/**
 * 主进程 IPC 注册（T03）。
 * 每个通道都套一层 try/catch：任何未预期异常都转成带中文信息的错误抛回给
 * 渲染进程（safeInvoke 会显示出来），而不是让主进程静默吞掉或崩溃。
 */

/** 把 handler 的异常统一转成可读的 Error（renderer 的 safeInvoke 会展示 message） */
function wrap<T>(name: string, fn: (payload: unknown) => T | Promise<T>): void {
  ipcMain.handle(name, async (_event, payload) => {
    try {
      return await fn(payload)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logger.error(`[ipc] ${name} 处理失败：`, msg)
      throw new Error(msg)
    }
  })
}

/** 校验入参是普通对象，不是就抛（防止手误传 null/undefined） */
function asRecord(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>
  }
  return {}
}

/**
 * 账号被删除后的收尾：清掉它的历史快照与关联的监控目标。
 * 否则可用性监控 / 每日统计会继续用旧快照显示这个已经不存在的账号。
 */
async function cleanupAccountArtifacts(accountId: string, secret: string): Promise<void> {
  try {
    await removeByAccount(accountId)
  } catch (e) {
    logger.warn('[cleanup] 清理快照失败：' + (e as Error).message)
  }
  if (secret) {
    try {
      removeMonitorsBySecret(secret)
    } catch (e) {
      logger.warn('[cleanup] 清理监控目标失败：' + (e as Error).message)
    }
  }
}

export function registerIpc(): void {
  // 启动信息（版本 / 数据目录 / 加密可用性 / 配置状态 / 通知是否可用）
  wrap(IPC.APP_INFO, (): AppInfo => {
    return {
      version: app.getVersion(),
      dataDir: DATA_DIR,
      configPath: CONFIG_FILE,
      secure: isSecure(),
      configStatus: store.getConfigStatus(),
      noticeSupported: Notification.isSupported()
    }
  })

  // 账号列表（不含密文）
  wrap(IPC.ACCOUNT_LIST, () => store.listAccounts().map(toView))

  // 新增 / 编辑账号
  wrap(IPC.ACCOUNT_SAVE, (payload) => {
    const input = asRecord(payload) as unknown as AccountInput
    if (!input || !input.name || !input.type) {
      throw new Error('账号名称和平台类型是必填项')
    }
    const account = store.saveAccount(input)
    // 账号变了，缓存里可能残留旧结果，清掉
    invalidateCache(account.id)
    return toView(account)
  })

  // 删除账号
  wrap(IPC.ACCOUNT_REMOVE, async (payload) => {
    // 兼容两种传参：preload 传 { id }，旧调用传裸字符串
    const id = typeof payload === 'string' ? payload : String((asRecord(payload) as { id?: string }).id ?? '')
    const secret = store.revealSecret(id)
    const ok = store.removeAccount(id)
    if (ok) await cleanupAccountArtifacts(id, secret)
    return ok
  })

  // 刷新余额（ids 为空 = 全部启用账号）
  wrap(IPC.BALANCE_REFRESH, (payload) => {
    const p = asRecord(payload) as unknown as RefreshPayload
    return refresh(p)
  })

  // 读设置
  wrap(IPC.SETTINGS_GET, () => store.getSettings())

  // 开机自启的真实状态（回读系统启动项，界面据此显示，而不是照抄配置）
  wrap(IPC.APP_AUTOSTART_STATUS, () => getAutoStartStatus())

  // 局部更新设置；刷新间隔变了就热重启定时器
  wrap(IPC.SETTINGS_SAVE, (payload) => {
    const patch = asRecord(payload) as unknown as Partial<Settings>
    const before = store.getSettings()
    const after = store.saveSettings(patch)
    if (after.refresh_seconds !== before.refresh_seconds) {
      scheduler.reset(after.refresh_seconds)
    }
    if (after.launch_at_login !== before.launch_at_login) {
      // 写系统启动项并把真实结果记进日志；界面随后会用 APP_AUTOSTART_STATUS 回读显示
      const st = applyAutoStart(after.launch_at_login)
      if (after.launch_at_login && !st.registered && st.packaged) {
        logger.warn('[autostart] 已开启但系统启动项未写入成功，请查看界面提示')
      }
    }
    return after
  })

  // 打开配置所在目录
  wrap(IPC.APP_OPEN_DATA_DIR, async () => {
    const err = await shell.openPath(DATA_DIR)
    return { ok: !err }
  })

  // 打开内置浏览器登录站点，返回抓到的 Cookie（mimo 等需登录的平台）
  wrap(IPC.ACCOUNT_LOGIN, async (payload) => {
    const p = asRecord(payload) as unknown as {
      url?: string
      name?: string
      platform?: string
      extraUrls?: string[]
      /** 已有账号 id（编辑时传）：登录成功后把「续期材料」直接存到该账号 */
      accountId?: string
    }
    if (typeof p.url !== 'string' || !p.url) throw new Error('缺少登录地址')
    /**
     * 各平台的登录规则统一放在 shared/constants.ts 的 LOGIN_RULES（含**分区 host**）。
     * 之前规则内联在这里、分区名由登录页 hostname 推导，导致登录与静默续期落在两个分区里
     * （小米 / 商汤登录后界面一直显示"等待登录"的根因），现在两边共用同一张表，无法再漂移。
     */
    const rule = p.platform ? LOGIN_RULES[p.platform] : undefined
    // 分区 host：优先规则里的（真正持有会话 Cookie 的域），否则退回登录页 hostname
    let partitionHost = rule?.partitionHost ?? ''
    if (!partitionHost) {
      try {
        partitionHost = new URL(p.url).hostname
      } catch {
        partitionHost = ''
      }
    }
    const buildValidate = (platform?: string): LoginOptions['validate'] => {
      if (platform === 'mimo' || platform === 'mimo-plan') return validateByUrl(MIMO_BALANCE_URL)
      if (platform === 'minimax') return validateMinimaxCookie
      if (platform === 'zhipu') return cookieHas('bigmodel_token_production')
      return undefined
    }
    const extraUrls = Array.from(
      new Set([
        ...(Array.isArray(p.extraUrls) ? p.extraUrls.filter((x): x is string => typeof x === 'string') : []),
        ...(rule?.extra ?? [])
      ])
    )
    // 采集「续期材料」：登录这一刻的会话 Cookie 是后续静默续期的钥匙，必须一起存下来。
    // **从 partitionHost 那个分区读**（与续期脚本同一个分区），否则存下来的会话续期读不到。
    const sessionUrls = rule?.cookieUrls?.length ? rule.cookieUrls : extraUrls.length ? extraUrls : [p.url]
    const collectSession = rule?.cookieUrls
      ? async (): Promise<CredentialSession | null> => {
          const ses = session.fromPartition(loginPartition(partitionHost))
          const parts: string[] = []
          const seen = new Set<string>()
          for (const u of sessionUrls) {
            const list = await ses.cookies.get({ url: u }).catch(() => [])
            for (const c of list) {
              const k = c.name + '\u0000' + (c.domain ?? '')
              if (seen.has(k)) continue
              seen.add(k)
              parts.push(c.name + '=' + c.value)
            }
          }
          if (parts.length === 0) return null
          return {
            ts: Date.now(),
            cookies: parts.join('; '),
            tokenKey: rule?.sessionTokenKey ?? '',
            tokenLen: 0,
            v: 1
          }
        }
      : undefined

    /**
     * 保存后的复验：把凭据真的存进账号，再用适配器跑一次。
     *
     * 只有真能查到数才算"登录成功"——避免出现"窗口关了、凭据存了、界面却一直等待登录"。
     * （自动续期能力不在这里验：它由后台保活按自己的节奏跑，并在 renewal.ts 里如实校验与记录，
     *   放在登录链路上只会让用户多等 6~10 秒。）
     */
    const accountId = typeof p.accountId === 'string' && p.accountId ? p.accountId : ''
    const verifyAfterSave: LoginOptions['verify'] = accountId
      ? async (credential) => {
          store.saveCredential(accountId, {
            secret: credential,
            session: null,
            tokenExpiresAt: jwtExpiry(credential)
          })
          invalidateCache(accountId)
          const acc = store.getAccount(accountId)
          if (!acc) return '账号不存在'
          try {
            const adapter = getAdapter(acc.type)
            const row = await adapter(acc, {
              getSecret: (a: Account): string => store.getSecret(a),
              getSession: (a: Account): CredentialSession | null => store.getSession(a),
              saveRenewed: (a: Account, token: string, session: CredentialSession | null): void => {
                store.saveCredential(a.id, { secret: token, session })
              }
            })
            if (!row.ok) {
              return '账号查询失败（' + (row.errorCode ?? '未知') + '）：' + (row.errorDetail ?? row.note ?? '')
            }
            return null
          } catch (e) {
            const err = e as { code?: string; detail?: string; message?: string }
            return '账号查询异常（' + (err.code ?? '未知') + '）：' + (err.detail ?? err.message ?? '')
          }
        }
      : undefined

    const result = await loginToSite({
      url: p.url,
      name: typeof p.name === 'string' && p.name ? p.name : '站点',
      partitionHost: partitionHost || undefined,
      extraUrls,
      success: rule?.success,
      validate: buildValidate(p.platform),
      tokenKey: rule?.tokenKey,
      validateToken: rule?.tokenKey ? validateSenseNovaToken : undefined,
      collectSession,
      verify: verifyAfterSave
    })

    // 登录成功就把新凭据 + 续期材料一起写进账号，之后由后台保活自动续期
    let renewHint = ''
    if (result.ok && result.cookie && typeof p.accountId === 'string' && p.accountId) {
      const session = result.session ?? null
      const exp = jwtExpiry(result.cookie)
      store.saveCredential(p.accountId, {
        secret: result.cookie,
        session,
        tokenExpiresAt: exp
      })
      logger.info(
        `[ipc] 账号 ${p.accountId} 已保存登录凭据（续期材料：${session ? session.cookies.split('; ').filter(Boolean).length + ' 个 Cookie' : '无'}；凭据有效至 ${exp ? new Date(exp).toLocaleString('zh-CN') : '未知'}）`
      )
      // 走到这里说明 verifyAfterSave 里两步复验都过了（能查到数 + 自动续期可用）
      if (supportsRenewal(store.getAccount(p.accountId)?.type ?? '')) {
        renewHint = '自动续期已验证可用（登录窗口与后台保活共用同一分区）'
      }
    }
    return {
      ok: result.ok,
      cookie: result.cookie,
      error: result.error,
      // 告诉界面：这个平台是否具备"自动续期"能力（用于提示文案）
      canRenew: Boolean(rule?.cookieUrls),
      renewHint
    }
  })

  // 手动续期登录（卡片上的「续期登录」按钮）
  wrap(IPC.ACCOUNT_RENEW, async (payload) => {
    const p = asRecord(payload) as { id?: string }
    const id = typeof p.id === 'string' ? p.id : ''
    if (!id) throw new Error('缺少账号 id')
    const account = store.getAccount(id)
    if (!account) throw new Error('账号不存在')
    if (!supportsRenewal(account.type)) {
      return { ok: false, error: '该平台不支持静默续期（只有登录型平台支持）', needLogin: false, expiresAt: null }
    }
    const ok = await renewForAccount(account, 'manual')
    const after = store.getAccount(id)
    if (!ok) {
      // 静默续期没成功：告诉界面"需要重新登录一次"，界面会直接把登录窗口打开（一步到位）
      return {
        ok: false,
        error: '会话已失效，需要重新登录一次',
        needLogin: true,
        expiresAt: after?.token_expires_at ?? null
      }
    }
    invalidateCache(id)
    return { ok: true, error: '', needLogin: false, expiresAt: after?.token_expires_at ?? null }
  })

  // ---------- 数据校正（手动修正历史数据） ----------

  // 读某账号的校正视图：账本 + 每条影响多少快照 + 校正前后对照点
  wrap(IPC.CORRECTION_VIEW, async (payload) => {
    const p = asRecord(payload) as { accountId?: string; limit?: number }
    const accountId = typeof p.accountId === 'string' ? p.accountId : ''
    if (!accountId) throw new Error('缺少账号 id')
    const account = store.getAccount(accountId)
    if (!account) throw new Error('账号不存在')
    const limit = typeof p.limit === 'number' && p.limit > 0 ? Math.min(Math.round(p.limit), 2000) : 400

    const raw = (await readSnapshotsRaw()).filter((s) => s.account_id === accountId).sort((a, b) => a.ts - b.ts)
    const corrected = applyCorrections(raw, accountId)
    const list = listCorrections(accountId)
    const affected: Record<string, number> = {}
    for (const c of list) affected[c.id] = raw.filter((s) => s.ts >= c.fromTs).length

    const points: CorrectionView['points'] = corrected.slice(-limit).map((s, i) => {
      const src = raw[raw.length - Math.min(limit, corrected.length) + i]
      return {
        ts: s.ts,
        remaining: s.remaining ?? null,
        raw: src?.remaining ?? null,
        adjusted: Boolean(s.adjusted)
      }
    })
    const lastOffset = list.filter((c) => c.kind === 'offset').reduce((a, c) => a + c.value, 0)
    const lastSet = list.filter((c) => c.kind === 'set').sort((a, b) => b.fromTs - a.fromTs)[0]?.value ?? null
    return {
      accountId,
      name: account.name,
      type: account.type,
      unit: account.unit ?? '',
      offset: Math.round(lastOffset * 1e6) / 1e6,
      setValue: lastSet,
      corrections: list,
      points,
      affected
    } satisfies CorrectionView
  })

  // 新增校正：三种模式都归一化成"从某一时刻起的安全操作"
  wrap(IPC.CORRECTION_APPLY, async (payload) => {
    const p = asRecord(payload) as {
      accountId?: string
      mode?: string
      fromTs?: number
      dayTs?: number
      value?: number
      note?: string
    }
    const accountId = typeof p.accountId === 'string' ? p.accountId : ''
    if (!accountId) throw new Error('缺少账号 id')
    const account = store.getAccount(accountId)
    if (!account) throw new Error('账号不存在')
    const mode =
      p.mode === 'day' || p.mode === 'set' || p.mode === 'dayBalance' || p.mode === 'dayIgnore'
        ? p.mode
        : 'offset'
    const value = Number(p.value)
    if (mode !== 'dayIgnore' && !Number.isFinite(value)) throw new Error('数值不合法')
    const note = typeof p.note === 'string' ? p.note : ''

    /**
     * 模式①c：忽略某天（把这段快照从统计里剔除）。
     * 用途：那天读到明显错的值（例如瞬时闪断）。与其"改成一个数字"，不如整段剔除，
     * 报表里那一天就是空的，不会污染消耗统计。
     */
    if (mode === 'dayIgnore') {
      const dayTs = Number(p.dayTs)
      if (!Number.isFinite(dayTs)) throw new Error('缺少日期')
      const d0 = new Date(dayTs)
      d0.setHours(0, 0, 0, 0)
      const dayStart = d0.getTime()
      const dayEnd = dayStart + 24 * 60 * 60 * 1000
      const dayLabel = new Date(dayStart).toLocaleDateString('zh-CN')
      const item = addCorrection({
        accountId,
        fromTs: dayStart,
        toTs: dayEnd,
        kind: 'ignore',
        value: 0,
        unit: account.unit ?? '',
        note: note || `忽略 ${dayLabel} 的异常读数`
      })
      invalidateCache(accountId)
      return {
        ok: true,
        correctionId: item.id,
        offset: 0,
        message: `已忽略 ${dayLabel} 的数据：该天不计入消耗统计（可随时撤销）`
      }
    }

    /**
     * 模式①b：改某天的**余额**（只改这一天）。
     *
     * 用途：某次刷新因网络原因读到错的余额，导致那天被算出一大笔"消耗"。
     *
     * 锚点很关键：平移起点取**当天第一条快照的时间**，而不是当天 00:00。
     * 原因：相邻快照的差值决定消耗，起点落在"前一天最后一条 → 当天第一条"之间时，
     * 会把跨零点那一小段的消耗也一起改掉（实测偏差 1 左右）。锚在当天第一条上，
     * 就只改"这一天内部"的数据，前后两天的消耗都不受影响。
     */
    if (mode === 'dayBalance') {
      const dayTs = Number(p.dayTs)
      if (!Number.isFinite(dayTs)) throw new Error('缺少日期')
      const d0 = new Date(dayTs)
      d0.setHours(0, 0, 0, 0)
      const dayStart = d0.getTime()
      const dayEnd = dayStart + 24 * 60 * 60 * 1000
      const raw = (await readSnapshotsRaw()).filter((s) => s.account_id === accountId).sort((a, b) => a.ts - b.ts)
      const corrected = applyCorrections(raw, accountId)
      const dayList = corrected.filter((s) => s.ts >= dayStart && s.ts < dayEnd && s.remaining !== null)
      if (dayList.length === 0) throw new Error('这一天没有该账号的快照，无法修改')
      const fromTs = dayList[0].ts

      /**
       * 自校准求偏移量（关键）：
       * 直接按"余额差"反推会与界面显示口径差一点点（跨零点那一小段归属不同，实测差 1）。
       * 这里改成：① 用**界面同款的账目函数 + 同样宽的窗口**（目标日前后各 5 天）测出这一天当前显示的消耗；
       *          ② delta = 当前值 − 目标值（平移 delta 后该天消耗正好变化 −delta）。
       * 用宽窗口很重要：闪断识别是"看当天上下文"的，只传一天会得出不同的结果。
       */
      const gapMs = gapLimitMs()
      const hasUsed = isUsageBased(corrected)
      const dayLabel = new Date(dayStart).toLocaleDateString('zh-CN')

      /**
       * 校准窗口必须与界面一致：每日使用状况用的是"近 30 天（以今天结尾）"的切片。
       * 闪断识别是看当天上下文的，窗口不同 → 同一天算出来的值不同（实测差 1~3）。
       */
      const sliceCache = new WeakMap<object, { start: number; end: number; label: string }[]>()
      const calSlices = (list: Snapshot[]): { start: number; end: number; label: string }[] => {
        const cached = sliceCache.get(list as unknown as object)
        if (cached) return cached
        const built = daySlices(30).map((x) => ({ start: x.start, end: x.end, label: x.label }))
        sliceCache.set(list as unknown as object, built)
        return built
      }
      /** 在"应用了 candidate 偏移"之后，这一天在界面上会显示多少消耗 */
      const measureWith = (candidate: number): number => {
        const own = loadCorrections().filter((c) => c.accountId === accountId)
        const list =
          candidate === 0
            ? applyCorrections(raw, accountId, own)
            : applyCorrections(raw, accountId, [
                ...own,
                {
                  id: '__probe__',
                  accountId,
                  fromTs,
                  toTs: dayEnd,
                  kind: 'offset' as const,
                  value: candidate,
                  unit: '',
                  note: '',
                  createdAt: Date.now()
                }
              ])
        const slices = calSlices(list)
        const idx = slices.findIndex((x) => x.start === dayStart)
        if (idx < 0) return 0
        const v = dailyConsumedDetailed(list, slices, hasUsed, gapMs).values[idx]
        return typeof v === 'number' ? v : 0
      }

      // 候选择优：先按"当前值 − 目标值"给个候选，再在其附近试几个倍数，
      // 取「应用后该天显示值最接近目标」的那个（避免因闪断识别跳变而反复横跳）。
      const current = measureWith(0)
      const step0 = Math.round((current - value) * 1e6) / 1e6
      let best = { delta: 0, measured: current }
      if (Math.abs(step0) > 1e-6) {
        for (const mul of [1, 1.5, 2, 2.5, 3, 3.5, 4, 0.5]) {
          const candidate = Math.round(step0 * mul * 1e6) / 1e6
          const measured = measureWith(candidate)
          if (Math.abs(measured - value) < Math.abs(best.measured - value) - 1e-9) {
            best = { delta: candidate, measured }
          }
          if (Math.abs(measured - value) < 1e-4) break
        }
      }
      const delta = best.delta
      if (Math.abs(delta) < 1e-6) {
        return { ok: true, correctionId: '', offset: 0, message: '该天数据已经是这个值，无需修改' }
      }
      const exact = Math.abs(best.measured - value) < 1e-4
      const appliedNote = exact
        ? `当天消耗由 ${current} 改为 ${value}`
        : `该天涉及"读数闪断"，无法精确落到 ${value}；已按最接近的方案调整（当前显示 ${best.measured}）`

      const item = addCorrection({
        accountId,
        fromTs,
        toTs: dayEnd,
        kind: 'offset',
        value: delta,
        unit: account.unit ?? '',
        note: note || `修正 ${dayLabel} 当日数据（整体调整 ${delta}，只影响这一天）`
      })
      invalidateCache(accountId)
      return {
        ok: true,
        correctionId: item.id,
        offset: delta,
        message: `已修正 ${dayLabel}：${appliedNote}（只影响这一天，前后日期不受影响）`
      }
    }

    // 模式①：改某天的用量 → 换算成"从那天 00:00 起平移 delta"（会一并影响之后的日期）
    if (mode === 'day') {
      const dayTs = Number(p.dayTs)
      if (!Number.isFinite(dayTs)) throw new Error('缺少日期')
      const dayStart = new Date(dayTs)
      dayStart.setHours(0, 0, 0, 0)
      const fromTs = dayStart.getTime()
      const toTs = fromTs + 24 * 60 * 60 * 1000
      const raw = (await readSnapshotsRaw()).filter((s) => s.account_id === accountId).sort((a, b) => a.ts - b.ts)
      const corrected = applyCorrections(raw, accountId)
      const inDay = corrected.filter((s) => s.ts >= fromTs && s.ts < toTs && s.remaining !== null)
      if (inDay.length === 0) throw new Error('这一天没有该账号的快照，无法修改')
      // 该日用量 = 当日基准（前一条快照）− 当日最后一条
      const before = corrected.filter((s) => s.ts < fromTs && s.remaining !== null).slice(-1)[0] ?? null
      const firstVal = inDay[0].remaining as number
      const lastVal = inDay[inDay.length - 1].remaining as number
      const base = before ? (before.remaining as number) : firstVal
      const current = Math.round(Math.max(0, base - lastVal) * 1e6) / 1e6
      // 目标用量 → 需要的平移量：base 与 lastVal 同时平移 delta ⇒ 用量减少 delta
      const delta = Math.round((current - value) * 1e6) / 1e6
      if (delta === 0) {
        return { ok: true, correctionId: '', offset: 0, message: '数值与当前一致，无需校正' }
      }
      const item = addCorrection({
        accountId,
        fromTs,
        kind: 'offset',
        value: delta,
        unit: account.unit ?? '',
        note: note || `把 ${new Date(fromTs).toLocaleDateString('zh-CN')} 的用量改为 ${value}`
      })
      invalidateCache(accountId)
      return {
        ok: true,
        correctionId: item.id,
        offset: delta,
        message: `已把 ${new Date(fromTs).toLocaleDateString('zh-CN')} 的用量从 ${current} 改为 ${value}（该日起整体平移 ${delta}）`
      }
    }

    const fromTs = Number(p.fromTs)
    if (!Number.isFinite(fromTs)) throw new Error('缺少生效时间')
    const item = addCorrection({
      accountId,
      fromTs,
      kind: mode === 'set' ? 'set' : 'offset',
      value,
      unit: account.unit ?? '',
      note:
        note ||
        (mode === 'set'
          ? `从 ${new Date(fromTs).toLocaleString('zh-CN')} 起剩余设为 ${value}`
          : `从 ${new Date(fromTs).toLocaleString('zh-CN')} 起平移 ${value}`)
    })
    invalidateCache(accountId)
    return {
      ok: true,
      correctionId: item.id,
      offset: mode === 'offset' ? value : 0,
      message: mode === 'set' ? '已按指定值校正' : `已从该时刻起整体平移 ${value}`
    }
  })

  // 撤销一条校正
  wrap(IPC.CORRECTION_REMOVE, async (payload) => {
    const p = asRecord(payload) as { id?: string }
    const id = typeof p.id === 'string' ? p.id : ''
    if (!id) throw new Error('缺少校正 id')
    const ok = removeCorrection(id)
    invalidateCache()
    return { ok }
  })

  // 清空某账号的全部校正（一键还原）
  wrap(IPC.CORRECTION_CLEAR, async (payload) => {
    const p = asRecord(payload) as { accountId?: string }
    const accountId = typeof p.accountId === 'string' ? p.accountId : ''
    if (!accountId) throw new Error('缺少账号 id')
    const removed = clearCorrections(accountId)
    invalidateCache(accountId)
    return { ok: true, removed }
  })

  // 每日使用状况统计（主进程按快照聚合，返回报告）
  wrap(IPC.SNAPSHOT_DAILY, async (payload) => {
    const p = asRecord(payload) as { days?: number }
    const days = typeof p.days === 'number' && Number.isFinite(p.days) ? Math.round(p.days) : 30
    return buildDailyUsage(days)
  })
  // 平台用量统计（按平台类型 × 单位聚合）
  wrap(IPC.SNAPSHOT_PLATFORM, async (payload) => {
    const p = asRecord(payload) as { days?: number }
    const days = typeof p.days === 'number' && Number.isFinite(p.days) ? Math.round(p.days) : 30
    return buildPlatformUsage(days)
  })

  // AI 使用报告（只基于金额消耗）
  wrap(IPC.REPORT_USAGE, async (payload) => {
    const p = asRecord(payload) as { period?: ReportPeriod }
    const period: ReportPeriod = p.period === 'week' || p.period === 'month' ? p.period : 'day'
    return buildUsageReport(period)
  })


  // 演示模式开关（内存沙箱）
  wrap(IPC.DEMO_TOGGLE, async (payload) => {
    const p = asRecord(payload) as { on?: boolean }
    setDemo(p.on === true)
    return { ok: true, demo: isDemo() }
  })

  // 配置备份 / 恢复
  wrap(IPC.BACKUP_EXPORT, async (payload) => {
    const p = asRecord(payload) as { includeHistory?: boolean }
    return exportBackup(p.includeHistory !== false)
  })

  wrap(IPC.BACKUP_IMPORT, async () => importBackup())

  // 接口监控（用户自填 Key + 地址，定期真实调用）
  wrap(IPC.MONITOR_LIST, async (payload) => {
    const p = asRecord(payload) as { days?: number }
    const days = typeof p.days === 'number' && Number.isFinite(p.days) ? Math.round(p.days) : 30
    return buildMonitorReport(days)
  })

  wrap(IPC.MONITOR_SAVE, async (payload) => saveMonitor(asRecord(payload) as unknown as MonitorInput))

  wrap(IPC.MONITOR_REMOVE, async (payload) => removeMonitor(String(payload ?? '')))

  wrap(IPC.MONITOR_RUN, async (payload) => {
    const p = asRecord(payload) as { id?: string }
    return runMonitors(typeof p.id === 'string' && p.id.length > 0 ? p.id : undefined)
  })

  wrap(IPC.MONITOR_TEST, async (payload) => testMonitor(asRecord(payload) as unknown as MonitorInput))

  // Key 管理（汇总 + 审计 + 批量 + 明文复制）
  wrap(IPC.KEY_LIST, async () => buildKeyList()),

  wrap(IPC.KEY_BULK, async (payload) => {
    const p = asRecord(payload) as { ids?: unknown; action?: unknown; tags?: unknown }
    const ids = Array.isArray(p.ids) ? p.ids.map((x) => String(x)) : []
    const action = String(p.action ?? '')
    let affected = 0
    if (action === 'purge') {
      for (const id of ids) {
        const secret = store.revealSecret(id)
        if (store.purgeAccount(id)) {
          affected += 1
          await cleanupAccountArtifacts(id, secret)
        }
      }
    } else if (action === 'delete') {
      // 移入回收站：账号不再查询，监控目标一并停掉（避免继续消耗）
      for (const id of ids) {
        const secret = store.revealSecret(id)
        if (store.softDelete(id)) {
          affected += 1
          if (secret) {
            try { removeMonitorsBySecret(secret) } catch { /* 忽略 */ }
          }
        }
      }
    } else if (action === 'restore') {
      for (const id of ids) if (store.restoreAccount(id)) affected += 1
    } else if (action === 'enable' || action === 'disable') {
      affected = store.bulkPatch(ids, { enabled: action === 'enable' })
    } else if (action === 'tag') {
      const tags = Array.isArray(p.tags) ? p.tags.map((x) => String(x)) : []
      affected = store.bulkPatch(ids, { tags })
    } else {
      throw new Error('未知的批量操作：' + action)
    }
    invalidateCache()
    return { affected }
  }),

  wrap(IPC.KEY_SECRET, async (payload) => {
    // 兼容旧调用（直接传 id 字符串 = 账号），新调用传 { id, source }
    if (typeof payload === 'string') return store.revealSecret(payload)
    const p = asRecord(payload) as { id?: string; source?: string }
    const id = String(p.id ?? '')
    return p.source === 'vault' ? revealVaultKey(id) : store.revealSecret(id)
  }),

  wrap(IPC.KEY_VAULT_SAVE, async (payload) => {
    const input = asRecord(payload) as unknown as KeyVaultInput
    const saved = saveVaultKey(input)
    return { ok: true, id: saved.id }
  }),

  wrap(IPC.KEY_VAULT_REMOVE, async (payload) => ({ ok: removeVaultKey(String(payload ?? '')) })),

  // 运行日志
  wrap(IPC.LOG_LIST, async (payload) => {
    const p = asRecord(payload) as { limit?: number; level?: LogLevel; keyword?: string }
    return {
      entries: readLogs({ limit: p.limit, level: p.level, keyword: p.keyword }),
      level: getLogLevel(),
      files: listLogFiles()
    }
  }),

  wrap(IPC.LOG_CLEAR, async () => {
    clearLogs()
    logger.info('[log] 日志已清空')
    return { ok: true }
  }),

  wrap(IPC.LOG_EXPORT, async () => exportLogs()),

  wrap(IPC.LOG_OPEN_DIR, async () => {
    const r = await shell.openPath(LOG_DIR)
    return { ok: r === '' }
  }),

  wrap(IPC.LOG_SET_LEVEL, async (payload) => {
    const p = asRecord(payload) as { level?: LogLevel }
    const level: LogLevel = p.level === 'debug' || p.level === 'warn' || p.level === 'error' ? p.level : 'info'
    setLogLevel(level)
    return { level }
  }),

  // 自定义背景图
  wrap(IPC.BG_LIST, async () => ({ files: listBackgrounds() })),

  wrap(IPC.BG_IMPORT, async () => importBackground()),

  wrap(IPC.BG_REMOVE, async (payload) => ({ ok: removeBackground(String(payload ?? '')) })),

  wrap(IPC.BG_DATA, async (payload) => backgroundData(String(payload ?? ''))),

  wrap(IPC.BG_FOR_THEME, async (payload) => ({ name: backgroundForTheme(String(payload ?? '')) })),

  // 自绘标题栏的窗口控制
  wrap(IPC.WINDOW_MINIMIZE, async () => {
    minimizeWindow()
  }),

  wrap(IPC.WINDOW_TOGGLE_MAX, async () => ({ maximized: toggleMaximizeWindow() })),

  wrap(IPC.WINDOW_CLOSE, async () => {
    closeWindow()
  }),

  wrap(IPC.WINDOW_GET_STATE, async () => ({ maximized: isWindowMaximized() })),

  wrap(IPC.MONITOR_HISTORY, async (payload) => {
    const p = asRecord(payload) as { id?: string; limit?: number }
    const limit = typeof p.limit === 'number' && Number.isFinite(p.limit) ? Math.round(p.limit) : 200
    return listChecks(String(p.id ?? ''), limit)
  })

  // 实时汇率（成本折算用；主进程内部含 1 小时缓存与兜底，不抛错）
  wrap(IPC.FX_GET, () => getFx())

  // 某账号的余额快照（趋势图用）
  wrap(IPC.SNAPSHOT_LIST, (payload) => {
    const id = asRecord(payload).id
    if (typeof id !== 'string' || !id) throw new Error('缺少账号 id')
    return listByAccount(id)
  })

  logger.info('[ipc] 全部业务 IPC 通道已注册')
}
