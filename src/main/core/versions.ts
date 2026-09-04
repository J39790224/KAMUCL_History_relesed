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
import {
  classifyHttpStatus,
  downloadAll,
  downloadCandidates,
  downloadFile,
  fetchSignal,
  type DownloadTask,
  type MirrorPref
} from './download'
import { getSettings } from './settings'
import { abortableDelay, throwIfCancelled } from './tasks'
import { createWeightedProgressEmit, VERSION_INSTALL_STAGE_RANGES } from './progress'
import {
  allVersionsDirs,
  assetIndexPath,
  assetObjectPath,
  baseVersionDir,
  baseVersionJarPath,
  baseVersionJsonPath,
  gameDir,
  installMarkPath,
  instanceIconsDir,
  libraryPath,
  registerVersionFolder,
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
  /** KAMUCL 自定义字段：版本独立指定 Java 路径 */
  _javaPath?: string
  /** KAMUCL 自定义字段：自定义命名的原版实例记录其真实 MC 版本 id（修复/推断用） */
  _mcVersion?: string
  /** KAMUCL 自定义字段：实例图标（'mob:<内置id>' / 'file:<自定义文件名>'） */
  _icon?: string
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

/** 拉取远程版本清单，带 1 小时本地缓存；refresh=true 强制刷新；signal 用于任务取消 */
export async function fetchVersionManifest(
  mirror: MirrorPref,
  refresh = false,
  signal?: AbortSignal
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
    // 元数据官方地址优先，BMCL 仅作受支持的备用源；404/410 不重试同址。
    let data: { versions?: unknown[] } | null = null
    let lastErr: unknown = null
    sourceLoop: for (const source of downloadCandidates([MANIFEST_URL], mirror)) {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (signal?.aborted) throw new Error('已取消')
        try {
          const res = await fetch(source, { signal: fetchSignal(signal) })
          if (!res.ok) {
            lastErr = new Error(`HTTP ${res.status}: ${source}`)
            if (classifyHttpStatus(res.status) !== 'transient') break
            throw lastErr
          }
          data = (await res.json()) as { versions?: unknown[] }
          break sourceLoop
        } catch (e) {
          if (signal?.aborted) throw new Error('已取消')
          lastErr = e
          if (attempt < 2) await abortableDelay(800 * (attempt + 1), signal)
        }
      }
    }
    if (!data) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
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

/** 同步读取本地版本 json（容错 BOM 头）；versions/ 没有时回退到 .kamucl/base 依赖原版区 */
export function readVersionJson(id: string): VersionJson {
  let p = versionJsonPath(id)
  if (!fs.existsSync(p) && fs.existsSync(baseVersionJsonPath(id))) p = baseVersionJsonPath(id)
  const raw = fs.readFileSync(p, 'utf-8')
  return JSON.parse(raw.replace(/^﻿/, '')) as VersionJson
}

/** 确保版本 json 存在并解析返回（不存在则按清单下载到 dest，默认 versions 区；signal 用于任务取消） */
export async function getVersionJson(
  versionId: string,
  dest?: string,
  signal?: AbortSignal
): Promise<VersionJson> {
  const jsonPath = dest ?? versionJsonPath(versionId)
  if (!fs.existsSync(jsonPath)) {
    const mirror = getSettings().mirror
    let manifest = await fetchVersionManifest(mirror, false, signal)
    let entry = manifest.find((v) => v.id === versionId)
    if (!entry) {
      // 可能是新发布的版本，强制刷新一次清单再找
      manifest = await fetchVersionManifest(mirror, true, signal)
      entry = manifest.find((v) => v.id === versionId)
    }
    if (!entry) throw new Error(`版本清单中找不到 ${versionId}`)
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true })
    await downloadFile(entry.url, jsonPath, undefined, undefined, mirror, signal)
  }
  return JSON.parse(fs.readFileSync(jsonPath, 'utf-8').replace(/^﻿/, '')) as VersionJson
}

