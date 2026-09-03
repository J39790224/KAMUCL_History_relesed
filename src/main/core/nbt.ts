/**
 * 极简 NBT（Named Binary Tag）读写器：只支持 servers.dat 需要的类型
 * （0=End, 1=Byte, 3=Int, 8=String, 9=List, 10=Compound）。
 * servers.dat 为未压缩 NBT：根 Compound（无名）→ servers: List[Compound{name, ip, ...}]
 */

export interface NbtCompound {
  [key: string]: unknown
}

// ---------------- 读 ----------------
class Reader {
  private off = 0
  constructor(private buf: Buffer) {}

  byte(): number {
    return this.buf.readInt8(this.off++)
  }
  short(): number {
    const v = this.buf.readInt16BE(this.off)
    this.off += 2
    return v
  }
  int(): number {
    const v = this.buf.readInt32BE(this.off)
    this.off += 4
    return v
  }
  string(): string {
    const len = this.short()
    const s = this.buf.toString('utf-8', this.off, this.off + len)
    this.off += len
    return s
  }

  payload(type: number): unknown {
    switch (type) {
      case 1:
        return this.byte()
      case 3:
        return this.int()
      case 8:
        return this.string()
      case 9: {
        const itemType = this.byte()
        const len = this.int()
        const arr: unknown[] = []
        for (let i = 0; i < len; i++) arr.push(this.payload(itemType))
        return arr
      }
      case 10: {
        const obj: NbtCompound = {}
        for (;;) {
          const t = this.byte()
          if (t === 0) break
          const name = this.string()
          obj[name] = this.payload(t)
        }
        return obj
      }
      default:
        throw new Error(`不支持的 NBT 类型: ${type}`)
    }
  }
}

/** 解析 NBT 二进制为根 Compound */
export function parseNbt(buf: Buffer): NbtCompound {
  const r = new Reader(buf)
  const rootType = r.byte()
  if (rootType !== 10) throw new Error('NBT 根节点不是 Compound')
  r.string() // root name（通常为空）
  return r.payload(10) as NbtCompound
}

// ---------------- 写 ----------------
class Writer {
  private parts: Buffer[] = []
  byte(v: number): void {
    const b = Buffer.alloc(1)
    b.writeInt8(v)
    this.parts.push(b)
  }
  short(v: number): void {
    const b = Buffer.alloc(2)
    b.writeInt16BE(v)
    this.parts.push(b)
  }
  int(v: number): void {
    const b = Buffer.alloc(4)
    b.writeInt32BE(v)
    this.parts.push(b)
  }
  string(v: string): void {
    const b = Buffer.from(v, 'utf-8')
    this.short(b.length)
    this.parts.push(b)
  }
  buffer(): Buffer {
    return Buffer.concat(this.parts)
  }
}

function writePayload(w: Writer, type: number, value: unknown): void {
  switch (type) {
    case 1:
      w.byte(value as number)
      break
    case 3:
      w.int(value as number)
      break
    case 8:
      w.string(value as string)
      break
    case 10: {
      for (const [k, v] of Object.entries(value as NbtCompound)) {
        const t = tagTypeOf(v)
        w.byte(t)
        w.string(k)
        writePayload(w, t, v)
      }
      w.byte(0)
      break
    }
    default:
      throw new Error(`不支持的写入类型: ${type}`)
  }
}

function tagTypeOf(v: unknown): number {
  if (typeof v === 'string') return 8
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 128 ? 1 : 3
  if (typeof v === 'object' && v !== null) return 10
  throw new Error('无法推断 NBT 类型')
}

/** 序列化根 Compound 为 NBT 二进制 */
export function writeNbt(root: NbtCompound): Buffer {
  const w = new Writer()
  w.byte(10)
  w.string('')
  writePayload(w, 10, root)
  return w.buffer()
}

/** 构造 servers.dat 内容：servers: List[Compound{name, ip}] */
export function buildServersDat(list: Array<{ name: string; ip: string }>): Buffer {
  const w = new Writer()
  w.byte(10) // root compound
  w.string('')
  // "servers" list of compound(10)
  w.byte(9)
  w.string('servers')
  w.byte(10) // item type: compound
  w.int(list.length)
  for (const s of list) {
    w.byte(8)
    w.string('name')
    w.string(s.name)
    w.byte(8)
    w.string('ip')
    w.string(s.ip)
    w.byte(0) // end compound item
  }
  w.byte(0) // end root
  return w.buffer()
}
