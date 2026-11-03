<#
  批量把 Wallpaper Engine 订阅里的作品实拍成视频。

  用法：pwsh -File tools/capture-batch.ps1

  - 先把桌面清空（最小化窗口 / 隐藏图标 / 隐藏任务栏），拍完还原；
  - 每件：WE 打开 → 等 10 秒 → ffmpeg 录 12 秒 → 关闭；
  - 产物与清单写到 build\cap\。
#>

$ErrorActionPreference = 'Stop'

$WE   = "D:\SteamLibrary\steamapps\common\wallpaper_engine\wallpaper64.exe"
$FF   = "C:\Users\Lenovo\Documents\deepseek-harness\default-workspace\.tools\node_modules\@ffmpeg-installer\win32-x64\ffmpeg.exe"
$ROOT = "D:\SteamLibrary\steamapps\workshop\content\431960"
$OUT  = Join-Path $PSScriptRoot "..\build\cap"
$OUT  = [System.IO.Path]::GetFullPath($OUT)
New-Item -ItemType Directory -Force -Path $OUT | Out-Null

# RePKG 做不出来的 10 个：8 个分件木偶/图集 + 2 个没有大纹理
$IDS = @(
  '3326873240', '3409595232', '3426865175', '3463520581', '3470764447',
  '3479521040', '3521337568', '3554161528', '2821781071', '3510729512'
)

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DeskCap {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string cls, string win);
  [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr child, string cls, string win);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);

  public static IntPtr FindDefView() {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      var sb = new StringBuilder(256);
      GetClassName(h, sb, 256);
      string cls = sb.ToString();
      if (cls == "Progman" || cls == "WorkerW") {
        IntPtr dv = FindWindowEx(h, IntPtr.Zero, "SHELLDLL_DefView", null);
        if (dv != IntPtr.Zero) { found = dv; return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static void ToggleIcons() {
    IntPtr dv = FindDefView();
    if (dv != IntPtr.Zero) SendMessage(dv, 0x111, (IntPtr)0x7402, IntPtr.Zero);
  }
}
"@

$shell = New-Object -ComObject Shell.Application
$tray  = [DeskCap]::FindWindow("Shell_TrayWnd", $null)
$hideIcons = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced' -Name HideIcons -ErrorAction SilentlyContinue).HideIcons

Write-Host "清场：最小化窗口 / 隐藏图标 / 隐藏任务栏"
$shell.MinimizeAll()
Start-Sleep -Seconds 2
if ($hideIcons -ne 1) { [DeskCap]::ToggleIcons() }
[void][DeskCap]::ShowWindow($tray, 0)
Start-Sleep -Seconds 2

$manifest = @()

try {
  $i = 0
  foreach ($id in $IDS) {
    $i++
    $proj = Join-Path $ROOT "$id\project.json"
    if (-not (Test-Path $proj)) { Write-Host "[$i/$($IDS.Count)] 跳过 $id：没有 project.json"; continue }

    $title = $id
    try { $title = (Get-Content $proj -Raw -Encoding utf8 | ConvertFrom-Json).title } catch {}

    Write-Host "[$i/$($IDS.Count)] $title"
    & $WE -control openWallpaper -file $proj 2>&1 | Out-Null
    Start-Sleep -Seconds 10

    $mp4 = Join-Path $OUT "$id.mp4"
    & $FF -hide_banner -loglevel error -y -f gdigrab -framerate 60 -i desktop -t 12 `
      -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -movflags +faststart $mp4 2>&1 | Out-Null

    $jpg = Join-Path $OUT "$id.jpg"
    & $FF -hide_banner -loglevel error -y -ss 2 -i $mp4 -frames:v 1 -q:v 2 $jpg 2>&1 | Out-Null

    $size = [math]::Round((Get-Item $mp4).Length / 1MB, 2)
    Write-Host ("   录制完成 {0} MB" -f $size)

    $manifest += [pscustomobject]@{ id = $id; title = $title; mp4 = $mp4; jpg = $jpg; mb = $size }

    & $WE -control closeWallpaper 2>&1 | Out-Null
    Start-Sleep -Seconds 2
  }
}
finally {
  Write-Host "还原桌面"
  & $WE -control closeWallpaper 2>&1 | Out-Null
  [void][DeskCap]::ShowWindow($tray, 5)
  if ($hideIcons -ne 1) { [DeskCap]::ToggleIcons() }
  $shell.UndoMinimizeAll()
}

$manifestPath = Join-Path $OUT "manifest.json"
$manifest | ConvertTo-Json -Depth 3 | Set-Content -Path $manifestPath -Encoding utf8
Write-Host "`n完成 $($manifest.Count) 个，清单：$manifestPath"
