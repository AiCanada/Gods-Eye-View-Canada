# Read a teacher's reply out of the Grok Bot or ChatGPT desktop app for AI
# DISTILLATION (best effort; the run falls back to the paste-back box).
# server/shared/desktopReply.mjs spawns this with a JSON job on stdin (never
# argv): { app: 'grok-bot' | 'chatgpt', tag, timeoutMs, findMs, quietMs, copy }.
# `tag` is the marker GEVC put on the last line of the prompt it pasted
# (GEV-<hex>): the reply is what comes after the message that carries it.
# Prints one JSON line and exits:
#   {"event":"reply","how":"copy"|"read","b64":"<UTF-8 text, base64>"}  exit 0
#   {"event":"error","reason":"..."}                                     exit 1
# The apps are Electron: Chromium turns its accessibility tree on at the first
# UI Automation query, so the window is read without a click. Done means the
# message after the tag stops changing and the app shows no Stop button.
# ChatGPT's own Copy response button gives the reply as written (Markdown),
# but only on a real click with ChatGPT in front: the window is restored, kept
# topmost, hovered and the point checked before the click, as the paste
# scripts do. Grok Bot shows no copy button on a reply, so its text is read.
# Coordinates: per-monitor DPI aware, so UI Automation rectangles, the cursor
# and WindowFromPoint share one space.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

