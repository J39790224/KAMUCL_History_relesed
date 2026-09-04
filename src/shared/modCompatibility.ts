import type { InstalledVersion, LoaderName, ModInfo } from './types'

export function normalizeLoader(value: unknown): LoaderName | undefined {
  const key = String(value ?? '').trim().toLowerCase().replace(/[-_\s]/g, '')
  return ({ neoforge: 'neoforge', neoforged: 'neoforge', forge: 'forge', fabric: 'fabric', fabricloader: 'fabric', quilt: 'quilt', quiltloader: 'quilt' } as Record<string, LoaderName>)[key]
}

export function normalizeLoaderVersion(value: string, loader?: LoaderName, mc?: string): string {
  let version = value.trim().replace(/^(?:neoforge|forge|fabric(?:-loader)?|quilt(?:-loader)?)[\s:_-]+/i, '').replace(/^v(?=\d)/i, '')
  if (loader === 'forge' && mc && version.startsWith(mc + '-')) version = version.slice(mc.length + 1)
  return version
}

/** Numeric components are not limited to semver's three fields (e.g. NeoForge 26.2.0.66).
 * Unknown/non-numeric versions remain distinct, never coerced to zero. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => /^(\d+(?:\.\d+)*)(?:-([^+]+))?(?:\+.*)?$/.exec(v.trim())
  const x = parse(a), y = parse(b)
  if (!x || !y) return a === b ? 0 : a < b ? -1 : 1
  const xs = x[1].split('.').map(Number), ys = y[1].split('.').map(Number)
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const d = (xs[i] ?? 0) - (ys[i] ?? 0)
    if (d) return Math.sign(d)
  }
  if (!x[2] || !y[2]) return x[2] === y[2] ? 0 : x[2] ? -1 : 1
  const xp = x[2].split(/[.-]/), yp = y[2].split(/[.-]/)
  for (let i = 0; i < Math.max(xp.length, yp.length); i++) {
    const p = xp[i], q = yp[i]
    if (p === q) continue
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q)
    if (pn && qn) return Math.sign(Number(p) - Number(q))
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

function predicate(range: string, version: string): boolean {
  if (range === '*') return true
  const m = /^(>=|<=|>|<|=|~|\^)?([^\s,()[\]]+)$/.exec(range)
  if (!m) return false
  const op = m[1] ?? '=', base = m[2]
  const parts = base.split('.')
  const wild = parts.findIndex(p => /^(x|\*)$/i.test(p))
  if (wild >= 0) return op === '=' && parts.slice(wild).every(p => /^(x|\*)$/i.test(p)) && parts.slice(0, wild).every((p, i) => p === version.split('.')[i])
  const c = compareVersions(version, base)
  if (op === '=') return c === 0
  if (op === '>') return c > 0
  if (op === '>=') return c >= 0
  if (op === '<') return c < 0
  if (op === '<=') return c <= 0
  if (!/^\d+(?:\.\d+)*(?:-[\w.-]+)?$/.test(base)) return false
  const nums = base.split('-')[0].split('.').map(Number)
  const index = op === '~' ? Math.min(1, nums.length - 1) : Math.max(0, nums.findIndex(n => n !== 0) < 0 ? nums.length - 1 : nums.findIndex(n => n !== 0))
  const upper = nums.slice(0, index + 1)
  upper[index]++
  return c >= 0 && compareVersions(version, upper.join('.')) < 0
}

/** Maven interval unions, Fabric/Quilt OR alternatives and AND predicates.
 * A comma inside an interval is NEVER an alternative separator. Malformed ranges fail closed. */
export function matchesVersionRange(range: string, version: string): boolean {
  const r = (range ?? '').trim()
  if (!version || version === '未知') return false
  if (!r || r === '*') return true
  if (r.includes('||')) return r.split('||').some(part => !!part.trim() && matchesVersionRange(part, version))
  if (/^[[(]/.test(r)) {
    const intervals = r.match(/[[(][^()[\]]*[)\]]/g)
    if (!intervals || intervals.join(',').replace(/\s/g, '') !== r.replace(/\s/g, '')) return false
    return intervals.some(interval => {
      const body = interval.slice(1, -1).trim()
      if (!body.includes(',')) return interval[0] === '[' && interval.endsWith(']') && !!body && compareVersions(version, body) === 0
      const bounds = body.split(',').map(s => s.trim())
      if (bounds.length !== 2 || (!bounds[0] && !bounds[1])) return false
      const [lo, hi] = bounds
      if (lo && hi && compareVersions(lo, hi) > 0) return false
      const low = lo ? compareVersions(version, lo) : 1
      const high = hi ? compareVersions(version, hi) : -1
      return (low > 0 || low === 0 && interval[0] === '[') && (high < 0 || high === 0 && interval.endsWith(']'))
    })
  }
  return r.replace(/(>=|<=|>|<|=|~|\^)\s+/g, '$1').split(/\s+/).every(part => predicate(part, version))
}

/** Metadata arrays express OR, not comma-delimited Maven intervals. */
export function dependencyRange(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(dependencyRange).join(' || ')
  if (value == null) return ''
  return '!unsupported-range!'
}

export function modMatchesInstance(mod: Pick<ModInfo, 'loader' | 'mcRange' | 'loaderRange' | 'error'>, instance: InstalledVersion): boolean {
  const loader = normalizeLoader(instance.loader)
  if (mod.error || instance.failed || instance.incomplete || !loader || loader !== normalizeLoader(mod.loader)) return false
  return matchesVersionRange(mod.mcRange, instance.mcVersion) && (!mod.loaderRange || matchesVersionRange(mod.loaderRange, normalizeLoaderVersion(instance.loaderVersion ?? '', loader, instance.mcVersion)))
}

/** A version ID is only unique INSIDE one registered game folder. */
export const instanceKey = (instance: Pick<InstalledVersion, 'id' | 'folder'>): string => JSON.stringify([instance.folder ?? '', instance.id])
