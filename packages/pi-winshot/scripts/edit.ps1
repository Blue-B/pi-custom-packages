<#
  pi-winshot edit.ps1
  Operations (one per invocation):
    -Op crop     -X N -Y N -W N -H N
    -Op mask     -Regions "x,y,w,h[;x,y,w,h;...]"  [-MaskStyle black|blur|pixelate] [-Pixel N] [-BlurRadius N]
    -Op resize   [-MaxW N] [-MaxH N] [-Scale F]    keeps aspect; provide one of these
    -Op info                                       prints dimensions of input
  Common:
    -In  <path>   (default: C:\tmp\winshot.png)
    -Out <path>   (default: same as -In, or C:\tmp\winshot_edited.png if -Op info)
    -Json
#>
[CmdletBinding()]
param(
  [ValidateSet('crop','mask','resize','info')]
  [string]$Op = 'info',
  [string]$In = "C:\tmp\winshot.png",
  [string]$Out = "",
  [int]$X = 0, [int]$Y = 0, [int]$W = 0, [int]$H = 0,
  [string]$Regions = "",
  [ValidateSet('black','blur','pixelate')]
  [string]$MaskStyle = 'black',
  [int]$Pixel = 16,
  [int]$BlurRadius = 12,
  [int]$MaxW = 0,
  [int]$MaxH = 0,
  [double]$Scale = 0,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\lib.ps1"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not (Test-Path $In)) { throw "input not found: $In" }
if (-not $Out) { $Out = if ($Op -eq 'info') { $In } else { $In } }
Ensure-Dir $Out

$src = [System.Drawing.Image]::FromFile($In)
try {
  $srcW = $src.Width; $srcH = $src.Height

  function Save-And-Dispose($bmp) {
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  }

  function Clamp-Rect([int]$x, [int]$y, [int]$w, [int]$h, [int]$imgW, [int]$imgH) {
    if ($x -lt 0) { $w += $x; $x = 0 }
    if ($y -lt 0) { $h += $y; $y = 0 }
    if ($x + $w -gt $imgW) { $w = $imgW - $x }
    if ($y + $h -gt $imgH) { $h = $imgH - $y }
    return ,@($x, $y, $w, $h)
  }

  function Apply-Pixelate($g, [int]$rx, [int]$ry, [int]$rw, [int]$rh, [int]$block) {
    if ($block -lt 2) { $block = 2 }
    $tinyW = [math]::Max(1, [int]($rw / $block))
    $tinyH = [math]::Max(1, [int]($rh / $block))
    $tiny = New-Object System.Drawing.Bitmap $tinyW, $tinyH
    $tg = [System.Drawing.Graphics]::FromImage($tiny)
    $tg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
    $tg.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $tinyW, $tinyH),
                  $rx, $ry, $rw, $rh, [System.Drawing.GraphicsUnit]::Pixel)
    $tg.Dispose()
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    $g.DrawImage($tiny, (New-Object System.Drawing.Rectangle $rx, $ry, $rw, $rh),
                 0, 0, $tinyW, $tinyH, [System.Drawing.GraphicsUnit]::Pixel)
    $tiny.Dispose()
  }

  function Apply-Blur($g, [int]$rx, [int]$ry, [int]$rw, [int]$rh, [int]$radius) {
    # Cheap box-blur via two-step downscale/upscale (fast, dependency-free, good enough for masking)
    if ($radius -lt 2) { $radius = 2 }
    $factor = [math]::Max(2, [int]($radius / 2))
    $smallW = [math]::Max(1, [int]($rw / $factor))
    $smallH = [math]::Max(1, [int]($rh / $factor))
    $small = New-Object System.Drawing.Bitmap $smallW, $smallH
    $sg = [System.Drawing.Graphics]::FromImage($small)
    $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $sg.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $smallW, $smallH),
                  $rx, $ry, $rw, $rh, [System.Drawing.GraphicsUnit]::Pixel)
    $sg.Dispose()
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($small, (New-Object System.Drawing.Rectangle $rx, $ry, $rw, $rh),
                 0, 0, $smallW, $smallH, [System.Drawing.GraphicsUnit]::Pixel)
    $small.Dispose()
  }

  switch ($Op) {
    'info' {
      $result = [pscustomobject]@{ ok=$true; op='info'; in=$In; w=$srcW; h=$srcH }
      if ($Json) { Write-Output (Write-Json $result) }
      else { Write-Host ("OK info w={0} h={1} in={2}" -f $srcW, $srcH, $In) }
      return
    }

    'crop' {
      if ($W -le 0 -or $H -le 0) { throw "crop requires -W and -H > 0" }
      $c = Clamp-Rect $X $Y $W $H $srcW $srcH
      $cx = $c[0]; $cy = $c[1]; $cw = $c[2]; $ch = $c[3]
      if ($cw -le 0 -or $ch -le 0) { throw "crop region is fully outside image" }
      $bmp = New-Object System.Drawing.Bitmap $cw, $ch
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $cw, $ch),
                   $cx, $cy, $cw, $ch, [System.Drawing.GraphicsUnit]::Pixel)
      $g.Dispose()
      Save-And-Dispose $bmp
      $result = [pscustomobject]@{ ok=$true; op='crop'; x=$cx; y=$cy; w=$cw; h=$ch; out=$Out }
    }

    'mask' {
      if (-not $Regions) { throw "mask requires -Regions 'x,y,w,h;x,y,w,h'" }
      $bmp = New-Object System.Drawing.Bitmap $srcW, $srcH
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.DrawImage($src, 0, 0, $srcW, $srcH)
      $rects = @()
      foreach ($spec in $Regions -split ';') {
        $spec = $spec.Trim()
        if (-not $spec) { continue }
        $parts = $spec -split ','
        if ($parts.Count -ne 4) { throw "bad region '$spec' (expect x,y,w,h)" }
        $rx = [int]$parts[0]; $ry = [int]$parts[1]; $rw = [int]$parts[2]; $rh = [int]$parts[3]
        $c = Clamp-Rect $rx $ry $rw $rh $srcW $srcH
        if ($c[2] -le 0 -or $c[3] -le 0) { continue }
        $rects += ,@($c[0], $c[1], $c[2], $c[3])
        switch ($MaskStyle) {
          'black' {
            $brush = [System.Drawing.Brushes]::Black
            $g.FillRectangle($brush, $c[0], $c[1], $c[2], $c[3])
          }
          'pixelate' { Apply-Pixelate $g $c[0] $c[1] $c[2] $c[3] $Pixel }
          'blur'     { Apply-Blur     $g $c[0] $c[1] $c[2] $c[3] $BlurRadius }
        }
      }
      $g.Dispose()
      Save-And-Dispose $bmp
      $result = [pscustomobject]@{ ok=$true; op='mask'; style=$MaskStyle; count=$rects.Count; out=$Out }
    }

    'resize' {
      $nw = $srcW; $nh = $srcH
      if ($Scale -gt 0) {
        $nw = [int]($srcW * $Scale); $nh = [int]($srcH * $Scale)
      } elseif ($MaxW -gt 0 -or $MaxH -gt 0) {
        $rW = if ($MaxW -gt 0) { $MaxW / [double]$srcW } else { [double]::MaxValue }
        $rH = if ($MaxH -gt 0) { $MaxH / [double]$srcH } else { [double]::MaxValue }
        $r = [math]::Min($rW, $rH)
        if ($r -le 0 -or $r -ge [double]::MaxValue) { throw "resize needs -Scale, -MaxW, or -MaxH" }
        $nw = [int]($srcW * $r); $nh = [int]($srcH * $r)
      } else {
        throw "resize requires -Scale or -MaxW/-MaxH"
      }
      if ($nw -lt 1) { $nw = 1 }; if ($nh -lt 1) { $nh = 1 }
      $bmp = New-Object System.Drawing.Bitmap $nw, $nh
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.DrawImage($src, 0, 0, $nw, $nh)
      $g.Dispose()
      Save-And-Dispose $bmp
      $result = [pscustomobject]@{ ok=$true; op='resize'; from_w=$srcW; from_h=$srcH; w=$nw; h=$nh; out=$Out }
    }
  }

  if ($Json) { Write-Output (Write-Json $result) }
  else { Write-Host ("OK " + ($result | Out-String).Trim()) }
}
finally {
  $src.Dispose()
}
