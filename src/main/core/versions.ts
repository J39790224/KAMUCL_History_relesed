/**
 * 版本管理：版本清单缓存、rules 评估、原版安装、已装列表、删除
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type {
  InstalledVersion,
  InstallOptions,
  ProgressEvent,
  RemoteVersion
} from '../../shared/types'
import { downloadAll, downloadFile, mirrorUrl, type DownloadTask, type MirrorPref } from './download'
import { getSettings } from './settings'
import {
  assetIndexPath,
  assetObjectPath,
  gameDir,
  libraryPath,
  versionDir,
  versionJarPath,
  versionJsonPath,
  versionsDir,
  virtualLegacyDir
} from './paths'

export type ProgressEmit = (e: ProgressEvent) => void

// ---------------- Mojang 版本 json 的内部结构（只取需要的字段） ----------------

export interface VersionRule {
  action: 'allow' | 'disallow'
  os?: { name?: 'windows' | 'linux' | 'osx'; arch?: 'x86' }
  features?: Record<string, boolean>
}

export interface LibraryArtifact {
  path: string
  url: string
  sha1?: string
  size?: number
}

export interface Library {
  name?: string
  /** maven 坐标形式（fabric/quilt profile）的仓库基址 */
  url?: string
  rules?: VersionRule[]
  natives?: Record<string, string>
  downloads?: {
    artifact?: LibraryArtifact
    classifiers?: Record<string, LibraryArtifact>
  }
}

export interface ArgumentEntry {
  rules?: VersionRule[]
  value: string | string[]
}

export interface AssetIndexRef {
  id: string
  url: string
  sha1?: string
  size?: number
  totalSize?: number
}

export interface VersionJson {
  id: string
  inheritsFrom?: string
  mainClass?: string
  minecraftArguments?: string
  arguments?: { game?: (string | ArgumentEntry)[]; jvm?: (string | ArgumentEntry)[] }
  type?: string
  assets?: string
  assetIndex?: AssetIndexRef
  javaVersion?: { majorVersion: number }
  libraries?: Library[]
  downloads?: { client?: LibraryArtifact }
  /** KAMUCL 自定义字段：加载器版本标记 */
  _loader?: 'forge' | 'fabric' | 'quilt' | 'neoforge'
  _loaderVersion?: string
  /** KAMUCL 自定义字段：实例隔离（启动时游戏目录 = 本版本目录） */
  _gameDir?: boolean
  /** KAMUCL 自定义字段：来源整合包名称/版本 */
  _modpackName?: string
  _modpackVersion?: string
}

// ---------------- rules 评估 ----------------

/** 当前平台对应的 MC rules os 名（win32→windows / darwin→osx / linux→linux） */
export const OS_NAME: 'windows' | 'osx' | 'linux' =
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'

/**
 * 评估 rules（Mojang 官方语义）：
 * 无 rules → 放行；有 rules 时，**仅当有 rule 的条件匹配当前环境**才按其 action 决定，
 * 全部不匹配 → 拒绝（默认 disallow）。
 * 带 features 的 rule 视为不匹配（quickPlay 等功能默认关闭）。
 */
export function rulesAllow(rules?: VersionRule[]): boolean {
  if (!rules || rules.length === 0) return true
  let allowed = false // 有规则但无一匹配 → 拒绝（如 macOS 专属参数 -XstartOnFirstThread）
  for (const rule of rules) {
    if (rule.features) continue
    if (rule.os) {
      if (rule.os.name && rule.os.name !== OS_NAME) continue
      if (rule.os.arch && !(rule.os.arch === 'x86' && process.arch === 'ia32')) continue
    }
    allowed = rule.action === 'allow'
  }
  return allowed
}

// ---------------- 版本清单 ----------------

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest.json'
const CACHE_TTL = 60 * 60 * 1000 // 缓存 1 小时

function manifestCacheFile(): string {
  return path.join(app.getPath('userData'), 'version_manifest.json')
}

function readManifestCache(): RemoteVersion[] | null {
  try {
    const c = JSON.parse(fs.readFileSync(manifestCacheFile(), 'utf-8'))
    return Array.isArray(c.versions) ? (c.versions as RemoteVersion[]) : null
  } catch {
    return null
  }
}

