/**
 * 整合包安装：Modrinth .mrpack、CurseForge .zip 与「解压即玩」全量包（含 .minecraft/versions）
 * 流程：探测格式 → 解析清单 → 安装游戏本体与加载器 → 创建隔离实例 → 下载文件 → 解压 overrides
 * 全量包：注册包内游戏版本（versions/<vid>）→ 游戏文件解压到实例目录（过滤启动器/垃圾文件）
 * 入口 installModpack(filePath, emit, opts?) 返回实例版本 id；probeModpack(filePath) 只解析不安装；
 * 失败抛出友好中文错误
 */
import fs from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'
import type { LoaderName, ModpackInfo, ProgressEvent } from '../../shared/types'
import { downloadAll, fetchSignal, type DownloadTask } from './download'
import { getSettings } from './settings'
import { registerVersionFolder, versionDir, versionJsonPath, versionsDir } from './paths'
import { gameDir } from './paths'
import { installVersion } from './versions'
import { throwIfCancelled } from './tasks'

export type ProgressEmit = (e: ProgressEvent) => void

/** 实例命名来源：file = 压缩包文件名；inner = 包内名称 */
export interface ModpackInstallOpts {
  nameSource?: 'file' | 'inner'
  /** 任务取消信号（下载中心取消按钮） */
  signal?: AbortSignal
}

// ---------------- 清单结构（只取需要的字段） ----------------

interface MrpackFile {
  path?: string
  hashes?: { sha1?: string; sha512?: string }
  downloads?: string[]
  fileSize?: number
  env?: { client?: string; server?: string }
}

interface MrpackIndex {
  formatVersion?: number
  game?: string
  name?: string
  versionId?: string
  dependencies?: Record<string, string>
  files?: MrpackFile[]
}

interface CfManifest {
  name?: string
  version?: string
  overrides?: string
  minecraft?: {
    version?: string
    modLoaders?: { id?: string; primary?: boolean }[]
  }
  files?: { projectID?: number; fileID?: number; required?: boolean }[]
}

/** 解析后的公共信息 */
interface PackMeta {
  name: string
  packVersion: string
  mcVersion: string
  loader?: LoaderName
  loaderVersion?: string
  /** overrides 目录前缀（zip 条目名，无尾斜杠），null = 无 */
  overridesPrefix: string | null
}

interface PendingFile {
  /** 实例目录内的相对路径（正斜杠） */
  rel: string
  url: string
  sha1?: string
  size: number
}

type Parsed =
  | { kind: 'mrpack'; meta: PackMeta; files: PendingFile[] }
  | { kind: 'curseforge'; meta: PackMeta; files: { projectID: number; fileID: number }[] }

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 防目录穿越：相对路径含 .. 段或为空时返回 null */
function safeJoin(base: string, rel: string): string | null {
  const parts = rel.split(/[\\/]+/).filter(Boolean)
  if (!parts.length || parts.includes('..')) return null
  return path.join(base, ...parts)
}

/** 清洗实例 id：去 \\/:*?"<>| 与首尾空格点 */
function sanitizeId(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|]/g, '').replace(/^[\s.]+|[\s.]+$/g, '')
  return clean || '整合包'
}

/** 实例 id 冲突时追加 -2、-3…；reserved 中的 id 同样跳过（如全量包注册的游戏版本 id） */
function uniqueInstanceId(name: string, reserved?: ReadonlySet<string>): string {
  const base = sanitizeId(name)
  let id = base
  let n = 2
  while (fs.existsSync(versionDir(id)) || reserved?.has(id)) id = `${base}-${n++}`
  return id
}

function readEntryJson(zip: AdmZip, name: string): unknown {
  const entry = zip.getEntry(name) ?? zip.getEntry('./' + name)
  if (!entry) return null
  return JSON.parse(entry.getData().toString('utf-8'))
}

// ---------------- 压缩包打开与格式探测（install / probe 共用） ----------------

