# Create a desktop shortcut for Hai Launchpad.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools\create-shortcut.ps1
# NOTE: keep this file pure ASCII - Windows PowerShell 5.1 reads .ps1 as ANSI.

param(
  [string]$Target = "",
  [string]$Icon = "",
  [string]$Name = "Hai Launchpad"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$exe = $Target
if (-not $exe) {
  $portable = Join-Path $root "dist\Hai-Launchpad-win32-x64\Hai Launchpad.exe"
  $dev = Join-Path $root "node_modules\electron\dist\electron.exe"
  if (Test-Path $portable) { $exe = $portable } else { $exe = $dev }
}
if (-not (Test-Path $exe)) { throw ("target not found: " + $exe) }

$iconPath = $Icon
if (-not $iconPath) { $iconPath = Join-Path $root "assets\icon.ico" }
$icon = $iconPath
$isDev = $exe -like "*node_modules\electron\dist*"
$workdir = if ($isDev) { $root } else { Split-Path -Parent $exe }
$argLine = if ($isDev) { ('"' + $root + '" --no-sandbox') } else { "" }

$desktop = [Environment]::GetFolderPath("Desktop")
$lnkPath = Join-Path $desktop ($Name + ".lnk")
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = $exe
if ($argLine) { $lnk.Arguments = $argLine }
$lnk.WorkingDirectory = $workdir
$lnk.IconLocation = $icon
$lnk.Description = "Hai Launchpad - Windows Launchpad"
$lnk.WindowStyle = 7
$lnk.Save()
Write-Output ("shortcut created: " + $lnkPath)
Write-Output ("target: " + $exe)
