/**
 * 下载模块：流式写盘 + sha1 校验 + BMCLAPI 镜像回退 + 并发池
 * 仅使用 Node 内置模块（全局 fetch / node:fs / node:crypto）
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { once } from 'node:events'
import {
  abortableDelay,
  inheritTaskControl,
  isTaskPaused,
  waitIfTaskPaused
} from './tasks'
import {
  DownloadProgressTracker,
  SmoothedSpeedEstimator,
  type DownloadProgressSnapshot
} from './downloadProgress'

export type MirrorPref = 'official' | 'bmclapi'
export type ProgressFn = (done: number, total: number) => void
export interface DownloadBatchProgress extends DownloadProgressSnapshot {
  speedBps: number
  etaSeconds: number | null
  paused: boolean
}
/** 前三个参数保留兼容；detail 提供真实字节进度、平滑 ETA 和不确定状态。 */
export type AllProgressFn = (
  done: number,
  total: number,
  speedBps: number,
  detail: DownloadBatchProgress
) => void

export interface DownloadTask {
  url: string
  /** 元数据声明的其他合法来源，按原顺序 fallback。 */
  urls?: string[]
  dest: string
  sha1?: string
  sha512?: string
  size?: number
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

class DownloadIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DownloadIntegrityError'
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

/** 一次流读取同时计算所需哈希，校验阶段也响应任务取消。 */
function hashesOf(
  file: string,
  algorithms: Array<'sha1' | 'sha512'>,
  signal?: AbortSignal
): Promise<Partial<Record<'sha1' | 'sha512', string>>> {
  return new Promise((resolve, reject) => {
    const hashes = new Map(algorithms.map((algorithm) => [algorithm, crypto.createHash(algorithm)]))
    const stream = fs.createReadStream(file)
    const onAbort = (): void => stream.destroy(new DOMException('已取消', 'AbortError'))
    stream
      .on('error', reject)
      .on('data', (data) => {
        for (const hash of hashes.values()) hash.update(data)
      })
      .on('end', () => {
        const result: Partial<Record<'sha1' | 'sha512', string>> = {}
        for (const [algorithm, hash] of hashes) result[algorithm] = hash.digest('hex')
        resolve(result)
      })
      .on('close', () => signal?.removeEventListener('abort', onAbort))
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function verifyFile(
  file: string,
  expected: { sha1?: string; sha512?: string; size?: number },
  signal?: AbortSignal
): Promise<string | null> {
  const stat = await fs.promises.stat(file)
  if (expected.size != null && stat.size !== expected.size) {
    return `大小校验失败：期望 ${expected.size}，实际 ${stat.size}`
  }
  const algorithms: Array<'sha1' | 'sha512'> = []
  if (expected.sha1) algorithms.push('sha1')
  if (expected.sha512) algorithms.push('sha512')
  if (!algorithms.length) return null
  const actual = await hashesOf(file, algorithms, signal)
  if (expected.sha1 && actual.sha1 !== expected.sha1.toLowerCase()) return 'sha1 校验失败'
  if (expected.sha512 && actual.sha512 !== expected.sha512.toLowerCase()) return 'sha512 校验失败'
  return null
}

interface TransferResult {
  tmp: string
  received: number
  total: number
}

/** 单次下载到 .part；支持 HTTP Range 续传，最终校验与原子改名由 downloadFile 负责。 */
async function doDownload(
  url: string,
  dest: string,
  onProgress?: ProgressFn,
  extSignal?: AbortSignal,
  expectedSize?: number
): Promise<TransferResult> {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  if (extSignal?.aborted) throw new Error('已取消')
  const tmp = dest + '.part'
  let offset = 0
  try {
    offset = fs.statSync(tmp).size
    if (expectedSize != null && offset > expectedSize) {
      fs.rmSync(tmp, { force: true })
      offset = 0
    }
  } catch {
    offset = 0
  }

  const requestController = new AbortController()
  const onExternalAbort = (): void => requestController.abort(extSignal?.reason)
  extSignal?.addEventListener('abort', onExternalAbort, { once: true })
  let inactivityTimer: NodeJS.Timeout | undefined
  const clearInactivity = (): void => {
    if (inactivityTimer) clearTimeout(inactivityTimer)
    inactivityTimer = undefined
  }
  const armInactivity = (): void => {
    clearInactivity()
    inactivityTimer = setTimeout(
      () => requestController.abort(new DOMException('网络读取超时', 'TimeoutError')),
      30_000
    )
  }

  try {
    await waitIfTaskPaused(extSignal)
    armInactivity()
    const headers: Record<string, string> = {}
    if (offset > 0) headers.Range = `bytes=${offset}-`
    const res = await fetch(url, {
      signal: requestController.signal,
      redirect: 'follow',
      headers
    })
    if (res.status === 416 && expectedSize != null && offset === expectedSize) {
      clearInactivity()
      onProgress?.(offset, expectedSize)
      return { tmp, received: offset, total: expectedSize }
    }
    if (!res.ok || !res.body) throw new DownloadHttpError(res.status, url)

    const append = offset > 0 && res.status === 206
    if (!append) offset = 0 // 服务端忽略 Range 并返回 200 时从头覆盖
    const contentRange = res.headers.get('content-range')
    const rangeMatch = contentRange?.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i)
    if (append && rangeMatch && Number(rangeMatch[1]) !== offset) {
      fs.rmSync(tmp, { force: true })
      throw new DownloadIntegrityError(`断点位置不匹配：请求 ${offset}，响应 ${rangeMatch[1]}`)
    }
    const contentLength = Number(res.headers.get('content-length') ?? 0)
    const rangeTotal = rangeMatch?.[3] && rangeMatch[3] !== '*' ? Number(rangeMatch[3]) : 0
    const total = expectedSize ?? (rangeTotal || (contentLength > 0 ? offset + contentLength : 0))
    if (expectedSize != null && rangeTotal > 0 && rangeTotal !== expectedSize) {
      throw new DownloadIntegrityError(`远端大小 ${rangeTotal} 与元数据 ${expectedSize} 不一致`)
    }

    const ws = fs.createWriteStream(tmp, { flags: append ? 'a' : 'w' })
    ws.on('error', () => undefined)
    const reader = res.body.getReader()
    const onAbort = (): void => {
      void reader.cancel(requestController.signal.reason).catch(() => undefined)
      ws.destroy(requestController.signal.reason as Error | undefined)
    }
    requestController.signal.addEventListener('abort', onAbort, { once: true })
    let received = offset
    onProgress?.(received, total)
    try {
      for (;;) {
        if (extSignal?.aborted) throw new Error('已取消')
        if (isTaskPaused(extSignal)) {
          clearInactivity()
          await waitIfTaskPaused(extSignal)
          armInactivity()
        }
        const { done, value } = await reader.read()
        if (done) break
        if (value && value.byteLength > 0) {
          received += value.byteLength
          if (!ws.write(value)) await once(ws, 'drain')
          onProgress?.(received, total)
          armInactivity()
        }
      }
      ws.end()
      await once(ws, 'finish')
      if (extSignal?.aborted) throw new Error('已取消')
      if (total > 0 && received !== total) {
        throw new DownloadIntegrityError(`响应提前结束：期望 ${total} 字节，实际 ${received} 字节`)
      }
      return { tmp, received, total }
    } catch (e) {
      void reader.cancel().catch(() => undefined)
      ws.destroy()
      if (!ws.closed) await once(ws, 'close').catch(() => undefined)
      if (extSignal?.aborted) fs.rmSync(tmp, { force: true })
      if (extSignal?.aborted) throw new Error('已取消')
      throw e
    } finally {
      requestController.signal.removeEventListener('abort', onAbort)
    }
  } finally {
    clearInactivity()
    extSignal?.removeEventListener('abort', onExternalAbort)
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
  alternateUrls: string[] = [],
  integrity: { sha512?: string; size?: number } = {}
): Promise<void> {
  const expected = { sha1, sha512: integrity.sha512, size: integrity.size }
  if (fs.existsSync(dest)) {
    const invalid = await verifyFile(dest, expected, extSignal)
    if (!invalid) {
      const size = fs.statSync(dest).size
      onProgress?.(size, expected.size ?? size)
      return
    }
    fs.rmSync(dest, { force: true })
  }

  // 上次网络中断后若 .part 已完整，直接校验并提交，不再发无意义 Range 请求。
  const tmp = dest + '.part'
  if (fs.existsSync(tmp) && expected.size != null && fs.statSync(tmp).size === expected.size) {
    const invalid = await verifyFile(tmp, expected, extSignal)
    if (!invalid) {
      fs.renameSync(tmp, dest)
      onProgress?.(expected.size, expected.size)
      return
    }
    fs.rmSync(tmp, { force: true })
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
  for (const candidate of candidates) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (extSignal?.aborted) throw new Error('已取消')
      try {
        const transfer = await doDownload(
          candidate,
          dest,
          monoOnProgress,
          extSignal,
          expected.size
        )
        const invalid = await verifyFile(transfer.tmp, expected, extSignal)
        if (invalid) {
          fs.rmSync(transfer.tmp, { force: true })
          failures.push(`${candidate} -> ${invalid}`)
          lastErr = new DownloadIntegrityError(`${invalid}: ${path.basename(dest)}`)
          // 完整响应但内容错误：切换来源，不对同一地址无脑重试。
          break
        }
        fs.rmSync(dest, { force: true })
        fs.renameSync(transfer.tmp, dest)
        return
      } catch (e) {
        if (extSignal?.aborted) {
          fs.rmSync(dest + '.part', { force: true })
          throw new Error('已取消')
        }
        lastErr = e
        const kind =
          e instanceof DownloadHttpError
            ? classifyHttpStatus(e.status)
            : e instanceof DownloadIntegrityError
              ? 'fatal'
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
    onProgress?.(0, 0, 0, {
      completedFiles: 0,
      totalFiles: 0,
      bytesDone: 0,
      bytesTotal: 0,
      fraction: 1,
      indeterminate: false,
      speedBps: 0,
      etaSeconds: null,
      paused: false
    })
    return
  }
  const tracker = new DownloadProgressTracker()
  const progressIds = tasks.map((task) => tracker.add(task.size))
  tracker.seal()
  let idx = 0
  const poolController = new AbortController()
  const poolSignal = extSignal
    ? AbortSignal.any([extSignal, poolController.signal])
    : poolController.signal
  inheritTaskControl(extSignal, poolSignal)
  let networkBytes = 0
  let speedState = { speedBps: 0, etaSeconds: null as number | null }
  let lastEmitAt = 0
  const speedEstimator = new SmoothedSpeedEstimator()
  const emitSnapshot = (force = false): void => {
    const now = Date.now()
    if (!force && now - lastEmitAt < 100) return
    lastEmitAt = now
    const snapshot = tracker.snapshot()
    const detail: DownloadBatchProgress = {
      ...snapshot,
      ...speedState,
      paused: isTaskPaused(poolSignal)
    }
    onProgress?.(
      snapshot.completedFiles,
      snapshot.totalFiles,
      speedState.speedBps,
      detail
    )
  }
  emitSnapshot(true)
  const timer = setInterval(() => {
    const snapshot = tracker.snapshot()
    const remaining =
      snapshot.bytesTotal == null
        ? null
        : Math.max(0, snapshot.bytesTotal - snapshot.bytesDone)
    speedState = speedEstimator.sample(
      networkBytes,
      remaining,
      Date.now(),
      isTaskPaused(poolSignal)
    )
    emitSnapshot(true)
  }, 500)
  timer.unref()
  let firstError: unknown = null
  const worker = async (): Promise<void> => {
    while (idx < tasks.length) {
      if (poolSignal.aborted) throw new Error('已取消')
      await waitIfTaskPaused(poolSignal)
      const taskIndex = idx++
      const t = tasks[taskIndex]
      let lastReceived = 0
      let hasReceivedSample = false
      try {
        await downloadFile(
          t.url,
          t.dest,
          (received, discoveredTotal) => {
            if (hasReceivedSample) networkBytes += Math.max(0, received - lastReceived)
            else hasReceivedSample = true
            lastReceived = received
            tracker.update(progressIds[taskIndex], received, discoveredTotal)
            emitSnapshot()
          },
          t.sha1,
          mirror,
          poolSignal,
          (t.urls ?? []).filter((url) => url !== t.url),
          { sha512: t.sha512, size: t.size }
        )
      } catch (e) {
        if (firstError == null) firstError = e
        poolController.abort(e)
        throw e
      }
      const actualSize = fs.statSync(t.dest).size
      tracker.complete(progressIds[taskIndex], actualSize)
      emitSnapshot(true)
    }
  }
  try {
    const workers = Array.from(
      { length: Math.min(Math.max(1, Math.floor(concurrency) || 1), total) },
      () => worker()
    )
    await Promise.allSettled(workers)
    if (firstError != null) {
      if (extSignal?.aborted) throw new Error('已取消')
      throw firstError
    }
    speedState = { speedBps: 0, etaSeconds: null }
    emitSnapshot(true)
  } finally {
    clearInterval(timer)
  }
}
