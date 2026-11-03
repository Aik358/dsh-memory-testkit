# elevate.ps1 -- 给沙箱根目录补 WRITE_DAC / WRITE_OWNER
#
# 为什么需要：
#   dsh-sandbox-windows-acl 的 grantWrite() 要给工作区目录设置 DACL 与
#   Low 完整性标签，这一步需要 WRITE_DAC + WRITE_OWNER。
#   D:\ 下继承的权限是 Authenticated Users:Modify —— **不含这两项**
#   ⇒ 未提权的进程跑 dsh 时会报：
#       SetNamedSecurityInfoW failed (Win32 5): grantWrite(<workspace>)
#   而且症状极具误导性：**连工作区内的正常写入都失败**，
#   看起来像「沙箱坏了」，实际是「沙箱装不起来」。
#
# 用法（会弹 UAC，点「是」）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File setup\elevate.ps1
#
# 注意：本脚本纯 ASCII —— PowerShell 5.1 把无 BOM 的 .ps1 按 ANSI 读，
#       中文会乱码并连带破坏字符串解析（反引号转义会失效）。
param(
  # 沙箱根目录。不写默认值 —— 本机路径不该进仓库。
  # 用法：-Work 'D:\your\sandbox'，或先设环境变量 TESTKIT_WORK
  [string]$Work = $(if ($env:TESTKIT_WORK) { $env:TESTKIT_WORK } else { (Join-Path $PSScriptRoot '..\run') })
)

$ErrorActionPreference = 'Stop'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host "work root : $Work"
Write-Host "elevated  : $isAdmin"
if (-not $isAdmin) {
  Write-Host ''
  Write-Host "NOT elevated. Re-run from an Administrator PowerShell, or:" -ForegroundColor Yellow
  Write-Host "  Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','$PSCommandPath'"
  exit 1
}

if (-not (Test-Path $Work)) { New-Item -ItemType Directory -Force -Path $Work | Out-Null }

$user = ($env:USERDOMAIN + '\' + $env:USERNAME)
try {
  $acl = Get-Acl $Work
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $user, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.SetAccessRule($rule)
  Set-Acl -Path $Work -AclObject $acl
  Write-Host "OK: granted FullControl on $Work to $user" -ForegroundColor Green
} catch {
  Write-Host "FAIL: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

# 复检
$now = (Get-Acl $Work).Access | Where-Object { $_.IdentityReference -like "*$env:USERNAME*" } | Select-Object -First 1
Write-Host ("verify    : " + $now.FileSystemRights)
if (-not ($now.FileSystemRights -match 'FullControl')) {
  Write-Host "WARN: rights do not include FullControl; sandbox grantWrite may still fail" -ForegroundColor Yellow
  exit 1
}
Write-Host ''
Write-Host "Done. Now run: node setup/preflight.mjs"
