<#
  pi-winshot capture.ps1
  Modes:
    -Mode full                                    full virtual desktop
    -Mode region   -X N -Y N -W N -H N            screen coordinates region
    -Mode monitor  -Monitor N                     by monitor index (0-based)
    -Mode active                                  current foreground window
    -Mode window   -Title "<substring>"           window by title substring (PrintWindow; works for occluded)
  Common:
    -Out  <path>                                  output PNG (default: C:\tmp\winshot.png)
    -BringToFront                                 restore + foreground before capture (window/active)
    -Json                                         emit JSON result line
#>
[CmdletBinding()]
param(
  [ValidateSet('full','region','monitor','active','window')]
  [string]$Mode = 'full',
  [int]$X = 0, [int]$Y = 0, [int]$W = 0, [int]$H = 0,
  [int]$Monitor = -1,
  [string]$Title = "",
  [string]$Out = "C:\tmp\winshot.png",
  [switch]$BringToFront,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\lib.ps1"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Ensure-Dir $Out
$rx = 0; $ry = 0; $rw = 0; $rh = 0
$method = "BitBlt"
$matchedTitle = $null

switch ($Mode) {
  'full' {
    $vb = Get-VirtualScreenBounds
    $rx = $vb.X; $ry = $vb.Y; $rw = $vb.W; $rh = $vb.H
  }
  'region' {
    if ($W -le 0 -or $H -le 0) { throw "region mode requires -W and -H > 0" }
    $rx = $X; $ry = $Y; $rw = $W; $rh = $H
  }
  'monitor' {
    $screens = [System.Windows.Forms.Screen]::AllScreens
    if ($Monitor -lt 0 -or $Monitor -ge $screens.Count) {
      throw "monitor index $Monitor out of range (0..$($screens.Count - 1))"
    }
    $b = $screens[$Monitor].Bounds
    $rx = $b.X; $ry = $b.Y; $rw = $b.Width; $rh = $b.Height
  }
  'active' {
    $h = [WinShotNative]::GetForegroundWindow()
    if ($h -eq [IntPtr]::Zero) { throw "no foreground window" }
    if ($BringToFront) {
      [void][WinShotNative]::ShowWindow($h, 9)
      [void][WinShotNative]::SetForegroundWindow($h)
      Start-Sleep -Milliseconds 200
    }
    $r = Get-WindowRectDwm $h
    $rx = $r.Left; $ry = $r.Top; $rw = $r.Right - $r.Left; $rh = $r.Bottom - $r.Top
  }
  'window' {
    if (-not $Title) { throw "window mode requires -Title" }
    $wins = Get-WindowList
    $match = $wins | Where-Object { $_.Title -like "*$Title*" } | Select-Object -First 1
    if (-not $match) { throw "no visible window matches: $Title" }
    $matchedTitle = $match.Title
    $hWnd = $match.Handle

    if ($BringToFront -or $match.Minimized) {
      [void][WinShotNative]::ShowWindow($hWnd, 9)
      [void][WinShotNative]::SetForegroundWindow($hWnd)
      Start-Sleep -Milliseconds 250
    }

    $r = Get-WindowRectDwm $hWnd
    $rw = $r.Right - $r.Left; $rh = $r.Bottom - $r.Top
    $rx = $r.Left; $ry = $r.Top
    if ($rw -le 0 -or $rh -le 0) { throw "window has zero size (minimized?)" }

    # PrintWindow w/ PW_RENDERFULLCONTENT (0x2) - captures occluded windows incl. Chrome/Edge
    $bmp = New-Object System.Drawing.Bitmap $rw, $rh
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    $ok = [WinShotNative]::PrintWindow($hWnd, $hdc, 0x2)
    $g.ReleaseHdc($hdc); $g.Dispose()
    if (-not $ok) { Write-Warning "PrintWindow returned false (may be partially blank)" }
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $method = "PrintWindow"
  }
}

if ($Mode -ne 'window') {
  if ($rw -le 0 -or $rh -le 0) { throw "computed region is empty: ${rw}x${rh}" }
  $bmp = New-Object System.Drawing.Bitmap $rw, $rh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($rx, $ry, 0, 0, (New-Object System.Drawing.Size $rw, $rh))
  $g.Dispose()
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

$result = [pscustomobject]@{
  ok      = $true
  mode    = $Mode
  method  = $method
  x       = $rx; y = $ry; w = $rw; h = $rh
  out     = $Out
  title   = $matchedTitle
}

if ($Json) { Write-Output (Write-Json $result) }
else { Write-Host ("OK mode={0} method={1} x={2} y={3} w={4} h={5} out={6}" -f $Mode, $method, $rx, $ry, $rw, $rh, $Out) }
