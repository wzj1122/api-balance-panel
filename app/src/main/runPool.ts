/**
 * 简易并发池：最多 limit 个任务同时在跑。
 * 与 Python 原型 ThreadPoolExecutor 语义对齐：任何一个任务失败不影响其它任务。
 * 纯函数、无 electron 依赖，方便独立验证并发语义。
 */

export async function runPool<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = []
  const queue = [...tasks]
  const workerCount = Math.max(1, Math.min(limit, queue.length))
  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length > 0) {
      const task = queue.shift()
      if (!task) break
      results.push(await task())
    }
  })
  await Promise.all(workers)
  return results
}
