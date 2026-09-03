/**
 * 轻量全局状态（Vue reactive），跨视图共享。
 */
import { reactive } from 'vue'
import type {
  Account,
  InstalledVersion,
  LaunchState,
  ProgressEvent,
  Settings
} from '@shared/types'
import { errText, getInstalled, getSelectedAccount, listAccounts, saveSettings } from './api'

export type ViewName =
  | 'home'
  | 'game'
  | 'mods'
  | 'packs'
  | 'shaders'
  | 'skins'
  | 'community'
  | 'servers'
  | 'settings'
  | 'accounts'
export type ToastType = 'success' | 'error' | 'info'

export interface ToastItem {
  id: number
  text: string
  type: ToastType
}

const LAST_PLAYED_KEY = 'kamucl.lastPlayed'
const BANNER_ALIGN_KEY = 'kamucl.bannerAlign'

export type BannerAlign = 'start' | 'center'

/** 从 localStorage 读取 Banner 文字对齐方式 */
function loadBannerAlign(): BannerAlign {
  try {
    return localStorage.getItem(BANNER_ALIGN_KEY) === 'center' ? 'center' : 'start'
  } catch {
    return 'start'
  }
}

/** 从 localStorage 读取「版本 id -> 最后启动时间戳」映射 */
function loadLastPlayed(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LAST_PLAYED_KEY)
    if (!raw) return {}
    const obj: unknown = JSON.parse(raw)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return obj as Record<string, number>
    }
    return {}
  } catch {
    return {}
  }
}

export const store = reactive({
  /** 应用设置（未加载完成时为 null） */
  settings: null as Settings | null,
  /** 首次初始化是否完成 */
  initialized: false,
  accounts: [] as Account[],
  selectedAccount: null as Account | null,
  installed: [] as InstalledVersion[],
  currentView: 'home' as ViewName,
  /** 顶栏搜索关键字（游戏页版本列表联动过滤） */
  searchKeyword: '',
  /** 资源管理（模组/资源包/光影包）当前选中的版本 id；空 = 跟随第一个已装版本 */
  resourceVersionId: '',
  /** 文件系统变更计数器（MOD 装入等操作后自增，驱动 FileManager 刷新） */
  fsRefreshTick: 0,
  /** 当前下载/安装进度（无任务时为 null） */
  progress: null as ProgressEvent | null,
  /** 正在后台下载/安装的版本 id 集合（installDone 事件到达后移除） */
  installing: new Set<string>(),
  /** 最近一次安装失败的版本 id 集合（已安装页显示重试入口） */
  failedInstalls: new Set<string>(),
  /** 首页 Banner 文字对齐（localStorage 持久化） */
  bannerAlign: loadBannerAlign(),
  /** 游戏启动状态（未启动过为 null） */
  launchState: null as LaunchState | null,
  /** 最近一次点击启动的版本 id（用于启动成功后记录 lastPlayed） */
  launchingVersionId: '',
  /** 启动日志行（滚动缓冲，有上限） */
  logs: [] as string[],
  /** 每个版本的最后启动时间戳（localStorage 持久化） */
  lastPlayed: loadLastPlayed(),
  /** 个性化点选编辑模式（停留当前界面，点击板块改色） */
  editMode: false,
  /** 当前选中的板块 key（对应元素 data-edit 值），空 = 未选中 */
  editTarget: '',
  /** 通知中心：最近的 toast 记录（新→旧，上限 30 条） */
  notices: [] as Array<{ id: number; text: string; type: ToastType; time: number }>,
  /** 通知是否有未读（驱动铃铛红点） */
  noticesUnread: false,
  /** 整合包导入处理器（App.vue 注册，供任意页面触发导入确认弹窗） */
  importHandler: null as ((filePath: string) => void) | null,
  toasts: [] as ToastItem[]
})

// ---------------- toast ----------------
let toastSeq = 0

