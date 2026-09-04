/**
 * 加载器：fabric / quilt / forge / neoforge 的版本列表与安装
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { FabricApiVersion, LoaderName, ProgressEvent } from '../../shared/types'
import { downloadAll, downloadFile } from './download'
import { getSettings } from './settings'
import { gameDir, registerVersionFolder, versionDir, versionJsonPath, versionsDir } from './paths'
import { ensureJava, scanJava } from './java'
import {
  installVanilla,
  libraryTasks,
  migrateDependencyVanilla,
  readVersionJson,
  type VersionJson
} from './versions'

export type ProgressEmit = (e: ProgressEvent) => void

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
  return res.json()
}

// ---------------- 版本列表 ----------------

/** 版本号倒序比较器：数字段数值比、同位稳定版优先于预发布（beta 等文本段），最新排最前 */
function compareVersionDesc(a: string, b: string): number {
  const pa = a.split(/[.-]/)
  const pb = b.split(/[.-]/)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const xa = pa[i]
    const xb = pb[i]
    if (xa === undefined) return 1 // 段数少 = 更旧，排后
    if (xb === undefined) return -1
    const aNum = /^\d+$/.test(xa)
    const bNum = /^\d+$/.test(xb)
    if (aNum && bNum) {
      const d = Number(xb) - Number(xa)
      if (d !== 0) return d
    } else if (aNum) {
      return -1 // 同位数字段（正式）优先于文本段（beta/rc）
    } else if (bNum) {
      return 1
    } else {
      const c = xb.localeCompare(xa) // 文本段按字母倒序（rc > beta）
      if (c !== 0) return c
    }
  }
  return 0
}

