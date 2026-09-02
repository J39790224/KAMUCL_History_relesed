/**
 * 社区资源：Modrinth / CurseForge（MCIM 镜像免 key）的搜索、文件列表与下载
 * - Modrinth 主备双域名互备（官方 api + MCIM 镜像）
 * - 下载落盘：实例隔离版本 → 版本目录，否则全局游戏目录；modpack 走整合包安装流程
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  CommunityFile,
  CommunityKind,
  CommunityQuery,
  CommunityResult,
  CommunitySource,
  LoaderName,
  ProgressEvent
} from '../../shared/types'
import { downloadFile } from './download'
import { gameDir, versionDir } from './paths'
import { readVersionJson } from './versions'

export type ProgressEmit = (e: ProgressEvent) => void

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const UA = { 'User-Agent': 'KAMUCL/0.4.0' }
const TIMEOUT = 30000

// ---------------- 基础请求 ----------------

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT), headers: UA })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
  return res.json()
}

// ---------------- Modrinth ----------------

const MR_BASES = ['https://api.modrinth.com/v2', 'https://mod.mcimirror.top/modrinth/v2']

/** 主备互备请求 Modrinth */
async function mrFetch(p: string): Promise<unknown> {
  let lastErr: unknown = null
  for (const base of MR_BASES) {
    try {
      return await fetchJson(base + p)
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

const MR_PROJECT_TYPE: Record<CommunityKind, string> = {
  mod: 'mod',
  modpack: 'modpack',
  resourcepack: 'resourcepack',
  shader: 'shader',
  datapack: 'datapack'
}

interface MrHit {
  project_id?: string
  slug?: string
  title?: string
  description?: string
  author?: string
  icon_url?: string | null
  downloads?: number
  date_modified?: string
  categories?: string[]
}

async function mrSearch(q: CommunityQuery): Promise<CommunityResult[]> {
  const facets: string[][] = [[`project_type:${MR_PROJECT_TYPE[q.kind]}`]]
  if (q.mcVersion) facets.push([`versions:${q.mcVersion}`])
  if (q.loader) facets.push([`categories:${q.loader}`])
  const params = new URLSearchParams({
    query: q.keyword,
    limit: String(q.limit),
    offset: String(q.offset),
    index: 'relevance',
    facets: JSON.stringify(facets)
  })
  const data = (await mrFetch(`/search?${params.toString()}`)) as { hits?: MrHit[] }
  return (data.hits ?? []).map((h) => ({
    source: 'modrinth' as const,
    projectId: String(h.project_id ?? ''),
    slug: h.slug ?? '',
    title: h.title ?? '',
    author: h.author ?? '',
    description: h.description ?? '',
    iconUrl: h.icon_url ?? '',
    downloads: h.downloads ?? 0,
    updatedAt: h.date_modified ?? '',
    categories: h.categories ?? []
  }))
}

interface MrVersionFile {
  filename?: string
  url?: string
  hashes?: { sha1?: string }
  size?: number
  primary?: boolean
}

interface MrVersion {
  id?: string
  version_number?: string
  version_type?: string
  game_versions?: string[]
  loaders?: string[]
  date_published?: string
  files?: MrVersionFile[]
}

async function mrFiles(projectId: string): Promise<CommunityFile[]> {
  const arr = (await mrFetch(`/project/${encodeURIComponent(projectId)}/version`)) as MrVersion[]
  const out: CommunityFile[] = []
  for (const v of arr ?? []) {
    const files = v.files ?? []
    const f = files.find((x) => x.primary) ?? files[0]
    if (!f?.url || !f.filename) continue
    const sha1 = f.hashes?.sha1
    out.push({
      fileId: sha1 ? sha1.slice(0, 8) : String(v.id ?? f.filename),
      fileName: f.filename,
      version: v.version_number ?? f.filename,
      url: f.url,
      sha1,
      size: f.size ?? 0,
      releaseType:
        v.version_type === 'beta' ? 'beta' : v.version_type === 'alpha' ? 'alpha' : 'release',
      gameVersions: v.game_versions ?? [],
      loaders: v.loaders ?? [],
      date: v.date_published ?? ''
    })
  }
  return out
}

// ---------------- CurseForge（MCIM 镜像） ----------------

const CF_BASE = 'https://mod.mcimirror.top/curseforge/v1'

const CF_CLASS_ID: Record<CommunityKind, number> = {
  mod: 6,
  modpack: 4471,
  resourcepack: 12,
  shader: 6552,
  datapack: 6945
}

const CF_LOADER_TYPE: Record<LoaderName, number> = {
  forge: 1,
  fabric: 4,
  quilt: 5,
  neoforge: 6
}

const LOADER_NAMES = new Set(['forge', 'fabric', 'quilt', 'neoforge'])

async function cfFetch(p: string): Promise<unknown> {
  return fetchJson(CF_BASE + p)
}

interface CfMod {
  id?: number
  slug?: string
  name?: string
  summary?: string
  authors?: { name?: string }[]
  logo?: { thumbnailUrl?: string }
  downloadCount?: number
  dateModified?: string
  categories?: { name?: string }[]
}

async function cfSearch(q: CommunityQuery): Promise<CommunityResult[]> {
  const params = new URLSearchParams({
    gameId: '432',
    classId: String(CF_CLASS_ID[q.kind]),
    searchFilter: q.keyword,
    index: String(q.offset),
    pageSize: String(q.limit),
    sortField: '2',
    sortOrder: 'desc'
  })
  if (q.mcVersion) params.set('gameVersion', q.mcVersion)
  // modLoaderType 仅对 mod 类有意义
  if (q.loader && q.kind === 'mod') params.set('modLoaderType', String(CF_LOADER_TYPE[q.loader]))
  const data = (await cfFetch(`/mods/search?${params.toString()}`)) as { data?: CfMod[] }
  return (data.data ?? []).map((m) => ({
    source: 'curseforge' as const,
    projectId: String(m.id ?? ''),
    slug: m.slug ?? '',
    title: m.name ?? '',
    author: m.authors?.[0]?.name ?? '',
    description: m.summary ?? '',
    iconUrl: m.logo?.thumbnailUrl ?? '',
    downloads: m.downloadCount ?? 0,
    updatedAt: m.dateModified ?? '',
    categories: (m.categories ?? [])
      .map((c) => c.name)
      .filter((n): n is string => !!n)
  }))
}

interface CfFile {
  id?: number
  fileName?: string
  displayName?: string
  downloadUrl?: string | null
  hashes?: { algo?: number; value?: string }[]
  fileLength?: number
  releaseType?: number
  gameVersions?: string[]
  fileDate?: string
}

async function cfFiles(
  projectId: string,
  filter?: { mcVersion?: string; loader?: LoaderName | '' }
): Promise<CommunityFile[]> {
  const params = new URLSearchParams({ pageSize: '50' })
  if (filter?.mcVersion) params.set('gameVersion', filter.mcVersion)
  if (filter?.loader) params.set('modLoaderType', String(CF_LOADER_TYPE[filter.loader]))
  const data = (await cfFetch(
    `/mods/${encodeURIComponent(projectId)}/files?${params.toString()}`
  )) as { data?: CfFile[] }
  return (data.data ?? []).map((f) => {
    const id = String(f.id ?? '')
    const gameVersions = f.gameVersions ?? []
    return {
      fileId: id,
      fileName: f.fileName ?? id,
      version: f.displayName ?? f.fileName ?? id,
      url:
        f.downloadUrl ??
        `${CF_BASE}/mods/${encodeURIComponent(projectId)}/files/${id}/download`,
      sha1: f.hashes?.find((h) => h.algo === 1)?.value,
      size: f.fileLength ?? 0,
      releaseType:
        f.releaseType === 2 ? 'beta' : f.releaseType === 3 ? 'alpha' : ('release' as const),
      gameVersions,
      loaders: gameVersions
        .map((g) => g.toLowerCase())
        .filter((g) => LOADER_NAMES.has(g)),
      date: f.fileDate ?? ''
    }
  })
}

// ---------------- 对外：搜索 / 文件列表 ----------------

const hasChinese = (s: string): boolean => /[一-鿿]/.test(s)

/** 社区资源搜索；source='all' 时两源并发、各取一半交错合并，单源失败不拖垮另一源 */
export async function communitySearch(q: CommunityQuery): Promise<CommunityResult[]> {
  if (q.source === 'modrinth') return mrSearch(q)
  if (q.source === 'curseforge') {
    try {
      return await cfSearch(q)
    } catch (e) {
      if (hasChinese(q.keyword)) {
        throw new Error('CurseForge 源暂不可用，中文关键词建议切换 Modrinth 源或「全部」')
      }
      throw e
    }
  }
  // 全部：两源并发各取一半，交错合并
  const half = Math.max(1, Math.ceil(q.limit / 2))
  const sub: CommunityQuery = { ...q, limit: half }
  const [mr, cf] = await Promise.allSettled([mrSearch(sub), cfSearch(sub)])
  if (mr.status === 'rejected' && cf.status === 'rejected') {
    throw mr.reason instanceof Error ? mr.reason : new Error(String(mr.reason))
  }
  const mrList = mr.status === 'fulfilled' ? mr.value : []
  const cfList = cf.status === 'fulfilled' ? cf.value : []
  const out: CommunityResult[] = []
  for (let i = 0; i < Math.max(mrList.length, cfList.length); i++) {
    if (mrList[i]) out.push(mrList[i])
    if (cfList[i]) out.push(cfList[i])
  }
  return out
}

/** 项目文件列表（新→旧） */
export async function communityFiles(
  source: CommunitySource,
  projectId: string,
  filter?: { mcVersion?: string; loader?: LoaderName | '' }
): Promise<CommunityFile[]> {
  const id = String(projectId ?? '')
  if (source === 'modrinth') return mrFiles(id)
  return cfFiles(id, filter)
}

// ---------------- 对外：下载 ----------------

/** kind → 游戏目录下的子目录 */
const KIND_SUBDIR: Partial<Record<CommunityKind, string>> = {
  mod: 'mods',
  resourcepack: 'resourcepacks',
  shader: 'shaderpacks',
  datapack: 'datapacks'
}

/**
 * 下载社区资源文件。
 * - 普通资源：落到目标版本目录（实例隔离 _gameDir=true 时）或全局游戏目录对应子目录，返回绝对路径
 * - modpack：先下载到临时目录，随后后台启动整合包安装流程，立即返回 '整合包已开始安装'
 */
export async function communityDownload(
  file: CommunityFile,
  target: { versionId: string; kind: CommunityKind },
  emit: ProgressEmit,
  onDone?: (r: { versionId: string; ok: boolean; error?: string }) => void
): Promise<string> {
  const fileName = path.basename(String(file.fileName ?? '')) || 'download.bin'

  if (target.kind === 'modpack') {
    const tmpPath = path.join(os.tmpdir(), `kamucl-pack-${Date.now()}-${fileName}`)
    await downloadFile(file.url, tmpPath, undefined, file.sha1)
    // 动态 import 避免与 modpacks.ts 的循环依赖；后台异步安装，进度走 event:progress
    const { installModpack } = await import('./modpacks')
    void installModpack(tmpPath, emit)
      .then((id) => {
        fs.rmSync(tmpPath, { force: true })
        onDone?.({ versionId: id, ok: true })
      })
      .catch((err) => {
        fs.rmSync(tmpPath, { force: true })
        const text = errText(err)
        emit({ stage: 'error', progress: 0, text: `整合包安装失败: ${text}` })
        onDone?.({ versionId: '', ok: false, error: text })
      })
    return '整合包已开始安装'
  }

  // 实例隔离版本 → 版本目录；否则全局游戏目录
  let base = gameDir()
  try {
    if (readVersionJson(target.versionId)._gameDir === true) base = versionDir(target.versionId)
  } catch {
    /* 版本 json 读取失败时按全局目录处理 */
  }

  // 数据包：MC 只从 saves/<世界>/datapacks 加载——唯一存档直接投入，否则落 gameDir/datapacks 并提示
  if (target.kind === 'datapack') {
    const savesDir = path.join(base, 'saves')
    let worlds: string[] = []
    try {
      worlds = fs
        .readdirSync(savesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && fs.existsSync(path.join(savesDir, d.name, 'level.dat')))
        .map((d) => d.name)
    } catch {
      /* 无存档目录 */
    }
    if (worlds.length === 1) {
      const dest = path.join(savesDir, worlds[0], 'datapacks', fileName)
      await downloadFile(file.url, dest, undefined, file.sha1)
      return dest
    }
    const dest = path.join(base, 'datapacks', fileName)
    await downloadFile(file.url, dest, undefined, file.sha1)
    return `${dest}（提示：请将文件移入存档 saves/<世界>/datapacks 后生效）`
  }

  const sub = KIND_SUBDIR[target.kind]
  if (!sub) throw new Error(`不支持的资源类型: ${target.kind}`)
  const dest = path.join(base, sub, fileName)
  await downloadFile(file.url, dest, undefined, file.sha1)
  return dest
}
