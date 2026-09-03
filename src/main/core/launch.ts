/**
 * 游戏启动：版本链合并、classpath/natives 处理、JVM/游戏参数组装、进程管理
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { app } from 'electron'
import AdmZip from 'adm-zip'
import type { LaunchState, ProgressEvent } from '../../shared/types'
import { getSettings } from './settings'
import { getValidAccount, selectedAccount } from './accounts'
import { ensureJava, requiredMajor, scanJava } from './java'
import {
  assetIndexPath,
  assetsDir,
  baseVersionJarPath,
  gameDir,
  librariesDir,
  nativesDir,
  versionDir,
  versionJarPath,
  versionJsonPath,
  virtualLegacyDir
} from './paths'
import {
  clientJarPath,
  installVanilla,
  libraryTasks,
  readVersionJson,
  resolvedLibraries,
  rulesAllow,
  type ArgumentEntry,
  type VersionJson
} from './versions'
import { downloadAll } from './download'

export type ProgressEmit = (e: ProgressEvent) => void
export type SendLog = (line: string) => void
export type OnState = (s: LaunchState) => void

let current: ChildProcess | null = null

/** 终止当前游戏进程 */
export function killGame(): void {
  try {
    current?.kill()
  } catch {
    /* 进程可能已退出 */
  }
  current = null
}

/**
 * 沿 inheritsFrom 读取版本链并合并：
 * - libraries 合并（子在前）
 * - arguments 合并（父在前，子的 game/jvm 追加在后，兼容 forge/fabric）
 * - mainClass/type/assets/assetIndex/javaVersion/minecraftArguments 子缺省继承父
 * 返回合并结果与链条最底层原版 id（client jar 用它的）。
 */
function resolveChain(id: string): { merged: VersionJson; baseId: string } {
  const chain: VersionJson[] = []
  let cur: VersionJson | null = readVersionJson(id)
  while (cur) {
    chain.push(cur)
    cur = cur.inheritsFrom ? readVersionJson(cur.inheritsFrom) : null
  }
  const baseId = chain[chain.length - 1].id

  const childFirst = <K extends keyof VersionJson>(key: K): VersionJson[K] | undefined => {
    for (const c of chain) {
      if (c[key] != null) return c[key]
    }
    return undefined
  }
  const parentFirst = [...chain].reverse()

  const merged: VersionJson = {
    id,
    mainClass: childFirst('mainClass'),
    type: childFirst('type'),
    assets: childFirst('assets'),
    assetIndex: childFirst('assetIndex'),
    javaVersion: childFirst('javaVersion'),
    minecraftArguments: childFirst('minecraftArguments'),
    libraries: chain.flatMap((c) => c.libraries ?? []),
    arguments: {
      game: parentFirst.flatMap((c) => c.arguments?.game ?? []),
      jvm: parentFirst.flatMap((c) => c.arguments?.jvm ?? [])
    }
  }
  return { merged, baseId }
}

/** 按空格拆分用户 JVM 参数，支持简单双引号 */
function splitArgs(s: string): string[] {
  if (!s.trim()) return []
  return (s.match(/"[^"]*"|[^\s"]+/g) ?? []).map((x) => x.replace(/^"|"$/g, ''))
}

/** 把子进程输出按行切分转发 */
function makeLinePusher(sendLog: SendLog): (chunk: Buffer) => void {
  let buf = ''
  return (chunk: Buffer) => {
    buf += chunk.toString('utf-8')
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '')
      buf = buf.slice(idx + 1)
      if (line) sendLog(line)
    }
  }
}

/**
 * 启动游戏。
 * emit 进度 / sendLog 日志行 / onState 状态回调（running/exited/error）。
 */
