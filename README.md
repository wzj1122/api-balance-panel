# API 余额面板（api-balance-panel）

一个常驻电脑上的小窗口：打开就能在一屏里看完所有 AI 平台 / 中转站账号的余额，余额低于阈值时自动变色提醒，不用再逐个登后台。

- **技术栈**：Electron 44 + Vue 3 + Vite 7 + TypeScript
- **运行环境**：Windows 10/11（x64）

![build](https://img.shields.io/badge/platform-Windows%2010%2F11-blue) ![license](https://img.shields.io/badge/license-MIT-green)

---

## ✨ 功能一览

- **余额卡片墙**：DeepSeek / 硅基流动 / 小米 MiMo（余额 + 套餐）/ MiniMax / 智谱 / 阿里云百炼 / New API 中转站 / 自定义接口，一张卡片一个账号，按类型分组可折叠
- **自动定时刷新**：默认 60 秒一次（可调 15 秒 ~ 24 小时），最小化到托盘仍持续刷新
- **低余额提醒**：每个账号可单独设阈值，触发后卡片变色 + 系统通知
- **余额耗尽预估**：按近 7 天日均消耗外推「预计 MM-DD 耗尽 · 约剩 N 天」
- **每日使用状况**：按日消耗统计、日历热力图、导出 CSV（Excel 直接打开不乱码）
- **平台用量**：按平台 × 单位聚合的消耗统计与对比图
- **AI 使用报告**：日报 / 周报 / 月报 + 一键生成 900×1200 分享卡片 PNG
- **接口监控**：自己填 API Key + 调用地址，按间隔真实调用并统计可用率 / 延迟 / 连续失败（POST/GET、自定义头、`{{key}}` 占位）
- **Key 管理**：集中管理各平台 API Key（分类标签、回收站、批量操作、导出 Markdown/JSON/cURL）
- **主题外观**：14 套主题（深色/浅色/跟随系统）+ 内置背景图 + 玻璃拟态效果
- **演示模式**：内置 6 个示例账号 + 30 天示例数据，不写盘、不发请求，先看效果
- **单实例常驻**：关窗只隐藏到托盘；再次点击快捷方式/重复启动只会唤起已有主界面，不会开出第二个窗口
- **数据安全**：密钥用系统级加密（Windows DPAPI）落盘，渲染进程永远拿不到明文，不上传任何地方

---

## 📦 安装（推荐：安装包）

1. 到 [Releases 页面](https://github.com/wzj1122/api-balance-panel/releases) 下载最新安装包（约 130 MB）。GitHub 附件名不支持中文，实际下载文件名为 **`API.Setup.v1.0.1.exe`**（安装后的程序/快捷方式名为「API 余额面板」，本地绿色版文件名为 `API 余额面板.exe`）。
2. 双击运行，跟着安装向导走（默认装到当前用户目录，可点「高级选项」改安装位置）。
3. 装完后桌面 / 开始菜单出现「API 余额面板」，首次启动如遇 Windows SmartScreen 提示，点 **「更多信息 → 仍要运行」** 即可（个人分发未购买代码签名证书，属正常现象）。
4. 数据保存在 `%APPDATA%\api-balance-panel\`（`config.json` + `snapshots.json` + `logs\`），备份/换电脑拷贝整个文件夹即可。

> 免安装（绿色版）：构建产物 `dist\win-unpacked\` 目录可整体分发（`API 余额面板.exe` 必须连同同级 `resources` 文件夹一起）。

## 🚀 快速开始

1. 打开程序 → 右上角「添加账号」，选择平台类型：
   - **API Key 型**（DeepSeek / New API 中转站 / 自定义）：粘贴 `sk-` 开头的 Key（可加 `base_url`）；
   - **登录型**（小米 MiMo / MiniMax / 智谱 / 硅基流动）：点「登录」按钮，在弹出的窗口里登录，完成后自动抓取 Cookie 并关窗；
   - **AccessKey 型**（阿里云百炼）：RAM 控制台创建只读 AccessKey，格式 `AccessKey ID|AccessKey Secret`。
2. 保存后程序立即刷新一次，卡片显示余额；点卡片右上角图标可看趋势 / 刷新 / 编辑。
3. 去「设置」里调整刷新间隔、各账号低余额阈值、每日预算告警、开机自启等。

> 各平台的详细图文步骤，打开程序后点侧边栏「使用说明」，或见 [`docs/使用说明.md`](docs/使用说明.md)。

## 🔒 数据与隐私

- 所有联网请求只在**主进程**发起；渲染进程永远拿不到密钥明文，`AccountView` 在类型层面就删除了 `secret_enc` 字段。
- 密钥优先用 Electron `safeStorage`（Windows = DPAPI，系统级加密）落盘；若系统不支持加密，降级为本机弱混淆并在界面顶部显示黄色横幅警告。
- 配置文件原子写入 + `.bak` 备份 + 损坏自动回滚；快照保留 30 天 / 每账号 2000 条，超期自动裁剪。
- 程序只在刷新时请求各平台官方接口，无其他外联；日志自动脱敏密钥。

## 🕹 常见问题

| 问题 | 处理 |
|---|---|
| 提示「网络不通」 | 本机解析不了平台接口域名，换网络/关代理再试 |
| 提示「密钥错了或过期了」 | DeepSeek/中转站检查 Key；MiMo/硅基流动/智谱/MiniMax 点「重新登录」 |
| 提示「网址填错了」 | New API 站点地址只填域名，不要带 `/v1` |
| 余额显示 0 / 字段找不到 | 多为平台接口结构变化，把小字详情反馈给开发者 |
| 换电脑怎么带配置 | 拷贝 `%APPDATA%\api-balance-panel` 整个文件夹（密钥是本机加密的） |

## 🛠 本地开发与构建

要求：Node.js 22（项目内置了 npmmirror 镜像，见 `app/.npmrc`）。

```bash
cd app
npm install        # 安装依赖
npm run dev        # 开发模式（热重载）
npm run typecheck  # 类型检查（vue-tsc + tsc）
npm run build      # 三段构建，输出 out/
npm run dist:win   # 打包 NSIS 安装包，输出 dist/API 余额面板 Setup 1.0.1.exe
```

## 📁 目录结构（代码在 `app/`）

```
app/
├── src/
│   ├── main/                 # 主进程（Node 侧，唯一联网方）
│   │   ├── adapters/         # 每家平台一个小文件（取数/解析）
│   │   ├── browser/          # 浏览器自动化（登录窗口 + 抓 Cookie，不装 Playwright）
│   │   ├── store.ts          # 配置原子写 / .bak 备份 / 损坏恢复 / 归一化
│   │   ├── snapshot.ts       # 快照追加与裁剪
│   │   ├── monitor.ts        # 接口监控（真实调用 + 统计）
│   │   ├── scheduler.ts      # 定时刷新
│   │   ├── notify.ts         # 低余额 / 预算告警通知
│   │   └── ipc.ts            # ipcMain.handle 注册
│   ├── preload/              # contextBridge 白名单（window.api）
│   ├── renderer/             # Vue 3 界面
│   └── shared/               # 两端共用类型 / 常量 / IPC 通道 / 格式化
├── resources/                # 图标与内置背景图
└── package.json
```

## 📚 更多文档

- [`docs/使用说明.md`](docs/使用说明.md) —— 面向最终用户的使用说明
- [`docs/PRD.md`](docs/PRD.md)、[`docs/架构设计.md`](docs/架构设计.md) —— 产品需求与架构设计（历史文档，部分表述以代码为准）
- [`memory/`](memory/) —— 开发日志（过程记录，非用户文档）

## ⚠️ 免责声明

- 本工具为个人自用的开源项目，**非官方出品**，与任何 AI 平台无隶属关系；接口解析可能因平台改版失效。
- 使用"登录抓 Cookie"方式的平台，Cookie 存在本机并加密保存，请勿将 `config.json` 外发。
- 建议为阿里云等平台创建**只读**专用 AccessKey（`AliyunBSSReadOnlyAccess`），不要把主账号密钥交给本工具。
- 由于未购买代码签名证书，Windows 会提示"未知发布者"，请确认从本项目 Releases 或源码构建后使用。

## 📄 许可证

[MIT License](LICENSE) © 2026 Zhenjie Wang

```text
MIT License

Copyright (c) 2026 Zhenjie Wang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```