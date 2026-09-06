/**
 * voxlink/settings.ts — 应用端设置持久化（移植自 voxlink/app-desktop/settings.go）
 *
 * 文件位置：userData/voxlink-settings.json
 * 字段：{ allowRelay: boolean, theme?: string }（serverUrl 忽略，写死默认）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { DEFAULT_SERVER_URL } from './api'

export interface VoxlinkSettings {
  allowRelay: boolean
  theme: string
}

export function defaultSettings(): VoxlinkSettings {
  return { allowRelay: true, theme: 'light' }
}

export function defaultSettingsPath(): string {
  // userData 下，跨平台稳定
  return path.join(app.getPath('userData'), 'voxlink-settings.json')
}

export function loadSettings(settingsPath = defaultSettingsPath()): VoxlinkSettings {
  const s = defaultSettings()
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8')
    const obj = JSON.parse(raw) as Partial<VoxlinkSettings>
    if (typeof obj.allowRelay === 'boolean') s.allowRelay = obj.allowRelay
    if (typeof obj.theme === 'string' && obj.theme) s.theme = obj.theme
  } catch {
    // 缺失/损坏 → 回落默认值
  }
  return s
}

export function saveSettings(settings: VoxlinkSettings, settingsPath = defaultSettingsPath()): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8')
}

export function getServerURL(): string {
  return DEFAULT_SERVER_URL
}