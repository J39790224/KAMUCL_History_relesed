/**
 * 渲染进程对 preload 桥接（window.kamucl）的类型化封装。
 * 所有 IPC 通道名一律取自 @shared/types 的 IPC / IPC_EVENT 常量。
 */
import { IPC, IPC_EVENT } from '@shared/types'
import type {
  Account,
  CommunityFile,
  CommunityKind,
  CommunityQuery,
  CommunityResult,
  CommunitySource,
  FabricApiVersion,
  FsEntry,
  GameFolder,
  InstallOptions,
  InstalledVersion,
  JavaInfo,
  LaunchState,
  LoaderName,
  ModCrossDuplicate,
  ModDuplicateGroup,
  ModInfo,
  ModInstallResult,
  ModpackInfo,
  MsDeviceCodeInfo,
  ProgressEvent,
  ProfileSkins,
  RemoteVersion,
  ServerEntry,
  ServerPingResult,
  Settings,
  SkinHistoryEntry,
  SkinVariant
} from '@shared/types'

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  // Vue 的 reactive proxy 无法通过 Electron IPC 结构化克隆（报 An object could not be cloned）。
  // 所有参数统一 JSON 深净化（undefined 原样保留），根治各调用点。
  const clean = args.map((a) => {
    if (a === undefined || a === null) return a
    try {
      return JSON.parse(JSON.stringify(a)) as unknown
    } catch {
      return a
    }
  })
  return window.kamucl.invoke(channel, ...clean) as Promise<T>
}

// ---------------- 设置 ----------------
export const getSettings = () => invoke<Settings>(IPC.settingsGet)
/**
 * 保存设置。Vue 的 reactive proxy 无法通过 IPC 结构化克隆，
 * 发送前用 JSON 深拷贝净化（同时剥掉一切不可序列化内容）。
 */
export const saveSettings = (patch: Partial<Settings>) =>
  invoke<Settings>(IPC.settingsSet, JSON.parse(JSON.stringify(patch)) as Partial<Settings>)
export const selectDir = () => invoke<string | null>(IPC.appSelectDir)
export const selectImage = () => invoke<string | null>(IPC.appSelectImage)
/** 游戏目录迁移（异步）；结束经 onGameDirDone 回调 */
export const migrateGameDir = (newDir: string, migrate: boolean) =>
  invoke<void>(IPC.gameDirMigrate, newDir, migrate)
export const onGameDirDone = (
  cb: (r: { ok: boolean; error?: string; gameDir?: string }) => void
) =>
  subscribe<{ ok: boolean; error?: string; gameDir?: string }>(IPC_EVENT.gameDirDone, cb)
/** 选择整合包文件（.mrpack/.zip），取消返回 null */
export const selectFile = () => invoke<string | null>(IPC.appSelectFile)

// ---------------- 账号 ----------------
export const listAccounts = () => invoke<Account[]>(IPC.accountsList)
export const addOfflineAccount = (username: string) => invoke<Account>(IPC.accountsAddOffline, username)
export const removeAccount = (id: string) => invoke<Account[]>(IPC.accountsRemove, id)
export const selectAccount = (id: string) => invoke<Account | null>(IPC.accountsSelect, id)
export const getSelectedAccount = () => invoke<Account | null>(IPC.accountsSelected)
export const msBeginLogin = () => invoke<MsDeviceCodeInfo>(IPC.accountsMsBegin)
export const msCancelLogin = () => invoke<void>(IPC.accountsMsCancel)

// ---------------- 版本 ----------------
export const getManifest = (refresh = false) => invoke<RemoteVersion[]>(IPC.versionsManifest, refresh)
export const getInstalled = () => invoke<InstalledVersion[]>(IPC.versionsInstalled)
export const installVersion = (id: string, opts?: InstallOptions) =>
  invoke<void>(IPC.versionsInstall, id, opts)
export const removeVersion = (id: string) => invoke<void>(IPC.versionsRemove, id)
export const renameVersion = (id: string, newName: string) =>
  invoke<void>(IPC.versionsRename, id, newName)
