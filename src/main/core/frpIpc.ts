/**
 * 樱花穿透 IPC 注册：
 *   - invoke 'frp:start'  ({ accessKey, tunnelId, localPort })
 *   - invoke 'frp:stop'
 *   - invoke 'frp:status'
 *   - push   'frp:event'  ({ type:'log'|'ready'|'error'|'stopped'|'status', data })
 */
import type { IpcMain } from 'electron'
import {
  frpController,
  loadFrpConfig,
  type FrpEvent,
  type FrpConfig,
  type FrpState
} from './frp'

export interface FrpStartPayload {
  accessKey: string
  tunnelId: string
  /** 留 0 表示自动读取 MC 局域网日志拿端口 */
  localPort?: number
}

export const FRP_IPC = {
  start: 'frp:start',
  stop: 'frp:stop',
  status: 'frp:status',
  event: 'frp:event'
} as const

export function registerFrpIpc(ipcMain: IpcMain): void {
  ipcMain.handle(FRP_IPC.start, async (_event, payload: FrpStartPayload) => {
    if (!payload || typeof payload !== 'object') throw new Error('参数无效')
    const accessKey = String(payload.accessKey ?? '').trim()
    const tunnelId = String(payload.tunnelId ?? '').trim()
    const localPort = Number(payload.localPort ?? 0) || 0
    if (!accessKey) throw new Error('请填写访问密钥')
    if (!tunnelId) throw new Error('请填写隧道 ID')
    return frpController.start({ accessKey, tunnelId, localPort })
  })

  ipcMain.handle(FRP_IPC.stop, async () => {
    await frpController.stop()
    return frpController.status()
  })

  ipcMain.handle(FRP_IPC.status, () => {
    const st = frpController.status()
    // 无运行会话时回填持久化配置，渲染端表单才能恢复上次填写的密钥与隧道 ID
    if (!st.config) {
      const saved = loadFrpConfig()
      if (saved) st.config = saved
    }
    return st
  })

  // 渲染端订阅事件
  frpController.setSink((event: FrpEvent) => {
    const win = (ipcMain as unknown as { _win?: () => Electron.BrowserWindow | null })._win?.()
    win?.webContents.send(FRP_IPC.event, event)
  })
}

/**
 * 仅暴露给 main/ipc.ts 用于在拿到 BrowserWindow getter 后注入。
 * 渲染端一旦首次调用 frp:status，会自动接 sink；主进程可在 registerIpc 内调用一次 installFrpEventBridge(getWin)。
 */
export function installFrpEventBridge(getWin: () => Electron.BrowserWindow | null): void {
  frpController.setSink((event: FrpEvent) => {
    getWin()?.webContents.send(FRP_IPC.event, event)
  })
}

export type { FrpEvent, FrpConfig, FrpState }