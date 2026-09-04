/**
 * KAMUCL 前后端共享类型与 IPC 契约
 * 主进程 (src/main) 与渲染进程 (src/renderer) 都必须遵守本文件定义。
 */

// ---------------- 账号 ----------------
export type AccountType = 'offline' | 'microsoft'

export interface Account {
  id: string
  type: AccountType
  username: string
  uuid: string
  accessToken?: string
  /** 微软 OAuth refresh_token，用于静默续期 */
  refreshToken?: string
  /** MC accessToken 过期时间（epoch 秒） */
  expiresAt?: number
}

/** 微软 device code 登录开始时返回给前端的展示信息 */
export interface MsDeviceCodeInfo {
  userCode: string
  verificationUri: string
  message: string
}

// ---------------- 版本 ----------------
export interface RemoteVersion {
  id: string
  type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha'
  url: string
  releaseTime: string
}

// ---------------- 游戏文件夹 ----------------
export interface GameFolder {
  /** 绝对路径 */
  path: string
  /** 显示名（默认取目录名） */
  name: string
  /** 是否为默认文件夹（承接新安装版本；libraries/assets/runtimes 共享位置） */
  isDefault: boolean
}

export interface InstalledVersion {
  id: string
  /** 基于的原版版本（加载器版本等于对应 mc 版本） */
  mcVersion: string
  loader?: 'forge' | 'fabric' | 'quilt' | 'neoforge'
  loaderVersion?: string
  /** 整合包实例：来源整合包名称/版本（非整合包安装时为空） */
  modpackName?: string
  modpackVersion?: string
  /** 版本隔离：独立的 mods/存档/配置目录（versions/<id>/ 作为游戏目录） */
  isolated?: boolean
  /** 下载未完成的残缺版本（json 在但客户端 jar 缺失/有 .part 残留），不算正常已安装 */
  incomplete?: boolean
  /** 安装事务失败的标记（.installing 存在），提供清理残留入口 */
  failed?: boolean
  /** 版本独立指定的 Java 路径（空 = 自动匹配） */
  javaPath?: string
  /** 实例图标：'mob:<内置生物头像id>' | 'file:<自定义图标文件名>'（空 = 默认图标） */
  icon?: string
  /** 该版本所属的游戏文件夹路径 */
  folder: string
}

export type LoaderName = 'forge' | 'fabric' | 'quilt' | 'neoforge'

export interface InstallOptions {
  loader?: LoaderName
  loaderVersion?: string
  /** Fabric 专用：同时安装的 Fabric API 版本号（不传 = 不装） */
  fabricApi?: string
  /** 自定义实例名（作为 versions/<名> 目录名与版本 id）；不填按规则自动生成 */
  instanceName?: string
}

/** Fabric API 版本条目（来自 Modrinth） */
export interface FabricApiVersion {
  version: string
  date: string
}

// ---------------- Java ----------------
export interface JavaInfo {
  path: string
  /** 主版本号，如 8 / 17 / 21 */
  major: number
  version: string
  is64Bit: boolean
  /** 来源：自动扫描 / 手动添加 */
  source?: 'auto' | 'manual'
}

// ---------------- 设置 ----------------
export type ThemeName = 'light' | 'dark' | 'custom'

/** 自定义主题：模块化颜色 + 布局位置（theme === 'custom' 时生效） */
export interface CustomTheme {
  colors: {
    accent: string // 主色调（按钮/选中/链接）
    bg: string // 界面背景
    card: string // 卡片背景
    text: string // 主要文字
    textDim: string // 次要文字
    border: string // 边框
    sidebarBg: string // 侧栏背景
    sidebarText: string // 侧栏文字
    bannerText: string // Banner 上的文字
  }
  layout: {
    sidebarWidth: number // 侧栏宽度 px（200-300）
    bannerHeight: number // 首页 Banner 高度 px（220-420）
    radius: number // 全局圆角 px（0-24）
  }
}

export const DEFAULT_CUSTOM_THEME: CustomTheme = {
  colors: {
    accent: '#2563eb',
    bg: '#edf0f7',
    card: '#ffffff',
    text: '#1b2437',
    textDim: '#68718a',
    border: '#e1e6f0',
    sidebarBg: '#f5f7fb',
    sidebarText: '#1b2437',
    bannerText: '#ffffff'
  },
  layout: {
    sidebarWidth: 248,
    bannerHeight: 300,
    radius: 14
  }
}

