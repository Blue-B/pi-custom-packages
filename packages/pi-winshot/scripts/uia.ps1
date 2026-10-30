<#
  pi-winshot uia.ps1 - UI Automation text tree + ref actions (no pixels, no mouse)
    -Op tree  -Title "<substring>" [-MaxNodes N] [-Rects]   print compact element tree with refs (e1, e2, ...)
    -Op act   -Ref eN -Action click|type|focus [-Value "..."]
  Refs from the last `tree` call are cached in %TEMP%\pi-winshot-uia.json as UIA RuntimeIds.
#>
[CmdletBinding()]
param(
  [ValidateSet('tree','act')]
  [string]$Op = 'tree',
  [string]$Title = "",
  [int]$MaxNodes = 300,
  [switch]$Rects,
  [string]$Ref = "",
  [ValidateSet('click','type','focus')]
  [string]$Action = 'click',
  [string]$Value = ""
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\lib.ps1"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$AE = [System.Windows.Automation.AutomationElement]
$cachePath = Join-Path $env:TEMP 'pi-winshot-uia.json'

# Containers that only add nesting; printed only when they carry a name.
$structural = @('Pane','Group','Custom','Document','Window','TitleBar','ToolBar','StatusBar','Header','ScrollBar','Thumb','Separator','Image','Table','List','Tree','Menu','MenuBar','Tab')

function Short([string]$s, [int]$n) {
  $s = ($s -replace '\s+', ' ').Trim()
  if ($s.Length -gt $n) { $s.Substring(0, $n) + '...' } else { $s }
}

if ($Op -eq 'tree') {
  if (-not $Title) { throw "tree requires -Title" }
  $match = Get-WindowList | Where-Object { $_.Title -like "*$Title*" } | Select-Object -First 1
  if (-not $match) { throw "no visible window matches: $Title" }
  $root = $AE::FromHandle($match.Handle)
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $lines = New-Object System.Collections.Generic.List[string]
  $refs = @{}
  $script:n = 0; $script:visited = 0

  function Walk($el, [int]$indent) {
    if ($script:visited -ge $MaxNodes) { return }
    $script:visited++
    $next = $indent
    try {
      $c = $el.Current
      $type = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
      $name = Short $c.Name 100
      if ($name -or $structural -notcontains $type) {
        $script:n++
        $id = "e$($script:n)"
        $refs[$id] = ($el.GetRuntimeId() -join '.')
        $line = ('  ' * $indent) + "$id $type"
        if ($name) { $line += " `"$name`"" }
        if ($type -in 'Edit','ComboBox' -and -not $c.IsPassword) {
          $vp = $null
          if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
            $v = Short $vp.Current.Value 80
            if ($v) { $line += " value=`"$v`"" }
          }
        }
        if ($type -in 'CheckBox','RadioButton') {
          $tp = $null
          if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tp)) { $line += " [$($tp.Current.ToggleState)]" }
        }
        $r = $c.BoundingRectangle
        if ($Rects -and -not $r.IsEmpty -and -not [double]::IsInfinity($r.X)) {
          $line += (" @{0},{1} {2}x{3}" -f [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)
        }
        if (-not $c.IsEnabled) { $line += ' disabled' }
        if ($c.IsOffscreen) { $line += ' offscreen' }
        $lines.Add($line)
        $next = $indent + 1
      }
    } catch { return }  # element vanished mid-walk
    $child = $walker.GetFirstChild($el)
    while ($child -and $script:visited -lt $MaxNodes) {
      Walk $child $next
      try { $child = $walker.GetNextSibling($child) } catch { break }
    }
  }

  Walk $root 0
  @{ handle = $match.Handle.ToInt64(); refs = $refs } | ConvertTo-Json -Compress | Set-Content -Encoding UTF8 $cachePath
  $head = "window: $($match.Title)  ($($lines.Count) elements"
  if ($script:visited -ge $MaxNodes) { $head += ", truncated at $MaxNodes nodes" }
  Write-Output ($head + ")")
  Write-Output ($lines -join "`n")
  exit 0
}

# --- act ---------------------------------------------------------------------
if (-not (Test-Path $cachePath)) { throw "no cached refs; run tree first" }
$cache = Get-Content -Raw -Encoding UTF8 $cachePath | ConvertFrom-Json
$rid = $cache.refs.$Ref
if (-not $rid) { throw "unknown ref $Ref; run tree again" }
$root = $AE::FromHandle([IntPtr][long]$cache.handle)
$ids = [int[]]($rid -split '\.')
$cond = New-Object System.Windows.Automation.PropertyCondition($AE::RuntimeIdProperty, $ids)
$el = $root.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $cond)
if (-not $el) { throw "ref $Ref is stale (element gone); run tree again" }

function Try-Pattern($pattern) {
  $p = $null
  if ($el.TryGetCurrentPattern($pattern, [ref]$p)) { return $p }
  return $null
}

$done = $null
switch ($Action) {
  'click' {
    if ($p = Try-Pattern ([System.Windows.Automation.InvokePattern]::Pattern)) { $p.Invoke(); $done = 'invoke' }
    elseif ($p = Try-Pattern ([System.Windows.Automation.TogglePattern]::Pattern)) { $p.Toggle(); $done = 'toggle' }
    elseif ($p = Try-Pattern ([System.Windows.Automation.SelectionItemPattern]::Pattern)) { $p.Select(); $done = 'select' }
    elseif ($p = Try-Pattern ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)) {
      if ($p.Current.ExpandCollapseState -eq 'Collapsed') { $p.Expand() } else { $p.Collapse() }
      $done = 'expandcollapse'
    }
    else { throw "$Ref supports no click pattern (Invoke/Toggle/SelectionItem/ExpandCollapse)" }
  }
  'type' {
    $p = Try-Pattern ([System.Windows.Automation.ValuePattern]::Pattern)
    if (-not $p) { throw "$Ref has no ValuePattern; cannot type" }
    if ($p.Current.IsReadOnly) { throw "$Ref is read-only" }
    $p.SetValue($Value); $done = 'setvalue'
  }
  'focus' { $el.SetFocus(); $done = 'focus' }
}
Write-Output ("ok {0} {1} `"{2}`"" -f $done, $Ref, (Short $el.Current.Name 80))
