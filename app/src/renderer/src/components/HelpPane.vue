<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

/** 内置使用说明整页（与 docs/使用说明.md 手工同步维护） */
const docHtml = `<h1>API 余额面板 · 使用说明</h1>
<blockquote>一个本地余额监控小工具：把 DeepSeek、硅基流动、小米 MiMo、New API 中转站、阿里云百炼等账号加进来，<br/>自动定时刷新余额头像卡片，余额低于阈值时变色提醒。所有密钥只保存在你自己的电脑上（本机加密），不会上传任何地方。</blockquote>
<hr/>
<h2>一、安装与运行（拿到安装包怎么用）</h2>
<ol><li>从发布页下载 <strong>「API 余额面板 Setup 1.1.1.exe」</strong> 安装包（约 130 MB）。</li><li>双击运行 → 跟着安装向导走（默认装到当前用户目录，可点「高级选项」改安装位置），装完后桌面和开始菜单会出现「API 余额面板」。</li><li>首次启动时 Windows 可能弹出蓝色提示「Windows 已保护你的电脑」（未知发布者）：点 <strong>「更多信息 → 仍要运行」</strong> 即可。这是因为安装包没有购买代码签名证书（个人分发、非商业签名），属正常现象，不是病毒。</li><li>所有账号配置保存在系统的用户数据目录（Windows：<code>%APPDATA%\\api-balance-panel</code>），换电脑/清数据前想备份，把整个文件夹拷走即可（里面是加密的密钥，拷给别人也没事，但建议别乱发）。</li></ol>
<p>免安装分发：把构建产物里的 <code>win-unpacked</code> 目录整体分发（<code>API 余额面板.exe</code> 必须连同同级 <code>resources</code> 文件夹一起）即为绿色版。</p>
<hr/>
<h2>二、添加账号：各平台分步说明</h2>
<p>点击界面右上角「添加账号」，先选平台类型，再按下面的步骤填。</p>
<h3>1) DeepSeek 官方</h3>
<ol><li>打开 <a href="https://platform.deepseek.com/" target="_blank" rel="noopener">DeepSeek 开放平台</a> ，登录后在左侧「API Keys」创建一个 Key（以 <code>sk-</code> 开头）。</li><li>面板里选「DeepSeek 官方」，把 Key 粘贴进「API Key」栏，保存即可。</li><li>可选：「总额」填了你充值过的总额，卡片上才能算百分比，不填也能用。</li></ol>
<h3>2) 硅基流动</h3>
<ol><li>打开 <a href="https://cloud.siliconflow.cn/" target="_blank" rel="noopener">硅基流动控制台</a> 登录（没账号先注册）。</li><li>面板里选「硅基流动」，点「登录获取 Cookie」——会弹出登录窗口，登录完成后窗口会自动关闭，程序自动抓取 Cookie。</li><li>Cookie 失效后卡片会提示「重新登录」，点卡片上的编辑 → 再点一次登录按钮即可。</li><li>说明：官方已于 2026-08-14 下线 API Key 余额接口，所以这个平台必须用「登录」方式。</li></ol>
<h3>3) 小米 MiMo</h3>
<ol><li>打开 <a href="https://platform.xiaomimimo.com/" target="_blank" rel="noopener">MiMo 开发平台</a> 登录。</li><li>面板里选「小米 MiMo」，点「登录 MiMo 获取 Cookie」，会直接跳到小米账号登录页，登录完成窗口自动关闭。</li><li>Cookie 约 24 小时过期，过期后点「重新登录」即可。</li></ol>
<h3>4) New API / One API 中转站</h3>
<ol><li>你的中转站后台（如 <code>https://你的域名</code>）生成一个令牌（一般 <code>sk-</code> 开头）。</li><li>面板里选「New API / One API 中转站」，填站点地址（<strong>只填域名，不要带 /v1</strong>）和令牌。</li><li>如有用户 ID 需求（部分站点），一并填写；没有就留空。</li></ol>
<h3>5) 自定义（抓包填写）</h3>
<p>适合会抓包的开发者：填写请求地址、请求头，以及余额字段的取值路径（JSON 路径），支持倍率换算。</p>
<h3>6) 阿里云百炼 ⭐（重点，步骤较多）</h3>
<p>阿里云余额在「费用与成本」控制台（账号级），要给它授权一台只读的访问密钥（AccessKey），步骤如下：</p>
<p><strong>第 1 步：创建 RAM 用户（或直接用主账号，推荐新建一个）</strong></p>
<ul><li>打开 <a href="https://ram.console.aliyun.com/users" target="_blank" rel="noopener">RAM 控制台 - 用户</a>，点「创建用户」。</li><li>登录名随便取（如 <code>panel-read</code>），访问方式勾选「OpenAPI 调用访问」。</li><li>官方教程（可对照）：<a href="https://help.aliyun.com/zh/ram/product-overview/create-and-authorize-a-ram-user" target="_blank" rel="noopener">创建 RAM 用户并授权</a></li></ul>
<p><strong>第 2 步：给该用户授权 AliyunBSSReadOnlyAccess（关键！）</strong></p>
<ul><li>在 <a href="https://ram.console.aliyun.com/users" target="_blank" rel="noopener">用户列表</a> 找到刚创建的用户，点「新增授权」（或点进用户 → 权限管理 → 新增授权）。</li><li>搜索框输入 <code>AliyunBSSReadOnlyAccess</code>，勾选它（系统策略，只读费用查询，<strong>只读不会动到账务</strong>），确定即可。</li><li>官方教程（可对照）：<a href="https://help.aliyun.com/zh/ram/user-guide/grant-permissions-to-the-ram-user" target="_blank" rel="noopener">为 RAM 用户授权</a></li></ul>
<p><strong>第 3 步：创建 AccessKey</strong></p>
<ul><li>在 <a href="https://ram.console.aliyun.com/users" target="_blank" rel="noopener">用户列表</a> 点进该用户 → 「AccessKey 页签」→「创建 AccessKey」，按提示完成验证。</li><li><strong>立刻把「AccessKey ID」和「AccessKey Secret」都下载/复制下来</strong>（Secret 只在创建时显示一次，之后再也看不到，丢了只能重新创建）。</li><li>官方教程（可对照）：<a href="https://help.aliyun.com/zh/ram/product-overview/quick-start-create-and-use-accesskey-pairs-for-programmatic-calls" target="_blank" rel="noopener">创建并使用 AccessKey</a></li></ul>
<p><strong>第 4 步：填进面板</strong></p>
<ul><li>面板里选「阿里云百炼」，把 AccessKey ID 填第一栏、AccessKey Secret 填第二栏，保存。</li><li>新建的密钥要等 <strong>2~3 分钟</strong>才全局生效，刚创建完立刻刷新若报错，等一会儿再刷。</li></ul>
<p><strong>阿里云常见报错对照</strong>（卡片失败态下方的小字会显示原文/详情）：</p>
<p>| 详情里的关键字 | 含义 | 怎么办 |</p>
<p>|---|---|---|</p>
<p>| InvalidAccessKeyId / SignatureDoesNotMatch | ID 或 Secret 填错了（或刚建还没生效） | 检查是否复制完整、两栏是否填反；等待 2~3 分钟再刷新 |</p>
<p>| Forbidden / NoPermission / AccessDenied | 密钥没有费用查询权限 | 回到第 2 步，给该用户授权 AliyunBSSReadOnlyAccess |</p>
<p>| 网络不通 | 机器解析不了阿里云接口域名 | 检查网络/代理/DNS，稍后重试 |</p>
<p><strong>关于「API Key」</strong>：百炼控制台里「API-KEY 管理」的 <code>sk-</code> 开头密钥是<strong>调用模型</strong>用的令牌， 阿里云没有给它开放余额查询接口，所以<strong>不能用它查余额</strong>；查余额只能用上面这种 RAM AccessKey。</p>
<hr/>
<h2>三、日常使用</h2>
<ul><li><strong>自动刷新</strong>：默认每 60 秒刷新一次（可在设置里调整 15 秒~24 小时）。程序最小化到托盘时继续刷新。</li><li><strong>低余额提醒</strong>：每个账号可单独设置「剩余低于 X 时提醒」；触发后卡片余额变黄/显示「低余额」标记，并弹系统通知。</li><li><strong>单账号刷新</strong>：点卡片右上角箭头图标；失败卡片上有点击重试按钮。</li><li><strong>趋势图</strong>：点卡片右上角趋势按钮可看余额走势（保存在本机）。</li></ul>
<h2>四、常见问题</h2>
<ol><li><strong>提示「网络不通」</strong>：本机解析不了平台接口域名。换网络/关代理再试；阿里云已内置选择可解析的接入点。</li><li><strong>提示「密钥错了或过期了」</strong>：DeepSeek/New API 检查 Key 是否有效；阿里云看上方对照表；MiMo/硅基流动点「重新登录」。</li><li><strong>提示「网址填错了」</strong>：New API 站点地址只填域名，不要带 <code>/v1</code>；检查是否有特殊字符。</li><li><strong>余额显示为 0 / 字段找不到</strong>：多为平台返回结构变化，把小字详情发给开发者排查。</li><li><strong>换电脑怎么带配置</strong>：拷贝 <code>%APPDATA%\\API 余额面板</code> 整个文件夹过去即可（密钥是本机加密的）。</li></ol>
<hr/>
<h2>五、隐私说明</h2>
<ul><li>所有密钥 / Cookie 只保存在本机，使用系统级加密（Windows DPAPI）落盘，不会上传、不会进入任何日志。</li><li>程序只在每次刷新时请求各平台官方余额接口，无其他外联。</li><li>建议给阿里云等平台单独创建「只读」专用密钥，见上文授权步骤。</li></ul>
<h3>3b) 小米 MiMo 套餐（Token Plan）</h3>
<ul><li>「小米 MiMo」管<strong>余额</strong>（现金/赠送），「小米 MiMo 套餐」管<strong>套餐用量</strong>（用量/总额度/套餐名/有效期），两者<strong>共用同一个登录状态</strong>。</li><li>选「小米 MiMo 套餐」→ 点「登录 MiMo 获取 Cookie」会直接跳到小米账号登录页，登录完成窗口自动关闭；若你已添加过「小米 MiMo」，添加时勾选「同时添加另一个方式」可以一键把套餐卡片也加上。</li><li>卡片显示：套餐名（如 Lite）、已用 / 总额度（M Credits）、剩余量、有效期至 X 月 X 日。</li></ul>
<hr/>
<h3>7) MiniMax（余额 = 现金 + 代金券 + 授信 − 欠费）</h3>
<ol><li>打开 <a href="https://platform.minimaxi.com/" target="_blank" rel="noopener">MiniMax 开放平台</a> 或 <a href="https://platform.minimax.cn/" target="_blank" rel="noopener">国内站</a> 登录（面板会自动识别 .com / .cn 站点）。</li><li>面板里选「MiniMax」，点「登录 MiniMax」会直接打开统一登录页，登录完成窗口自动关闭并抓取余额（现金 + 代金券 + 授信 − 欠费）。</li><li>卡片显示「可用额度」，下面分行列出：现金、代金券、授信、欠费（为 0 的项自动隐藏）。</li><li>说明：MiniMax 的「余额」不是 API Key 的预充值，而是<strong>账户钱包</strong>（可充值 + 代金券），欠费会从可用额度里扣除。</li></ol>
<h3>8) 智谱 AI（只看余额）</h3>
<ol><li>打开 <a href="https://bigmodel.cn/" target="_blank" rel="noopener">智谱 BigModel 开放平台</a> 登录。</li><li>面板里选「智谱 AI」，点「登录智谱」会直接打开登录页，登录完成窗口自动关闭并抓取余额（账户余额；有可用授信时会一并展示）。</li></ol>
<hr/>
<h2>六、界面与新功能</h2>
<h3>1) 侧边栏导航</h3>
<p>左侧边栏是全部功能的入口（点一下即可切换整页视图）：</p>
<ul><li><strong>概览</strong>：账号卡片面板（按类型分组，组头可点击折叠）。</li><li><strong>每日使用状况</strong>：按日统计消耗 + 余额耗尽预估 + 导出报表。</li><li><strong>平台用量</strong>：按平台（类型）汇总的消耗统计。</li>
<li><strong>运行日志</strong>：全部运行记录（已脱敏，可导出）。</li>
<li><strong>主题外观</strong>：主题、背景图与玻璃效果。</li><li><strong>设置</strong>：刷新 / 提醒 / 主题 / 数据 / 关于。</li><li><strong>使用说明</strong>：本说明的整页版（不再弹窗，直接铺满内容区）。</li></ul>
<h3>2) 每日使用状况统计</h3>
<ul><li>数据来自程序每次刷新自动记录的历史快照，无需额外开启；没数据时页面会提示。</li><li>口径：<strong>套餐型账号</strong>（如小米 MiMo 套餐）直接用「已用」增量；<strong>余额型账号</strong>按「剩余变化」估算（中途充值会掩盖消耗，仅供参考）。</li><li><strong>停机期间消耗</strong>：如果中间彻底退出过软件（关窗缩到托盘不算），重新打开后这段余额下降无法按天归属，会单独列在表格的「停机期间」列、并在日历对应日子打上 <strong>⏸</strong> 标记，<strong>不计入每日均值、耗尽预估和预算判断</strong>（避免把多天消耗堆到重新打开的那一天）。</li><li><strong>近 7 天</strong>：消耗信息卡 + 按单位柱状图 + 账号×日期明细表。</li><li><strong>近 30 天</strong>：日历形态——按自然月展示，格子颜色越深当天消耗越多（按主单位归一化）；每月顶部显示<strong>每月消耗合计、消耗最多的日期、消耗最多的账号</strong>；点击任意有数据的天，弹窗显示当天每个账号的用量明细和单位合计。</li></ul>
<h3>3) 余额耗尽预估</h3>
<ul><li>按近 7 天日均消耗外推剩余可用天数；只有 ≥2 天有效数据才会推算。</li><li>概览页卡片上会显示「预计 MM-DD 耗尽 · 约剩 N 天」（&lt;3 天红、&lt;7 天黄）；每日使用状况页也会列出每个账号的预计耗尽日期。</li></ul>
<h3>4) 导出 CSV</h3>
<ul><li>每日使用状况页右上角「导出 CSV」：账号 × 日期全量明细 + 按单位合计，含 BOM，Excel 直接打开不乱码。</li></ul>
<h3>5) 平台用量统计</h3>
<ul><li>按平台类型 × 单位聚合（对应「每日使用状况」的账号级口径），支持近 7 / 30 天切换。</li><li>顶部信息卡：总消耗、消耗最多平台、今日消耗。</li><li>平台消耗对比条形图 + 平台×日期明细表（含今日、7日均、合计），支持导出 CSV。</li></ul>
<h3>6) 浅色主题</h3>
<ul><li>设置 → 显示 → 主题，可切换深色 / 浅色，立即生效并记住选择。</li></ul>
<hr/>
<h2>七、监控与玩法（新功能）</h2>
<h3>1) 接口监控（自己填 Key + 地址的正式监控）</h3>
<ul><li>在「Key 管理」页顶部切换到「接口监控」标签页，点「添加监控目标」：填写<strong>调用地址</strong>、<strong>API Key</strong>，选择 POST（LLM 对话接口）或 GET（只读接口），可自定义请求头与请求体。</li><li>面板会<strong>按你设定的间隔真实调用该接口</strong>，记录每次的成功/失败、HTTP 状态码与响应耗时，并统计<strong>可用率、平均/P95 延迟、连续失败次数</strong>，以及近 30 天的每日可用率状态条；每个目标都能查看完整检查记录。</li><li>填完可以先点「试跑一次」验证配置（会真实调用一次，不保存、不计入统计），确认没问题再保存。</li><li><strong>费用提示</strong>：真实调用 LLM 接口会产生极少量费用，默认 POST 请求体已把 <code>max_tokens</code> 设为 1；也可以用 GET 模式指向平台的只读接口（如 <code>/models</code>）做到 0 费用。检查间隔最短 1 分钟，建议按需要设为 5~30 分钟。</li><li>API Key 与账号密钥使用同一套本机加密（safeStorage），界面上只显示 <code>sk-****1234</code> 形式的掩码，明文不落盘。</li><li>目标可以单独「暂停/启用」，暂停后不再检查但历史保留；窗口最小化/隐藏时<strong>仍会继续检查</strong>，保证监控数据连续。</li></ul>
<ul><li>请求头与请求体里可以用 <code>{{key}}</code> 占位符，会替换成你填的 API Key（例如 <code>x-api-key: {{key}}</code>）；默认会自动带上 <code>Authorization: Bearer &lt;key&gt;</code>，如果你已经自定义了 Authorization / x-api-key 则不会重复添加。</li></ul>
<h3>2) 每日预算与告警</h3>
<ul><li>「设置 → 每日预算与告警」里按单位设置每天最多花多少（例如 CNY 每天 50）。概览页会出现预算进度条：今日已用、剩余额度、以及「按这个节奏余额还能用约 N 天」。</li><li>达到预算 80% 和 100% 时各提醒一次。</li><li>另外两类告警：<strong>余额骤降</strong>（单次刷新内跌幅超过设定百分比，默认 30%）与<strong>接口异常</strong>（连续查询失败达到设定次数，默认 3 次）。</li><li>「每日使用状况」会给每个账号一个<strong>建议阈值</strong>（近 7 天日均 × 3，约 3 天用量），可以据此调整账号的低余额阈值。</li></ul>
<h3>3) 使用报告与分享卡片</h3>
<ul><li><strong>使用报告</strong>页支持日报 / 周报 / 月报：总消耗、环比上期、活跃天数、日均、平台消耗构成、24 小时时段分布、疑似充值记录，以及一段「这段时间的你」趣味总结。</li><li>「生成分享卡片」会把报告画成一张 900×1200 的图片（PNG）保存到下载目录，可以直接发群里。</li><li>说明：报告<strong>只基于金额消耗</strong>——各平台接口不提供按模型 / Token 的调用明细，所以没有「最爱的模型」「消耗了多少 Token」这类数据；时段分布由快照采样推断，刷新间隔越短越准（5 分钟刷新可定位到小时级）。</li></ul>
<h3>4) 新手引导与演示模式</h3>
<ul><li>首次启动（还没有账号时）会弹出三步引导，可以「添加第一个账号」或「先看演示模式」。</li><li><strong>演示模式</strong>内置 6 个示例账号与最近 30 天的示例数据，能完整体验卡片、日历、统计、报告、接口监控等全部功能；数据只存在内存里，<strong>不会写入你的配置、不发起任何请求</strong>，点「退出演示」即恢复。</li><li>各个新功能标题旁的「?」是即时说明，鼠标悬停即可看到这个功能是怎么算的。</li></ul>
<h3>5) 托盘与通知</h3>
<ul><li>托盘图标悬停会显示「最低余额账号」或「几个账号查询失败」；右键菜单直接列出各账号余额，并提供<strong>立即刷新 / 暂停自动刷新 / 显示主面板 / 退出</strong>。</li><li>系统通知共四类：低余额、余额骤降、接口连续失败、每日预算超支。</li></ul>
<h3>6) 备份与恢复</h3>
<ul><li>「设置 → 数据 → 备份与恢复」可以一键导出全部配置与历史（JSON，密钥仍是本机加密后的密文），换电脑时导入即可恢复账号与设置。</li><li>注意：密钥密文与原电脑的系统账号绑定，导入后可能需要重新填写密钥；导入前会自动把原配置另存为 <code>config.json.pre-import.bak</code>。</li></ul>
<h3>7) 主题与背景</h3>
<ul><li>「设置 → 显示 → 主题」支持<strong>深色 / 浅色 / 跟随系统</strong>三种，跟随系统时会随 Windows 主题实时切换。</li></ul>
<hr/>`

