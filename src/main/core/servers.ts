/**
 * 服务器：列表 CRUD（userData/servers.json）+ MC Server List Ping（1.7+ 协议）
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import type { ServerEntry, ServerPingResult } from '../../shared/types'

function storeFile(): string {
  return path.join(app.getPath('userData'), 'servers.json')
}

export function listServers(): ServerEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf-8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

function persist(list: ServerEntry[]): void {
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true })
  fs.writeFileSync(storeFile(), JSON.stringify(list, null, 2), 'utf-8')
}

export function addServer(name: string, address: string): ServerEntry[] {
  const n = name.trim()
  const a = address.trim()
  if (!n) throw new Error('服务器名称不能为空')
  if (!a) throw new Error('服务器地址不能为空')
  const list = listServers()
  if (list.some((s) => s.address === a)) throw new Error('该服务器已在列表中')
  list.push({ id: crypto.randomUUID(), name: n, address: a })
  persist(list)
  return list
}

export function removeServer(id: string): ServerEntry[] {
  const list = listServers().filter((s) => s.id !== id)
  persist(list)
  return list
}

// ---------------- Server List Ping ----------------

/** VarInt 编码 */
function writeVarInt(v: number): Buffer {
  const out: number[] = []
  let x = v >>> 0
  if (v < 0) x = v // 协议版本用负数（-1）时按 32 位处理
  do {
    let b = x & 0x7f
    x >>>= 7
    if (x !== 0) b |= 0x80
    out.push(b)
  } while (x !== 0)
  return Buffer.from(out)
}

/** 组包：VarInt 长度 + 包 id + 载荷 */
function pack(id: number, payload: Buffer): Buffer {
  const body = Buffer.concat([writeVarInt(id), payload])
  return Buffer.concat([writeVarInt(body.length), body])
}

/** MOTD 对象转纯文本并去掉 § 格式化码 */
function motdText(desc: unknown): string {
  let text = ''
  const walk = (node: unknown): void => {
    if (typeof node === 'string') text += node
    else if (node && typeof node === 'object') {
      const o = node as { text?: unknown; extra?: unknown[] }
      if (typeof o.text === 'string') text += o.text
      if (Array.isArray(o.extra)) o.extra.forEach(walk)
    }
  }
  walk(desc)
  return text.replace(/§[0-9a-fk-or]/gi, '').trim()
}

interface StatusJson {
  players?: { online?: number; max?: number }
  version?: { name?: string }
  description?: unknown
}

/**
 * 对 MC 服务器执行 Server List Ping。
 * 6 秒超时；offline 时不抛错，返回 online:false。
 */
export function pingServer(address: string): Promise<ServerPingResult> {
  return new Promise((resolve) => {
    const offline: ServerPingResult = {
      online: false,
      players: '-',
      motd: '无法连接（服务器离线或地址错误）',
      version: '-',
      latencyMs: 0
    }
    const [hostRaw, portRaw] = address.split(':')
    const host = (hostRaw ?? '').trim()
    const port = portRaw ? parseInt(portRaw, 10) : 25565
    if (!host || Number.isNaN(port)) {
      resolve(offline)
      return
    }

    const start = Date.now()
    let done = false
    const finish = (r: ServerPingResult): void => {
      if (done) return
      done = true
      try {
        sock.destroy()
      } catch {
        /* 忽略 */
      }
      resolve(r)
    }

    const sock = net.connect({ host, port })
    sock.setNoDelay(true)
    sock.setTimeout(6000)

    sock.on('connect', () => {
      // Handshake：protocol=-1（任意）、地址、端口、next=1(status)
      const addrBuf = Buffer.from(host, 'utf-8')
      const payload = Buffer.concat([
        writeVarInt(-1),
        writeVarInt(addrBuf.length),
        addrBuf,
        Buffer.from([port >> 8, port & 0xff]),
        writeVarInt(1)
      ])
      sock.write(pack(0x00, payload))
      sock.write(pack(0x00, Buffer.alloc(0))) // Status Request
    })

    let buf = Buffer.alloc(0)
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      // 读 VarInt 包长度
      let len = 0
      let shift = 0
      let i = 0
      for (; i < buf.length && i < 5; i++) {
        len |= (buf[i] & 0x7f) << (shift * 7)
        shift++
        if ((buf[i] & 0x80) === 0) break
      }
      if (i >= buf.length || (i < buf.length && (buf[i] & 0x80) !== 0)) return // 长度未收全
      const headLen = i + 1
      if (buf.length < headLen + len) return // 包体未收全
      const body = buf.subarray(headLen, headLen + len)
      // body: packetId(0x00) + VarInt jsonLen + json
      let j = 1
      let jsonLen = 0
      let jshift = 0
      for (; j < body.length && j < 6; j++) {
        jsonLen |= (body[j] & 0x7f) << (jshift * 7)
        jshift++
        if ((body[j] & 0x80) === 0) break
      }
      const json = body.subarray(j + 1, j + 1 + jsonLen).toString('utf-8')
      try {
        const s = JSON.parse(json) as StatusJson
        finish({
          online: true,
          players: `${s.players?.online ?? 0}/${s.players?.max ?? 0}`,
          motd: motdText(s.description) || '这个服务器没有介绍',
          version: s.version?.name ?? '未知',
          latencyMs: Date.now() - start
        })
      } catch {
        finish(offline)
      }
    })
    sock.on('timeout', () => finish(offline))
    sock.on('error', () => finish(offline))
  })
}