/** 拉取远程版本清单，带 1 小时本地缓存；refresh=true 强制刷新 */
export async function fetchVersionManifest(
  mirror: MirrorPref,
  refresh = false
): Promise<RemoteVersion[]> {
  if (!refresh) {
    try {
      const c = JSON.parse(fs.readFileSync(manifestCacheFile(), 'utf-8'))
      if (Date.now() - c.fetchedAt < CACHE_TTL && Array.isArray(c.versions)) {
        return c.versions as RemoteVersion[]
      }
    } catch {
      /* 无缓存或损坏则联网拉取 */
    }
  }
  try {
    const res = await fetch(mirrorUrl(MANIFEST_URL, mirror), {
      signal: AbortSignal.timeout(30000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as { versions?: unknown[] }
    const versions: RemoteVersion[] = (data.versions ?? []).map((v) => {
      const it = v as Record<string, string>
      return {
        id: it.id,
        type: it.type as RemoteVersion['type'],
        url: it.url,
        releaseTime: it.releaseTime
      }
    })
    fs.mkdirSync(path.dirname(manifestCacheFile()), { recursive: true })
    fs.writeFileSync(
      manifestCacheFile(),
      JSON.stringify({ fetchedAt: Date.now(), versions }),
      'utf-8'
    )
    return versions
  } catch (e) {
    // 网络失败时回退到过期缓存
    const stale = readManifestCache()
    if (stale) return stale
    throw e
  }
}

// ---------------- 版本 json ----------------

/** 同步读取本地版本 json */
export function readVersionJson(id: string): VersionJson {
  return JSON.parse(fs.readFileSync(versionJsonPath(id), 'utf-8')) as VersionJson
}

/** 确保 versions/<id>/<id>.json 存在并解析返回（不存在则按清单下载） */
export async function getVersionJson(versionId: string): Promise<VersionJson> {
  const dest = versionJsonPath(versionId)
  if (!fs.existsSync(dest)) {
    const mirror = getSettings().mirror
    let manifest = await fetchVersionManifest(mirror)
    let entry = manifest.find((v) => v.id === versionId)
    if (!entry) {
      // 可能是新发布的版本，强制刷新一次清单再找
      manifest = await fetchVersionManifest(mirror, true)
      entry = manifest.find((v) => v.id === versionId)
    }
    if (!entry) throw new Error(`版本清单中找不到 ${versionId}`)
    await downloadFile(entry.url, dest, undefined, undefined, mirror)
  }
  return readVersionJson(versionId)
}

// ---------------- 依赖库收集 ----------------

interface LibEntry {
  /** 本地绝对路径 */
  path: string
  url?: string
  sha1?: string
  isNative: boolean
}

/** 遍历通过 rules 的 libraries，收集 artifact 与 natives classifiers（去重） */
function collectLibraries(vj: VersionJson): LibEntry[] {
  const out: LibEntry[] = []
  const seen = new Set<string>()
  const push = (art: LibraryArtifact | undefined, isNative: boolean): void => {
    if (!art?.url || !art.path) return
    const dest = libraryPath(art.path)
    if (seen.has(dest)) return
    seen.add(dest)
    out.push({ path: dest, url: art.url, sha1: art.sha1, isNative })
  }
  /** maven 坐标（group:artifact:version[:classifier]）→ 仓库相对路径 */
  const mavenPath = (name: string): string | null => {
    const p = name.split(':')
    if (p.length < 3) return null
    const [g, a, v, classifier] = p
    const file = `${a}-${v}${classifier ? `-${classifier}` : ''}.jar`
    return `${g.replace(/\./g, '/')}/${a}/${v}/${file}`
  }
  for (const lib of vj.libraries ?? []) {
    if (!rulesAllow(lib.rules)) continue
    if (lib.downloads?.artifact) {
      push(lib.downloads.artifact, false)
    } else if (lib.name && lib.url) {
      // Fabric/Quilt 等 profile 的 maven 坐标形式：无内联 downloads，需按仓库基址拼接
      const rel = mavenPath(lib.name)
      if (rel) {
        const base = lib.url.endsWith('/') ? lib.url : lib.url + '/'
        push({ path: rel, url: base + rel }, false)
      }
    }
    const nativesKey = lib.natives?.[OS_NAME]?.replace(
      '${arch}',
      process.arch === 'ia32' ? '32' : '64'
    )
    if (nativesKey) push(lib.downloads?.classifiers?.[nativesKey], true)
  }
  return out
}

/** 依赖库下载任务（供 installVersion 与 loaders 复用） */
export function libraryTasks(vj: VersionJson): DownloadTask[] {
  return collectLibraries(vj)
    .filter((e) => e.url)
    .map((e) => ({ url: e.url as string, dest: e.path, sha1: e.sha1 }))
}

/** 启动用：classpath 中的 artifact 路径与 natives jar 路径 */
export function resolvedLibraries(vj: VersionJson): { artifacts: string[]; natives: string[] } {
  const entries = collectLibraries(vj)
  return {
    artifacts: entries.filter((e) => !e.isNative).map((e) => e.path),
    natives: entries.filter((e) => e.isNative).map((e) => e.path)
  }
}

// ---------------- 安装 ----------------

function fmtMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + 'MB'
}

/** 安装原版（不含加载器）。已下载的文件会自动跳过。 */
export async function installVanilla(versionId: string, emit: ProgressEmit): Promise<void> {
  const mirror = getSettings().mirror

  emit({ stage: 'version-json', progress: 0, text: `获取版本信息 ${versionId}` })
  const vj = await getVersionJson(versionId)

  // 1. 依赖库（含 natives classifiers）
  const libTasks = libraryTasks(vj)
  await downloadAll(
    libTasks,
    (d, t, speed) =>
      emit({ stage: 'libraries', progress: t ? d / t : 1, text: `依赖库 ${d}/${t}`, speed }),
    8,
    mirror
  )

  // 2. 客户端 jar
  const client = vj.downloads?.client
  if (client?.url) {
    await downloadFile(
      client.url,
      versionJarPath(versionId),
      (d, t) =>
        emit({
          stage: 'client',
          progress: t ? d / t : 0,
          text: `客户端 ${fmtMB(d)}${t ? '/' + fmtMB(t) : ''}`
        }),
      client.sha1,
      mirror
    )
  }

  // 3. 资源索引与资源文件
  if (vj.assetIndex?.url) {
    const idxPath = assetIndexPath(vj.assetIndex.id)
    await downloadFile(vj.assetIndex.url, idxPath, undefined, vj.assetIndex.sha1, mirror)

    const idx = JSON.parse(fs.readFileSync(idxPath, 'utf-8')) as {
      virtual?: boolean
      map_to_resources?: boolean
      objects?: Record<string, { hash: string; size?: number }>
    }
    const objects = idx.objects ?? {}

    // 按 hash 去重生成下载任务
    const seen = new Set<string>()
    const tasks: DownloadTask[] = []
    for (const o of Object.values(objects)) {
      if (!o?.hash || seen.has(o.hash)) continue
      seen.add(o.hash)
      tasks.push({
        url: `https://resources.download.minecraft.net/${o.hash.slice(0, 2)}/${o.hash}`,
        dest: assetObjectPath(o.hash),
        sha1: o.hash
      })
    }
    await downloadAll(
      tasks,
      (d, t, speed) =>
        emit({ stage: 'assets', progress: t ? d / t : 1, text: `资源文件 ${d}/${t}`, speed }),
      8,
      mirror
    )

    // legacy 版本需要把资源复制到 assets/virtual/legacy 下
    if (idx.virtual === true || idx.map_to_resources === true) {
      emit({ stage: 'assets', progress: 1, text: '复制 legacy 资源' })
      for (const [name, o] of Object.entries(objects)) {
        if (!o?.hash) continue
        const from = assetObjectPath(o.hash)
        const to = path.join(virtualLegacyDir(), ...name.split('/'))
        if (fs.existsSync(from) && !fs.existsSync(to)) {
          fs.mkdirSync(path.dirname(to), { recursive: true })
          fs.copyFileSync(from, to)
        }
      }
    }
  }

  emit({ stage: 'done', progress: 1, text: `${versionId} 安装完成` })
}

/**
 * 安装版本。opts.loader 存在时先确保原版，再委托 loaders 模块安装加载器。
 * 返回最终安装完成的版本 id。
 */
export async function installVersion(
  versionId: string,
  opts: InstallOptions = {},
  emit: ProgressEmit
): Promise<string> {
  if (opts.loader) {
    // 动态 import 避免与 loaders.ts 的循环依赖
    const { installLoader, listLoaderVersions, installFabricApi } = await import('./loaders')
    let loaderVersion = opts.loaderVersion
    if (!loaderVersion) {
      const list = await listLoaderVersions(opts.loader, versionId)
      loaderVersion = list[0]
      if (!loaderVersion) throw new Error(`${opts.loader} 没有适配 ${versionId} 的版本`)
    }
    const installedId = await installLoader(opts.loader, versionId, loaderVersion, emit)
    // Fabric：可选同时安装 Fabric API 到 mods 文件夹
    if (opts.loader === 'fabric' && opts.fabricApi) {
      await installFabricApi(versionId, opts.fabricApi, emit)
    }
    return installedId
  }
  await installVanilla(versionId, emit)
  return versionId
}

// ---------------- 已安装列表 / 删除 ----------------

/** 沿 inheritsFrom 链解析到最底层的原版 MC 版本 id（链断时回退为当前已知 id） */
function resolveBaseMcId(j: VersionJson, fallback: string): string {
  let cur = j
  let id = j.inheritsFrom ?? j.id ?? fallback
  let hops = 0
  while (cur.inheritsFrom && hops++ < 8) {
    try {
      const parent = readVersionJson(cur.inheritsFrom)
      id = parent.inheritsFrom ?? parent.id ?? id
      cur = parent
    } catch {
      break
    }
  }
  return id
}

/** 扫描 gameDir/versions/*\/，读取每个 <dir>/<dir>.json */
export function listInstalled(): InstalledVersion[] {
  const dir = versionsDir()
  if (!fs.existsSync(dir)) return []
  const out: InstalledVersion[] = []
  for (const name of fs.readdirSync(dir)) {
    const jp = versionJsonPath(name)
    if (!fs.existsSync(jp)) continue
    try {
      const j = readVersionJson(name)
      const item: InstalledVersion = {
        id: name,
        // 整合包实例的 inheritsFrom 指向加载器 profile 版本（如 fabric-loader-x-mc），
        // 需沿链解析到真实原版版本，避免污染「已安装」判定与版本筛选
        mcVersion: resolveBaseMcId(j, name)
      }
      if (j._loader) item.loader = j._loader
      if (j._loaderVersion) item.loaderVersion = j._loaderVersion
      if (j._modpackName) item.modpackName = j._modpackName
      if (j._modpackVersion) item.modpackVersion = j._modpackVersion
      if (j._gameDir === true) item.isolated = true
      out.push(item)
    } catch {
      // 跳过损坏的 json
    }
  }
  // 实例排序：按 MC 版本分组（新→旧），同版本内纯净版在前、加载器实例按 id 字母序
  out.sort((a, b) => {
    if (a.mcVersion !== b.mcVersion) {
      return b.mcVersion.localeCompare(a.mcVersion, undefined, { numeric: true })
    }
    if (!!a.loader !== !!b.loader) return a.loader ? 1 : -1
    return a.id.localeCompare(b.id)
  })
  return out
}

/** 删除版本目录 */
export function removeVersion(id: string): void {
  fs.rmSync(versionDir(id), { recursive: true, force: true })
}

// ---------------- 版本隔离 ----------------

/** 开启隔离时从共享目录复制进版本目录的内容（已存在项不覆盖） */
const ISOLATE_COPY_DIRS = ['saves', 'mods', 'config', 'resourcepacks', 'shaderpacks', 'screenshots']
const ISOLATE_COPY_FILES = ['options.txt', 'servers.dat']

/**
 * 版本隔离开关。
 * 开启：版本 json 写 _gameDir=true，并把共享游戏目录的存档/mods/配置等复制进 versions/<id>/
 * （复制而非移动，共享目录数据保留；版本目录中已存在的项不覆盖）。
 * 关闭：移除 _gameDir 标记（版本目录中的数据保留，仅启动时不再使用）。
 */
export function setIsolation(id: string, isolated: boolean): void {
  const jp = versionJsonPath(id)
  const j = readVersionJson(id)
  if (isolated) {
    j._gameDir = true
    const dest = versionDir(id)
    for (const d of ISOLATE_COPY_DIRS) {
      const from = path.join(gameDir(), d)
      const to = path.join(dest, d)
      try {
        if (fs.existsSync(from) && !fs.existsSync(to)) {
          fs.cpSync(from, to, { recursive: true })
        }
      } catch {
        /* 单个目录复制失败不阻断 */
      }
    }
    for (const f of ISOLATE_COPY_FILES) {
      const from = path.join(gameDir(), f)
      const to = path.join(dest, f)
      try {
        if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to)
      } catch {
        /* 同上 */
      }
    }
  } else {
    delete j._gameDir
  }
  fs.writeFileSync(jp, JSON.stringify(j, null, 2), 'utf-8')
}
