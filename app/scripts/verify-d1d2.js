/* eslint-disable */
/**
 * D1 / D2 修复验证脚本（临时验证用，验证后可删）。
 *
 * 运行方式（必须在 electron 环境跑，因为要用 safeStorage / 真实数据目录）：
 *   npx tsc -p scripts/tsconfig.verify.json
 *   npx electron scripts/verify-d1d2.js
 *
 * 覆盖两条修复：
 *   D1 概览页「删除账号」：ACCOUNT_REMOVE 主进程已兼容 { id } 对象与裸字符串两种传参，
 *      验证「preload 传对象也能解析出 id 并真正删除账号」。
 *   D2 重启丢状态：normalizeAccount / Store.load 已保留 tags 与 deleted_at，
 *      验证「保存带标签/回收站状态的账号 → 重新 load → 字段还在」。
 * 策略：先备份用户 config.json / .bak，跑完恢复（与 verify.js 相同模式，不影响真实数据）。
 */
const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

app.disableHardwareAcceleration()

const { Store, normalizeAccount } = require('./.tmp/main/store.js')
const paths = require('./.tmp/main/paths.js')

const results = []
function check(name, pass, extra) {
  results.push({ name, pass, extra: extra || '' })
  console.log(`${pass ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' —— ' + extra : ''}`)
}

const DATA_DIR = paths.DATA_DIR
function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

async function main() {
  console.log('数据目录：' + DATA_DIR)

  // ---------- D1：删除账号（兼容 { id } 对象传参） ----------
  // 与 src/main/ipc.ts ACCOUNT_REMOVE 处理同步的解析逻辑：
  const parsePayloadId = (payload) =>
    typeof payload === 'string' ? payload : (payload && typeof payload === 'object' && typeof payload.id === 'string' ? payload.id : '')

  check('D1a 裸字符串传参解析出原值', parsePayloadId('acc-abc') === 'acc-abc')
  check('D1b { id } 对象传参解析出原值（不再得到 [object Object]）', parsePayloadId({ id: 'acc-abc' }) === 'acc-abc')

  const store = new Store()
  store.load()
  const acc = store.saveAccount({ name: 'D1 验证号', type: 'deepseek', enabled: true, secret: 'sk-verify-d1a', tag: undefined })
  const payload = { id: acc.id } // preload removeAccount 现在传 { id }
  const id = parsePayloadId(payload)
  const ok = store.removeAccount(id)
  check('D1c 对象传参 → removeAccount 真正删除成功', ok === true, 'id=' + id)
  check('D1d 删除后账号已不存在', store.getAccount(id) === null)

  // 旧行为复现（修复前的 String(payload)）：证明这个 bug 确实存在过、且现在没有副作用
  const acc2 = store.saveAccount({ name: 'D1 残留检测号', type: 'deepseek', enabled: true, secret: 'sk-verify-d1b' })
  const bad = store.removeAccount(String({ id: acc2.id }))
  check('D1e 旧式 String({id}) 无法删除（[object Object] 找不到账号）', bad === false && store.getAccount(acc2.id) !== null)
  store.removeAccount(acc2.id) // 清理

  // ---------- D2：恢复标签与回收站状态 ----------
  // 2a/2b：normalizeAccount 直接验证
  const n = normalizeAccount({
    id: 't1',
    name: '标签号',
    type: 'deepseek',
    enabled: false,
    tags: ['工作', '中转'],
    deleted_at: 1750000000000,
    secret_enc: 'x',
    secret_masked: 'sk-****'
  })
  check('D2a normalizeAccount 保留 tags', !!n && Array.isArray(n.tags) && n.tags.join(',') === '工作,中转')
  check('D2b normalizeAccount 保留 deleted_at', !!n && n.deleted_at === 1750000000000)

  // 2c：整链验证 —— 保存带标签账号 → 重新 new Store().load()（模拟重启）→ 标签还在
  const s2 = new Store()
  s2.load()
  const b = s2.saveAccount({ name: 'D2 验证号', type: 'newapi', enabled: true, secret: 'sk-verify-d2', tags: ['SaaS', '测试'] })

  const s3 = new Store()
  s3.load()
  const b2 = s3.getAccount(b.id)
  check('D2c 重新 load 后账号存在', !!b2)
  check('D2d 重新 load 后 tags 保留', !!b2 && Array.isArray(b2.tags) && b2.tags.join(',') === 'SaaS,测试')

  // 清理 D2 测试账号
  s3.removeAccount(b.id)
}

// 备份/恢复用户真实配置（与 verify.js 相同模式）
const CONFIG = path.join(DATA_DIR, 'config.json')
const CONFIG_BAK = path.join(DATA_DIR, 'config.json.bak')
const backup = { config: readIfExists(CONFIG), bak: readIfExists(CONFIG_BAK), files: [] }
try {
  for (const f of fs.readdirSync(DATA_DIR)) if (f.startsWith('config.corrupt-')) backup.files.push(f)
} catch {}

function cleanup() {
  const restore = (file, content) => {
    try {
      if (content === null) fs.rmSync(file, { force: true })
      else fs.writeFileSync(file, content, 'utf8')
    } catch (e) {
      console.warn('[cleanup] 恢复失败', file, e.message)
    }
  }
  restore(CONFIG, backup.config)
  restore(CONFIG_BAK, backup.bak)
}

app.whenReady().then(async () => {
  try {
    await main()
  } catch (e) {
    check('脚本执行未抛异常', false, e && e.stack ? e.stack : String(e))
  } finally {
    cleanup()
  }
  const failed = results.filter((r) => !r.pass)
  console.log('========================================')
  console.log(`共 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`)
  console.log('========================================')
  app.exit(failed.length ? 1 : 0)
})