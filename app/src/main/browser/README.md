# browser 模块（浏览器自动化：登录 + 抓 Cookie）

> 已实现，非占位。用 Electron 自带的 Chromium 完成「Cookie 型平台登录」，**不引入
> Playwright / Chromium 依赖**，安装包体积不受影响。

## 用途

小米 MiMo、MiniMax、智谱、硅基流动这类平台没有公开令牌余额接口，只能抓登录后的
Cookie 当凭据（存进账号 `secret` 字段的 encrypted 值）。本模块打开一个独立的
登录窗口（专属 `session` 分区，与主窗口隔离），用户登录完成后**自动校验并关窗**，
主进程拿到 Cookie 落盘。

## 导出 API（`src/main/ipc.ts` 使用）

| 函数 | 说明 |
|---|---|
| `loginToSite(opts: LoginOptions): Promise<LoginResult>` | 核心入口：开窗 → 加载登录表单 → 轮询「成功规则」→ 校验 → 自动关窗返回 `{ ok, cookie }` |
| `validateByUrl(url, opts?)` | 生成校验器：拿 Cookie 真实请求一次业务接口，`200`（或 `okStatuses`）即通过 |
| `cookieHas(name)` | 生成校验器：Cookie 里出现指定名字即视为登录成功 |
| `validateMinimaxCookie(cookie)` | MiniMax 专用：先试 `.com` 再试 `.cn`，任一接口通过即成功 |

`LoginOptions`：

- `url` —— 登录表单页地址（各平台常量见 `src/shared/constants.ts` 的 `*_LOGIN_URL`）；
- `name` —— 平台显示名（窗口标题 / 日志）；
- `extraUrls` —— 额外按这些域名抓 Cookie（接口域与登录域不同时用，如 MiniMax 的 www 域）；
- `validate` —— 抓完 Cookie 后立即校验（null = 通过）；
- `success` —— 自动关窗规则：窗口进入指定 host（可带路径前缀）后开始轮询校验，通过即自动关闭。

## 使用流程

1. 用户点「登录 XX」→ 主进程调用 `loginToSite`；
2. 登录窗口用独立 `session`（先清空历史 Cookie，避免旧会话干扰）加载登录表单页；
3. 进入成功规则命中地址后轮询校验（每 800ms，最多等 60s），任一通过 → 延缓 600ms 等
   Cookie 落盘 → 自动关窗；
4. 用户在「有机会前」手动关窗 → `closed` 事件兜底抓 Cookie 并校验后返回；
5. 校验失败/超时 → 返回 `{ ok: false, error }`，界面提示重试。

## 注意事项

- 自动登录可能触发平台风控/验证码 → 留了「手动接管 + 超时兜底」：60s 未检测到成功则
  保持窗口打开，提示用户可手动关闭或重试。
- Cookie 一般 24 小时过期 → 适配器失败会返回「重新登录」类错误码，界面引导重新登录。
- 校验逻辑不依赖 Cookie 名字与登录后跳转路径（平台改名/改版不影响），首选各种
  `validateByUrl`；`cookieHas` 仅作简单场景的兜底判断。