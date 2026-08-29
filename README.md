# SatioMail

跑在 Cloudflare Workers 上的单账号网页邮箱。IMAP/SMTP 直连网易企业邮或腾讯企业邮，不经过任何第三方邮件服务。

纯静态前端，无框架。界面仿 Gmail（Material 3），浅色/深色主题，桌面和手机都能用。后端是一个 Worker：`cf-imap` 处理 IMAP，`src/smtp.ts` 是手写的 SMTP 客户端（`cloudflare:sockets`，465 隐式 TLS），MIME 报文自己组装。

## 功能

- 登录：访问密码，可选开启 TOTP 动态码（验证器 App）和 Turnstile 人机验证；登录失败有限流
- 文件夹列表，未读数，收起/展开（桌面收起后悬停展开，移动端是抽屉）
- 邮件列表分页，星标、已读未读、归档、删除（先进回收站）
- 读信：HTML 邮件做了白名单净化，远程图片默认不加载，支持内嵌图片和附件下载
- 写邮件：抄送/密送、附件、回复、转发，发出后自动存一份到已发送
- 搜索：网易的 IMAP SEARCH 不完整，所以在本地按关键词过滤最近 500 封
- 自定义头像（存 KV，可选）
- 浅色/深色主题切换
- PWA，可以装成桌面或手机应用

移动端：窄屏下侧栏默认收起，点左上角展开成抽屉；打开邮件时阅读页全屏覆盖在列表上，从底部滑入，返回滑出。

## 目录结构

```
├── src/
│   ├── index.ts      # Worker 入口，路由，CSRF，安全响应头
│   ├── config.ts     # Env 类型，端口
│   ├── auth.ts       # 登录，HMAC 签名的会话 Cookie
│   ├── totp.ts       # TOTP 动态码校验（RFC 6238）
│   ├── imap.ts       # cf-imap 连接管理，每个请求单独建连
│   ├── api.ts        # 所有 /api/* 处理函数和输入校验
│   ├── smtp.ts       # SMTP 客户端
│   └── mime.ts       # 出站 MIME 组装
├── public/           # 前端静态资源
│   ├── index.html / app.css / app.js
│   ├── manifest.webmanifest / sw.js / icons/
│   └── _headers      # 安全响应头
├── deploy/           # 部署教程和一键脚本
├── docs/             # 旧设计文档存档
└── wrangler.toml
```

## 本地开发

```bash
npm install
npm run dev        # http://127.0.0.1:8787
npm run typecheck
```

密钥放在根目录 `.dev.vars`（已 gitignore），模板见 [deploy/.dev.vars.example](deploy/.dev.vars.example)：

```bash
APP_PASSWORD=网页登录密码
COOKIE_SECRET=随机长字符串（openssl rand -hex 32）
EMAIL_USERNAME=邮箱地址
EMAIL_PASSWORD=邮箱授权码，不是登录密码
# 下面两项可选
TOTP_SECRET=Base32 密钥，配了登录就要输动态码
TURNSTILE_SITE_KEY=0x...
TURNSTILE_SECRET=0x...
```

网易企业邮先在网页版设置里开启 IMAP/SMTP 并生成客户端授权密码。

## 部署

详细步骤和常见问题见 [deploy/README.md](deploy/README.md)，也可以直接跑 `deploy/deploy.sh`（Windows 用 `deploy/deploy.ps1`）。

最简流程：

```bash
npx wrangler login
npx wrangler secret put APP_PASSWORD
npx wrangler secret put COOKIE_SECRET     # openssl rand -hex 32
npx wrangler secret put EMAIL_USERNAME
npx wrangler secret put EMAIL_PASSWORD
npx wrangler deploy
```

`wrangler.toml` 里默认是网易企业邮华东集群（`imaphz.qiye.163.com`），腾讯企业邮改成 `imap.exmail.qq.com` / `smtp.exmail.qq.com`。

可选配置：

- 登录限流的 KV（`LOGIN_KV`）已在 `wrangler.toml` 里绑定，开箱即用
- 自定义头像：`npx wrangler kv namespace create AVATAR_KV`，把 id 填进 `wrangler.toml`
- TOTP 动态码：生成一个 Base32 密钥，`npx wrangler secret put TOTP_SECRET`，录进验证器 App（详见 deploy/README.md 5.1 节）
- Turnstile：控制台建一个 site，Site Key 填 `wrangler.toml`，Secret Key 走 `wrangler secret put TURNSTILE_SECRET`

