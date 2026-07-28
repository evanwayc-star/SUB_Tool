[CmdletBinding()]
param(
  [string]$RepositoryRoot = '',
  [string]$ProductName = 'SUB Tool'
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
  $RepositoryRoot = Join-Path $PSScriptRoot '..'
}

function Normalize-PathForComparison([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  return [IO.Path]::GetFullPath($Path.Replace('/', '\')).TrimEnd('\')
}

function Test-PathInside([string]$Candidate, [string]$Parent) {
  $normalizedCandidate = Normalize-PathForComparison $Candidate
  if (-not $normalizedCandidate) { return $false }

  return $normalizedCandidate.Equals($Parent, [StringComparison]::OrdinalIgnoreCase) -or
    $normalizedCandidate.StartsWith("$Parent\", [StringComparison]::OrdinalIgnoreCase)
}

$repository = Normalize-PathForComparison $RepositoryRoot
$uninstallRoots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
$shortcutRoots = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

$violations = [System.Collections.Generic.List[string]]::new()

foreach ($root in $uninstallRoots) {
  if (-not (Test-Path -LiteralPath $root)) { continue }

  Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | ForEach-Object {
    $entry = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
    if ($entry.DisplayName -notlike "$ProductName*") { return }

    foreach ($field in 'InstallLocation', 'DisplayIcon', 'UninstallString', 'QuietUninstallString') {
      $value = [string]$entry.$field
      if ($value -and $value.IndexOf($repository, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        $violations.Add("解除安裝資訊 $($_.PSChildName) 的 $field 指向原始碼目錄：$value")
      }
    }
  }
}

$shell = New-Object -ComObject WScript.Shell
foreach ($root in $shortcutRoots) {
  Get-ChildItem -LiteralPath $root -Filter "$ProductName*.lnk" -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    $target = $shell.CreateShortcut($_.FullName).TargetPath
    if (Test-PathInside $target $repository) {
      $violations.Add("捷徑 $($_.FullName) 指向原始碼目錄：$target")
    }
  }
}

if ($violations.Count -gt 0) {
  Write-Error ("發版安裝安全檢查失敗：`n- " + ($violations -join "`n- ") + "`n不可用正式 NSIS 安裝器的 /D 參數安裝到原始碼工作區；請以正規解除安裝修復後再發布。")
  exit 1
}

Write-Output "發版安裝安全檢查通過：沒有 $ProductName 安裝資訊或捷徑指向原始碼目錄。"
