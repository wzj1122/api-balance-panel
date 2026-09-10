import type { Account, BalanceResult } from '../../shared/types'

/**
 * 适配器统一接口。
 *
 * 每家的「取数脚本」都实现这个签名：拿到账号配置，取回明文密钥，发请求，
 * 解析出余额，返回一个统一的 BalanceResult。新增平台 = 新增一个文件 + 在
 * index.ts 的 PROVIDERS 里注册一行，其余代码不动。
 */

/** 适配器运行所需的上下文（由 query.ts 注入） */
export interface AdapterContext {
  /** 取账号的明文密钥。明文只存在于主进程内存，绝不跨 IPC 传输。 */
  getSecret: (account: Account) => string
}

/**
 * 适配器函数签名。
 * 成功返回 ok:true 的 BalanceResult；
 * 失败**抛 AdapterError**（只带错误码，人话文案由 errors.ts 统一产出）。
 */
export type Adapter = (account: Account, ctx: AdapterContext) => Promise<BalanceResult>
