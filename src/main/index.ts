import { app, BrowserWindow, shell, ipcMain } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { initializeLauncherLog, launcherLog } from './core/launcherLog'

let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1120,
    height: 700,
    minWidth: 960,
    minHeight: 620,
    frame: false,
    backgroundColor: '#0d0f14',
    icon: join(__dirname, '../../build/icon.png'),
    show: false,
    title: 'KAMUCL',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  initializeLauncherLog()
  launcherLog('Electron ready')
  registerIpc(() => win)

  ipcMain.on('window:minimize', () => win?.minimize())
  ipcMain.on('window:maximize', () => (win?.isMaximized() ? win?.unmaximize() : win?.maximize()))
  ipcMain.on('window:close', () => win?.close())

  createWindow()
  launcherLog('Main window created')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  launcherLog('All windows closed')
  if (process.platform !== 'darwin') app.quit()
})

process.on('uncaughtExceptionMonitor', (error) => {
  launcherLog(`Uncaught exception: ${error.name}: ${error.message}`)
})
process.on('unhandledRejection', (reason) => {
  launcherLog(`Unhandled rejection: ${reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)}`)
})
