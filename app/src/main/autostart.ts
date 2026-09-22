import { execFileSync } from 'node:child_process'
import { app } from 'electron'
import { logger } from './logger'

/**
 * 开机自启（Windows）。
 *
 * 为什么不用 `app.setLoginItemSettings` 一路走到底：
 * 1. Electron 在 Windows 上把登录项写到注册表 Run 键，写入失败**不抛异常**，
 *    调用方无从判断到底成没成（旧实现只记一句「已开启」，实际可能没写进去）；
 * 2. Electron 读回时用的名字是 package.json 的 `name`（api-balance-panel），
 *    而写入用的是 `productName`（API 余额面板）——名字都对不上，读回永远是 false；
 * 3. Windows 任务管理器里「禁用」过某个启动项后会在 StartupApproved\Run 留下记录，
 *    之后再写 Run 键也会被系统当成禁用状态；这条记录只有我们自己清。
 *
 * 因此这里的策略是：先尝试用 Electron 官方 API 写（行为最标准），写完立刻读注册表验证；
 * 验证不过就用 `reg.exe` 直写 Run 键兜底，最后把真实状态回读出来反馈给界面。
 */

/** 登录项 / 注册表里使用的名字：必须与 package.json 的 productName 一致 */
const AUTOSTART_NAME = 'API 余额面板'

/** Run 键（当前用户，不需要管理员权限） */
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
/** 任务管理器「启动」页的启用/禁用记录 */
const APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'

/** 自启状态（回读注册表得到的事实，而不是配置里的期望值） */
export interface AutoStartStatus {
  /** 平台是否支持（仅 Windows 支持当前实现） */
  supported: boolean
  /** 是否已打包（开发模式不会写系统启动项） */
  packaged: boolean
  /** 注册表 Run 键里是否有本程序的启动项 */
  registered: boolean
  /** 注册表里的启动命令行（没有则为空串） */
  command: string
  /** 被任务管理器 / 系统「禁用」过（StartupApproved 标记为关闭） */
  disabledBySystem: boolean
  /** 一句话状态说明（界面直接展示） */
  message: string
}

/** reg.exe 调用（不弹窗、失败不抛给调用方，由返回值体现） */
function runReg(args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync('reg.exe', args, {
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { ok: true, out: String(out) }
  } catch (e) {
    const err = e as { stderr?: string | Buffer; message?: string }
    const detail = err.stderr ? String(err.stderr).trim() : (err.message ?? '')
    return { ok: false, out: detail }
  }
}

/**
 * 启动命令行（就是写进 Run 键的值）。
 * 路径含空格必须加引号，否则系统解析时会把路径截断。
 */
function loginCommand(): string {
  const exe = process.execPath
  return `"${exe}" --open-at-login`
}

/** 从 Run 键的值里解析出可执行文件路径（去掉引号，忽略后面的参数） */
function parseExecutable(command: string): string {
  const s = (command || '').trim()
  if (!s) return ''
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1)
    return end > 0 ? s.slice(1, end) : s.slice(1)
  }
  // 没引号时：按 .exe 截断（路径本身带空格的老式写法）
  const m = /^(.*?\.exe)(\s|$)/i.exec(s)
  return m ? m[1] : s
}

/** 读 Run 键里的本程序启动项（没有返回 ''） */
function readRunValue(name: string = AUTOSTART_NAME): string {
  const r = runReg(['query', RUN_KEY, '/v', name])
  if (!r.ok) return ''
  const m = /REG_SZ\s+(.+)/i.exec(r.out)
  return m ? m[1].trim() : ''
}