/** 预设主题色板（选择后 theme='custom' 并套用对应配色） */
export const THEME_PRESETS: Record<string, { label: string; colors: CustomTheme['colors'] }> = {
  'pink-white': {
    label: '粉白',
    colors: {
      accent: '#ec4899',
      bg: '#fdf2f8',
      card: '#ffffff',
      text: '#4a1d35',
      textDim: '#a06b8a',
      border: '#fbcfe8',
      sidebarBg: '#fce7f3',
      sidebarText: '#4a1d35',
      bannerText: '#ffffff'
    }
  },
  'pink-black': {
    label: '粉黑',
    colors: {
      accent: '#f472b6',
      bg: '#171019',
      card: '#211623',
      text: '#f5e8f2',
      textDim: '#a68ba3',
      border: '#3d2740',
      sidebarBg: '#1c1220',
      sidebarText: '#a68ba3',
      bannerText: '#ffffff'
    }
  }
}

export interface Settings {
  gameDir: string
  /** 游戏文件夹登记列表（每个文件夹独立 versions/；libraries/assets/runtimes 共享于默认文件夹） */
  folders: GameFolder[]
  /** 当前活动文件夹（新安装版本与常规寻址目标） */
  activeFolder: string
  /** 指定 java 可执行文件路径；空字符串 = 自动 */
  javaPath: string
  /** Java 自动管理：自动检测版本所需 Java，缺失时自动下载（默认开启） */
  javaAuto: boolean
  /** 手动添加的 Java 路径（展示来源标注「手动」） */
  javaCustom: string[]
  /** 从扫描结果中隐藏的 Java 路径 */
  javaHidden: string[]
  memoryMB: number
  jvmArgs: string
  resolution: { width: number; height: number; fullscreen: boolean }
  mirror: 'official' | 'bmclapi'
  /** 新版本安装后默认开启版本隔离（独立游戏目录），可在设置中关闭 */
  defaultIsolation: boolean
  /** 微软登录用的 Azure 应用 client_id（device code flow） */
  msClientId: string
  theme: ThemeName
  /** theme === 'custom' 时使用的自定义配色与布局 */
  custom: CustomTheme
  /** 禁用的功能模块 key（mods/packs/shaders/servers/skins/community），关闭后侧栏入口隐藏 */
  disabledFeatures: string[]
  /** 收藏的版本 id 列表（各列表置顶） */
  favoriteVersions: string[]
  /** 首页布局：模块顺序与显隐（main=主列，side=右栏，数组顺序即渲染顺序） */
  homeLayout: HomeLayout
  /** 背景自定义 */
  background: BackgroundSettings
  closeAfterLaunch: boolean
}

// ---------------- 首页布局 ----------------
export interface HomeModule {
  key: string
  visible: boolean
}

export interface HomeLayout {
  /** 主列模块（欢迎横幅/启动日志/最近游戏） */
  main: HomeModule[]
  /** 右栏模块（账户信息/系统信息/快速操作/作者卡片） */
  side: HomeModule[]
}

export const DEFAULT_HOME_LAYOUT: HomeLayout = {
  main: [
    { key: 'banner', visible: true },
    { key: 'logDrawer', visible: true },
    { key: 'recentGames', visible: true }
  ],
  side: [
    { key: 'accountCard', visible: true },
    { key: 'sysInfo', visible: true },
    { key: 'quickActions', visible: true },
    { key: 'authorCard', visible: true }
  ]
}

export const HOME_MODULE_LABELS: Record<string, string> = {
  banner: '欢迎横幅',
  logDrawer: '启动日志',
  recentGames: '最近游戏',
  accountCard: '账户信息',
  sysInfo: '系统信息',
  quickActions: '快速操作',
  authorCard: '作者卡片'
}

// ---------------- 背景 ----------------
export interface BackgroundSettings {
  /** none=默认主题底色 / color=纯色 / image=本地图片 */
  mode: 'none' | 'color' | 'image'
  color: string
  /** 图片路径（userData 内复制的文件名） */
  image: string
  /** 0-1 背景层透明度 */
  opacity: number
  /** 0-40 模糊度 px */
  blur: number
}

export const DEFAULT_BACKGROUND: BackgroundSettings = {
  mode: 'none',
  color: '#1b2437',
  image: '',
  opacity: 0.5,
  blur: 0
}

// ---------------- 皮肤/披风 ----------------
export type SkinVariant = 'classic' | 'slim'

export interface SkinInfo {
  variant: SkinVariant
  url: string
  state?: string
  /** 主进程下载纹理转的 dataURL（前端渲染更稳，不受 CORS 影响） */
  dataUrl?: string
}

