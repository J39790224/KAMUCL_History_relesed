import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

/** Product backend action, scoped to the JVM owned by GameSession. No taskkill / Kill /
 * SIGTERM is used for graceful Windows closure: GLFW receives a normal WM_CLOSE. */
export function requestGameWindowClose(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (!Number.isSafeInteger(pid) || !pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  if (process.platform !== 'win32') return Promise.reject(new Error('请先在 Minecraft 内保存并退出，然后重试；当前平台不支持自动正常关窗'))
  const script = `$ErrorActionPreference='Stop'; $gameProcess=[System.Diagnostics.Process]::GetProcessById(${pid}); if (-not $gameProcess.CloseMainWindow()) { throw 'Minecraft has no responsive main window; exit from inside the game.' }`
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 6000 }, error => error ? reject(new Error('无法发送正常退出请求，请在游戏内保存退出；不会自动强杀')) : resolve())
  })
}

/** QuickPlay 直达场景（创建世界/进服）：游戏窗口出现后拉到前台，避免进入世界时鼠标被锁在未聚焦窗口内 */
export function focusGameWindow(child: ChildProcess, timeoutMs = 90000): Promise<void> {
  const pid = child.pid
  if (!Number.isSafeInteger(pid) || !pid || child.exitCode !== null) return Promise.resolve()
  if (process.platform !== 'win32') return Promise.resolve()
  const script = [
    `$deadline=(Get-Date).AddMilliseconds(${timeoutMs})`,
    `while ((Get-Date) -lt $deadline) {`,
    `  try { $p=[System.Diagnostics.Process]::GetProcessById(${pid}) } catch { break }`,
    `  $h=$p.MainWindowHandle`,
    `  if ($h -and $h -ne [IntPtr]::Zero) {`,
    `    Add-Type -TypeDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);' -Name U32Focus -ErrorAction SilentlyContinue`,
    `    [U32Focus]::AllowSetForegroundWindow(${pid}) | Out-Null`,
    `    [U32Focus]::ShowWindow($h, 9) | Out-Null`,
    `    [U32Focus]::SetForegroundWindow($h) | Out-Null`,
    `    break`,
    `  }`,
    `  Start-Sleep -Milliseconds 800`,
    `}`
  ].join('; ')
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: timeoutMs + 5000 }, () => resolve())
  })
}