/** 写 Run 键（先删再加，避免类型残留） */
function writeRunValue(value: string, name: string = AUTOSTART_NAME): boolean {
  runReg(['delete', RUN_KEY, '/v', name, '/f'])
  const r = runReg(['add', RUN_KEY, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'])
  if (!r.ok) logger.warn(`[autostart] 写入启动项失败：${r.out}`)
  return r.ok
}

/** 清掉「任务管理器禁用」标记：Windows 只要看到这条记录就会拦住启动项 */
function clearApprovedFlag(name: string = AUTOSTART_NAME): void {
  runReg(['delete', APPROVED_KEY, '/v', name, '/f'])
}

/** 任务管理器是否把它标成了「已禁用」 */
function isDisabledBySystem(name: string = AUTOSTART_NAME): boolean {
  const r = runReg(['query', APPROVED_KEY, '/v', name])
  if (!r.ok) return false
  // 值形如 03 00 00 00 ...（偶数/03 开头 = 启用，奇数 02/06 = 禁用）；取第一个字节判断
  const m = /REG_BINARY\s+([0-9a-f\s]+)/i.exec(r.out)
  if (!m) return false
  const first = parseInt(m[1].trim().split(/\s+/)[0] ?? '', 16)
  if (!Number.isFinite(first)) return false
  return first % 2 === 1
}

/** 回读真实状态 */
export function getAutoStartStatus(): AutoStartStatus {
  const packaged = app.isPackaged
  if (process.platform !== 'win32') {
    return {
      supported: false,
      packaged,
      registered: false,
      command: '',
      disabledBySystem: false,
      message: '当前系统不支持在此设置开机自启（仅 Windows 版支持）。'
    }
  }
  const command = readRunValue()
  const registered = command.length > 0
  const disabledBySystem = registered && isDisabledBySystem()
  let message: string
  if (!packaged) {
    message = '开发调试模式不写入系统启动项；安装版（Setup）里开关后立即生效。'
  } else if (registered && disabledBySystem) {
    message = '启动项已写入，但被 Windows「任务管理器 → 启动」标记为禁用，请在任务管理器里启用。'
  } else if (registered) {
    message = '已写入系统启动项，开机后会随系统自动启动（后台托盘运行）。'
  } else {
    message = '未写入系统启动项。开启开关即可自动写入（当前用户，无需管理员权限）。'
  }
  return { supported: true, packaged, registered, command, disabledBySystem, message }
}

/**
 * 设置开机自启：写入 → 校验 → 兜底 → 回读。
 * 返回回读到的真实状态，界面据此显示，不再"假装成功"。
 */
export function applyAutoStart(enabled: boolean): AutoStartStatus {
  if (process.platform !== 'win32' || !app.isPackaged) {
    if (enabled) {
      logger.info(`[autostart] 跳过写入（platform=${process.platform}，packaged=${app.isPackaged}）`)
    }
    return getAutoStartStatus()
  }

  try {
    if (!enabled) {
      app.setLoginItemSettings({ openAtLogin: false, name: AUTOSTART_NAME })
      runReg(['delete', RUN_KEY, '/v', AUTOSTART_NAME, '/f'])
      clearApprovedFlag()
      const st = getAutoStartStatus()
      logger.info(`[autostart] 已关闭开机自启（registered=${st.registered}）`)
      return st
    }

    // 1) 官方 API：写 Run 键 + 清 StartupApproved 标记
    let apiOk = false
    try {
      app.setLoginItemSettings({
        openAtLogin: true,
        name: AUTOSTART_NAME,
        path: process.execPath,
        args: ['--open-at-login']
      })
      apiOk = true
    } catch (e) {
      logger.warn(`[autostart] setLoginItemSettings 失败：${(e as Error).message}`)
    }

    // 2) 校验：注册表里到底有没有
    let command = apiOk ? readRunValue() : ''

    // 3) 兜底：官方 API 没写进去就自己写（reg.exe 直写当前用户 Run 键）
    if (command.length === 0) {
      logger.warn('[autostart] 官方接口未写入启动项，改用注册表直写兜底')
      writeRunValue(loginCommand())
      command = readRunValue()
    }

    // 4) 写入成功但被系统标禁用时，清掉禁用标记
    if (command.length > 0 && isDisabledBySystem()) {
      clearApprovedFlag()
    }

    // 5) 一致性校验：注册的可执行文件必须是当前这个程序（防止写进开发版 / 旧路径）
    if (command.length > 0) {
      const registered = parseExecutable(command)
      if (registered.toLowerCase() !== process.execPath.toLowerCase()) {
        logger.warn(`[autostart] 启动项指向的不是当前程序（${registered}），已改写为 ${process.execPath}`)
        writeRunValue(loginCommand())
      }
    }

    const st = getAutoStartStatus()
    if (st.registered) {
      logger.info(`[autostart] 已开启开机自启：${st.command}${st.disabledBySystem ? '（被系统标记为禁用）' : ''}`)
    } else {
      logger.error('[autostart] 开机自启写入失败：注册表 Run 键中仍无本程序启动项')
    }
    return st
  } catch (e) {
    logger.warn(`[autostart] 设置开机自启失败：${(e as Error).message}`)
    return getAutoStartStatus()
  }
}

/**
 * 启动时校准一次：配置里说开着、但系统启动项被清理掉了（换机器 / 被优化软件清掉）就补写回来。
 * 配置里是关的就什么都不做，避免把用户手动关掉的启动项又"复活"。
 */
export function refreshAutoStart(enabled: boolean): AutoStartStatus {
  const st = getAutoStartStatus()
  if (!enabled || !st.supported || !st.packaged) return st
  if (st.registered && !st.disabledBySystem) return st
  logger.info('[autostart] 配置为开启但系统启动项缺失，正在补写')
  return applyAutoStart(true)
}