// ---------------- 依赖库收集 ----------------

interface LibEntry {
  /** 本地绝对路径 */
  path: string
  url?: string
  sha1?: string
  size?: number
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
    out.push({ path: dest, url: art.url, sha1: art.sha1, size: art.size, isNative })
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
    .map((e) => ({ url: e.url as string, dest: e.path, sha1: e.sha1, size: e.size }))
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

/**
 * 安装原版（不含加载器），返回最终版本 id。已下载的文件会自动跳过。
 * dest='versions'：作为独立版本安装进 versions/（用户主动安装，支持 instanceName 自定义实例名）
 * dest='base'：作为加载器实例的内部依赖装进 .kamucl/base/（不进版本列表，json/jar 仅供链解析）
 */
export async function installVanilla(
  versionId: string,
  emit: ProgressEmit,
  dest: 'versions' | 'base' = 'versions',
  instanceName?: string,
  signal?: AbortSignal,
  finalEvent = true
): Promise<string> {
  const finalId = dest === 'versions' ? instanceName?.trim() || versionId : versionId
  const dir = dest === 'base' ? baseVersionDir(versionId) : versionDir(finalId)
  const jsonPath = path.join(dir, `${finalId}.json`)
  const jarPath = path.join(dir, `${finalId}.jar`)
  const mark = path.join(dir, '.installing')
  const mirror = getSettings().mirror
  const sourceText = mirror === 'bmclapi' ? 'BMCLAPI 镜像' : '官方源'

  // 事务标记：安装开始打标，全部成功才移除；失败由 cleanupPartialInstall 清理
  fs.mkdirSync(dir, { recursive: true })
  if (dest === 'versions') registerVersionFolder(finalId, gameDir()) // 新版本注册到当前活动文件夹
  fs.writeFileSync(mark, new Date().toISOString(), 'utf-8')
  try {
    emit({ stage: 'version-json', progress: 0, text: `获取版本信息 ${versionId}`, source: sourceText })
    const vj = await getVersionJson(versionId, jsonPath, signal)
    // 自定义实例名：json id 同步改写，并记录真实 MC 版本供修复/Java 推断
    if (finalId !== versionId) {
      vj.id = finalId
      vj._mcVersion = versionId
      fs.writeFileSync(jsonPath, JSON.stringify(vj, null, 2), 'utf-8')
    }

    // 1. 依赖库（含 natives classifiers）
    const libTasks = libraryTasks(vj)
    await downloadAll(
      libTasks,
      (d, t, speed, detail) =>
        emit({
          stage: 'libraries',
          progress: detail.fraction ?? 0,
          text: `下载依赖库 ${d}/${t}`,
          speed,
          etaSeconds: detail.etaSeconds ?? undefined,
          bytesDone: detail.bytesDone,
          bytesTotal: detail.bytesTotal ?? undefined,
          indeterminate: detail.indeterminate,
          source: sourceText
        }),
      8,
      mirror,
      signal
    )

    // 2. 客户端 jar
    const client = vj.downloads?.client
    if (client?.url) {
      await downloadFile(
        client.url,
        jarPath,
        (d, t) =>
          emit({
            stage: 'client',
            progress: t ? d / t : 0,
            text: `下载游戏本体 ${fmtMB(d)}${t ? '/' + fmtMB(t) : ''}`,
            source: sourceText
          }),
        client.sha1,
        mirror,
        signal,
        [],
        { size: client.size }
      )
    }

    // 3. 资源索引与资源文件
    if (vj.assetIndex?.url) {
      const idxPath = assetIndexPath(vj.assetIndex.id)
      await downloadFile(
        vj.assetIndex.url,
        idxPath,
        undefined,
        vj.assetIndex.sha1,
        mirror,
        signal,
        [],
        { size: vj.assetIndex.size }
      )

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
          sha1: o.hash,
          size: o.size
        })
      }
      await downloadAll(
        tasks,
        (d, t, speed, detail) =>
          emit({
            stage: 'assets',
            progress: detail.fraction ?? 0,
            text: `下载资源文件 ${d}/${t}`,
            speed,
            etaSeconds: detail.etaSeconds ?? undefined,
            bytesDone: detail.bytesDone,
            bytesTotal: detail.bytesTotal ?? undefined,
            indeterminate: detail.indeterminate,
            source: sourceText
          }),
        8,
        mirror,
        signal
      )