/** 获取加载器可用版本列表（最新在前） */
export async function listLoaderVersions(
  loader: LoaderName,
  mcVersion: string
): Promise<string[]> {
  let list: string[]
  switch (loader) {
    case 'fabric': {
      const arr = (await fetchJson(
        `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`
      )) as { loader?: { version?: string } }[]
      list = arr.map((x) => x.loader?.version).filter((v): v is string => !!v)
      break
    }
    case 'quilt': {
      const arr = (await fetchJson(
        `https://meta.quiltmc.org/v3/versions/loader/${mcVersion}`
      )) as { loader?: { version?: string } }[]
      list = arr.map((x) => x.loader?.version).filter((v): v is string => !!v)
      break
    }
    case 'forge': {
      const arr = (await fetchJson(
        `https://bmclapi2.bangbang93.com/forge/minecraft/${mcVersion}`
      )) as { version?: string }[]
      list = arr.map((x) => x.version).filter((v): v is string => !!v)
      break
    }
    case 'neoforge': {
      try {
        const res = await fetch(`https://bmclapi2.bangbang93.com/neoforge/list/${mcVersion}`, {
          signal: AbortSignal.timeout(30000)
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as unknown
        if (Array.isArray(data)) {
          list = data
            .map((x) => (typeof x === 'string' ? x : ((x as { version?: string }).version ?? '')))
            .filter(Boolean)
          break
        }
        throw new Error('返回格式异常')
      } catch {
        // 回退：解析 maven-metadata.xml，过滤 mc 前缀（1.20.4 -> 20.4）
        const res = await fetch(
          'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml',
          { signal: AbortSignal.timeout(30000) }
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}: neoforge maven-metadata`)
        const xml = await res.text()
        const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1])
        const prefix = mcVersion.replace(/^1\./, '')
        list = all.filter((v) => v.startsWith(prefix)).reverse()
        break
      }
    }
  }
  // 统一按版本号倒序：最新版本排最前（下拉默认选中第一个即最新版）
  return list.sort(compareVersionDesc)
}

// ---------------- 安装 ----------------

/** 选一个可用 java 运行安装器：优先本机扫描，实在不行用 ensureJava 下载 */
async function pickJavaForInstaller(mcVersion: string, emit: ProgressEmit): Promise<string> {
  const found = scanJava()
  const any = found.find((j) => j.is64Bit) ?? found[0]
  if (any) return any.path
  // 本机完全没有 Java，按原版需求下载一个
  const vj = readVersionJson(mcVersion)
  return await ensureJava(vj, emit)
}

/** 运行 forge/neoforge 安装器：全量输出落盘 installer.log；失败带最后 30 行；--mirror= 等号形式，失败降级去 mirror 重试；signal 取消时杀掉安装器进程 */
function runInstaller(javaPath: string, jar: string, emit: ProgressEmit, signal?: AbortSignal): Promise<void> {
  const useMirror = getSettings().mirror === 'bmclapi'

  const buildArgs = (withMirror: boolean): string[] => {
    const args = ['-jar', jar, '--installClient', gameDir()]
    if (withMirror) args.push('--mirror=https://bmclapi2.bangbang93.com/maven')
    return args
  }

  const runOnce = (args: string[]): Promise<void> =>
    new Promise((resolve, reject) => {
      const proc = spawn(javaPath, args, { windowsHide: true })
      const onAbort = () => {
        try {
          proc.kill()
        } catch {
          /* 忽略 */
        }
        reject(new Error('已取消'))
      }
      if (signal) {
        if (signal.aborted) {
          proc.kill()
          reject(new Error('已取消'))
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      const allLines: string[] = []
      let tail = ''
      const onData = (d: Buffer): void => {
        const lines = (tail + d.toString('utf-8')).split(/\r?\n/)
        tail = lines.pop() ?? ''
        for (const l of lines) if (l.trim()) allLines.push(l)
        const shortTail = lines.slice(-2).join(' ').slice(-160)
        emit({ stage: 'loader', progress: 0.75, text: `安装器: ${shortTail || '运行中…'}` })
      }
      proc.stdout.on('data', onData)
      proc.stderr.on('data', onData)
      proc.on('error', reject)
      proc.on('exit', (code) => {
        if (tail.trim()) allLines.push(tail)
        // 全量输出落盘，便于排查
        try {
          const logDir = path.join(gameDir(), 'kamucl-logs')
          fs.mkdirSync(logDir, { recursive: true })
          fs.writeFileSync(
            path.join(logDir, 'installer.log'),
            allLines.join('\n') + `\n\n[退出码 ${code ?? '未知'}] ${args.join(' ')}\n`,
            'utf-8'
          )
        } catch {
          /* 日志写盘失败不影响流程 */
        }
        if (code === 0) resolve()
        else {
          const last = allLines.slice(-30).join('\n')
          reject(new Error(`安装器退出码 ${code}（完整日志见 kamucl-logs/installer.log）\n${last}`))
        }
      })
    })

  return runOnce(buildArgs(useMirror)).catch((err) => {
    if (!useMirror) throw err
    emit({ stage: 'loader', progress: 0.7, text: '镜像模式安装失败，改用官方源重试…' })
    return runOnce(buildArgs(false))
  })
}

/** 安装完成后扫描 versions/ 找安装器生成的版本目录名 */
function findInstalledDir(loader: LoaderName, mcVersion: string, loaderVersion: string): string | null {
  const dir = versionsDir()
  if (!fs.existsSync(dir)) return null
  // Forge 生成的目录名形如 `<mc>-forge-<ver>`；NeoForge 形如 `neoforge-<ver>`
  const needle = loader === 'forge' ? `forge-${loaderVersion}` : loaderVersion
  const candidates = fs
    .readdirSync(dir)
    .filter((name) => {
      const lower = name.toLowerCase()
      if (!lower.includes(loader)) return false
      if (!name.includes(needle)) return false
      return fs.existsSync(versionJsonPath(name))
    })
    .map((name) => ({ name, mtime: fs.statSync(versionDir(name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return candidates[0]?.name ?? null
}

/** 给安装好的版本 json 补写 _loader/_loaderVersion 标记 */
function tagLoaderJson(id: string, loader: LoaderName, loaderVersion: string): void {
  const p = versionJsonPath(id)
  const j = JSON.parse(fs.readFileSync(p, 'utf-8')) as VersionJson
  j._loader = loader
  j._loaderVersion = loaderVersion
  fs.writeFileSync(p, JSON.stringify(j, null, 2), 'utf-8')
}

/**
 * 安装加载器，返回新版本的 id。
 * 原版作为内部依赖：fabric/quilt 直接装进 .kamucl/base（不进版本列表）；
 * forge/neoforge 安装器强制要求 versions/ 下存在原版，先落地、装完（无论成败）再迁移进 base。
 */
export async function installLoader(
  loader: LoaderName,
  mcVersion: string,
  loaderVersion: string,
  emit: ProgressEmit,
  instanceName?: string,
  signal?: AbortSignal
): Promise<string> {
  emit({ stage: 'loader', progress: 0, text: `检查原版 ${mcVersion}` })
  const vanillaPreExisted = fs.existsSync(versionJsonPath(mcVersion))
  const installerBased = loader === 'forge' || loader === 'neoforge'
  await installVanilla(mcVersion, emit, vanillaPreExisted || installerBased ? 'versions' : 'base', undefined, signal)

  // ---- fabric / quilt：profile json 直写 ----
  if (loader === 'fabric' || loader === 'quilt') {
    const base =
      loader === 'fabric' ? 'https://meta.fabricmc.net/v2' : 'https://meta.quiltmc.org/v3'
    emit({ stage: 'loader', progress: 0.1, text: `获取 ${loader} ${loaderVersion} 配置` })
    const profile = (await fetchJson(
      `${base}/versions/loader/${mcVersion}/${loaderVersion}/profile/json`
    )) as VersionJson
    const id = instanceName?.trim() || profile.id
    if (!id) throw new Error(`${loader} profile 缺少 id`)
    // 自定义实例名：json id 同步改写，inheritsFrom 保持不变
    profile.id = id
    profile._loader = loader
    profile._loaderVersion = loaderVersion
    fs.mkdirSync(versionDir(id), { recursive: true })
    fs.writeFileSync(versionJsonPath(id), JSON.stringify(profile, null, 2), 'utf-8')

    // profile 自带的依赖库也要下载
    const tasks = libraryTasks(profile)
    const mirror = getSettings().mirror
    await downloadAll(
      tasks,
      (d, t, speed) =>
        emit({
          stage: 'loader',
          progress: 0.1 + (t ? (d / t) * 0.9 : 0),
          text: `${loader} 依赖库 ${d}/${t}`,
          speed
        }),
      8,
      mirror,
      signal
    )
    emit({ stage: 'done', progress: 1, text: `${id} 安装完成` })
    registerVersionFolder(id, gameDir()) // fabric/quilt 实例注册到当前活动文件夹
    return id
  }

  // ---- forge / neoforge：下载 installer 并运行 ----
  const fileBase =
    loader === 'forge'
      ? `forge-${mcVersion}-${loaderVersion}-installer.jar`
      : `neoforge-${loaderVersion}-installer.jar`
  const officialUrl =
    loader === 'forge'
      ? `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${loaderVersion}/${fileBase}`
      : `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/${fileBase}`
  const mirrorUrlB =
    loader === 'forge'
      ? `https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/${mcVersion}-${loaderVersion}/${fileBase}`
      : `https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/${loaderVersion}/${fileBase}`

  const jarPath = path.join(os.tmpdir(), `kamucl-${loader}-installer-${Date.now()}.jar`)
  try {
    emit({ stage: 'loader', progress: 0.2, text: `下载 ${loader} 安装器` })
    try {
      await downloadFile(officialUrl, jarPath, (d, t) =>
        emit({
          stage: 'loader',
          progress: 0.2 + (t ? (d / t) * 0.4 : 0),
          text: `下载安装器 ${(d / 1024 / 1024).toFixed(1)}MB`
        }), undefined, undefined, signal
      )
    } catch {
      // 官方源失败回退 BMCLAPI（取消除外）
      if (signal?.aborted) throw new Error('已取消')
      await downloadFile(mirrorUrlB, jarPath, (d, t) =>
        emit({
          stage: 'loader',
          progress: 0.2 + (t ? (d / t) * 0.4 : 0),
          text: `下载安装器(镜像) ${(d / 1024 / 1024).toFixed(1)}MB`
        }), undefined, undefined, signal
      )
    }

    const javaPath = await pickJavaForInstaller(mcVersion, emit)
    // Forge/NeoForge 安装器要求目标目录存在 launcher_profiles.json，否则报错退出
    const lp = path.join(gameDir(), 'launcher_profiles.json')
    if (!fs.existsSync(lp)) {
      fs.writeFileSync(lp, JSON.stringify({ profiles: {}, settings: {}, version: 3 }, null, 2), 'utf-8')
    }
    emit({ stage: 'loader', progress: 0.7, text: '运行安装器（可能需要几分钟）…' })
    await runInstaller(javaPath, jarPath, emit, signal)

    const id0 = findInstalledDir(loader, mcVersion, loaderVersion)
    if (!id0) throw new Error('安装器运行结束，但未找到生成的版本目录')
    // 自定义实例名：重命名安装器生成的目录与 json id
    let id = id0
    if (instanceName?.trim() && instanceName.trim() !== id0) {
      const { renameVersion } = await import('./versions')
      renameVersion(id0, instanceName.trim())
      id = instanceName.trim()
    }
    tagLoaderJson(id, loader, loaderVersion)

    // 完整性自愈：安装器可能半失败（json 已写但部分库未下载，如 client 校验失败中止）
    // 逐文件校验版本 json 声明的库，缺失则经镜像补齐；补不齐则明确报错
    emit({ stage: 'loader', progress: 0.92, text: '校验依赖库完整性…' })
    const profileJson = readVersionJson(id)
    const libTasks = libraryTasks(profileJson)
    const missing = libTasks.filter((t) => !fs.existsSync(t.dest))
    if (missing.length) {
      emit({ stage: 'loader', progress: 0.94, text: `补全 ${missing.length} 个缺失依赖库…` })
      await downloadAll(
        missing,
        (d, t, speed) =>
          emit({
            stage: 'loader',
            progress: 0.94 + (t ? (d / t) * 0.05 : 0),
            text: `补全依赖库 ${d}/${t}`,
            speed
          }),
        8,
        getSettings().mirror,
        signal
      )
    }
    emit({ stage: 'done', progress: 1, text: `${id} 安装完成` })
    registerVersionFolder(id, gameDir()) // forge/neoforge 实例注册到当前活动文件夹
    return id
  } finally {
    fs.rmSync(jarPath, { force: true })
    // 本次安装临时落地的原版条目迁移进依赖区（无论成败），版本列表只保留加载器实例
    if (!vanillaPreExisted) {
      try {
        migrateDependencyVanilla(mcVersion)
      } catch {
        /* 迁移失败不阻断安装结果 */
      }
    }
  }
}

// ---------------- Fabric API（Modrinth 数据源，MCIM 国内镜像回退） ----------------

const MODRINTH_BASES = [
  'https://api.modrinth.com/v2',
  'https://mod.mcimirror.top/modrinth/v2'
]
const MODRINTH_UA = { 'User-Agent': 'KAMUCL/0.4.1 (kamucl launcher)' }

interface ModrinthFile {
  url?: string
  filename?: string
  primary?: boolean
  hashes?: { sha1?: string }
}
interface ModrinthVersion {
  version_number?: string
  date_published?: string
  files?: ModrinthFile[]
}

/** 按 mc 版本缓存查询结果，避免列表与下载两次请求 */
const fabricApiCache = new Map<string, ModrinthVersion[]>()

async function fetchFabricApiVersions(mcVersion: string): Promise<ModrinthVersion[]> {
  const cached = fabricApiCache.get(mcVersion)
  if (cached) return cached
  const gv = encodeURIComponent(JSON.stringify([mcVersion]))
  const ld = encodeURIComponent(JSON.stringify(['fabric']))
  let lastErr: unknown = null
  for (const base of MODRINTH_BASES) {
    try {
      const res = await fetch(`${base}/project/fabric-api/version?game_versions=${gv}&loaders=${ld}`, {
        headers: MODRINTH_UA,
        signal: AbortSignal.timeout(30000)
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const arr = (await res.json()) as ModrinthVersion[]
      if (!Array.isArray(arr)) throw new Error('响应格式异常')
      fabricApiCache.set(mcVersion, arr)
      return arr
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** Fabric API 可用版本列表（最新在前） */
export async function listFabricApiVersions(mcVersion: string): Promise<FabricApiVersion[]> {
  const arr = await fetchFabricApiVersions(mcVersion)
  return arr
    .filter((v) => !!v.version_number)
    .map((v) => ({ version: v.version_number as string, date: v.date_published ?? '' }))
}

/** 下载指定版本 Fabric API 到 gameDir/mods */
export async function installFabricApi(
  mcVersion: string,
  version: string,
  emit: ProgressEmit
): Promise<void> {
  emit({ stage: 'fabric-api', progress: 0, text: `查询 Fabric API ${version}` })
  const arr = await fetchFabricApiVersions(mcVersion)
  const v = arr.find((x) => x.version_number === version)
  const file = v?.files?.find((f) => f.primary) ?? v?.files?.[0]
  if (!file?.url || !file.filename) {
    throw new Error(`未找到适配 ${mcVersion} 的 Fabric API ${version} 文件`)
  }
  const dest = path.join(gameDir(), 'mods', file.filename)
  emit({ stage: 'fabric-api', progress: 0.2, text: `下载 Fabric API ${version}` })
  await downloadFile(file.url, dest, undefined, file.hashes?.sha1, 'official')
  emit({ stage: 'fabric-api', progress: 1, text: `Fabric API 已放入 mods 文件夹` })
}