const scrollRef = ref<HTMLElement | null>(null)
const bodyRef = ref<HTMLElement | null>(null)
const toc = ref<{ id: string; text: string }[]>([])
const active = ref('')
let obs: IntersectionObserver | null = null

function buildToc() {
  const body = bodyRef.value
  if (!body) return
  toc.value = Array.from(body.querySelectorAll('h2')).map((el, i) => {
    const text = (el.textContent || '').trim()
    const id = 'sec-' + i
    el.id = id
    return { id, text }
  })
}

function setupObserver() {
  if (obs) obs.disconnect()
  const body = bodyRef.value
  const root = scrollRef.value
  if (!body || !root) return
  obs = new IntersectionObserver(
    (entries) => {
      const vis = entries.filter((e) => e.isIntersecting)
      if (vis.length) active.value = (vis[0].target as HTMLElement).id
    },
    { root, rootMargin: '-64px 0px -72% 0px', threshold: 0 }
  )
  for (const el of body.querySelectorAll('h2')) obs.observe(el)
}

function scrollTo(id: string) {
  active.value = id
  const el = document.getElementById(id)
  const sc = scrollRef.value
  if (!el || !sc) return
  const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 24
  sc.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
}

onMounted(() => {
  buildToc()
  nextTick(setupObserver)
})
onBeforeUnmount(() => { if (obs) obs.disconnect() })
</script>

