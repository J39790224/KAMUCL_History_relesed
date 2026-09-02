/**
 * Java 管理：本机扫描、版本需求推断、Adoptium 自动下载
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync, spawnSync } from 'node:child_process'
import AdmZip from 'adm-zip'
import type { JavaInfo, ProgressEvent } from '../../shared/types'
import { getSettings } from './settings'
import { runtimesDir } from './paths'
import { downloadFile } from './download'
import type { VersionJson } from './versions'

export type ProgressEmit = (e: ProgressEvent) => void

const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'
/** java 可执行文件名（Windows 为 java.exe，其他为 java） */
const JAVA_EXE = IS_WIN ? 'java.exe' : 'java'

/** 运行 java -version 并解析版本/位数；失败返回 null */
function probeJava(exe: string): JavaInfo | null {
  try {
    const r = spawnSync(exe, ['-version'], {
      encoding: 'utf-8',
      timeout: 10000,
      windowsHide: true
    })
    if (r.error) return null
    const out = `${r.stderr ?? ''}\n${r.stdout ?? ''}`
    const m = /version "([^"]+)"/.exec(out)
    if (!m) return null
    const version = m[1]
    const parts = version.split('.')
    // "1.8.0_xxx" -> 8；"17.0.x" -> 17
    const major = parts[0] === '1' ? parseInt(parts[1] ?? '0', 10) : parseInt(parts[0], 10)
    if (!Number.isFinite(major) || major <= 0) return null
    // 非 Windows 平台的现代 JDK 均为 64 位，输出不一定含 "64-Bit" 字样
    const is64Bit = IS_WIN ? /64-Bit/i.test(out) : true
    return { path: exe, major, version, is64Bit }
  } catch {
    return null
  }
}

/** 收集所有候选 java 路径 */
function candidatePaths(): string[] {
  const list: string[] = []
  const push = (p?: string): void => {
    if (!p) return
    // Windows 下可执行文件以 .exe 结尾；其他平台无后缀要求
    if (IS_WIN && !p.toLowerCase().endsWith('.exe')) return
    list.push(p)
  }

  // 1. 用户指定
  push(getSettings().javaPath)

  // 2. JAVA_HOME
  if (process.env.JAVA_HOME) push(path.join(process.env.JAVA_HOME, 'bin', JAVA_EXE))

  // 3. PATH 中的 java
  try {
    const cmd = IS_WIN ? 'where java' : 'which java'
    const out = execSync(cmd, { encoding: 'utf-8', timeout: 10000, windowsHide: true })
    for (const line of out.split(/\r?\n/)) push(line.trim())
  } catch {
    /* 找不到时返回非零，忽略 */
  }

  // 4. 常见安装目录（手动枚举，不引 glob 库）
  if (IS_WIN) {
    const bases = [
      'C:\\Program Files\\Java',
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Microsoft',
      'C:\\Program Files\\Zulu',
      'C:\\Program Files\\Amazon Corretto'
    ]
    for (const base of bases) {
      try {
        for (const sub of fs.readdirSync(base)) push(path.join(base, sub, 'bin', JAVA_EXE))
      } catch {
        /* 目录不存在 */
      }
    }
  } else if (IS_MAC) {
    // macOS：系统 JDK 目录（*/Contents/Home/bin/java）与用户级目录
    const bases = [
      '/Library/Java/JavaVirtualMachines',
      path.join(os.homedir(), 'Library/Java/JavaVirtualMachines'),
      '/Library/Internet Plug-Ins/JavaAppletPlugin.plugin/Contents/Home'
    ]
    for (const base of bases) {
      try {
        if (base.endsWith('Home')) {
          push(path.join(base, 'bin', JAVA_EXE))
          continue
        }
        for (const sub of fs.readdirSync(base)) {
          push(path.join(base, sub, 'Contents', 'Home', 'bin', JAVA_EXE))
        }
      } catch {
        /* 目录不存在 */
      }
    }
    push('/usr/bin/java')
  } else {
    // Linux
    push('/usr/bin/java')
    try {
      for (const sub of fs.readdirSync('/usr/lib/jvm')) {
        push(path.join('/usr/lib/jvm', sub, 'bin', JAVA_EXE))
      }
    } catch {
      /* 目录不存在 */
    }
  }

  // 5. 启动器自管理的 runtimes 目录
  try {
    for (const sub of fs.readdirSync(runtimesDir())) {
      const home = path.join(runtimesDir(), sub)
      // Windows 结构 bin/java.exe；macOS 结构 Contents/Home/bin/java
      push(path.join(home, 'bin', JAVA_EXE))
      if (IS_MAC) push(path.join(home, 'Contents', 'Home', 'bin', JAVA_EXE))
    }
  } catch {
    /* 目录不存在 */
  }

  return list
}

/** 扫描本机所有可用 Java，返回去重后的 JavaInfo[] */
export function scanJava(): JavaInfo[] {
  const seen = new Set<string>()
  const out: JavaInfo[] = []
  for (const p of candidatePaths()) {
    let real: string
    try {
      if (!fs.existsSync(p)) continue
      real = fs.realpathSync(p).toLowerCase()
    } catch {
      continue
    }
    if (seen.has(real)) continue
    seen.add(real)
    const info = probeJava(p)
    if (info) out.push(info)
  }
  return out
}