/** 归一化 zip 条目名：\ → /，去开头 ./ */
const normEntry = (name: string): string => name.replace(/\\/g, '/').replace(/^\.\//, '')

/** 压缩包文件名（去扩展名），作为实例命名来源之一 */
const packFileName = (filePath: string): string => path.basename(filePath).replace(/\.[^.]+$/, '')

function openPackZip(filePath: string): AdmZip {
  if (!filePath || !fs.existsSync(filePath)) throw new Error('整合包文件不存在，请重新选择')
  try {
    const zip = new AdmZip(filePath)
    zip.getEntries()
    return zip
  } catch {
    throw new Error('整合包文件损坏或不是有效的压缩包')
  }
}

/** 全量包探测结果 */
interface FullpackDetected {
  /** 包内游戏版本 id（versions/<vid>/<vid>.json） */
  vid: string
  /** 版本 json 条目名（归一化后） */
  jsonEntry: string
  /** 游戏根目录前缀（zip 条目名，含尾斜杠；'' = zip 根，如 'xxx/.minecraft/'） */
  prefix: string
}

/** 探测 zip 内 versions/<vid>/<vid>.json（任意嵌套前缀）；多版本时选继承链顶端的加载器版本 */
function detectFullpackEntry(zip: AdmZip): FullpackDetected | null {
  const all: FullpackDetected[] = []
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue
    const name = normEntry(e.entryName)
    const m = /(?:^|\/)versions\/([^/]+)\/\1\.json$/.exec(name)
    if (!m) continue
    const tail = `versions/${m[1]}/${m[1]}.json`
    all.push({ vid: m[1], jsonEntry: name, prefix: name.slice(0, name.length - tail.length) })
  }
  if (!all.length) return null

  // 同一游戏根前缀成组：.minecraft/ 下优先，其次 zip 根
  const prefScore = (p: string): number => (/\.minecraft\/$/i.test(p) ? 2 : p === '' ? 1 : 0)
  let group = all.filter((c) => c.prefix === all[0].prefix)
  let groupScore = prefScore(all[0].prefix)
  for (const c of all) {
    const s = prefScore(c.prefix)
    if (s > groupScore) {
      groupScore = s
      group = all.filter((x) => x.prefix === c.prefix)
    }
  }

  // 继承链顶端 = 没有被其他版本 inheritsFrom 指向的 vid（全量包常同时携带原版基础版本）
  const inherited = new Set<string>()
  for (const c of group) {
    try {
      const j = JSON.parse(zip.getEntry(c.jsonEntry)?.getData().toString('utf-8') ?? '{}') as {
        inheritsFrom?: unknown
      }
      if (typeof j.inheritsFrom === 'string' && j.inheritsFrom) inherited.add(j.inheritsFrom)
    } catch {
      /* 单个 json 损坏不阻断探测；若恰好被选中，parseFullpack 会报友好错误 */
    }
  }
  const leaves = group.filter((c) => !inherited.has(c.vid))
  const pool = leaves.length ? leaves : group
  return pool.find((c) => /fabric|forge|quilt|neoforge/i.test(c.vid)) ?? pool[0]
}

type Detected =
  | { format: 'mrpack' | 'curseforge' }
  | { format: 'fullpack'; full: FullpackDetected }

/** 三格式探测：mrpack → curseforge → fullpack，均不命中抛错 */
function detectPack(zip: AdmZip): Detected {
  const names = new Set(zip.getEntries().map((e) => normEntry(e.entryName)))
  if (names.has('modrinth.index.json')) return { format: 'mrpack' }
  if (names.has('manifest.json')) return { format: 'curseforge' }
  const full = detectFullpackEntry(zip)
  if (full) return { format: 'fullpack', full }
  throw new Error(
    '无法识别的整合包格式（支持 Modrinth .mrpack、CurseForge .zip 与含 versions 目录的完整客户端包）'
  )
}

// ---------------- Modrinth .mrpack ----------------

/** mrpack dependencies → 加载器（取第一个命中的） */
const MR_LOADERS: Array<[string, LoaderName]> = [
  ['fabric-loader', 'fabric'],
  ['quilt-loader', 'quilt'],
  ['neoforge', 'neoforge'],
  ['forge', 'forge']
]

