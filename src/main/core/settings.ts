/**
 * 设置持久化：userData/settings.json
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Settings } from '../../shared/types'
import {
  DEFAULT_BACKGROUND,
  DEFAULT_CUSTOM_THEME,
  DEFAULT_HOME_LAYOUT,
  DEFAULT_MS_CLIENT_ID,
  normalizeThemeName
} from '../../shared/types'
import {
  assertValidResolution,
  normalizeStoredResolution,
  resolutionValidationError
} from './gameWindow'

let cached: Settings | null = null

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

function defaults(): Settings {
  const gameDir = path.join(app.getPath('appData'), '.kamucl')
  return {
    gameDir,
    folders: [{ path: gameDir, name: '默认文件夹', isDefault: true }],
    activeFolder: gameDir,
    javaPath: '',
    javaAuto: true,
    javaCustom: [],
    javaHidden: [],
    memoryMB: 4096,
    jvmArgs: '',
    resolution: { width: 854, height: 480, mode: 'windowed', fullscreen: false },
    mirror: 'bmclapi',
    defaultIsolation: true,
    msClientId: DEFAULT_MS_CLIENT_ID,
    theme: 'blue-white',
    custom: structuredClone(DEFAULT_CUSTOM_THEME),
    disabledFeatures: [],
    favoriteVersions: [],
    homeLayout: structuredClone(DEFAULT_HOME_LAYOUT),
    background: structuredClone(DEFAULT_BACKGROUND),
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
      },
      homeLayout: {
        main: Array.isArray(raw.homeLayout?.main) ? raw.homeLayout.main : def.homeLayout.main,
        side: Array.isArray(raw.homeLayout?.side) ? raw.homeLayout.side : def.homeLayout.side
      },
      background: { ...def.background, ...(raw.background ?? {}) },
      // 兼容旧配置：无 folders 时由 gameDir 迁移为唯一默认文件夹
      folders:
        Array.isArray(raw.folders) && raw.folders.length
          ? raw.folders
          : def.folders,
      activeFolder:
        raw.activeFolder ||
        raw.gameDir ||
        def.activeFolder
    }
    const c = cached
    c.theme = normalizeThemeName(raw.theme)
    const migratedResolution = normalizeStoredResolution(c.resolution, def.resolution)
    c.resolution = resolutionValidationError(migratedResolution)
      ? def.resolution
      : migratedResolution
    // 迁移：旧版默认 client_id（Mojang legacy 应用，不支持 device code）→ 新默认
    if (c.msClientId === '00000000402b5328') c.msClientId = def.msClientId
    // 保证 activeFolder 指向已登记文件夹；gameDir 与 activeFolder 保持一致语义
    if (!c.folders.some((f) => f.path === c.activeFolder)) {
      c.activeFolder = c.folders.find((f) => f.isDefault)?.path ?? c.folders[0].path
    }
    c.gameDir = c.activeFolder
    cached = c
  } catch {
    cached = def
  }
  return cached
}

/** 合并 patch 并写盘，返回合并后的完整 Settings */
export function saveSettings(patch: Partial<Settings>): Settings {
  const cur = getSettings()
  let nextResolution = cur.resolution
  if (patch.resolution) {
    const requested = { ...cur.resolution, ...patch.resolution }
    assertValidResolution(requested)
    nextResolution = normalizeStoredResolution(
      requested,
      cur.resolution
    )
  }
  const merged: Settings = {
    ...cur,
    ...patch,
    resolution: nextResolution,
    custom: {
      colors: { ...cur.custom.colors, ...(patch.custom?.colors ?? {}) },
      layout: { ...cur.custom.layout, ...(patch.custom?.layout ?? {}) }
    },
    homeLayout: {
      main: Array.isArray(patch.homeLayout?.main) ? patch.homeLayout.main : cur.homeLayout.main,
      side: Array.isArray(patch.homeLayout?.side) ? patch.homeLayout.side : cur.homeLayout.side
    },
    background: { ...cur.background, ...(patch.background ?? {}) }
  }
  // activeFolder 与 gameDir 语义一致：改其一跟随另一个
  if (patch.activeFolder && merged.folders.some((f) => f.path === patch.activeFolder)) {
    merged.gameDir = patch.activeFolder
  } else if (patch.gameDir) {
    merged.activeFolder = patch.gameDir
    if (!merged.folders.some((f) => f.path === patch.gameDir)) {
      merged.folders = [
        ...merged.folders,
        { path: patch.gameDir, name: path.basename(patch.gameDir), isDefault: false }
      ]
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
