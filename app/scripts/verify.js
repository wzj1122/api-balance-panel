/* eslint-disable */
/**
 * T02 数据层实测脚本（临时，不在主流程里，跑完可删）。
 *
 * 运行方式（必须用 electron 当 node 运行时，因为要用 safeStorage）：
 *   npx tsc -p scripts/tsconfig.verify.json
 *   npx electron scripts/verify.js
 *
 * 覆盖三条验收：
 *   1. 保存一个 deepseek 账号 → config.json 里 secret_enc 是密文，且能解密回原文；
 *   2. 重新加载 → 账号、掩码、明文都在；
 *   3. 故意写坏 config.json → 重新加载自动回滚 .bak 且 configStatus='recovered'。
 */
const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

// 本脚本不开窗口，禁掉硬件加速，避免无 GPU 的 CI/远程环境里 GPU 进程崩溃把进程带走
app.disableHardwareAcceleration()

const { Store } = require('./.tmp/main/store.js')
const { isSecure, currentScheme, encrypt, decrypt } = require('./.tmp/main/crypto.js')
const paths = require('./.tmp/main/paths.js')
const snapshot = require('./.tmp/main/snapshot.js')
const { maskSecret } = require('./.tmp/shared/format.js')

const results = []
function check(name, pass, extra) {
  results.push({ name, pass, extra: extra || '' })
  console.log(`${pass ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' —— ' + extra : ''}`)
}

