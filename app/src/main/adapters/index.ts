import { aliyunAdapter } from './aliyun'
import { minimaxAdapter } from './minimax'
import { mimoPlanAdapter } from './mimo-plan'
import { zhipuAdapter } from './zhipu'
import type { AccountType } from '../../shared/types'
import { AdapterError } from '../errors'
import { customAdapter } from './custom'
import { deepseekAdapter } from './deepseek'
import { mimoAdapter } from './mimo'
import { newapiAdapter } from './newapi'
import { siliconflowAdapter } from './siliconflow'
import type { Adapter } from './types'

/**
 * 平台适配器注册表（等价于 Python 原型的 PROVIDERS 字典）。
 * 新增平台 = 新增一个文件 + 在这里注册一行，界面无需改代码。
 */
export const PROVIDERS: Record<AccountType, Adapter> = {
  deepseek: deepseekAdapter,
  siliconflow: siliconflowAdapter,
  newapi: newapiAdapter,
  custom: customAdapter,
  mimo: mimoAdapter,
  'mimo-plan': mimoPlanAdapter,
  minimax: minimaxAdapter,
  zhipu: zhipuAdapter,
  aliyun: aliyunAdapter
}

/** 取某类型的适配器；未知类型抛 UNKNOWN_TYPE（界面显示"未知的平台类型"） */
export function getAdapter(type: string): Adapter {
  const adapter = PROVIDERS[type as AccountType]
  if (!adapter) throw new AdapterError('UNKNOWN_TYPE', type)
  return adapter
}