/** 推断运行该版本所需的 Java 主版本号 */
export function requiredMajor(versionJson: VersionJson): number {
  const declared = versionJson.javaVersion?.majorVersion
  if (declared && declared > 0) return declared
  // 按 MC 版本号推断（id 形如 1.20.5 / 1.18 / 1.8.9）
  const verId = versionJson.inheritsFrom ?? versionJson.id
  const m = /^1\.(\d+)(?:\.(\d+))?/.exec(verId)
  if (!m) return 8
  const minor = parseInt(m[1], 10)
  const patch = parseInt(m[2] ?? '0', 10)
  if (minor > 20 || (minor === 20 && patch >= 5)) return 21
  if (minor >= 18) return 17
  if (minor === 17) return 16
  return 8
}

interface AdoptiumAsset {
  binary?: { package?: { link?: string } }
}

/**
 * 确保有可用 Java：优先本机扫描（major 匹配且 64 位），
 * 没有则从 Adoptium 下载 JRE 到 gameDir/runtimes/jre-<major>/。
 * Windows 为 zip（adm-zip 解压）；macOS/Linux 为 tar.gz（系统 tar 解压）。
 * 返回 java 可执行文件绝对路径。
 */
export async function ensureJava(versionJson: VersionJson, emit: ProgressEmit): Promise<string> {
  const need = requiredMajor(versionJson)

  const local = scanJava().find((j) => j.major === need && j.is64Bit)
  if (local) return local.path

  emit({ stage: 'java', progress: 0, text: `本机没有 Java ${need} (64位)，开始自动下载…` })

  // 查询 Adoptium 最新 JRE（平台与架构按当前系统）
  const osName = IS_WIN ? 'windows' : IS_MAC ? 'mac' : 'linux'
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64'
  const api =
    `https://api.adoptium.net/v3/assets/latest/${need}/hotspot` +
    `?architecture=${arch}&image_type=jre&os=${osName}&vendor=eclipse`
  const res = await fetch(api, { signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`查询 Adoptium 失败: HTTP ${res.status}`)
  const assets = (await res.json()) as AdoptiumAsset[]
  const link = assets?.[0]?.binary?.package?.link
  if (!link) throw new Error(`Adoptium 没有提供 Java ${need} 的下载`)

  // 下载到临时文件（Windows=zip，其他=tar.gz）
  const ext = IS_WIN ? 'zip' : 'tar.gz'
  const tmpPkg = path.join(os.tmpdir(), `kamucl-jre-${need}-${Date.now()}.${ext}`)
  await downloadFile(link, tmpPkg, (d, t) =>
    emit({
      stage: 'java',
      progress: t ? (d / t) * 0.9 : 0,
      text: `下载 Java ${need} ${(d / 1024 / 1024).toFixed(1)}MB${t ? '/' + (t / 1024 / 1024).toFixed(1) + 'MB' : ''}`
    })
  )

  // 解压（包内有一层顶层目录，解压后平移为 jre-<major>/）
  emit({ stage: 'java', progress: 0.9, text: `解压 Java ${need}…` })
  const extractTmp = path.join(runtimesDir(), `.extract-${need}-${Date.now()}`)
  const target = path.join(runtimesDir(), `jre-${need}`)
  fs.rmSync(extractTmp, { recursive: true, force: true })
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(extractTmp, { recursive: true })
  try {
    if (IS_WIN) {
      new AdmZip(tmpPkg).extractAllTo(extractTmp, true)
    } else {
      const r = spawnSync('tar', ['-xzf', tmpPkg, '-C', extractTmp], { timeout: 120000 })
      if (r.status !== 0) throw new Error(`tar 解压失败: ${r.stderr?.toString() ?? r.status}`)
    }
    const entries = fs.readdirSync(extractTmp)
    const src =
      entries.length === 1 && fs.statSync(path.join(extractTmp, entries[0])).isDirectory()
        ? path.join(extractTmp, entries[0])
        : extractTmp
    try {
      fs.renameSync(src, target)
    } catch {
      // 跨盘等情况 rename 失败则复制
      fs.cpSync(src, target, { recursive: true })
      fs.rmSync(src, { recursive: true, force: true })
    }
  } finally {
    fs.rmSync(extractTmp, { recursive: true, force: true })
    fs.rmSync(tmpPkg, { force: true })
  }

  // Windows: bin/java.exe；macOS: Contents/Home/bin/java；Linux: bin/java
  const candidates = IS_MAC
    ? [path.join(target, 'Contents', 'Home', 'bin', JAVA_EXE), path.join(target, 'bin', JAVA_EXE)]
    : [path.join(target, 'bin', JAVA_EXE)]
  const exe = candidates.find((p) => fs.existsSync(p))
  if (!exe) {
    fs.rmSync(target, { recursive: true, force: true })
    throw new Error('Java 解压失败：未找到 bin/java')
  }
  // macOS/Linux 确保可执行权限
  if (!IS_WIN) {
    try {
      fs.chmodSync(exe, 0o755)
    } catch {
      /* 忽略 */
    }
  }
  emit({ stage: 'java', progress: 1, text: `Java ${need} 就绪` })
  return exe
}
