/**
 * 适配器 + 并发池 + 错误映射 验证脚本（本地 mock，不需要真实密钥）。
 * 运行：node scripts/verify-adapters.mjs
 *
 * 原理：用 esbuild 把纯逻辑源码（adapters / runPool / errors）打成临时 ESM，
 * 再用 stub 掉的 globalThis.fetch 提供各家平台的假响应，断言解析结果与错误文案。
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { mkdirSync } from 'node:fs'

const root = process.cwd()
const tmpDir = path.join(root, 'scripts', '.verify')
mkdirSync(tmpDir, { recursive: true })

async function bundle(entry, name) {
  const outfile = path.join(tmpDir, `${name}.mjs`)
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile,
    logLevel: 'silent'
  })
  return await import(pathToFileURL(outfile).href + '?t=' + Date.now())
}

const { PROVIDERS } = await bundle('src/main/adapters/index.ts', 'adapters')

// ---- siliconflow 控制台 mock（页面 -> SF_SUBJECT_ID -> walletd 接口） ----
let SF_MODE = 'ok' // ok | expired | loginwall
let ALIYUN_MODE = 'ok' // ok | badkey | notfound
let SF_SUBJECT_SEEN = ''
const SF_SID = 'mocksubject12345'
const SF_HTML_OK =
  '<!DOCTYPE html><html><body><script>window.SF_SUBJECT_ID = \'' + SF_SID +
  '\'; window.subjectInfo = {"subjectId":"' + SF_SID + '"}</script><h1>expensebill</h1></body></html>'
const SF_FIN = {
  code: 20000,
  data: { financialInfo: { balance: '10000000000000', available: '10000000000000', recharged: '10000000000000', used: '0', lineOfCredit: '0', remainingCreditLine: '0' } }
}
const SF_COUPONS = {
  code: 20000,
  data: {
    wallets: [
      { name: '{"zh-cn":"推荐官奖励券"}', balance: '16000000000000', cap: '16000000000000', used: '0', status: 0 },
      { name: '{"zh-cn":"推荐官奖励券"}', balance: '16000000000000', cap: '16000000000000', used: '0', status: 0 },
      { name: '{"zh-cn":"推荐官奖励券"}', balance: '5695405360000', cap: '16000000000000', used: '10304594640000', status: 0 },
      { name: '{"zh-cn":"认证奖励券"}', balance: '0', cap: '16000000000000', used: '16000000000000', status: 1 }
    ],
    pagination: { total: 4 }
  }
}
const SF_PACKS = { code: 20000, data: { wallets: [] } }
const { runPool } = await bundle('src/main/runPool.ts', 'runpool')
const { errorText, mapHttpStatus, mapFetchError } = await bundle('src/main/errors.ts', 'errors')

// ---------- 断言 ----------
let passed = 0
let failed = 0
function ok(cond, label, extra = '') {
  if (cond) {
    passed++
    console.log(`  PASS  ${label}`)
  } else {
    failed++
    console.log(`  FAIL  ${label}  ${extra}`)
  }
}
function close(a, b, label) {
  const good = a !== null && b !== null && Math.abs(a - b) < 1e-9
  ok(good, label, `期望 ${b}，实际 ${a}`)
}

// ---------- stub fetch ----------
let fetchCount = 0
globalThis.fetch = async (url, opts) => {
  fetchCount++
  const u = String(url)
  const signal = opts && opts.signal

  // 超时场景：发一个永不 resolve 的 promise，等 signal abort
  if (u.includes('mock.local/slow')) {
    return new Promise((_res, rej) => {
      if (signal) {
        signal.addEventListener('abort', () => {
          const e = new Error('The operation was aborted due to timeout')
          e.name = 'AbortError'
          rej(e)
        })
      }
    })
  }

  const json = (code, body) => ({
    status: code,
    text: async () => JSON.stringify(body)
  })
  const html = (code) => ({ status: code, text: async () => '<html><body>login</body></html>' })

  if (u.includes('api.deepseek.com/user/balance')) {
    return json(200, {
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '128.45', granted_balance: '20.00', topped_up_balance: '108.45' }]
    })
  }
  if (u.includes('platform.xiaomimimo.com/api/v1/balance')) {
    const cookie = (opts && opts.headers && opts.headers.Cookie) || ''
    if (cookie.includes('expired')) return { status: 401, text: async () => '{}' }
    return json(200, { data: { currency: 'CNY', balance: '88.50', cashBalance: '50.00', giftBalance: '38.50' } })
  }
  if (u.includes('platform.xiaomimimo.com/api/v1/tokenPlan/detail')) {
    const cookie = (opts && opts.headers && opts.headers.Cookie) || ''
    if (cookie.includes('expired')) return { status: 401, text: async () => '{}' }
    if (cookie.includes('noplan')) return json(200, { code: 0, data: {} })
    return json(200, { code: 0, data: { planCode: 'lite', planName: 'Lite', currentPeriodEnd: '2026-09-28 23:59:59', expired: false } })
  }
  if (u.includes('platform.xiaomimimo.com/api/v1/tokenPlan/usage')) {
    const cookie = (opts && opts.headers && opts.headers.Cookie) || ''
    if (cookie.includes('expired')) return { status: 401, text: async () => '{}' }
    return json(200, {
      data: {
        usage: {
          items: [
            { name: 'plan_total_token', used: '1636962419', limit: '4100000000', percent: 0.4 },
            { name: 'compensation_total_token', used: '0', limit: '0', percent: 0 }
          ]
        }
      }
    })
  }
  if (u.includes('www.minimaxi.com/backend/account')) {
    const cookie = (opts && opts.headers && opts.headers.Cookie) || ''
    if (cookie.includes('expired')) return { status: 401, text: async () => '{}' }
    if (cookie.includes('cnonly')) return json(200, { base_resp: { status_code: 1004, status_msg: 'not login' } })
    return json(200, { account_info: { group_id: 'g20260816' }, base_resp: { status_code: 0, status_msg: 'success' } })
  }
  if (u.includes('www.minimax.cn/backend/account')) {
    const cookie = (opts && opts.headers && opts.headers.Cookie) || ''
    if (cookie.includes('expired')) return { status: 401, text: async () => '{}' }
    return json(200, { account_info: { group_id: 'gcn2026' }, base_resp: { status_code: 0, status_msg: 'success' } })
  }
  if (u.includes('www.minimax.cn/account/query_balance')) {
    return json(200, { available_amount: '8.00', cash_balance: '8.00', voucher_balance: '0.00', credit_balance: '0.00', owed_amount: '0.00', base_resp: { status_code: 0, status_msg: 'success' } })
  }
  if (u.includes('www.minimaxi.com/account/query_balance')) {
    return json(200, { available_amount: '15.00', cash_balance: '0.00', voucher_balance: '15.00', credit_balance: '0.00', owed_amount: '0.00', balance_alert_switch: false, base_resp: { status_code: 0, status_msg: 'success' } })
  }
  if (u.includes('bigmodel.cn/api/biz/customer/accountSet')) {
    const cookie = (opts && opts.headers && opts.headers.Cookie) || ''
    if (cookie.includes('expired')) return json(200, { code: 401, msg: '令牌已过期或验证不正确', success: false })
    if (cookie.includes('notoken')) return json(200, { code: 1001, msg: 'Header中未收到Authorization参数', success: false })
    return json(200, { code: 200, msg: '操作成功', data: { basicCustomerInfo: { balance: '1.000000000', availableCreditBalance: null } }, success: true })
  }
  if (u.includes('cloud.siliconflow.cn/me/expensebill')) {
    if (SF_MODE === 'expired') return { status: 401, text: async () => '{}' }
    if (SF_MODE === 'loginwall') {
      return { status: 200, text: async () => '<html><body><a href="https://account.siliconflow.cn/login">登录</a></body></html>' }
    }
    return { status: 200, text: async () => SF_HTML_OK }
  }
  if (u.includes('walletd-server/api/v1/subject/profile/peek')) {
    const headers = (opts && opts.headers) || {}
    const sid = headers['X-Subject-Id'] || headers['x-subject-id'] || ''
    if (sid) SF_SUBJECT_SEEN = sid
    if (SF_MODE === 'expired') return { status: 401, text: async () => '{}' }
    return json(200, SF_FIN)
  }
  if (u.includes('walletd-server/api/v1/subject/wallets')) {
    return u.includes('stage=3') ? json(200, SF_COUPONS) : json(200, SF_PACKS)
  }
  if (u.includes('bssapi.aliyuncs.com') || u.includes('business.aliyuncs.com')) {
    const action = (u.match(/Action=([^&]+)/) || [])[1]
    const act = action ? decodeURIComponent(action) : ''
    if (ALIYUN_MODE === 'badkey' && act === 'QueryAccountBalance') {
      return json(200, { Code: 'InvalidAccessKeyId.NotFound', Message: 'Specified access key is not found.', RequestId: 'mock' })
    }
    if (ALIYUN_MODE === 'notfound' && act === 'QueryAccountBalance') {
      // 真实线上：InvalidAccessKeyId 返回 HTTP 404 + JSON 错误体
      return { status: 404, text: async () => JSON.stringify({ RequestId: 'mock', Message: 'Specified access key is not found.', Code: 'InvalidAccessKeyId.NotFound', HostId: 'business.aliyuncs.com' }) }
    }
    if (act === 'QueryAccountBalance') {
      // 真实线格式：PascalCase（AvailableAmount…）
      return json(200, { Code: 'Success', Data: { AvailableAmount: '7.81', AvailableCashAmount: '7.81', MybankCreditAmount: '0.00', CreditAmount: '0.00', Currency: 'CNY' } })
    }
    if (act === 'QueryCashCoupons') {
      return json(200, {
        Code: 'Success',
        Data: {
          CashCoupon: [
            { Status: 'Available', NominalValue: '300', Balance: '233.6495124666', CashCouponNo: '904651500639' },
            { Status: 'Expired', NominalValue: '100', Balance: '100', CashCouponNo: '897833580639' }
          ]
        }
      })
    }
    if (act === 'QuerySavingsPlansInstance') {
      return json(200, { Code: 'Success', Data: { Items: [] } })
    }
    return json(200, { Code: 'Success', Data: {} })
  }
    if (u.includes('mock.local/newapi/api/user/self')) {
    return json(200, { success: true, message: '', data: { id: 1, username: 'alice', quota: 1600000, used_quota: 2400000, request_count: 87 } })
  }
  if (u.includes('mock.local/custom')) {
    return json(200, { code: 0, data: { balance: 8800, total: 10000, used: 1200, plans: [{ name: 'A', remain: '500' }, { name: 'B', remain: '300' }] } })
  }
  if (u.includes('mock.local/401')) return { status: 401, text: async () => '{}' }
  if (u.includes('mock.local/404')) return { status: 404, text: async () => '{}' }
  if (u.includes('mock.local/429')) return { status: 429, text: async () => '{}' }
  if (u.includes('mock.local/500')) return { status: 500, text: async () => '{}' }
  if (u.includes('mock.local/html')) return html(200)

  return { status: 200, text: async () => '{}' }
}

const ctx = { getSecret: () => 'sk-test-0000' }

// ---------- 1. deepseek 解析 ----------
{
  const r = await PROVIDERS.deepseek({ type: 'deepseek', quota_total: null }, ctx)
  close(r.remaining, 128.45, 'deepseek remaining=128.45')
  ok(r.total === null, 'deepseek total=null（平台不提供）')
  ok(r.used === null, 'deepseek used=null')
  ok(r.unit === 'CNY', 'deepseek unit=CNY')
  ok(r.items.length === 2, 'deepseek 两条子项', `实际 ${r.items.length}`)
  close(r.items[0].remaining, 20, 'deepseek 赠送余额=20')
  close(r.items[1].remaining, 108.45, 'deepseek 充值余额=108.45')
}

// ---------- 2. siliconflow（Cookie + x-subject-id 全链路） ----------
{
  SF_MODE = 'ok'
  SF_SUBJECT_SEEN = ''
  const sfCtx = { getSecret: () => 'sf-cookie-abc123' }
  const r = await PROVIDERS.siliconflow({ type: 'siliconflow', name: '硅基' }, sfCtx)
  close(r.remaining, 47.695405, 'siliconflow remaining=余额+代金券=10+37.695405')
  close(r.total, 74, 'siliconflow total=现金充值10+代金券总额64')
  close(r.used, 26.304595, 'siliconflow used=74-47.695405')
  ok(r.unit === 'CNY', 'siliconflow unit=CNY')
  ok(r.note.includes('控制台'), 'siliconflow note 含来源')
  ok(r.items.length >= 2, 'siliconflow items ≥2（现金+代金券）', '实际 ' + r.items.length)
  close(r.items[0].remaining, 10, 'siliconflow 现金余额=10')
  const couponItem = r.items.find((it) => it.planName.includes('代金券'))
  ok(!!couponItem, 'siliconflow 有代金券条目')
  if (couponItem) {
    ok(couponItem.planName.includes('3 张可用'), 'siliconflow 代金券 3 张可用（第 4 张已用尽不计入）')
    close(couponItem.remaining, 37.695405, 'siliconflow 代金券剩余合计=16+16+5.69540536（round6）')
    close(couponItem.used, 26.304595, 'siliconflow 代金券已用=10.30459464+16（round6）')
  }
  ok(SF_SUBJECT_SEEN === SF_SID, 'siliconflow x-subject-id 头 = 页面提取值', '实际 ' + SF_SUBJECT_SEEN)

  // 无代金券时退回纯余额口径
  SF_COUPONS.data.wallets = []
  const r2 = await PROVIDERS.siliconflow({ type: 'siliconflow' }, sfCtx)
  close(r2.remaining, 10, 'siliconflow 无代金券时 remaining=10（纯现金）')
  close(r2.total, 10, 'siliconflow 无代金券时 total=10')
  ok(!r2.items.some((it) => it.planName.includes('代金券')), 'siliconflow 无代金券条目')
  SF_COUPONS.data.wallets = [
    { name: '{"zh-cn":"推荐官奖励券"}', balance: '16000000000000', cap: '16000000000000', used: '0', status: 0 },
    { name: '{"zh-cn":"推荐官奖励券"}', balance: '16000000000000', cap: '16000000000000', used: '0', status: 0 },
    { name: '{"zh-cn":"推荐官奖励券"}', balance: '5695405360000', cap: '16000000000000', used: '10304594640000', status: 0 },
    { name: '{"zh-cn":"认证奖励券"}', balance: '0', cap: '16000000000000', used: '16000000000000', status: 1 }
  ]
}
// ---------- 2b. siliconflow 失效场景 ----------
{
  const sfCtx = { getSecret: () => 'sf-cookie-abc123' }
  SF_MODE = 'expired'
  await expectCode(PROVIDERS.siliconflow, { type: 'siliconflow' }, 'COOKIE_EXPIRED', 'siliconflow 登录失效(401) → COOKIE_EXPIRED', sfCtx)
  SF_MODE = 'loginwall'
  await expectCode(PROVIDERS.siliconflow, { type: 'siliconflow' }, 'COOKIE_EXPIRED', 'siliconflow 登录墙页面 → COOKIE_EXPIRED', sfCtx)
  SF_MODE = 'ok'
  const skCtx = { getSecret: () => 'sk-test-0000' }
  await expectCode(PROVIDERS.siliconflow, { type: 'siliconflow' }, 'COOKIE_EXPIRED', 'siliconflow 旧版 sk- Key → COOKIE_EXPIRED（提示改用登录）', skCtx)
}

// ---------- 3. newapi 解析 + 换算 + user_id 头 ----------
{
  let sawUserIdHeader = false
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    const headers = (opts && opts.headers) || {}
    if (headers['New-API-User'] === 'alice') sawUserIdHeader = true
    return origFetch(url, opts)
  }
  const r = await PROVIDERS.newapi({ type: 'newapi', base_url: 'http://mock.local/newapi', quota_per_usd: 500000, unit: 'USD', user_id: 'alice' }, ctx)
  globalThis.fetch = origFetch
  close(r.remaining, 3.2, 'newapi remaining=1600000/500000=3.2')
  close(r.used, 4.8, 'newapi used=2400000/500000=4.8')
  close(r.total, 8, 'newapi total=8')
  ok(r.unit === 'USD', 'newapi unit=USD')
  ok(r.note.includes('alice'), 'newapi note 含用户名')
  ok(sawUserIdHeader, 'newapi 带 New-API-User 头')
}

// ---------- 4~8. 错误码 → 文案 ----------
async function expectCode(adapter, account, code, label, ctxOverride) {
  try {
    await adapter(account, ctxOverride || ctx)
    ok(false, label, '未抛错')
  } catch (e) {
    ok(e && e.code === code, label, `实际 ${e && e.code}`)
  }
}
await expectCode(PROVIDERS.newapi, { type: 'newapi', base_url: 'http://mock.local/401' }, 'HTTP_401', 'newapi 401 → HTTP_401')
await expectCode(PROVIDERS.newapi, { type: 'newapi', base_url: 'http://mock.local/404' }, 'HTTP_404', 'newapi 404 → HTTP_404')
await expectCode(PROVIDERS.newapi, { type: 'newapi', base_url: 'http://mock.local/429' }, 'HTTP_429', 'newapi 429 → HTTP_429')
await expectCode(PROVIDERS.newapi, { type: 'newapi', base_url: 'http://mock.local/500' }, 'HTTP_5XX', 'newapi 500 → HTTP_5XX')
await expectCode(PROVIDERS.newapi, { type: 'newapi', base_url: 'http://mock.local/html' }, 'BAD_JSON', 'newapi 200 HTML → BAD_JSON')

// 文案断言
ok(errorText('HTTP_401') === '密钥错了或过期了，去平台后台重新生成一个', 'HTTP_401 文案')
ok(errorText('HTTP_404') === '网址填错了，检查中转站地址（只填域名，不要带 /v1）', 'HTTP_404 文案')
ok(errorText('HTTP_429') === '查太频繁了，平台限流了，把自动刷新间隔调大一点', 'HTTP_429 文案')
ok(errorText('HTTP_5XX') === '平台自己挂了，等一会儿再试', 'HTTP_5XX 文案')
ok(errorText('BAD_PATH') === '没在数据里找到余额字段，检查一下"取值路径"填对没', 'BAD_PATH 文案')

// ---------- 9. custom 解析 + scale + items ----------
{
  const r = await PROVIDERS.custom({
    type: 'custom',
    request: { url: 'http://mock.local/custom', method: 'GET', headers: {} },
    extract: { remaining: 'data.balance', total: 'data.total', used: 'data.used', unit: '元', scale: 0.01, items: [{ from: 'data.plans', name: 'name', remaining: 'remain' }] }
  }, ctx)
  close(r.remaining, 88, 'custom remaining=8800*0.01=88')
  close(r.total, 100, 'custom total=100')
  close(r.used, 12, 'custom used=12')
  ok(r.unit === '元', 'custom unit=元')
  ok(r.items.length === 2, 'custom items 展开 2 条', `实际 ${r.items.length}`)
  close(r.items[0].remaining, 5, 'custom items[0] remaining=5')
}

// ---------- 10. custom 填错路径 → BAD_PATH ----------
await expectCode(PROVIDERS.custom, {
  type: 'custom',
  request: { url: 'http://mock.local/custom', method: 'GET', headers: {} },
  extract: { remaining: 'data.notexist', total: 'data.notexist2', used: 'data.notexist3' }
}, 'BAD_PATH', 'custom 填错路径 → BAD_PATH')

// ---------- 10b. mimo 解析 + Cookie 过期 ----------
{
  const mimoCtx = { getSecret: () => 'cookie=abc; token=xyz' }
  const r = await PROVIDERS.mimo({ type: 'mimo' }, mimoCtx)
  close(r.remaining, 88.5, 'mimo remaining=88.5')
  ok(r.unit === 'CNY', 'mimo unit=CNY')
  ok(r.items.length >= 2, 'mimo items=现金+赠送（套餐已拆到 mimo-plan 卡片）', `实际 ${r.items.length}`)
  close(r.items[0].remaining, 50, 'mimo 现金余额=50')
  close(r.items[1].remaining, 38.5, 'mimo 赠送余额=38.5')
  ok(!r.items.some((it) => it.unit === 'M Credits'), 'mimo 余额卡不再混入套餐用量')
}
await expectCode(
  PROVIDERS.mimo,
  { type: 'mimo' },
  'COOKIE_EXPIRED',
  'mimo Cookie 过期 → COOKIE_EXPIRED',
  { getSecret: () => 'cookie=expired' }
)
ok(errorText('COOKIE_EXPIRED') === '登录已过期，点「登录」重新获取一次 Cookie', 'COOKIE_EXPIRED 文案')

// ---------- 10c. aliyun（BSS OpenAPI + AccessKey 签名全链路） ----------
{
  const aliyunCtx = { getSecret: () => 'LTAItest123456|testsecret456' }
  const { signRpc, buildBssUrl } = await bundle('src/main/adapters/aliyun.ts', 'aliyun')
  const r = await PROVIDERS.aliyun({ type: 'aliyun' }, aliyunCtx)
  close(r.remaining, 241.459512, 'aliyun remaining=资金7.81+代金券233.6495124666（round6）')
  close(r.total, 307.81, 'aliyun total=资金7.81+代金券面值300')
  close(r.used, 66.350488, 'aliyun used=307.81-241.4595124666（round6）')
  ok(r.unit === 'CNY', 'aliyun unit=CNY')
  ok(r.note.includes('BSS'), 'aliyun note 含 BSS 来源')
  ok(r.items.length === 2, 'aliyun items=资金账户+代金券（节省计划为空不显示）', '实际 ' + r.items.length)
  close(r.items[0].remaining, 7.81, 'aliyun 资金账户=7.81')
  const cItem = r.items.find((it) => it.planName.includes('代金券'))
  ok(!!cItem, 'aliyun 有代金券条目')
  if (cItem) {
    ok(cItem.planName.includes('1 张可用'), 'aliyun 代金券 1 张可用（Expired 不计入）')
    close(cItem.remaining, 233.649512, 'aliyun 代金券剩余=233.649512（round6）')
    close(cItem.total, 300, 'aliyun 代金券面值=300')
  }
  const url = buildBssUrl('LTAItest', 'sec', 'QueryAccountBalance')
  ok(url.startsWith('https://business.aliyuncs.com/?'), 'aliyun 签名 URL 前缀= business 端点（可解析）')
  ok(/Signature=[%A-Za-z0-9/+\\=]+/.test(url), 'aliyun URL 含 Signature')
  ok(/&Timestamp=/.test(url) && /&SignatureNonce=/.test(url), 'aliyun URL 含 Timestamp+Nonce')
  const s1 = signRpc('sec', { A: '1', B: '2' })
  const s2 = signRpc('sec', { A: '1', B: '2' })
  ok(s1 === s2 && /^[A-Za-z0-9+/=]+$/.test(s1), 'aliyun signRpc 确定性 + base64 形态')
  ok(signRpc('sec2', { A: '1', B: '2' }) !== s1, 'aliyun signRpc 不同密钥 → 不同签名')
}

// ---------- 10e. mimo-plan（Token Plan 套餐） ----------
{
  const planCtx = { getSecret: () => 'cookie=abc; token=xyz' }
  const r = await PROVIDERS['mimo-plan']({ type: 'mimo-plan' }, planCtx)
  close(r.remaining, 2463.037581, 'mimo-plan remaining=4100-1636.962419=2463.037581')
  close(r.total, 4100, 'mimo-plan total=4100 M Credits')
  close(r.used, 1636.962419, 'mimo-plan used=1636.962419')
  ok(r.unit === 'M Credits', 'mimo-plan unit=M Credits')
  ok(r.note.includes('Lite') && r.note.includes('2026-09-28'), 'mimo-plan note 含套餐名+有效期', r.note)
  ok(r.items.length === 1, 'mimo-plan 一条子项')
}
await expectCode(PROVIDERS['mimo-plan'], { type: 'mimo-plan' }, 'COOKIE_EXPIRED', 'mimo-plan Cookie 过期 → COOKIE_EXPIRED', { getSecret: () => 'cookie=expired' })
await expectCode(PROVIDERS['mimo-plan'], { type: 'mimo-plan' }, 'BAD_PATH', 'mimo-plan 未开通套餐 → BAD_PATH', { getSecret: () => 'cookie=noplan' })

// ---------- 10f. minimax（Cookie + X-Group-Id） ----------
{
  let minimaxGroupSeen = ''
  const mmCtx = { getSecret: () => 'a=1; _token=xyz' }
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    const hdrs = (opts && opts.headers) || {}
    if (String(url).includes('query_balance') && (hdrs['X-Group-Id'] || hdrs['x-group-id'])) {
      minimaxGroupSeen = hdrs['X-Group-Id'] || hdrs['x-group-id']
    }
    return origFetch(url, opts)
  }
  const r = await PROVIDERS.minimax({ type: 'minimax' }, mmCtx)
  globalThis.fetch = origFetch
  close(r.remaining, 15, 'minimax remaining=可用额度 15')
  ok(r.unit === 'CNY', 'minimax unit=CNY')
  ok(r.items.length === 2, 'minimax items=现金+代金券（授信/欠费为0不显示）', '实际 ' + r.items.length)
  close(r.items[0].remaining, 0, 'minimax 现金=0')
  close(r.items[1].remaining, 15, 'minimax 代金券=15')
  ok(minimaxGroupSeen === 'g20260816', 'minimax query_balance 带 X-Group-Id 头', '实际 ' + minimaxGroupSeen)
}
await expectCode(PROVIDERS.minimax, { type: 'minimax' }, 'MISSING_FIELD', 'minimax 无 Cookie → MISSING_FIELD', { getSecret: () => '' })
await expectCode(PROVIDERS.minimax, { type: 'minimax' }, 'COOKIE_EXPIRED', 'minimax Cookie 过期(401) → COOKIE_EXPIRED', { getSecret: () => 'cookie=expired' })
{
  // .com 登录态失效、.cn 正常 → 自动回退 .cn
  const r = await PROVIDERS.minimax({ type: 'minimax' }, { getSecret: () => 'cookie=cnonly; ok=1' })
  close(r.remaining, 8, 'minimax .com 未登录 → 自动回退 .cn 成功(8)')
  close(r.items[0].remaining, 8, '回退后 cn 现金=8')
  close(r.items[1].remaining, 0, '回退后 cn 代金券=0')
}

// ---------- 10g. zhipu（Cookie + Authorization JWT） ----------
{
  let zhipuAuthSeen = ''
  const zCtx = { getSecret: () => 'a=1; bigmodel_token_production=eyJhbGciOiJIUzUxMiJ9.abc; c=3' }
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    const hdrs = (opts && opts.headers) || {}
    if (String(url).includes('accountSet') && hdrs['Authorization']) zhipuAuthSeen = hdrs['Authorization']
    return origFetch(url, opts)
  }
  const r = await PROVIDERS.zhipu({ type: 'zhipu' }, zCtx)
  globalThis.fetch = origFetch
  close(r.remaining, 1, 'zhipu remaining=1')
  ok(r.unit === 'CNY', 'zhipu unit=CNY')
  ok(zhipuAuthSeen === 'eyJhbGciOiJIUzUxMiJ9.abc', 'zhipu Authorization=token cookie 值（无前缀）', '实际 ' + zhipuAuthSeen)
  ok(r.note.includes('余额 ¥1'), 'zhipu note 含余额')
}
await expectCode(PROVIDERS.zhipu, { type: 'zhipu' }, 'COOKIE_EXPIRED', 'zhipu cookie 无令牌 → COOKIE_EXPIRED', { getSecret: () => 'a=1; other=x' })
await expectCode(PROVIDERS.zhipu, { type: 'zhipu' }, 'COOKIE_EXPIRED', 'zhipu 401 → COOKIE_EXPIRED', { getSecret: () => 'bigmodel_token_production=t; x=expired' })

// ---------- 10d. aliyun 错误场景 ----------
await expectCode(PROVIDERS.aliyun, { type: 'aliyun' }, 'MISSING_FIELD', 'aliyun 未填 AccessKey → MISSING_FIELD', { getSecret: () => '' })
await expectCode(PROVIDERS.aliyun, { type: 'aliyun' }, 'MISSING_FIELD', 'aliyun 格式错误（缺 |）→ MISSING_FIELD', { getSecret: () => 'LTAIxxx' })
ALIYUN_MODE = 'badkey'
await expectCode(PROVIDERS.aliyun, { type: 'aliyun' }, 'HTTP_401', 'aliyun 无效 AccessKey(200+Code) → HTTP_401', { getSecret: () => 'LTAItest123456|testsecret456' })
ALIYUN_MODE = 'notfound'
{
  const zh = '阿里云返回的原文'
  try {
    await PROVIDERS.aliyun({ type: 'aliyun' }, { getSecret: () => 'LTAItest123456|testsecret456' })
    ok(false, 'aliyun 无效 AccessKey(404+JSON Code) → HTTP_401', '未抛错')
  } catch (e) {
    ok(e && e.code === 'HTTP_401', 'aliyun 无效 AccessKey(404+JSON Code) → HTTP_401（不能误报网址错）', '实际 ' + (e && e.code))
    ok(e && e.detail && e.detail.includes('等 2~3 分钟'), 'aliyun 401 详情是中文可执行提示', '实际 ' + ((e && e.detail) || ''))
  }
}
ALIYUN_MODE = 'ok'

// ---------- 11. errors 纯函数 ----------
ok(mapHttpStatus(401) === 'HTTP_401', 'mapHttpStatus 401')
ok(mapHttpStatus(403) === 'HTTP_403', 'mapHttpStatus 403')
ok(mapHttpStatus(404) === 'HTTP_404', 'mapHttpStatus 404')
ok(mapHttpStatus(429) === 'HTTP_429', 'mapHttpStatus 429')
ok(mapHttpStatus(500) === 'HTTP_5XX', 'mapHttpStatus 500')
ok(mapHttpStatus(418) === 'HTTP_OTHER', 'mapHttpStatus 418 → HTTP_OTHER')
ok(mapFetchError({ name: 'AbortError' }) === 'TIMEOUT', 'mapFetchError AbortError → TIMEOUT')
ok(mapFetchError({ message: 'self-signed certificate' }) === 'CERT', 'mapFetchError 证书 → CERT')
ok(mapFetchError(new Error('fetch failed')) === 'NETWORK', 'mapFetchError 其它 → NETWORK')

// ---------- 12. runPool 并发 ----------
{
  let active = 0
  let peak = 0
  const task = async (i) => {
    active++
    peak = Math.max(peak, active)
    await new Promise((res) => setTimeout(res, 50))
    active--
    return i
  }
  const t0 = Date.now()
  const results = await runPool([0, 1, 2, 3, 4, 5].map((i) => () => task(i)), 2)
  const elapsed = Date.now() - t0
  ok(results.length === 6, 'runPool 6 个任务全部返回', `实际 ${results.length}`)
  ok(peak <= 2, 'runPool 并发峰值 ≤ 2', `实际 ${peak}`)
  ok(elapsed < 250, `runPool limit=2 时 6×50ms 总耗时 <250ms（约150ms）`, `实际 ${elapsed}ms`)
  ok(elapsed > 100, 'runPool 确实在并发（非串行 300ms）', `实际 ${elapsed}ms`)
}

// ---------- 汇总 ----------
console.log(`\n结果：${passed} 通过，${failed} 失败，fetch 被调用 ${fetchCount} 次`)
process.exit(failed === 0 ? 0 : 1)
