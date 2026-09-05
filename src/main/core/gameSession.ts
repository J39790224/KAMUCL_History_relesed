import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'

/** Own one launch from preparation until its actual process closes. */
export class GameSession {
  private active: { token: symbol; versionId: string; child?: ChildProcess } | null = null
  private stopApproval?: { token: symbol; nonce: string }
  private stopping = false
  stopIntentToken?: symbol
  get busy() { return !!this.active }
  get versionId() { return this.active?.versionId ?? null }
  get token() { return this.active?.token }
  /** Save-first stop. Only a timed-out request can authorize force for this JVM. */
  async requestStop(requestClose: (child: ChildProcess) => Promise<void>, forceToken?: string, timeoutMs = 30000): Promise<{ requiresForce: boolean; forceToken?: string }> {
    if (!this.active?.child) throw new Error('没有正在运行的游戏，或游戏仍在准备启动')
    if (this.stopping) throw new Error('正在等待游戏退出，请稍候')
    const token = this.active.token
    if (forceToken && (!this.stopApproval || this.stopApproval.token !== token || this.stopApproval.nonce !== forceToken)) throw new Error('强制结束确认已失效，未结束任何进程')
    this.stopping = true; this.stopIntentToken = token
    try {
      if (forceToken) {
        this.stopApproval = undefined
        await this.stop()
      } else {
        try { await this.stopGracefully(requestClose, timeoutMs) }
        catch {
          if (this.active?.token !== token) return { requiresForce: false }
          this.stopApproval = { token, nonce: randomUUID() }
          return { requiresForce: true, forceToken: this.stopApproval.nonce }
        }
      }
      return { requiresForce: false }
    } finally { this.stopping = false }
  }
  async stopGracefully(requestClose: (child: ChildProcess) => Promise<void>, timeoutMs = 30000): Promise<void> {
    const session = this.active, child = session?.child
    if (!child) throw new Error('游戏仍在准备启动，请稍后重试')
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); child.off('close', exited) }
      const exited = () => { cleanup(); resolve() }
      const timer = setTimeout(() => { cleanup(); reject(new Error('正常退出等待超时，游戏可能正在保存；可继续等待，或明确选择强制结束')) }, timeoutMs)
      child.once('close', exited)
      // A failed close request does not mean the JVM exited. Keep listening until
      // actual close or timeout; force termination is a separate confirmed action.
      void requestClose(child).catch(() => {})
    })
  }
  reserve(versionId: string): symbol {
    if (this.active) throw new Error('已有游戏正在启动或运行，请先结束当前游戏')
    const token = Symbol(versionId)
    this.stopApproval = undefined; this.stopIntentToken = undefined
    this.active = { token, versionId }
    return token
  }
  attach(token: symbol, child: ChildProcess) {
    if (this.active?.token !== token) throw new Error('启动会话已失效')
    this.active.child = child
  }
  release(token: symbol): boolean {
    if (this.active?.token !== token) return false
    this.active = null
    return true
  }
  async stop(timeoutMs = 8000): Promise<void> {
    const session = this.active
    if (!session) throw new Error('没有可结束的游戏进程')
    const child = session.child
    if (!child) throw new Error('游戏仍在准备启动，请等待进程创建后再结束')
    await new Promise<void>((resolve, reject) => {
      const clean = () => { clearTimeout(timer); child.off('close', exited); child.off('error', failed) }
      const exited = () => { clean(); resolve() }
      const failed = (error: Error) => { clean(); reject(error) }
      const timer = setTimeout(() => failed(new Error('游戏进程尚未确认退出；请在游戏内退出或检查进程状态')), timeoutMs)
      child.once('close', exited)
      child.once('error', failed)
      try {
        if (child.exitCode === null && child.signalCode === null && !child.kill()) {
          failed(new Error('系统未接受结束请求，游戏状态保持运行'))
        }
      }
      catch (error) { failed(error as Error) }
    })
    // Only the owning process callback releases the session and announces its exit.
  }
}
