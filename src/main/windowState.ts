import { app, screen, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'

export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

const stateFile = () => join(app.getPath('userData'), 'window-state.json')

/** 上次关闭时的窗口状态；无记录/损坏/窗口整体在屏幕外时返回 null（回落到默认尺寸） */
export function loadWindowState(): WindowState | null {
  try {
    const raw = readFileSync(stateFile(), 'utf-8')
    const s = JSON.parse(raw) as WindowState
    if (typeof s?.width !== 'number' || typeof s?.height !== 'number') return null
    if (typeof s.x === 'number' && typeof s.y === 'number') {
      const onScreen = screen.getAllDisplays().some((d) => {
        const wa = d.workArea
        return (
          s.x! < wa.x + wa.width - 40 &&
          s.x! + s.width > wa.x + 40 &&
          s.y! >= wa.y - 20 &&
          s.y! < wa.y + wa.height - 40
        )
      })
      if (!onScreen) return { width: s.width, height: s.height, maximized: s.maximized }
    }
    return s
  } catch {
    return null
  }
}

/** 防抖持久化窗口 bounds（resize/move/最大化变化），关闭时立即写一次 */
export function trackWindowState(win: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const save = () => {
    if (win.isDestroyed()) return
    try {
      const b = win.getNormalBounds()
      writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }))
    } catch {
      /* 用户数据目录不可写时忽略 */
    }
  }
  const debounce = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      save()
    }, 500)
  }
  win.on('resize', debounce)
  win.on('move', debounce)
  win.on('maximize', debounce)
  win.on('unmaximize', debounce)
  win.on('close', save)
}