const SECRET = 'sk-verify1234567890abcdef'
const DATA_DIR = paths.DATA_DIR

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function cleanup(backup) {
  const restore = (file, content) => {
    try {
      if (content === null) fs.rmSync(file, { force: true })
      else fs.writeFileSync(file, content, 'utf8')
    } catch (e) {
      console.warn('[cleanup] 恢复失败', file, e.message)
    }
  }
  restore(paths.CONFIG_FILE, backup.config)
  restore(paths.CONFIG_BAK, backup.bak)
  restore(paths.SNAPSHOT_FILE, backup.snapshot)
  try {
    fs.rmSync(paths.CONFIG_TMP, { force: true })
  } catch {}
  // 清理本次产生的 corrupt 归档
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (f.startsWith('config.corrupt-') && !backup.corruptFiles.includes(f)) {
      try {
        fs.rmSync(path.join(DATA_DIR, f), { force: true })
      } catch {}
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  console.log('数据目录：' + DATA_DIR)
  console.log('safeStorage 可用：' + isSecure() + '，当前方案：' + currentScheme())

  const backup = {
    config: readIfExists(paths.CONFIG_FILE),
    bak: readIfExists(paths.CONFIG_BAK),
    snapshot: readIfExists(paths.SNAPSHOT_FILE),
    corruptFiles: fs.readdirSync(DATA_DIR).filter((f) => f.startsWith('config.corrupt-'))
  }

  try {
    // ---------- 1. 保存账号 → 密文落盘 ----------
    const store = new Store()
    store.load()
    const account = store.saveAccount({
      name: 'DeepSeek 验证号',
      type: 'deepseek',
      enabled: true,
      secret: SECRET,
      unit: 'CNY'
    })

    const rawText = fs.readFileSync(paths.CONFIG_FILE, 'utf8')
    const raw = JSON.parse(rawText)
    const enc = raw.accounts[0].secret_enc
    check('1a 落盘后 config.json 里不含明文密钥', !rawText.includes(SECRET))
    check('1b secret_enc 是密文且非空', typeof enc === 'string' && enc.length > 0 && enc !== SECRET,
      `scheme=${raw.crypto.scheme}, enc 长度=${enc ? enc.length : 0}`)
    check('1c secret_masked 计算正确', raw.accounts[0].secret_masked === maskSecret(SECRET),
      `实际=${raw.accounts[0].secret_masked}`)
    check('1d 内存里能解密回原文', store.getSecret(account) === SECRET)

    // ---------- 2. 重新加载 → 仍能解密 ----------
    const store2 = new Store()
    store2.load()
    const acc2 = store2.getAccount(account.id)
    check('2a 重新加载后账号还在', !!acc2 && acc2.name === 'DeepSeek 验证号')
    check('2b 重新加载后能解密出原文', !!acc2 && store2.getSecret(acc2) === SECRET)
    check('2c 配置状态为 ok', store2.getConfigStatus() === 'ok', '状态=' + store2.getConfigStatus())

    // 再存一次，让 .bak 里也有一份带账号的配置
    store2.saveAccount({ id: account.id, name: 'DeepSeek 验证号', type: 'deepseek', enabled: true })
    check('2d 生成了 config.json.bak', fs.existsSync(paths.CONFIG_BAK))

    // ---------- 3. 写坏 config.json → 自动回滚 ----------
    fs.writeFileSync(paths.CONFIG_FILE, '{ 这不是 JSON，故意写坏：,,,', 'utf8')
    const store3 = new Store()
    store3.load()
    const acc3 = store3.getAccount(account.id)
    check('3a 配置状态为 recovered', store3.getConfigStatus() === 'recovered', '状态=' + store3.getConfigStatus())
    check('3b 账号从备份恢复回来了', !!acc3 && acc3.name === 'DeepSeek 验证号')
    check('3c 恢复后密钥仍能解密', !!acc3 && store3.getSecret(acc3) === SECRET)
    const hasCorrupt = fs.readdirSync(DATA_DIR).some((f) => f.startsWith('config.corrupt-'))
    check('3d 坏文件已归档为 config.corrupt-*.json', hasCorrupt)

    // ---------- 4. 主配置与备份都坏 → 重置为默认 ----------
    fs.writeFileSync(paths.CONFIG_FILE, '!!! 彻底坏了 !!!', 'utf8')
    fs.writeFileSync(paths.CONFIG_BAK, '!!! 备份也坏了 !!!', 'utf8')
    const store4 = new Store()
    store4.load()
    check('4a 配置状态为 reset', store4.getConfigStatus() === 'reset', '状态=' + store4.getConfigStatus())
    check('4b 重置后账号列表为空且不崩', store4.listAccounts().length === 0)

    // ---------- 5. 快照落盘 ----------
    snapshot.append([
      {
        ok: true,
        remaining: 12.34,
        total: 100,
        used: 87.66,
        unit: 'CNY',
        note: '可用',
        items: [{ planName: '赠送余额', remaining: 2, total: null, used: null, unit: 'CNY' }],
        ts: Date.now(),
        latencyMs: 123,
        cached: false,
        accountId: account.id,
        name: 'DeepSeek 验证号',
        type: 'deepseek',
        enabled: true,
        threshold: null,
        lowBalance: false
      }
    ])
    await sleep(150)
    await snapshot.flush()
    const snapText = readIfExists(paths.SNAPSHOT_FILE)
    check('5a snapshots.json 已落盘', !!snapText)
    check('5b 快照内容包含账号与余额', !!snapText && snapText.includes(account.id) && snapText.includes('12.34'))

    // ---------- 6. 归一化兜底 ----------
    const s5 = new Store()
    s5.load()
    const weird = s5.saveSettings({ refresh_seconds: -1, concurrency: 999, theme: 'dark' })
    check('6a 非法 refresh_seconds 回落 300', weird.refresh_seconds === 300, '实际=' + weird.refresh_seconds)
    check('6b 越界 concurrency 钳到 32', weird.concurrency === 32, '实际=' + weird.concurrency)
  } catch (e) {
    check('脚本执行未抛异常', false, e && e.stack ? e.stack : String(e))
  } finally {
    cleanup(backup)
  }

  const failed = results.filter((r) => !r.pass)
  console.log('========================================')
  console.log(`共 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`)
  console.log('========================================')
  app.quit(failed.length ? 1 : 0)
}

app.whenReady().then(main).catch((e) => {
  console.error('脚本异常：', e)
  app.exit(1)
})