export interface CapeInfo {
  id: string
  alias: string
  active: boolean
  url?: string
  /** 披风纹理 dataURL */
  dataUrl?: string
}

/** 当前微软账号的皮肤档案 */
export interface ProfileSkins {
  username: string
  skins: SkinInfo[]
  capes: CapeInfo[]
}

export interface SkinHistoryItem {
  id: string
  variant: SkinVariant
  time: number
}

export interface SkinHistoryEntry extends SkinHistoryItem {
  dataUrl: string
}
export interface ProgressEvent {
  /** 当前阶段，如 'version-json' | 'client' | 'libraries' | 'assets' | 'java' | 'loader' */
  stage: string
  /** 0-1 */
  progress: number
  /** 人类可读描述 */
  text: string
  /** 字节/秒，可空 */
  speed?: number
  /** 当前下载源（BMCLAPI 镜像 / 官方源） */
  source?: string
  /** 所属后台任务 id（下载中心按任务聚合；无 = 全局进度条） */
  taskId?: string
  /** 任务展示名（随首条进度事件下发） */
  taskTitle?: string
}

export interface LaunchState {
  status: 'launching' | 'running' | 'exited' | 'error'
  text: string
  code?: number
}

// ---------------- IPC 通道（invoke: 前端 await 调用） ----------------
export const IPC = {
  // 设置
  settingsGet: 'settings:get',
  settingsSet: 'settings:set', // (patch: Partial<Settings>) => Settings
  appSelectDir: 'app:selectDir', // () => string | null
  appSelectFile: 'app:selectFile', // () => string | null  选择整合包文件（.mrpack/.zip）
  appSelectImage: 'app:selectImage', // () => string | null  选择图片文件（png/jpg/webp）

  // 账号
  accountsList: 'accounts:list', // () => Account[]
  accountsAddOffline: 'accounts:addOffline', // (username: string) => Account
  accountsRemove: 'accounts:remove', // (id: string) => Account[]
  accountsSelect: 'accounts:select', // (id: string) => Account | null
  accountsSelected: 'accounts:selected', // () => Account | null
  accountsMsBegin: 'accounts:msBegin', // () => MsDeviceCodeInfo  开始 device code 流程
  accountsMsCancel: 'accounts:msCancel', // () => void

  // 版本
  versionsManifest: 'versions:manifest', // (refresh?: boolean) => RemoteVersion[]
  versionsInstalled: 'versions:installed', // () => InstalledVersion[]
  versionsInstall: 'versions:install', // (versionId: string, opts?: InstallOptions) => void
  versionsRemove: 'versions:remove', // (versionId: string) => void
  versionsRename: 'versions:rename', // (id: string, newName: string) => void  重命名实例（目录+json id 同步改）
  versionsCleanup: 'versions:cleanup', // (id: string) => boolean  清理安装失败残留目录

  // 游戏文件夹管理
  foldersList: 'folders:list', // () => { folders: GameFolder[]; active: string }
  foldersAdd: 'folders:add', // (path: string) => GameFolder[]  添加已有文件夹（校验存在）
  foldersRemove: 'folders:remove', // (path: string) => GameFolder[]  移除登记（不删文件；默认文件夹不可移除）
  foldersSetDefault: 'folders:setDefault', // (path: string) => GameFolder[]
  foldersSetActive: 'folders:setActive', // (path: string) => void  切换活动文件夹（gameDir 跟随）
  versionsSetJava: 'versions:setJava', // (id: string, javaPath: string) => void  版本独立指定 Java（空串恢复自动匹配）
  versionsSetIsolation: 'versions:setIsolation', // (versionId: string, isolated: boolean) => void  版本隔离开关；开启时把共享目录的存档/mods/配置等复制进版本独立目录（已存在项不覆盖）

  versionsSetIcon: 'versions:setIcon', // (versionId: string, icon: string) => void  设置实例图标（'mob:<id>' / 'file:<文件名>' / '' 恢复默认）
  versionsUploadIcon: 'versions:uploadIcon', // (versionId: string) => string | null  弹窗选择图片并落地为自定义图标，返回新 icon 值（取消 = null）
  loadersList: 'loaders:list', // (loader: LoaderName, mcVersion: string) => string[]
  fabricApiList: 'loaders:fabricApi', // (mcVersion: string) => FabricApiVersion[]

  // Java
  javaList: 'java:list', // () => JavaInfo[]（5 分钟缓存）
  javaRefresh: 'java:refresh', // () => JavaInfo[]  强制重扫
  javaAddCustom: 'java:addCustom', // (path: string) => void  手动添加（校验 java -version）
  javaPickAdd: 'java:pickAdd', // () => JavaInfo[] | null  文件选择器选 java.exe 并校验入库（取消 = null）
  javaHide: 'java:hide', // (path: string) => void  从列表隐藏

  // 游戏
  gameLaunch: 'game:launch', // (versionId: string, serverAddress?: string) => void  带 serverAddress 时用 --quickPlayMultiplayer 直接进服
  gameKill: 'game:kill', // () => void

  // 游戏目录迁移
  gameDirMigrate: 'gameDir:migrate', // (newDir: string, migrate: boolean) => void  异步：进度走 event:progress（stage=migrate），结束走 event:gameDirDone

  // 服务器（SLP 协议 ping）
  serversList: 'servers:list', // () => ServerEntry[]
  serversAdd: 'servers:add', // (name: string, address: string) => ServerEntry[]
  serversRemove: 'servers:remove', // (id: string) => ServerEntry[]
  serversPing: 'servers:ping', // (address: string) => ServerPingResult  6 秒超时
  serversBind: 'servers:bind', // (id: string, versionId: string) => ServerEntry[]  绑定/解绑版本（空串解绑）
  serversSyncFromDat: 'servers:syncFromDat', // () => { list: ServerEntry[]; added: number }  从各版本 servers.dat 合并

  // MOD 拖入即装
  modsParse: 'mods:parse', // (paths: string[]) => ModInfo[]  支持文件/文件夹路径，静默解析元数据
  modsInstall: 'mods:install', // (files: string[], targetVersionId: string) => ModInstallResult[]  装入目标版本 mods 目录（遵循版本隔离）
  modsDuplicates: 'mods:duplicates', // (versionId: string) => ModDuplicateGroup[]  单版本查重
  modsCrossDuplicates: 'mods:crossDuplicates', // (versionIds: string[]) => ModCrossDuplicate[]  跨版本查重

  // 整合包
  modpackProbe: 'modpack:probe', // (filePath: string) => ModpackInfo  只解析不安装（供导入确认弹窗）
  modpackInstall: 'modpack:install', // (filePath: string, opts?: { nameSource?: 'file' | 'inner' }) => void  nameSource 默认 'file'（以压缩包文件名命名实例）；异步：进度走 event:progress，完成走 event:installDone（versionId = 实例 id）

  // 社区资源
  communitySearch: 'community:search', // (q: CommunityQuery) => CommunityResult[]
  communityFiles: 'community:files', // (source: 'modrinth'|'curseforge', projectId: string) => CommunityFile[]
  communityDownload: 'community:download', // (file: CommunityFile, target: { versionId: string; kind: CommunityKind }) => string  同步下载完成返回保存路径；kind=modpack 时下载后自动进入整合包安装流程

  tasksCancel: 'tasks:cancel', // (taskId: string) => boolean  取消进行中的后台任务（版本安装/整合包导入/资源下载）

  // 皮肤/披风（均需当前选中账号为微软正版账号）
  skinProfile: 'skin:profile', // () => ProfileSkins  拉取当前账号皮肤/披风档案
  skinUpload: 'skin:upload', // (filePath: string, variant: SkinVariant) => ProfileSkins  上传并返回最新档案
  skinCape: 'skin:cape', // (capeId: string | null) => ProfileSkins  激活/卸下披风
  skinHistory: 'skin:history', // () => SkinHistoryEntry[]  历史皮肤（含 dataUrl 缩略）
  skinHistoryDelete: 'skin:historyDelete', // (id: string) => SkinHistoryEntry[]
  skinUploadHistory: 'skin:uploadHistory', // (id: string) => ProfileSkins  用历史记录快速换回
  skinAvatar: 'skin:avatar', // () => string | null  当前选中账号的方块头像 dataURL（微软=皮肤头部渲染；离线=minotar 公共头像；无账号=null）

  // 文件/目录（rel 为相对游戏目录的子目录：'mods' | 'resourcepacks' | 'shaderpacks' | ''）
  appOpenDir: 'app:openDir', // (rel?: string) => void  用系统资源管理器打开目录
  fsList: 'fs:list', // (rel: string) => FsEntry[]
  fsRemove: 'fs:remove' // (rel: string, name: string) => FsEntry[]
} as const

