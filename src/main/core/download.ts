/**
 * 下载模块：流式写盘 + sha1 校验 + BMCLAPI 镜像回退 + 并发池
 * 仅使用 Node 内置模块（全局 fetch / node:fs / node:crypto）
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { once } from 'node:events'

export type MirrorPref = 'official' | 'bmclapi'
export type ProgressFn = (done: number, total: number) => void
/** downloadAll 的进度回调：完成数/总数/实时速度(字节每秒) */
export type AllProgressFn = (done: number, total: number, speedBps: number) => void

export interface DownloadTask {
  url: string
  dest: string
  sha1?: string
}

const BMCLAPI_HOST = 'bmclapi2.bangbang93.com'

/** 这些域名在 BMCLAPI 下为透明镜像，直接换 host、路径不变 */
const PLAIN_MIRROR_HOSTS = new Set([
  'piston-meta.mojang.com',
  'piston-data.mojang.com',
  'launchermeta.mojang.com',
  'launcher.mojang.com',
  'resources.download.minecraft.net',
  'files.minecraftforge.net'
])

/**
 * 按镜像偏好改写 URL。
 * maven 系仓库（libraries.minecraft.net / fabric / quilt / forge / neoforge）
 * 在 BMCLAPI 下对应 /maven 前缀，等价于 host 替换 + 路径前补 /maven。
 */
const MAVEN_MIRROR_HOSTS = new Set([
  'libraries.minecraft.net',
  'maven.fabricmc.net',
  'maven.quiltmc.org',
  'maven.minecraftforge.net',
  'maven.neoforged.net'
])
export function mirrorUrl(url: string, mirror: MirrorPref): string {
  if (mirror !== 'bmclapi') return url
  try {
    const u = new URL(url)
    if (MAVEN_MIRROR_HOSTS.has(u.host)) {
      return `https://${BMCLAPI_HOST}/maven${u.pathname}${u.search}`
    }
    if (PLAIN_MIRROR_HOSTS.has(u.host)) {
      return `https://${BMCLAPI_HOST}${u.pathname}${u.search}`
    }
    return url
  } catch {
    return url
  }
}

/** 计算文件 sha1（hex 小写） */
function sha1Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1')
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/** 单次下载：fetch body reader 流式写入 .part 临时文件，完成后改名 */
async function doDownload(url: string, dest: string, onProgress?: ProgressFn): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const res = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${url}`)

  const total = Number(res.headers.get('content-length') ?? 0)
  const tmp = dest + '.part'
  const ws = fs.createWriteStream(tmp)
  const reader = res.body.getReader()
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength > 0) {
        received += value.byteLength
        if (!ws.write(value)) await once(ws, 'drain')
        onProgress?.(received, total)
      }
    }
    ws.end()
    await once(ws, 'finish')
    fs.renameSync(tmp, dest)
  } catch (e) {
    ws.destroy()
    fs.rmSync(tmp, { force: true })
    throw e
  }
}

/**
 * 下载单个文件。
 * - 已存在且 sha1 校验通过（或未提供 sha1）则跳过
 * - 失败时自动在 官方/镜像 之间切换重试，最多 3 次
 */
export async function downloadFile(
  url: string,
  dest: string,
  onProgress?: ProgressFn,
  sha1?: string,
  mirror: MirrorPref = 'official'
): Promise<void> {
  if (fs.existsSync(dest)) {
    if (!sha1) return
    const h = await sha1Of(dest)
    if (h === sha1.toLowerCase()) return
    fs.rmSync(dest, { force: true })
  }

  // 候选 URL：按镜像偏好排序，去重
  const alt = mirrorUrl(url, 'bmclapi')
  const candidates = [...new Set(mirror === 'bmclapi' ? [alt, url] : [url, alt])]

  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const u = candidates[attempt % candidates.length]
    try {
      await doDownload(u, dest, onProgress)
      if (sha1) {
        const h = await sha1Of(dest)
        if (h !== sha1.toLowerCase()) {
          fs.rmSync(dest, { force: true })
          throw new Error(`sha1 校验失败: ${path.basename(dest)}`)
        }
      }
      return
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/**
 * 并发下载池。
 * onProgress(doneCount, totalCount, speedBps)：每完成一个文件回调一次，
 * 且每 500ms 额外回调一次带实时速度（滑窗统计字节增量）。
 * 任一文件最终失败则整体 reject。
 */
export async function downloadAll(
  tasks: DownloadTask[],
  onProgress?: AllProgressFn,
  concurrency = 8,
  mirror: MirrorPref = 'official'
): Promise<void> {
  const total = tasks.length
  if (total === 0) {
    onProgress?.(0, 0, 0)
    return
  }
  let idx = 0
  let done = 0
  // 速度统计：累计各文件已下载字节增量
  let bytesTotal = 0
  let lastSampleT = Date.now()
  let lastSampleBytes = 0
  let speed = 0
  const timer = setInterval(() => {
    const now = Date.now()
    const dt = (now - lastSampleT) / 1000
    if (dt > 0) {
      speed = Math.max(0, Math.round((bytesTotal - lastSampleBytes) / dt))
      lastSampleT = now
      lastSampleBytes = bytesTotal
      onProgress?.(done, total, speed)
    }
  }, 500)
  const worker = async (): Promise<void> => {
    while (idx < tasks.length) {
      const t = tasks[idx++]
      let lastReceived = 0
      await downloadFile(
        t.url,
        t.dest,
        (received) => {
          bytesTotal += received - lastReceived
          lastReceived = received
        },
        t.sha1,
        mirror
      )
      done++
      onProgress?.(done, total, speed)
    }
  }
  try {
    const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker())
    await Promise.all(workers)
  } finally {
    clearInterval(timer)
  }
}