function parseMrpack(zip: AdmZip): Parsed {
  let idx: MrpackIndex | null = null
  try {
    idx = readEntryJson(zip, 'modrinth.index.json') as MrpackIndex | null
  } catch {
    throw new Error('modrinth.index.json 已损坏，整合包无法解析')
  }
  const mcVersion = idx?.dependencies?.minecraft
  if (!mcVersion) throw new Error('整合包清单缺少 Minecraft 版本，文件可能损坏')

  let loader: LoaderName | undefined
  let loaderVersion: string | undefined
  for (const [key, l] of MR_LOADERS) {
    const v = idx?.dependencies?.[key]
    if (v) {
      loader = l
      loaderVersion = v
      break
    }
  }

  const files: PendingFile[] = []
  for (const f of idx?.files ?? []) {
    if (!f?.path) continue
    // 仅服务端需要的文件跳过（server-only）
    if (f.env?.server === 'required' && f.env?.client === 'unsupported') continue
    const url = f.downloads?.[0]
    if (!url) continue
    files.push({
      rel: f.path.replace(/\\/g, '/'),
      url,
      sha1: f.hashes?.sha1,
      size: f.fileSize ?? 0
    })
  }

  return {
    kind: 'mrpack',
    meta: {
      name: (idx?.name ?? '').trim() || '未命名整合包',
      packVersion: idx?.versionId ?? '',
      mcVersion,
      loader,
      loaderVersion,
      overridesPrefix: 'overrides'
    },
    files
  }
}

// ---------------- CurseForge .zip ----------------

const CF_LOADER_IDS = new Set(['fabric', 'forge', 'quilt', 'neoforge'])

function parseCurseForge(zip: AdmZip): Parsed {
  let mf: CfManifest | null = null
  try {
    mf = readEntryJson(zip, 'manifest.json') as CfManifest | null
  } catch {
    throw new Error('manifest.json 已损坏，整合包无法解析')
  }
  const mcVersion = mf?.minecraft?.version
  if (!mcVersion) throw new Error('整合包清单缺少 Minecraft 版本，文件可能损坏')

  let loader: LoaderName | undefined
  let loaderVersion: string | undefined
  const modLoaders = mf?.minecraft?.modLoaders ?? []
  const primary = modLoaders.find((l) => l.primary) ?? modLoaders[0]
  if (primary?.id) {
    // id 形如 forge-47.2.0 / fabric-0.16.9
    const m = /^([A-Za-z]+)-(.+)$/.exec(primary.id)
    const name = (m?.[1] ?? '').toLowerCase()
    if (!m || !CF_LOADER_IDS.has(name)) {
      throw new Error(`暂不支持该整合包使用的加载器：${primary.id}`)
    }
    loader = name as LoaderName
    loaderVersion = m[2]
  }

  return {
    kind: 'curseforge',
    meta: {
      name: (mf?.name ?? '').trim() || '未命名整合包',
      packVersion: mf?.version ?? '',
      mcVersion,
      loader,
      loaderVersion,
      overridesPrefix: mf?.overrides ?? 'overrides'
    },
    files: (mf?.files ?? [])
      .filter((f) => !!f?.projectID && !!f?.fileID)
      .map((f) => ({ projectID: f.projectID as number, fileID: f.fileID as number }))
  }
}

// ---------------- 全量包（解压即玩） ----------------

interface FullpackMeta {
  vid: string
  prefix: string
  mcVersion: string
  loader?: LoaderName
  loaderVersion?: string
}

/** id 关键词 → 加载器与版本号猜测（顺序敏感：neoforge 先于 forge） */
const FULL_LOADER_GUESS: Array<[LoaderName, RegExp]> = [
  ['neoforge', /neoforge[-_]([0-9][\w.]*)/],
  ['fabric', /fabric-loader[-_]([0-9][\w.]*)/],
  ['quilt', /quilt-loader[-_]([0-9][\w.]*)/],
  ['forge', /forge[-_]([0-9][\w.]*)/]
]

/** 解析全量包版本 json：mcVersion 取 inheritsFrom（无则 id）；loader 由 _loader 或 id 关键词推断 */
function parseFullpack(zip: AdmZip, det: FullpackDetected): FullpackMeta {
  let json: {
    id?: unknown
    inheritsFrom?: unknown
    _loader?: unknown
    _loaderVersion?: unknown
  } | null = null
  try {
    json = JSON.parse(zip.getEntry(det.jsonEntry)?.getData().toString('utf-8') ?? '')
  } catch {
    throw new Error('包内版本描述文件已损坏，整合包无法解析')
  }
  const id = typeof json?.id === 'string' && json.id ? json.id : det.vid
  const mcVersion =
    typeof json?.inheritsFrom === 'string' && json.inheritsFrom ? json.inheritsFrom : id

  let loader: LoaderName | undefined
  let loaderVersion: string | undefined
  const declared = typeof json?._loader === 'string' ? json._loader.toLowerCase() : ''
  if (CF_LOADER_IDS.has(declared)) {
    loader = declared as LoaderName
    loaderVersion = typeof json?._loaderVersion === 'string' ? json._loaderVersion : undefined
  } else {
    const text = id.toLowerCase()
    for (const [l, re] of FULL_LOADER_GUESS) {
      const m = re.exec(text)
      if (m) {
        loader = l
        loaderVersion = m[1]
        break
      }
    }
    if (!loader) {
      if (text.includes('neoforge')) loader = 'neoforge'
      else if (text.includes('fabric')) loader = 'fabric'
      else if (text.includes('quilt')) loader = 'quilt'
      else if (text.includes('forge')) loader = 'forge'
    }
  }
  return { vid: det.vid, prefix: det.prefix, mcVersion, loader, loaderVersion }
}

