import type { Account, KeyAuditItem, KeyListReport, KeyRow } from '../shared/types'
import { logger } from './logger'
import { readSnapshots } from './snapshot'
import { listVaultKeys, vaultFingerprint } from './keyvault'
import { store } from './store'

/**
 * Key 管理：把 config 里的账号汇总成一行一个 key 的清单，并做安全审计。
 * 只读汇总 + 复用 store 的增删改，不额外落盘（标签与回收站字段存在 config.json 的账号上）。
 */

/** 平台密钥格式规则（用于审计「格式异常」） */
const KEY_RULES: Record<string, { pattern: RegExp; hint: string }> = {
  deepseek: { pattern: /^sk-[A-Za-z0-9_-]{10,}$/, hint: 'DeepSeek 的 Key 通常以 sk- 开头' },
  newapi: { pattern: /^sk-[A-Za-z0-9_-]{6,}$/, hint: '中转站令牌通常以 sk- 开头' },
  siliconflow: { pattern: /^(sk-[A-Za-z0-9_-]{6,}|.+[=;].+)$/, hint: '应是 sk- 开头的 Key 或登录 Cookie' }
}

function toKeyRow(acc: Account): KeyRow {
  const secret = store.revealSecret(acc.id)
  return {
    id: acc.id,
    name: acc.name,
    type: acc.type,
    enabled: acc.enabled,
    secretMasked: acc.secret_masked || '',
    hasSecret: !!secret,
    fingerprint: store.fingerprint(acc.id),
    tags: Array.isArray(acc.tags) ? acc.tags : [],
    unit: acc.unit || '',
    threshold: acc.threshold ?? null,
    baseUrl: acc.base_url || '',
    lastStatus: acc.last_status ?? null,
    lastError: acc.last_error || '',
    lastTs: acc.last_ts ?? null,
    createdAt: acc.created_at,
    updatedAt: acc.updated_at,
    deleted: !!acc.deleted_at,
    deletedAt: acc.deleted_at ?? null,
    // 账号来源：在「添加账号」里用 API Key 建的，自动出现在 Key 管理（单向同步）
    source: 'account'
  }
}

/** Key 库里的独立记录（不参与余额查询，也不会变成账号） */
function toVaultRow(v: { id: string; name: string; type: string; base_url: string; secret_masked: string; secret_enc: string | null; tags: string[]; enabled: boolean; created_at: number; updated_at: number }): KeyRow {
  return {
    id: v.id,
    name: v.name,
    type: v.type as never,
    enabled: v.enabled,
    secretMasked: v.secret_masked || '',
    hasSecret: !!v.secret_enc,
    fingerprint: vaultFingerprint(v.id),
    tags: Array.isArray(v.tags) ? v.tags : [],
    unit: '',
    threshold: null,
    baseUrl: v.base_url || '',
    lastStatus: null,
    lastError: '',
    lastTs: null,
    createdAt: v.created_at,
    updatedAt: v.updated_at,
    deleted: false,
    deletedAt: null,
    source: 'vault'
  }
}

export async function buildKeyList(): Promise<KeyListReport> {
  const all = store.listAccounts()
  const removed = store.listDeleted()
  // 单向合并：账号（source=account） + 独立 Key 库（source=vault）
  const rows = [...all.map(toKeyRow), ...listVaultKeys().map(toVaultRow)]
  const deletedRows = removed.map(toKeyRow)
  const tags = Array.from(new Set(rows.flatMap((r) => r.tags))).sort((a, b) => a.localeCompare(b, 'zh'))

  const audit: KeyAuditItem[] = []
  const now = Date.now()
  const DAY = 24 * 60 * 60 * 1000

  // ① 长期未成功刷新（> 30 天）
  for (const r of rows) {
    if (r.lastTs !== null && now - r.lastTs > 30 * DAY) {
      audit.push({ id: r.id, kind: 'stale', level: 'warn', message: '「' + r.name + '」超过 30 天没有成功刷新，可能是废弃的 Key' })
    }
  }

  // ② 近 7 天没有任何消耗（余额高但没在用）
  try {
    const snaps = (await readSnapshots()).filter((s) => s && s.ok).sort((a, b) => a.ts - b.ts)
    const since = now - 7 * DAY
    for (const r of rows) {
      if (!r.enabled) continue
      const list = snaps.filter((s) => s.account_id === r.id && s.ts >= since)
      if (list.length < 3) continue
      let drop = 0
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1].remaining
        const b = list[i].remaining
        if (a !== null && b !== null && a > b) drop += a - b
      }
      const latest = list[list.length - 1].remaining
      if (drop <= 0 && latest !== null && r.threshold !== null && latest > r.threshold * 3) {
        audit.push({ id: r.id, kind: 'unused', level: 'info', message: '「' + r.name + '」近 7 天没有消耗，但余额还有 ' + latest + ' ' + r.unit + '，注意别浪费' })
      }
    }
  } catch (e) {
    logger.warn('[keys] 审计读取快照失败：' + (e as Error).message)
  }

  // ③ 重复密钥（同一份密钥被添加了多次）
  const byFp = new Map<string, KeyRow[]>()
  for (const r of rows) {
    if (!r.fingerprint) continue
    const arr = byFp.get(r.fingerprint) ?? []
    arr.push(r)
    byFp.set(r.fingerprint, arr)
  }
  for (const [, arr] of byFp) {
    if (arr.length < 2) continue
    audit.push({ id: arr[0].id, kind: 'duplicate', level: 'warn', message: '发现 ' + arr.length + ' 个账号用了同一份密钥：' + arr.map((x) => x.name).join('、') })
  }

  // ④ 密钥格式异常
  for (const r of rows) {
    const rule = KEY_RULES[r.type]
    if (!rule || !r.hasSecret) continue
    const secret = store.revealSecret(r.id)
    if (!rule.pattern.test(secret)) {
      audit.push({ id: r.id, kind: 'format', level: 'warn', message: '「' + r.name + '」的密钥格式看着不对：' + rule.hint })
    }
  }

  return {
    rows,
    deleted: deletedRows,
    tags,
    audit,
    note: rows.length === 0 ? '还没有账号：先在概览页添加一个平台账号，这里会自动汇总' : ''
  }
}