<template>
  <section class="help-pane">
    <!-- 封面区 -->
    <div class="help-hero">
      <div class="hero-logo" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
          <path d="M3 15l4-5 4 3 6-8" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M15 5h4v4" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
      <div class="hero-text">
        <h1>API 余额面板</h1>
        <p class="hero-sub">本地余额监控 · 定时刷新 · 低余额提醒 · 每日用量统计与平台用量对比</p>
        <div class="hero-tags">
          <span class="hero-tag">密钥本机加密</span>
          <span class="hero-tag">直连平台接口</span>
          <span class="hero-tag">绿色免安装</span>
        </div>
      </div>
    </div>

    <div class="help-layout">
      <!-- 左目录 -->
      <aside v-if="toc.length" class="help-toc">
        <div class="toc-title">本页目录</div>
        <button v-for="t in toc" :key="t.id" class="toc-item" :class="{ on: active === t.id }" type="button" @click="scrollTo(t.id)">
          <span class="toc-dot"></span>
          <span class="toc-text">{{ t.text }}</span>
        </button>
      </aside>

      <!-- 右内容 -->
      <div class="help-scroll" ref="scrollRef">
        <div class="help-body" ref="bodyRef" v-html="docHtml"></div>
        <div class="help-foot">
          <span class="foot-line"></span>
          以上说明与压缩包内的 docs/使用说明.md 保持同步 · 平台教程有更新时，以最新版为准
          <span class="foot-line"></span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.help-pane { display: flex; flex-direction: column; height: 100%; min-height: 0; }

