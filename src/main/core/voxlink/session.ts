/**
 * voxlink/session.ts — 单个房间会话：心跳循环 + 信令循环（移植自 voxlink/app-desktop/session.go）
 *
 * WS 复用为通用帧通道：wsLoop 持有连接，心跳/轮询经 wsSend 帧化发送，
 * 推送帧 id=0 走 handleSignals。
 *
 * 时间常量与 Go 原值对齐：heartbeat 5s/失败 5 次、轮询 1s/失败 10 次、ws 重试 30s、ws 响应 15s。
 */
// 使用 Node 内置 WebSocket（Node 22+），与浏览器 API 一致
import { EventEmitter } from 'node:events'
import type { ApiClient } from './api'
import { APIError } from './api'

const DEFAULT_HEARTBEAT_INTERVAL = 5_000
const MAX_HEARTBEAT_FAILURES = 5
const MAX_POLL_FAILURES = 10
const WS_RETRY_WAIT_MS = 30_000
const HTTP_POLL_INTERVAL_MS = 1_000
const WS_RESPONSE_TIMEOUT_MS = 15_000
const WS_POLL_INTERVAL_MS = 5_000

export interface SessionOptions {
  code: string
  token: string
  isHost: boolean
}

export interface SignalMsg {
  id?: unknown
  from: string
  type: string
  data: Record<string, unknown>
  timestamp: number
  to?: string
}

export interface SessionState {
  state: 'idle' | 'hosting' | 'in_room' | 'closed'
  code: string
  token: string
  isHost: boolean
  room: Record<string, unknown> | null
}

export type LogFn = (level: 'info' | 'warn' | 'error', msg: string) => void
export type EmitFn = (event: string, data: unknown) => void

export class VoxlinkSession extends EventEmitter {
  readonly app: { api: ApiClient; baseURL: () => string; emit: EmitFn; netLog: LogFn }
  readonly code: string
  readonly token: string
  readonly isHost: boolean

  private done = false
  private donePromise: Promise<void>
  private doneResolve!: () => void
  private stopCh = false
  private stopOnce = false
  private fatalMu = false
  private fatalled = false

  private sinceMs = Date.now() - 30_000

  // WS 复用
  private wsConn: WebSocket | null = null
  private wsPending = new Map<number, { resolve: (f: WsFrame) => void; reject: (e: Error) => void }>()
  private wsMu = false

  constructor(
    app: { api: ApiClient; baseURL: () => string; emit: EmitFn; netLog: LogFn },
    opts: SessionOptions
  ) {
    super()
    this.app = app
    this.code = opts.code
    this.token = opts.token
    this.isHost = opts.isHost
    this.donePromise = new Promise<void>((resolve) => (this.doneResolve = resolve))
  }

  isDone(): boolean {
    return this.done
  }

  getDone(): Promise<void> {
    return this.donePromise
  }

  /** 主动停止会话（LeaveRoom），不触发 closed 事件。 */
  stop(): void {
    if (this.stopOnce) return
    this.stopOnce = true
    this.stopCh = true
    this.fatal('会话已停止')
  }

  /** 标记会话致命结束，广播 closed 事件（只执行一次）。 */
  fatal(msg: string): void {
    if (this.fatalled) return
    this.fatalled = true
    this.app.netLog('error', `会话结束: ${msg}`)
    this.app.emit('session:state', { state: 'closed', message: msg, room: this.snapshotRoom() })
    this.done = true
    try { this.wsConn?.close() } catch { /* ignore */ }
    this.doneResolve()
  }

  snapshotRoom(): Record<string, unknown> | null {
    return null // 房间信息由 App 侧维护
  }

  /** 并发运行心跳与信令循环，返回时清理会话。 */
  async run(): Promise<void> {
    await Promise.all([this.heartbeatLoop(), this.signalLoop()])
  }

  // ---- 心跳循环 ----

