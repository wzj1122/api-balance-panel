import { onMounted, onUnmounted, ref } from 'vue'
import type { AccountInput, AccountView, AppInfo, BalanceRow, Settings } from '@shared/types'
import {
  getAppInfo,
  getSettings,
  listAccounts,
  refreshBalances,
  removeAccount as removeAccountRpc,
  saveAccount as saveAccountRpc,
  saveSettings as saveSettingsRpc,
  subscribeRow,
  subscribeUpdated
} from '@renderer/api/ipc'

/**
 * 面板核心状态机：负责账号 / 余额行 / 设置 / 启动信息 的加载与刷新，
 * 以及订阅主进程推送的余额结果。
 *
 * 状态：accounts / rows / settings / appInfo / loading / refreshingIds / lastUpdated / configBanner
 * 动作：loadAll / refreshAll / refreshOne / saveAccount / removeAccount / saveSettings
 */
export function usePanel() {
  const accounts = ref<AccountView[]>([])
  const rows = ref<BalanceRow[]>([])
  const settings = ref<Settings | null>(null)
  const appInfo = ref<AppInfo | null>(null)
  const loading = ref(false)
  /** 正在刷新中的账号 id 集合，控制按钮禁用 */
  const refreshingIds = ref<Set<string>>(new Set())
  /** 最近一次整批刷新完成的时间戳，状态行"更新于 HH:mm:ss"用 */
  const lastUpdated = ref<number | null>(null)
  /** 配置损坏 / 降级存储 横幅文案，空 = 不显示 */
  const configBanner = ref<string>('')

  let unsubRow: (() => void) | null = null
  let unsubUpdated: (() => void) | null = null
  /** 整批刷新进行中标记，收到 balance:updated 时统一清掉 refreshingIds */
  let batchPending = false

  // ---------- 内部工具 ----------

  function upsertRow(row: BalanceRow) {
    const idx = rows.value.findIndex((r) => r.accountId === row.accountId)
    if (idx >= 0) {
      const copy = rows.value.slice()
      copy[idx] = row
      rows.value = copy
    } else {
      rows.value = [...rows.value, row]
    }
  }

  function setRefreshing(ids: string[]) {
    refreshingIds.value = new Set(ids)
  }
  function addRefreshing(id: string) {
    const s = new Set(refreshingIds.value)
    s.add(id)
    refreshingIds.value = s
  }
  function removeRefreshing(id: string) {
    const s = new Set(refreshingIds.value)
    s.delete(id)
    refreshingIds.value = s
  }

  async function reloadAccounts() {
    const r = await listAccounts()
    if (r.ok) accounts.value = r.data
  }

  // ---------- 动作 ----------

  /** 首屏：取启动信息 / 账号列表 / 设置，随后拉一次余额 */
  async function loadAll() {
    loading.value = true
    configBanner.value = ''

    const info = await getAppInfo()
    if (info.ok) {
      appInfo.value = info.data
      if (info.data.configStatus === 'recovered') {
        configBanner.value = '配置文件已损坏，已自动恢复上一次可用的备份。'
      } else if (info.data.configStatus === 'reset') {
        configBanner.value = '配置文件已重置为默认设置。'
      }
    } else {
      configBanner.value = info.error
    }

    await reloadAccounts()

    const st = await getSettings()
    if (st.ok) settings.value = st.data

    loading.value = false
    await refreshAll()
  }

  /** 刷新全部启用账号 */
  async function refreshAll() {
    const ids = accounts.value.filter((a) => a.enabled).map((a) => a.id)
    batchPending = true
    setRefreshing(ids)
    const r = await refreshBalances({})
    if (!r.ok) {
      batchPending = false
      refreshingIds.value = new Set()
      configBanner.value = r.error
    }
  }

  /** 只刷单个账号（force=true 跳过缓存） */
  async function refreshOne(id: string) {
    addRefreshing(id)
    const r = await refreshBalances({ ids: [id], force: true })
    if (r.ok) {
      // 兜底：若订阅回调没触发，也用返回值直接更新并解除禁用
      for (const row of r.data.rows) {
        upsertRow(row)
        removeRefreshing(row.accountId)
      }
      lastUpdated.value = r.data.ts
    } else {
      removeRefreshing(id)
      configBanner.value = r.error
    }
  }

  /** 新增或编辑账号，成功后重载列表并刷新（基于 api 层纯保存封装组合而成，不再各自维护一份 IPC 调用） */
  async function saveAccount(
    input: AccountInput
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const r = await saveAccountRpc(input)
    if (r.ok) {
      await reloadAccounts()
      await refreshAll()
      return { ok: true }
    }
    return { ok: false, error: r.error }
  }

  /** 删除账号，成功后从本地列表移除 */
  async function removeAccount(id: string): Promise<{ ok: boolean; error?: string }> {
    const r = await removeAccountRpc(id)
    if (r.ok && r.data.ok) {
      accounts.value = accounts.value.filter((a) => a.id !== id)
      rows.value = rows.value.filter((row) => row.accountId !== id)
      return { ok: true }
    }
    return { ok: false, error: r.ok ? '主进程返回删除失败' : r.error }
  }

  /** 局部更新设置 */
  async function saveSettings(
    patch: Partial<Settings>
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const r = await saveSettingsRpc(patch)
    if (r.ok) {
      settings.value = r.data
      return { ok: true }
    }
    return { ok: false, error: r.error }
  }

  // ---------- 订阅（挂载时订阅，卸载时清理） ----------

  onMounted(() => {
    unsubRow = subscribeRow((row) => {
      upsertRow(row)
      removeRefreshing(row.accountId)
      lastUpdated.value = row.ts
    })
    unsubUpdated = subscribeUpdated((payload) => {
      rows.value = payload.rows
      lastUpdated.value = payload.ts
      if (batchPending) {
        batchPending = false
        refreshingIds.value = new Set()
      }
    })
  })

  onUnmounted(() => {
    unsubRow?.()
    unsubUpdated?.()
    unsubRow = null
    unsubUpdated = null
  })

  return {
    accounts,
    rows,
    settings,
    appInfo,
    loading,
    refreshingIds,
    lastUpdated,
    configBanner,
    loadAll,
    refreshAll,
    refreshOne,
    saveAccount,
    removeAccount,
    saveSettings
  }
}
