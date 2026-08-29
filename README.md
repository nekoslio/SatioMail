# SatioMail

部署在 **Cloudflare Workers** 上的单账号个人邮箱客户端。通过 IMAP/SMTP 直连网易企业邮（或腾讯企业邮），在自己部署的 Gmail 风格网页里收信、读信、回信、归档、搜索。

- 前端：纯静态单页应用（无框架），Material 3 / Gmail 风格，浅色+深色双主题，桌面/移动端自适应
- 字体与图标：Roboto + Noto Sans SC + Material Symbols，经 **Google Fonts CDN** 加载（离线自动回退系统字体）
- 后端：Cloudflare Worker，`cf-imap` 负责 IMAP，自研原始 socket SMTP 客户端（`cloudflare:sockets`，465 隐式 TLS）
- PWA：可安装为桌面/手机独立应用，断网时界面壳离线可用（`/api/*` 永不缓存）
- 凭据：邮箱账号/授权码与网页访问密码均以 **Workers Secrets** 存储，不进仓库、不落盘、不在页面回显
- 登录三重防护：**Turnstile 人机验证 + 访问密码 + TOTP 动态码**，配全局限流

## 功能

- 登录：访问密码 + 验证器 App 动态码（TOTP 2FA）+ Turnstile 人机验证；全局限流（60 秒内错 5 次锁定，跨实例计数）
- 文件夹列表（含未读数）与收起/展开（桌面收起态为圆形图标栏，悬停 0.5s 自动展开；移动端为覆盖式抽屉，点遮罩自动收起）
- 邮件列表分页 / 星标 / 已读未读 / 归档 / 删除（默认进回收站，回收站内为永久删除）；列表行操作按钮在触屏上常显
- 读信：移动端为**全屏覆盖层**（自底部滑入，返回滑出）；文本/HTML 正文（白名单净化 + 远程图片默认拦截）、内嵌图片、附件下载
- 写邮件：收件人/抄送/密送、附件、回复（`In-Reply-To`/`References`）、转发；发送后自动存「已发送」；服务端校验地址格式与附件限额
- 全站搜索（网易 IMAP SEARCH 不完整，客户端本地过滤最近 500 封）
- 自定义头像（base64 存 Cloudflare KV，可选功能）
- 主题切换（浅色/深色，跟随登录页与 Turnstile 挂件）

## 目录结构

```
├── src/
│   ├── index.ts      # Worker 入口 + 路由 + CSRF 校验 + 安全响应头
│   ├── config.ts     # Env 类型与默认端口
│   ├── auth.ts       # 登录、HMAC 会话 Cookie
│   ├── totp.ts       # RFC 6238 TOTP 二步验证
│   ├── imap.ts       # cf-imap 连接管理（每请求独立连接 + 超时重试）
│   ├── api.ts        # 全部 /api/* 处理函数 + 输入校验
│   ├── smtp.ts       # 自研 SMTP 客户端（465 隐式 TLS）
│   └── mime.ts       # 出站 MIME 构造器（RFC 2047 折行编码）
├── public/           # 前端静态资源（Worker Assets）
│   ├── index.html / app.css / app.js
│   ├── manifest.webmanifest / sw.js / icons/   # PWA
│   └── _headers      # 边缘安全响应头
├── deploy/           # 部署套件：详细教程 + 一键脚本 + 配置模板
├── docs/             # 历史设计文档归档
└── wrangler.toml     # Worker 配置 + KV 绑定 + 变量（IMAP/SMTP 主机端口）
```

## 本地开发

```bash
npm install
npm run dev        # http://127.0.0.1:8787
npm run typecheck  # TypeScript 检查
```

本地调试用的秘密放在根目录 `.dev.vars`（已被 .gitignore 忽略），模板见
[deploy/.dev.vars.example](deploy/.dev.vars.example)：

```bash
APP_PASSWORD=你的网页访问密码
COOKIE_SECRET=随机长字符串（openssl rand -hex 32）
EMAIL_USERNAME=你的邮箱地址
EMAIL_PASSWORD=邮箱授权码（不是登录密码）
# 可选：TOTP 二步验证密钥（Base32，不配置则登录无需动态码）
TOTP_SECRET=Base32 密钥
# 可选：Turnstile 人机验证（成对配置才启用）
TURNSTILE_SITE_KEY=站点密钥
TURNSTILE_SECRET=服务端密钥
```

163 企业邮：网页版 → 设置 → 客户端授权密码 → 开启 IMAP/SMTP 并设置授权密码。

## 部署

> 📦 **详细部署教程（含常见问题排查、自定义域名、一键脚本）：见 [deploy/README.md](deploy/README.md)**

```bash
npm install
npx wrangler login
npx wrangler secret put APP_PASSWORD      # 网页访问密码
npx wrangler secret put COOKIE_SECRET     # openssl rand -hex 32
npx wrangler secret put EMAIL_USERNAME    # 完整邮箱地址
npx wrangler secret put EMAIL_PASSWORD    # 客户端授权码
npx wrangler deploy
```

`wrangler.toml` 内置网易企业邮（华东 hz 集群）服务器地址；腾讯企业邮改为
`imap.exmail.qq.com` / `smtp.exmail.qq.com`。`wrangler.toml` 中已绑定
`LOGIN_KV`（全局限流）——新账号首次部署无需额外操作。