      // legacy 版本需要把资源复制到 assets/virtual/legacy 下
      if (idx.virtual === true || idx.map_to_resources === true) {
        emit({ stage: 'assets', progress: 1, text: '复制 legacy 资源' })
        let copied = 0
        for (const [name, o] of Object.entries(objects)) {
          throwIfCancelled(signal)
          if (!o?.hash) continue
          const from = assetObjectPath(o.hash)
          const to = path.join(virtualLegacyDir(), ...name.split('/'))
          if (fs.existsSync(from) && !fs.existsSync(to)) {
            fs.mkdirSync(path.dirname(to), { recursive: true })
            fs.copyFileSync(from, to)
          }
          if (++copied % 64 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
        }
      }
    }

    emit(
      finalEvent
        ? { stage: 'done', progress: 1, text: `校验完成，${versionId} 安装成功` }
        : { stage: 'assets', progress: 1, text: `原版 ${versionId} 依赖准备完成` }
    )
    // 全部步骤成功：移除事务标记
    fs.rmSync(mark, { force: true })
  } catch (e) {
    // 失败时保留 .installing 标记（列表显示「安装失败」+ 清理残留入口）
    throw e
  }
  return finalId
}

/**
 * 安装版本。opts.loader 存在时先确保原版（作为内部依赖，不产生独立版本条目），
 * 再委托 loaders 模块安装加载器。返回最终安装完成的版本 id。
 */
export async function installVersion(
  versionId: string,
  opts: InstallOptions = {},
  emit: ProgressEmit,
  signal?: AbortSignal
): Promise<string> {
  const report = createWeightedProgressEmit(emit, VERSION_INSTALL_STAGE_RANGES)
  if (opts.loader) {
    // 动态 import 避免与 loaders.ts 的循环依赖
    const { installLoader, listLoaderVersions, installFabricApi } = await import('./loaders')
    let loaderVersion = opts.loaderVersion
    if (!loaderVersion) {
      const list = await listLoaderVersions(opts.loader, versionId, signal)
      loaderVersion = list[0]
      if (!loaderVersion) throw new Error(`${opts.loader} 没有适配 ${versionId} 的版本`)
    }
    const installedId = await installLoader(
      opts.loader,
      versionId,
      loaderVersion,
      report,
      opts.instanceName,
      signal
    )
    // Fabric：可选同时安装 Fabric API 到 mods 文件夹
    if (opts.loader === 'fabric' && opts.fabricApi) {
      await installFabricApi(versionId, opts.fabricApi, report, signal)
    }
    return installedId
  }
  return await installVanilla(versionId, report, 'versions', opts.instanceName, signal)
}

/** 链底客户端 jar 的实际位置（versions 区优先，缺省时取 .kamucl/base 依赖原版区） */
export function clientJarPath(id: string): string {
  return fs.existsSync(versionJsonPath(id)) ? versionJarPath(id) : baseVersionJarPath(id)
}

/**
 * 把「加载器安装时临时落地的原版条目」迁移进 .kamucl/base 依赖区：
 * versions/<mc>/ 下的 json+jar 移走并删除目录，版本列表不再出现多余的原版条目。
 * 安装不完整（.installing 标记在）时整个目录直接删除。
 */
