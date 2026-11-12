# Capture the DESKTOP LAYER (wallpaper incl. Wallpaper Engine) by PrintWindow on Progman.
# Outputs JSON: {"left":..,"top":..,"width":..,"height":..,"path":".."}
param(
  [Parameter(Mandatory = $true)][string]$Out
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DeskCap {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
}
"@ -ReferencedAssemblies System.Drawing

[void][DeskCap]::SetProcessDPIAware()

$script:progman = [IntPtr]::Zero
$cb = [DeskCap+EnumProc]{
  param($h, $p)
  $cls = New-Object System.Text.StringBuilder 256
  [void][DeskCap]::GetClassName($h, $cls, 256)
  if ($cls.ToString() -eq 'Progman') { $script:progman = $h; return $false }
  return $true
}
[void][DeskCap]::EnumWindows($cb, [IntPtr]::Zero)

if ($script:progman -eq [IntPtr]::Zero) {
  Write-Output '{"error":"no-progman"}'
  exit 2
}

$r = New-Object DeskCap+RECT
[void][DeskCap]::GetWindowRect($script:progman, [ref]$r)
$w = $r.right - $r.left
$h = $r.bottom - $r.top
if ($w -le 0 -or $h -le 0) {
  Write-Output '{"error":"bad-rect"}'
  exit 3
}

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [DeskCap]::PrintWindow($script:progman, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Output ("{`"left`":" + $r.left + ",`"top`":" + $r.top + ",`"width`":" + $w + ",`"height`":" + $h + ",`"ok`":" + ($ok.ToString().ToLower()) + ",`"path`":`"" + $Out.Replace('\', '\\') + "`"}")