// ---- 全量包解压：无用文件过滤 ----

/** Windows 非法设备名（含带扩展名形式，如 nul.txt） */
const ILLEGAL_NAME = /^(nul|aux|con|prn|com[1-9]|lpt[1-9])(\..*)?$/i
/** 系统垃圾文件 */
const JUNK_FILE = /^(\.ds_store|thumbs\.db|desktop\.ini)$/i
/** 整目录跳过：macOS 元数据 / 日志 / 崩溃报告 */
const SKIP_DIR = new Set(['__macosx', 'logs', 'crash-reports'])

/** 全量包条目是否跳过：目录穿越 / 启动器与脚本(*.exe|*.bat|*.cmd) / 系统垃圾 / 日志崩溃 / 非法名 */
function skipFullEntry(rel: string): boolean {
  const parts = rel.split('/').filter(Boolean)
  if (!parts.length || parts.includes('..')) return true
  const file = parts[parts.length - 1]
  if (/\.(exe|bat|cmd)$/i.test(file)) return true
  if (JUNK_FILE.test(file)) return true
  for (const seg of parts) {
    if (SKIP_DIR.has(seg.toLowerCase())) return true
    if (ILLEGAL_NAME.test(seg)) return true
  }
  return false
}

/** 已知游戏根内容（无 .minecraft 前缀时判定 zip 根游戏文件用） */
const GAME_ROOT_HINTS = new Set([
  'mods',
  'config',
  'defaultconfigs',
  'saves',
  'resourcepacks',
  'shaderpacks',
  'screenshots',
  'schematics',
  'datapacks',
  'kubejs',
  'scripts',
  'libraries',
  'assets',
  'cache',
  'backups',
  'journeymap',
  'options.txt',
  'optionsof.txt',
  'servers.dat',
  'servers.dat_old'
])

/**
 * 计算全量包普通条目相对游戏根的路径与来源优先级。
 * score 2 = 来自 .minecraft/ 下（多处前缀冲突时优先）；1 = 游戏根前缀 / zip 根；null = 与游戏无关跳过
 */
function fullpackGameRel(
  name: string,
  det: FullpackDetected
): { rel: string; score: number } | null {
  if (det.prefix && name.startsWith(det.prefix)) {
    const rel = name.slice(det.prefix.length)
    if (!rel) return null
    return { rel, score: /\.minecraft\/$/i.test(det.prefix) ? 2 : 1 }
  }
  const mi = name.toLowerCase().indexOf('.minecraft/')
  if (mi >= 0) {
    const rel = name.slice(mi + '.minecraft/'.length)
    return rel ? { rel, score: 2 } : null
  }
  const first = name.split('/')[0]?.toLowerCase() ?? ''
  if (GAME_ROOT_HINTS.has(first)) return { rel: name, score: 1 }
  return null
}

type ZipEntry = ReturnType<AdmZip['getEntries']>[number]

interface ExtractOp {
  entry: ZipEntry
  dest: string
  /** 目标已存在时跳过（保护已安装的游戏版本） */
  skipIfExists: boolean
}

