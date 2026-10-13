# Paste an OPENAI DOT SWARM task into the ChatGPT composer and send it.
# openaiDotsDesktop.js spawns this with the task on stdin (never argv).
# Exit 0 only after a pixel on ChatGPT is topmost, Ctrl+V, and Enter.
# Stay HWND_TOPMOST until after Enter so the click is not eaten by Chrome.
# Click with SetCursorPos (same DPI space as GetWindowRect). Do not mix
# SendInput ABSOLUTE with GetSystemMetrics: that misses at 150% DPI.
# Spawn without CREATE_NO_WINDOW: a hidden console cannot inject keys.
# Window process names: ChatGPT Classic (packaged app) and ChatGPT.

$ErrorActionPreference = 'Stop'

$MaxChars = 16384
$WaitMs = 12000
$PollMs = 250
$AfterTopMostMs = 450
$AfterClickMs = 350
$AfterPasteMs = 800

$in = New-Object System.IO.StreamReader(
  [Console]::OpenStandardInput(),
  (New-Object System.Text.UTF8Encoding $false),
  $false,
  4096
)
try {
  $text = $in.ReadToEnd()
} finally {
  $in.Dispose()
}
if ([string]::IsNullOrEmpty($text)) {
  [Console]::Error.WriteLine('no task')
  exit 1
}
if ($text.Length -gt $MaxChars) {
  [Console]::Error.WriteLine('task too long')
  exit 1
}

try {
  Add-Type -AssemblyName System.Windows.Forms
  $copied = $false
  for ($i = 0; $i -lt 8 -and -not $copied; $i++) {
    try {
      [System.Windows.Forms.Clipboard]::SetText($text)
      if ([System.Windows.Forms.Clipboard]::GetText() -eq $text) {
        $copied = $true
      }
    } catch {
      Start-Sleep -Milliseconds 80
    }
  }
  if (-not $copied) { throw 'clipboard busy' }
} catch {
  [Console]::Error.WriteLine('clipboard')
  exit 4
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class GrokBotPasteWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int dwProcessId);
  [DllImport("user32.dll")] public static extern bool LockSetForegroundWindow(int uLockCode);
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, IntPtr pvParam, uint fWinIni);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo;
  }
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
  public const int SW_RESTORE = 9;
  public const int SW_SHOW = 5;
  public const int SW_SHOWNORMAL = 1;
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_SHOWWINDOW = 0x0040;
  public const uint GA_ROOT = 2;
  public const uint INPUT_MOUSE = 0;
  public const uint INPUT_KEYBOARD = 1;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const uint SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001;
  public const int LSFW_UNLOCK = 2;
  public const int ASFW_ANY = -1;
  public const ushort VK_MENU = 0x12;
  public const ushort VK_CONTROL = 0x11;
  public const ushort VK_V = 0x56;
  public const ushort VK_RETURN = 0x0D;
  static INPUT Key(ushort vk, bool up) {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.U.ki.wVk = vk;
    i.U.ki.wScan = 0;
    i.U.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
    return i;
  }
  public static void Send(INPUT[] inputs) {
    uint n = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (n != (uint)inputs.Length) throw new InvalidOperationException("SendInput");
  }
  public static void Tap(ushort vk) {
    Send(new INPUT[] { Key(vk, false), Key(vk, true) });
  }
  public static void Chord(ushort hold, ushort tap) {
    Send(new INPUT[] {
      Key(hold, false), Key(tap, false), Key(tap, true), Key(hold, true)
    });
  }
  public static void ClickAt(int x, int y) {
    SetCursorPos(x, y);
    INPUT down = new INPUT();
    down.type = INPUT_MOUSE;
    down.U.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    INPUT up = new INPUT();
    up.type = INPUT_MOUSE;
    up.U.mi.dwFlags = MOUSEEVENTF_LEFTUP;
    Send(new INPUT[] { down, up });
  }
  public static bool PointBelongsTo(IntPtr hWnd, int x, int y) {
    POINT p;
    p.X = x;
    p.Y = y;
    IntPtr hit = WindowFromPoint(p);
    if (hit == IntPtr.Zero || hWnd == IntPtr.Zero) return false;
    if (hit == hWnd) return true;
    IntPtr root = GetAncestor(hit, GA_ROOT);
    return root == hWnd;
  }
  public static void SetTopMost(IntPtr hWnd, bool topMost) {
    SetWindowPos(
      hWnd,
      topMost ? HWND_TOPMOST : HWND_NOTOPMOST,
      0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW
    );
  }
  public static void ShowRestored(IntPtr hWnd) {
    ShowWindow(hWnd, SW_RESTORE);
    ShowWindow(hWnd, SW_SHOWNORMAL);
    ShowWindow(hWnd, SW_SHOW);
    BringWindowToTop(hWnd);
    SwitchToThisWindow(hWnd, true);
  }
  public static long ForegroundId() {
    return GetForegroundWindow().ToInt64();
  }
}
"@

