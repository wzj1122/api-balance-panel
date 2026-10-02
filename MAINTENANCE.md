# API 余额面板 · 维护手册（MAINTENANCE）

> 本文件是本软件唯一的维护入口文档。**任何修改前必读，修改完成后必须把改动同步回本文件。**
> 最后更新：2026-10-03 ｜ 当前版本：1.8.0

---

## 一、软件简介

**它是什么**：`api-balance-panel`（产品名「API 余额面板」）是一个常驻 Windows 桌面的小窗口。打开就能在一屏里看完所有 AI 平台账号的余额，余额低于阈值自动变色 + 系统通知，不用再逐个登后台。

**解决什么问题**：多平台（DeepSeek / 硅基流动 / 小米 MiMo / MiMo TokenPlan / MiniMax / bigmodel 智谱 / 阿里云百炼 / 商汤 SenseNova）账号分散，余额与用量要一个个登录控制台看。本工具统一抓取、统一展示，并附带每日用量统计、平台用量对比、AI 使用报告、接口可用性监控、Key 管理。

**目标用户**：同时使用多个 AI 平台、需要盯余额与用量的个人开发者（单机、单用户）。

**运行环境**：Windows 10 / 11（x64）；开发需 Node.js 22（仓库内置 npmmirror 镜像，见 `app/.npmrc`）。

**技术栈**：Electron 44.2.0 + Vue 3.5.42 + Vite 7.3.6 + TypeScript 5.9.3，构建器 `electron-vite` 5.0.0 三段构建，打包 `electron-builder` 26.x（NSIS x64）。

**关键铁律**：所有联网请求只在**主进程**发起；渲染进程永远拿不到密钥明文，也永不直接发 HTTP 请求。

### 版本号在哪里

