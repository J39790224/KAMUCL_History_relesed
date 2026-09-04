import type { VersionJson } from './versions'
import { normalizeLoader, normalizeLoaderVersion } from '../../shared/modCompatibility'
import type { LoaderName } from '../../shared/types'

/** Read actual launch metadata. Folder/display names are deliberately not an input. */
export function resolveInstanceMetadata(json: VersionJson, readParent: (id: string) => VersionJson | undefined): {
  mcVersion: string; loader?: LoaderName; loaderVersion?: string; broken: boolean
} {
  const chain: VersionJson[] = [json]
  const seen = new Set<string>([json.id])
  let broken = false
  while (chain.at(-1)?.inheritsFrom) {
    const id = chain.at(-1)!.inheritsFrom!
    if (seen.has(id) || chain.length >= 16 || /[\\/]/.test(id) || id === '..') { broken = true; break }
    seen.add(id)
    const parent = readParent(id)
    if (!parent) { broken = true; break }
    chain.push(parent)
  }
  const args = chain.flatMap(j => [
    ...(j.arguments?.game ?? []).flatMap(a => typeof a === 'string' ? [a] : typeof a.value === 'string' ? [a.value] : a.value),
    ...(j.minecraftArguments?.match(/"[^"]*"|\S+/g) ?? []).map(a => a.replace(/^"|"$/g, ''))
  ])
  const arg = (name: string): string | undefined => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : args.find(a => a.startsWith(name + '='))?.slice(name.length + 1)
  }
  const libraries = chain.flatMap(j => (j.libraries ?? []).map(l => (l.name ?? '').split(':')))
  const lib = (group: string, artifact: string) => libraries.find(l => l[0] === group && l[1] === artifact)?.[2]
  const detected = lib('net.neoforged', 'neoforge') ? 'neoforge' : lib('net.minecraftforge', 'forge') ? 'forge'
    : lib('net.fabricmc', 'fabric-loader') ? 'fabric' : lib('org.quiltmc', 'quilt-loader') ? 'quilt' : undefined
  const main = chain.map(j => j.mainClass ?? '').join(' ').toLowerCase()
  const loader = normalizeLoader(chain.find(j => j._loader)?._loader) ?? detected ?? (main.includes('neoforged') ? 'neoforge' : main.includes('minecraftforge') ? 'forge' : main.includes('fabricmc') ? 'fabric' : main.includes('quiltmc') ? 'quilt' : undefined)
  const forge = lib('net.minecraftforge', 'forge')
  const base = chain.at(-1)!
  // Mojang's id in a vanilla profile is metadata; an opaque flattened modpack id is not an MC version.
  const vanillaId = !base.inheritsFrom && (!loader || chain.length > 1) ? base.id : undefined
  const mcVersion = chain.find(j => j._mcVersion)?._mcVersion ?? arg('--fml.mcVersion') ?? chain.find(j => j.clientVersion)?.clientVersion ?? lib('net.fabricmc', 'intermediary') ?? lib('org.quiltmc', 'hashed') ?? forge?.split('-')[0] ?? vanillaId ?? '未知'
  const rawLoader = chain.find(j => j._loaderVersion)?._loaderVersion ?? (loader === 'neoforge' ? lib('net.neoforged', 'neoforge') ?? arg('--fml.neoForgeVersion') : loader === 'forge' ? forge ?? arg('--fml.forgeVersion') : loader === 'fabric' ? lib('net.fabricmc', 'fabric-loader') : loader === 'quilt' ? lib('org.quiltmc', 'quilt-loader') : undefined)
  return { mcVersion, loader, loaderVersion: rawLoader ? normalizeLoaderVersion(rawLoader, loader, mcVersion) : undefined, broken }
}