export function toast(text: string, type: ToastType = 'info') {
  const id = ++toastSeq
  store.toasts.push({ id, text, type })
  // 同步记录到通知中心（新→旧，上限 30 条，标记未读）
  store.notices.unshift({ id, text, type, time: Date.now() })
  if (store.notices.length > 30) store.notices.length = 30
  store.noticesUnread = true
  setTimeout(() => {
    const i = store.toasts.findIndex((t) => t.id === id)
    if (i >= 0) store.toasts.splice(i, 1)
  }, 3000)
}

/** 打开通知中心时调用：清除未读标记 */
export function markNoticesRead() {
  store.noticesUnread = false
}

// ---------------- 数据刷新 ----------------
export async function refreshAccounts() {
  const [accounts, selected] = await Promise.all([listAccounts(), getSelectedAccount()])
  store.accounts = accounts
  store.selectedAccount = selected
}

export async function refreshInstalled() {
  store.installed = await getInstalled()
}

// ---------------- 最近游玩记录 ----------------
/** 记录某版本的最后启动时间（启动状态变为 running 时调用） */
export function recordLastPlayed(id: string) {
  if (!id) return
  store.lastPlayed[id] = Date.now()
  try {
    localStorage.setItem(LAST_PLAYED_KEY, JSON.stringify(store.lastPlayed))
  } catch {
    /* 持久化失败不影响功能 */
  }
}

/** 设置 Banner 文字对齐方式（靠左下 / 居中），并持久化 */
export function setBannerAlign(a: BannerAlign) {
  store.bannerAlign = a
  try {
    localStorage.setItem(BANNER_ALIGN_KEY, a)
  } catch {
    /* 持久化失败不影响功能 */
  }
}

// ---------------- 个性化点选编辑模式 ----------------
/** 进入编辑模式：确保主题为 custom（custom 保持现有值或默认），然后停留在当前界面 */
export async function enterEditMode() {
  if (store.editMode) return
  if (store.settings && store.settings.theme !== 'custom') {
    try {
      store.settings = await saveSettings({ theme: 'custom' })
    } catch (e) {
      toast('切换自定义主题失败：' + errText(e), 'error')
      return
    }
  }
  store.editTarget = ''
  store.editMode = true
}

/** 退出编辑模式并复位选中板块 */
export function exitEditMode() {
  store.editMode = false
  store.editTarget = ''
}

// ---------------- 实例显示（版本 × 加载器 统一语义） ----------------
/**
 * 实例主显示名：`26.2 · Forge 65.0.0` / `26.2`（纯净版）。
 * 加载器实例不再裸奔技术 id（fabric-loader-x.x.x-mc）。
 */
export function displayVersionName(v: InstalledVersion): string {
  if (v.loader) {
    const cap = v.loader.charAt(0).toUpperCase() + v.loader.slice(1)
    return `${v.mcVersion} · ${cap}${v.loaderVersion ? ' ' + v.loaderVersion : ''}`
  }
  return v.mcVersion
}

/** 实例副显示名：技术 id（小字补充） */
export function displayVersionSub(v: InstalledVersion): string {
  return v.id
}

// ---------------- 进度平滑 ----------------/** 安装/启动任务的阶段顺序（用于把单阶段进度换算为单调不回退的整体进度） */
const STAGE_ORDER = [
  'version-json',
  'libraries',
  'client',
  'assets',
  'loader',
  'fabric-api',
  'repair',
  'modpack',
  'java',
  'launch',
  'done'
]

/** 把当前阶段进度换算为整体进度（0-1，阶段单调推进不回退） */
export function progressOverall(e: ProgressEvent): number {
  const i = STAGE_ORDER.indexOf(e.stage)
  const idx = i < 0 ? 0 : i
  const p = Math.max(0, Math.min(1, e.progress))
  return Math.min(1, (idx + p) / STAGE_ORDER.length)
}

/** 最后启动时间 -> 「今天 / 昨天 / x天前」，无记录返回 '—' */export function fmtLastPlayed(ts?: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOf(new Date()) - startOf(d)) / 86400000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 30) return `${days}天前`
  return d.toLocaleDateString('zh-CN')
}
