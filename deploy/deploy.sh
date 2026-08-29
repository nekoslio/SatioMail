#!/usr/bin/env bash
# SatioMail 一键部署脚本（Linux / macOS / Git Bash）
# 用法：bash deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

step "[1/5] 检查本地环境"
command -v node >/dev/null 2>&1 || { echo "✗ 缺少 Node.js（≥18），请先安装"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "✗ 缺少 npm"; exit 1; }
[ -d node_modules ] || { echo "依赖未安装，执行 npm install..."; npm install; }

step "[2/5] 检查 Cloudflare 登录态"
if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "✗ wrangler 未登录，请先执行: npx wrangler login"
  exit 1
fi
echo "✓ 已登录"

step "[3/5] TypeScript 类型检查"
npm run --silent typecheck
echo "✓ 通过"

step "[4/5] 检查 Secrets 是否齐全"
secret_list=$(npx wrangler secret list 2>/dev/null || echo "")
missing=""
for s in APP_PASSWORD COOKIE_SECRET EMAIL_USERNAME EMAIL_PASSWORD; do
  echo "$secret_list" | grep -q "\"$s\"" || missing="$missing $s"
done
if [ -n "$missing" ]; then
  echo "✗ 缺少以下 Secrets，请先执行 npx wrangler secret put <名称>:$missing"
  exit 1
fi
echo "✓ 4 个 Secrets 齐全"

step "[5/5] 部署"
npx wrangler deploy

printf '\n\033[1;32m✓ 部署完成。\033[0m 若改动了前端资源，记得把 public/sw.js 中的 CACHE 版本号 +1 后再部署。\n'
