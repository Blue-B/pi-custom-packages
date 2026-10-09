<#
.SYNOPSIS
  Apply the pi-light-eyes palette and font to Windows Terminal.

.DESCRIPTION
  Idempotent. Backs up settings.json, then updates only:
    - the "ChatGPT Light" color scheme
    - profiles.defaults.font / antialiasingMode / colorScheme
    - the "ChatGPT Light" appearance theme (tab colors)

  Everything else in the file, and every other scheme and profile, is preserved.
  The file is written with 4-space indentation.

.PARAMETER SettingsPath
  Windows Terminal settings.json. Defaults to the packaged install location for
  the current user.

.PARAMETER FontFace
  Font family name. Default D2Coding.

.PARAMETER FontSize
  Size in points. Default 12.5. Must be passed as a decimal; 12 stays 12.

.PARAMETER Bg, Foreground
  Background and foreground hex. Defaults #F2F2F2 and #1A1A1A.

.PARAMETER CellHeight
  Line height multiplier. Default 1.45.

.PARAMETER DryRun
  Print the planned change and exit without writing.

.EXAMPLE
  pwsh -File apply-terminal.ps1
  pwsh -File apply-terminal.ps1 -Bg '#F4F4F4' -FontSize 12 -DryRun
#>
[CmdletBinding()]
param(
  [string]$SettingsPath,
  [string]$FontFace   = 'D2Coding',
  [double]$FontSize   = 12.5,
  [string]$Bg         = '#F2F2F2',
  [string]$Foreground = '#1A1A1A',
  [double]$CellHeight = 1.45,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

if (-not $SettingsPath) {
  $SettingsPath = Join-Path $env:LOCALAPPDATA 'Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json'
}

if (-not (Test-Path $SettingsPath)) {
  throw "Windows Terminal settings.json not found: $SettingsPath`nPass -SettingsPath explicitly (also check the WindowsTerminalPreview package)."
}

function Normalize-Hex([string]$v) {
  if ($v -notmatch '^#?[0-9A-Fa-f]{6}$') { throw "Invalid hex color: $v" }
  return '#' + $v.TrimStart('#').ToUpper()
}

# PSCustomObject properties must exist before assignment, and a fresh machine's
# settings.json has no schemes array and an empty profiles.defaults, so set
# every value through this helper instead of assigning directly.
function Set-Prop($obj, [string]$name, $value) {
  if ($obj.PSObject.Properties[$name]) { $obj.$name = $value }
  else { $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value -Force }
}
$Bg = Normalize-Hex $Bg
$Foreground = Normalize-Hex $Foreground

# Windows Terminal ships UTF-8 without BOM; keep it that way so it stays parseable.
$raw = Get-Content -Path $SettingsPath -Raw -Encoding UTF8
$cfg = $raw | ConvertFrom-Json

# --- back up before touching anything -------------------------------------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$SettingsPath.bak-lighteyes-$stamp"
if (-not $DryRun) { Copy-Item -Path $SettingsPath -Destination $backup -Force }

# --- color scheme ----------------------------------------------------------
$schemeName = 'ChatGPT Light'
if (-not $cfg.PSObject.Properties['schemes']) { $cfg | Add-Member -NotePropertyName schemes -NotePropertyValue @() -Force }
$scheme = $cfg.schemes | Where-Object { $_.name -eq $schemeName }
if (-not $scheme) {
  $scheme = [pscustomobject]@{ name = $schemeName }
  $cfg.schemes = @($cfg.schemes) + $scheme
}
Set-Prop $scheme 'background' $Bg
Set-Prop $scheme 'foreground' $Foreground
Set-Prop $scheme 'cursorColor' $Foreground
if (-not $scheme.selectionBackground) { Set-Prop $scheme 'selectionBackground' '#B4D5FE' }
# ANSI colors are only filled in when absent, so hand-tuned values survive.
$ansi = @{
  black='#0D0D0D'; red='#C0341D'; green='#0F7B0F'; yellow='#8A6D00'
  blue='#0B5CAB'; purple='#7A3DB8'; cyan='#0A6E6E'; white='#E5E5E5'
  brightBlack='#5D5D5D'; brightRed='#D94A33'; brightGreen='#1A8F1A'; brightYellow='#A38000'
  brightBlue='#156FCB'; brightPurple='#8E52CC'; brightCyan='#0B8080'; brightWhite='#FFFFFF'
}
foreach ($k in $ansi.Keys) {
  if (-not $scheme.PSObject.Properties[$k]) {
    $scheme | Add-Member -NotePropertyName $k -NotePropertyValue $ansi[$k]
  }
}

# --- appearance theme (tab bar) -------------------------------------------
if (-not $cfg.PSObject.Properties['themes']) { $cfg | Add-Member -NotePropertyName themes -NotePropertyValue @() -Force }
$appearance = $cfg.themes | Where-Object { $_.name -eq $schemeName }
if ($appearance) {
  if (-not $appearance.PSObject.Properties['tab']) {
    $appearance | Add-Member -NotePropertyName tab -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  if (-not $appearance.PSObject.Properties['tabRow']) {
    $appearance | Add-Member -NotePropertyName tabRow -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  Set-Prop $appearance.tab 'background' "$($Bg)F2"
  Set-Prop $appearance.tab 'unfocusedBackground' '#EAEAEA'
  Set-Prop $appearance.tabRow 'background' '#E9E9EC'
  Set-Prop $appearance.tabRow 'unfocusedBackground' $Bg
}

# --- defaults --------------------------------------------------------------
if (-not $cfg.profiles) { throw 'settings.json has no "profiles" object; refusing to guess.' }
if (-not $cfg.profiles.PSObject.Properties['defaults']) {
  $cfg.profiles | Add-Member -NotePropertyName defaults -NotePropertyValue ([pscustomobject]@{}) -Force
}
$d = $cfg.profiles.defaults

# font is an object; other values pass through
if (-not $d.PSObject.Properties['font'] -or $d.font -is [string]) {
  $prevFace = if ($d.font) { $d.font } else { $FontFace }
  $d | Add-Member -NotePropertyName font -NotePropertyValue ([pscustomobject]@{ face = $prevFace }) -Force
}
Set-Prop $d.font 'face' $FontFace
Set-Prop $d.font 'size' $FontSize
Set-Prop $d.font 'weight' 'normal'
# Preserve string vs number: WT accepts both, but changing the type makes the
# file diff noisily against what the user hand-edited.
# NOTE: do not name this $cellHeight - PowerShell is case-insensitive and that
# collides with the [double]$CellHeight parameter, coercing the string to a number.
$chValue = if ($d.font.cellHeight -is [string]) { "$CellHeight" } else { $CellHeight }
Set-Prop $d.font 'cellHeight' $chValue

Set-Prop $d 'antialiasingMode' 'grayscale'
Set-Prop $d 'colorScheme' $schemeName

$json = $cfg | ConvertTo-Json -Depth 64

# Round-trip before writing: ConvertTo-Json re-serializes the whole file, so a
# parse failure here must never reach disk.
$null = $json | ConvertFrom-Json

Write-Host '=== pi-light-eyes: Windows Terminal ==='
Write-Host ("  colorScheme      : {0}" -f $d.colorScheme)
Write-Host ("  font             : {0} {1}pt weight={2} cellHeight={3}" -f $d.font.face, $d.font.size, $d.font.weight, $d.font.cellHeight)
Write-Host ("  antialiasingMode : {0}" -f $d.antialiasingMode)
Write-Host ("  scheme           : bg {0} / fg {1}" -f $scheme.background, $scheme.foreground)

if ($DryRun) {
  Write-Host '  DRY RUN - nothing written.'
  exit 0
}

[System.IO.File]::WriteAllText($SettingsPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ("  backup           : {0}" -f $backup)
Write-Host ''
Write-Host 'Restart Windows Terminal for the font and antialiasing change to take effect.'
Write-Host 'Color and theme changes are already applied.'
