/**
 * IPC 注册：types.ts 中 IPC 常量的全部通道
 * 事件统一通过 getWin()?.webContents.send(IPC_EVENT.xxx, payload) 推送
 */
import { ipcMain, dialog, shell, type BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { IPC, IPC_EVENT } from '../shared/types'
import type {
  CommunityFile,
  CommunityKind,
  CommunityQuery,
  CommunitySource,
  FsEntry,
  InstallOptions,
  LaunchState,
  LoaderName,
  ProgressEvent,
  Settings,
  SkinVariant
} from '../shared/types'
import * as settings from './core/settings'
import * as accounts from './core/accounts'
import * as versions from './core/versions'
import * as loaders from './core/loaders'
import * as java from './core/java'
import * as launch from './core/launch'
import * as servers from './core/servers'
import * as modpacks from './core/modpacks'
import * as skins from './core/skins'
import * as community from './core/community'

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function registerIpc(getWin: () => BrowserWindow | null): void {
  const send = (channel: string, payload: unknown): void => {
    getWin()?.webContents.send(channel, payload)
  }
  /** 统一进度回调 */
  const emit = (e: ProgressEvent): void => send(IPC_EVENT.progress, e)
  const sendState = (s: LaunchState): void => send(IPC_EVENT.launchState, s)

  // ---------------- 设置 ----------------
  ipcMain.handle(IPC.settingsGet, () => settings.getSettings())
  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<Settings>) => settings.saveSettings(patch))
  ipcMain.handle(IPC.appSelectDir, async () => {
    const win = getWin()
    const opts = { properties: ['openDirectory' as const], title: '选择游戏目录' }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  ipcMain.handle(IPC.appSelectFile, async () => {
    const win = getWin()
    const opts = {
      properties: ['openFile' as const],
      title: '选择整合包',
      filters: [{ name: '整合包', extensions: ['mrpack', 'zip'] }]
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })

  // ---------------- 账号 ----------------
  ipcMain.handle(IPC.accountsList, () => accounts.listAccounts())
  ipcMain.handle(IPC.accountsAddOffline, (_e, username: string) =>
    accounts.addOffline(String(username ?? ''))
  )
  ipcMain.handle(IPC.accountsRemove, (_e, id: string) => accounts.removeAccount(id))
  ipcMain.handle(IPC.accountsSelect, (_e, id: string) => accounts.selectAccount(id))
  ipcMain.handle(IPC.accountsSelected, () => accounts.selectedAccount())
  ipcMain.handle(IPC.accountsMsBegin, () =>
    accounts.beginMsDeviceCode((account) => send(IPC_EVENT.msLoginDone, account))
  )
  ipcMain.handle(IPC.accountsMsCancel, () => accounts.cancelMsLogin())

  // ---------------- 版本 ----------------
  ipcMain.handle(IPC.versionsManifest, (_e, refresh?: boolean) =>
    versions.fetchVersionManifest(settings.getSettings().mirror, refresh === true)
  )
  ipcMain.handle(IPC.versionsInstalled, () => versions.listInstalled())
  // 异步执行，不阻塞返回；进度经 event:progress 推送，结束经 event:installDone 推送
  ipcMain.handle(IPC.versionsInstall, (_e, versionId: string, opts?: InstallOptions) => {
    void versions
      .installVersion(versionId, opts ?? {}, emit)
      .then(() => send(IPC_EVENT.installDone, { versionId, ok: true }))
      .catch((err) => {
        const text = errText(err)
        emit({ stage: 'error', progress: 0, text: `安装失败: ${text}` })
        send(IPC_EVENT.installDone, { versionId, ok: false, error: text })
      })
  })
  ipcMain.handle(IPC.versionsRemove, (_e, versionId: string) => versions.removeVersion(versionId))
  ipcMain.handle(IPC.versionsSetIsolation, (_e, versionId: string, isolated: boolean) =>
    versions.setIsolation(String(versionId ?? ''), isolated === true)
  )
  ipcMain.handle(IPC.loadersList, (_e, loader: LoaderName, mcVersion: string) =>
    loaders.listLoaderVersions(loader, mcVersion)
  )
  ipcMain.handle(IPC.fabricApiList, (_e, mcVersion: string) =>
    loaders.listFabricApiVersions(String(mcVersion ?? ''))
  )

  // ---------------- 整合包 ----------------
  // 只解析不安装：导入确认弹窗展示包信息用
  ipcMain.handle(IPC.modpackProbe, (_e, filePath: string) =>
    modpacks.probeModpack(String(filePath ?? ''))
  )
  // 异步执行，不阻塞返回；进度经 event:progress 推送，结束经 event:installDone 推送（versionId = 实例 id）
  ipcMain.handle(
    IPC.modpackInstall,
    (_e, filePath: string, opts?: { nameSource?: 'file' | 'inner' }) => {
      const clean: modpacks.ModpackInstallOpts = {
        nameSource: opts?.nameSource === 'inner' ? 'inner' : 'file'
      }
      void modpacks
        .installModpack(String(filePath ?? ''), emit, clean)
        .then((id) => send(IPC_EVENT.installDone, { versionId: id, ok: true }))
        .catch((err) => {
          const text = errText(err)
          emit({ stage: 'error', progress: 0, text: `整合包安装失败: ${text}` })
          send(IPC_EVENT.installDone, { versionId: '', ok: false, error: text })
        })
    }
  )

  // ---------------- 社区资源（同步 await 返回，错误 reject 给前端） ----------------
  ipcMain.handle(IPC.communitySearch, (_e, q: CommunityQuery) => community.communitySearch(q))
  ipcMain.handle(
    IPC.communityFiles,
    (_e, source: CommunitySource, projectId: string, filter?: { mcVersion?: string; loader?: LoaderName | '' }) =>
      community.communityFiles(source, String(projectId ?? ''), filter)
  )
  ipcMain.handle(
    IPC.communityDownload,
    (_e, file: CommunityFile, target: { versionId: string; kind: CommunityKind }) =>
      community.communityDownload(file, target, emit, (r) => send(IPC_EVENT.installDone, r))
  )

  // ---------------- Java ----------------
  ipcMain.handle(IPC.javaList, () => java.scanJava())

  // ---------------- 皮肤/披风（同步 await 返回，错误经 invoke reject 给前端） ----------------
  ipcMain.handle(IPC.skinProfile, () => skins.getProfile())
  ipcMain.handle(IPC.skinUpload, (_e, filePath: string, variant: SkinVariant) =>
    skins.uploadSkin(String(filePath ?? ''), variant)
  )
  ipcMain.handle(IPC.skinCape, (_e, capeId: string | null) => skins.changeCape(capeId ?? null))
  ipcMain.handle(IPC.skinHistory, () => skins.history())
  ipcMain.handle(IPC.skinHistoryDelete, (_e, id: string) =>
    skins.historyDelete(String(id ?? ''))
  )
  ipcMain.handle(IPC.skinUploadHistory, (_e, id: string) =>
    skins.uploadHistory(String(id ?? ''))
  )
  ipcMain.handle(IPC.skinAvatar, () => skins.getAvatar())

  // ---------------- 游戏 ----------------
  // 异步执行；开始发 launching，退出/错误经 event:launchState 推送
  ipcMain.handle(IPC.gameLaunch, (_e, versionId: string, serverAddress?: string) => {
    sendState({ status: 'launching', text: '正在准备启动…' })
    void launch
      .launch(
        versionId,
        emit,
        (line) => send(IPC_EVENT.launchLog, line),
        (s) => {
          sendState(s)
          // 设置项生效：游戏成功进入运行状态后关闭启动器窗口
          if (s.status === 'running' && settings.getSettings().closeAfterLaunch) {
            setTimeout(() => getWin()?.close(), 1500)
          }
        },
        serverAddress ? String(serverAddress) : undefined
      )
      .catch((err) => sendState({ status: 'error', text: errText(err) }))
  })
  ipcMain.handle(IPC.gameKill, () => launch.killGame())

  // ---------------- 服务器 ----------------
  ipcMain.handle(IPC.serversList, () => servers.listServers())
  ipcMain.handle(IPC.serversAdd, (_e, name: string, address: string) =>
    servers.addServer(String(name ?? ''), String(address ?? ''))
  )
  ipcMain.handle(IPC.serversRemove, (_e, id: string) => servers.removeServer(String(id ?? '')))
  ipcMain.handle(IPC.serversPing, (_e, address: string) =>
    servers.pingServer(String(address ?? ''))
  )

  // ---------------- 文件/目录 ----------------
  const safeDir = (rel: string): string => {
    // 允许 gameDir 下最多两级子目录（如 versions/<id>），防目录穿越
    const parts = String(rel ?? '')
      .split(/[\\/]+/)
      .filter((s) => s && s !== '.')
    if (parts.some((s) => s === '..') || parts.length > 2) throw new Error('非法目录')
    const base = settings.getSettings().gameDir
    const dir = parts.length ? path.join(base, ...parts) : base
    if (!path.resolve(dir).startsWith(path.resolve(base))) throw new Error('非法目录')
    return dir
  }
  const listDir = (rel: string): FsEntry[] => {
    const dir = safeDir(rel)
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .map((d) => {
          try {
            const st = fs.statSync(path.join(dir, d.name))
            return { name: d.name, size: st.size, isDir: d.isDirectory(), mtime: st.mtimeMs }
          } catch {
            return { name: d.name, size: 0, isDir: d.isDirectory(), mtime: 0 }
          }
        })
        .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
    } catch {
      return []
    }
  }
  ipcMain.handle(IPC.appOpenDir, (_e, rel?: string) => {
    const dir = safeDir(String(rel ?? ''))
    fs.mkdirSync(dir, { recursive: true })
    void shell.openPath(dir)
  })
  ipcMain.handle(IPC.fsList, (_e, rel: string) => listDir(String(rel ?? '')))
  ipcMain.handle(IPC.fsRemove, (_e, rel: string, name: string) => {
    const dir = safeDir(String(rel ?? ''))
    const target = path.join(dir, path.basename(String(name ?? '')))
    fs.rmSync(target, { recursive: true, force: true })
    return listDir(String(rel ?? ''))
  })
}
