<#
  pi-winshot list.ps1
    -What windows | monitors
    -Json
#>
[CmdletBinding()]
param(
  [ValidateSet('windows','monitors')]
  [string]$What = 'windows',
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\lib.ps1"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if ($What -eq 'windows') {
  $wins = Get-WindowList | ForEach-Object {
    [pscustomobject]@{
      handle    = ("0x{0:X8}" -f $_.Handle.ToInt64())
      title     = $_.Title
      x = $_.X; y = $_.Y; w = $_.W; h = $_.H
      minimized = $_.Minimized
    }
  }
  if ($Json) { Write-Output ($wins | ConvertTo-Json -Compress -Depth 4) }
  else {
    foreach ($w in $wins) {
      $tag = if ($w.minimized) { '[min]' } else { '     ' }
      Write-Host ("{0} {1}  {2,5}x{3,-5}  {4}" -f $w.handle, $tag, $w.w, $w.h, $w.title)
    }
  }
} else {
  $screens = [System.Windows.Forms.Screen]::AllScreens
  $arr = @()
  for ($i = 0; $i -lt $screens.Count; $i++) {
    $b = $screens[$i].Bounds
    $arr += [pscustomobject]@{
      index = $i
      primary = $screens[$i].Primary
      x = $b.X; y = $b.Y; w = $b.Width; h = $b.Height
      name = $screens[$i].DeviceName
    }
  }
  if ($Json) { Write-Output ($arr | ConvertTo-Json -Compress -Depth 4) }
  else {
    foreach ($m in $arr) {
      Write-Host ("monitor[{0}] primary={1} x={2} y={3} w={4} h={5} name={6}" -f $m.index, $m.primary, $m.x, $m.y, $m.w, $m.h, $m.name)
    }
  }
}