export function migrateDependencyVanilla(mcId: string): void {
  const dir = versionDir(mcId)
  if (!fs.existsSync(dir)) return
  if (fs.existsSync(installMarkPath(mcId))) {
    fs.rmSync(dir, { recursive: true, force: true })
    return
  }
  const jp = versionJsonPath(mcId)
  if (!fs.existsSync(jp)) return
  const base = baseVersionDir(mcId)
  fs.mkdirSync(base, { recursive: true })
  const baseJson = baseVersionJsonPath(mcId)
  const baseJar = baseVersionJarPath(mcId)
  if (!fs.existsSync(baseJson)) fs.renameSync(jp, baseJson)
  const jar = versionJarPath(mcId)
  if (fs.existsSync(jar) && !fs.existsSync(baseJar)) fs.renameSync(jar, baseJar)
  fs.rmSync(dir, { recursive: true, force: true })
}

// ---------------- 已安装列表 / 删除 ----------------

/** 沿 inheritsFrom 链解析到最底层的原版 MC 版本 id（链断时回退为当前已知 id；自定义命名的原版取 _mcVersion） */
function resolveBaseMcId(j: VersionJson, fallback: string): string {
  let cur = j
  let id = j.inheritsFrom ?? j._mcVersion ?? j.id ?? fallback
  let hops = 0
  while (cur.inheritsFrom && hops++ < 8) {
    try {
      const parent = readVersionJson(cur.inheritsFrom)
      id = parent.inheritsFrom ?? parent._mcVersion ?? parent.id ?? id
      cur = parent
    } catch {
      break
    }
  }
  return id
}