| 位置 | 说明 |
|---|---|
| `app/package.json` → `version` | **唯一真源**，当前 `1.8.0`。界面左下角版本号、`app:info` 通道、备份文件 `app` 字段都取自这里 |
| `app/package.json` → `productName` | `API 余额面板`。**决定 userData 目录名**（`%APPDATA%\API 余额面板\`）与安装包/快捷方式名，**一期定名后不可改**，改了老用户配置全部"找不到" |
| `app/package.json` → `name` | `api-balance-panel`。开发模式（无 productName）才用它当 userData 名 |
| `README.md` / `CHANGELOG.md` / `docs/*` | 手工同步的版本号引用，改版本时必须一起改 |

### 如何开发调试

```bash
cd app
npm install          # 首次；走 .npmrc 里的 npmmirror
npm run dev          # electron-vite dev，主/预加载/渲染三段热重载
npm run typecheck    # vue-tsc（渲染）+ tsc（主进程），打包前必过
npm run build        # 三段构建，输出 out/
npm run start        # electron-vite preview，跑构建产物
```

`npm run dev` 时主进程通过 `process.env.ELECTRON_RENDERER_URL` 加载开发服务器（见 `src/main/window.ts`），生产才 `loadFile(out/renderer/index.html)`。

### 如何打包发布

```bash
cd app
npm run dist:win     # electron-vite build + electron-builder --win --x64 → app/dist/
```

产物：`app/dist/API 余额面板 Setup <版本>.exe`（NSIS 安装包）+ `app/dist/win-unpacked/`（绿色版，`API 余额面板.exe` 必须连同同级 `resources/` 一起分发）。`dist/` 与 `out/` 已被 `.gitignore` 忽略，**不进 Git**。

`package.json` 的 `build` 段负责：`extraResources` 把 `resources/icon.png`、`tray.png`、`tray-alert.png`、`resources/backgrounds/` 拷进安装包 `resources/`（运行期用 `process.resourcesPath` 取，见 `tray.ts` / `bgstore.ts`）；`win.icon` 用 `resources/icon.ico`；`nsis` 段为「可选安装目录、当前用户安装、建桌面与开始菜单快捷方式」。

### 两个必须知道的坑

1. **打包后 CSS 必须内联**：生产用 `file://` 加载 HTML，外链 `<link rel="stylesheet">` 在 `file://` 下**不生效**，会导致"样式全丢 + `position:fixed` 弹窗点不动"。修复在 `app/electron.vite.config.ts` 的自定义插件 `inlineCssPlugin()`（把 CSS 内联为 `<style>`、删掉 `.css` 产物与 `crossorigin`）。**不要删这个插件**。
2. **别名两处都要配**：`@shared` / `@main` / `@renderer` 同时配在 `electron.vite.config.ts` 与 `tsconfig.json`，只配一处会出现"IDE 不报错但运行找不到模块"。

---

## 二、目录结构总览

```
api-show/
├── MAINTENANCE.md          # 本文件（唯一维护入口）
├── README.md               # 面向用户/访客的项目主页
├── CHANGELOG.md            # 版本变更记录（头部追加）
├── LICENSE                 # 专有许可（Source-available）
├── .gitignore              # 仓库根忽略（app/ 下另有一份更细的）
├── app/                    # 应用工程（全部代码在这里）
│   ├── package.json        # 版本号真源 + 依赖 + 脚本 + electron-builder 配置
│   ├── electron.vite.config.ts  # 三段构建配置 + CSS 内联插件
│   ├── tsconfig*.json      # 根 references / node（主进程）/ web（渲染）
│   ├── .npmrc / .gitignore
│   ├── src/
│   │   ├── main/           # 主进程（Node 侧，唯一联网方）
│   │   │   ├── adapters/   # 每家平台一个文件（取数 + 解析）
│   │   │   └── browser/    # 内置浏览器登录 + 抓 Cookie（不装 Playwright）
│   │   ├── preload/        # contextBridge 白名单（window.api）
│   │   ├── renderer/       # Vue 3 界面（index.html 在 renderer 根）
│   │   └── shared/         # 两端共用类型 / 常量 / IPC 通道 / 格式化 / 折算
│   ├── resources/          # 图标 + 14 张内置背景图
│   ├── scripts/            # 正式验证脚本（verify.js / verify-adapters.mjs）+ 图标生成
│   ├── out/                # 构建产物（忽略，git 不进）
│   └── dist/               # 打包产物（忽略，git 不进）
├── docs/                   # 设计与需求文档（历史 + 现行说明）
├── memory/                 # 开发过程日志（.gitignore 已忽略，不推送）
└── 归档/                   # 一次性诊断脚本归档
```

---

## 三、文件用途清单

> 表格列：`路径` | `用途` | `备注`。路径除特别标注外，均相对 `E:\program\api-show\`。

### 3.1 仓库根目录

| 路径 | 用途 | 备注 |
|---|---|---|
| `MAINTENANCE.md` | 本维护手册 | 改前必读、改后必同步（文件清单 + 变更记录 + 头部日期/版本） |
| `README.md` | 项目主页：功能一览、安装、快速开始、常见问题、本地构建、目录结构、隐私与许可 | 用户可见行为变化时必须同步；内含历史版本号引用（如 `API.Setup.1.3.0.exe`），改版本时一并检查 |
| `CHANGELOG.md` | 版本变更记录 | 每次升版本**头部追加**一条（版本号、日期、摘要） |
| `LICENSE` | 专有许可全文（Source-available，保留所有权利） | 版权 © 2026 Zhenjie Wang；`package.json` 的 `license` 指向它 |
| `.gitignore` | 仓库根忽略：node_modules / dist / out / logs / `*.log` / `.e2e-*/` / `scripts/.tmp/` / `scripts/.verify/` / `config.json` `config.json.bak` `config.json.tmp` `snapshots.json` `*.corrupt-*.json` / `memory/` | **`memory/` 被忽略**：开发日志不进公开仓库。用户数据文件必须始终在此列表内 |
| `docs/` | 见 3.8 | — |
| `memory/` | 见 3.9 | 开发日志，已忽略 |
| `归档/` | 见 3.9 | 一次性脚本归档 |

### 3.2 app/ 工程配置

| 路径 | 用途 | 备注 |
|---|---|---|
| `app/package.json` | **版本号真源** + 依赖 + npm 脚本 + electron-builder 打包配置 | 改版本只改这里的 `version`；`productName` 决定 userData 目录名，**不可改**；`main` 指向 `./out/main/index.js` |
| `app/electron.vite.config.ts` | electron-vite 三段构建（main / preload / renderer）+ 别名 + **`inlineCssPlugin()` CSS 内联插件** | 别名 `@shared` `@main` `@renderer` 必须与 `tsconfig.json` 同步；renderer `base: './'` 与内联插件是打包后样式能生效的前提，**删了会复现"裸 HTML + 按钮点不动"** |
| `app/tsconfig.json` | 根配置：references 指向 node/web，集中声明 `paths` 别名 | 别名只配这里 + vite 配置两处，别处不要重复定义 |
| `app/tsconfig.node.json` | 主进程 + preload + shared 的 TS 配置（typecheck 的 tsc 半边） | `npm run typecheck` 用它检查主进程 |
| `app/tsconfig.web.json` | 渲染进程 TS 配置（typecheck 的 vue-tsc 半边） | include 了 `src/preload/index.d.ts`，所以 `window.api` 有类型 |
| `app/.npmrc` | npmmirror registry + electron/dist 二进制镜像 | 国内网络必需，不要改成官方源 |
| `app/.gitignore` | app 内的忽略（node_modules / out / dist / logs / 用户数据 / 脚本临时产物） | 与根 `.gitignore` 呼应，用户数据文件两边都要在 |
| `app/README.md` | 面向**开发者**的工程说明：安装启动、目录说明、密钥保管、**如何新增一个平台适配器**、自定义平台抓包步骤、常见问题 | 新增适配器时按第 4 节流程走；文档与实现不一致时以代码为准并回来改这里 |

### 3.3 app/scripts 与 app/resources

| 路径 | 用途 | 备注 |
|---|---|---|
| `app/scripts/verify.js` | **正式回归脚本**：配置读写 / 加密落盘 / 损坏回滚归档 / 归一化兜底 / 快照（18 项断言），长期保留 | 需先 `npx tsc -p scripts/tsconfig.verify.json` 编译到 `scripts/.tmp/`，再 `npx electron scripts/verify.js`（必须用 electron 当 node，因为要 `safeStorage`）。`.tmp/` 属临时产物，用完应清理 |
| `app/scripts/verify-adapters.mjs` | **正式回归脚本**：适配器 + 并发池 + 错误映射，用 esbuild 打包纯逻辑 + stub `globalThis.fetch` 喂假响应，**不需要真实密钥**，47 项断言 | 运行 `node scripts/verify-adapters.mjs`；产物在 `scripts/.verify/`（临时，用完清理）。改动 adapters / runPool / errors 后应跑一遍 |
| `app/scripts/tsconfig.verify.json` | 上面 verify.js 的编译配置：把 `src/main` + `src/shared` 编译成 CommonJS 到 `scripts/.tmp` | 不属于主构建流程；改了 `src/main` 的模块结构一般不用动 |
| `app/scripts/gen-icon.py` | 由 PNG 生成多尺寸 `resources/icon.ico` | 换图标时才用；需 Python 图像库 |
| `app/resources/icon.ico` | Windows 应用图标（exe / 安装包 / 快捷方式） | 由 `package.json` 的 `build.win.icon` 引用 |
| `app/resources/icon.png` | 运行时用主图标：安装包 `extraResources` 拷到 `resources/`，被托盘图标复用（`tray.ts`，缩到 16×16） | 换图后必须重新打包才生效 |
| `app/resources/tray.png` / `tray-alert.png` | 托盘图标资源（当前 `tray.ts` 统一只用 `icon.png`，**不随状态变色**） | `tray-alert.png` 目前仅被 `extraResources` 拷贝、无代码引用 → 属于**待清理的历史资源** |
| `app/resources/backgrounds/*.png` | **14 张内置背景图**（逐文件）：`builtin-dark.png`、`builtin-light.png`、`cute-bluepink-dark.png`、`cute-bluepink-light.png`、`deep-space-dark.png`、`deep-space-light.png`、`editorial-mono-dark.png`、`editorial-mono-light.png`、`fluent-acrylic-dark.png`、`fluent-acrylic-light.png`、`scifi-3d-dark.png`、`scifi-3d-light.png`、`soft-pastel-dark.png`、`soft-pastel-light.png`（6 个设计方向 × 深/浅 + `builtin` 兜底对） | 文件名即主题 slug：`bgstore.ts` 的 `backgroundForTheme()` 按 `<theme>.png` 找图，`dark`/`light` 特殊映射到 `builtin-dark.png` / `builtin-light.png`。**加主题必须同步加对应背景图**，否则该主题没有默认背景 |

### 3.4 app/src/main 主进程

**应用装配与窗口**

| 路径 | 用途 | 备注 |
|---|---|---|
| `app/src/main/index.ts` | 应用入口：单实例锁、`whenReady` 装配（ensureDirs → store.load → createWindow → createTray → 监控定时器 → refreshAutoStart → registerIpc → scheduler.start → 会话保活）、`second-instance` 唤起主窗、崩溃/未捕获异常落日志、`before-quit`/`will-quit` 收尾（退出前 `flush()` 快照） | 新增全局定时器/生命周期钩子加在这里；窗口隐藏/最小化时 `scheduler.pause()` 的逻辑也在此（受 `pause_when_hidden` 控制，**开机自启启动例外**） |
| `app/src/main/window.ts` | 主窗口：1100×760（最小 900×600）、`frame:false` 自绘标题栏、`contextIsolation:true` / `nodeIntegration:false`、关窗拦截为隐藏到托盘、`ready-to-show` 才显示、渲染 console 转发到主进程日志、最大化状态推送 `window:state` | `isAutoStartLaunch()` 判定 `--open-at-login`（开机自启静默启动不弹窗）；`setQuitting(true)` 才允许真关。**不要把 `contextIsolation` 关掉**，preload 会直接抛错拒绝加载 |
| `app/src/main/tray.ts` | 系统托盘：左键显示主面板、右键菜单（显示主面板 / 退出）、tooltip 显示"最低余额账号 / 失败数 / 已暂停刷新" | 图标路径：打包用 `process.resourcesPath`，开发用 `__dirname/../../resources`。**tooltip 依赖 `updateTray(rows)` 被调用**（`query.ts` 刷新后调用） |
| `app/src/main/autostart.ts` | 开机自启（Windows）：官方 API 写 → 回读注册表校验 → `reg.exe` 直写 `HKCU\...\Run` 兜底 → 清 `StartupApproved` 禁用标记 → 回读真实状态 | 名字必须是 `productName`（`API 余额面板`）；开发模式不写启动项；`refreshAutoStart()` 在启动时校准被优化软件删掉的启动项 |
| `app/src/main/scheduler.ts` | 定时刷新单例：`start/reset`（热改间隔，不用重启）、`pause/resume`（resume 会立刻补刷一次）、`isPaused` | 改刷新间隔：`ipc.ts` 的 `SETTINGS_SAVE` 里比较前后值后调 `scheduler.reset()` |
| `app/src/main/logger.ts` | 统一日志：级别 debug/info/warn/error、内存环形缓冲 3000 条 + 文件追加、2MB 轮转保留 8 个、**写入前脱敏**（`sk-*` / cookie / authorization / api key / access key / secret / token / 邮箱 / 手机号） | 启动时把上次 `main.log` 尾部 400 行读回缓冲；`exportLogs()` 只导出内存缓冲（不是全部历史文件）。**新增日志文案不要写真实凭据**，即便有脱敏也别赌 |
| `app/src/main/paths.ts` | 数据目录与文件常量：`DATA_DIR`（userData）、`CONFIG_FILE` / `CONFIG_BAK` / `CONFIG_TMP` / `SNAPSHOT_FILE` / `LOG_DIR` / `LOG_FILE`、`ensureDirs()`、`corruptFileName()` | 其他新增数据文件（如 `keys.json` `monitors.json` `corrections.json`）分别在各自模块里用 `path.join(DATA_DIR, ...)` 拼；新增时统一风格并在此说明 |
| `app/src/main/errors.ts` | 错误码 → 人话文案**唯一真源**（`ERROR_TEXT`）、`mapHttpStatus()`、`mapFetchError()`、`errorText()`、`failResult()`、`AdapterError` 类 | 适配器只抛错误码，不写中文文案。新增错误码要同时改 `shared/types.ts` 的 `ErrorCode` 与这里的表 |

**数据层（配置 / 快照 / 校正 / Key 库）**

| 路径 | 用途 | 备注 |
|---|---|---|
| `app/src/main/store.ts` | 配置读写核心（`config.json`）：原子写（tmp + fsync + rename）、`.bak` 节流备份（10 分钟一次）、损坏回滚（`recovered`）/重置（`reset`）+ 坏文件归档为 `config.corrupt-<ts>.json`；逐字段归一化（`normalizeSettings` / `normalizeAccount`）；账号 CRUD、回收站（软删/恢复/彻底删）、批量改启停与标签、密钥加解密读写（`getSecret` / `revealSecret` / `fingerprint`）、**会话凭据** `getSession` / `saveCredential`、提醒计数 `getNoticeState` / `bumpNotice`、`toView()` 去掉 `secret_enc` | 新增设置项：① `shared/constants.ts` 的 `DEFAULT_SETTINGS` ② 这里的 `normalizeSettings` ③ `shared/types.ts` 的 `Settings` —— 三处缺一会出现"设置重启后丢失" |
| `app/src/main/snapshot.ts` | 余额快照（`snapshots.json`）：追加（同步改内存、异步节流 1s 落盘）、裁剪（默认 30 天 + 单账号 2000 条，天数取用户设置）、原子 `flush()`（写盘期间的新请求排队补写，不丢数据）、`readSnapshots()`（**套用校正，所有历史统计的唯一出口**）与 `readSnapshotsRaw()`（给校正页看原值）、`listByAccount()`、`removeByAccount()` | 演示模式返回 `demoSnapshots()` 且不落盘。**所有统计/图表必须走 `readSnapshots()`**，走 raw 会绕过用户校正 |
| `app/src/main/corrections.ts` | 数据校正账本（`corrections.json`）：`offset`（某时刻起整体平移）/ `set`（某时刻起设为定值）/ `ignore`（某段快照剔除统计），`loadCorrections` / `totalOffset` / `applyCorrections` / `addCorrection` / `removeCorrection` / `clearCorrections` | 设计要点：**只做"从某一时刻起整体平移"**，不改原始快照，因此可撤销、相邻快照差值不变、后续每日消耗仍准确。**不要改成"只改单点"**，会算错消耗 |
| `app/src/main/keyvault.ts` | 独立 Key 库（`keys.json`）：与账号单向（Key 库里新建的**不会**变成账号、不查余额），密钥同走本机加密，`saveVaultKey` / `removeVaultKey` / `revealVaultKey` / `vaultFingerprint` | 坏文件先改名归档再重建（不静默覆盖现场） |
| `app/src/main/keys.ts` | Key 管理汇总（只读）：账号 + Key 库合并成 `KeyRow`，安全审计四类（① 超 30 天没成功刷新 ② 近 7 天无消耗但余额高 ③ 同一密钥被重复添加 ④ 密钥格式异常 `KEY_RULES`），并汇总标签列表 | 不额外落盘：标签与回收站字段存在 `config.json` 的账号上。新增平台密钥格式规则加到 `KEY_RULES` |
| `app/src/main/crypto.ts` | 密钥加解密：`safeStorage-v1`（Windows DPAPI，系统级）/ `obfuscate-v1`（本机弱混淆，主机名+用户名做盐的 XOR）双方案；`isSecure()` / `currentScheme()` / `encrypt()` / `decrypt()` / `decryptWithFallback()`（主方案解不开自动试另一种） | 方案与版本写入 `config.json` 的 `crypto`。**降级方案不是加密**，此时界面顶部必须显示黄色横幅（`usePanel` 的 `configBanner`）。未来换方案：在 `SCHEMES` 加一条，旧配置不用迁移 |
| `app/src/main/backup.ts` | 配置备份/恢复：导出（`config.json` 原文 + 可选快照）为 JSON；导入（校验 `kind: api-balance-panel-backup` → 当前配置另存 `config.json.pre-import.bak` → 覆盖 → `store.load()`） | 换电脑后 safeStorage 密钥不同，密文解不开，需重新填密钥（账号与设置保留）——界面文案里要维持这个提示 |
| `app/src/main/bgstore.ts` | 自定义背景图：列表（内置 + 用户，`backgrounds/`）、导入（白名单扩展名 + 8MB 上限 + 重命名）、删除、转 data URL、`backgroundForTheme()` 主题 → 内置默认背景 | **扩展名白名单**是安全边界（防"目录内任意文件转 base64"）；新增支持格式要同时改 `ALLOWED`、`dialog` 过滤器与 `backgroundData` 的 MIME 判断 |
| `app/src/main/monitor.ts` | 接口监控：`monitors.json`（目标：URL/方法/请求体/头/`{{key}}` 占位、间隔、超时、启停）+ `monitor-history.json`（检查历史，单目标 1000 / 总 6000 条）；`runCheck()` 真实调用、`runDueMonitors()` 到点才跑、`runMonitors()` 立即跑、`testMonitor()` 试跑不保存、`buildMonitorReport()` 统计（成功率 / 均值 / P95 / 连续失败 / 每日可用率）、`removeMonitorsBySecret()` 随账号删除清理 | 与"余额轮询"是两件事：这里是对用户指定的线上接口做真实调用（默认请求体 `max_tokens:1` 压成本）。**窗口隐藏时仍继续检查** |
| `app/src/main/demo.ts` | 演示模式内存沙箱：6 个示例账号 + 最近 30 天示例快照（确定性伪随机、含一次充值、少量失败、一个套餐卡示例）、`demoRows()` 当前余额行 | **不写盘、不发请求**；`setDemo(false)` 清快照缓存。示例数据形状要与真实适配器输出保持一致（尤其 `PlanUsageInfo`），否则演示与实机表现不一致 |

**查询 / 通知 / 续期 / 网络**

| 路径 | 用途 | 备注 |
|---|---|---|
| `app/src/main/query.ts` | 余额查询核心：结果缓存（`cache_seconds`）、`runPool` 并发池、适配器分发、单账号失败兜底为 `failResult`、**每完成一条推 `balance:row`**、整批完成推 `balance:updated` + 写快照 + `maybeNotify` + 更新托盘；`invalidateCache()`；静默续期入口 `renewForAccount()`（互斥 + 5 分钟冷却）；会话保活 `keepAliveSessions()` / `decideRenewal()` / `startKeepAlive()` / `stopKeepAlive()`（每 5 分钟检查，临期/过期/到期时间读不出都续） | 单账号刷新时 `refresh()` 会把缓存里其它启用账号补进 `rows`——**必须保持"推给界面的 rows 是全量"**，否则界面整体替换会把别的卡片冲掉。`decideRenewal` 是纯函数（有回归测试），改判定先看它的注释 |
| `app/src/main/notify.ts` | 四类系统通知：低余额、余额骤降（`drop_alert_percent`）、连续失败（`fail_alert_count`）、每日预算 80%/100%（按单位各一次）；共用 `notice_state` 按自然日限频（`notice_max_per_day`） | 出口只有一个 `maybeNotify(rows, settings)`（查询完成后调用）。新增通知类型：走 `allow()` + `send()` + `store.bumpNotice()` 三件套，别绕开限频 |
| `app/src/main/renewal.ts` | 静默续期：配方表（商汤 `SENSENOVA_RENEWAL` 加载控制台读 `localStorage.access_token`；小米 `MIMO_RENEWAL` 加载控制台 + 打一次余额接口）在隐藏窗口里用**持久化登录分区**重放页面动作；`renewCredential()`、`supportsRenewal()`、`autoRenewable()`（商汤为 false：会话 3 小时绝对到期，续期无效，只保留到期提醒）、`jwtExpiry()` / `msUntilExpiry()` / `sessionExpiryMs()` | **分区名必须与登录窗口一致**（都来自 `shared/constants.ts` 的 `LOGIN_RULES[*].partitionHost` + `loginPartition()`）。无 tokenKey 的平台必须**用真实接口验会话**（`validateSession`），不允许"有 Cookie 就报成功" |
| `app/src/main/http.ts` | 极简 HTTP 客户端（原生 fetch）：`request()` 返回 `{status, text}`（**非 2xx 不抛**）、URL/Header **非 ASCII 预检**（`BAD_URL` / `BAD_HEADER`）、超时来自设置 `timeout_ms`（`setDefaultTimeoutMs` 由 store 同步） | 渲染进程永不直接发请求；新增适配器一律用 `request()` 而不是裸 `fetch`（拿不到预检与统一超时） |
| `app/src/main/fx.ts` | 实时汇率（`open.er-api.com`，1 USD = ? CNY）：1 小时缓存 + 并发去重 + 失败用上次缓存 + 再无则内置 7.2 兜底 | **只发货币代码，不带任何账号信息/密钥/Cookie**；任何情况都不向渲染进程抛错（汇率拿不到不阻断界面） |
| `app/src/main/runPool.ts` | 20 行并发池：最多 `limit` 个任务并行，任一失败不影响其它 | 纯函数、无 electron 依赖，被 `verify-adapters.mjs` 独立验证 |
| `app/src/main/usage.ts` | 用量统计引擎（1022 行，**最重的统计逻辑**）：`daySlices()` 日期切片、`isUsageBased()` 判断"用量型 vs 余额型"、`gapLimitMs()` 停机（跨期）阈值（硬下限 2 小时 / 刷新间隔×3）、`dailyConsumedDetailed()` 每日明细（跨期消耗单独标记，不污染日均与耗尽预估）、`buildDailyUsage()` 每日使用状况 + 耗尽预估、`buildPlatformUsage()` 平台×单位聚合 + 跨单位折算对比、`buildUsageReport()` 日报/周报/月报 | 数据源统一是 `readSnapshots()`（已套用校正）。改消耗口径务必同时看 `ipc.ts` 的 `CORRECTION_APPLY`（`dayBalance` 模式用**同款账目函数 + 同宽窗口**自校准，口径漂移会导致"改了某天但数值对不上"） |

**IPC 注册与平台接入**

| 路径 | 用途 | 备注 |
|---|---|---|
| `app/src/main/ipc.ts` | **全部业务 IPC 注册**（938 行，通道最全的一处）：`wrap()` 统一 try/catch + 发送方校验（只接受主窗调用）+ 错误信息里本地路径脱敏；账号 CRUD、余额刷新、设置读写（含刷新间隔热重启、开机自启）、登录三入口（`ACCOUNT_LOGIN` / `ACCOUNT_RELOGIN` / `ACCOUNT_RENEW`）、MiMo「另一个方式」检测与一键添加、数据校正四通道、每日/平台/报告统计、演示开关、备份导入导出、监控六通道、Key 管理、日志五通道、背景图五通道、窗口控制四通道、汇率、快照列表 | 新增通道 = `shared/ipc.ts` 加常量与 `PanelApi` 方法 → `preload/index.ts` 加薄封装 → 这里 `wrap()` 注册 → `renderer/src/api/ipc.ts` 加封装函数。**四处都要改，漏一处就是断链**（历史上 `account:relogin` 就这么失效过） |
| `app/src/main/adapters/types.ts` | 适配器统一接口：`AdapterContext`（`getSecret` / 可选 `getSession` / 可选 `saveRenewed`）与 `Adapter` 函数签名 | 新适配器必须实现这个签名才可注册 |
| `app/src/main/adapters/index.ts` | 适配器注册表 `PROVIDERS`（10 个平台）+ `getAdapter(type)`（未知类型抛 `UNKNOWN_TYPE`） | **新增平台 = 加一个文件 + 这里注册一行**；同时要改 `shared/types.ts` 的 `AccountType`、`constants.ts` 的 `PROVIDER_META` / `ACCOUNT_TYPES`（界面表单项自动渲染） |
| `app/src/main/adapters/util.ts` | 适配器公共工具：`dig()` 点号路径取值、`num()` 转数字（带 scale）、`safeJson()`（失败抛 `BAD_JSON`）、`assertNotExpired()`（401/403 → `COOKIE_EXPIRED`）、`round6()`、`okResult()`（used 缺失时用 total−remaining 推导） | 六个登录型适配器共用 `assertNotExpired`，别逐文件复制判定 |
| `app/src/main/adapters/deepseek.ts` | DeepSeek 官方：`GET /user/balance` → `balance_infos[0]` 的 `total_balance` / `granted_balance` / `topped_up_balance`，拆成"赠送/充值"两个 items；总额靠用户手填 `quota_total` | 最简单的一个，可作为新适配器的模板 |
| `app/src/main/adapters/siliconflow.ts` | 硅基流动**登录 Cookie 版**（API Key 版 `/v1/user/info` 已于 2026-08-14 官方下线）：① 抓 `/me/expensebill` HTML 里的 `window.SF_SUBJECT_ID` ② `profile/peek` 取 `financialInfo`（金额整数，1 元 = 1e12） ③ `wallets?stage=3` 代金券 / `stage=2` 资源包 | 三条链路的字段路径是实测结论，平台改版会整段失效；`YUAN_SCALE` 是单位口径，改动前先核实现网返回 |
| `app/src/main/adapters/newapi.ts` | New API / One API / Veloera 中转站：`GET {base_url}/api/user/self`，`quota`/`used_quota` 按 `quota_per_usd`（默认 500000）折美元，`user_id` 非空时补 `New-API-User` 头 | 已从"新增账号"下拉移除（历史账号仍可读写）；`base_url` 只填域名，不要带 `/v1` |
| `app/src/main/adapters/custom.ts` | 万能适配器：按账号里的 `request`（url/method/headers/body）+ `extract`（点号路径 + scale + items 子表）取值；三个关键字段全取不到 → `BAD_PATH` | 同样已从"新增账号"下拉移除，但适配器保留（老账号继续可用）。**这是"不改代码接新平台"的兜底手段** |
| `app/src/main/adapters/mimo.ts` | 小米 MiMo 余额（Cookie）：`GET /api/v1/balance` → `data.balance` / `cashBalance` / `giftBalance` / `currency`，拆现金/赠送两个 items | 套餐用量已拆到 `mimo-plan`；两者**共用同一份 Cookie**（见 `ipc.ts` 的 sibling 检测） |
| `app/src/main/adapters/mimo-plan.ts` | 小米 MiMo TokenPlan（Cookie）：① `tokenPlan/detail`（planCode / planName / currentPeriodEnd / 过期 / 自动续费） ② `tokenPlan/usage` 的 `data.usage.items[]`（`plan_total_token` 优先） ③ `POST usage/token-plan/list?api-platform_ph=<Cookie 里的值>` 按模型拆 Token（缺这个参数一律 401） | **两套口径不能相加**：套餐额度 = Credits（`percent` 官方口径，按 `MIMO_PLAN_PRICES` 百分比折元）；使用详情 = Tokens。额度单位 `M Credits = 原值 / 1e6` |
| `app/src/main/adapters/minimax.ts` | MiniMax 余额（Cookie + `X-Group-Id`）：① `/backend/account` 取 `group_id`（`.com` 国际站优先，未登录回退 `.cn` 国内站） ② `/account/query_balance` → 可用额度 = 现金 + 代金券 + 授信 − 欠费 | **少了 `X-Group-Id` 头接口直接报 system error**；两站接口同构，改一处要核两站 |
| `app/src/main/adapters/zhipu.ts` | 智谱 bigmodel（Cookie + Authorization）：从 Cookie 提 `bigmodel_token_production` 的 JWT 值**原样**放 Authorization（无 `Bearer` 前缀），`GET /api/biz/customer/accountSet` → `data.basicCustomerInfo.balance`（¥）+ 可用授信 | `code === 401 / 1001` 视为登录失效；`Referer` 是必须的 |
| `app/src/main/adapters/aliyun.ts` | 阿里云百炼：BSS OpenAPI `business.aliyuncs.com`（V2017-12-14）**HMAC-SHA1 RPC 签名**（`signRpc()` / `buildBssUrl()`，RFC3986 编码含 `!'()*` 转义），依次查 `QueryAccountBalance`（资金账户）/ `QueryCashCoupons`（代金券，`status=Available`）/ `QuerySavingsPlansInstance`（节省计划剩余池值） | 密钥格式 `AccessKey ID|AccessKey Secret`；控制台的 `data/api.json` 走 AWSC 反自动化签名（collina），Node 复刻不了，**不要试图改成抓控制台接口**；端点用 `business.aliyuncs.com`（`bssapi` 在部分网络解析不了）；业务错误常带非 200 状态，**必须先看响应体 Code** |
| `app/src/main/adapters/sensenova.ts` | 商汤日日新 Token Plan：`GET /lite/console/v1/tokenplan/pool-usage`（Bearer 登录态 token）→ `plan` + `pools[]`（`window_5h` 5 小时窗口 / `window_7d` 周额度），卡片主值取 5 小时剩余，周额度作 total/进度条；Flash-Lite 独立积分池单列一行 | **额度接口只认登录态 token（Bearer），Cookie 无效**；登录态约 3 小时绝对到期、无法续期 → 到期前 15 分钟由保活提醒用户重新登录（见 `query.ts` 的 `notifyExpiry`） |
| `app/src/main/browser/index.ts` | 内置浏览器登录（不装 Playwright）：`loginToSite()`（开登录窗 → 轮询判定登录成功 → 抓 Cookie / localStorage token → 可选 `validate` / `validateToken` → **保存后 `verify` 真查一次**才算成功 → 采集续期材料）；校验器 `validateByUrl()` / `cookieHas()` / `validateSenseNovaToken()` / `validateMinimaxCookie()` | 窗口关闭 ≠ 登录成功：必须复验通过。分区由 `loginPartition(rule.partitionHost)` 决定，**与 `renewal.ts` 必须同一分区** |
| `app/src/main/browser/README.md` | 说明该目录的登录抓取策略与各平台校验口径 | 改登录流程时同步更新 |

### 3.5 app/src/preload 预加载

| 路径 | 用途 | 备注 |
|---|---|---|
| `app/src/preload/index.ts` | `contextBridge.exposeInMainWorld('api', api)`：把 `PanelApi` 的每个方法薄封装成 `ipcRenderer.invoke(IPC.X)`；订阅类方法（`onBalanceRow` / `onBalanceUpdated` / `onWindowState`）返回**取消订阅函数**。若 `contextIsolation` 未启用则**直接抛错拒绝加载**（不静默降级） | 只暴露方法，不暴露 `ipcRenderer` 本体、不暴露任何 Node 模块、不跨进程传回调。新增通道在此加一层封装 |
| `app/src/preload/index.d.ts` | 声明 `Window.api: PanelApi`，让渲染进程有类型 | `tsconfig.web.json` 已 include，所以 `window.api` 在渲染层不报错 |

### 3.6 app/src/renderer 渲染进程

**入口与全局**

| 路径 | 用途 | 备注 |
|---|---|---|
| `app/src/renderer/index.html` | HTML 宿主：`#app` 挂载点 + 内联深色底（防 Electron 白屏闪） | 打包后 CSS 由 `inlineCssPlugin()` 内联进本文件 |
| `app/src/renderer/src/main.ts` | `createApp(App).mount('#app')`；mount 前按 `localStorage['panel-theme']` 设置 `document.documentElement.dataset.theme`（**主题防闪**） | 主题标识的语义见 `utils/theme.ts` |
| `app/src/renderer/src/App.vue` | **根组件 + 页面路由中枢**（725 行）：`view` 决定渲染哪个页（dashboard / usage / platform / keys / report / correction / logs / theme / settings / help）；持有 `usePanel()` 全部状态；「点击登录」统一入口（先静默续期、失败再开登录窗）；消耗预估与预算条数据加载；演示模式开关；新手引导；数据校正页预选账号；顶部横幅提示；`ConfirmHost` 全局唯一挂载 | 新增页面：① `Sidebar.vue` 加 `SidebarView` 与导航项 ② 这里 import 并加 `v-else-if` 分支 |
| `app/src/renderer/src/env.d.ts` | 引用 `vite/client` 类型 | 空壳，别删 |

**组件（components/）**

| 路径 | 用途 | 备注 |
|---|---|---|
| `components/TitleBar.vue` | 自绘标题栏：最小化 / 最大化还原 / 关闭（隐藏到托盘）、刷新按钮、添加账号、更新于时间、刷新间隔、失败红点、版本号 | 窗口状态走 `getWindowState` + `subscribeWindowState`（`window:state` 推送） |
| `components/Sidebar.vue` | 左侧导航：10 个视图（概览 / 每日使用状况 / 平台用量 / Key 管理 / 使用报告 / 数据校正 / 运行日志 / 主题外观 / 设置 / 使用说明），导出 `SidebarView` 类型；显示失败红点与版本号 | **`SidebarView` 是页面路由的类型真源**，加页面先改这里 |
| `components/SummaryBar.vue` | 概览顶部汇总条：账号总数、失败数、最低余额、总剩余等 | 只读展示，数据由 App.vue 传入 |
| `components/AccountCard.vue` | **最重要的展示组件**（1415 行）：单账号卡片（余额、单位、进度条、阈值变色、备注、发光/玻璃效果）；登录入口大号「点击登录」框（仅"需要登录"时出现）；模型明细；趋势悬浮窗（420px，1/6/24 小时轴自动选择，点外部/Esc 关闭）；**MiMo TokenPlan 横板宽卡**（跨两列：左 = 额度 + 按百分比折元，右 = 本周期 Token 总量 / 请求数 / 各模型占比） | emit：`refresh` / `edit` / `remove` / `relogin` / `correct`。判断逻辑"是否该提示登录"只认凭据类错误（`COOKIE_EXPIRED` / 返回非数据），网络类失败不弹登录框。进度条口径全站统一"越长 = 剩得越多" |
| `components/AccountDialog.vue` | 新增/编辑账号弹窗：按 `PROVIDER_META` 动态渲染字段（Key / base_url / user_id / 自定义 request+extract）、平台下拉、各平台「登录获取 Cookie / 只重新登录」、登录后自动保存、MiMo「一键添加另一种方式」→ `save-both` | 编辑历史 `newapi` / `custom` 账号时要把该类型补进下拉，否则 select 显示空值 |
| `components/SettingsDialog.vue` | 设置弹窗：刷新间隔（`REFRESH_OPTIONS`）、隐藏时暂停、并发、超时、缓存、快照保留天数、低余额默认阈值（普通/中转站）、每日预算（按单位）、骤降与连续失败告警、通知开关与每日上限、积分折算率、开机自启（显示系统真实状态）、备份导入导出、打开数据目录 | 保存走 `save-settings`（`emit('save', patch)` 返回 Promise），父组件负责回灌与提示 |
| `components/ThemeView.vue` | 主题外观页：14 套主题（经典深/浅 + 跟随系统 + 6 方向 × 深/浅）、内置与自定义背景选择、适配方式、暗化、模糊、卡片半透明、玻璃效果参数 | 主题变更要同时处理背景图（`backgroundForTheme`）、`styles/variables.css` 与 `localStorage['panel-theme']`；`主题/` 已于 2026-10-03 删除，**不要再引用** |
| `components/UsageStats.vue` | 每日使用状况页：日期切片表格（含停机标记与悬浮说明）、日历热力图（`UsageCalendar`）、导出 CSV、「今日消耗最多」（先折算成金额再比）、余额耗尽预估、进入数据校正入口 | 「今日消耗最多」主进程已按同一权重排序，这里再算一遍权重兜底 |
| `components/UsageCalendar.vue` | 日历热力图：按日消耗着色、点击某天 → `select-day` | 被 `UsageStats` 嵌入 |
| `components/PlatformUsage.vue` | 平台用量页：按平台 × 单位聚合的消耗与对比图；**跨单位统一折算成金额比较**（积分按折算率、美元按实时汇率），展示仍用原值；积分合计卡只在存在积分型单位时显示 | 折算入口唯一：`@shared/cost.ts` 的 `creditCny()`，非积分单位返回 null → 界面留空 |
| `components/UsageReportView.vue` | AI 使用报告页：日报 / 周报 / 月报 + 一键生成 900×1200 分享卡片 PNG | 数据来自 `getUsageReport(period)`（`report:usage`），只基于金额 |
| `components/KeysView.vue` | Key 管理页：汇总列表（账号 + Key 库）、标签筛选、回收站、批量操作（启停/删除/恢复/彻底删除/打标签）、明文复制、导出 Markdown/JSON/cURL；内嵌 `MonitorPanel`（tab = monitor） | 审计项来自 `buildKeyList()`；取明文会写 `[audit]` 日志 |
| `components/MonitorPanel.vue` | 接口监控面板：目标列表 + 统计（成功率 / 均值 / P95 / 连续失败 / 每日可用率）、新增编辑弹窗（URL / 方法 / 请求体 / 头 / `{{key}}` / 间隔 / 超时）、立即检查、试跑、检查历史 | 被 `KeysView` 以 tab 形式嵌入；试跑不落库 |
| `components/LogView.vue` | 运行日志页：级别筛选、关键字、自动刷新、文件列表与大小、清空、导出、打开日志目录、切换日志级别（debug 可看请求级细节） | 数据来自 `readLogs`（内存缓冲 + 启动时载入的尾部） |
| `components/CorrectionView.vue` | 数据校正页：账本列表、影响条数、校正前后对照点；三种安全操作（① 改某天用量 ② 回退到某次快照 ③ 手动平移/设为指定值）+「只改这一天」「忽略某天」 | 只提供"从某一时刻起整体平移/覆盖"的原因写在文件头注释：相邻快照差值决定每日消耗，只改单点会让那天消耗变成黑洞 |
| `components/HelpPane.vue` | 内置「使用说明」整页（内联 HTML 字符串，含各平台分步图文说明、常见问题、隐私说明） | **与 `docs/使用说明.md` 手工同步维护**，改一处要一起改 |
| `components/OnboardingGuide.vue` | 首次启动的新手引导分步弹层（`onboarded` 设置控制） | emit：`close` / `add-account` / `demo` |
| `components/BudgetBar.vue` | 每日预算条：每个单位的今日消耗 / 预算 / 剩余 / 按当前速度还能撑几天 / 超支告警 | 数据由 App.vue 从每日统计里算好传入 |
| `components/EmptyState.vue` | 空状态占位（还没有账号时），带「添加账号」入口 | — |
| `components/BaseModal.vue` | 通用模态框基座：`<Teleport to="body">` + 遮罩 + Esc/点遮罩关闭 + 标题栏 + footer 插槽 | **模态框样式必须写在全局 CSS**（`global.css`「模态框」一节），因为 Teleport 出去的节点不受 `scoped` 约束 |
| `components/ConfirmDialog.vue` | 统一确认/输入对话框（基于 `BaseModal`）：标题 + 正文（`\n` 渲染换行）+ 确认/取消；`danger` 红按钮；`withInput` 输入模式 | 由 `useConfirm` 的 `ConfirmHost` 驱动 |
| `components/InfoTip.vue` | 小问号气泡提示 | 悬停/点击展开 |
| `components/SelectMenu.vue` | 自定义下拉选择（`v-model`，点外部关闭） | 替代原生 `<select>` 以获得统一外观 |
| `components/TrendChart.vue` | 趋势折线图（**纯 SVG 手绘，不引图表库**）：面积渐变 + 虚线网格 + 关键点；`spanMs` 固定 1/6/24 小时窗，显示 4~6 个均匀刻度 | **不再支持自适应 x 轴**；唯一调用方是 `AccountCard` 的趋势悬浮窗，改签名要一起改 |

**组合式函数（composables/）**

| 路径 | 用途 | 备注 |
|---|---|---|
| `composables/usePanel.ts` | 面板核心状态机：`accounts` / `rows` / `settings` / `appInfo` / `loading` / `refreshingIds` / `lastUpdated` / `configBanner` + `loadAll` / `refreshAll` / `refreshOne` / `saveAccount` / `removeAccount` / `saveSettings`；订阅 `balance:row`（单条 upsert）与 `balance:updated`（整体替换 + 清 refreshing） | 全应用**唯一**的状态容器（刻意不引 Pinia）。收到 `balance:updated` 会**整体替换** rows，因此主进程必须推全量（见 `query.ts`） |
| `composables/useConfirm.ts` | 统一对话框（替代 `window.confirm/prompt`）：`confirm()` / `prompt()` + `ConfirmHost` 宿主组件；模块级单例，同一时刻只弹一个（新请求把上一个按取消结掉，防 Promise 泄漏） | `ConfirmHost` 只在 `App.vue` 挂一次，别处只调 `confirm/prompt` |
| `composables/useFlash.ts` | "消息 + N 秒自动消失"统一提示（`msg` / `err` / `flash` / `fail` / `clear`） | 收敛了 KeysView / LogView / ThemeView / CorrectionView 四份重复实现 |
| `composables/useClipboard.ts` | 剪贴板复制统一入口（`navigator.clipboard.writeText` + try/catch + 成功/失败提示） | 收敛 KeysView 里三处手写复制 |

**工具（utils/）与样式（styles/）**

| 路径 | 用途 | 备注 |
|---|---|---|
| `api/ipc.ts` | 渲染层 RPC 门面（382 行，**注意在 `api/` 而不是 `utils/`**）：把 `window.api` 的每个方法包成 `{ ok, data, error }`（`rpc()`），订阅类统一走 `subscribe()`（无桥时返回空函数）；`window.api` 缺失时给中文提示 | **直调 `window.api` 方法，不再走"通道名 switch 镜像分发"**——历史上 switch 漏 case 导致 `account:relogin` 整条功能失效。新增通道在这里加一个直调封装 |
| `utils/theme.ts` | 主题解析：`resolveTheme(pref, prefersDark)` 把 `'system'` 解析成经典 `dark`/`light`，其余原样返回 | 与「设置 → 显示 → 主题」和主题页联动口径 |
| `utils/csv.ts` | CSV 导出：单元格转义、带 UTF-8 BOM 下载（Excel 不乱码）、日期戳文件名 | 被 UsageStats / PlatformUsage 复用 |
| `utils/download.ts` | 触发浏览器下载（Blob + `URL.createObjectURL`），用于 CSV 与分享卡片 PNG | 渲染层不碰文件系统，下载走浏览器能力 |
| `utils/text.ts` | 文本/展示工具：`formatBytes()`、`providerLabel()`（平台类型 → 展示名）、`dateStamp()` | 收敛各组件重复的本地实现 |
| `styles/variables.css` | **设计系统 token**（588 行）：`:root`/`[data-theme='light']` 为浅色基准，`[data-theme='dark']` 覆盖，另有 12 套设计师主题块；尺寸/圆角/动效 token 两边共用，只有颜色随主题切换 | 组件里**不得硬编码颜色**，一律用变量；新增主题 = 加一个 `[data-theme='xxx']` 块（见 `docs/主题设计指南.md`） |
| `styles/global.css` | 全局样式：基础重置、滚动条、按钮/输入/表格/进度条等公共类，以及**模态框样式**（Teleport 出去，必须全局） | 改模态框外观改这里，不是组件内 `<style scoped>` |

### 3.7 app/src/shared 共享层

| 路径 | 用途 | 备注 |
|---|---|---|
| `shared/types.ts` | **全端类型真源**（776 行）：`Account` / `AccountView`（类型层面删掉 `secret_enc`）/ `AccountInput`、`AccountType`、`ErrorCode`、`BalanceResult` / `BalanceRow` / `PanelPayload`、`Snapshot`、`Settings`、`CredentialSession`、`PlanUsageInfo` / `PlanModelUsage`、`Correction*`、`DailyUsageReport` / `PlatformUsageReport` / `UsageReport`、`Monitor*`、`Key*`、`AppInfo`、`FxInfo`、`ProviderMeta` | 命名约定：**落盘结构一律 snake_case**（与 PRD 一致），**运行时传输结构用 camelCase**。本文件不得 import `node:` / `electron` |
| `shared/constants.ts` | 常量真源：默认设置 `DEFAULT_SETTINGS`、`REFRESH_OPTIONS`、平台元数据 `PROVIDER_META`、`ACCOUNT_TYPES` 与界面可选的 `ACCOUNT_TYPE_OPTIONS`、各平台接口与登录 URL、`MIMO_PLAN_PRICES` 价目表、`LOGIN_RULES`（**登录分区唯一口径**）+ `loginPartition()`、`credentialKind()`、`KEY_PRESETS` | **新增平台要动的第一处**；`ACCOUNT_TYPES` 用于 store 校验（含历史类型），`ACCOUNT_TYPE_OPTIONS` 才是界面下拉。`LOGIN_RULES[*].partitionHost` 改错会直接导致"登录成功但一直等待登录" |
| `shared/ipc.ts` | IPC 契约：`IPC` 通道名常量（命名规则 `域:动作`）、`PanelApi` 接口（preload 白名单与类型）、`AutoStartStatus`、`RefreshPayload` | 改通道名两边一起变，不会漏改；**新增通道从这里开始** |
| `shared/format.ts` | 两端共用的纯格式化：`fmtNumber` / `fmtMoney` / `fmtAgo` / `fmtClock` / `maskSecret` / `isPlainObject` / `numOrNull` / `normalizeTags` / `pctLevel` | 不得 import `node:` / `electron` |
| `shared/cost.ts` | 单位 → 金额折算（**只对"积分"类单位**）：`isCreditUnit` / `hasCreditRate` / `creditsToCny` / `creditCny` / `rateText` / `compareWeight` | 元/美元平台**不折算**（用户 2026-09-22 明确要求）；折算结果是估算，界面必须带「≈ / 估算」字样 |

### 3.8 docs/ 文档

| 路径 | 用途 | 备注 |
|---|---|---|
| `docs/使用说明.md` | **面向最终用户**的分步说明：安装运行、各平台账号添加（含阿里云 RAM 授权）、日常使用、常见问题、隐私说明、界面与新功能、监控与玩法 | **必须与 `components/HelpPane.vue` 内联说明同步**；功能变化时两处一起改 |
| `docs/架构设计.md` | 系统架构设计 + 任务分解（65KB，历史文档）：框架选型与理由、版本锁、完整文件列表、数据结构与接口、IPC 通道设计、关键流程时序图、safeStorage 加密方案、错误映射、依赖清单、任务列表（T01~T05）、跨文件共享约定（命名/单位/时间/格式化/日志/路径） | 一期设计定稿，**部分表述已与代码不一致，以代码为准**；新增大型模块时可回来补章节 |
| `docs/架构设计-类图.mermaid` | 架构类图（Mermaid 源） | 与架构设计文档配套 |
| `docs/架构设计-时序图.mermaid` | 启动 / 刷新 / 保存账号等关键时序（Mermaid 源） | 同上 |
| `docs/PRD.md` | 产品需求文档：术语、产品定义、需求池（P0/P1/P2）、UI 线框、数据模型、待确认问题、非功能要求、一期不做的事 | **落盘字段命名以它的第 5 节为准**；历史文档 |
| `docs/项目完整计划书.md` | 完整计划书与技术细节：路线图、技术栈与版本锁定、总体架构、完整目录结构、数据模型、适配器详解、数据层、IPC 清单、查询引擎、安全设计、二期能力、错误码总表、测试验收、风险 | 综合索引类文档，查"某个能力在哪实现"很快；历史文档 |
| `docs/主题设计指南.md` | 交给设计类 AI 的主题设计说明：机制（只输出 CSS 变量）、必须输出的变量清单、设计约束、提示词模板、可选方向、交付与接入、当前默认主题 | **新增主题的入口文档**；与 `styles/variables.css` 配套（原 `主题/overview.md` 已随 `主题/` 删除） |
| `docs/剩余开发规划.md` | 剩余开发规划：已拍板的 5 件事、一期收尾、二期实施顺序、二期第一刀方案、下一步动作 | 规划类，做完一项应回来更新/划掉 |
| `docs/代码审查报告-死代码与冗余.md` | 渲染层/通用死代码与冗余审查报告（含整改执行记录、真实 Bug、清理动作清单） | 历史审查记录；**结论有些已过期**，引用前先 grep 核实 |
| `docs/代码审查报告-主进程与脚本-死代码与优化.md` | 主进程 / shared / scripts 的死代码、冗余、重复实现、功能优化建议与 Top 10 行动清单 | 同上，属历史记录 |

### 3.9 memory/、归档/

> **`主题/` 已于 2026-10-03 整体删除**（原文件：`api-balance-themes.css`、`theme-preview.html`、`overview.md`、`归档/trae.css`，均为未纳入 Git 的本地交付物）。主题真源现在只剩 `app/src/renderer/src/styles/variables.css`（见 §3.6）与内置背景图 `app/resources/backgrounds/`（见 §3.3）；**不要再往 `主题/` 写任何东西**。

| 路径 | 用途 | 备注 |
|---|---|---|
| `memory/2026-09-08.md` | 开发日志：一期进度盘点、`query.ts` 缺 import 的修复、全部测试通过记录、启动冒烟结论（正确启动方式） | 过程记录，**`.gitignore` 已忽略、不推送公开仓库**；排障时可回溯当时的验证方法 |
| `memory/2026-09-09.md` | 开发日志（49KB，信息量最大）：**打包后 CSS 全失效的根因与修复**（asar 内验证方法可复用）、UI 视觉重做、各平台抓包实测结论 | 排查"打包后样式/交互异常"先读这一篇；抓包结论是适配器字段路径的来源 |
| `归档/diag-renderer.js` | 一次性诊断脚本：以 `file://` 加载 `out/renderer/index.html`，打印渲染进程 console，用来确认打包产物里 JS/CSS 是否生效 | 按项目规则从源码目录移入归档；需要时手动 `electron 归档/diag-renderer.js` 运行（注意里面用的相对路径按原位置写，移动后需自行调整） |

---

## 四、关键流程与数据流

### 4.1 启动链路

```
app/package.json (main: out/main/index.js)
  └─ src/main/index.ts
       ├─ requestSingleInstanceLock()      单实例；重复启动 → showMainWindow()
       ├─ app.whenReady()
       │    ├─ ensureDirs()                建 userData 与 logs 目录
       │    ├─ store.load()                config.json（含损坏回滚）；状态进 getConfigStatus()
       │    ├─ createWindow()              BrowserWindow（contextIsolation:true）
       │    │     └─ preload/index.ts → contextBridge.exposeInMainWorld('api', PanelApi)
       │    │           └─ src/renderer/index.html → src/main.ts → App.vue → usePanel().loadAll()
       │    │                 └─ utils/ipc.ts 的 rpc() → window.api.* → ipcRenderer.invoke(IPC.*)
       │    ├─ createTray()                托盘
       │    ├─ setInterval(runDueMonitors, 60s)   接口监控到点检查
       │    ├─ refreshAutoStart()          校准开机自启
       │    ├─ registerIpc()               ipcMain.handle 注册全部通道
       │    ├─ scheduler.start(refresh_seconds)
       │    ├─ win.on('hide'/'show'/'minimize'/'restore')  暂停/恢复刷新
       │    └─ keepAliveSessions() + startKeepAlive()      会话保活（每 5 分钟）
       ├─ 'second-instance' → showMainWindow()
       ├─ 'before-quit'    → setQuitting(true) + scheduler.stop() + stopKeepAlive() + destroyTray()
       └─ 'will-quit'      → 先 flush() 写完内存里的快照，再 app.quit()
```

### 4.2 IPC 约定

- **通道名规则**：`域:动作`，全部定义在 `src/shared/ipc.ts` 的 `IPC` 常量里，主进程与渲染进程共用。
- **方向**：`invoke/handle`（请求-响应）为主；主进程 → 渲染进程的推送只有三条：`balance:row`（单条完成即推）、`balance:updated`（整批完成）、`window:state`（最大化状态）。
- **新增一个通道的标准流程（四处都要改，缺一即断链）**：
  1. `src/shared/ipc.ts`：加 `IPC.XXX` 常量 + `PanelApi` 方法签名；
  2. `src/preload/index.ts`：加一层 `ipcRenderer.invoke(IPC.XXX)` 薄封装（订阅类记得返回取消函数）；
  3. `src/main/ipc.ts`：在 `registerIpc()` 里用 `wrap(IPC.XXX, handler)` 注册（自动获得发送方校验 + 异常兜底 + 路径脱敏）；
  4. `src/renderer/src/api/ipc.ts`：加 `rpc((a) => a.xxx())` 直调封装。
- **安全约定**：`wrap()` 只接受主窗口发来的调用；错误信息里的 `DATA_DIR` / `LOG_DIR` 会被替换成占位符后再回抛；明文密钥只在主进程内存里，绝不跨 IPC（`AccountView` 类型层面已删 `secret_enc`）。

### 4.3 数据与配置存放位置

打包后数据根目录：`%APPDATA%\API 余额面板\`（开发模式为 `%APPDATA%\api-balance-panel\`；`app` 未就绪时兜底 `~/.api-balance-panel`）。**换电脑/备份 = 拷贝整个文件夹**。

| 文件 | 内容 | 写入方 | 说明 |
|---|---|---|---|
| `config.json` | `version` / `crypto`（方案+版本）/ `settings` / `accounts`（含 `secret_enc` `secret_masked` `session_enc` `token_expires_at` `tags` `deleted_at`）/ `notice_state` | `store.ts` | 原子写；`.bak` 单份备份；损坏 → `config.corrupt-<ts>.json` 归档 |
| `config.json.bak` / `config.json.tmp` | 上一版备份 / 原子写临时文件 | `store.ts` | 不要提交、不要手改 |
| `config.json.pre-import.bak` | 导入备份前的现场 | `backup.ts` | 导入出问题时可回滚 |
| `snapshots.json` | `items[]`：每条快照（account_id / ts / ok / remaining / total / used / unit / note / items[] / latency_ms） | `snapshot.ts` | 30 天 + 单账号 2000 条自动裁剪；节流 1s 落盘；退出前 `flush()` |
| `corrections.json` | `items[]`：校正账本（accountId / fromTs / toTs / kind: offset\|set\|ignore / value / unit / note / createdAt） | `corrections.ts` | **不改原始快照**；改账本即改所有统计 |
| `keys.json` | Key 库记录（含 `secret_enc` / `secret_scheme` / `tags`） | `keyvault.ts` | 单向：不会变成账号 |
| `monitors.json` | 监控目标（url / method / body / headers / `secret_enc` / `interval_minutes` / `timeout_ms` / `enabled`） | `monitor.ts` | 坏文件先归档再重建 |
| `monitor-history.json` | `entries[]`：每次检查（monitorId / ts / ok / status / latency_ms / error） | `monitor.ts` | 单目标 1000 条、总 6000 条上限 |
| `logs/main.log` 及轮转 `main-<ts>.log` | 运行日志（已脱敏） | `logger.ts` | 2MB 轮转、保留 8 个；`export-<ts>.log` 是导出产物 |
| `backgrounds/` | 用户导入的背景图 | `bgstore.ts` | 内置图在安装包的 `resources/backgrounds/`，**不要覆盖用户目录** |

> `config.json` / `snapshots.json` / `corrections.json` / `keys.json` / `monitors*.json` / `backgrounds/` 都是**真实用户数据 + 加密凭据**：永不提交 Git，打包与测试过程不得删除或覆盖。

### 4.4 典型改动怎么做

| 想改什么 | 要动哪些文件 |
|---|---|
| 新增一个平台 | `src/main/adapters/<新平台>.ts`（实现 `Adapter`）→ `adapters/index.ts` 注册一行 → `shared/types.ts` 的 `AccountType` → `shared/constants.ts` 的 `PROVIDER_META` / `ACCOUNT_TYPES`（是否进 `ACCOUNT_TYPE_OPTIONS` 看是否需要登录）→ 若为登录型：`LOGIN_RULES` + `renewal.ts` 的配方 + `ipc.ts` 的 `LOGIN_URLS` 与 `buildValidate` → `app/README.md` 第 4 节流程 |
| 某个平台接口字段变了 | 只改对应 `adapters/<平台>.ts` 的取值路径与断言；跑 `node scripts/verify-adapters.mjs` |
| 改错误文案 | `src/main/errors.ts` 的 `ERROR_TEXT`（唯一真源），别改适配器 |
| 新增设置项 | `shared/types.ts` 的 `Settings` + `shared/constants.ts` 的 `DEFAULT_SETTINGS` + `src/main/store.ts` 的 `normalizeSettings` + `SettingsDialog.vue` 表单项（四处） |
| 新增 IPC 通道 | 见 4.2 的四处流程 |
| 新增页面/视图 | `Sidebar.vue`（`SidebarView` + 导航项）→ `App.vue`（import + `v-else-if` 分支）→ 新组件放 `components/` |
| 新增主题 | `styles/variables.css` 加 `[data-theme='xxx']` 块 → `app/resources/backgrounds/`（内置图放 `<slug>.png`）→ `ThemeView.vue` 主题列表 → `docs/主题设计指南.md` 同步 |
| 改刷新 / 缓存 / 并发 / 超时 | `scheduler.ts`（间隔由 `ipc.ts` 的 `SETTINGS_SAVE` 热重启）、`query.ts`（缓存）、`http.ts`（超时由 store 同步 `setDefaultTimeoutMs`） |
| 改每日消耗口径 | `usage.ts`（主逻辑）+ 同时核对 `ipc.ts` 的 `CORRECTION_APPLY`（`dayBalance` 用同款账目函数与同宽窗口自校准），否则"改了某天但数字对不上" |
| 改登录/续期 | `browser/index.ts`（登录抓取）与 `renewal.ts`（续期配方）**必须共用同一 `LOGIN_RULES[*].partitionHost`** |
| 改 UI 配色 | `styles/variables.css` 是唯一真源（应用实际读取）；`主题/` 已于 2026-10-03 删除，配色不再有第二份交付物 |
| 用户可见功能变化 | 同步 `README.md`、`docs/使用说明.md`、`components/HelpPane.vue`、`CHANGELOG.md`、本手册 |

---

## 五、改这个软件的安全守则

### 五条铁律（来自工作区 AGENTS.md）

1. **升版本号**：任何代码/资源修改前，先提升 `app/package.json` 的 `version`（功能 → 次版本；修复 → 修订号；破坏性 → 主版本）。同步检查 `README.md` / `CHANGELOG.md` / `docs/` 里的版本引用。
   - **例外**：只改说明性文档（`README.md` / `docs/` / `MAINTENANCE.md` / `CHANGELOG.md`），不改代码、资源与打包配置时，**不升版本、不打包**，但仍要提交推送（`docs: ...`）。
2. **打包前先类型检查**：`cd app && npm run typecheck`，不通过不得打包、不得提交、不得推送。
3. **必须打包成功**：`npm run dist:win`（或 `npm run dist`），`app/dist/` 下要产出含新版本号的 `API 余额面板 Setup <版本>.exe`。
4. **提交并推送**：`git add -A` → `git commit -m "<type>: <摘要>（v<版本>）"` → `git push origin main`。
5. **Release 默认禁止**：只有用户**明确文字同意**后才能打 tag + `gh release create` 上传安装包。普通小修改不触发征询，直接跳过。

### 常用命令

```bash
cd app
npm run typecheck        # vue-tsc + tsc，打包前的硬门槛
npm run build            # 三段构建，产物 out/
npm run dev              # 开发模式（热重载）
npm run dist:win         # Windows x64 NSIS 安装包 + 绿色版
npm run verify           # 数据层回归（需先按 scripts/tsconfig.verify.json 编译）
node scripts/verify-adapters.mjs   # 适配器回归（无需真实密钥）
```

### 验证打包产物（易踩坑时用）

不要只验 `out/`，要验**安装包内部**：

```bash
npx asar extract app/dist/win-unpacked/resources/app.asar asar-chk
# 检查 asar-chk/out/renderer/index.html：含内联 <style>、无 crossorigin、assets 下无 .css
```

样式/弹窗异常的现场排查可参考 `归档/diag-renderer.js` 与 `memory/2026-09-09.md`。

### 敏感数据与用户数据

- **永不提交**：`config.json`、`config.json.bak/.tmp`、`config.json.pre-import.bak`、`snapshots.json`、`corrections.json`、`keys.json`、`monitors.json`、`monitor-history.json`、`*.corrupt-*.json`、`backgrounds/`、真实凭据。
- 代码、README、示例、脚本、日志里的密钥一律用占位符（如 `your-api-key`）；文档中已出现过的 `LTAIabc123|你的秘密` 也是占位示例。
- 打包、测试、运行**不得删除或覆盖**用户真实数据文件。
- 日志虽有脱敏（`logger.ts` 的 `sanitize`），仍不要把真实凭据写进日志文案。

### 工完场清

修改完成后清理本次产生的一次性产物：`app/scripts/.tmp/`、`app/scripts/.verify/`、`*.log`、`*.bak`、`.e2e-*/`。一次性调试脚本删除或移入 `归档/`；`scripts/verify.js`、`scripts/verify-adapters.mjs` 属正式回归脚本，**保留**。

### 高风险的改动（改前务必读对应文件头注释）

| 位置 | 为什么危险 |
|---|---|
| `electron.vite.config.ts` 的 `inlineCssPlugin()` | 删了 → 打包后样式全丢、弹窗点不动 |
| `shared/constants.ts` 的 `LOGIN_RULES[*].partitionHost` | 改错 → 登录成功但界面一直"等待登录"、续期永远失败 |
| `query.ts` 的 `refresh()` 全量 rows 逻辑 | 破坏 → 单账号刷新会冲掉其它卡片 |
| `corrections.ts` 的"整体平移"语义 | 改成只改单点 → 每日消耗算错 |
| `snapshot.ts` 的 `readSnapshots()` 出口 | 统计绕过它 → 用户校正失效 |
| `store.ts` 的 `normalizeSettings` / `normalizeAccount` | 漏字段 → 设置或账号重启后丢失/被丢弃 |
| `package.json` 的 `productName` | 改了 → 老用户数据目录"找不到" |
| `crypto.ts` 的降级方案 | 误当"加密" → 密钥实际未受保护，必须保留界面黄色横幅 |

### 待清理 / 待修复（技术债，改到相关文件时一并处理）

| 项 | 位置 | 说明与建议处理方式 |
|---|---|---|
| 返回类型不严谨 | `app/src/shared/cost.ts` → `hasCreditRate()` | 声明返回 `boolean`，但 `typeof x === 'number' && ... && x > 0` 短路时会返回 `null`（实际类型为 `number \| null \| boolean`）。**下次改动 cost 相关逻辑时一并修正**：改为 `return typeof x === 'number' && x > 0;` |
| 无引用的历史资源 | `app/resources/tray-alert.png` | `tray.ts` 统一只用 `icon.png`，该文件仅被 `package.json` 的 `extraResources` 拷贝，**代码 0 引用**。下次打包/清理时决定「删除并同步 `extraResources`」或「接线做失败状态图标」 |
| 归档脚本相对路径失效 | `归档/diag-renderer.js` | 从 `scripts/` 移入 `归档/` 后，内部 `path.join(__dirname, '..', 'out', ...)` 指向错误位置；下次要用时改成 `path.join(__dirname, '..', 'app', 'out', ...)` |
| 已删除目录的残留引用 | 文档中的 `主题/` | `主题/` 已于 2026-10-03 删除。历史文档（`docs/`、`CHANGELOG.md`、`memory/`）里的引用属历史记录，**不必回改**；**现行文档与代码里若再出现 `主题/` 视为错误** |

### 修改后必须同步本手册（三项缺一不可）

1. 更新受影响的「三、文件用途清单」条目（新增/删除/重命名/职责变化都要改）；
2. 在「六、变更记录」**倒序追加**一条（日期、版本、改动摘要、涉及文件）；
3. 更新本文件头部的「最后更新」日期与「当前版本」。

---

## 六、变更记录（倒序，最新在上）

| 日期 | 版本 | 改动摘要 | 涉及文件 |
|---|---|---|---|
| 2026-10-03 | 1.8.0 | ① 删除 `主题/` 目录（用户确认；4 个未纳入 Git 的本地交付物：`api-balance-themes.css`、`theme-preview.html`、`overview.md`、`归档/trae.css`）；② 手册同步：移除 `主题/` 树节点与条目、修正内置背景图为 14 张、新增「待清理 / 待修复（技术债）」章节（`cost.ts` 返回类型、`tray-alert.png` 无引用、`归档/diag-renderer.js` 相对路径）；③ **未改任何代码/资源，未升版本、未打包** | `MAINTENANCE.md`；`主题/`（删除） |
| 2026-10-03 | 1.8.0 | 建立本维护手册（首次）：覆盖软件简介、目录结构总览、逐文件用途清单（主进程 / 适配器 / 预加载 / 渲染组件 / 共享层 / 文档 / 主题等）、启动链路与 IPC 数据流、数据文件清单、改动安全守则与高风险清单；内置背景图条目校正为 14 张并逐文件列名 | `MAINTENANCE.md`（新增） |
