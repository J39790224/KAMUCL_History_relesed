import fs from 'node:fs'
import path from 'node:path'
import type { FolderScanResult, GameFolder } from '../../shared/types'
import { getSettings, saveSettings } from './settings'
import { canonicalPath, pathIdentity, resolveMinecraftRoot } from './folderPaths'
import { scanInstalledFolder } from './versions'

const cleanName = (value: string): string => {
  const name = value.trim()
  if (!name) throw new Error('显示名称不能为空')
  if (name.length > 64) throw new Error('显示名称最多 64 个字符')
  return name
}

function normalizedFolders(): GameFolder[] {
  const current = getSettings().folders
  const seen = new Set<string>()
  const result: GameFolder[] = []
  for (const folder of current) {
    const resolved = canonicalPath(folder.path)
    const identity = pathIdentity(resolved)
    if (seen.has(identity)) continue
    seen.add(identity)
    result.push({ ...folder, path: resolved })
  }
  if (result.length && !result.some((folder) => folder.isDefault)) result[0].isDefault = true
  if (result.filter((folder) => folder.isDefault).length > 1) {
    let found = false
    for (const folder of result) {
      if (folder.isDefault && !found) found = true
      else folder.isDefault = false
    }
  }
  return result
}

function persistFolders(folders: GameFolder[], active?: string): GameFolder[] {
  const current = getSettings()
  const activeFolder = active ?? current.activeFolder
  const selected = folders.find((folder) => pathIdentity(folder.path) === pathIdentity(activeFolder))
  const fallback = folders.find((folder) => folder.isDefault) ?? folders[0]
  saveSettings({
    folders,
    activeFolder: selected?.path ?? fallback.path,
    gameDir: selected?.path ?? fallback.path
  })
  return folders
}

export function listGameFolders(): { folders: GameFolder[]; active: string } {
  const current = getSettings()
  const folders = normalizedFolders()
  const selected = folders.find(
    (folder) => pathIdentity(folder.path) === pathIdentity(current.activeFolder)
  )
  const active = selected?.path ?? folders.find((folder) => folder.isDefault)?.path ?? folders[0].path
  const changed =
    folders.length !== current.folders.length ||
    active !== current.activeFolder ||
    folders.some((folder, index) =>
      folder.path !== current.folders[index]?.path ||
      folder.name !== current.folders[index]?.name ||
      folder.isDefault !== current.folders[index]?.isDefault
    )
  if (changed) persistFolders(folders, active)
  return { folders, active }
}

export function addGameFolder(input: string): { folders: GameFolder[]; folder: GameFolder; structure: FolderScanResult['structure'] } {
  const resolved = resolveMinecraftRoot(input)
  const current = listGameFolders()
  const duplicate = current.folders.find(
    (folder) => pathIdentity(folder.path) === pathIdentity(resolved.path)
  )
  if (duplicate) return { folders: current.folders, folder: duplicate, structure: resolved.structure }
  const folder: GameFolder = {
    path: resolved.path,
    name: path.basename(resolved.path) || resolved.path,
    isDefault: false
  }
  return {
    folders: persistFolders([...current.folders, folder]),
    folder,
    structure: resolved.structure
  }
}

export function renameGameFolder(input: string, displayName: string): GameFolder[] {
  const identity = pathIdentity(input)
  const name = cleanName(displayName)
  const current = listGameFolders()
  if (!current.folders.some((folder) => pathIdentity(folder.path) === identity)) {
    throw new Error('文件夹未登记')
  }
  return persistFolders(
    current.folders.map((folder) =>
      pathIdentity(folder.path) === identity ? { ...folder, name } : folder
    ),
    current.active
  )
}

/** 只解除登记，不删除磁盘中的任何文件。 */
export function removeGameFolder(input: string): GameFolder[] {
  const identity = pathIdentity(input)
  const current = listGameFolders()
  const target = current.folders.find((folder) => pathIdentity(folder.path) === identity)
  if (!target) throw new Error('文件夹未登记')
  if (current.folders.length <= 1) throw new Error('至少需要保留一个游戏文件夹')
  const folders = current.folders.filter((folder) => pathIdentity(folder.path) !== identity)
  if (target.isDefault) folders[0] = { ...folders[0], isDefault: true }
  const nextActive =
    pathIdentity(current.active) === identity
      ? (folders.find((folder) => folder.isDefault) ?? folders[0]).path
      : current.active
  return persistFolders(folders, nextActive)
}

export function setDefaultGameFolder(input: string): GameFolder[] {
  const identity = pathIdentity(input)
  const current = listGameFolders()
  if (!current.folders.some((folder) => pathIdentity(folder.path) === identity)) {
    throw new Error('文件夹未登记')
  }
  return persistFolders(
    current.folders.map((folder) => ({
      ...folder,
      isDefault: pathIdentity(folder.path) === identity
    })),
    current.active
  )
}

export function setActiveGameFolder(input: string): string {
  const identity = pathIdentity(input)
  const current = listGameFolders()
  const folder = current.folders.find((value) => pathIdentity(value.path) === identity)
  if (!folder) throw new Error('文件夹未登记')
  if (!fs.existsSync(folder.path)) throw new Error('文件夹已不存在，请重新连接或解除绑定')
  persistFolders(current.folders, folder.path)
  return folder.path
}

export function scanGameFolder(input: string): FolderScanResult {
  const started = Date.now()
  const current = listGameFolders()
  const identity = pathIdentity(input)
  const folder = current.folders.find((value) => pathIdentity(value.path) === identity)
  if (!folder) throw new Error('文件夹未登记')
  if (!fs.existsSync(folder.path)) {
    return {
      folder,
      structure: 'missing',
      status: 'error',
      versions: [],
      errors: ['文件夹不存在或磁盘当前不可用'],
      scannedAt: new Date().toISOString(),
      durationMs: Date.now() - started
    }
  }
  const structure = fs.existsSync(path.join(folder.path, '.kamucl'))
    ? 'kamucl'
    : fs.existsSync(path.join(folder.path, 'versions'))
      ? 'minecraft'
      : 'empty'
  const scanned = scanInstalledFolder(folder.path)
  return {
    folder,
    structure,
    status: scanned.errors.length ? 'warning' : 'ready',
    versions: scanned.versions,
    errors: scanned.errors,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started
  }
}
