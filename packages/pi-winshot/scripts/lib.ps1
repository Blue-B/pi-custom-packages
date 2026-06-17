# Shared helpers and Win32 P/Invoke for pi-winshot.
# Dot-source this file: . "$PSScriptRoot\lib.ps1"

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

if (-not ("WinShotNative" -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class WinShotNative {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("dwmapi.dll")]
  public static extern int DwmGetWindowAttribute(IntPtr hWnd, int dwAttr, out RECT pvAttr, int cbAttr);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
}

function Get-WindowList {
  $list = New-Object System.Collections.ArrayList
  $cb = [WinShotNative+EnumProc]{
    param($h, $l)
    if (-not [WinShotNative]::IsWindowVisible($h)) { return $true }
    $len = [WinShotNative]::GetWindowTextLength($h)
    if ($len -le 0) { return $true }
    $sb = New-Object System.Text.StringBuilder ($len + 2)
    [void][WinShotNative]::GetWindowText($h, $sb, $sb.Capacity)
    $t = $sb.ToString()
    if ([string]::IsNullOrWhiteSpace($t)) { return $true }
    $r = New-Object WinShotNative+RECT
    [void][WinShotNative]::GetWindowRect($h, [ref]$r)
    $w = $r.Right - $r.Left; $hgt = $r.Bottom - $r.Top
    if ($w -lt 50 -or $hgt -lt 50) { return $true }
    [void]$list.Add([pscustomobject]@{
      Handle = $h
      Title  = $t
      X = $r.Left; Y = $r.Top; W = $w; H = $hgt
      Minimized = [WinShotNative]::IsIconic($h)
    })
    return $true
  }
  [void][WinShotNative]::EnumWindows($cb, [IntPtr]::Zero)
  return $list
}

function Get-WindowRectDwm {
  param([IntPtr]$Handle)
  $r = New-Object WinShotNative+RECT
  $size = [System.Runtime.InteropServices.Marshal]::SizeOf([type][WinShotNative+RECT])
  # DWMWA_EXTENDED_FRAME_BOUNDS = 9 (excludes invisible drop-shadow border)
  $res = [WinShotNative]::DwmGetWindowAttribute($Handle, 9, [ref]$r, $size)
  if ($res -ne 0) {
    [void][WinShotNative]::GetWindowRect($Handle, [ref]$r)
  }
  return $r
}

function Ensure-Dir {
  param([string]$Path)
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
}

function Get-VirtualScreenBounds {
  $screens = [System.Windows.Forms.Screen]::AllScreens
  $minX = 0; $minY = 0; $maxR = 0; $maxB = 0
  $first = $true
  foreach ($s in $screens) {
    $b = $s.Bounds
    if ($first) {
      $minX = $b.X; $minY = $b.Y; $maxR = $b.X + $b.Width; $maxB = $b.Y + $b.Height
      $first = $false
    } else {
      if ($b.X -lt $minX) { $minX = $b.X }
      if ($b.Y -lt $minY) { $minY = $b.Y }
      if (($b.X + $b.Width)  -gt $maxR) { $maxR = $b.X + $b.Width }
      if (($b.Y + $b.Height) -gt $maxB) { $maxB = $b.Y + $b.Height }
    }
  }
  return [pscustomobject]@{ X=$minX; Y=$minY; W=($maxR-$minX); H=($maxB-$minY) }
}

function Write-Json {
  param($Object)
  ($Object | ConvertTo-Json -Compress -Depth 6)
}