function Get-ChatGptWindow {
  $names = @('ChatGPT Classic', 'ChatGPT')
  $fromMain = @(
    Get-Process -ErrorAction SilentlyContinue |
      Where-Object {
        $names -contains $_.ProcessName -and
        $_.MainWindowHandle -ne [IntPtr]::Zero
      }
  )
  if ($fromMain.Count -gt 0) {
    return $fromMain |
      Sort-Object {
        $rect = New-Object GrokBotPasteWin+RECT
        [void][GrokBotPasteWin]::GetWindowRect($_.MainWindowHandle, [ref]$rect)
        [Math]::Abs($rect.Right - $rect.Left) * [Math]::Abs($rect.Bottom - $rect.Top)
      } -Descending |
      Select-Object -First 1
  }
  $script:foundHwnd = [IntPtr]::Zero
  $script:foundArea = 0
  $script:foundId = 0
  $cb = [GrokBotPasteWin+EnumProc]{
    param($hWnd, $lp)
    $procIdOut = 0
    [void][GrokBotPasteWin]::GetWindowThreadProcessId($hWnd, [ref]$procIdOut)
    if ($procIdOut -eq 0) { return $true }
    $p = Get-Process -Id $procIdOut -ErrorAction SilentlyContinue
    if (-not $p -or $names -notcontains $p.ProcessName) { return $true }
    if (-not [GrokBotPasteWin]::IsWindowVisible($hWnd)) { return $true }
    $rect = New-Object GrokBotPasteWin+RECT
    [void][GrokBotPasteWin]::GetWindowRect($hWnd, [ref]$rect)
    $area = [Math]::Abs($rect.Right - $rect.Left) * [Math]::Abs($rect.Bottom - $rect.Top)
    if ($area -gt $script:foundArea) {
      $script:foundArea = $area
      $script:foundHwnd = $hWnd
      $script:foundId = $p.Id
    }
    return $true
  }
  [void][GrokBotPasteWin]::EnumWindows($cb, [IntPtr]::Zero)
  if ($script:foundId -ne 0 -and $script:foundHwnd -ne [IntPtr]::Zero) {
    return [pscustomobject]@{
      Id = $script:foundId
      MainWindowHandle = $script:foundHwnd
    }
  }
  return $null
}

function Test-Foreground([IntPtr]$hwnd) {
  return [GrokBotPasteWin]::ForegroundId() -eq $hwnd.ToInt64()
}

$deadline = (Get-Date).AddMilliseconds($WaitMs)
$proc = Get-ChatGptWindow
while (-not $proc -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds $PollMs
  $proc = Get-ChatGptWindow
}
if (-not $proc) {
  [Console]::Error.WriteLine('ChatGPT window not found')
  exit 2
}

$hwnd = $proc.MainWindowHandle
$rect = New-Object GrokBotPasteWin+RECT
if ([GrokBotPasteWin]::IsIconic($hwnd)) {
  [void][GrokBotPasteWin]::ShowWindow($hwnd, [GrokBotPasteWin]::SW_RESTORE)
  Start-Sleep -Milliseconds 700
}
[void][GrokBotPasteWin]::GetWindowRect($hwnd, [ref]$rect)
$width = [Math]::Abs($rect.Right - $rect.Left)
$height = [Math]::Abs($rect.Bottom - $rect.Top)
if ($width -lt 200 -or $height -lt 200) {
  [Console]::Error.WriteLine('ChatGPT window too small')
  exit 3
}

[void][GrokBotPasteWin]::SystemParametersInfo(
  [GrokBotPasteWin]::SPI_SETFOREGROUNDLOCKTIMEOUT,
  0,
  [IntPtr]::Zero,
  0
)
[void][GrokBotPasteWin]::LockSetForegroundWindow([GrokBotPasteWin]::LSFW_UNLOCK)
[void][GrokBotPasteWin]::AllowSetForegroundWindow([GrokBotPasteWin]::ASFW_ANY)