export const setVersionJava = (id: string, javaPath: string) =>
  invoke<void>(IPC.versionsSetJava, id, javaPath)
export const cleanupPartialInstall = (id: string) =>
  invoke<boolean>(IPC.versionsCleanup, id)

// ---------------- 游戏文件夹管理 ----------------
export const listFolders = () =>
  invoke<{ folders: GameFolder[]; active: string }>(IPC.foldersList)
export const addFolder = (path: string) => invoke<GameFolder[]>(IPC.foldersAdd, path)
export const removeFolder = (path: string) => invoke<GameFolder[]>(IPC.foldersRemove, path)
export const setDefaultFolder = (path: string) =>
  invoke<GameFolder[]>(IPC.foldersSetDefault, path)
export const setActiveFolder = (path: string) => invoke<void>(IPC.foldersSetActive, path)
export const setVersionIsolation = (id: string, isolated: boolean) =>
  invoke<void>(IPC.versionsSetIsolation, id, isolated)
/** 设置实例图标（'mob:<id>' / 'file:<文件名>' / '' 恢复默认） */
export const setVersionIcon = (id: string, icon: string) =>
  invoke<void>(IPC.versionsSetIcon, id, icon)
/** 上传自定义实例图标，返回新 icon 值（取消 = null） */
export const uploadVersionIcon = (id: string) =>
  invoke<string | null>(IPC.versionsUploadIcon, id)
export const listLoaders = (loader: LoaderName, mc: string) =>
  invoke<string[]>(IPC.loadersList, loader, mc)
export const listFabricApi = (mc: string) => invoke<FabricApiVersion[]>(IPC.fabricApiList, mc)

// ---------------- 整合包 ----------------
/** 只解析整合包元信息（不解压不下载），供导入确认弹窗展示；失败抛错 */
export const probeModpack = (filePath: string) => invoke<ModpackInfo>(IPC.modpackProbe, filePath)
/** 异步安装整合包：invoke 仅表示任务已受理，完成/失败由 onInstallDone 推送 */
export const installModpack = (filePath: string, opts?: { nameSource?: 'file' | 'inner' }) =>
  invoke<void>(IPC.modpackInstall, filePath, opts)

// ---------------- 社区资源 ----------------
/** 搜索 Modrinth / CurseForge 社区资源 */
export const communitySearch = (q: CommunityQuery) =>
  invoke<CommunityResult[]>(IPC.communitySearch, q)
/** 项目文件版本列表（可按 mc 版本/加载器过滤） */
export const communityFiles = (
  source: CommunitySource,
  projectId: string,
  filter?: { mcVersion?: string; loader?: LoaderName | '' }
) => invoke<CommunityFile[]>(IPC.communityFiles, source, projectId, filter)
/** 下载资源文件，返回保存路径；kind=modpack 时自动进入整合包安装流程 */
export const communityDownload = (
  file: CommunityFile,
  target: { versionId: string; kind: CommunityKind }
) => invoke<string>(IPC.communityDownload, file, target)

// ---------------- Java ----------------
export const listJava = () => invoke<JavaInfo[]>(IPC.javaList)
export const refreshJava = () => invoke<JavaInfo[]>(IPC.javaRefresh)
export const addCustomJava = (path: string) => invoke<void>(IPC.javaAddCustom, path)
export const hideJava = (path: string) => invoke<void>(IPC.javaHide, path)

// ---------------- 皮肤/披风 ----------------
/** 当前微软账号的皮肤/披风档案 */
export const getSkinProfile = () => invoke<ProfileSkins>(IPC.skinProfile)
/** 上传皮肤（64×64 PNG），返回最新档案 */
export const uploadSkin = (filePath: string, variant: SkinVariant) =>
  invoke<ProfileSkins>(IPC.skinUpload, filePath, variant)
/** 激活披风（传 id）/ 卸下披风（传 null），返回最新档案 */
export const changeCape = (capeId: string | null) => invoke<ProfileSkins>(IPC.skinCape, capeId)
/** 历史皮肤（含 dataUrl 缩略图，新→旧） */
export const getSkinHistory = () => invoke<SkinHistoryEntry[]>(IPC.skinHistory)
/** 删除一条历史，返回最新列表 */
export const deleteSkinHistory = (id: string) =>
  invoke<SkinHistoryEntry[]>(IPC.skinHistoryDelete, id)
