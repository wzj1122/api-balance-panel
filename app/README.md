# API 余额面板（api-balance-panel）

一个常驻电脑上的小窗口：打开就能在一屏里看完所有 AI 平台 / 中转站账号的余额，不用再逐个登后台。

- 技术栈：Electron 44 + Vue 3 + Vite 7 + TypeScript（electron-vite 三段构建）
- 运行环境：Windows 11 / Node 22
- 数据存放：`%APPDATA%\API 余额面板\`（`config.json` + `snapshots.json` + `logs\`；打包后 userData 取 `productName`）

## 一、安装与启动

```bash
# 1. 安装依赖（已内置 npmmirror 镜像，见 .npmrc）
npm install

# 2. 开发模式（热重载）
npm run dev

# 3. 三段构建（输出 out/）
npm run build

# 4. 类型检查（vue-tsc 检查渲染进程 + tsc 检查主进程）
npm run typecheck

# 5. 预览构建产物
npm run start
```

> npm 请使用 `C:\Users\18293\.workbuddy\binaries\node\versions\22.22.2-2\` 下的 node/npm（Node 22.22.2）。

## 二、目录说明

```
src/
├── main/                 # 主进程（Node 侧，唯一联网方）
│   ├── index.ts          # app 生命周期、单实例锁、启动装配
│   ├── window.ts         # BrowserWindow（1100×760，最小 900×600）
│   ├── paths.ts          # 数据目录与文件常量
│   ├── logger.ts         # 分级日志 + 密钥脱敏 + 1MB 轮转
│   ├── crypto.ts         # safeStorage 加解密 + 不支持时的本机弱混淆降级
│   ├── store.ts          # config.json 原子写 / .bak 备份 / 损坏恢复 / 归一化
│   ├── snapshot.ts       # 快照追加与裁剪（保留 30 天、单账号 2000 条）
│   ├── http.ts           # 原生 fetch 封装（15s 超时、非 ASCII 预检、非 2xx 不抛）
│   ├── errors.ts         # 错误码 → 人话文案总表
│   ├── adapters/         # 每家平台一个小文件（T03）
│   ├── browser/          # 浏览器自动化（登录窗口 + 抓 Cookie，不装 Playwright）
│   ├── query.ts          # 并发池 + 缓存 + 写快照（T03）
│   ├── scheduler.ts      # 定时刷新（T03）
│   ├── notify.ts         # 低余额通知（T03）
│   └── ipc.ts            # ipcMain.handle 注册（T03）
├── preload/              # contextBridge 白名单（window.api）
├── renderer/             # Vue 3 界面（index.html 在 renderer 根目录）
└── shared/               # 两端共用的类型 / 常量 / IPC 通道 / 格式化函数
```

**铁律**：所有联网请求只在主进程发起；渲染进程永远拿不到密钥明文，也永不直接发 HTTP 请求。

## 三、密钥是怎么保管的

1. 密钥只在主进程内存里以明文出现，用完即弃。
2. 落盘的是 `secret_enc`：优先用 Electron `safeStorage`（Windows 走 DPAPI，系统级加密）。
3. 若系统不支持加密（罕见），降级为「本机弱混淆」并在界面顶部弹黄色横幅 —— **这不是加密**，只能防止别人不小心看到明文，**请不要把 config.json 发给任何人**。
4. 界面上只显示掩码 `sk-****1234`；`AccountView` 类型层面就删掉了 `secret_enc`。

## 四、新增一个平台适配器

1. 在 `src/main/adapters/` 下新建 `xxx.ts`，导出一个函数：
   `(account: Account, secret: string, ctx: AdapterContext) => Promise<BalanceResult>`；
2. 用 `http.request()` 发请求、`dig()/num()` 取值、**失败只返回错误码**（文案统一在 `errors.ts`）；
3. 在 `src/main/adapters/index.ts` 的 `PROVIDERS` 里注册一行；
4. 在 `src/shared/types.ts` 的 `AccountType` 与 `src/shared/constants.ts` 的 `PROVIDER_META` 各加一条，界面表单会自动渲染新字段。

## 五、自定义平台怎么抓包填（搬自原型 README）

1. 浏览器打开平台余额页，按 F12 → 网络（Network）面板；
2. 刷新页面，在请求列表里找返回 JSON、且内容里带余额数字的那条；
3. 右键该请求 → 复制 → 复制为 cURL，或手动记下：**请求地址**、**请求方式**、**请求头**（Cookie / Authorization）；
4. 在面板里添加「自定义」账号：填地址、方式、请求头（一行一个，格式 `键: 值`）；
5. 取值路径填余额数字在 JSON 里的位置，例如返回 `{"data":{"balance":12.3}}` 就填 `data.balance`；
6. 平台返回的单位不是「元」就填倍率：差 100 倍填 `0.01`，差 100 万倍填 `0.000001`；
7. 点保存后看卡片：数字对就完事了，不对就微调取值路径。

## 六、常见问题

| 现象 | 原因与处理 |
|---|---|
| 卡片显示「密钥错了或过期了」 | HTTP 401/403，去平台后台重新生成一个 Key 粘进来 |
| 卡片显示「网址填错了」 | 中转站地址只填域名，不要带 `/v1` 或结尾斜杠 |
| 卡片显示「平台返回的不是数据」 | Cookie 过期了，重新抓一次包 |
| 卡片显示「网络不通」 | 检查代理 / 防火墙；公司网络常需要开代理 |
| 提示「已恢复到上一次备份」 | config.json 被改坏了，程序自动回滚到 `.bak`，坏文件另存为 `config.corrupt-<时间戳>.json` |
| 顶部黄色横幅 | 当前系统不支持加密存储，见第三节第 3 条 |