export interface FsEntry {
  name: string
  size: number
  isDir: boolean
  mtime: number
}

// ---------------- IPC 事件（主进程 -> 前端，on 订阅） ----------------
export const IPC_EVENT = {
  progress: 'event:progress', // (e: ProgressEvent)
  launchLog: 'event:launchLog', // (line: string)
  launchState: 'event:launchState', // (s: LaunchState)
  msLoginDone: 'event:msLoginDone', // (account: Account | null)  null = 失败/取消
  installDone: 'event:installDone', // (r: { versionId: string; installedId?: string; ok: boolean; error?: string; taskId?: string; cancelled?: boolean; stage?: string })  installedId = 实际实例 id（含加载器后缀，成功时存在）；stage = 失败阶段；cancelled = 用户取消
  taskDone: 'event:taskDone', // (r: { taskId: string; ok: boolean; error?: string; cancelled?: boolean; stage?: string })  所有后台任务（含普通资源下载）的统一完成通知
  gameDirDone: 'event:gameDirDone' // (r: { ok: boolean; error?: string; gameDir?: string })  目录迁移结束（配置已切换/失败已回滚）
} as const

/**
 * 默认微软登录 client_id：Prism Launcher 注册的公开 Azure 应用，
 * 已在 consumers 租户实测支持 device code 流程；可在设置中替换为自注册应用
 */