  private async heartbeatLoop(): Promise<void> {
    let interval = DEFAULT_HEARTBEAT_INTERVAL
    let seq = 0
    let fails = 0
    while (!this.isDone()) {
      seq += 1
      const body: Record<string, unknown> = {
        code: this.code,
        token: this.token,
        isHost: this.isHost,
        seq,
        currentInterval: 5,
        mcPlayerCount: 0
      }
      let hb = { heartbeatInterval: 0, currentPlayers: 0, name: '' }
      let err: Error | null = null
      const f = await this.wsSend('/room/heartbeat', body)
      if (f) {
        if (!f.success) {
          err = new APIError(f.error || 'HTTP_ERROR', f.message || '', 400)
        } else if (f.data && typeof f.data === 'object') {
          Object.assign(hb, f.data as object)
        }
      } else {
        try {
          const out = (await this.app.api.post(this.app.baseURL(), '/room/heartbeat', body, {})) as { heartbeatInterval?: number; currentPlayers?: number; name?: string }
          hb.heartbeatInterval = out.heartbeatInterval ?? 0
          hb.currentPlayers = out.currentPlayers ?? 0
          hb.name = out.name ?? ''
        } catch (e) {
          err = e as Error
        }
      }
      if (err) {
        if (err instanceof APIError) {
          if (err.status === 410 || isFatalAuthError(err.code)) {
            this.fatal(err.message || '房间已失效')
            return
          }
        }
        fails += 1
        this.app.netLog('warn', `心跳失败(${fails}/${MAX_HEARTBEAT_FAILURES}): ${err.message}`)
        if (fails >= MAX_HEARTBEAT_FAILURES) {
          this.fatal('网络持续失败，会话已终止')
          return
        }
      } else {
        fails = 0
        this.emit('roomInfo', { currentPlayers: hb.currentPlayers, name: hb.name })
        if (hb.heartbeatInterval > 0) interval = hb.heartbeatInterval * 1000
      }
      await sleepInterruptible(interval, () => this.isDone())
    }
  }

  // ---- 信令循环 ----

  private async signalLoop(): Promise<void> {
    while (!this.isDone()) {
      try {
        await this.wsLoop()
      } catch (e) {
        if (this.isDone()) return
        this.app.netLog('warn', `WebSocket 断开，回退 HTTP 轮询: ${(e as Error).message}`)
      }
      if (this.isDone()) return
      const ended = await this.httpPollLoop(WS_RETRY_WAIT_MS)
      if (ended) return
      this.app.netLog('info', '尝试重连 WebSocket...')
    }
  }

  /** 每 1s 轮询 /signal/poll，最多运行 maxWait；返回 true 表示会话结束。 */
  private async httpPollLoop(maxWait: number): Promise<boolean> {
    const deadline = Date.now() + maxWait
    let fails = 0
    while (true) {
      if (this.isDone() || this.stopCh) return true
      const remain = deadline - Date.now()
      if (remain <= 0) return false
      await sleepInterruptible(Math.min(HTTP_POLL_INTERVAL_MS, remain), () => this.isDone())
      const body: Record<string, unknown> = {
        code: this.code,
        token: this.token,
        isHost: this.isHost,
        since: this.sinceMs
      }
      let sd: { s?: SignalMsg[]; ts?: number } | null = null
      try {
        sd = (await this.app.api.post(this.app.baseURL(), '/signal/poll', body, {})) as { s?: SignalMsg[]; ts?: number }
      } catch (e) {
        const err = e as Error
        const ae = err as APIError
        if (ae instanceof APIError && (ae.status === 410 || isFatalAuthError(ae.code))) {
          this.fatal(ae.message || '房间已失效')
          return true
        }
        fails += 1
        if (fails === 1 || fails % MAX_POLL_FAILURES === 0) {
          this.app.netLog('warn', `信令轮询失败(${fails}): ${err.message}`)
        }
        if (fails >= MAX_POLL_FAILURES) {
          this.fatal('网络持续失败，会话已终止')
          return true
        }
        continue
      }
      fails = 0
      this.handleSignals({ s: sd?.s ?? [], ts: sd?.ts ?? 0 })
    }
  }

  /** 分发信令并推进 since 游标。 */
  private handleSignals(sd: { s: SignalMsg[]; ts: number }): void {
    let maxTs = this.sinceMs
    for (const sig of sd.s) {
      if (sig.timestamp > maxTs) maxTs = sig.timestamp
      const data = sig.data || {}
      this.app.emit('signal', {
        type: sig.type,
        from: sig.from,
        data,
        timestamp: sig.timestamp
      })
      this.emit('engineSignal', { type: sig.type, from: sig.from, data })
    }
    if (sd.ts > maxTs) maxTs = sd.ts
    this.sinceMs = maxTs
  }

  // ---- WebSocket 通道 ----

  private wsURLFrom(baseURL: string): string {
    let u = baseURL.replace(/\/+$/, '')
    if (u.startsWith('https://')) u = 'wss://' + u.slice('https://'.length)
    else if (u.startsWith('http://')) u = 'ws://' + u.slice('http://'.length)
    return u + '/ws'
  }

