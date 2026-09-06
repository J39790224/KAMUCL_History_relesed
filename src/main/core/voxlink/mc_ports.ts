/**
 * voxlink/mc_ports.ts — 探测本机 Minecraft Java 进程的监听端口
 * （移植自 voxlink/app-desktop/mc_ports.go）
 *
 *   1) 列出所有 java.exe / javaw.exe 进程（wmic 优先，powershell 兜底），按 CommandLine
 *      是否命中 MC 特征判断"是不是 MC 进程"。
 *   2) 对每个 MC PID 解析 netstat -ano -p TCP 的 LISTENING 行，过滤出该 PID 的端口。
 *   3) 返回 {ports:[{port,pid}]}，0 个=没检测到；多端口全返回（≤3 个，按端口升序）。
 */
import { spawn } from 'node:child_process'

const MC_MAX_RESULT = 3

const MC_KEYWORDS = [
  'minecraft',
  '.minecraft',
  'fabric',
  'forge',
  'neoforge',
  'net.fabricmc',
  'launchwrapper'
]

function isMcProcessLine(cmdLine: string): boolean {
  const low = cmdLine.toLowerCase()
  for (const kw of MC_KEYWORDS) if (low.includes(kw)) return true
  return false
}

interface ProcEntry { pid: number; cmd: string }

function execCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    try {
      const child = spawn(cmd, args, { windowsHide: true })
      const chunks: Buffer[] = []
      child.stdout.on('data', (c: Buffer) => chunks.push(c))
      child.stderr.on('data', (c: Buffer) => chunks.push(c))
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'))
        else reject(new Error(`${cmd} exited ${code}`))
      })
    } catch (e) {
      reject(e as Error)
    }
  })
}

function parseCsvLine(line: string): string[] {
  // 简易 CSV 解析（不依赖外部库）：处理双引号包裹 + 转义
  const out: string[] = []
  let i = 0
  while (i < line.length) {
    if (line[i] === '"') {
      let buf = ''
      i++
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          buf += '"'
          i += 2
        } else if (line[i] === '"') {
          i++
          break
        } else {
          buf += line[i]
          i++
        }
      }
      out.push(buf)
      if (line[i] === ',') i++
    } else {
      let buf = ''
      while (i < line.length && line[i] !== ',') {
        buf += line[i]
        i++
      }
      out.push(buf)
      if (line[i] === ',') i++
    }
  }
  return out
}

async function listByWmic(): Promise<ProcEntry[]> {
  const out = await execCapture('wmic', [
    'process', 'where',
    "name='java.exe' or name='javaw.exe'",
    'get', 'ProcessId,CommandLine', '/FORMAT:CSV'
  ])
  return parseWmicCsv(out)
}

function parseWmicCsv(text: string): ProcEntry[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 2) return []
  const header = parseCsvLine(lines[0]!).map((h) => h.toLowerCase().trim())
  const cmdIdx = header.indexOf('commandline')
  const pidIdx = header.indexOf('processid')
  if (cmdIdx < 0 || pidIdx < 0) return []
  const out: ProcEntry[] = []
  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]!)
    if (row.length <= pidIdx) continue
    const pid = parseInt(row[pidIdx]!.trim(), 10)
    if (!pid) continue;
    const cmd = cmdIdx < row.length ? row[cmdIdx]! : ''
    out.push({ pid, cmd })
  }
  return out
}

async function listByPowerShell(): Promise<ProcEntry[]> {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='java.exe' or Name='javaw.exe'" | Select ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation`
  const out = await execCapture('powershell', ['-NoProfile', '-Command', ps])
  return parsePsCsv(out)
}

function parsePsCsv(text: string): ProcEntry[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 2) return []
  const header = parseCsvLine(lines[0]!).map((h) => h.toLowerCase().trim().replace(/^"|"$/g, ''))
  const cmdIdx = header.indexOf('commandline')
  const pidIdx = header.indexOf('processid')
  if (cmdIdx < 0 || pidIdx < 0) return []
  const out: ProcEntry[] = []
  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]!)
    if (row.length <= pidIdx) continue
    const pid = parseInt(row[pidIdx]!.trim(), 10)
    if (!pid) continue;
    const cmd = cmdIdx < row.length ? row[cmdIdx]! : ''
    out.push({ pid, cmd })
  }
  return out
}

async function listJavaProcesses(): Promise<ProcEntry[]> {
  try {
    const w = await listByWmic()
    if (w.length > 0) return w
  } catch { /* fallthrough */ }
  try {
    const p = await listByPowerShell()
    return p
  } catch {
    return []
  }
}

interface NetstatEntry { port: number; pid: number }

function parseNetstat(text: string): NetstatEntry[] {
  const out: NetstatEntry[] = []
  const seen = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/)
    if (f.length < 5) continue
    if (f[0]!.toUpperCase() !== 'TCP') continue
    if (f[3]!.toUpperCase() !== 'LISTENING') continue
    const local = f[1]!
    const idx = local.lastIndexOf(':')
    if (idx < 0) continue
    const port = parseInt(local.slice(idx + 1), 10)
    if (!port || port < 1 || port > 65535) continue
    const pid = parseInt(f[f.length - 1]!, 10)
    if (!pid) continue
    const k = `${port}:${pid}`
    if (!seen.has(k)) {
      seen.add(k)
      out.push({ port, pid })
    }
  }
  return out
}

export interface McPortEntry { port: number; pid: number }

export async function detectMcPorts(): Promise<McPortEntry[]> {
  const procs = await listJavaProcesses()
  if (procs.length === 0) return []
  const mcPids = new Set<number>()
  for (const p of procs) if (isMcProcessLine(p.cmd)) mcPids.add(p.pid)
  if (mcPids.size === 0) return []
  let netstatOut = ''
  try {
    netstatOut = await execCapture('netstat', ['-ano', '-p', 'TCP'])
  } catch {
    return []
  }
  const entries = parseNetstat(netstatOut)
  const filtered = entries.filter((e) => mcPids.has(e.pid))
  filtered.sort((a, b) => (a.port !== b.port ? a.port - b.port : a.pid - b.pid))
  const result = filtered.slice(0, MC_MAX_RESULT).map<McPortEntry>((e) => ({ port: e.port, pid: e.pid }))
  return result
}

/** 端口可达性探测（TCP Dial 127.0.0.1）。 */
import net from 'node:net'
export async function probeHostPort(hostPort: number, timeoutMs = 1500): Promise<void> {
  if (hostPort < 1 || hostPort > 65535) throw new Error(`端口 ${hostPort} 不在合法范围`)
  return new Promise<void>((resolve, reject) => {
    const sock = new net.Socket()
    let done = false
    const finish = (err?: Error | null): void => {
      if (done) return
      done = true
      sock.destroy()
      if (err) reject(err)
      else resolve()
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(null))
    sock.once('error', (err) => finish(err))
    sock.once('timeout', () => finish(new Error('timeout')))
    sock.connect(hostPort, '127.0.0.1')
  })
}