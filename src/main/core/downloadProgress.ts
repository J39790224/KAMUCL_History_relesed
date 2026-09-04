export interface DownloadProgressSnapshot {
  completedFiles: number
  totalFiles: number
  bytesDone: number
  /** null 表示仍有文件总大小未知。 */
  bytesTotal: number | null
  /** null 时调用方必须显示不确定进度，不能伪造百分比。 */
  fraction: number | null
  indeterminate: boolean
}

interface ProgressEntry {
  expected: number | null
  transferred: number
  complete: boolean
}

const validSize = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

/**
 * 以每个文件“已持久化字节”聚合并发下载进度。每个 entry 只允许增长；乱序完成、
 * 重试与断点续传都不会扣掉已确认字节。动态新增任务时建立新进度 epoch，把新增
 * 工作量分配进当前剩余区间，因此已发布百分比不会倒退。
 */
export class DownloadProgressTracker {
  private readonly entries: ProgressEntry[] = []
  private sealed = false
  private lastFraction = 0
  private anchorFraction = 0
  private anchorDone = 0
  private anchorRemaining: number | null = null
  private hasDeterminateEpoch = false

  add(expected?: number): number {
    if (this.lastFraction >= 1) throw new Error('已完成的进度任务不能再添加文件')
    const wasDeterminate = this.isDeterminate()
    const doneBefore = this.bytesDone()
    if (this.sealed && wasDeterminate) this.snapshot()
    const index = this.entries.push({
      expected: validSize(expected) ? expected : null,
      transferred: 0,
      complete: false
    }) - 1
    if (this.sealed && wasDeterminate) {
      this.anchorFraction = this.lastFraction
      this.anchorDone = doneBefore
      this.anchorRemaining = this.totalExpected() == null
        ? null
        : Math.max(0, (this.totalExpected() ?? 0) - doneBefore)
      this.hasDeterminateEpoch = true
    }
    return index
  }

  /** 初始任务发现完成后调用；seal 前只报告不确定进度。 */
  seal(): void {
    this.sealed = true
    this.ensureEpoch()
  }

  update(index: number, transferred: number, discoveredTotal?: number): DownloadProgressSnapshot {
    const entry = this.entry(index)
    if (entry.expected == null && validSize(discoveredTotal) && discoveredTotal > 0) {
      entry.expected = discoveredTotal
    }
    if (validSize(transferred)) {
      const capped = entry.expected == null ? transferred : Math.min(transferred, entry.expected)
      entry.transferred = Math.max(entry.transferred, capped)
    }
    this.ensureEpoch()
    return this.snapshot()
  }

  complete(index: number, actualSize: number): DownloadProgressSnapshot {
    const entry = this.entry(index)
    if (entry.expected == null && validSize(actualSize)) entry.expected = actualSize
    if (entry.expected != null) entry.transferred = Math.max(entry.transferred, entry.expected)
    else if (validSize(actualSize)) entry.transferred = Math.max(entry.transferred, actualSize)
    entry.complete = true
    this.ensureEpoch()
    return this.snapshot()
  }

  snapshot(): DownloadProgressSnapshot {
    const bytesDone = this.bytesDone()
    const bytesTotal = this.totalExpected()
    const complete = this.entries.length > 0 && this.entries.every((entry) => entry.complete)
    if (!this.sealed || bytesTotal == null) {
      return {
        completedFiles: this.completedFiles(),
        totalFiles: this.entries.length,
        bytesDone,
        bytesTotal: null,
        fraction: complete ? 1 : null,
        indeterminate: !complete
      }
    }

    this.ensureEpoch()
    let fraction: number
    if (complete) {
      fraction = 1
    } else if (!this.anchorRemaining || this.anchorRemaining <= 0) {
      fraction = this.anchorFraction
    } else {
      const completedSinceAnchor = Math.max(0, bytesDone - this.anchorDone)
      fraction =
        this.anchorFraction +
        (1 - this.anchorFraction) * Math.min(1, completedSinceAnchor / this.anchorRemaining)
    }
    this.lastFraction = Math.max(this.lastFraction, Math.min(1, Math.max(0, fraction)))
    return {
      completedFiles: this.completedFiles(),
      totalFiles: this.entries.length,
      bytesDone,
      bytesTotal,
      fraction: this.lastFraction,
      indeterminate: false
    }
  }

  private ensureEpoch(): void {
    if (!this.sealed || !this.isDeterminate()) return
    if (this.anchorRemaining != null) return
    const total = this.totalExpected() ?? 0
    if (this.hasDeterminateEpoch) {
      this.anchorRemaining = Math.max(0, total - this.anchorDone)
    } else {
      this.anchorFraction = 0
      this.anchorDone = 0
      this.anchorRemaining = total
      this.hasDeterminateEpoch = true
    }
  }

  private entry(index: number): ProgressEntry {
    const entry = this.entries[index]
    if (!entry) throw new Error(`未知下载进度项: ${index}`)
    return entry
  }

  private isDeterminate(): boolean {
    return this.sealed && this.entries.every((entry) => entry.expected != null)
  }

  private totalExpected(): number | null {
    if (this.entries.some((entry) => entry.expected == null)) return null
    return this.entries.reduce((sum, entry) => sum + (entry.expected ?? 0), 0)
  }

  private bytesDone(): number {
    return this.entries.reduce((sum, entry) => sum + entry.transferred, 0)
  }

  private completedFiles(): number {
    return this.entries.reduce((sum, entry) => sum + (entry.complete ? 1 : 0), 0)
  }
}

export interface SpeedSnapshot {
  speedBps: number
  etaSeconds: number | null
}

/** 指数平滑速度 + 限幅 ETA，避免瞬时网络波动制造负数、Infinity 或数量级跳变。 */
export class SmoothedSpeedEstimator {
  private lastAt: number | null = null
  private lastBytes = 0
  private ema = 0
  private lastEta: number | null = null

  sample(
    transferredBytes: number,
    remainingBytes: number | null,
    now = Date.now(),
    paused = false
  ): SpeedSnapshot {
    if (this.lastAt == null) {
      this.lastAt = now
      this.lastBytes = transferredBytes
      return { speedBps: 0, etaSeconds: null }
    }
    const elapsed = Math.max(0.001, (now - this.lastAt) / 1000)
    const delta = Math.max(0, transferredBytes - this.lastBytes)
    this.lastAt = now
    this.lastBytes = transferredBytes

    if (paused) return { speedBps: 0, etaSeconds: null }

    const instant = delta / elapsed
    if (delta > 0) this.ema = this.ema > 0 ? this.ema * 0.72 + instant * 0.28 : instant
    else if (elapsed >= 1) this.ema *= 0.82
    const speedBps = Number.isFinite(this.ema) ? Math.max(0, Math.round(this.ema)) : 0

    if (remainingBytes == null || remainingBytes <= 0 || speedBps <= 0) {
      this.lastEta = null
      return { speedBps, etaSeconds: null }
    }
    let eta = remainingBytes / speedBps
    if (!Number.isFinite(eta) || eta < 0) eta = 0
    eta = Math.min(eta, 30 * 24 * 60 * 60)
    if (this.lastEta != null) {
      const lower = Math.max(0, Math.min(this.lastEta - 2, this.lastEta * 0.65))
      const upper = Math.max(this.lastEta + 5, this.lastEta * 1.35)
      eta = Math.max(lower, Math.min(upper, eta))
    }
    this.lastEta = eta
    return { speedBps, etaSeconds: Math.round(eta) }
  }
}