/* ===== 封面区 ===== */
.help-hero {
  flex: none;
  display: flex;
  align-items: center;
  gap: 16px;
  margin: 18px var(--pad-lg) 8px;
  padding: 18px 22px;
  border-radius: 16px;
  background: var(--card);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
  background-image: linear-gradient(120deg, var(--acc-soft) 0%, transparent 55%);
}

.hero-logo {
  width: 46px; height: 46px; flex: none;
  border-radius: 13px;
  background: var(--acc-grad);
  display: inline-flex; align-items: center; justify-content: center;
  box-shadow: 0 6px 18px rgba(79, 140, 255, 0.38);
}

.hero-text h1 {
  margin: 0;
  font-size: 19px; font-weight: 800;
  color: var(--tx-strong);
  letter-spacing: 0.3px;
}

.hero-sub {
  margin: 4px 0 0;
  font-size: 12.5px;
  color: var(--tx3);
  letter-spacing: 0.2px;
}

.hero-tags { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.hero-tag {
  font-size: 10.5px; font-weight: 600;
  color: var(--acc);
  background: var(--acc-soft);
  border: 1px solid var(--line-soft);
  padding: 2px 9px;
  border-radius: 999px;
}

/* ===== 两栏布局 ===== */
.help-layout {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: var(--gap);
  padding: 10px var(--pad-lg) 24px;
}

.help-toc {
  flex: none;
  width: 178px;
  padding-top: 8px;
}

.toc-title {
  font-size: 11px; font-weight: 700;
  color: var(--tx3);
  letter-spacing: 1.2px;
  margin-bottom: 10px;
  padding-left: 12px;
}

.toc-item {
  display: flex; align-items: center; gap: 8px;
  width: 100%;
  border: none; background: transparent;
  font-size: 12px; font-weight: 500;
  color: var(--tx2);
  text-align: left;
  padding: 7px 10px;
  border-radius: 9px;
  cursor: pointer;
  transition: background var(--dur) ease, color var(--dur) ease;
}

.toc-item:hover { background: var(--panel2); color: var(--tx); }

.toc-item.on { background: var(--acc-soft); color: var(--acc); font-weight: 600; }
.toc-item.on .toc-dot { background: var(--acc); box-shadow: 0 0 0 3px var(--acc-soft); }

.toc-dot {
  width: 5px; height: 5px; flex: none;
  border-radius: 50%;
  background: var(--track);
  transition: background var(--dur) ease;
}

.toc-text {
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.help-scroll {
  flex: 1; min-width: 0;
  overflow-y: auto;
  padding: 8px 6px 30px 10px;
}

.help-foot {
  display: flex; align-items: center; gap: 12px;
  margin-top: 28px;
  font-size: 11.5px;
  color: var(--tx3);
}

.foot-line { flex: 1; height: 1px; background: var(--line); }

/* ===== 正文精排 ===== */
.help-body {
  font-size: 13.5px;
  line-height: 1.85;
  color: var(--tx2);
  max-width: 920px;
}

.help-body :deep(h1) { display: none; }

.help-body :deep(h2) {
  position: relative;
  font-size: 16.5px; font-weight: 750;
  color: var(--tx-strong);
  margin: 30px 0 14px;
  padding: 0 0 10px 14px;
  border-bottom: 1px solid var(--line);
  scroll-margin-top: 20px;
}

.help-body :deep(h2)::before {
  content: '';
  position: absolute; left: 0; top: 3px; bottom: 12px;
  width: 4px;
  border-radius: 3px;
  background: var(--acc-grad);
}

.help-body :deep(h3) {
  font-size: 14px; font-weight: 700;
  color: var(--tx);
  margin: 20px 0 8px;
  padding-left: 10px;
  border-left: 3px solid var(--acc-2);
  border-radius: 2px;
}

.help-body :deep(p) { margin: 9px 0; }

.help-body :deep(strong) { color: var(--tx-strong); font-weight: 650; }

.help-body :deep(a) { color: var(--acc); text-decoration: none; border-bottom: 1px dashed var(--line-strong); }
.help-body :deep(a:hover) { border-bottom-style: solid; }

.help-body :deep(code) {
  font-family: ui-monospace, Consolas, "Cascadia Mono", monospace;
  font-size: 12px;
  color: var(--acc-2);
  background: var(--panel2);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 1px 6px;
  word-break: break-all;
}

.help-body :deep(blockquote) {
  position: relative;
  margin: 12px 0;
  padding: 10px 14px 10px 34px;
  background: var(--acc-soft);
  border: 1px solid var(--line-soft);
  border-left: 3px solid var(--acc);
  border-radius: 10px;
  color: var(--tx2);
}

.help-body :deep(blockquote)::before {
  content: 'ℹ';
  position: absolute; left: 12px; top: 9px;
  font-size: 13px; font-weight: 800;
  color: var(--acc);
}

.help-body :deep(ul), .help-body :deep(ol) { margin: 9px 0; padding-left: 22px; }
.help-body :deep(li) { margin: 4px 0; }
.help-body :deep(li)::marker { color: var(--acc); font-weight: 600; }
.help-body :deep(li > strong) { color: var(--tx); }


</style>
