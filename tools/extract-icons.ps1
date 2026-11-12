param(
  [Parameter(Mandatory=$true)][string]$ListPath
)
# Extract crisp, well-proportioned icons for a list of shell items.
# Input JSON:  [{ "path": "C:\\...\\foo.lnk", "out": "C:\\cache\\abc.png" }, ...]
# Output JSON: { "ok": {"<path>": "<out>"}, "fail": {"<path>": "reason"} }
#
# Strategy (per item):
#   1. Ask the shell for the item's jumbo icon (SHCreateItemFromParsingName +
#      IShellItemImageFactory) - this is what Explorer/Flare use, and it is the
#      sharpest source available.
#   2. Also extract via PrivateExtractIcons from the resolved icon location.
#   3. Reject a shell result that turns out to be the generic "unknown file"
#      icon, then keep whichever candidate is sharper.
#   4. Trim the transparent margin and rescale so the artwork's longest side is
#      ~92% of the canvas (avoids icons that look tiny/blurry inside the tile).
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Add-Type compiles to %TEMP%; in restricted environments %TEMP% may be denied.
$tmpDir = Join-Path (Split-Path -Parent $ListPath) 'pwsh-tmp'
try {
  if (-not (Test-Path -LiteralPath $tmpDir)) { New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null }
  $env:TEMP = $tmpDir
  $env:TMP = $tmpDir
} catch { }

Add-Type -AssemblyName System.Drawing

