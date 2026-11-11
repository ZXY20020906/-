# 手动部署兜底（Windows PowerShell）
#
# 用途：当 GitHub Actions 挂了 / 需要立刻发一版时，本地直接推。
# 用法：
#   .\scripts\deploy.ps1                       # 完整流程：测试 → 同步 → 部署
#   .\scripts\deploy.ps1 -SkipTest             # 跳过测试（紧急时）
#   .\scripts\deploy.ps1 -Branch preview       # 发到预览环境而不是生产
#
# 需要：Node 20+（不必全局装 wrangler，脚本用 npx）、一个带
#       Account · Cloudflare Pages · Edit 权限的 API Token。

param(
  [switch]$SkipTest,
  [string]$Branch = "main",
  [string]$Project = "folia"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $env:CLOUDFLARE_API_TOKEN) {
  throw "缺少 CLOUDFLARE_API_TOKEN（Cloudflare → My Profile → API Tokens，勾 Account · Cloudflare Pages · Edit）"
}

Write-Host "→ 目录: $root" -ForegroundColor Cyan
Write-Host "→ 分支: $Branch · 项目: $Project" -ForegroundColor Cyan

if (-not $SkipTest) {
  Write-Host "→ 跑测试…" -ForegroundColor Cyan
  npm test
  if ($LASTEXITCODE -ne 0) { throw "测试失败，已中止部署（确认要发就加 -SkipTest）" }
}

Write-Host "→ 同步 deploy/（public + functions + src + schema）…" -ForegroundColor Cyan
node tools/sync-deploy.mjs
if ($LASTEXITCODE -ne 0) { throw "sync-deploy 失败" }

Write-Host "→ 上传到 Cloudflare Pages…" -ForegroundColor Cyan
npx -y wrangler@3.99.0 pages deploy ./deploy `
  --project-name=$Project `
  --branch=$Branch `
  --commit-dirty=true
if ($LASTEXITCODE -ne 0) { throw "部署失败（先看是不是 Token 缺 Pages:Edit 权限）" }

Write-Host "✓ 完成。生产域名: https://folia-5ve.pages.dev" -ForegroundColor Green
Write-Host "  自检: 打开首页 → DevTools → Network → 看 gallery.js?v= 是否为新版本号" -ForegroundColor Green
