/**
 * IPC 注册：types.ts 中 IPC 常量的全部通道
 * 事件统一通过 getWin()?.webContents.send(IPC_EVENT.xxx, payload) 推送
 */
import { ipcMain, dialog, shell, type BrowserWindow } from 'electron'
import crypto from 'node:crypto'
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
import * as modinfo from './core/modinfo'
import * as gamedir from './core/gamedir'
import { folderOfVersion, instanceIconsDir, versionDir } from './core/paths'
import * as modpacks from './core/modpacks'
import * as skins from './core/skins'
import * as community from './core/community'
import { registerTask, cancelTask, finishTask, isCancelError } from './core/tasks'

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
  ipcMain.handle(IPC.appSelectImage, async () => {
    const win = getWin()
    const opts = {
      properties: ['openFile' as const],
      title: '选择背景图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
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
  // 异步执行，不阻塞返回；进度经 event:progress（带 taskId）推送，结束经 event:installDone 推送
  ipcMain.handle(IPC.versionsInstall, (_e, versionId: string, opts?: InstallOptions) => {
    const vid = String(versionId ?? '')
      const task = registerTask(`安装版本 ${vid}${opts?.loader ? ` + ${opts.loader}` : ''}`, 'version')
      let lastStage = ''
      const taskEmit = (e: ProgressEvent): void => {
        lastStage = e.stage
        emit({ ...e, taskId: task.id, taskTitle: task.title })
      }
      const taskDone = (ok: boolean, error?: string, cancelled = false): void =>
        send(IPC_EVENT.taskDone, { taskId: task.id, ok, error, cancelled, stage: ok ? undefined : lastStage })
      void versions
        .installVersion(vid, opts ?? {}, taskEmit, task.controller.signal)
        .then((installedId) => {
          // 设置项生效：新版本默认开启版本隔离（整合包实例本身强制隔离，无需处理）
          try {
            if (settings.getSettings().defaultIsolation) {
              versions.setIsolation(installedId, true)
            }
          } catch (e) {
            console.error('[KAMUCL] 默认隔离设置失败:', e)
          }
          taskDone(true)
          send(IPC_EVENT.installDone, { versionId: vid, installedId, ok: true, taskId: task.id })
        })
        .catch((err) => {
          const cancelled = isCancelError(err)
          const text = cancelled ? '已取消' : errText(err)
          if (!cancelled) taskEmit({ stage: 'error', progress: 0, text: `安装失败: ${text}` })
          // 事务清理：删除安装失败产生的文件（.installing 标记在则目录是失败产物）
          try {
            versions.cleanupPartialInstall(vid)
            // 加载器实例目录（若已生成）一并清理
            const installed = versions.listInstalled()
            for (const v of installed) {
              if (v.failed) versions.cleanupPartialInstall(v.id)
            }
          } catch {
            /* 清理失败不阻断错误上报 */
          }
          taskDone(false, text, cancelled)
          send(IPC_EVENT.installDone, {
            versionId: vid,
            ok: false,
            error: text,
            taskId: task.id,
            cancelled,
            stage: lastStage
          })
        })
        .finally(() => finishTask(task.id))
    })
  // 取消进行中的后台任务（版本安装/整合包导入/资源下载）
  ipcMain.handle(IPC.tasksCancel, (_e, taskId: string) => cancelTask(String(taskId ?? '')))
  ipcMain.handle(IPC.versionsRemove, (_e, versionId: string) => versions.removeVersion(versionId))
  ipcMain.handle(IPC.versionsRename, (_e, id: string, newName: string) => {
    const vid = String(id ?? '')
    const name = String(newName ?? '').trim()
    // 前置校验：游戏运行中禁止改名（文件夹句柄被占用，且引用会错乱）
    if (launch.getRunningVersionId() === vid) {
      throw new Error('该版本正在运行中，请先退出游戏再改名')
    }
    versions.renameVersion(vid, name)
    // 引用同步：收藏列表
    const s = settings.getSettings()
    if (s.favoriteVersions.includes(vid)) {
      settings.saveSettings({
        favoriteVersions: s.favoriteVersions.map((x) => (x === vid ? name : x))
      })
    }
    // 引用同步：服务器绑定（隔离实例的 servers.dat 随目录迁移，无需额外处理）
    servers.renameBinding(vid, name)
  })
  ipcMain.handle(IPC.versionsCleanup, (_e, id: string) =>
    versions.cleanupPartialInstall(String(id ?? ''))
  )

  // ---------------- 游戏文件夹管理 ----------------
  ipcMain.handle(IPC.foldersList, () => {
    const s = settings.getSettings()
    return { folders: s.folders, active: s.activeFolder }
  })
  ipcMain.handle(IPC.foldersAdd, (_e, p: string) => {
    const dir = path.resolve(String(p ?? ''))
    if (!fs.existsSync(dir)) throw new Error('文件夹不存在')
    const s = settings.getSettings()
    if (s.folders.some((f) => path.resolve(f.path) === dir)) return s.folders
    return settings.saveSettings({
      folders: [...s.folders, { path: dir, name: path.basename(dir), isDefault: false }]
    }).folders
  })
  ipcMain.handle(IPC.foldersRemove, (_e, p: string) => {
    const dir = path.resolve(String(p ?? ''))
    const s = settings.getSettings()
    const target = s.folders.find((f) => path.resolve(f.path) === dir)
    if (target?.isDefault) throw new Error('默认文件夹不可移除（请先设其他文件夹为默认）')
    return settings.saveSettings({
      folders: s.folders.filter((f) => path.resolve(f.path) !== dir)
    }).folders
  })
  ipcMain.handle(IPC.foldersSetDefault, (_e, p: string) => {
    const dir = path.resolve(String(p ?? ''))
    const s = settings.getSettings()
    return settings.saveSettings({
      folders: s.folders.map((f) => ({ ...f, isDefault: path.resolve(f.path) === dir }))
    }).folders
  })
  ipcMain.handle(IPC.foldersSetActive, (_e, p: string) => {
    const dir = path.resolve(String(p ?? ''))
    const s = settings.getSettings()
    if (!s.folders.some((f) => path.resolve(f.path) === dir)) throw new Error('文件夹未登记')
    settings.saveSettings({ activeFolder: dir, gameDir: dir })
  })
  ipcMain.handle(IPC.versionsSetJava, (_e, id: string, javaPath: string) =>
    versions.setVersionJava(String(id ?? ''), String(javaPath ?? ''))
  )
  ipcMain.handle(IPC.versionsSetIcon, (_e, id: string, icon: string) =>
    versions.setVersionIcon(String(id ?? ''), String(icon ?? ''))
  )
  // 上传自定义图标：弹窗选图 → 校验类型/大小 → 复制进 .kamucl/icons 并写入版本 json
  ipcMain.handle(IPC.versionsUploadIcon, async (_e, id: string) => {
    const vid = String(id ?? '')
    const win = getWin()
    const opts = {
      title: '选择实例图标',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
      properties: ['openFile' as const]
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return null
    const src = r.filePaths[0]
    const st = fs.statSync(src)
    if (st.size > 5 * 1024 * 1024) throw new Error('图片过大（最大 5MB）')
    const ext = path.extname(src).toLowerCase() || '.png'
    const name = `${crypto.randomUUID()}${ext}`
    fs.mkdirSync(instanceIconsDir(), { recursive: true })
    fs.copyFileSync(src, path.join(instanceIconsDir(), name))
    const icon = `file:${name}`
    versions.setVersionIcon(vid, icon)
    return icon
  })
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
  // 异步执行，不阻塞返回；进度经 event:progress（带 taskId）推送，结束经 event:installDone 推送（versionId = 实例 id）
  ipcMain.handle(
    IPC.modpackInstall,
    (_e, filePath: string, opts?: { nameSource?: 'file' | 'inner' }) => {
      const fp = String(filePath ?? '')
      const clean: modpacks.ModpackInstallOpts = {
        nameSource: opts?.nameSource === 'inner' ? 'inner' : 'file'
      }
      const task = registerTask(`导入整合包 ${path.basename(fp)}`, 'modpack')
      clean.signal = task.controller.signal
      let lastStage = ''
      const taskEmit = (e: ProgressEvent): void => {
        lastStage = e.stage
        emit({ ...e, taskId: task.id, taskTitle: task.title })
      }
      void modpacks
        .installModpack(fp, taskEmit, clean)
        .then((id) => {
          send(IPC_EVENT.taskDone, { taskId: task.id, ok: true })
          send(IPC_EVENT.installDone, { versionId: id, ok: true, taskId: task.id })
        })
        .catch((err) => {
          const cancelled = isCancelError(err)
          const text = cancelled ? '已取消' : errText(err)
          if (!cancelled) taskEmit({ stage: 'error', progress: 0, text: `整合包安装失败: ${text}` })
          send(IPC_EVENT.taskDone, { taskId: task.id, ok: false, error: text, cancelled, stage: lastStage })
          send(IPC_EVENT.installDone, {
            versionId: '',
            ok: false,
            error: text,
            taskId: task.id,
            cancelled,
            stage: lastStage
          })
        })
        .finally(() => finishTask(task.id))
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
    async (_e, file: CommunityFile, target: { versionId: string; kind: CommunityKind }) => {
      const task = registerTask(`下载 ${file.fileName ?? '资源'}`, 'download')
      let lastStage = ''
      const taskEmit = (e: ProgressEvent): void => {
        lastStage = e.stage
        emit({ ...e, taskId: task.id, taskTitle: task.title })
      }
      try {
        const r = await community.communityDownload(file, target, taskEmit, (done) => {
          const cancelled = done.error === '已取消'
          send(IPC_EVENT.taskDone, {
            taskId: task.id,
            ok: done.ok,
            error: done.error,
            cancelled,
            stage: done.ok ? undefined : lastStage
          })
          send(IPC_EVENT.installDone, {
            ...done,
            taskId: task.id,
            cancelled,
            stage: done.ok ? undefined : lastStage
          })
          finishTask(task.id)
        }, task.controller.signal)
        // 非整合包：invoke 返回即完成；整合包：完成回调在后台安装结束时触发
        if (target.kind === 'modpack') return r
        send(IPC_EVENT.taskDone, { taskId: task.id, ok: true })
        finishTask(task.id)
        return r
      } catch (err) {
        const cancelled = isCancelError(err)
        send(IPC_EVENT.taskDone, {
          taskId: task.id,
          ok: false,
          error: cancelled ? '已取消' : errText(err),
          cancelled,
          stage: lastStage
        })
        finishTask(task.id)
        throw err
      }
    }
  )

  // ---------------- Java ----------------
  ipcMain.handle(IPC.javaList, () => java.scanJava())
  ipcMain.handle(IPC.javaAddCustom, (_e, p: string) => java.addCustomJava(String(p ?? '')))
  // 文件选择器添加 Java：选完即真实执行 -version 校验，通过则入库并返回最新列表
  ipcMain.handle(IPC.javaPickAdd, async () => {
    const win = getWin()
    const isWin = process.platform === 'win32'
    const opts = {
      title: '选择 Java 可执行文件（java.exe / java）',
      filters: isWin
        ? [
            { name: 'Java 可执行文件', extensions: ['exe'] },
            { name: '所有文件', extensions: ['*'] }
          ]
        : [{ name: '所有文件', extensions: ['*'] }],
      properties: ['openFile' as const]
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return null
    java.addCustomJava(r.filePaths[0]) // 校验失败会抛出「这不是有效的 Java…」
    return java.scanJava()
  })
  ipcMain.handle(IPC.javaHide, (_e, p: string) => java.hideJava(String(p ?? '')))
  ipcMain.handle(IPC.javaRefresh, () => java.scanJava(true))

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

  // ---------------- 游戏目录迁移 ----------------
  ipcMain.handle(IPC.gameDirMigrate, (_e, newDir: string, migrate: boolean) => {
    void gamedir
      .migrateGameDir(String(newDir ?? ''), migrate === true, emit)
      .then((dir) => send(IPC_EVENT.gameDirDone, { ok: true, gameDir: dir }))
      .catch((err) => send(IPC_EVENT.gameDirDone, { ok: false, error: errText(err) }))
  })

  // ---------------- 服务器 ----------------
  ipcMain.handle(IPC.serversList, () => servers.listServers())
  ipcMain.handle(IPC.serversAdd, (_e, name: string, address: string) =>
    servers.addServer(String(name ?? ''), String(address ?? ''))
  )
  ipcMain.handle(IPC.serversRemove, (_e, id: string) => servers.removeServer(String(id ?? '')))
  ipcMain.handle(IPC.serversPing, (_e, address: string) =>
    servers.pingServer(String(address ?? ''))
  )
  ipcMain.handle(IPC.serversBind, (_e, id: string, versionId: string) =>
    servers.bindServer(String(id ?? ''), String(versionId ?? ''))
  )
  ipcMain.handle(IPC.serversSyncFromDat, () => servers.syncFromServersDat())

  // ---------------- MOD 拖入即装 ----------------
  ipcMain.handle(IPC.modsParse, (_e, paths: string[]) => {
    const { files, skipped } = modinfo.expandJarPaths(
      Array.isArray(paths) ? paths.map(String) : []
    )
    const list = files.map((f) => modinfo.parseModFile(f))
    // 非 jar 文件逐个给出原因，不静默吞掉
    for (const s of skipped) {
      list.push({
        filePath: s,
        fileName: s,
        id: '',
        name: '',
        version: '',
        loader: null,
        mcRange: '',
        dependencies: [],
        error: '不支持的文件类型（仅支持 .jar 或包含 .jar 的文件夹）'
      })
    }
    return list
  })
  ipcMain.handle(IPC.modsDuplicates, (_e, versionId: string) =>
    modinfo.findDuplicates(String(versionId ?? ''))
  )
  ipcMain.handle(IPC.modsCrossDuplicates, (_e, versionIds: string[]) =>
    modinfo.findCrossDuplicates(Array.isArray(versionIds) ? versionIds.map(String) : [])
  )

  ipcMain.handle(IPC.modsInstall, (_e, files: string[], targetVersionId: string) => {    const vid = String(targetVersionId ?? '')
    // 版本隔离时装入版本独立 mods 目录，否则共享目录
    let base = settings.getSettings().gameDir
    try {
      if (versions.readVersionJson(vid)._gameDir === true) base = versionDir(vid)
    } catch {
      /* json 读取失败按共享目录 */
    }
    const modsDir = path.join(base, 'mods')
    fs.mkdirSync(modsDir, { recursive: true })
    return (Array.isArray(files) ? files : []).map((f) => {
      const name = path.basename(String(f))
      try {
        fs.copyFileSync(String(f), path.join(modsDir, name))
        return { fileName: name, ok: true, message: '已装入' }
      } catch (e) {
        return { fileName: name, ok: false, message: errText(e) }
      }
    })
  })

  // ---------------- 文件/目录 ----------------
  const safeDir = (rel: string): string => {
    // 允许 gameDir 下单级子目录（mods 等）或 versions/<id>/<sub> 三级（版本实例目录），防目录穿越
    const parts = String(rel ?? '')
      .split(/[\\/]+/)
      .filter((s) => s && s !== '.')
    if (parts.some((s) => s === '..')) throw new Error('非法目录')
    const isVersionPath = parts[0] === 'versions'
    if (parts.length > (isVersionPath ? 3 : 2)) throw new Error('非法目录')
    // versions/<id> 前缀按版本所属文件夹寻址（多文件夹体系）；其余按当前活动文件夹
    const base = isVersionPath && parts.length >= 2 ? folderOfVersion(parts[1]) : settings.getSettings().gameDir
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
