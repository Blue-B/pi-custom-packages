<#
.SYNOPSIS
  Install the D2Coding Regular and Bold faces as separate per-user fonts.

.DESCRIPTION
  D2Coding must be registered as two individual TTFs. Registering the combined
  D2Coding-all.ttc makes Windows unable to tell Regular from Bold apart, so a
  "weight" setting in Windows Terminal is silently ignored.

  This script:
    1. copies the TTFs into the per-user font directory
    2. removes any stale entries for this family (including a TTC registration)
    3. registers both faces by full path
    4. notifies running apps so the change is picked up

  Idempotent. Safe to re-run.

.PARAMETER FontDir
  Source directory holding D2Coding-Regular.ttf and D2Coding-Bold.ttf.
  Defaults to ../assets/fonts next to this script.

.PARAMETER NoNotify
  Skip the WM_FONTCHANGE broadcast.

.EXAMPLE
  pwsh -File register-font.ps1
  pwsh -File register-font.ps1 -FontDir 'C:\fonts'
#>
[CmdletBinding()]
param(
  [string]$FontDir,
  [switch]$NoNotify
)

$ErrorActionPreference = 'Stop'

if (-not $FontDir) {
  $FontDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'assets\fonts'
}
if (-not (Test-Path $FontDir)) {
  throw "Font directory not found: $FontDir"
}

$files = @{
  'D2Coding (TrueType)'      = 'D2Coding-Regular.ttf'
  'D2Coding Bold (TrueType)' = 'D2Coding-Bold.ttf'
}
foreach ($f in $files.Values) {
  if (-not (Test-Path (Join-Path $FontDir $f))) {
    throw "Missing font file: $(Join-Path $FontDir $f)"
  }
}

$dest = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Fonts'
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$reg = 'HKCU:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts'

Write-Host '=== pi-light-eyes: font registration ==='

# Copy first so a registration never points at a missing file.
# A font already loaded by a running process cannot be overwritten; skip when the
# content is identical (the normal re-run case) and explain when it is not.
foreach ($f in $files.Values) {
  $src = Join-Path $FontDir $f
  $dst = Join-Path $dest $f
  if (Test-Path $dst) {
    $same = (Get-FileHash $src -Algorithm SHA256).Hash -eq (Get-FileHash $dst -Algorithm SHA256).Hash
    if ($same) {
      Write-Host "  unchanged  $f"
      continue
    }
  }
  try {
    Copy-Item -Path $src -Destination $dst -Force -ErrorAction Stop
    Write-Host "  copied     $f"
  }
  catch [System.IO.IOException] {
    throw "Cannot replace $dst because it is in use. Close every Windows Terminal window and retry, or reboot." 
  }
}

# Drop every existing name for this family, including the TTC entry, so the
# two faces below are the only registrations left.
$existing = (Get-ItemProperty -Path $reg -ErrorAction SilentlyContinue).PSObject.Properties |
  Where-Object { $_.Name -match 'D2Coding' -and $_.Name -notlike 'PS*' }
foreach ($e in $existing) {
  if ($files.ContainsKey($e.Name)) { continue }
  Remove-ItemProperty -Path $reg -Name $e.Name -ErrorAction SilentlyContinue
  Write-Host "  removed stale entry $($e.Name)"
}

foreach ($name in $files.Keys) {
  $full = Join-Path $dest $files[$name]
  Set-ItemProperty -Path $reg -Name $name -Value $full -Type String
}

if (-not $NoNotify) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class FontNotify {
  [DllImport("user32.dll")]
  public static extern int SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam,
      IntPtr lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
}
'@
  $res = [UIntPtr]::Zero
  [FontNotify]::SendMessageTimeout([IntPtr]0xffff, 0x001D, [UIntPtr]::Zero,
      [IntPtr]::Zero, 2, 1500, [ref]$res) | Out-Null
}

Write-Host '  registered:'
(Get-ItemProperty -Path $reg).PSObject.Properties |
  Where-Object { $_.Name -match 'D2Coding' -and $_.Name -notlike 'PS*' } |
  ForEach-Object { Write-Host "    $($_.Name)  =>  $($_.Value)" }

Write-Host ''
Write-Host 'Restart Windows Terminal so it picks up the font.'
