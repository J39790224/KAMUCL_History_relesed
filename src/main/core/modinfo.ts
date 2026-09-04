/**
 * MOD 元数据解析：读取 jar 内 fabric.mod.json / quilt.mod.json /
 * neoforge.mods.toml / mods.toml / mcmod.info，提取名称、版本、
 * 加载器类型、MC 版本范围、前置依赖与图标。
 */
import { dependencyRange } from '../../shared/modCompatibility'
import fs from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'
import type { LoaderName, ModCrossDuplicate, ModDuplicateGroup, ModInfo } from '../../shared/types'
import { readVersionJson } from './versions'
import { instanceDirectoryState } from './instances'

// ---------------- TOML 极简解析（按行，仅够提取 mods.toml 字段） ----------------

interface TomlModSection {
  modId?: string
  displayName?: string
  version?: string
  logoFile?: string
}
interface TomlDepSection {
  modId?: string
  versionRange?: string
  mandatory?: boolean
}

function unquote(s: string): string {
  const m = /^\s*"(.*)"\s*$/.exec(s.trim())
  return m ? m[1] : s.trim()
}

/** 解析 mods.toml：收集 [[mods]] 与 [[dependencies.X]] 段 */
function parseModsToml(text: string): { mods: TomlModSection[]; deps: TomlDepSection[] } {
  const mods: TomlModSection[] = []
  const deps: TomlDepSection[] = []
  let current: Record<string, string> | null = null
  let currentType: 'mod' | 'dep' | null = null
  const flush = (): void => {
    if (current && currentType === 'mod') mods.push(current as TomlModSection)
    else if (current && currentType === 'dep') deps.push(current as TomlDepSection)
    current = null
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const sec = /^\[\[(.+)\]\]$/.exec(line)
    if (sec) {
      flush()
      const name = sec[1]
      if (name === 'mods') {
        currentType = 'mod'
        current = {}
      } else if (name.startsWith('dependencies.')) {
        currentType = 'dep'
        current = {}
      } else {
        currentType = null
        current = null
      }
      continue
    }
    const kv = /^([A-Za-z_]+)\s*=\s*(.+)$/.exec(line)
    if (kv && current) current[kv[1]] = unquote(kv[2])
  }
  flush()
  // mandatory 是布尔裸值，unquote 后转回
  for (const d of deps) {
    if (typeof d.mandatory === 'string') {
      ;(d as { mandatory?: boolean }).mandatory = (d.mandatory as unknown as string) === 'true'
    }
  }
  return { mods, deps }
}

// ---------------- 版本范围匹配 ----------------

export { compareVersions as compareMcVersion, matchesVersionRange as matchMcRange } from '../../shared/modCompatibility'

