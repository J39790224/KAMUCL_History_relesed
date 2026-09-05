import type { ChildProcess } from 'node:child_process'

/** Own one launch from preparation until its actual process closes. */
export class GameSession {
  private active: { token: symbol; versionId: string; child?: ChildProcess } | null = null
  get busy() { return !!this.active }
  get versionId() { return this.active?.versionId ?? null }
  reserve(versionId: string): symbol {
    if (this.active) throw new Error('已有游戏正在启动或运行，请先结束当前游戏')
    const token = Symbol(versionId)
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
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve, reject) => {
      const clean = () => { clearTimeout(timer); child.off('exit', exited); child.off('error', failed) }
      const exited = () => { clean(); resolve() }
      const failed = (error: Error) => { clean(); reject(error) }
      const timer = setTimeout(() => failed(new Error('游戏进程尚未确认退出；请在游戏内退出或检查进程状态')), timeoutMs)
      child.once('exit', exited)
      child.once('error', failed)
      try { if (!child.kill()) failed(new Error('系统未接受结束请求，游戏状态保持运行')) }
      catch (error) { failed(error as Error) }
    })
    // Only the owning process callback releases the session and announces its exit.
  }
}
