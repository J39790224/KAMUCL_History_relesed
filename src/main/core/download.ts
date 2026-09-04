/**
 * 下载模块：流式写盘 + sha1 校验 + BMCLAPI 镜像回退 + 并发池
 * 仅使用 Node 内置模块（全局 fetch / node:fs / node:crypto）
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { once } from 'node:events'
import { abortableDelay } from './tasks'

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
export const BMCL_MAVEN_ROOT = `https://${BMCLAPI_HOST}/maven/`

/** 这些域名在 BMCLAPI 下为透明镜像，直接换 host、路径不变 */
const PLAIN_MIRROR_HOSTS = new Set([
  'piston-meta.mojang.com',
  'piston-data.mojang.com',
  'launchermeta.mojang.com',
  'launcher.mojang.com'
])

/**
 * 按镜像偏好改写 URL。
 * maven 系仓库（libraries.minecraft.net / fabric / quilt / forge / neoforge）
 * 在 BMCLAPI 下对应 /maven 前缀，等价于 host 替换 + 路径前补 /maven。
 */
export function mirrorUrl(url: string, mirror: MirrorPref): string {
  if (mirror !== 'bmclapi') return url
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return url
    const host = u.hostname.toLowerCase()
    if (PLAIN_MIRROR_HOSTS.has(host)) {
      return `https://${BMCLAPI_HOST}${u.pathname}${u.search}`
    }
    // BMCLAPI 的 Assets 根比 Mojang 多一层 /assets。
    if (host === 'resources.download.minecraft.net') {
      return `https://${BMCLAPI_HOST}/assets${u.pathname}${u.search}`
    }
    if (host === 'libraries.minecraft.net' || host === 'maven.fabricmc.net' || host === 'maven.minecraftforge.net') {
      return `${BMCL_MAVEN_ROOT}${u.pathname.replace(/^\/+/, '')}${u.search}`
    }
    // 官方文档将 /releases 映射到 BMCL /maven 根，不能得到 /maven/releases/...。
    if (host === 'maven.neoforged.net' && u.pathname.startsWith('/releases/')) {
      return `${BMCL_MAVEN_ROOT}${u.pathname.slice('/releases/'.length)}${u.search}`
    }
    // files.minecraftforge.net 只有 /maven 子树有明确镜像规则。
    if (host === 'files.minecraftforge.net' && u.pathname.startsWith('/maven/')) {
      return `${BMCL_MAVEN_ROOT}${u.pathname.slice('/maven/'.length)}${u.search}`
    }
    // BMCL 文档目前把 Quilt 镜像标记为不可用，保留元数据原地址。
    return url
  } catch {
    return url
  }
}

export type HttpFailureKind = 'unavailable' | 'transient' | 'fatal'

/** 404/410 表示该地址永久不可用；仅临时状态允许对同一 URL 退避重试。 */
export function classifyHttpStatus(status: number): HttpFailureKind {
  if (status === 404 || status === 410) return 'unavailable'
  if (status === 408 || status === 425 || status === 429) return 'transient'
  if (status >= 500 && status <= 599 && status !== 501 && status !== 505) return 'transient'
  return 'fatal'
}

export class DownloadHttpError extends Error {
  readonly status: number
  readonly url: string

  constructor(status: number, url: string) {
    super(`HTTP ${status}: ${url}`)
    this.name = 'DownloadHttpError'
    this.status = status
    this.url = url
  }
}

/** 元数据给出的真实地址始终优先；仅配置镜像且规则明确支持时追加 BMCL 备用地址。 */
export function downloadCandidates(urls: string[], mirror: MirrorPref): string[] {
  const out: string[] = []
  for (const url of urls) {
    if (url && !out.includes(url)) out.push(url)
    if (mirror === 'bmclapi') {
      const mirrored = mirrorUrl(url, mirror)
      if (mirrored && mirrored !== url && !out.includes(mirrored)) out.push(mirrored)
    }
  }
  return out
}

/** 合并 30s 超时与外部取消信号（版本清单等裸 fetch 调用点使用；取消立即中断） */
export function fetchSignal(extSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(30000)
  if (!extSignal) return timeout
  if (extSignal.aborted) return extSignal
  // Electron 33 / Node 20 支持 AbortSignal.any；组合信号会自行解除来源监听，
  // 避免每次 fetch 都把永久监听器挂在任务 signal 上。
  return AbortSignal.any([timeout, extSignal])
}

