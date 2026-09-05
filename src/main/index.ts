import { app, BrowserWindow, crashReporter, shell, ipcMain, net, protocol } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createStartupSplash } from './startupSplash'
import { authorizeManagedImage } from './core/appearanceAssets'
import { initializeLauncherLog, launcherLog } from './core/launcherLog'
import { getSettings, migrateLegacyAppearanceAssets } from './core/settings'
import { windowAppearance } from './windowAppearance'
import { applyNativeAppearance } from './nativeAppearance'
import { loadWindowState, trackWindowState } from './windowState'
import { stopDirectHost } from './core/directConnect'

// 启动日志尽 earliest 初始化：闪退发生在 app.whenReady 之前时也有据可查
try {
  initializeLauncherLog()
  launcherLog('Main process module loaded')
} catch {
  /* 日志不可影响启动 */
}

// 崩溃取证：minidump 落到 userData/Crashpad（不上传），配合 launcher-current.log 定位闪退
try {
  crashReporter.start({ uploadToServer: false, compress: false })
} catch {
  /* crashReporter 初始化失败不阻断 */
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'kamucl-asset',
    // 仅供 <img>/CSS 读取，不开放 renderer fetch，缩小本地资源协议的攻击面。
    privileges: { standard: true, secure: true, stream: true }
  }
])

let win: BrowserWindow | null = null

function createWindow(startup?: ReturnType<typeof createStartupSplash>): void {
  applyNativeAppearance(null, getSettings())
  const windowState = loadWindowState()
  win = new BrowserWindow({
    ...windowAppearance(),
    ...(windowState
      ? { width: windowState.width, height: windowState.height, x: windowState.x, y: windowState.y }
      : {}),
    icon: join(__dirname, '../../build/icon.png'),
    show: false,
    title: 'KAMUCL',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  if (windowState?.maximized) win.maximize()

  // Electron 33 会把 backgroundMaterial 交给 DWM；显式重设一次可覆盖部分
  // Windows 恢复窗口状态时丢失材质的情况。旧版 Windows 会安全忽略该调用。
  if (process.platform === 'win32') {
    try {
      win.setBackgroundMaterial('acrylic')
    } catch (error) {
      launcherLog(
        `Acrylic material unavailable, using translucent fallback: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  if (startup) startup.attach(win)
  else   win.on('ready-to-show', () => win?.show())
  applyNativeAppearance(win, getSettings())
  trackWindowState(win)
  // 渲染进程崩溃/无响应取证（25h2 GPU 崩溃常见前兆），现有 splash 处理只覆盖初始化期
  win.webContents.on('render-process-gone', (_event, details) => {
    try {
      launcherLog(`[CRASH] Renderer gone: reason=${details.reason} exitCode=${details.exitCode}`)
    } catch {
      /* 忽略 */
    }
  })
  win.webContents.on('unresponsive', () => {
    try {
      launcherLog('[CRASH] Renderer unresponsive')
    } catch {
      /* 忽略 */
    }
  })
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

app.whenReady().then(async () => {
  initializeLauncherLog()
  launcherLog('Electron ready')
  const startup = createStartupSplash()
  const { registerIpc } = await import('./ipc')
  try {
    await migrateLegacyAppearanceAssets()
  } catch (error) {
    launcherLog(
      `Appearance asset migration failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  protocol.handle('kamucl-asset', (request) => {
    if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
    try {
      const candidate = new URL(request.url).searchParams.get('path') ?? ''
      const authorized = authorizeManagedImage(
        candidate,
        getSettings().folders.map((folder) => folder.path)
      )
      if (!authorized) return new Response('Not Found', { status: 404 })
      return net.fetch(pathToFileURL(authorized).toString())
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  })
  registerIpc(() => win)

  // 存量实例自包含迁移（老式 inheritsFrom 继承 → 合并进实例，幂等）：基础版本改名/删除不再波及已装实例
  void import('./core/versions').then(({ migrateFlattenedInstances }) =>
    migrateFlattenedInstances((m) => launcherLog(`[迁移] ${m}`)).then((n) => {
      if (n > 0) launcherLog(`[迁移] 共 ${n} 个旧式继承实例已合并为自包含实例`)
    })
  )

  ipcMain.on('window:minimize', () => win?.minimize())
  ipcMain.on('window:maximize', () => (win?.isMaximized() ? win?.unmaximize() : win?.maximize()))
  ipcMain.on('window:close', () => win?.close())

  createWindow(startup)
  launcherLog('Main window created')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // 仅清理由好友直连创建的本机监听器和短租约；不影响 Minecraft 生命周期。
  void stopDirectHost()
  launcherLog('All windows closed')
  if (process.platform !== 'darwin') app.quit()
})

// ---------------- 崩溃取证（win11 25h2 概率闪退排查） ----------------
// 主进程未捕获异常：记录完整堆栈并保持进程存活（活着 > 闪退；日志可回溯）
process.on('uncaughtException', (error) => {
  try {
    launcherLog(`[CRASH] Uncaught exception: ${error.stack ?? error.message}`)
  } catch {
    /* 日志失败不追加崩溃 */
  }
})
process.on('unhandledRejection', (reason) => {
  try {
    launcherLog(`[CRASH] Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`)
  } catch {
    /* 同上 */
  }
})
// 子进程（GPU/渲染/网络等）异常退出记录：25h2 上 GPU 进程崩溃是常见闪退前兆
app.on('child-process-gone', (_event, details) => {
  try {
    launcherLog(`[CRASH] Child process gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`)
  } catch {
    /* 同上 */
  }
})
app.on('quit', () => {
  try {
    launcherLog('App quit')
  } catch {
    /* 忽略 */
  }
})