### 可选：TOTP 二步验证

```bash
# 生成随机密钥（Base32，录入验证器 App：手动添加，SHA1/6 位/30 秒）
node -e "const B32='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';const b=require('crypto').randomBytes(20);let bits=0,v=0,out='';for(const x of b){v=(v<<8)|x;bits+=8;while(bits>=5){out+=B32[(v>>>(bits-5))&31];bits-=5;}}if(bits>0)out+=B32[(v<<(5-bits))&31];console.log(out);"
npx wrangler secret put TOTP_SECRET       # 粘贴生成的密钥
npx wrangler deploy
```

录入验证器后，登录即需「密码 + 6 位动态码」。遗失密钥：`npx wrangler secret
delete TOTP_SECRET` 临时关闭 2FA，重新生成即完成换机。

### 可选：Turnstile 人机验证

1. Cloudflare 控制台 → Turnstile → Add site → 域名填 Worker 地址 + `localhost`
2. Site Key → `wrangler.toml` 的 `[vars]` 段：`TURNSTILE_SITE_KEY = "..."`
3. Secret Key → `npx wrangler secret put TURNSTILE_SECRET`
4. `npx wrangler deploy`

### 可选：头像存储（KV）

头像以 base64 存于 KV（`wrangler.toml` 已含绑定段，按注释填入 id 即可）。未配置时头像接口返回友好提示，其余功能不受影响：

```bash
npx wrangler kv namespace create AVATAR_KV
```

> Cloudflare Workers 禁止出站端口 25，SMTP 必须走 465 隐式 TLS（已内置）。IMAP 走 993。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/config` | 登录页配置（是否启用 TOTP/Turnstile，公开） |
| POST | `/api/login` | 密码登录（可含 `totp`/`turnstileToken`），签发会话 Cookie |
| POST | `/api/logout` | 退出登录，清除 Cookie |
| GET | `/api/me` | 当前账号信息 |
| GET | `/api/avatar` | 读取自定义头像（data URL，未设置返回 null） |
| POST | `/api/avatar` | 设置/移除头像（`{dataUrl}` 或 `{clear:true}`） |
| GET | `/api/folders` | 文件夹列表 + 未读数 |
| GET | `/api/emails?folder=&offset=&limit=` | 邮件列表（分页） |
| GET | `/api/search?folder=&q=` | 搜索（最近 500 封本地过滤） |
| GET | `/api/email?folder=&uid=&read=` | 读取单封邮件 |
| POST | `/api/flags` | 标记已读/未读/星标（flags 白名单） |
| POST | `/api/move` | 移动到文件夹（无 MOVE 能力时回退 COPY+删除） |
| POST | `/api/delete` | 删除（默认移入回收站） |
| POST | `/api/send` | 发送邮件（服务端校验地址/附件限额，自动存「已发送」） |

除 `/api/login` 与 `/api/config` 外，所有 `/api/*` 都要求有效会话；所有 POST 均校验 `Sec-Fetch-Site`/`Origin`。

## 安全说明

- 邮箱凭据与访问密码只存于 Cloudflare Secrets；会话为无状态 HMAC-SHA256 签名 Cookie（HTTPS 下 `__Host-` 前缀 + Secure + HttpOnly + SameSite=Lax，30 天）
- **登录三重防护**：Turnstile 人机验证（可选）→ 访问密码（常量时间比较）→ TOTP 动态码（可选）；任一未配置自动跳过对应环节
- 发送路径服务端校验：收件人地址格式、CRLF 剥除（防信头/信封注入）、收件人 ≤50、附件单文件/总量 ≤25MB、附件名消毒
- IMAP 参数校验：文件夹名拒绝引号/CR/LF，标记白名单（\Seen/\Flagged/\Deleted/...），uids 仅数字列表
- **登录限流**：同一 IP 60 秒内失败 5 次锁定，经 LOGIN_KV 跨实例全局计数
- CSRF：所有写操作校验 `Sec-Fetch-Site`/`Origin`
- 安全响应头：CSP、nosniff、X-Frame-Options、HSTS、COOP 等（`_headers` + Worker 双层）
- 读信 HTML 白名单净化 + 剥离事件属性/危险 CSS/`javascript:` 协议 + 远程图片默认拦截
- Service Worker：`/api/*` 永不缓存；静态资源网络优先、离线回退缓存

## 已知限制

- 单账号（个人企业邮箱自用），多账号需自行扩展
- IMAP 为每请求独立连接，冷启动后首次操作略慢属正常
- 附件单文件/总量上限 25MB（Worker 内存限制）
- 网易 IMAP SEARCH 服务端不可用，搜索为客户端本地过滤（最近 500 封）
- 字体与图标经 Google CDN 加载：离线时中文/图标回退系统字体（界面仍可用）
- SMTP 仅支持 465 隐式 TLS（Cloudflare 禁 25 端口）

## 开源许可

本项目基于 [MIT License](LICENSE) 开源。字体与图标经 Google Fonts 公共 CDN
加载：Roboto（Apache 2.0）、Noto Sans SC（OFL）、Material Symbols（Apache 2.0）。

## 相关文档

- [deploy/README.md](deploy/README.md) —— 从零到上线的部署教程与故障排查
- [deploy/.dev.vars.example](deploy/.dev.vars.example) —— 本地调试配置模板
- [docs/](docs/) —— 历史设计文档