export async function launch(
  versionId: string,
  emit: ProgressEmit,
  sendLog: SendLog,
  onState: OnState,
  serverAddress?: string
): Promise<void> {
  const settings = getSettings()

  // 日志落盘：gameDir/kamucl-logs/latest.log（每次启动覆盖）
  let logStream: fs.WriteStream | null = null
  try {
    const logDir = path.join(gameDir(), 'kamucl-logs')
    fs.mkdirSync(logDir, { recursive: true })
    logStream = fs.createWriteStream(path.join(logDir, 'latest.log'), { flags: 'w' })
  } catch {
    logStream = null
  }
  const log: SendLog = (line) => {
    sendLog(line)
    try {
      logStream?.write(line + '\n')
    } catch {
      /* 忽略写入失败 */
    }
  }

  // a0) 自愈：版本链 json 缺失或链底客户端 jar 缺失时，自动补全下载原版文件
  let baseIdProbe = versionId
  let chainBroken = false
  try {
    let cur: VersionJson = readVersionJson(versionId)
    while (cur.inheritsFrom) {
      baseIdProbe = cur.inheritsFrom
      cur = readVersionJson(baseIdProbe)
    }
  } catch (e) {
    if (baseIdProbe === versionId) {
      // 连入口版本的 json 都丢了，无法推断链条，只能重装
      throw new Error(`版本 ${versionId} 文件丢失，请在游戏版本页重新安装`)
    }
    chainBroken = true
  }
  // 链底原版 json/jar 可能在 versions 区（独立原版）或 .kamucl/base 依赖区（加载器实例的内部依赖）
  const baseInVersions = fs.existsSync(versionJsonPath(baseIdProbe))
  const jarProbe = baseInVersions ? versionJarPath(baseIdProbe) : baseVersionJarPath(baseIdProbe)
  if (chainBroken || !fs.existsSync(jarProbe)) {
    emit({
      stage: 'repair',
      progress: 0,
      text: `检测到游戏文件缺失，正在自动补全 ${baseIdProbe}…`
    })
    // installVanilla 内部：json 不在则下载，已存在文件校验跳过，只补缺失部分
    // 自定义命名的原版实例：真实 MC 版本 id 从 _mcVersion 取
    let realId = baseIdProbe
    try {
      realId = readVersionJson(baseIdProbe)._mcVersion ?? baseIdProbe
    } catch {
      /* json 缺失时用 probe（即真实 MC id） */
    }
    // 加载器实例的依赖原版补进 base 区；独立原版实例仍在 versions 区修复
    const dest = baseIdProbe !== versionId && !baseInVersions ? 'base' : 'versions'
    await installVanilla(realId, emit, dest, realId !== baseIdProbe ? baseIdProbe : undefined)
    emit({ stage: 'repair', progress: 1, text: '文件补全完成' })
  }

  // a0.1) 实例隔离：入口版本 json 带 _gameDir 时（整合包实例），
  // 本次启动的游戏目录 = 版本目录（mods/存档/配置互不影响）；assets 仍用全局共享目录
  const effectiveGameDir =
    readVersionJson(versionId)._gameDir === true ? versionDir(versionId) : gameDir()
  fs.mkdirSync(effectiveGameDir, { recursive: true })

  // 默认中文：仅在 options.txt 不存在时写入（绝不覆盖玩家已有设置）
  try {
    const optFile = path.join(effectiveGameDir, 'options.txt')
    if (!fs.existsSync(optFile)) {
      fs.writeFileSync(optFile, 'lang:zh_cn\n', 'utf-8')
    }
  } catch {
    /* 写入失败不影响启动 */
  }

  // a) 版本链合并
  emit({ stage: 'launch', progress: 0, text: '解析版本信息' })
  const { merged, baseId } = resolveChain(versionId)
  const clientJar = clientJarPath(baseId)
  if (!fs.existsSync(clientJar)) {
    throw new Error(`客户端文件缺失（${baseId}.jar），请先完整安装版本 ${baseId}`)
  }
  if (!merged.mainClass) throw new Error('版本 json 缺少 mainClass，文件可能损坏')

  // a1) 依赖库完整性：缺失则自动补下（含 fabric/quilt 的 maven 坐标库）
  const libTasks = libraryTasks(merged)
  const missingLibs = libTasks.filter((t) => !fs.existsSync(t.dest))
  if (missingLibs.length) {
    emit({
      stage: 'repair',
      progress: 0,
      text: `检测到 ${missingLibs.length} 个依赖库缺失，正在补全…`
    })
    await downloadAll(
      missingLibs,
      (d, t, speed) =>
        emit({ stage: 'repair', progress: t ? d / t : 1, text: `补全依赖库 ${d}/${t}`, speed }),
      8,
      settings.mirror
    )
  }

  // b) 账号
  const account = selectedAccount()
  if (!account) throw new Error('尚未选择账号，请先在账号页添加并选择一个账号')
  const validAccount = await getValidAccount(account)

  // c) Java：版本独立指定 > 手动指定 > 自动管理
  emit({ stage: 'java', progress: 0, text: '检查 Java 环境' })
  let javaPath: string
  const versionJava = readVersionJson(versionId)._javaPath
  if (versionJava) {
    if (!fs.existsSync(versionJava)) {
      throw new Error(`该版本指定的 Java 不存在（${versionJava}），请在版本设置中重新选择`)
    }
    javaPath = versionJava
    emit({ stage: 'java', progress: 1, text: '使用该版本指定的 Java' })
  } else if (settings.javaAuto) {
    javaPath = await ensureJava(merged, emit)
  } else if (settings.javaPath) {
    if (!fs.existsSync(settings.javaPath)) {
      throw new Error('手动指定的 Java 路径不存在，请在设置中重新选择')
    }
    javaPath = settings.javaPath
    emit({ stage: 'java', progress: 1, text: '使用手动指定的 Java' })
  } else {
    const need = requiredMajor(merged)
    const found = scanJava().find((j) => j.major === need && j.is64Bit)
    if (!found) {
      throw new Error(
        `该版本需要 Java ${need} (64位)，但未找到（Java 自动管理已关闭）。请在设置中选择 Java 或开启自动管理`
      )
    }
    javaPath = found.path
    emit({ stage: 'java', progress: 1, text: `使用本机 Java ${found.version}` })
  }

  // d) classpath 与 natives 解压
  emit({ stage: 'launch', progress: 0.5, text: '准备运行库与 natives' })
  const { artifacts, natives } = resolvedLibraries(merged)
  const nativesPath = nativesDir(versionId)
  fs.mkdirSync(nativesPath, { recursive: true })
  for (const jar of natives) {
    if (!fs.existsSync(jar)) continue
    try {
      const zip = new AdmZip(jar)
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory || entry.entryName.startsWith('META-INF/')) continue
        zip.extractEntryTo(entry, nativesPath, true, true)
      }
    } catch {
      // 单个 natives 解压失败不阻断启动
    }
  }
  const classpath = [...new Set([...artifacts, ...natives, clientJar])].join(path.delimiter)

  // assets（legacy 版本使用虚拟资源目录）
  const indexId = merged.assetIndex?.id ?? merged.assets ?? 'legacy'
  let assetsRoot = assetsDir()
  try {
    const idx = JSON.parse(fs.readFileSync(assetIndexPath(indexId), 'utf-8')) as {
      virtual?: boolean
      map_to_resources?: boolean
    }
    if (idx.virtual === true || idx.map_to_resources === true) assetsRoot = virtualLegacyDir()
  } catch {
    /* 索引缺失时使用默认 assets 根目录 */
  }

  // f) 变量替换表
  const vars: Record<string, string> = {
    auth_player_name: validAccount.username,
    version_name: versionId,
    game_directory: effectiveGameDir,
    assets_root: assetsRoot,
    assets_index_name: merged.assets ?? indexId,
    auth_uuid: validAccount.uuid,
    auth_access_token: validAccount.accessToken ?? '',
    clientid: '',
    auth_xuid: '',
    user_type: validAccount.type === 'microsoft' ? 'msa' : 'mojang',
    version_type: 'KAMUCL',
    natives_directory: nativesPath,
    launcher_name: 'KAMUCL',
    launcher_version: app.getVersion(),
    classpath,
    library_directory: librariesDir(),
    classpath_separator: path.delimiter
  }
  const sub = (s: string): string => s.replace(/\$\{([^}]+)\}/g, (m, k) => vars[k] ?? m)

  /** 展开新版 arguments 数组（字符串或带 rules 的对象） */
  const expandEntries = (entries?: (string | ArgumentEntry)[]): string[] => {
    const out: string[] = []
    for (const e of entries ?? []) {
      if (typeof e === 'string') {
        out.push(sub(e))
      } else if (e && rulesAllow(e.rules)) {
        const values = Array.isArray(e.value) ? e.value : [e.value]
        for (const v of values) out.push(sub(v))
      }
    }
    return out
  }

  // 游戏参数：新版 arguments.game / 旧版 minecraftArguments
  let gameArgs: string[]
  if ((merged.arguments?.game?.length ?? 0) > 0) {
    gameArgs = expandEntries(merged.arguments?.game)
  } else if (merged.minecraftArguments) {
    gameArgs = merged.minecraftArguments.split(/\s+/).filter(Boolean).map(sub)
  } else {
    throw new Error('版本 json 缺少游戏参数，文件可能损坏')
  }

  // e) JVM 参数
  const mem = Math.max(512, settings.memoryMB || 4096)
  const jvmArgs: string[] = [
    `-Xmx${mem}M`,
    `-Xms${Math.min(mem, 1024)}M`,
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
    '-Dfile.encoding=UTF-8',
    // macOS 上 LWJGL 必须在主线程启动 AWT
    ...(process.platform === 'darwin' ? ['-XstartOnFirstThread'] : []),
    `-Djava.library.path=${nativesPath}`,
    `-Djna.tmpdir=${nativesPath}`,
    // 版本 json 自带的 JVM 参数（forge 的 -p ${classpath} 等依赖它）
    ...expandEntries(merged.arguments?.jvm),
    ...splitArgs(settings.jvmArgs)
  ]

  // e2) 分辨率
  if (settings.resolution.fullscreen) {
    gameArgs.push('--fullscreen')
  } else {
    if (settings.resolution.width > 0) gameArgs.push('--width', String(settings.resolution.width))
    if (settings.resolution.height > 0) gameArgs.push('--height', String(settings.resolution.height))
  }

  // e3) 一键进服（1.20.2+ 支持 --quickPlayMultiplayer）
  if (serverAddress) {
    gameArgs.push('--quickPlayMultiplayer', serverAddress)
  }

  // g) 启动进程
  const args = [...jvmArgs, '-cp', classpath, merged.mainClass, ...gameArgs]
  // 日志中隐藏 accessToken
  const logArgs = args.map((a) => (a === validAccount.accessToken ? '***' : a))
  log(`[KAMUCL] 启动命令: ${javaPath} ${logArgs.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`)

  emit({ stage: 'launch', progress: 1, text: '启动游戏进程' })
  const proc = spawn(javaPath, args, { cwd: effectiveGameDir })
  current = proc
  onState({ status: 'running', text: '游戏进程已启动' })

  const pushLine = makeLinePusher(log)
  proc.stdout?.on('data', pushLine)
  proc.stderr?.on('data', pushLine)
  proc.on('error', (err) => {
    current = null
    logStream?.end()
    onState({ status: 'error', text: `进程启动失败: ${err.message}` })
  })
  proc.on('exit', (code) => {
    current = null
    logStream?.end()
    onState({ status: 'exited', code: code ?? 0, text: `游戏已退出 (code=${code ?? 0})` })
  })
}