/** 汇总全量包解压计划：versions/** → 全局 versions 目录；其余游戏文件 → 实例目录（去重） */
function planFullpackExtract(zip: AdmZip, det: FullpackDetected, instDir: string): ExtractOp[] {
  const ops: ExtractOp[] = []
  const vpre = det.prefix + 'versions/'

  // a) 包内 versions/** 注册为全局游戏版本（zip 自带 <vid>.json/.jar 与可能的原版基础版本）
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const name = normEntry(entry.entryName)
    if (!name.startsWith(vpre)) continue
    const rel = name.slice(vpre.length)
    if (rel.split('/').filter(Boolean).length < 2) continue // 必须形如 <vid>/<file>
    if (skipFullEntry(rel)) continue
    const dest = safeJoin(versionsDir(), rel)
    if (!dest) continue
    ops.push({ entry, dest, skipIfExists: true })
  }

  // b) 其余游戏文件 → 实例目录；同名冲突以 .minecraft/ 下来源为准
  const picked = new Map<string, { entry: ZipEntry; dest: string; score: number }>()
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const name = normEntry(entry.entryName)
    if (name.startsWith(vpre)) continue
    const g = fullpackGameRel(name, det)
    if (!g || skipFullEntry(g.rel)) continue
    const dest = safeJoin(instDir, g.rel)
    if (!dest) continue
    const key = g.rel.toLowerCase()
    const old = picked.get(key)
    if (!old || g.score > old.score) picked.set(key, { entry, dest, score: g.score })
  }
  for (const p of picked.values()) ops.push({ entry: p.entry, dest: p.dest, skipIfExists: false })
  return ops
}