/** 扫描全部已登记游戏文件夹的 versions/*\/（标注所属文件夹并注册寻址映射） */
export function listInstalled(): InstalledVersion[] {
  const out: InstalledVersion[] = []
  for (const { folder, dir } of allVersionsDirs()) {
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir)) {
      const jp = path.join(dir, name, `${name}.json`)
      if (!fs.existsSync(jp)) continue
      try {
        const j = readVersionJson(name)
        registerVersionFolder(name, folder)
        const item: InstalledVersion = {
          id: name,
          mcVersion: resolveBaseMcId(j, name),
          folder
        }
        if (j._loader) item.loader = j._loader
        else {
          const mc = (j.mainClass ?? '').toLowerCase()
          if (mc.includes('neoforged')) item.loader = 'neoforge'
          else if (mc.includes('forge')) item.loader = 'forge'
          else if (mc.includes('fabricmc')) item.loader = 'fabric'
          else if (mc.includes('quiltmc')) item.loader = 'quilt'
        }
        if (j._loaderVersion) item.loaderVersion = j._loaderVersion
        if (j._modpackName) item.modpackName = j._modpackName
        if (j._modpackVersion) item.modpackVersion = j._modpackVersion
        if (j._javaPath) item.javaPath = j._javaPath
        if (j._icon) item.icon = j._icon
        if (j._gameDir === true) item.isolated = true
        if (!j.inheritsFrom) {
          const jarOk = fs.existsSync(versionJarPath(name))
          const hasPart = fs.existsSync(versionJarPath(name) + '.part')
          if (!jarOk || hasPart) item.incomplete = true
        }
        if (fs.existsSync(installMarkPath(name))) item.failed = true
        out.push(item)
      } catch {
        // 跳过损坏的 json
      }
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

/** 实例名校验：非法字符与保留名（返回错误文案，合法返回 null） */
export function validateInstanceName(name: string, excludeId?: string): string | null {
  const n = name.trim()
  if (!n) return '实例名不能为空'
  if (n.length > 64) return '实例名过长（最多 64 字符）'
  if (/[\\/:*?"<>|]/.test(n)) return '实例名不能包含 \\ / : * ? " < > | 字符'
  if (/^[.\s]|[.\s]$/.test(n)) return '实例名不能以空格或点开头/结尾'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(n)) return '实例名为系统保留名'
  if (n !== excludeId) {
    // 跨所有游戏文件夹查重
    for (const { dir } of allVersionsDirs()) {
      if (fs.existsSync(path.join(dir, n))) return `实例「${n}」已存在，请换一个名字`
    }
  }
  return null
}

/** 重命名实例：目录、json id、原版 jar 文件名同步改名（校验冲突/非法/占用；运行中由调用方拦截） */
export function renameVersion(id: string, newName: string): void {
  const err = validateInstanceName(newName, id)
  if (err) throw new Error(err)
  const trimmed = newName.trim()
  const from = versionDir(id)
  const to = versionDir(trimmed)
  if (!fs.existsSync(from)) throw new Error('实例不存在')
  if (from === to) return
  // 更新 json 内 id 字段（先读改写，再移动目录，避免中间态）；
  // 原版实例改名前记录真实 MC 版本 id（_mcVersion），改名后修复/Java 推断仍可用
  const jp = versionJsonPath(id)
  if (fs.existsSync(jp)) {
    const j = readVersionJson(id)
    if (!j.inheritsFrom && !j._loader && !j._modpackName && !j._mcVersion) j._mcVersion = j.id
    j.id = trimmed
    fs.writeFileSync(jp, JSON.stringify(j, null, 2), 'utf-8')
  }
  // 重命名 json 文件名 <id>.json → <newName>.json
  try {
    fs.renameSync(jp, path.join(from, `${trimmed}.json`))
  } catch {
    /* json 文件名异常不阻断 */
  }
  // 原版实例的客户端 jar 文件名与 id 同名，同步改名
  const oldJar = path.join(from, `${id}.jar`)
  if (fs.existsSync(oldJar)) {
    try {
      fs.renameSync(oldJar, path.join(from, `${trimmed}.jar`))
    } catch {
      /* 同上 */
    }
  }
  try {
    fs.renameSync(from, to)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY') {
      throw new Error('文件夹正被占用（游戏运行中或被其他程序打开），请关闭后重试')
    }
    throw e
  }
}
export function removeVersion(id: string): void {
  // 自定义图标文件随实例删除（内置 mob 头像无文件落地）
  try {
    const j = readVersionJson(id)
    if (j._icon?.startsWith('file:')) {
      fs.rmSync(path.join(instanceIconsDir(), j._icon.slice(5)), { force: true })
    }
  } catch {
    /* 清理图标失败不阻断删除 */
  }
  fs.rmSync(versionDir(id), { recursive: true, force: true })
}

/** 设置实例图标：'mob:<内置id>' / 'file:<文件名>' / '' 恢复默认；更换时清理旧的自定义图标文件 */
export function setVersionIcon(id: string, icon: string): void {
  if (icon && !/^mob:[a-z0-9_]{1,32}$/.test(icon) && !/^file:[\w.-]{1,64}$/.test(icon)) {
    throw new Error('非法的图标标识')
  }
  const jp = versionJsonPath(id)
  const j = readVersionJson(id)
  const old = j._icon
  if (icon) j._icon = icon
  else delete j._icon
  fs.writeFileSync(jp, JSON.stringify(j, null, 2), 'utf-8')
  // 旧的自定义图标文件若不再使用则删除
  if (old?.startsWith('file:') && old !== icon) {
    try {
      fs.rmSync(path.join(instanceIconsDir(), old.slice(5)), { force: true })
    } catch {
      /* 清理失败不影响设置 */
    }
  }
}

/**
 * 清理安装失败的残留（.installing 标记存在时调用）：
 * 删除整个版本目录（该标记只在安装开始时创建，目录必然是不完整产物）
 */
export function cleanupPartialInstall(id: string): boolean {
  if (!fs.existsSync(installMarkPath(id))) return false
  fs.rmSync(versionDir(id), { recursive: true, force: true })
  return true
}

/** 版本独立指定 Java（写入 _javaPath；空串恢复自动匹配） */
export function setVersionJava(id: string, javaPath: string): void {
  const jp = versionJsonPath(id)
  const j = readVersionJson(id)
  const p = javaPath.trim()
  if (p) j._javaPath = p
  else delete j._javaPath
  fs.writeFileSync(jp, JSON.stringify(j, null, 2), 'utf-8')
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