$fore = [GrokBotPasteWin]::GetForegroundWindow()
$foreProcOut = 0
$targetProcOut = 0
$ourTid = [GrokBotPasteWin]::GetCurrentThreadId()
$foreTid = [GrokBotPasteWin]::GetWindowThreadProcessId($fore, [ref]$foreProcOut)
$targetTid = [GrokBotPasteWin]::GetWindowThreadProcessId($hwnd, [ref]$targetProcOut)
$attachedFore = $false
$attachedTarget = $false
$attachedPair = $false
if ($foreTid -ne 0 -and $foreTid -ne $ourTid) {
  $attachedFore = [GrokBotPasteWin]::AttachThreadInput($ourTid, $foreTid, $true)
}
if ($targetTid -ne 0 -and $targetTid -ne $ourTid) {
  $attachedTarget = [GrokBotPasteWin]::AttachThreadInput($ourTid, $targetTid, $true)
}
if (
  $foreTid -ne 0 -and $targetTid -ne 0 -and $foreTid -ne $targetTid
) {
  $attachedPair = [GrokBotPasteWin]::AttachThreadInput($foreTid, $targetTid, $true)
}

$topMost = $false
try {
  [GrokBotPasteWin]::ShowRestored($hwnd)
  [GrokBotPasteWin]::SetTopMost($hwnd, $true)
  $topMost = $true
  Start-Sleep -Milliseconds $AfterTopMostMs
  [void][GrokBotPasteWin]::GetWindowRect($hwnd, [ref]$rect)
  $width = [Math]::Abs($rect.Right - $rect.Left)
  $height = [Math]::Abs($rect.Bottom - $rect.Top)
  $titleX = [int](($rect.Left + $rect.Right) / 2)
  $titleY = $rect.Top + 12
  $composeX = $rect.Left + [int]($width * 0.30)
  $composeYs = @(
    [int]($rect.Bottom - 88),
    [int]($rect.Bottom - 120),
    [int]($rect.Bottom - 64),
    [int]($rect.Bottom - 150)
  )

  $wshell = New-Object -ComObject WScript.Shell
  $frontDeadline = (Get-Date).AddMilliseconds(5000)
  $onTop = $false
  while ((Get-Date) -lt $frontDeadline) {
    [GrokBotPasteWin]::SetTopMost($hwnd, $true)
    [GrokBotPasteWin]::ShowRestored($hwnd)
    [void]$wshell.AppActivate($proc.Id)
    [void][GrokBotPasteWin]::SetForegroundWindow($hwnd)
    [GrokBotPasteWin]::ClickAt($titleX, $titleY)
    Start-Sleep -Milliseconds 180
    if ([GrokBotPasteWin]::PointBelongsTo($hwnd, $titleX, $titleY)) {
      $onTop = $true
      break
    }
    Start-Sleep -Milliseconds 220
  }
  if (-not $onTop) {
    [Console]::Error.WriteLine('ChatGPT not topmost')
    exit 5
  }

  [GrokBotPasteWin]::Tap([GrokBotPasteWin]::VK_MENU)
  [void][GrokBotPasteWin]::SetForegroundWindow($hwnd)
  Start-Sleep -Milliseconds 120

  foreach ($composeY in $composeYs) {
    if ($composeY -le ($rect.Top + 40)) { continue }
    [GrokBotPasteWin]::ClickAt($composeX, $composeY)
    Start-Sleep -Milliseconds 90
  }
  Start-Sleep -Milliseconds $AfterClickMs

  $lastY = $composeYs[0]
  if (-not [GrokBotPasteWin]::PointBelongsTo($hwnd, $composeX, $lastY)) {
    [Console]::Error.WriteLine('ChatGPT not topmost')
    exit 5
  }
  if (-not (Test-Foreground $hwnd)) {
    [void][GrokBotPasteWin]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 80
  }
  if (-not (Test-Foreground $hwnd)) {
    [Console]::Error.WriteLine('ChatGPT not foreground')
    exit 5
  }

  if ([System.Windows.Forms.Clipboard]::GetText() -ne $text) {
    [System.Windows.Forms.Clipboard]::SetText($text)
  }
  [GrokBotPasteWin]::Chord([GrokBotPasteWin]::VK_CONTROL, [GrokBotPasteWin]::VK_V)
  Start-Sleep -Milliseconds $AfterPasteMs
  [GrokBotPasteWin]::Tap([GrokBotPasteWin]::VK_RETURN)
} finally {
  if ($topMost) {
    [GrokBotPasteWin]::SetTopMost($hwnd, $false)
  }
  if ($attachedPair) {
    [void][GrokBotPasteWin]::AttachThreadInput($foreTid, $targetTid, $false)
  }
  if ($attachedTarget) {
    [void][GrokBotPasteWin]::AttachThreadInput($ourTid, $targetTid, $false)
  }
  if ($attachedFore) {
    [void][GrokBotPasteWin]::AttachThreadInput($ourTid, $foreTid, $false)
  }
}
exit 0