export const DEFAULT_MS_CLIENT_ID = 'c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb'

// ---------------- 社区资源 ----------------
export type CommunityKind = 'mod' | 'modpack' | 'resourcepack' | 'shader' | 'datapack'
export type CommunitySource = 'modrinth' | 'curseforge'

export interface CommunityQuery {
  keyword: string
  kind: CommunityKind
  source: 'all' | CommunitySource
  mcVersion?: string
  loader?: LoaderName | ''
  /** 排序：相关度（默认）/ 最多下载 / 最新发布 */
  sort?: 'relevance' | 'downloads' | 'newest'
  /** 分页偏移 */
  offset: number
  limit: number
}

export interface CommunityResult {
  source: CommunitySource
  projectId: string
  slug: string
  title: string
  author: string
  description: string
  iconUrl: string
  downloads: number
  updatedAt: string
  categories: string[]
}

export interface CommunityFile {
  fileId: string
  fileName: string
  version: string
  url: string
  sha1?: string
  size: number
  releaseType: 'release' | 'beta' | 'alpha'
  gameVersions: string[]
  loaders: string[]
  date: string
}

/** 整合包探测信息（导入确认弹窗用） */
export interface ModpackInfo {
  format: 'mrpack' | 'curseforge' | 'fullpack'
  /** 包内声明的名称 */
  innerName: string
  /** 压缩包文件名（去扩展名） */
  fileName: string
  version: string
  mcVersion: string
  loader?: LoaderName
  loaderVersion?: string
}

// ---------------- 服务器 ----------------
export interface ServerEntry {
  id: string
  name: string
  address: string
  /** 绑定的游戏版本 id（双击直接启动该版本进服；空 = 未绑定） */
  versionId?: string
}

// ---------------- MOD 拖入即装 ----------------
/** 单个 MOD 文件的元数据解析结果 */
export interface ModInfo {
  /** jar 文件绝对路径 */
  filePath: string
  fileName: string
  /** 解析出的 mod id（失败为空） */
  id: string
  /** 展示名 */
  name: string
  /** MOD 版本号 */
  version: string
  /** 所属加载器 */
  loader: LoaderName | null
  /** 支持的 MC 版本范围原文（如 [1.20,) / 1.20.1） */
  mcRange: string
  /** 要求的加载器版本范围原文（如 >=0.15.0 / [65.0,)） */
  loaderRange?: string
  /** 前置依赖 mod id 列表 */
  dependencies: string[]
  /** 图标 dataURL（jar 内嵌图标） */
  iconDataUrl?: string
  /** 解析失败原因（非 MOD/损坏时存在） */
  error?: string
}

export interface ModInstallResult {
  fileName: string
  ok: boolean
  message: string
}

/** 单版本重复 MOD 组（同 mod id 多文件共存） */
export interface ModDuplicateGroup {
  modId: string
  name: string
  files: Array<{ fileName: string; version: string; /** 排序后的最新版（默认保留） */ latest: boolean }>
}

/** 跨版本重复：同一 mod id 同时存在于多个版本 */
export interface ModCrossDuplicate {
  modId: string
  name: string
  /** 出现该 MOD 的版本列表（版本 id + 文件名） */
  presentIn: Array<{ versionId: string; fileName: string }>
}

export interface ServerPingResult {
  online: boolean
  /** 在线/上限，如 "12/100" */
  players: string
  /** MOTD 纯文本（去格式化码） */
  motd: string
  version: string
  latencyMs: number
}