  /** 在 WS 已连接时发送一个帧请求并等待响应；WS 未连接返回 ok=false。 */
  private async wsSend(route: string, body: unknown): Promise<WsFrame | null> {
    const conn = this.wsConn
    if (!conn || conn.readyState !== OPEN) return null
    const id = Date.now() * 1_000_000 + Math.floor(Math.random() * 1000)
    return new Promise<WsFrame | null>((resolve) => {
      const entry = {
        resolve: (f: WsFrame) => {
          clearTimeout(timer)
          resolve(f)
        },
        reject: () => {
          clearTimeout(timer)
          resolve(null)
        }
      }
      const timer = setTimeout(() => {
        this.wsPending.delete(id)
        resolve(null)
      }, WS_RESPONSE_TIMEOUT_MS)
      this.wsPending.set(id, entry)
      const payload = JSON.stringify({ id, route, method: 'POST', body })
      try {
        conn.send(payload)
      } catch {
        this.wsPending.delete(id)
        clearTimeout(timer)
        resolve(null)
      }
    })
  }

  private async wsLoop(): Promise<void> {
    const wsURL = this.wsURLFrom(this.app.baseURL())
    const conn = new WebSocket(wsURL)
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => { cleanup(); resolve() }
      const onError = (err: Event): void => { cleanup(); reject(new Error('ws error')) }
      const cleanup = (): void => {
        conn.removeEventListener('open', onOpen)
        conn.removeEventListener('error', onError)
      }
      conn.addEventListener('open', onOpen, { once: true })
      conn.addEventListener('error', onError, { once: true })
    })
    this.wsConn = conn
    this.wsPending.clear()
    this.app.netLog('info', 'WebSocket 已连接')

    let closedResolve!: () => void
    const closed = new Promise<void>((resolve) => (closedResolve = resolve))

    conn.addEventListener('message', (ev: MessageEvent) => {
      let f: WsFrame
      try {
        f = JSON.parse(String(ev.data)) as WsFrame
      } catch {
        return
      }
      if (f.push || f.id === 0) {
        const sd = f.data as { s?: SignalMsg[]; ts?: number }
        if (sd && Array.isArray(sd.s)) this.handleSignals({ s: sd.s, ts: sd.ts ?? 0 })
        return
      }
      const entry = this.wsPending.get(f.id)
      if (entry) {
        this.wsPending.delete(f.id)
        entry.resolve(f)
      }
    })
    conn.addEventListener('close', () => closedResolve())
    conn.addEventListener('error', () => closedResolve())

    const pollLoop = (async (): Promise<void> => {
      while (!this.isDone() && conn.readyState === OPEN) {
        await sleepInterruptible(WS_POLL_INTERVAL_MS, () => this.isDone())
        const body = { code: this.code, token: this.token, isHost: this.isHost, since: this.sinceMs }
        const f = await this.wsSend('/signal/poll', body)
        if (!f) {
          try { conn.close() } catch { /* ignore */ }
          return
        }
        if (!f.success) {
          const code = f.error
          if (isFatalAuthError(code)) {
            this.fatal(f.message || '房间已失效')
            try { conn.close() } catch { /* ignore */ }
            return
          }
          try { conn.close() } catch { /* ignore */ }
          throw new Error(`服务端错误: ${code} ${f.message}`)
        }
        const sd = f.data as { s?: SignalMsg[]; ts?: number }
        if (sd && Array.isArray(sd.s)) this.handleSignals({ s: sd.s, ts: sd.ts ?? 0 })
      }
    })()

    await Promise.race([closed, pollLoop])
    this.wsConn = null
    this.wsPending.clear()
    try { conn.close() } catch { /* ignore */ }
  }
}

const OPEN = 1 // WebSocket.OPEN

export interface WsFrame {
  id: number
  push?: string
  success: boolean
  error: string
  message: string
  data: unknown
}

function isFatalAuthError(code: string): boolean {
  return ['ROOM_EXPIRED', 'ROOM_CLOSED', 'ROOM_EVICTED', 'INVALID_TOKEN'].includes(code)
}

function sleepInterruptible(ms: number, isDone: () => boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      clearInterval(poll)
      resolve()
    }, ms)
    const poll = setInterval(() => {
      if (isDone()) {
        clearTimeout(t)
        clearInterval(poll)
        resolve()
      }
    }, 100)
  })
}