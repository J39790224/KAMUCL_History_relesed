/**
 * 启动失败日志导出：latest.log + crash-report + 启动器/版本/Java 摘要打包为 zip
 * 文件名：KAMUCL-错误日志-<版本>-<时间戳>.zip，玩家自选保存位置
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { app, dialog, type BrowserWindow } from 'electron'
import yazl from 'yazl'
import { getSettings } from './settings'
import { gameDir, versionDir } from './paths'
import { readVersionJson, listInstalled } from './versions'
import { getLastLaunch } from './launch'
import { scanJava } from './java'

function fmtStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 收集摘要文本（启动器自身信息 + 版本与 Java 信息） */
function buildSummary(versionId: string): string {
  const s = getSettings()
  const last = getLastLaunch()
  const lines: string[] = [
    '================ KAMUCL 启动失败诊断摘要 ================',
    `导出时间: ${new Date().toLocaleString('zh-CN')}`,
    `启动器版本: ${app.getVersion()}`,
    `运行平台: ${process.platform} ${process.arch} / ${os.release()}`,
    `Electron: ${process.versions.electron ?? '-'} / Node: ${process.versions.node ?? '-'}`,
    '',
    '---------------- 最近一次启动 ----------------',
    `版本: ${last?.versionId ?? versionId ?? '（未知）'}`,
    `Java: ${last?.javaPath ?? '（未知）'}`,
    `启动时间: ${last?.startedAt ?? '-'}`,
    '',
    '---------------- 启动器设置（节选） ----------------',
    `游戏目录: ${s.gameDir}`,
    `内存上限: ${s.memoryMB} MB`,
    `下载源: ${s.mirror === 'bmclapi' ? 'BMCLAPI 镜像' : '官方源'}`,
    `Java 自动管理: ${s.javaAuto ? '开' : '关'}`,
    `手动指定 Java: ${s.javaPath || '（未指定）'}`,
    ''
  ]
  try {
    const javas = scanJava()
    lines.push('---------------- 本机已识别 Java ----------------')
    for (const j of javas) lines.push(`Java ${j.major}（${j.version}）${j.is64Bit ? '64位' : '32位'} · ${j.path}`)
    lines.push('')
  } catch {
    /* 扫描失败不影响导出 */
  }
  try {
    const installed = listInstalled()
    lines.push('---------------- 已安装版本 ----------------')
    for (const v of installed) {
      lines.push(
        `${v.id}（MC ${v.mcVersion}${v.loader ? ` · ${v.loader} ${v.loaderVersion ?? ''}` : ''}${v.failed ? ' · 安装失败' : ''}${v.incomplete ? ' · 下载未完成' : ''}）`
      )
    }
  } catch {
    /* 列表失败不影响导出 */
  }
  return lines.join('\n')
}

/** 实例（或共享）游戏目录下的 crash-reports 最新两份 */
function collectCrashReports(versionId: string): string[] {
  const dirs: string[] = []
  try {
    const isolated = versionId && readVersionJson(versionId)._gameDir === true
    dirs.push(path.join(isolated ? versionDir(versionId) : gameDir(), 'crash-reports'))
  } catch {
    dirs.push(path.join(gameDir(), 'crash-reports'))
  }
  const out: Array<{ file: string; mtime: number }> = []
  for (const d of dirs) {
    try {
      for (const f of fs.readdirSync(d)) {
        if (!f.endsWith('.txt') && !f.endsWith('.log')) continue
        const fp = path.join(d, f)
        out.push({ file: fp, mtime: fs.statSync(fp).mtimeMs })
      }
    } catch {
      /* 目录不存在 */
    }
  }
  return out
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 2)
    .map((x) => x.file)
}

/** 弹保存对话框并导出日志包；返回保存路径（取消 = null） */
export async function exportLaunchLogs(
  win: BrowserWindow | null,
  versionId: string
): Promise<string | null> {
  const vid = versionId || getLastLaunch()?.versionId || 'unknown'
  const defName = `KAMUCL-错误日志-${vid}-${fmtStamp(new Date())}.zip`
  const opts = {
    title: '导出错误日志',
    defaultPath: defName,
    filters: [{ name: '压缩包', extensions: ['zip'] }]
  }
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  if (r.canceled || !r.filePath) return null
  const dest = r.filePath

  const zip = new yazl.ZipFile()
  // 1. 启动日志 latest.log（含完整启动命令与游戏输出）
  const latestLog = path.join(gameDir(), 'kamucl-logs', 'latest.log')
  if (fs.existsSync(latestLog)) zip.addFile(latestLog, 'latest.log')
  // 2. 最近的 crash-report
  for (const f of collectCrashReports(vid)) {
    zip.addFile(f, `crash-reports/${path.basename(f)}`)
  }
  // 3. 诊断摘要（启动器自身信息 + 版本与 Java 信息）
  zip.addBuffer(Buffer.from(buildSummary(vid), 'utf-8'), '诊断摘要.txt')

  await new Promise<void>((resolve, reject) => {
    const ws = fs.createWriteStream(dest)
    ws.on('close', resolve)
    ws.on('error', reject)
    zip.outputStream.pipe(ws)
    zip.end()
  })
  return dest
}
