import { nativeTheme, type BrowserWindow } from 'electron'
import type { Settings } from '../shared/types'
import { launcherLog } from './core/launcherLog'

/** DWM 的染色也要跟随应用主题，否则浅色系统会在暗色页面下叠一层白灰色。 */
export function applyNativeAppearance(window: BrowserWindow | null, settings: Settings): void {
  const light = settings.theme === 'blue-white' || settings.theme === 'white-pink' ||
    (settings.theme === 'custom' && /^#[0-9a-f]{6}$/i.test(settings.custom.colors.bg) &&
      parseInt(settings.custom.colors.bg.slice(1, 3), 16) * .299 +
      parseInt(settings.custom.colors.bg.slice(3, 5), 16) * .587 +
      parseInt(settings.custom.colors.bg.slice(5, 7), 16) * .114 > 128)
  nativeTheme.themeSource = light ? 'light' : 'dark'
  if (!window || window.isDestroyed()) return
  if (process.platform === 'win32') {
    try { window.setBackgroundMaterial('acrylic') }
    catch (error) { launcherLog(`Desktop acrylic unavailable: ${String(error)}`) }
  }
}