$code = @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class IconX {
  [StructLayout(LayoutKind.Sequential)]
  public struct SIZE { public int cx; public int cy; public SIZE(int x, int y) { cx = x; cy = y; } }

  [Flags]
  public enum SIIGBF : uint {
    RESIZETOFIT = 0x00, BIGGERSIZEOK = 0x01, MEMORYONLY = 0x02, ICONONLY = 0x04,
    THUMBNAILONLY = 0x08, INCACHEONLY = 0x10, CROPTOSQUARE = 0x20,
    WIDETHUMBNAILS = 0x40, ICONBACKGROUND = 0x80, SCALEUP = 0x100
  }

  [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItemImageFactory {
    [PreserveSig] int GetImage(SIZE size, SIIGBF flags, out IntPtr phbm);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid,
    [MarshalAs(UnmanagedType.Interface)] out object ppv);

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern int PrivateExtractIconsW(string lpszFile, int nIconIndex, int cxIcon, int cyIcon,
    IntPtr[] phicon, int[] piconid, int nIcons, int flags);

  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int ExtractIconEx(string lpszFile, int nIconIndex, IntPtr[] phiconLarge, IntPtr[] phiconSmall, int nIcons);

  [DllImport("user32.dll", SetLastError = true)]
  static extern bool DestroyIcon(IntPtr hIcon);

  [StructLayout(LayoutKind.Sequential)]
  struct BITMAP { public int bmType; public int bmWidth; public int bmHeight; public int bmWidthBytes; public ushort bmPlanes; public ushort bmBitsPixel; public IntPtr bmBits; }

  [StructLayout(LayoutKind.Sequential)]
  struct BITMAPINFOHEADER {
    public uint biSize; public int biWidth; public int biHeight; public ushort biPlanes; public ushort biBitCount;
    public uint biCompression; public uint biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter;
    public uint biClrUsed; public uint biClrImportant;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct BITMAPINFO { public BITMAPINFOHEADER bmiHeader; public uint bmiColors0; }

  [DllImport("gdi32.dll")] static extern int GetObject(IntPtr h, int c, ref BITMAP pv);
  [DllImport("gdi32.dll")] static extern int GetDIBits(IntPtr hdc, IntPtr hbm, uint start, uint lines, IntPtr bits, ref BITMAPINFO bmi, uint usage);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);

  static Bitmap FromHBitmap(IntPtr hbm) {
    BITMAP bm = new BITMAP();
    GetObject(hbm, Marshal.SizeOf(typeof(BITMAP)), ref bm);
    int w = bm.bmWidth, h = bm.bmHeight;
    Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    BitmapData bd = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
    BITMAPINFO bi = new BITMAPINFO();
    bi.bmiHeader.biSize = (uint)Marshal.SizeOf(typeof(BITMAPINFOHEADER));
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -h;
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = 0;
    IntPtr hdc = GetDC(IntPtr.Zero);
    GetDIBits(hdc, hbm, 0, (uint)h, bd.Scan0, ref bi, 0);
    ReleaseDC(IntPtr.Zero, hdc);
    bmp.UnlockBits(bd);
    return bmp;
  }

  // Shell jumbo icon for any shell item (.lnk, .url, folder, exe...).
  public static Bitmap FromShell(string path, int size) {
    try {
      Guid iid = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");
      object o;
      SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out o);
      IShellItemImageFactory f = (IShellItemImageFactory)o;
      IntPtr hbm;
      int hr = f.GetImage(new SIZE(size, size), SIIGBF.BIGGERSIZEOK | SIIGBF.ICONONLY, out hbm);
      if (hr != 0 || hbm == IntPtr.Zero) return null;
      try { return FromHBitmap(hbm); } finally { DeleteObject(hbm); }
    } catch { return null; }
  }

  static Bitmap RenderIcon(IntPtr hicon, int size) {
    if (hicon == IntPtr.Zero) return null;
    Icon icon = Icon.FromHandle(hicon);
    Bitmap bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
    Graphics g = Graphics.FromImage(bmp);
    try {
      g.Clear(Color.Transparent);
      g.InterpolationMode = InterpolationMode.HighQualityBicubic;
      g.SmoothingMode = SmoothingMode.HighQuality;
      g.PixelOffsetMode = PixelOffsetMode.HighQuality;
      g.CompositingQuality = CompositingQuality.HighQuality;
      g.DrawIcon(icon, new Rectangle(0, 0, size, size));
    } finally { g.Dispose(); }
    return bmp;
  }

  // Icon resource extraction (exe/dll/ico + index).
  public static Bitmap FromResource(string file, int index, int size) {
    IntPtr[] h = new IntPtr[1];
    int[] ids = new int[1];
    int n = 0;
    try { n = PrivateExtractIconsW(file, index, size, size, h, ids, 1, 0); } catch { n = 0; }
    if (n > 0 && h[0] != IntPtr.Zero) {
      Bitmap b = RenderIcon(h[0], size);
      try { DestroyIcon(h[0]); } catch { }
      if (b != null) return b;
    }
    IntPtr[] large = new IntPtr[1];
    IntPtr[] small = new IntPtr[1];
    int cnt = 0;
    try { cnt = ExtractIconEx(file, index, large, small, 1); } catch { cnt = 0; }
    if (cnt > 0) {
      IntPtr pick = large[0] != IntPtr.Zero ? large[0] : small[0];
      Bitmap b = RenderIcon(pick, size);
      if (large[0] != IntPtr.Zero) { try { DestroyIcon(large[0]); } catch { } }
      if (small[0] != IntPtr.Zero) { try { DestroyIcon(small[0]); } catch { } }
      return b;
    }
    return null;
  }

  // Alpha bounding box of drawn content.
  static Rectangle ContentBox(Bitmap src) {
    Rectangle rect = new Rectangle(0, 0, src.Width, src.Height);
    BitmapData bd = src.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    int minX = src.Width, minY = src.Height, maxX = -1, maxY = -1;
    try {
      int stride = bd.Stride;
      byte[] row = new byte[stride];
      for (int y = 0; y < src.Height; y++) {
        Marshal.Copy(new IntPtr(bd.Scan0.ToInt64() + (long)y * stride), row, 0, stride);
        for (int x = 0; x < src.Width; x++) {
          if (row[x * 4 + 3] > 96) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
    } finally { src.UnlockBits(bd); }
    if (maxX < 0) return Rectangle.Empty;
    return new Rectangle(minX, minY, maxX - minX + 1, maxY - minY + 1);
  }

  // Trim transparent margin; scale so the longest side is fill*size; center.
  public static Bitmap Normalize(Bitmap src, int size, double fill) {
    if (src == null) return null;
    Rectangle box = ContentBox(src);
    if (!box.IsEmpty) {
      // keep a 2px safety ring so soft edges / glows are not clipped away
      int pad = 2;
      int x0 = Math.Max(0, box.Left - pad);
      int y0 = Math.Max(0, box.Top - pad);
      int x1 = Math.Min(src.Width - 1, box.Right + pad - 1);
      int y1 = Math.Min(src.Height - 1, box.Bottom + pad - 1);
      box = Rectangle.FromLTRB(x0, y0, x1 + 1, y1 + 1);
    }
    Bitmap canvas = new Bitmap(size, size, PixelFormat.Format32bppArgb);
    Graphics g = Graphics.FromImage(canvas);
    try {
      g.Clear(Color.Transparent);
      g.InterpolationMode = InterpolationMode.HighQualityBicubic;
      g.SmoothingMode = SmoothingMode.HighQuality;
      g.PixelOffsetMode = PixelOffsetMode.HighQuality;
      g.CompositingQuality = CompositingQuality.HighQuality;
      if (box.IsEmpty) {
        g.DrawImage(src, new Rectangle(0, 0, size, size));
        return canvas;
      }
      double target = size * fill;
      double scale = Math.Min(target / box.Width, target / box.Height);
      int dw = Math.Max(1, (int)Math.Round(box.Width * scale));
      int dh = Math.Max(1, (int)Math.Round(box.Height * scale));
      int dx = (size - dw) / 2;
      int dy = (size - dh) / 2;
      g.DrawImage(src, new Rectangle(dx, dy, dw, dh), box, GraphicsUnit.Pixel);
    } finally { g.Dispose(); }
    return canvas;
  }

  static Bitmap Sample(Bitmap src, int n) {
    Bitmap small = new Bitmap(n, n, PixelFormat.Format32bppArgb);
    Graphics g = Graphics.FromImage(small);
    try {
      g.Clear(Color.Transparent);
      g.InterpolationMode = InterpolationMode.HighQualityBilinear;
      g.DrawImage(src, new Rectangle(0, 0, n, n));
    } finally { g.Dispose(); }
    return small;
  }

  // Laplacian variance over a 64x64 grey sample: higher = crisper.
  public static double Sharpness(Bitmap src) {
    if (src == null) return 0;
    int n = 64;
    Bitmap s = Sample(src, n);
    double sum = 0, sum2 = 0;
    int count = 0;
    try {
      for (int y = 1; y < n - 1; y++) {
        for (int x = 1; x < n - 1; x++) {
          double c = Grey(s.GetPixel(x, y));
          double lap = 4 * c - Grey(s.GetPixel(x - 1, y)) - Grey(s.GetPixel(x + 1, y))
                     - Grey(s.GetPixel(x, y - 1)) - Grey(s.GetPixel(x, y + 1));
          sum += lap; sum2 += lap * lap; count++;
        }
      }
    } finally { s.Dispose(); }
    if (count == 0) return 0;
    double mean = sum / count;
    return sum2 / count - mean * mean;
  }

  static double Grey(Color c) { return (c.R * 0.299 + c.G * 0.587 + c.B * 0.114) * (c.A / 255.0); }

  // Mean absolute difference of two icons over a dark background (0..255).
  public static double Diff(Bitmap a, Bitmap b) {
    if (a == null || b == null) return 255;
    int n = 24;
    Bitmap sa = Sample(a, n), sb = Sample(b, n);
    double total = 0;
    try {
      for (int y = 0; y < n; y++) {
        for (int x = 0; x < n; x++) {
          Color ca = sa.GetPixel(x, y), cb = sb.GetPixel(x, y);
          total += Math.Abs(ca.R - cb.R) + Math.Abs(ca.G - cb.G) + Math.Abs(ca.B - cb.B);
        }
      }
    } finally { sa.Dispose(); sb.Dispose(); }
    return total / (n * n * 3.0);
  }

  static Bitmap genericRef;

  // The shell's generic "unknown file" icon, used to reject bogus results.
  public static Bitmap GenericReference(string probeLnk) {
    if (genericRef != null) return genericRef;
    if (probeLnk != null && probeLnk.Length > 0) genericRef = FromShell(probeLnk, 256);
    return genericRef;
  }

  // Pick the best icon for an item and normalise it.
  // preferResource: the shortcut carries an explicit icon location, so honour it.
  public static Bitmap Extract(string itemPath, string resFile, int resIndex, int size,
                               string probeFile, bool preferResource) {
    Bitmap shell = FromShell(itemPath, size);
    Bitmap res = null;
    if (resFile != null && resFile.Length > 0) res = FromResource(resFile, resIndex, size);

    Bitmap generic = GenericReference(probeFile);
    if (shell != null && generic != null && Diff(shell, generic) < 6.0) {
      shell.Dispose();
      shell = null;
    }

    // An explicit icon location is honoured only when it is not visibly worse
    // than the shell result: some .ico files are tiny and blow up blurry.
    Bitmap pick;
    if (shell == null) pick = res;
    else if (res == null) pick = shell;
    else {
      double ss = Sharpness(shell), rs = Sharpness(res);
      pick = preferResource ? ((rs >= ss * 0.98) ? res : shell)
                            : ((ss >= rs * 1.02) ? shell : res);
    }
    if (pick == null) return null;
    Bitmap norm = Normalize(pick, size, 0.98);
    if (!object.ReferenceEquals(pick, norm)) pick.Dispose();
    if (shell != null && !object.ReferenceEquals(shell, pick)) shell.Dispose();
    if (res != null && !object.ReferenceEquals(res, pick)) res.Dispose();
    return norm;
  }
}
"@
Add-Type -TypeDefinition $code -Language CSharp -ReferencedAssemblies System.Drawing

$items = Get-Content -Raw -Encoding UTF8 -Path $ListPath | ConvertFrom-Json
$ok = @{}
$fail = @{}
$wshell = $null

function Get-Shell {
  if ($null -eq $script:wshell) { $script:wshell = New-Object -ComObject WScript.Shell }
  return $script:wshell
}

function Split-IconLocation([string]$loc) {
  $r = @{ file = $null; index = 0 }
  if ([string]::IsNullOrWhiteSpace($loc)) { return $r }
  $loc = $loc.Trim().Trim('"')
  $m = [regex]::Match($loc, '^(.*?),\s*(-?\d+)\s*$')
  if ($m.Success) {
    $r.file = $m.Groups[1].Value
    $r.index = [int]$m.Groups[2].Value
  } else {
    $r.file = $loc
    $r.index = 0
  }
  if ($r.index -lt 0) { $r.index = 0 }
  return $r
}

function Resolve-IconSource([string]$p) {
  $res = @{ file = $p; index = 0; explicit = $false }
  try {
    if ($p -match '\.lnk$') {
      $sc = (Get-Shell).CreateShortcut($p)
      $fromIcon = Split-IconLocation $sc.IconLocation
      if ($fromIcon.file) {
        $expanded = [Environment]::ExpandEnvironmentVariables($fromIcon.file)
        if (Test-Path -LiteralPath $expanded) { return @{ file = $expanded; index = $fromIcon.index; explicit = $true } }
      }
      if ($sc.TargetPath) {
        $t = [Environment]::ExpandEnvironmentVariables($sc.TargetPath)
        if (Test-Path -LiteralPath $t -PathType Container) { return @{ file = "$env:SystemRoot\System32\shell32.dll"; index = 3; explicit = $false } }
        if (Test-Path -LiteralPath $t) { return @{ file = $t; index = 0; explicit = $false } }
      }
    } elseif ($p -match '\.url$') {
      $lines = Get-Content -LiteralPath $p -ErrorAction Stop
      $iconFile = ($lines | Where-Object { $_ -match '^IconFile=' } | Select-Object -First 1)
      $iconIndex = ($lines | Where-Object { $_ -match '^IconIndex=' } | Select-Object -First 1)
      if ($iconFile) {
        $f = $iconFile.Substring(9).Trim()
        $f = [Environment]::ExpandEnvironmentVariables($f)
        if (Test-Path -LiteralPath $f) {
          $idx = 0
          if ($iconIndex) { [void][int]::TryParse($iconIndex.Substring(10).Trim(), [ref]$idx) }
          return @{ file = $f; index = $idx; explicit = $true }
        }
      }
      return @{ file = "$env:SystemRoot\System32\imageres.dll"; index = 104; explicit = $false }
    } elseif (Test-Path -LiteralPath $p -PathType Container) {
      return @{ file = "$env:SystemRoot\System32\shell32.dll"; index = 3; explicit = $false }
    }
  } catch { }
  return $res
}

# A file with an unknown extension makes the shell render its generic
# "unknown file" page icon, which we use to reject bogus shell results.
$probeFile = $null
try {
  $probeFile = Join-Path $tmpDir '__generic_probe.zzz'
  if (-not (Test-Path -LiteralPath $probeFile)) { Set-Content -LiteralPath $probeFile -Value '' -Encoding ASCII }
} catch { $probeFile = $null }

foreach ($it in $items) {
  $p = [string]$it.path
  $out = [string]$it.out
  try {
    $src = Resolve-IconSource $p
    $srcFile = $null
    if ($src.file -and (Test-Path -LiteralPath $src.file)) { $srcFile = $src.file }
    $bmp = $null
    try {
      $bmp = [IconX]::Extract($p, $srcFile, [int]$src.index, 256, $probeFile, [bool]$src.explicit)
    } catch { $bmp = $null }
    if ($null -eq $bmp) { $fail[$p] = "extract failed"; continue }
    $dir = Split-Path -Parent $out
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $ok[$p] = $out
  } catch {
    $fail[$p] = $_.Exception.Message
  }
}

try { if ($probeFile -and (Test-Path -LiteralPath $probeFile)) { Remove-Item -LiteralPath $probeFile -Force } } catch { }

$result = @{ ok = $ok; fail = $fail }
$json = $result | ConvertTo-Json -Depth 4 -Compress
[Console]::Out.Write($json)

