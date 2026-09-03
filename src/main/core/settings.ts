/**
 * 设置持久化：userData/settings.json
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Settings } from '../../shared/types'
import { DEFAULT_CUSTOM_THEME, DEFAULT_MS_CLIENT_ID } from '../../shared/types'

let cached: Settings | null = null

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

function defaults(): Settings {
  return {
    gameDir: path.join(app.getPath('appData'), '.kamucl'),
    javaPath: '',
    javaAuto: true,
    memoryMB: 4096,
    jvmArgs: '',
    resolution: { width: 854, height: 480, fullscreen: false },
    mirror: 'bmclapi',
    defaultIsolation: true,
    msClientId: DEFAULT_MS_CLIENT_ID,
    theme: 'light',
    custom: structuredClone(DEFAULT_CUSTOM_THEME),
    closeAfterLaunch: false
  }
}

/** 读取设置（带内存缓存），文件不存在/损坏时返回默认值 */
export function getSettings(): Settings {
  if (cached) return cached
  const def = defaults()
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf-8')) as Partial<Settings>
    cached = {
      ...def,
      ...raw,
      resolution: { ...def.resolution, ...(raw.resolution ?? {}) },
      custom: {
        colors: { ...def.custom.colors, ...(raw.custom?.colors ?? {}) },
        layout: { ...def.custom.layout, ...(raw.custom?.layout ?? {}) }
      }
    }
    // 迁移：旧版默认 client_id（Mojang legacy 应用，不支持 device code）→ 新默认
    if (cached.msClientId === '00000000402b5328') cached.msClientId = def.msClientId
  } catch {
    cached = def
  }
  return cached
}

/** 合并 patch 并写盘，返回合并后的完整 Settings */
export function saveSettings(patch: Partial<Settings>): Settings {
  const cur = getSettings()
  const merged: Settings = {
    ...cur,
    ...patch,
    resolution: { ...cur.resolution, ...(patch.resolution ?? {}) },
    custom: {
      colors: { ...cur.custom.colors, ...(patch.custom?.colors ?? {}) },
      layout: { ...cur.custom.layout, ...(patch.custom?.layout ?? {}) }
    }
  }
  cached = merged
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
    fs.writeFileSync(settingsFile(), JSON.stringify(merged, null, 2), 'utf-8')
  } catch (e) {
    console.error('[KAMUCL] 设置写入失败:', e)
  }
  return merged
}