/** 从范围声明中解析出下界（用于「自动下载最新兼容版本」的版本排序参考），无下界返回 '' */
export function rangeLowerBound(range: string): string {
  const m = /^[\[(]([^,]+),/.exec((range ?? '').trim())
  if (m) return m[1]
  const op = /^>=(.+)$/.exec(range.trim())
  if (op) return op[1]
  return ''
}

// ---------------- jar 解析 ----------------

function readEntryText(zip: AdmZip, name: string): string | null {
  const e = zip.getEntry(name)
  if (!e) return null
  try {
    return zip.readAsText(e)
  } catch {
    return null
  }
}

function readEntryDataUrl(zip: AdmZip, name: string): string | undefined {
  const e = zip.getEntry(name)
  if (!e) return undefined
  try {
    const buf = zip.readFile(e)
    if (!buf?.length || buf.length > 512 * 1024) return undefined
    return `data:image/png;base64,${buf.toString('base64')}`
  } catch {
    return undefined
  }
}

/** 解析单个 .jar 文件为 ModInfo（失败时 error 有值） */
export function parseModFile(filePath: string): ModInfo {
  const info: ModInfo = {
    filePath,
    fileName: path.basename(filePath),
    id: '',
    name: '',
    version: '',
    loader: null,
    mcRange: '',
    dependencies: []
  }
  let zip: AdmZip
  try {
    zip = new AdmZip(filePath)
  } catch {
    info.error = '文件损坏或不是有效的 jar 文件'
    return info
  }

  // ---- Fabric：fabric.mod.json ----
  const fabricText = readEntryText(zip, 'fabric.mod.json')
  if (fabricText) {
    try {
      const j = JSON.parse(fabricText) as {
        id?: string
        name?: string
        version?: string
        icon?: string
        depends?: Record<string, unknown>
      }
      info.loader = 'fabric'
      info.id = j.id ?? ''
      info.name = j.name ?? j.id ?? ''
      info.version = String(j.version ?? '')
      const dep = j.depends ?? {}
      info.mcRange = dependencyRange(dep.minecraft)
      info.loaderRange = dependencyRange(dep.fabricloader)
      info.dependencies = Object.keys(dep).filter(
        (k) => !['minecraft', 'fabricloader', 'fabric', 'java'].includes(k)
      )
      if (typeof j.icon === 'string') info.iconDataUrl = readEntryDataUrl(zip, j.icon)
      return info
    } catch {
      info.error = 'fabric.mod.json 解析失败（JSON 损坏）'
      return info
    }
  }

  // ---- Quilt：quilt.mod.json ----
  const quiltText = readEntryText(zip, 'quilt.mod.json')
  if (quiltText) {
    try {
      const j = JSON.parse(quiltText) as {
        quilt_loader?: {
          id?: string
          metadata?: { name?: string; icon?: string }
          version?: string
          depends?: Array<{ id?: string; versions?: unknown }>
        }
        minecraft?: { environment?: string }
        depends?: Record<string, unknown> | Array<{ id?: string; versions?: string }>
      }
      info.loader = 'quilt'
      const ql = j.quilt_loader ?? {}
      info.id = ql.id ?? ''
      info.name = ql.metadata?.name ?? ql.id ?? ''
      info.version = String(ql.version ?? '')
      const deps = ql.depends ?? j.depends
      if (Array.isArray(deps)) {
        const mc = deps.find((d) => d.id === 'minecraft')
        info.mcRange = dependencyRange(mc?.versions)
        const qld = deps.find((d) => d.id === 'quilt_loader')
        info.loaderRange = dependencyRange(qld?.versions)
        info.dependencies = deps
          .map((d) => d.id ?? '')
          .filter((id) => id && !['minecraft', 'quilt_loader', 'quilted_fabric_api', 'java'].includes(id))
      }
      const icon = ql.metadata?.icon
      if (typeof icon === 'string') info.iconDataUrl = readEntryDataUrl(zip, icon)
      return info
    } catch {
      info.error = 'quilt.mod.json 解析失败（JSON 损坏）'
      return info
    }
  }

  // ---- NeoForge：META-INF/neoforge.mods.toml ----
  const neoText = readEntryText(zip, 'META-INF/neoforge.mods.toml')
  if (neoText) {
    const { mods, deps } = parseModsToml(neoText)
    const m = mods[0]
    if (m) {
      info.loader = 'neoforge'
      info.id = m.modId ?? ''
      info.name = m.displayName ?? m.modId ?? ''
      info.version = (m.version ?? '').replace(/^"|"$/g, '')
      const mcDep = deps.find((d) => d.modId === 'minecraft')
      info.mcRange = mcDep?.versionRange ?? ''
      const loaderDep = deps.find((d) => d.modId === 'neoforge')
      info.loaderRange = loaderDep?.versionRange ?? ''
      info.dependencies = deps
        .filter((d) => d.modId && !['minecraft', 'neoforge', 'java'].includes(d.modId) && d.mandatory !== false)
        .map((d) => d.modId as string)
      if (m.logoFile) info.iconDataUrl = readEntryDataUrl(zip, m.logoFile)
      return info
    }
    info.error = 'neoforge.mods.toml 缺少 [[mods]] 段'
    return info
  }

  // ---- Forge（1.13+）：META-INF/mods.toml ----
  const forgeText = readEntryText(zip, 'META-INF/mods.toml')
  if (forgeText) {
    const { mods, deps } = parseModsToml(forgeText)
    const m = mods[0]
    if (m) {
      info.loader = deps.some(d => d.modId === 'neoforge') ? 'neoforge' : 'forge'
      info.id = m.modId ?? ''
      info.name = m.displayName ?? m.modId ?? ''
      info.version = (m.version ?? '').replace(/^"|"$/g, '')
      const mcDep = deps.find((d) => d.modId === 'minecraft')
      info.mcRange = mcDep?.versionRange ?? ''
      const loaderDep = deps.find((d) => d.modId === info.loader)
      info.loaderRange = loaderDep?.versionRange ?? ''
      info.dependencies = deps
        .filter((d) => d.modId && !['minecraft', 'forge', 'java'].includes(d.modId) && d.mandatory !== false)
        .map((d) => d.modId as string)
      if (m.logoFile) info.iconDataUrl = readEntryDataUrl(zip, m.logoFile)
      return info
    }
    info.error = 'mods.toml 缺少 [[mods]] 段'
    return info
  }

  // ---- 老 Forge（≤1.12）：mcmod.info ----
  const legacyText = readEntryText(zip, 'mcmod.info')
  if (legacyText) {
    try {
      const arr = JSON.parse(legacyText) as Array<{
        modid?: string
        name?: string
        version?: string
        mcversion?: string
        dependencies?: string[]
      }>
      const m = arr[0]
      if (m) {
        info.loader = 'forge'
        info.id = m.modid ?? ''
        info.name = m.name ?? m.modid ?? ''
        info.version = m.version ?? ''
        info.mcRange = m.mcversion ?? ''
        info.dependencies = m.dependencies ?? []
        return info
      }
    } catch {
      info.error = 'mcmod.info 解析失败（JSON 损坏）'
      return info
    }
  }

  info.error = '不是有效的 MOD 文件（未找到任何 MOD 元数据）'
  return info
}

/** 展开路径（文件/文件夹）为 .jar 文件列表；文件夹非递归只取一层 */
export function expandJarPaths(paths: string[]): { files: string[]; skipped: string[] } {
  const files: string[] = []
  const skipped: string[] = []
  for (const p of paths) {
    try {
      const st = fs.statSync(p)
      if (st.isDirectory()) {
        const jars = fs
          .readdirSync(p)
          .filter((n) => n.toLowerCase().endsWith('.jar'))
          .map((n) => path.join(p, n))
        if (jars.length) files.push(...jars)
        else skipped.push(`${path.basename(p)}（文件夹内无 .jar）`)
      } else if (p.toLowerCase().endsWith('.jar')) {
        files.push(p)
      } else {
        skipped.push(path.basename(p))
      }
    } catch {
      skipped.push(path.basename(p))
    }
  }
  return { files, skipped }
}

// ---------------- �ظ� MOD ���� ----------------

/** �汾 mods Ŀ¼����ѭ�汾���룩 */
function modsDirOf(versionId: string): string {
  return path.join(instanceDirectoryState(versionId, readVersionJson(versionId)).path, 'mods')
}

/** MOD �汾�űȽϣ����ֶαȽϣ����Ժ�׺�� */
function compareModVersion(a: string, b: string): number {
  const norm = (s: string): number[] =>
    s
      .replace(/[+_].*$/, '')
      .split(/[.-]/)
      .map((x) => parseInt(x, 10) || 0)
  const pa = norm(a)
  const pb = norm(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** ���汾���أ�ͬ mod id ���ļ����棬���汾�����������°� */
export function findDuplicates(versionId: string): ModDuplicateGroup[] {
  const dir = modsDirOf(versionId)
  let jars: string[] = []
  try {
    jars = fs
      .readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith('.jar'))
      .map((n) => path.join(dir, n))
  } catch {
    return []
  }
  const groups = new Map<string, ModDuplicateGroup>()
  for (const jar of jars) {
    const info = parseModFile(jar)
    if (info.error || !info.id) continue
    const key = info.id.toLowerCase()
    if (!groups.has(key)) {
      groups.set(key, { modId: info.id, name: info.name || info.id, files: [] })
    }
    groups.get(key)!.files.push({ fileName: info.fileName, version: info.version, latest: false })
  }
  const out: ModDuplicateGroup[] = []
  for (const g of groups.values()) {
    if (g.files.length < 2) continue
    g.files.sort((a, b) => compareModVersion(b.version, a.version))
    g.files.forEach((f, i) => (f.latest = i === 0))
    out.push(g)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** ��汾���أ�ͬһ mod id ͬʱ�����ڶ����ѡ�汾 */
export function findCrossDuplicates(versionIds: string[]): ModCrossDuplicate[] {
  const map = new Map<string, ModCrossDuplicate>()
  for (const vid of versionIds) {
    const dir = modsDirOf(vid)
    let jars: string[] = []
    try {
      jars = fs
        .readdirSync(dir)
        .filter((n) => n.toLowerCase().endsWith('.jar'))
        .map((n) => path.join(dir, n))
    } catch {
      continue
    }
    for (const jar of jars) {
      const info = parseModFile(jar)
      if (info.error || !info.id) continue
      const key = info.id.toLowerCase()
      if (!map.has(key)) {
        map.set(key, { modId: info.id, name: info.name || info.id, presentIn: [] })
      }
      const g = map.get(key)!
      if (!g.presentIn.some((p) => p.versionId === vid)) {
        g.presentIn.push({ versionId: vid, fileName: info.fileName })
      }
    }
  }
  return [...map.values()]
    .filter((g) => g.presentIn.length >= 2)
    .sort((a, b) => b.presentIn.length - a.presentIn.length)
}
