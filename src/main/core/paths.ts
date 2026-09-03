/**
 * 目录拼接工具：所有路径基于 settings.gameDir
 */
import path from 'node:path'
import { getSettings } from './settings'

/** 游戏根目录 */
export function gameDir(): string {
  return getSettings().gameDir
}

export function versionsDir(): string {
  return path.join(gameDir(), 'versions')
}

export function versionDir(id: string): string {
  return path.join(versionsDir(), id)
}

export function versionJsonPath(id: string): string {
  return path.join(versionDir(id), `${id}.json`)
}

export function versionJarPath(id: string): string {
  return path.join(versionDir(id), `${id}.jar`)
}

export function nativesDir(id: string): string {
  return path.join(versionDir(id), 'natives')
}

/** 安装事务标记文件路径（存在 = 安装未完成/失败） */
export function installMarkPath(id: string): string {
  return path.join(versionDir(id), '.installing')
}

export function librariesDir(): string {
  return path.join(gameDir(), 'libraries')
}

/** rel 为 maven 风格的相对路径（正斜杠），Windows 下混合分隔符也可正常使用 */
export function libraryPath(rel: string): string {
  return path.join(librariesDir(), rel)
}

export function assetsDir(): string {
  return path.join(gameDir(), 'assets')
}

export function assetIndexPath(indexId: string): string {
  return path.join(assetsDir(), 'indexes', `${indexId}.json`)
}

export function assetObjectPath(hash: string): string {
  return path.join(assetsDir(), 'objects', hash.slice(0, 2), hash)
}

/** legacy 版本的虚拟资源目录（assets/virtual/legacy） */
export function virtualLegacyDir(): string {
  return path.join(assetsDir(), 'virtual', 'legacy')
}

export function runtimesDir(): string {
  return path.join(gameDir(), 'runtimes')
}
