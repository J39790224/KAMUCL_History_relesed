/**
 * 后台任务注册表：安装/导入/下载类任务的取消控制
 * 每个任务持有一个 AbortController，取消信号贯穿 downloadAll/downloadFile
 */

export interface TaskRecord {
  id: string
  /** 展示名（如「导入整合包 xxx.zip」「安装版本 26.2」） */
  title: string
  kind: 'version' | 'modpack' | 'download'
  controller: AbortController
  /** 仅在底层任务已经退出并完成清理后才会 resolve。 */
  settled: Promise<void>
  status: 'running' | 'cancelling'
}

const tasks = new Map<string, TaskRecord>()
let seq = 0

interface InternalTaskRecord extends TaskRecord {
  settle: () => void
}

export function registerTask(title: string, kind: TaskRecord['kind']): TaskRecord {
  const id = `${kind}-${Date.now()}-${++seq}`
  let settle = (): void => undefined
  const settled = new Promise<void>((resolve) => {
    settle = resolve
  })
  const rec: InternalTaskRecord = {
    id,
    title,
    kind,
    controller: new AbortController(),
    settled,
    settle,
    status: 'running'
  }
  tasks.set(id, rec)
  return rec
}

export function cancelTask(id: string): boolean {
  const rec = tasks.get(id) as InternalTaskRecord | undefined
  if (!rec) return false
  if (rec.status === 'running') {
    rec.status = 'cancelling'
    rec.controller.abort(new DOMException('已取消', 'AbortError'))
  }
  return true
}

export function finishTask(id: string): void {
  const rec = tasks.get(id) as InternalTaskRecord | undefined
  rec?.settle()
  tasks.delete(id)
}

/**
 * 发出取消后等待任务主流程退出。IPC 只有在 finally/回滚完成后才返回，避免 UI
 * 在网络、文件写入或安装器仍运行时把任务假装成“已取消”。
 */
export async function cancelTaskAndWait(id: string, timeoutMs = 30_000): Promise<boolean> {
  const rec = tasks.get(id)
  if (!rec) return false
  cancelTask(id)
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      rec.settled,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('取消超时：后台任务尚未停止，请稍后重试')), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
  return true
}

/** 取消错误的统一判定（abort 信号抛出） */
export function isCancelError(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.message === '已取消' || e.name === 'AbortError' || /aborted|取消/i.test(e.message))
  )
}

/** 阶段边界手动检查（下载循环之外的长流程节点调用） */
export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('已取消')
}

/** 可取消的退避等待；取消时不必等定时器自然结束。 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
  throwIfCancelled(signal)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('已取消'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
