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
}

const tasks = new Map<string, TaskRecord>()
let seq = 0

export function registerTask(title: string, kind: TaskRecord['kind']): TaskRecord {
  const id = `${kind}-${Date.now()}-${++seq}`
  const rec: TaskRecord = { id, title, kind, controller: new AbortController() }
  tasks.set(id, rec)
  return rec
}

export function cancelTask(id: string): boolean {
  const rec = tasks.get(id)
  if (!rec) return false
  rec.controller.abort(new Error('已取消'))
  return true
}

export function finishTask(id: string): void {
  tasks.delete(id)
}

/** 取消错误的统一判定（abort 信号抛出） */
export function isCancelError(e: unknown): boolean {
  return e instanceof Error && (e.message === '已取消' || e.name === 'AbortError')
}

/** 阶段边界手动检查（下载循环之外的长流程节点调用） */
export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('已取消')
}