注意 Workers 禁止出站 25 端口，SMTP 走的是 465 隐式 TLS，IMAP 走 993。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/config` | 登录页配置（是否启用了 TOTP/Turnstile，公开） |
| POST | `/api/login` | 登录，可带 `totp`、`turnstileToken` |
| POST | `/api/logout` | 退出 |
| GET | `/api/me` | 当前账号 |
| GET | `/api/accounts` | 列出多账号配置（公开字段，公开密码/主机） |
| POST | `/api/accounts/active` | 切换当前活跃账号 |
| GET | `/api/avatar` | 读头像 |
| POST | `/api/avatar` | 设置/移除头像 |
| GET | `/api/folders` | 文件夹列表和未读数 |
| GET | `/api/emails?folder=&offset=&limit=` | 邮件列表 |
| GET | `/api/search?folder=&q=` | 搜索 |
| GET | `/api/email?folder=&uid=&read=` | 读单封 |
| POST | `/api/flags` | 已读/未读/星标 |
| POST | `/api/move` | 移动到文件夹 |
| POST | `/api/delete` | 删除 |
| POST | `/api/send` | 发送 |

除 `/api/login` 和 `/api/config` 外都需要会话；POST 都会校验 `Sec-Fetch-Site`/`Origin`。

## 安全上的处理

- 密码常量时间比较；会话是无状态 HMAC-SHA256 Cookie（`__Host-` 前缀 + Secure + HttpOnly + SameSite=Lax，30 天）
- 发送前服务端校验收件人格式、剥 CR/LF、附件和收件人数量有上限，防止信头注入
- IMAP 的文件夹名、标记、UID 都做了校验
- 写操作的 CSRF 校验（`Sec-Fetch-Site`/`Origin`）
- 登录失败限流走 LOGIN_KV，跨实例计数
- HTML 邮件白名单净化，远程图片默认不加载，`javascript:` 协议拦截
- `/api/*` 不被 Service Worker 缓存；静态资源网络优先、离线回退缓存

## 多账号（v1.3+）

默认仍是单账号；新增 `ACCOUNTS_CONFIG`（Workers Secret，JSON 数组）支持多账号。
配置示例：

```json
[
	{
		"id": "personal",
		"label": "私人 · 163",
		"username": "you@163.com",
		"password": "授权码A",
		"imapHost": "imaphz.qiye.163.com",
		"imapPort": 993,
		"smtpHost": "smtphz.qiye.163.com",
		"smtpPort": 465
	},
	{
		"id": "work",
		"label": "公司 · QQ",
		"username": "you@qq.com",
		"password": "授权码B",
		"imapHost": "imap.exmail.qq.com",
		"imapPort": 993,
		"smtpHost": "smtp.exmail.qq.com",
		"smtpPort": 465
	}
]
```

上传：

```bash
npx wrangler secret put ACCOUNTS_CONFIG   # 把上面的 JSON 粘进去（整段）
```

切换：顶栏点账号胶囊 → 选择目标账号；后端会下发新会话 Cookie，自动重载页面。
凭据始终只存在 Secret，不下发到前端；`/api/accounts` 只返回 `id` / `label` / `email` / `from`。

如果只填了旧的 `EMAIL_USERNAME` / `EMAIL_PASSWORD` 等单账号 Secret，完全兼容本版本，
无任何行为变化（登录后默认账号即唯一账号）。

## 已知限制

- 每个请求单独建 IMAP 连接，冷启动第一下慢
- 附件和总量上限 25MB，受 Worker 内存限制
- 搜索只能覆盖最近 500 封（网易 IMAP SEARCH 的锅）
- 字体和图标走 Google CDN，离线时回退系统字体
- SMTP 只支持 465 隐式 TLS（Cloudflare 禁 25 端口）

## 许可

[MIT](LICENSE)。Roboto / Material Symbols 是 Apache 2.0，Noto Sans SC 是 OFL，均通过 Google Fonts CDN 加载。

## 其他文档

- [deploy/README.md](deploy/README.md) —— 部署教程和故障排查
- [deploy/.dev.vars.example](deploy/.dev.vars.example) —— 本地配置模板
- [docs/](docs/) —— 旧设计文档
