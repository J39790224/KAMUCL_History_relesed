import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { redactDiagnosticText } from './diagnostics'

let currentLogPath = ''

/** 每次启动器会话单独覆盖，确保导出的是“本次启动器运行”的日志。 */
export function initializeLauncherLog(): string {
  const dir = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(dir, { recursive: true })
  currentLogPath = path.join(dir, 'launcher-current.log')
  fs.writeFileSync(
    currentLogPath,
    `[${new Date().toISOString()}] KAMUCL ${app.getVersion()} session started (${process.platform} ${process.arch})\n`,
    'utf-8'
  )
  return currentLogPath
}

export function launcherLog(message: string): void {
  try {
    if (!currentLogPath) initializeLauncherLog()
    const safe = redactDiagnosticText(message).replace(/[\r\n]+/g, ' ')
    fs.appendFileSync(currentLogPath, `[${new Date().toISOString()}] ${safe}\n`, 'utf-8')
  } catch {
    // 日志自身不能影响启动器业务。
  }
}

export function launcherLogPath(): string {
  return currentLogPath || path.join(app.getPath('userData'), 'logs', 'launcher-current.log')
}
