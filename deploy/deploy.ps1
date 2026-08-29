# SatioMail 一键部署脚本（Windows PowerShell）
# 用法：powershell -File deploy\deploy.ps1
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

Step "[1/5] 检查本地环境"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "x 缺少 Node.js（>=18），请先安装"; exit 1
}
if (-not (Test-Path "node_modules")) {
    Write-Host "依赖未安装，执行 npm install..."
    npm install
}

Step "[2/5] 检查 Cloudflare 登录态"
npx wrangler whoami 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "x wrangler 未登录，请先执行: npx wrangler login"
    exit 1
}
Write-Host "v 已登录"

Step "[3/5] TypeScript 类型检查"
npm run --silent typecheck
Write-Host "v 通过"

Step "[4/5] 检查 Secrets 是否齐全"
$secretList = (npx wrangler secret list 2>$null) -join "`n"
$missing = @()
foreach ($s in @("APP_PASSWORD", "COOKIE_SECRET", "EMAIL_USERNAME", "EMAIL_PASSWORD")) {
    if ($secretList -notmatch [regex]::Escape("`"$s`"")) { $missing += $s }
}
if ($missing.Count -gt 0) {
    Write-Host ("x 缺少以下 Secrets，请先执行 npx wrangler secret put <名称>: " + ($missing -join " "))
    exit 1
}
Write-Host "v 4 个 Secrets 齐全"

Step "[5/5] 部署"
npx wrangler deploy

Write-Host "`nv 部署完成。若改动了前端资源，记得把 public/sw.js 中的 CACHE 版本号 +1 后再部署。" -ForegroundColor Green