function Say($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
function Fail([string]$reason) {
  Say @{ event = 'error'; reason = $reason }
  exit 1
}
function Clamp($value, [int]$low, [int]$high, [int]$fallback) {
  $n = 0
  if (-not [int]::TryParse([string]$value, [ref]$n)) { return $fallback }
  return [Math]::Min($high, [Math]::Max($low, $n))
}

$in = New-Object System.IO.StreamReader(
  [Console]::OpenStandardInput(),
  (New-Object System.Text.UTF8Encoding $false),
  $false,
  4096
)
try {
  $raw = $in.ReadToEnd()
} finally {
  $in.Dispose()
}
try { $job = $raw | ConvertFrom-Json } catch { Fail 'bad job' }
$app = [string]$job.app
if ($app -ne 'grok-bot' -and $app -ne 'chatgpt') { Fail 'unknown app' }
$tag = [string]$job.tag
if ($tag -cnotmatch '^GEV-[0-9a-f]{6,16}$') { Fail 'bad tag' }
$timeoutMs = Clamp $job.timeoutMs 5000 3600000 600000
$findMs = Clamp $job.findMs 2000 $timeoutMs 60000
$quietMs = Clamp $job.quietMs 1000 120000 15000
$copy = $job.copy -eq $true
$PollMs = 2000

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class GevReplyWin {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  public static bool Owns(IntPtr hWnd, int x, int y) {
    POINT p;
    p.X = x;
    p.Y = y;
    IntPtr hit = WindowFromPoint(p);
    if (hit == IntPtr.Zero || hWnd == IntPtr.Zero) return false;
    return hit == hWnd || GetAncestor(hit, 2) == hWnd;
  }
  public static void TopMost(IntPtr hWnd, bool on) {
    SetWindowPos(hWnd, new IntPtr(on ? -1 : -2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
  }
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
}
"@
[void][GevReplyWin]::SetProcessDpiAwarenessContext([IntPtr](-4))
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

$AE = [System.Windows.Automation.AutomationElement]
$Tree = [System.Windows.Automation.TreeScope]
$Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$ButtonCond = New-Object System.Windows.Automation.PropertyCondition(
  $AE::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Button
)
$TextCond = New-Object System.Windows.Automation.PropertyCondition(
  $AE::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Text
)
$DocCond = New-Object System.Windows.Automation.PropertyCondition(
  $AE::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Document
)
$Names = if ($app -eq 'grok-bot') { @('Grok Bot') } else { @('ChatGPT Classic', 'ChatGPT') }

function Area([IntPtr]$hwnd) {
  $rect = New-Object GevReplyWin+RECT
  [void][GevReplyWin]::GetWindowRect($hwnd, [ref]$rect)
  return [Math]::Abs($rect.Right - $rect.Left) * [Math]::Abs($rect.Bottom - $rect.Top)
}

# The app's biggest window: its main window, else any visible top-level one.
function Find-AppWindow {
  $main = @(
    Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $Names -contains $_.ProcessName -and $_.MainWindowHandle -ne [IntPtr]::Zero }
  )
  if ($main.Count -gt 0) {
    $best = $main | Sort-Object { Area $_.MainWindowHandle } -Descending | Select-Object -First 1
    return @{ hwnd = $best.MainWindowHandle; id = $best.Id }
  }
  $script:found = @{ hwnd = [IntPtr]::Zero; id = 0; area = 0 }
  $cb = [GevReplyWin+EnumProc]{
    param($hWnd, $lp)
    $procId = 0
    [void][GevReplyWin]::GetWindowThreadProcessId($hWnd, [ref]$procId)
    if ($procId -eq 0 -or -not [GevReplyWin]::IsWindowVisible($hWnd)) { return $true }
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $p -or $Names -notcontains $p.ProcessName) { return $true }
    $a = Area $hWnd
    if ($a -gt $script:found.area) { $script:found = @{ hwnd = $hWnd; id = $p.Id; area = $a } }
    return $true
  }
  [void][GevReplyWin]::EnumWindows($cb, [IntPtr]::Zero)
  if ($script:found.hwnd -eq [IntPtr]::Zero) { return $null }
  return $script:found
}

function Children($el) {
  $out = New-Object System.Collections.ArrayList
  try { $c = $Walker.GetFirstChild($el) } catch { return $out }
  while ($c -ne $null) {
    [void]$out.Add($c)
    try { $c = $Walker.GetNextSibling($c) } catch { $c = $null }
  }
  # The comma keeps PowerShell from unrolling the list.
  return ,$out
}

# An element's text in reading order (block breaks as new lines); else the
# names of its Text parts.
function Text-Of($tp, $el) {
  if ($tp) {
    try { return [string]$tp.RangeFromChild($el).GetText(-1) } catch { }
  }
  try {
    $parts = foreach ($t in $el.FindAll($Tree::Descendants, $TextCond)) { $t.Current.Name }
    return ($parts -join "`n")
  } catch {
    return ''
  }
}

function Has-Button($el, [string]$name) {
  try {
    foreach ($b in $el.FindAll($Tree::Descendants, $ButtonCond)) {
      if ($b.Current.Name -ceq $name) { return $b }
    }
  } catch { }
  return $null
}

# A Stop button (the app is still answering), or Grok Bot's typing dots.
function Busy($root) {
  try {
    foreach ($b in $root.FindAll($Tree::Descendants, $ButtonCond)) {
      if ($b.Current.Name -cmatch '^Stop( |$)') { return $true }
    }
    if ($app -eq 'grok-bot') {
      foreach ($e in $root.FindAll($Tree::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
        if ($e.Current.ClassName -match '(^| )sand-(message-typing|typing-indicator)( |$)') { return $true }
      }
    }
  } catch { }
  return $false
}

# Grok Bot: transcript rows in order; the reply is the rows after the one with
# the tag, each without its first line (the sender's name).
function Read-GrokBot($root, $tp) {
  $rows = New-Object System.Collections.ArrayList
  foreach ($e in $root.FindAll($Tree::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($e.Current.ClassName -match '(^| )sand-transcript-row( |$)') { [void]$rows.Add($e) }
  }
  $texts = New-Object System.Collections.ArrayList
  foreach ($row in $rows) {
    $anchor = $null
    foreach ($d in $row.FindAll($Tree::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
      if ($d.Current.ClassName -match '(^| )sand-message-action-anchor( |$)') { $anchor = $d; break }
    }
    [void]$texts.Add($(if ($anchor) { Text-Of $tp $anchor } else { '' }))
  }
  $mine = -1
  for ($i = 0; $i -lt $texts.Count; $i++) {
    if ($texts[$i].Contains($tag)) { $mine = $i; break }
  }
  if ($mine -lt 0) { return @{ found = $false } }
  $parts = @()
  for ($i = $mine + 1; $i -lt $texts.Count; $i++) {
    $lines = ($texts[$i] -replace "`r", '') -split "`n"
    $body = (($lines | Select-Object -Skip 1) -join "`n").Trim()
    if ($body) { $parts += $body }
  }
  return @{ found = $true; text = ($parts -join "`n`n"); button = $null }
}

# ChatGPT: main's parts in order run message, its Copy message bar, the reply,
# the reply's Copy response bar. The reply follows the bar after the message
# that carries the tag, up to the next Copy response bar.
function Read-ChatGpt($root, $tp) {
  $main = $root.FindFirst(
    $Tree::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'main'))
  )
  if (-not $main) {
    $main = $root.FindFirst($Tree::Descendants, $DocCond)
  }
  if (-not $main) { return @{ found = $false } }
  $kids = Children $main
  $kinds = New-Object System.Collections.ArrayList
  $copies = New-Object System.Collections.ArrayList
  foreach ($k in $kids) {
    $copyBtn = Has-Button $k 'Copy response'
    if ($copyBtn) {
      [void]$kinds.Add('reply-bar')
      [void]$copies.Add($copyBtn)
      continue
    }
    [void]$kinds.Add($(if (Has-Button $k 'Copy message') { 'message-bar' } else { 'part' }))
    [void]$copies.Add($null)
  }
  # The newest message bar whose message (the parts before it) carries the tag.
  $bar = -1
  for ($i = $kids.Count - 1; $i -ge 0 -and $bar -lt 0; $i--) {
    if ($kinds[$i] -ne 'message-bar') { continue }
    $j = $i - 1
    $said = ''
    while ($j -ge 0 -and $kinds[$j] -eq 'part') {
      $said = (Text-Of $tp $kids[$j]) + "`n" + $said
      $j--
    }
    if ($said.Contains($tag)) { $bar = $i }
  }
  if ($bar -lt 0) { return @{ found = $false } }
  $parts = @()
  $button = $null
  for ($i = $bar + 1; $i -lt $kids.Count; $i++) {
    if ($kinds[$i] -eq 'reply-bar') { $button = $copies[$i]; break }
    if ($kinds[$i] -eq 'message-bar') { break }
    $t = (Text-Of $tp $kids[$i]).Trim()
    if ($t) { $parts += $t }
  }
  $text = ($parts -join "`n`n") -replace '^ChatGPT said:\s*', ''
  return @{ found = $true; text = $text.Trim(); button = $button }
}

function Set-Clip([string]$text) {
  for ($i = 0; $i -lt 8; $i++) {
    try { [System.Windows.Forms.Clipboard]::SetText($text); return $true } catch { Start-Sleep -Milliseconds 80 }
  }
  return $false
}
function Get-Clip {
  for ($i = 0; $i -lt 8; $i++) {
    try { return [string][System.Windows.Forms.Clipboard]::GetText() } catch { Start-Sleep -Milliseconds 80 }
  }
  return ''
}

# ChatGPT's Copy response, clicked for real with ChatGPT in front. Returns the
# copied text, or '' when the click could not be made or copied nothing.
function Copy-Reply($win, $button) {
  $hwnd = [IntPtr]$win.hwnd
  $marker = "GEV-WAIT-$tag"
  if (-not (Set-Clip $marker)) { return '' }
  $topMost = $false
  try {
    if ([GevReplyWin]::IsIconic($hwnd)) {
      [void][GevReplyWin]::ShowWindow($hwnd, 9)
      Start-Sleep -Milliseconds 2500
    }
    $wshell = New-Object -ComObject WScript.Shell
    [void]$wshell.AppActivate([int]$win.id)
    [void][GevReplyWin]::SetForegroundWindow($hwnd)
    [GevReplyWin]::TopMost($hwnd, $true)
    $topMost = $true
    Start-Sleep -Milliseconds 700
    $r = $button.Current.BoundingRectangle
    if ($r.IsEmpty -or $r.Width -lt 8 -or $r.Height -lt 8) {
      Start-Sleep -Milliseconds 1500
      $r = $button.Current.BoundingRectangle
    }
    if ($r.IsEmpty -or $r.Width -lt 8 -or $r.Height -lt 8) { return '' }
    $x = [int]($r.X + $r.Width / 2)
    $y = [int]($r.Y + $r.Height / 2)
    # Hover the reply first: its bar shows on hover.
    [void][GevReplyWin]::SetCursorPos($x - 30, $y - 60)
    Start-Sleep -Milliseconds 300
    $r = $button.Current.BoundingRectangle
    $x = [int]($r.X + $r.Width / 2)
    $y = [int]($r.Y + $r.Height / 2)
    [void][GevReplyWin]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 400
    if (-not [GevReplyWin]::Owns($hwnd, $x, $y)) { return '' }
    [GevReplyWin]::Click($x, $y)
    $got = $marker
    for ($i = 0; $i -lt 12 -and $got -eq $marker; $i++) {
      Start-Sleep -Milliseconds 250
      $got = Get-Clip
    }
    if ($got -eq $marker) { return '' }
    return $got
  } catch {
    return ''
  } finally {
    if ($topMost) { [GevReplyWin]::TopMost($hwnd, $false) }
  }
}

$started = Get-Date
$deadline = $started.AddMilliseconds($timeoutMs)
$findBy = $started.AddMilliseconds($findMs)
$found = $false
$last = $null
$changedAt = Get-Date
$primed = @{}
while ((Get-Date) -lt $deadline) {
  $win = Find-AppWindow
  if (-not $win) {
    if ((Get-Date) -gt $findBy) { Fail 'the app is not open' }
    Start-Sleep -Milliseconds $PollMs
    continue
  }
  try {
    $root = $AE::FromHandle([IntPtr]$win.hwnd)
    $key = [string]$win.hwnd
    if (-not $primed[$key]) {
      # The first query turns the app's accessibility tree on.
      [void]$root.FindAll($Tree::Children, [System.Windows.Automation.Condition]::TrueCondition)
      Start-Sleep -Milliseconds 1500
      $primed[$key] = $true
    }
    $doc = $root.FindFirst($Tree::Descendants, $DocCond)
    $tp = $null
    if ($doc) {
      try { $tp = $doc.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern) } catch { $tp = $null }
    }
    $seen = if ($app -eq 'grok-bot') { Read-GrokBot $root $tp } else { Read-ChatGpt $root $tp }
  } catch {
    Start-Sleep -Milliseconds $PollMs
    continue
  }
  if (-not $seen.found) {
    if (-not $found -and (Get-Date) -gt $findBy) { Fail 'the pasted prompt is not in the app' }
    Start-Sleep -Milliseconds $PollMs
    continue
  }
  $found = $true
  $text = [string]$seen.text
  if ($text -ne $last) {
    $last = $text
    $changedAt = Get-Date
  }
  $ready = $text.Length -gt 0 -and -not (Busy $root)
  if ($app -eq 'chatgpt') { $ready = $ready -and $seen.button -ne $null }
  if ($ready -and ((Get-Date) - $changedAt).TotalMilliseconds -ge $quietMs) {
    $how = 'read'
    if ($copy -and $seen.button) {
      $copied = Copy-Reply $win $seen.button
      if ($copied.Trim()) {
        $text = $copied
        $how = 'copy'
      }
    }
    $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($text.Trim()))
    Say @{ event = 'reply'; how = $how; b64 = $b64 }
    exit 0
  }
  Start-Sleep -Milliseconds $PollMs
}
if ($found) { Fail 'no finished reply in time' }
Fail 'the pasted prompt is not in the app'
