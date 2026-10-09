<#
.SYNOPSIS
  Report the active pi-light-eyes state without changing anything.

.DESCRIPTION
  Prints the Windows Terminal scheme, font and antialiasing settings, checks that
  both D2Coding faces are registered as separate files, and reports the pi theme
  and herdr settings when readable from the WSL side.

.EXAMPLE
  pwsh -File verify.ps1
#>
[CmdletBinding()]
param(
  [string]$SettingsPath
)

$ErrorActionPreference = 'Continue'

if (-not $SettingsPath) {
  $SettingsPath = Join-Path $env:LOCALAPPDATA 'Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json'
}

$problems = 0
function Fail([string]$m) { Write-Host "  FAIL  $m" -ForegroundColor Red;  $script:problems++ }
function Pass([string]$m) { Write-Host "  ok    $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "  warn  $m" -ForegroundColor Yellow }

Write-Host '=== Windows Terminal ==='
if (-not (Test-Path $SettingsPath)) {
  Fail "settings.json not found: $SettingsPath"
} else {
  $cfg = Get-Content $SettingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $d = $cfg.profiles.defaults

  $name = $d.colorScheme
  $scheme = $cfg.schemes | Where-Object { $_.name -eq $name }
  if ($scheme) {
    Write-Host ("  active scheme : {0}" -f $name)
    Write-Host ("    background  : {0}" -f $scheme.background)
    Write-Host ("    foreground  : {0}" -f $scheme.foreground)
    if ($scheme.background -and $scheme.background -notmatch '^#F[0-9A-F]{5}$') {
      Warn "background $($scheme.background) is very bright; #F2F2F2 is the reference"
    } else {
      Pass "background is a soft off-white"
    }
  } else {
    Fail "colorScheme '$name' is not defined in schemes"
  }

  Write-Host ("  font          : {0} {1}pt weight={2} cellHeight={3}" -f `
    $d.font.face, $d.font.size, $d.font.weight, $d.font.cellHeight)
  if ($d.font.face -ne 'D2Coding') { Warn "font.face is $($d.font.face), not D2Coding" } else { Pass 'font face is D2Coding' }
  if ($d.font.weight -ne 'normal') { Warn "font.weight is $($d.font.weight); 'normal' keeps strokes from merging" } else { Pass 'weight is normal' }

  Write-Host ("  antialiasing  : {0}" -f $d.antialiasingMode)
  if ($d.antialiasingMode -ne 'grayscale') {
    Warn "antialiasingMode is $($d.antialiasingMode); ClearType fringes on light backgrounds"
  } else {
    Pass 'grayscale antialiasing (no color fringing)'
  }
}

Write-Host ''
Write-Host '=== D2Coding registration ==='
$reg = 'HKCU:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts'
$entries = (Get-ItemProperty -Path $reg -ErrorAction SilentlyContinue).PSObject.Properties |
  Where-Object { $_.Name -match 'D2Coding' -and $_.Name -notlike 'PS*' }

if (-not $entries) {
  Fail 'no D2Coding fonts registered for this user'
} else {
  foreach ($e in $entries) {
    if (Test-Path $e.Value) { Pass "$($e.Name)  =>  $($e.Value)" }
    else { Fail "$($e.Name) points at a missing file: $($e.Value)" }
  }
  $n = @($entries).Count
  if ($n -lt 2) {
    Fail "only $n face(s) registered; Regular and Bold must be separate files or weight is ignored"
  } else {
    Pass "$n faces registered separately"
  }
}

Write-Host ''
Write-Host '=== Result ==='
if ($problems -eq 0) {
  Write-Host '  all checks passed' -ForegroundColor Green
} else {
  Write-Host "  $problems problem(s) found" -ForegroundColor Red
}
exit $problems
