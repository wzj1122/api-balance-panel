import { logger } from './logger'
import { refresh } from './query'

/**
 * 定时自动刷新。
 *
 * 窗口隐藏（最小化）时暂停，回到前台立即补刷一次；设置里改了刷新间隔后
 * 用 reset() 热重启定时器，不用重启应用。
 */
class Scheduler {
  private timer: NodeJS.Timeout | null = null
  private seconds = 300
  private paused = false

  /** 启动定时器（应用启动时调用） */
  start(seconds: number): void {
    this.seconds = seconds
    this.arm()
  }

  /** 修改刷新间隔后热重启定时器 */
  reset(seconds: number): void {
    this.seconds = seconds
    this.arm()
  }

  private arm(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.seconds <= 0) return
    this.timer = setInterval(() => {
      if (this.paused) return
      void this.tick()
    }, this.seconds * 1000)
  }

  private async tick(): Promise<void> {
    try {
      await refresh({})
    } catch (e) {
      logger.error('[scheduler] 定时刷新失败：', (e as Error).message)
    }
  }

  /** 窗口隐藏时调用：暂停刷新 */
  pause(): void {
    this.paused = true
    logger.info('[scheduler] 已暂停定时刷新（窗口隐藏）')
  }

  /** 窗口回到前台时调用：恢复并立刻补刷一次 */
  async resume(): Promise<void> {
    this.paused = false
    logger.info('[scheduler] 已恢复定时刷新，立即补刷一次')
    try {
      await refresh({})
    } catch (e) {
      logger.error('[scheduler] 补刷失败：', (e as Error).message)
    }
  }

  /** 当前是否处于暂停状态 */
  isPaused(): boolean {
    return this.paused
  }

  /** 停止定时器（应用退出前） */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

/** 全局单例 */
export const scheduler = new Scheduler()
