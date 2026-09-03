/**
 * MOD 元数据解析：读取 jar 内 fabric.mod.json / quilt.mod.json /
 * neoforge.mods.toml / mods.toml / mcmod.info，提取名称、版本、
 * 加载器类型、MC 版本范围、前置依赖与图标。
 */
import fs from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'
import type { LoaderName, ModInfo } from '../../shared/types'

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

/** 比较两个版本号（按数字段；26.2 与 1.21.8 这类新命名直接数值比） */
export function compareMcVersion(a: string, b: string): number {
  const pa = a.split(/[.-]/)
  const pb = b.split(/[.-]/)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = parseInt(pa[i] ?? '0', 10)
    const nb = parseInt(pb[i] ?? '0', 10)
    const xa = Number.isFinite(na) ? na : 0
    const xb = Number.isFinite(nb) ? nb : 0
    if (xa !== xb) return xa - xb
  }
  return 0
}

/** 单段范围匹配：[a,b) / (a,b] / [a,b] / (a,b) / >=a / >a / <=a / <a / ~a / a / * */
function matchOne(seg: string, mc: string): boolean {
  const s = seg.trim()
  if (!s || s === '*') return true
  const range = /^([\[(])([^,]*),([^\])]*)[\])]$/.exec(s)
  if (range) {
    const [, open, minS, maxS] = range
    const closedEnd = s.endsWith(']')
    if (minS && compareMcVersion(mc, minS) < 0) return false
    if (maxS) {
      const c = compareMcVersion(mc, maxS)
      if (closedEnd ? c > 0 : c >= 0) return false
    }
    return true
  }
  if (s.startsWith('~')) {
    const base = s.slice(1)
    const parts = base.split('.')
    const upper = `${parts[0]}.${(parseInt(parts[1] ?? '0', 10) || 0) + 1}`
    return compareMcVersion(mc, base) >= 0 && compareMcVersion(mc, upper) < 0
  }
  const op = /^(>=|<=|>|<)(.+)$/.exec(s)
  if (op) {
    const c = compareMcVersion(mc, op[2].trim())
    switch (op[1]) {
      case '>=':
        return c >= 0
      case '<=':
        return c <= 0
      case '>':
        return c > 0
      case '<':
        return c < 0
    }
  }
  // 精确版本（如 1.20.1）或形如 1.20.x
  if (s.endsWith('.x')) return mc.startsWith(s.slice(0, -1))
  return compareMcVersion(mc, s) === 0
}

/** 判断 mc 版本是否满足范围声明（逗号/空格分隔取「任一匹配」语义） */
export function matchMcRange(range: string, mc: string): boolean {
  const r = (range ?? '').trim()
  if (!r || r === '*') return true
  return r.split(/\s*,\s*|\s+/).some((seg) => matchOne(seg, mc))
}

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
      info.mcRange = Array.isArray(dep.minecraft)
        ? (dep.minecraft as string[]).join(', ')
        : String(dep.minecraft ?? '')
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
        }
        minecraft?: { environment?: string }
        depends?: Record<string, unknown> | Array<{ id?: string; versions?: string }>
      }
      info.loader = 'quilt'
      const ql = j.quilt_loader ?? {}
      info.id = ql.id ?? ''
      info.name = ql.metadata?.name ?? ql.id ?? ''
      info.version = String(ql.version ?? '')
      const deps = j.depends
      if (Array.isArray(deps)) {
        const mc = deps.find((d) => d.id === 'minecraft')
        info.mcRange = mc?.versions ?? ''
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
      info.loader = 'forge'
      info.id = m.modId ?? ''
      info.name = m.displayName ?? m.modId ?? ''
      info.version = (m.version ?? '').replace(/^"|"$/g, '')
      const mcDep = deps.find((d) => d.modId === 'minecraft')
      info.mcRange = mcDep?.versionRange ?? ''
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