/** 全量包安装：注册游戏版本 + 游戏文件入实例目录 + 写实例 json */
async function installFullpack(
  zip: AdmZip,
  det: FullpackDetected,
  fileName: string,
  nameSource: 'file' | 'inner',
  emit: ProgressEmit,
  signal?: AbortSignal
): Promise<string> {
  emit({ stage: 'modpack', progress: 0, text: '解析整合包信息…' })
  const meta = parseFullpack(zip, det)
  const name = (nameSource === 'inner' ? meta.vid : fileName) || meta.vid
  const loaderText = meta.loader ? ` + ${meta.loader} ${meta.loaderVersion ?? ''}` : ''
  emit({ stage: 'modpack', progress: 0.02, text: `${name}（MC ${meta.mcVersion}${loaderText}）` })

  // 实例 id 不能撞包内注册的游戏版本 id（否则实例 json 会覆盖版本 json）
  const shippedVids = new Set<string>()
  const vpre = det.prefix + 'versions/'
  for (const e of zip.getEntries()) {
    const n = normEntry(e.entryName)
    if (!n.startsWith(vpre)) continue
    const seg = n.slice(vpre.length).split('/')[0]
    if (seg) shippedVids.add(seg)
  }
  const id = uniqueInstanceId(name, shippedVids)
  const instDir = versionDir(id)
  fs.mkdirSync(instDir, { recursive: true })

  const ops = planFullpackExtract(zip, det, instDir)
  const total = ops.length
  let done = 0
  const createdFiles: string[] = []
  try {
    for (const op of ops) {
      throwIfCancelled(signal)
      done++
      if (!(op.skipIfExists && fs.existsSync(op.dest))) {
        fs.mkdirSync(path.dirname(op.dest), { recursive: true })
        fs.writeFileSync(op.dest, op.entry.getData())
        createdFiles.push(op.dest)
      }
      if (done % 8 === 0 || done === total) {
        emit({
          stage: 'modpack',
          progress: 0.05 + (total ? (done / total) * 0.9 : 0.9),
          text: `解压游戏文件 ${done}/${total}`
        })
        // 让主进程有机会处理“取消”IPC，避免大量同步 ZIP 条目饿死事件循环。
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }

    // 版本注册校验：版本 json 必须就位（zip 内必有，除非被意外跳过）
    if (!fs.existsSync(versionJsonPath(meta.vid))) {
      throw new Error('游戏版本注册失败：包内缺少有效的版本描述文件')
    }

    throwIfCancelled(signal)
    emit({ stage: 'modpack', progress: 0.97, text: '创建游戏实例…' })
    const instanceJson = {
      id,
      inheritsFrom: meta.vid,
      ...(meta.loader ? { _loader: meta.loader, _loaderVersion: meta.loaderVersion } : {}),
      _gameDir: true,
      _modpackName: name,
      _modpackVersion: meta.vid
    }
    fs.writeFileSync(versionJsonPath(id), JSON.stringify(instanceJson, null, 2), 'utf-8')
    registerVersionFolder(id, gameDir())

    emit({ stage: 'done', progress: 1, text: `${name} 安装完成` })
    return id
  } catch (e) {
    // 只回滚本次新建文件；skipIfExists 的用户既有版本文件绝不删除。
    for (const file of createdFiles.reverse()) fs.rmSync(file, { force: true })
    fs.rmSync(instDir, { recursive: true, force: true })
    throw e
  }
}

// ---------------- CurseForge 文件地址解析（MCIM 国内镜像，免 key） ----------------

const MCIM_CF = 'https://mod.mcimirror.top/curseforge/v1'

/** 先取文件信息（fileName + downloadUrl）；失败退回直接下载端点（302 到文件） */
async function resolveCfFile(
  projectID: number,
  fileID: number,
  signal?: AbortSignal
): Promise<{ url: string; fileName: string }> {
  const fallbackUrl = `${MCIM_CF}/mods/${projectID}/files/${fileID}/download`
  try {
    const res = await fetch(`${MCIM_CF}/mods/${projectID}/files/${fileID}`, {
      signal: fetchSignal(signal)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as {
      data?: { fileName?: string; downloadUrl?: string | null }
    }
    const fileName = json.data?.fileName
    if (!fileName) throw new Error('镜像返回缺少 fileName')
    return { url: json.data?.downloadUrl || fallbackUrl, fileName }
  } catch {
    if (signal?.aborted) throw new Error('已取消')
    return { url: fallbackUrl, fileName: `${projectID}-${fileID}.jar` }
  }
}

/** 简单并发池（保序写入结果数组） */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let idx = 0
  const worker = async (): Promise<void> => {
    while (idx < items.length) {
      throwIfCancelled(signal)
      const i = idx++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** 只解压 overrides 前缀下的条目到实例目录（含 .. 的可疑条目跳过），返回文件数 */
async function extractOverrides(
  zip: AdmZip,
  prefix: string | null,
  destDir: string,
  signal?: AbortSignal
): Promise<number> {
  if (!prefix) return 0
  const pre = prefix.replace(/[\\/]+/g, '/').replace(/\/+$/, '') + '/'
  let count = 0
  for (const entry of zip.getEntries()) {
    throwIfCancelled(signal)
    const name = entry.entryName.replace(/\\/g, '/')
    if (entry.isDirectory || !name.startsWith(pre)) continue
    const dest = safeJoin(destDir, name.slice(pre.length))
    if (!dest) continue
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, entry.getData())
    count++
    if (count % 8 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return count
}

const fmtMB = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1) + 'MB'

/** 只解析整合包元信息（不解压不下载），供导入确认弹窗展示 */
export async function probeModpack(filePath: string): Promise<ModpackInfo> {
  const zip = openPackZip(filePath)
  const detected = detectPack(zip)
  const fileName = packFileName(filePath)
  if (detected.format === 'fullpack') {
    const meta = parseFullpack(zip, detected.full)
    return {
      format: 'fullpack',
      innerName: meta.vid,
      fileName,
      version: meta.vid,
      mcVersion: meta.mcVersion,
      loader: meta.loader,
      loaderVersion: meta.loaderVersion
    }
  }
  const parsed = detected.format === 'mrpack' ? parseMrpack(zip) : parseCurseForge(zip)
  const { meta } = parsed
  return {
    format: detected.format,
    innerName: meta.name,
    fileName,
    version: meta.packVersion,
    mcVersion: meta.mcVersion,
    loader: meta.loader,
    loaderVersion: meta.loaderVersion
  }
}

/**
 * 安装整合包，返回实例版本 id。
 * 实例版本 json 带 _gameDir: true（启动时游戏目录隔离到 versions/<id>）。
 * opts.nameSource：'file'（默认）以压缩包文件名命名实例；'inner' 以包内名称命名
 */
export async function installModpack(
  filePath: string,
  emit: ProgressEmit,
  opts?: ModpackInstallOpts
): Promise<string> {
  // 1) 校验存在性与 zip 可读、探测格式
  const zip = openPackZip(filePath)
  const nameSource = opts?.nameSource === 'inner' ? 'inner' : 'file'
  const fileName = packFileName(filePath)
  const detected = detectPack(zip)

  // 全量包：解压即玩，无需下载
  if (detected.format === 'fullpack') {
    return await installFullpack(zip, detected.full, fileName, nameSource, emit, opts?.signal)
  }

  // 2) 解析清单
  emit({ stage: 'modpack', progress: 0, text: '解析整合包信息…' })
  const parsed = detected.format === 'mrpack' ? parseMrpack(zip) : parseCurseForge(zip)
  throwIfCancelled(opts?.signal)
  const { meta } = parsed
  const loaderText = meta.loader ? ` + ${meta.loader} ${meta.loaderVersion ?? ''}` : ''
  emit({
    stage: 'modpack',
    progress: 0.02,
    text: `${meta.name}（MC ${meta.mcVersion}${loaderText}）`
  })

  // 3) 实例 id（清洗 + 冲突追加序号）
  const id = uniqueInstanceId(nameSource === 'inner' ? meta.name : fileName)
  const instDir = versionDir(id)

  try {

  // 4) 安装游戏本体与加载器（已有的文件自动跳过）
  emit({ stage: 'modpack', progress: 0.05, text: '安装游戏本体与加载器…' })
  const baseVersionId = await installVersion(
    meta.mcVersion,
    meta.loader ? { loader: meta.loader, loaderVersion: meta.loaderVersion } : {},
    emit,
    opts?.signal
  )

  // 5) 创建实例版本
  fs.mkdirSync(instDir, { recursive: true })
  const instanceJson = {
    id,
    inheritsFrom: baseVersionId,
    ...(meta.loader ? { _loader: meta.loader, _loaderVersion: meta.loaderVersion } : {}),
    _gameDir: true,
    _modpackName: meta.name,
    _modpackVersion: meta.packVersion
  }
  fs.writeFileSync(versionJsonPath(id), JSON.stringify(instanceJson, null, 2), 'utf-8')
  registerVersionFolder(id, gameDir())

  // 6) 下载整合包文件
  let pending: PendingFile[]
  if (parsed.kind === 'mrpack') {
    pending = parsed.files
  } else {
    // CurseForge：先经 MCIM 镜像解析真实文件名与下载地址
    const cfFiles = parsed.files
    let resolved = 0
    const infos = await mapPool(cfFiles, 8, async (f) => {
      const info = await resolveCfFile(f.projectID, f.fileID, opts?.signal)
      resolved++
      emit({
        stage: 'modpack',
        progress: 0.05 + (cfFiles.length ? (resolved / cfFiles.length) * 0.05 : 0),
        text: `解析下载地址 ${resolved}/${cfFiles.length}`
      })
      return info
    }, opts?.signal)
    pending = infos.map((info) => ({ rel: `mods/${info.fileName}`, url: info.url, size: 0 }))
  }

  const tasks: DownloadTask[] = []
  const sizes: number[] = []
  for (const f of pending) {
    const dest = safeJoin(instDir, f.rel)
    if (!dest) continue // 拒绝含 .. 的条目
    tasks.push({ url: f.url, dest, sha1: f.sha1 })
    sizes.push(f.size)
  }
  // 按 fileSize 汇总进度（任务按序派发，用前缀和近似已完成字节数；无 size 时退化为按文件数）
  const prefixSum: number[] = [0]
  for (const s of sizes) prefixSum.push(prefixSum[prefixSum.length - 1] + s)
  const totalBytes = prefixSum[prefixSum.length - 1]

  if (tasks.length) {
    try {
      await downloadAll(
        tasks,
        (d, t, speed) => {
          const doneBytes = prefixSum[d] ?? 0
          const ratio = totalBytes ? doneBytes / totalBytes : t ? d / t : 0
          emit({
            stage: 'modpack',
            progress: 0.1 + ratio * 0.85,
            text: totalBytes
              ? `下载整合包文件 ${d}/${t}（${fmtMB(doneBytes)}/${fmtMB(totalBytes)}）`
              : `下载整合包文件 ${d}/${t}`,
            speed
          })
        },
        8,
        getSettings().mirror,
        opts?.signal
      )
    } catch (e) {
      throw new Error(`整合包文件下载失败：${errText(e)}`)
    }
  }

  // 7) 解压 overrides 覆盖到实例目录
  emit({ stage: 'modpack', progress: 0.96, text: '解压覆盖文件…' })
  throwIfCancelled(opts?.signal)
  await extractOverrides(zip, meta.overridesPrefix, instDir, opts?.signal)

  // 8) 完成
  emit({ stage: 'done', progress: 1, text: `${meta.name} 安装完成` })
  return id
  } catch (e) {
    // id 由 uniqueInstanceId 生成，本次流程独占；失败/取消时可安全整目录回滚。
    fs.rmSync(instDir, { recursive: true, force: true })
    throw e
  }
}
