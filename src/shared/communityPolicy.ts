import type { CommunityFile, InstalledVersion, LoaderName } from './types'
import { compareVersions, normalizeLoader } from './modCompatibility'

export function matchesCommunityFilter(file: CommunityFile, filter: { mcVersion?: string; loader?: LoaderName | '' }): boolean {
  return (!filter.mcVersion || file.gameVersions.some(v => compareVersions(v, filter.mcVersion!) === 0)) &&
    (!filter.loader || file.loaders.some(l => normalizeLoader(l) === normalizeLoader(filter.loader)))
}

export function communityFileMatchesInstance(file: CommunityFile, instance: InstalledVersion): boolean {
  return !instance.failed && !instance.incomplete && !!instance.loader &&
    matchesCommunityFilter(file, { mcVersion: instance.mcVersion, loader: instance.loader })
}
