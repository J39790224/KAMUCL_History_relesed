import { join } from 'node:path'
import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { logScope } from './launcherLog'

const closeLog = logScope('graceful-close')

/** Product backend action, scoped to the JVM owned by GameSession. No taskkill / Kill /
 * SIGTERM is used for graceful Windows closure: GLFW receives a normal WM_CLOSE. */
export function requestGameWindowClose(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (!Number.isSafeInteger(pid) || !pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  if (process.platform !== 'win32') return Promise.reject(new Error('请先在 Minecraft 内保存并退出，然后重试；当前平台不支持自动正常关窗'))
  closeLog.info(`向游戏进程 pid=${pid} 发送正常关闭消息（WM_CLOSE）`)
  const script = `$ErrorActionPreference='Stop'; $gameProcess=[System.Diagnostics.Process]::GetProcessById(${pid}); if (-not $gameProcess.CloseMainWindow()) { throw 'Minecraft has no responsive main window; exit from inside the game.' }`
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 6000 }, error => {
      if (error) {
        closeLog.warn(`pid=${pid} 正常退出请求失败，请在游戏内保存退出`, error)
        reject(new Error('无法发送正常退出请求，请在游戏内保存退出；不会自动强杀'))
      } else {
        closeLog.info(`pid=${pid} 已确认正常关闭请求送达`)
        resolve()
      }
    })
  })
}

/** QuickPlay 直达场景：仅激活本次启动的 JVM，确认前台结果，退出时取消等待。 */
export function focusGameWindow(child: ChildProcess, timeoutMs = 90000): Promise<void> {
  const pid = child.pid
  if (!Number.isSafeInteger(pid) || !pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  if (process.platform !== 'win32') return Promise.resolve()
  closeLog.debug(`拉起游戏窗口聚焦助手：pid=${pid}，超时 ${timeoutMs}ms`)
  const helper = join(__dirname, 'GameWindowFocus.exe').replace('app.asar', 'app.asar.unpacked')
  return new Promise((resolve, reject) => {
    const worker = execFile(helper, [String(pid), String(timeoutMs)], { windowsHide: true, timeout: timeoutMs + 2000 }, (error, _stdout, stderr) => {
      child.off('exit', cancel)
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      if (error) {
        closeLog.warn(`游戏窗口聚焦未完成：pid=${pid}`, error)
        reject(new Error(stderr.trim() || '游戏窗口前台激活失败或超时'))
      } else resolve()
    })
    const cancel = () => { worker.kill() } // Only our helper, never the game.
    child.once('exit', cancel)
  })
}
