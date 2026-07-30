[CmdletBinding()]
param(
  [string]$RepositoryRoot = ''
)

# 發版前置檢查：electron/ffmpeg/ 與 electron/mpv/ 這兩支內建執行檔【刻意不進版控】
# （見 .gitignore，體積合計約 538 MB），只存在於各自的開發機上。package.json 的
# asarUnpack 明列這四個路徑要被打進安裝檔；`npm run dist` 對「檔案不存在」這件事
# 完全不會報錯——electron-builder 對 asarUnpack 沒 match 到任何檔案是靜默的，
# 產物只是單純少了那幾支執行檔。
#
# 後果：detect()（electron/main.js）找不到內建 ffmpeg 時會退回系統 PATH 或
# `C:\Program Files\FFMPEG\bin\`——若那裡裝的不是 gyan 的 full_build，多音軌 MXF
# 的音訊會被截斷（docs/Electron_維護手冊.md §7 的既有踩雷紀錄）。mpv 同理，找不到
# 內建版就退回系統安裝，沒裝就直接沒有秒開。兩者都不會讓 npm run dist 失敗，
# 使用者也不會看到任何錯誤訊息——這正是 AGENTS.md §0.6「有產出不等於對」的形狀。
#
# 這裡把它變成 npm run dist 之前的硬性檢查（package.json 的 predist）。

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
  $RepositoryRoot = Join-Path $PSScriptRoot '..'
}
$RepositoryRoot = [IO.Path]::GetFullPath($RepositoryRoot)

# MinBytes 只抓「明顯不對」的情況（0 byte、下載中斷的殘檔），不做完整性驗證。
$required = @(
  @{ Path = 'electron\ffmpeg\ffmpeg.exe';      MinBytes = 50MB; Note = 'ffmpeg（固定用 gyan 的 full_build，見 docs/Electron_維護手冊.md §7——BtbN 的 gpl-shared 版會截斷多串流 MXF 音訊）' }
  @{ Path = 'electron\ffmpeg\ffprobe.exe';     MinBytes = 50MB; Note = 'ffprobe（與 ffmpeg 同一份 gyan full_build 內附）' }
  @{ Path = 'electron\mpv\mpv.exe';            MinBytes = 20MB; Note = 'mpv.exe（官方 Windows build，供秒開播放使用）' }
  @{ Path = 'electron\mpv\d3dcompiler_43.dll'; MinBytes = 1MB;  Note = 'd3dcompiler_43.dll（mpv 官方包同時附帶）' }
)

$missing = [System.Collections.Generic.List[string]]::new()

foreach ($item in $required) {
  $full = Join-Path $RepositoryRoot $item.Path
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
    $missing.Add("缺少 $($item.Path) —— $($item.Note)")
    continue
  }
  $size = (Get-Item -LiteralPath $full).Length
  if ($size -lt $item.MinBytes) {
    $missing.Add("$($item.Path) 只有 $size bytes，看起來是損毀或未下載完整的殘檔 —— $($item.Note)")
  }
}

if ($missing.Count -gt 0) {
  Write-Error (
    "找不到打包必須的內建執行檔，npm run dist 會靜默做出功能殘缺的安裝檔：`n- " +
    ($missing -join "`n- ") +
    "`n`nelectron/ffmpeg/ 與 electron/mpv/ 刻意不進版控（見 .gitignore），" +
    "需要在每台要發版的機器上手動放置。取得方式與版本要求見 " +
    "docs/Electron_維護手冊.md §4「ffmpeg / ffprobe 整合」與 §7「常見問題排查」。"
  )
  exit 1
}

Write-Output '內建執行檔核對通過：electron/ffmpeg/ 與 electron/mpv/ 皆存在且大小正常。'
