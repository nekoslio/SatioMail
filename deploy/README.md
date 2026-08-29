# SatioMail 部署教程（Cloudflare Workers）

从零开始，把 SatioMail 部署到你自己的 Cloudflare 账号上。全程约 10 分钟，免费套餐即可。

---

## 一、前置条件

| 项目 | 要求 |
|---|---|
| Node.js | ≥ 18（含 npm） |
| Cloudflare 账号 | 免费版即可（Workers 免费额度：10 万次请求/天） |
| 企业邮箱 | 网易企业邮（`@mails.xxx.edu.cn` 等）或腾讯企业邮，且有管理员/个人权限开启 IMAP/SMTP |

> **邮箱授权码 ≠ 邮箱登录密码**。部署用的是「客户端授权密码」：
> - 网易企业邮：网页版 → 设置 → 客户端授权密码 → 开启 IMAP/SMTP 并设置授权密码
> - 腾讯企业邮：网页版 → 设置 → 客户端设置/安全 → 开启 IMAP/SMTP → 生成授权码

## 二、获取代码并安装依赖

```bash
git clone <你的仓库地址> SatioMail
cd SatioMail
npm install
npm run typecheck   # 应无报错
```

## 三、登录 Cloudflare

```bash
npx wrangler login
```

浏览器会弹出授权页，点击 Allow。验证：

```bash
npx wrangler whoami
```

## 四、配置 Secrets（4 个，缺一不可）

```bash
# 1. 网页登录密码（自己随意设置，用于登录 SatioMail 网页）
npx wrangler secret put APP_PASSWORD

# 2. 会话 Cookie 签名密钥（随机长字符串）
#    生成命令：openssl rand -hex 32
npx wrangler secret put COOKIE_SECRET

# 3. 邮箱地址（完整地址，注意域名后缀，如 zhangsan@mails.xxx.edu.cn）
npx wrangler secret put EMAIL_USERNAME

# 4. 邮箱客户端授权码（第一步准备的）
npx wrangler secret put EMAIL_PASSWORD
```

> Secrets 存储在 Cloudflare，不进代码仓库、不落盘、网页不回显。

## 五、（可选）启用自定义头像

头像以 base64 存在 Cloudflare KV。不配置时其余功能不受影响，仅头像接口提示"未配置"：

```bash
npx wrangler kv namespace create AVATAR_KV
```

把命令输出的 `id` 填入项目根目录 `wrangler.toml` 中 `AVATAR_KV` 注释段，并取消该段注释。

## 六、部署

```bash
npx wrangler deploy
```

成功后会输出形如 `https://satiomail.<你的子域>.workers.dev` 的地址。打开它，输入 `APP_PASSWORD` 即可使用。

> **首次打开样式不对？** Service Worker 缓存机制下，部署新版后第一次刷新可能仍是旧资源（后台正在更新缓存），**再刷新一次**即是最新版。

## 七、更新版本

```bash
git pull                 # 拉取更新
npm install              # 依赖有变化时
npm run typecheck
# 若改动了前端（public/），先把 public/sw.js 中的 CACHE 版本号 +1
npx wrangler deploy
```

## 八、（可选）绑定自定义域名

1. 将一个域名托管到 Cloudflare（免费计划支持）
2. Cloudflare 控制台 → Workers 和 Pages → 你的 Worker → 设置 → 域和路由 → 添加自定义域
3. DNS 记录自动创建，HTTPS 证书自动签发
4. 建议再叠加一层 [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)（免费 50 用户内）做二次认证

---

## 常见问题（Troubleshooting）

| 现象 | 原因与处理 |
|---|---|
| 登录后文件夹报「邮箱服务器操作失败」 | ① 授权码错误（`ERR.LOGIN.PASSERR`）→ 重新生成授权码；② 服务器域名与邮箱服务商不匹配（`ERR.LOGIN.DOMAINNOTEXIST`）→ 检查 `wrangler.toml` 中 IMAP/SMTP 主机是否为你的邮箱服务商（网易企业邮华东集群为 `imaphz.qiye.163.com` / `smtphz.qiye.163.com`） |
| 部署报 KV namespace not found | `wrangler.toml` 中 AVATAR_KV 的 id 未替换为真实值 → 见第五步，或暂时注释掉该段 |
| 部署报 Authentication error | 未登录 → `npx wrangler login` |
| 图标显示为英文单词（如 inbox） | Material Symbols 图标字体加载失败（网络问题）→ 检查对 `fonts.googleapis.com` / `fonts.gstatic.com` 的访问；中文回退为系统字体不影响使用 |
| 提示「尝试次数过多」 | 登录限流（60 秒 5 次）→ 稍后再试，或重启 Worker |
| 邮件发送失败（502） | 收件人地址错误，或附件超限（单文件/总量 25MB） |
| 断网时界面还能打开但收不了信 | 预期行为：界面壳离线可用，收发信必须联网 |

## 快捷脚本

`deploy/` 目录提供了一键部署脚本（自动检查登录态、类型检查、Secrets 是否齐全）：

```bash
# Linux / macOS / Git Bash
bash deploy/deploy.sh
```

```powershell
# Windows PowerShell
powershell -File deploy/deploy.ps1
```

## 安全提醒

- Worker 地址是公网可访问的——请务必设置强 `APP_PASSWORD`
- 不要把 `.dev.vars`、Secrets 值提交到仓库（`.gitignore` 已默认排除）
- 如需更强隔离，叠加 Cloudflare Access 或把 Worker 限制为仅自定义域访问