/** 计算文件 sha1（hex 小写） */
function sha1Of(file: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1')
    const stream = fs.createReadStream(file)
    const onAbort = (): void => stream.destroy(new DOMException('已取消', 'AbortError'))
    stream
      .on('error', reject)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('close', () => signal?.removeEventListener('abort', onAbort))
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 单次下载：fetch body reader 流式写入 .part 临时文件，完成后改名；extSignal 用于任务取消 */
async function doDownload(
  url: string,
  dest: string,
  onProgress?: ProgressFn,
  extSignal?: AbortSignal
): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  if (extSignal?.aborted) throw new Error('已取消')
  const signal = fetchSignal(extSignal)
  const res = await fetch(url, { signal, redirect: 'follow' })
  if (!res.ok || !res.body) throw new DownloadHttpError(res.status, url)

  const total = Number(res.headers.get('content-length') ?? 0)
  const tmp = dest + '.part'
  const ws = fs.createWriteStream(tmp)
  // destroy(error) 必须有常驻 error 监听；finish/drain 的 once 仍会收到并 reject。
  ws.on('error', () => undefined)
  const reader = res.body.getReader()
  const onAbort = (): void => {
    void reader.cancel(extSignal?.reason).catch(() => undefined)
    ws.destroy(new DOMException('已取消', 'AbortError'))
  }
  extSignal?.addEventListener('abort', onAbort, { once: true })
  let received = 0
  try {
    for (;;) {
      if (extSignal?.aborted) throw new Error('已取消')
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
    if (extSignal?.aborted) throw new Error('已取消')
    fs.renameSync(tmp, dest)
  } catch (e) {
    void reader.cancel().catch(() => undefined)
    ws.destroy()
    // Windows 上写流关闭前直接 rm 可能留下被占用的 .part；确认 close 后再删。
    if (!ws.closed) await once(ws, 'close').catch(() => undefined)
    fs.rmSync(tmp, { force: true })
    if (extSignal?.aborted) throw new Error('已取消')
    throw e
  } finally {
    extSignal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 下载单个文件。
 * - 已存在且 sha1 校验通过（或未提供 sha1）则跳过
 * - 失败时自动在 官方/镜像 之间切换重试，最多 3 次
 * - extSignal 取消时立即抛出「已取消」，不重试
 */
export async function downloadFile(
  url: string,
  dest: string,
  onProgress?: ProgressFn,
  sha1?: string,
  mirror: MirrorPref = 'official',
  extSignal?: AbortSignal,
  alternateUrls: string[] = []
): Promise<void> {
  if (fs.existsSync(dest)) {
    if (!sha1) return
    const h = await sha1Of(dest, extSignal)
    if (h === sha1.toLowerCase()) return
    fs.rmSync(dest, { force: true })
  }

  const candidates = downloadCandidates([url, ...alternateUrls], mirror)

  // 单文件进度单调：官方/镜像重试时 received 不重置（防进度条回跳）
  let maxReceived = 0
  const monoOnProgress: ProgressFn | undefined = onProgress
    ? (received, total) => {
        maxReceived = Math.max(maxReceived, received)
        onProgress(maxReceived, total)
      }
    : undefined

  const failures: string[] = []
  let lastErr: unknown = null
  let downloaded = false
  for (const candidate of candidates) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (extSignal?.aborted) throw new Error('已取消')
      try {
        await doDownload(candidate, dest, monoOnProgress, extSignal)
        downloaded = true
        if (sha1) {
          const h = await sha1Of(dest, extSignal)
          if (h !== sha1.toLowerCase()) {
            fs.rmSync(dest, { force: true })
            failures.push(`${candidate} -> sha1 校验失败`)
            lastErr = new Error(`sha1 校验失败: ${path.basename(dest)}`)
            // 完整响应但内容错误：切换来源，不对同一地址无脑重试。
            break
          }
        }
        return
      } catch (e) {
        if (extSignal?.aborted) {
          if (downloaded) fs.rmSync(dest, { force: true })
          fs.rmSync(dest + '.part', { force: true })
          throw new Error('已取消')
        }
        lastErr = e
        const kind =
          e instanceof DownloadHttpError
            ? classifyHttpStatus(e.status)
            : e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')
              ? 'transient'
              : 'transient'
        failures.push(
          `${candidate} -> ${e instanceof Error ? e.message : String(e)}${attempt ? `（重试 ${attempt}）` : ''}`
        )
        // 404/410 以及其他确定性 4xx 对同一地址不重试，立即尝试下一个合法来源。
        if (kind !== 'transient') break
        if (attempt < 2) await abortableDelay(350 * 2 ** attempt, extSignal)
      }
    }
  }
  const detail = failures.length ? `；已尝试：${failures.join('；')}` : ''
  const reason = lastErr instanceof Error ? lastErr.message : String(lastErr)
  throw new Error(`下载失败：${path.basename(dest)}（${reason}）${detail}`)
}

/**
 * 并发下载池。
 * onProgress(doneCount, totalCount, speedBps)：每完成一个文件回调一次，
 * 且每 500ms 额外回调一次带实时速度（滑窗统计字节增量）。
 * 任一文件最终失败则整体 reject；extSignal 取消时在途文件尽快停止。
 */
export async function downloadAll(
  tasks: DownloadTask[],
  onProgress?: AllProgressFn,
  concurrency = 8,
  mirror: MirrorPref = 'official',
  extSignal?: AbortSignal
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
  const poolController = new AbortController()
  const poolSignal = extSignal
    ? AbortSignal.any([extSignal, poolController.signal])
    : poolController.signal
  let firstError: unknown = null
  const worker = async (): Promise<void> => {
    while (idx < tasks.length) {
      if (poolSignal.aborted) throw new Error('已取消')
      const t = tasks[idx++]
      let lastReceived = 0
      try {
        await downloadFile(
          t.url,
          t.dest,
          (received) => {
            bytesTotal += received - lastReceived
            lastReceived = received
          },
          t.sha1,
          mirror,
          poolSignal
        )
      } catch (e) {
        if (firstError == null) firstError = e
        poolController.abort(e)
        throw e
      }
      done++
      onProgress?.(done, total, speed)
    }
  }
  try {
    const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker())
    await Promise.allSettled(workers)
    if (firstError != null) {
      if (extSignal?.aborted) throw new Error('已取消')
      throw firstError
    }
  } finally {
    clearInterval(timer)
  }
}
