// electron 模块垫片：让 src/main/core/* 的 TS 模块可在 node(tsx) 下运行
import path from 'node:path'
import os from 'node:os'

const appData = path.join(os.homedir(), 'AppData', 'Roaming')
export const app = {
  getPath(name: string): string {
    if (name === 'userData') return path.join(appData, 'kamucl')
    if (name === 'appData') return appData
    if (name === 'temp' || name === 'tmp') return os.tmpdir()
    return appData
  },
  getVersion: () => '0.0.0-harness',
  getName: () => 'kamucl'
}
export const ipcMain = { handle: () => undefined, on: () => undefined }
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
export const shell = { openPath: async () => '', showItemInFolder: () => undefined, openExternal: async () => undefined }
export class BrowserWindow {}
export default { app, ipcMain, dialog, shell, BrowserWindow }