/** 用历史记录快速换回，返回最新档案 */
export const uploadSkinFromHistory = (id: string) =>
  invoke<ProfileSkins>(IPC.skinUploadHistory, id)
/** 当前选中账号的头像数据（微软=皮肤 dataURL / 离线=minotar 头像 dataURL / 无=null） */
export const getSkinAvatar = () => invoke<string | null>(IPC.skinAvatar)

// ---------------- 游戏 ----------------
export const launchGame = (id: string, serverAddress?: string) =>
  invoke<void>(IPC.gameLaunch, id, serverAddress)
export const killGame = () => invoke<void>(IPC.gameKill)

// ---------------- 服务器 ----------------
export const listServers = () => invoke<ServerEntry[]>(IPC.serversList)
export const addServer = (name: string, address: string) =>
  invoke<ServerEntry[]>(IPC.serversAdd, name, address)
export const removeServer = (id: string) => invoke<ServerEntry[]>(IPC.serversRemove, id)
export const pingServer = (address: string) =>
  invoke<ServerPingResult>(IPC.serversPing, address)
export const bindServer = (id: string, versionId: string) =>
  invoke<ServerEntry[]>(IPC.serversBind, id, versionId)
export const syncServersFromDat = () =>
  invoke<{ list: ServerEntry[]; added: number }>(IPC.serversSyncFromDat)

// ---------------- MOD 拖入即装 ----------------
export const parseMods = (paths: string[]) => invoke<ModInfo[]>(IPC.modsParse, paths)
export const installMods = (files: string[], targetVersionId: string) =>
  invoke<ModInstallResult[]>(IPC.modsInstall, files, targetVersionId)
export const findModDuplicates = (versionId: string) =>
  invoke<ModDuplicateGroup[]>(IPC.modsDuplicates, versionId)
export const findModCrossDuplicates = (versionIds: string[]) =>
  invoke<ModCrossDuplicate[]>(IPC.modsCrossDuplicates, versionIds)

// ---------------- 文件/目录 ----------------
/** 用系统资源管理器打开游戏目录下的子目录（'' = 游戏根目录） */
export const openDir = (rel = '') => invoke<void>(IPC.appOpenDir, rel)
/** 列出游戏目录下某个子目录的文件 */
export const listFs = (rel: string) => invoke<FsEntry[]>(IPC.fsList, rel)
/** 删除游戏目录下某个子目录中的文件，返回删除后的列表 */
export const removeFs = (rel: string, name: string) => invoke<FsEntry[]>(IPC.fsRemove, rel, name)

// ---------------- 事件订阅（返回取消函数） ----------------
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  return window.kamucl.on(channel, (payload) => cb(payload as T))
}

export const onProgress = (cb: (e: ProgressEvent) => void) =>
  subscribe<ProgressEvent>(IPC_EVENT.progress, cb)
export const onLaunchLog = (cb: (line: string) => void) =>
  subscribe<string>(IPC_EVENT.launchLog, cb)
export const onLaunchState = (cb: (s: LaunchState) => void) =>
  subscribe<LaunchState>(IPC_EVENT.launchState, cb)
export const onMsLoginDone = (cb: (account: Account | null) => void) =>
  subscribe<Account | null>(IPC_EVENT.msLoginDone, cb)
export const onInstallDone = (
  cb: (r: { versionId: string; installedId?: string; ok: boolean; error?: string }) => void
) =>
  subscribe<{ versionId: string; installedId?: string; ok: boolean; error?: string }>(
    IPC_EVENT.installDone,
    cb
  )

// ---------------- 工具 ----------------
/** 把 invoke 抛出的错误转成适合 toast 展示的短文本 */
export function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '') || '未知错误'
}

/** 复制文本到剪贴板（带降级方案），返回是否成功 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

/** 字节/秒 → 人类可读速度 */
export function formatSpeed(bytes?: number): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes.toFixed(0)} B/s`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB/s`
}
