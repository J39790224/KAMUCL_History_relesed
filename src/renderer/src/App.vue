<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { Component } from 'vue'
import {
  cancelTask,
  errText,
  exportLaunchLogs,
  getSettings,
  installModpack,
  onGameDirDone,
  onInstallDone,
  onLaunchLog,
  onLaunchState,
  onProgress,
  onTaskDone,
  pauseTask,
  probeModpack,
  probeWorld,
  resumeTask,
  selectFile
} from './api'
import { dismissTask, exitEditMode, finalizeTask, markNoticesRead, recordLastPlayed, refreshAccounts, refreshInstalled, resetProgressMono, stageLabel, store, toast, upsertTaskProgress } from './store'
import type { ViewName } from './store'
import type { CustomTheme, ModpackInfo, ThemeName, WorldImportInfo } from '@shared/types'
import Toasts from './components/Toasts.vue'
import EditPanel from './components/EditPanel.vue'
import SplashScreen from './components/SplashScreen.vue'
import HomeView from './views/HomeView.vue'
import GameView from './views/GameView.vue'
import ModsView from './views/ModsView.vue'
import PacksView from './views/PacksView.vue'
import ShadersView from './views/ShadersView.vue'
import SkinsView from './views/SkinsView.vue'
import CommunityView from './views/CommunityView.vue'
import ServersView from './views/ServersView.vue'
import SettingsView from './views/SettingsView.vue'
import AccountsView from './views/AccountsView.vue'
import ModDropModal from './components/ModDropModal.vue'
import WorldImportModal from './components/WorldImportModal.vue'

const viewMap: Record<ViewName, Component> = {
  home: HomeView,
  game: GameView,
  mods: ModsView,
  packs: PacksView,
  shaders: ShadersView,
  skins: SkinsView,
  community: CommunityView,
  servers: ServersView,
  settings: SettingsView,
  accounts: AccountsView
}

const currentComponent = computed(() => viewMap[store.currentView])

// ---------------- 开屏动画 ----------------
/** 初始化完成（settings/accounts/installed 加载 + 主题应用），最短展示 2.4s 后置 true */
const booted = ref(false)
/** 开屏动画自身时间线是否播放完成（SplashScreen done 事件） */
const splashAnimDone = ref(false)
/** 正在淡出（400ms opacity 过渡中） */
const splashLeaving = ref(false)
/** 淡出结束，v-if 彻底移除 splash */
const splashRemoved = ref(false)

// 初始化与动画都完成后再淡出，保证动画播完且内容就绪
watch([booted, splashAnimDone], ([b, a]) => {
  if (!b || !a || splashLeaving.value) return
  splashLeaving.value = true
  setTimeout(() => {
    splashRemoved.value = true
  }, 400)
})

const navItems: Array<{ key: ViewName; label: string; icon: string }> = [
  {
    key: 'home',
    label: '首页',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-6h6v6"/></svg>'
  },
  {
    key: 'game',
    label: '游戏版本',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="11" rx="5.5"/><path d="M7.5 10.8v3.4M5.8 12.5h3.4"/><circle cx="15.6" cy="11.9" r="0.6" fill="currentColor" stroke="none"/><circle cx="18" cy="13.6" r="0.6" fill="currentColor" stroke="none"/></svg>'
  },
  {
    key: 'skins',
    label: '皮肤',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 4-6 3 2 5 3-1v9h8v-9l3 1 2-5-6-3a3 3 0 0 1-6 0Z"/></svg>'
  },
  {
    key: 'community',
    label: '社区资源',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a13.5 13.5 0 0 1 0 18"/><path d="M12 3a13.5 13.5 0 0 0 0 18"/></svg>'
  },
  {
    key: 'settings',
    label: '设置',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06-.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06-.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>'
  }
]

/** 功能禁用判定 */
const isFeatureOff = (key: string): boolean =>
  (store.settings?.disabledFeatures ?? []).includes(key)

/** 过滤禁用功能后的主导航 */
const visibleNavItems = computed(() =>
  navItems.filter((n) => !isFeatureOff(n.key))
)

/** 过滤禁用功能后的资源管理子项 */
const visibleResourceSubItems = computed(() =>
  resourceSubItems.filter((s) => !isFeatureOff(s.key))
)

/** 资源管理子级菜单（模组/资源包/光影包），按游戏版本管理对应目录 */
const resourceSubItems: Array<{ key: ViewName; label: string; icon: string }> = [
  {
    key: 'mods',
    label: '模组',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/></svg>'
  },
  {
    key: 'packs',
    label: '资源包',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>'
  },
  {
    key: 'shaders',
    label: '光影包',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
  },
  {
    key: 'servers',
    label: '服务器',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>'
  }
]

/** 资源管理组是否展开（默认折叠；当前在其中任一子页时强制展开高亮） */
const resourceExpanded = ref(false)
const inResourceGroup = computed(() =>
  ['mods', 'packs', 'shaders', 'servers'].includes(store.currentView)
)

const win = (action: 'minimize' | 'maximize' | 'close') => {
  window.kamucl.send(`window:${action}`)
}

// ---------------- 全局拖拽导入整合包 ----------------
const dragActive = ref(false)
/** 进入/离开子元素会成对触发 dragenter/dragleave，用计数器避免遮罩闪烁 */
let dragDepth = 0

const dragHasFiles = (e: DragEvent) =>
  Array.from(e.dataTransfer?.types ?? []).includes('Files')

function onDragEnter(e: DragEvent) {
  if (!dragHasFiles(e)) return
  e.preventDefault()
  dragDepth++
  dragActive.value = true
}

function onDragOver(e: DragEvent) {
  if (!dragHasFiles(e)) return
  e.preventDefault() // 必须 preventDefault 才允许 drop
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  dragActive.value = true
}

function onDragLeave(e: DragEvent) {
  if (!dragHasFiles(e)) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragActive.value = false
}

function onDrop(e: DragEvent) {
  if (!dragHasFiles(e)) return
  e.preventDefault()
  dragDepth = 0
  dragActive.value = false
  const dropped = Array.from(e.dataTransfer?.files ?? [])
  if (!dropped.length) return
  const paths = dropped.map((f) => window.kamucl.getFilePath(f))
  const names = dropped.map((f) => f.name.toLowerCase())

  // 单项拖入先按内容识别：.mrpack 始终优先，ZIP/文件夹可能是世界存档。
  if (names.length === 1) {
    void routeSingleImport(paths[0], names[0])
    return
  }
  // 全部为非压缩包扩展（.jar 或文件夹）→ MOD 拖入即装流程
  if (names.every((n) => !/\.(mrpack|zip)$/.test(n))) {
    modDrop.files = paths
    modDrop.open = true
    return
  }
  toast('不能混合拖入整合包与其他文件，请分开拖入', 'error')
}

// ---------------- MOD 拖入即装 ----------------
const modDrop = reactive({ open: false, files: [] as string[] })

const worldModal = reactive({
  open: false,
  filePath: '',
  info: null as WorldImportInfo | null
})

async function routeSingleImport(filePath: string, displayName: string) {
  if (/\.mrpack$/i.test(displayName)) {
    await openModpackImport(filePath)
    return
  }
  if (!/\.jar$/i.test(displayName)) {
    try {
      const info = await probeWorld(filePath)
      if (info) {
        worldModal.filePath = filePath
        worldModal.info = info
        worldModal.open = true
        return
      }
    } catch (e) {
      toast('存档识别失败：' + errText(e), 'error')
      return
    }
  }
  if (/\.zip$/i.test(displayName)) {
    await openModpackImport(filePath)
    return
  }
  modDrop.files = [filePath]
  modDrop.open = true
}

// ---------------- 整合包导入确认弹窗 ----------------
const FORMAT_LABEL: Record<ModpackInfo['format'], string> = {
  mrpack: 'Modrinth',
  curseforge: 'CurseForge',
  fullpack: '完整客户端包'
}
const FORMAT_TAG_CLASS: Record<ModpackInfo['format'], string> = {
  mrpack: 'tag-success',
  curseforge: 'tag-gold',
  fullpack: 'tag-cyan'
}

interface ModpackModal {
  open: boolean
  probing: boolean
  error: string
  filePath: string
  info: ModpackInfo | null
  nameSource: 'file' | 'inner'
  customName: string
  targetFolder: string
  conflictAction: 'rename' | 'new' | 'update' | 'overwrite'
  existingId: string
  confirmReplace: boolean
}

const mpModal = reactive<ModpackModal>({
  open: false,
  probing: false,
  error: '',
  filePath: '',
  info: null,
  nameSource: 'file',
  customName: '',
  targetFolder: '',
  conflictAction: 'rename',
  existingId: '',
  confirmReplace: false
})

const mpFormatLabel = computed(() => (mpModal.info ? FORMAT_LABEL[mpModal.info.format] : ''))
const mpFormatTagClass = computed(() =>
  mpModal.info ? FORMAT_TAG_CLASS[mpModal.info.format] : ''
)
const normalizeMpName = (value: string) =>
  value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
const mpExistingInFolder = computed(() =>
  (mpModal.info?.existingInstances ?? []).filter((item) => item.folder === mpModal.targetFolder)
)
const mpNameConflict = computed(() =>
  mpExistingInFolder.value.find(
    (item) => normalizeMpName(item.id) === normalizeMpName(mpModal.customName)
  )
)
const mpRelatedExisting = computed(() => {
  const result = mpExistingInFolder.value.filter(
    (item) => item.samePackVersion || normalizeMpName(item.id) === normalizeMpName(mpModal.customName)
  )
  return [...new Map(result.map((item) => [item.id, item])).values()]
})
const mpNeedsReplaceConfirm = computed(
  () => mpModal.conflictAction === 'update' || mpModal.conflictAction === 'overwrite'
)

function fmtPackBytes(bytes: number): string {
  if (!bytes) return '大小未知'
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function setMpNameSource(source: 'file' | 'inner') {
  mpModal.nameSource = source
  if (mpModal.info) mpModal.customName = source === 'inner' ? mpModal.info.innerName : mpModal.info.fileName
  mpModal.confirmReplace = false
}

function onMpTargetFolderChange() {
  const related = mpRelatedExisting.value[0]
  mpModal.existingId = related?.id ?? ''
  mpModal.conflictAction = related ? 'new' : 'rename'
  mpModal.confirmReplace = false
  mpModal.error = ''
}

function onMpConflictActionChange() {
  mpModal.confirmReplace = false
  mpModal.error = ''
  if (mpNeedsReplaceConfirm.value) {
    const valid = mpExistingInFolder.value.some((item) => item.id === mpModal.existingId)
    if (!valid) mpModal.existingId = mpRelatedExisting.value[0]?.id ?? mpExistingInFolder.value[0]?.id ?? ''
  }
}

/** 拿到文件路径后先 probe 解析，弹确认框；解析失败在框内展示错误 */
async function openModpackImport(filePath: string) {
  if (!filePath) return
  Object.assign(mpModal, {
    open: true,
    probing: true,
    error: '',
    filePath,
    info: null,
    nameSource: 'file' as const,
    customName: '',
    targetFolder: store.settings?.activeFolder || store.settings?.gameDir || '',
    conflictAction: 'rename' as const,
    existingId: '',
    confirmReplace: false
  })
  try {
    const info = await probeModpack(filePath)
    // 防止解析期间用户又发起了另一次导入，旧结果覆盖新弹窗
    if (mpModal.filePath === filePath) {
      mpModal.info = info
      mpModal.customName = info.fileName
      const relevant = info.existingInstances.find(
        (item) => item.folder === mpModal.targetFolder && (item.sameNormalizedName || item.samePackVersion)
      )
      mpModal.existingId = relevant?.id ?? ''
      mpModal.conflictAction = relevant ? 'new' : 'rename'
    }
  } catch (e) {
    if (mpModal.filePath === filePath) mpModal.error = errText(e)
  } finally {
    if (mpModal.filePath === filePath) mpModal.probing = false
  }
}

function closeModpackImport() {
  mpModal.open = false
}

/** 确认导入：主进程后台异步执行，完成/失败由 installDone 订阅统一提示 */
function confirmModpackImport() {
  if (!mpModal.info) return
  if (!mpModal.customName.trim()) {
    mpModal.error = '实例名称不能为空'
    return
  }
  if (mpModal.conflictAction === 'rename' && mpNameConflict.value) {
    mpModal.error = `实例名称已存在：${mpNameConflict.value.id}，请改名或选择其他处理方式`
    return
  }
  if (mpNeedsReplaceConfirm.value && (!mpModal.existingId || !mpModal.confirmReplace)) {
    mpModal.error = '请选择现有实例并勾选影响范围确认'
    return
  }
  const filePath = mpModal.filePath
  const nameSource = mpModal.nameSource
  mpModal.open = false
  toast('开始解析并安装整合包…', 'info')
  void installModpack(filePath, {
    nameSource,
    instanceName: mpModal.customName.trim(),
    targetFolder: mpModal.targetFolder,
    conflictAction: mpModal.conflictAction,
    existingId: mpModal.existingId || undefined,
    confirmReplace: mpNeedsReplaceConfirm.value && mpModal.confirmReplace
  }).catch((e) => {
    toast('整合包安装失败：' + errText(e), 'error')
  })
}

/** 顶栏「导入」按钮：系统文件选择框选整合包 */
async function onImportClick() {
  try {
    const p = await selectFile()
    if (p) void routeSingleImport(p, p.split(/[\\/]/).pop() ?? p)
  } catch (e) {
    toast('整合包安装失败：' + errText(e), 'error')
  }
}

// ---------------- 通知中心 ----------------
const noticeOpen = ref(false)

function toggleNotices() {
  noticeOpen.value = !noticeOpen.value
  if (noticeOpen.value) markNoticesRead()
}

// ---------------- 启动失败日志导出 ----------------
const launchFail = reactive({ open: false, title: '', text: '', exporting: false })

async function onExportLogs() {
  if (launchFail.exporting) return
  launchFail.exporting = true
  try {
    const p = await exportLaunchLogs(store.launchingVersionId)
    if (p) {
      toast(`错误日志已导出：${p}`, 'success')
      launchFail.open = false
    }
  } catch (e) {
    toast('导出失败：' + errText(e), 'error')
  } finally {
    launchFail.exporting = false
  }
}

// ---------------- 下载中心 ----------------
const dlOpen = ref(false)
const activeTaskCount = computed(
  () =>
    store.tasks.filter(
      (t) => t.status === 'running' || t.status === 'paused' || t.status === 'cancelling'
    ).length
)

async function onPauseTask(id: string) {
  const task = store.tasks.find((t) => t.id === id)
  if (!task || task.status !== 'running') return
  try {
    if (await pauseTask(id)) task.status = 'paused'
  } catch (e) {
    toast('暂停失败：' + errText(e), 'error')
  }
}

async function onResumeTask(id: string) {
  const task = store.tasks.find((t) => t.id === id)
  if (!task || task.status !== 'paused') return
  try {
    if (await resumeTask(id)) task.status = 'running'
  } catch (e) {
    toast('恢复失败：' + errText(e), 'error')
  }
}

async function onCancelTask(id: string) {
  const task = store.tasks.find((t) => t.id === id)
  if (!task || (task.status !== 'running' && task.status !== 'paused')) return
  task.status = 'cancelling'
  try {
    const found = await cancelTask(id)
    if (!found) {
      finalizeTask({ taskId: id, ok: false, cancelled: true, error: '任务已结束' })
      toast('任务已结束或不存在', 'info')
    }
  } catch (e) {
    toast('取消失败：' + errText(e), 'error')
  }
}

/** 任务副标题：阶段标签与进度文本重复时只显示一次 */
function taskSubText(t: { stage: string; text: string }): string {
  const label = stageLabel(t.stage)
  return t.text.startsWith(label) ? t.text : `${label} · ${t.text}`
}

function taskEtaText(seconds?: number): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 3) return ''
  if (seconds >= 3600) return ` · 约剩 ${Math.ceil(seconds / 3600)}h`
  if (seconds >= 60) return ` · 约剩 ${Math.ceil(seconds / 60)}min`
  return ` · 约剩 ${Math.round(seconds)}s`
}

function fmtNoticeTime(ts: number): string {
  const d = new Date(ts)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const today = new Date().toDateString() === d.toDateString()
  return today ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

/** 自定义背景层样式（mode=none 时无背景层） */
const bgStyle = computed(() => {
  const bg = store.settings?.background
  if (!bg || bg.mode === 'none') return null
  if (bg.mode === 'color') {
    return {
      background: bg.color,
      opacity: String(bg.opacity)
    }
  }
  if (bg.mode === 'image' && bg.image) {
    const url = 'file:///' + bg.image.replace(/\\/g, '/')
    return {
      backgroundImage: `url("${url}")`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      opacity: String(bg.opacity),
      filter: bg.blur > 0 ? `blur(${bg.blur}px)` : 'none'
    }
  }
  return null
})

// ---------------- 主题应用（亮 / 暗 / 自定义） ----------------
/** 自定义主题写入的全部 inline CSS 变量（切回亮/暗时需统一清除） */
const CUSTOM_VARS = [
  '--accent',
  '--accent-2',
  '--accent-deep',
  '--accent-grad',
  '--accent-soft',
  '--on-accent',
  '--bg',
  '--bg-2',
  '--card',
  '--card-2',
  '--text',
  '--text-dim',
  '--border',
  '--sidebar-text',
  '--bn-text',
  '--sidebar-w',
  '--banner-h',
  '--radius'
]

/** 解析 #rrggbb 并计算相对亮度（0-1），非法输入按暗色处理 */
function hexLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return 0
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

function clearCustomVars() {
  const st = document.documentElement.style
  CUSTOM_VARS.forEach((v) => st.removeProperty(v))
}

/** 把 settings.custom 映射为 documentElement 上的 inline CSS 变量覆盖 */
function applyCustomVars(custom: CustomTheme) {
  const st = document.documentElement.style
  const { colors, layout } = custom
  const accent = colors.accent
  const accent2 = `color-mix(in srgb, ${accent} 72%, white)`
  const accentDeep = `color-mix(in srgb, ${accent} 78%, black)`
  st.setProperty('--accent', accent)
  st.setProperty('--accent-2', accent2)
  st.setProperty('--accent-deep', accentDeep)
  st.setProperty(
    '--accent-grad',
    `linear-gradient(135deg, ${accent2} 0%, ${accent} 55%, ${accentDeep} 100%)`
  )
  st.setProperty('--accent-soft', `color-mix(in srgb, ${accent} 14%, transparent)`)
  st.setProperty('--on-accent', hexLuminance(accent) > 0.6 ? '#1a1208' : '#ffffff')
  st.setProperty('--bg', colors.bg)
  st.setProperty('--card', colors.card)
  st.setProperty('--card-2', `color-mix(in srgb, ${colors.card} 95%, ${colors.bg})`)
  st.setProperty('--text', colors.text)
  st.setProperty('--text-dim', colors.textDim)
  st.setProperty('--border', colors.border)
  st.setProperty('--bg-2', colors.sidebarBg)
  st.setProperty('--sidebar-text', colors.sidebarText)
  st.setProperty('--bn-text', colors.bannerText)
  st.setProperty('--sidebar-w', `${layout.sidebarWidth}px`)
  st.setProperty('--banner-h', `${layout.bannerHeight}px`)
  st.setProperty('--radius', `${layout.radius}px`)
}

/**
 * 应用主题：custom = 回到 :root 亮色基底（删除 data-theme）+ inline 变量覆盖；
 * light/dark = 清除 inline 覆盖后按原逻辑写 data-theme
 */
function applyTheme(theme?: ThemeName, custom?: CustomTheme) {
  const root = document.documentElement
  if (theme === 'custom' && custom) {
    delete root.dataset.theme
    applyCustomVars(custom)
  } else {
    clearCustomVars()
    root.dataset.theme = theme === 'dark' ? 'dark' : 'light'
  }
}

// settings 未加载时按亮色应用；加载完成 / 修改后 watch 触发立即生效
// deep: true 保证 custom.colors / custom.layout 内部字段变化也重新应用（即改即生效）
watch(
  () => [store.settings?.theme, store.settings?.custom] as const,
  ([t, c]) => applyTheme(t, c),
  { immediate: true, deep: true }
)

// ---------------- 个性化点选编辑模式 ----------------
/** 编辑模式下捕获点击：命中最内层 [data-edit] 板块则拦截真实动作并选中（再点取消） */
function onEditClick(e: MouseEvent) {
  if (!store.editMode) return
  const el = (e.target as HTMLElement | null)?.closest?.('[data-edit]') as HTMLElement | null
  if (!el) return // 未命中不清空，便于点击编辑面板
  e.preventDefault()
  e.stopPropagation()
  const key = el.dataset.edit ?? ''
  store.editTarget = store.editTarget === key ? '' : key
}

/** Esc 退出编辑模式 */
function onEditKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && store.editMode) exitEditMode()
}

/** 同步选中板块的 .edit-active 高亮描边（视图切换后需重挂） */
async function refreshEditHighlight() {
  await nextTick()
  document
    .querySelectorAll('[data-edit].edit-active')
    .forEach((el) => el.classList.remove('edit-active'))
  if (store.editMode && store.editTarget) {
    document
      .querySelectorAll(`[data-edit="${store.editTarget}"]`)
      .forEach((el) => el.classList.add('edit-active'))
  }
}

watch(
  () => [store.editMode, store.editTarget, store.currentView] as const,
  () => void refreshEditHighlight(),
  { flush: 'post' }
)

// ---------------- 初始化与事件订阅 ----------------
const offs: Array<() => void> = []

onMounted(async () => {
  applyTheme(store.settings?.theme, store.settings?.custom)
  window.addEventListener('keydown', onEditKeydown)
  // 注册全局整合包导入入口（供首页快速操作等任意页面触发）
  store.importHandler = (filePath: string) => void openModpackImport(filePath)
  offs.push(
    onProgress((e) => {
      store.progress = e
      upsertTaskProgress(e)
    }),
    onTaskDone((r) => {
      finalizeTask(r)
      resetProgressMono(r.taskId)
      if (r.cancelled) toast('任务已取消', 'info')
    }),
    onInstallDone((r) => {
      store.installing.delete(r.versionId)
      store.progress = null
      finalizeTask(r)
      resetProgressMono(r.taskId)
      if (r.ok) {
        store.failedInstalls.delete(r.versionId)
        toast(`版本 ${r.versionId} 安装完成`, 'success')
        void refreshInstalled()
      } else if (r.cancelled) {
        // 用户主动取消：不记失败、不弹错误（taskDone 已提示）
        void refreshInstalled()
      } else {
        store.failedInstalls.add(r.versionId)
        toast(`安装失败${r.stage ? `（${stageLabel(r.stage)}）` : ''}：` + (r.error ?? '未知错误'), 'error')
      }
    }),
    // 游戏目录迁移完成：立即全局刷新（版本列表/最近游戏/资源管理），全程无需重启
    onGameDirDone((r) => {
      store.progress = null
      resetProgressMono()
      if (r.ok) {
        void refreshInstalled().then(() => {
          store.fsRefreshTick++
        })
      }
    }),
    onLaunchLog((line) => {
      store.logs.push(line)
      if (store.logs.length > 1000) store.logs.splice(0, store.logs.length - 1000)
    }),
    onLaunchState((s) => {
      store.launchState = s
      // 启动成功（进入 running）时记录该版本的最近游玩时间
      if (s.status === 'running' && store.launchingVersionId) {
        recordLastPlayed(store.launchingVersionId)
      }
      if (s.status === 'exited' || s.status === 'error') store.progress = null
      if (s.status === 'error') {
        // 启动失败：弹窗提示并提供「导出错误日志」
        launchFail.open = true
        launchFail.title = '游戏启动失败'
        launchFail.text = s.text
      } else if (s.status === 'exited') {
        if (s.code) {
          // 非 0 退出码 = 崩溃，同样提供日志导出
          launchFail.open = true
          launchFail.title = `游戏异常退出（代码 ${s.code}）`
          launchFail.text = '游戏进程崩溃或被异常终止。可导出错误日志（含 crash-report 与 latest.log）用于排查。'
        } else {
          toast('游戏已退出', 'info')
        }
        // 游戏退出后只扫描刚运行的实例，避免共享 servers.dat 被错误关联到其他版本。
        const exitedVersionId = store.launchingVersionId
        const exitedFolder =
          store.launchingFolder || (store.settings?.activeFolder ?? store.settings?.gameDir)
        void import('./api').then(({ syncServersFromDat }) =>
          syncServersFromDat(exitedVersionId || undefined, exitedFolder).catch(() => undefined)
        )
      }
    })
  )

  try {
    await Promise.all([
      (async () => {
        store.settings = await getSettings()
        await Promise.all([refreshAccounts(), refreshInstalled()])
        // 启动自检：发现上次下载未完成的残缺版本，提示去已安装页处理
        const broken = store.installed.filter((v) => v.incomplete)
        if (broken.length) {
          toast(
            `检测到 ${broken.length} 个版本下载未完成（${broken.map((b) => b.id).join('、')}），可在「游戏版本 → 已安装」继续下载或删除残留`,
            'info'
          )
        }
      })(),
      // 开屏动画最短展示 2.4s
      new Promise((r) => setTimeout(r, 2400))
    ])
  } catch (e) {
    toast('初始化失败：' + errText(e), 'error')
  } finally {
    store.initialized = true
    booted.value = true
  }
})

onUnmounted(() => {
  window.removeEventListener('keydown', onEditKeydown)
  offs.forEach((off) => off())
})
</script>

<template>
  <!-- 自定义背景层（纯色/图片 + 透明度 + 模糊） -->
  <div v-if="bgStyle" class="app-bg" :style="bgStyle"></div>
  <div
    class="shell"
    :class="{ 'edit-mode': store.editMode, 'has-bg': !!bgStyle }"
    @click.capture="onEditClick"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- ============ 左侧边栏（宽度 --sidebar-w） ============ -->
    <aside class="sidebar" data-edit="sidebar">
      <!-- Logo 区 -->
      <div class="logo-area">
        <svg class="logo-svg" viewBox="0 0 48 48" fill="none">
          <defs>
            <linearGradient id="logo-g" x1="6" y1="4" x2="42" y2="44" gradientUnits="userSpaceOnUse">
              <stop offset="0" style="stop-color: var(--accent-2)" />
              <stop offset="0.55" style="stop-color: var(--accent)" />
              <stop offset="1" style="stop-color: var(--accent-deep)" />
            </linearGradient>
          </defs>
          <path d="M24 3.5 42 13.75v20.5L24 44.5 6 34.25v-20.5Z" stroke="url(#logo-g)" stroke-width="2.4" stroke-linejoin="round" />
          <path d="M24 3.5v20.25M24 23.75 42 13.75M24 23.75 6 13.75" stroke="url(#logo-g)" stroke-width="1.6" opacity="0.75" stroke-linejoin="round" />
        </svg>
        <div class="logo-text">
          <span class="logo-name">KAMUCL</span>
          <span class="logo-sub">Minecraft 启动器</span>
        </div>
      </div>

      <!-- 导航 -->
      <nav class="nav">
        <template v-for="item in visibleNavItems" :key="item.key">
          <button
            class="nav-item"
            :class="{ active: store.currentView === item.key }"
            @click="store.currentView = item.key"
          >
            <span class="nav-icon" v-html="item.icon"></span>
            <span class="nav-label">{{ item.label }}</span>
          </button>

          <!-- 资源管理子级菜单（插在「游戏版本」之后） -->
          <template v-if="item.key === 'game'">
            <button
              class="nav-item nav-parent"
              :class="{ active: inResourceGroup }"
              @click="resourceExpanded = !resourceExpanded"
            >
              <span class="nav-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 11h18"/></svg>
              </span>
              <span class="nav-label">资源管理</span>
              <svg
                class="nav-caret"
                :class="{ open: resourceExpanded || inResourceGroup }"
                viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
              >
                <path d="m9 6 6 6-6 6" />
              </svg>
            </button>
            <div v-show="resourceExpanded || inResourceGroup" class="nav-sub">
              <button
                v-for="sub in visibleResourceSubItems"
                :key="sub.key"
                class="nav-item nav-sub-item"
                :class="{ active: store.currentView === sub.key }"
                @click="store.currentView = sub.key"
              >
                <span class="nav-icon" v-html="sub.icon"></span>
                <span class="nav-label">{{ sub.label }}</span>
              </button>
            </div>
          </template>
        </template>
      </nav>
    </aside>

    <!-- ============ 右侧（顶栏 + 内容） ============ -->
    <div class="main-area">
      <!-- 顶部栏（可拖拽） -->
      <header class="topbar" data-edit="topbar">
        <div class="search-box">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            v-model="store.searchKeyword"
            class="search-input"
            placeholder="搜索游戏版本、模组、资源包…"
          />
        </div>

        <div class="top-actions">
          <button class="top-btn dl-toggle" @click="dlOpen = !dlOpen">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3v11" />
              <path d="m7 10 5 5 5-5" />
              <path d="M4 21h16" />
            </svg>
            下载
            <span v-if="activeTaskCount" class="dl-badge">{{ activeTaskCount }}</span>
          </button>
          <button class="top-btn" @click="onImportClick">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 15V4" />
              <path d="m7 8 5-5 5 5" />
              <path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
            </svg>
            导入
          </button>
          <button class="top-icon-btn" title="通知" @click="toggleNotices">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.7 21a2 2 0 0 1-3.4 0" />
            </svg>
            <span v-if="store.noticesUnread" class="bell-dot"></span>
          </button>

          <span class="top-divider"></span>

          <button class="win-btn" title="最小化" @click="win('minimize')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M5 12h14" />
            </svg>
          </button>
          <button class="win-btn" title="最大化/还原" @click="win('maximize')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <rect x="6" y="6" width="12" height="12" rx="1.5" />
            </svg>
          </button>
          <button class="win-btn win-close" title="关闭" @click="win('close')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        <!-- 通知中心下拉 -->
        <Teleport to="body">
          <div v-if="noticeOpen" class="notice-mask" @click="noticeOpen = false"></div>
          <div v-if="noticeOpen" class="notice-panel">
            <div class="notice-head">
              <span class="notice-title">通知</span>
              <button class="btn btn-ghost btn-sm" :disabled="!store.notices.length" @click="store.notices = []">清空</button>
            </div>
            <div v-if="!store.notices.length" class="notice-empty">暂无通知</div>
            <div v-else class="notice-list">
              <div v-for="n in store.notices" :key="n.id" class="notice-item" :class="'notice-' + n.type">
                <span class="notice-dot"></span>
                <div class="notice-body">
                  <p class="notice-text">{{ n.text }}</p>
                  <span class="notice-time">{{ fmtNoticeTime(n.time) }}</span>
                </div>
              </div>
            </div>
          </div>
        </Teleport>

        <!-- 下载中心下拉：版本安装/整合包导入/资源下载统一任务列表，支持取消 -->
        <Teleport to="body">
          <div v-if="dlOpen" class="notice-mask" @click="dlOpen = false"></div>
          <div v-if="dlOpen" class="notice-panel dl-panel">
            <div class="notice-head">
              <span class="notice-title">下载中心</span>
              <button class="btn btn-ghost btn-sm" @click="dlOpen = false; store.currentView = 'game'">
                去版本下载
              </button>
            </div>
            <div v-if="!store.tasks.length" class="notice-empty">没有进行中的任务</div>
            <div v-else class="notice-list">
              <div v-for="t in store.tasks" :key="t.id" class="dl-item" :class="'dl-' + t.status">
                <div class="dl-item-head">
                  <span class="dl-title" :title="t.title">{{ t.title }}</span>
                  <span v-if="t.status === 'running'" class="dl-actions">
                    <button class="btn btn-ghost btn-sm" @click="onPauseTask(t.id)">暂停</button>
                    <button class="btn btn-ghost btn-sm" @click="onCancelTask(t.id)">取消</button>
                  </span>
                  <span v-else-if="t.status === 'paused'" class="dl-actions">
                    <button class="btn btn-ghost btn-sm" @click="onResumeTask(t.id)">继续</button>
                    <button class="btn btn-ghost btn-sm" @click="onCancelTask(t.id)">取消</button>
                  </span>
                  <button v-else-if="t.status === 'cancelling'" class="btn btn-ghost btn-sm" disabled>
                    正在取消…
                  </button>
                  <button v-else class="dl-dismiss" title="移除记录" @click="dismissTask(t.id)">×</button>
                </div>
                <div class="dl-sub muted">
                  <template v-if="t.status === 'running'">
                    {{ taskSubText(t) }} · {{ t.indeterminate ? '正在计算总量' : Math.round(t.progress * 100) + '%' }}{{ taskEtaText(t.etaSeconds) }}
                  </template>
                  <template v-else-if="t.status === 'paused'">已暂停 · {{ t.indeterminate ? '总量未知' : Math.round(t.progress * 100) + '%' }}</template>
                  <template v-else-if="t.status === 'cancelling'">正在停止网络与后台任务…</template>
                  <template v-else-if="t.status === 'done'">已完成</template>
                  <template v-else-if="t.status === 'cancelled'">已取消</template>
                  <template v-else>
                    失败于「{{ stageLabel(t.stage || 'error') }}」阶段：{{ t.error }}
                  </template>
                </div>
                <div v-if="t.status === 'running' || t.status === 'paused' || t.status === 'cancelling'" class="dl-bar" :class="{ 'is-indeterminate': t.indeterminate && t.status === 'running' }">
                  <div class="dl-bar-fill" :style="{ width: t.indeterminate ? '35%' : Math.round(t.progress * 100) + '%' }"></div>
                </div>
              </div>
            </div>
          </div>
        </Teleport>
      </header>

      <!-- 内容区 -->
      <main class="content">
        <Transition name="fade" mode="out-in">
          <component :is="currentComponent" :key="store.currentView" />
        </Transition>
      </main>
    </div>

    <Toasts />

    <!-- 个性化编辑模式：右侧滑出编辑面板 -->
    <Transition name="ep-slide">
      <EditPanel v-if="store.editMode" />
    </Transition>
  </div>

  <!-- 整合包拖入：全屏遮罩（pointer-events:none 保证不干扰拖拽事件） -->
  <Teleport to="body">
    <div v-if="dragActive" class="drop-mask">
      <div class="drop-box">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <path d="m7 8 5-5 5 5" />
          <path d="M12 3v12" />
        </svg>
        <p class="drop-title">松开导入：存档文件夹 / ZIP、整合包（.mrpack）或 MOD</p>
      </div>
    </div>
  </Teleport>

  <!-- MOD 拖入即装确认弹窗 -->
  <ModDropModal :open="modDrop.open" :files="modDrop.files" @close="modDrop.open = false" />

  <WorldImportModal
    :open="worldModal.open"
    :file-path="worldModal.filePath"
    :info="worldModal.info"
    @close="worldModal.open = false"
  />

  <!-- 启动失败：提示 + 导出错误日志 -->
  <Teleport to="body">
    <div v-if="launchFail.open" class="modal-mask" @click.self="launchFail.open = false">
      <div class="modal launchfail-modal">
        <h3 class="modal-title">{{ launchFail.title }}</h3>
        <p class="launchfail-text">{{ launchFail.text }}</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" @click="launchFail.open = false">关闭</button>
          <button class="btn btn-gold" :disabled="launchFail.exporting" @click="onExportLogs">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11" /><path d="m7 10 5 5 5-5" /><path d="M4 21h16" /></svg>
            {{ launchFail.exporting ? '导出中…' : '导出错误日志' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 整合包导入确认弹窗 -->
  <Teleport to="body">
    <div v-if="mpModal.open" class="modal-mask" @click.self="closeModpackImport">
      <div class="modal mp-modal">
        <h3 class="mp-title">导入整合包</h3>

        <!-- 解析中 -->
        <div v-if="mpModal.probing" class="mp-loading">
          <span class="spin"></span>
          <span class="muted">解析中…</span>
        </div>

        <!-- 解析成功：包信息 + 命名选项 -->
        <template v-else-if="mpModal.info">
          <div class="mp-tags">
            <span class="tag" :class="mpFormatTagClass">{{ mpFormatLabel }}</span>
            <span class="tag">MC {{ mpModal.info.mcVersion }}</span>
            <span v-if="mpModal.info.loader" class="tag tag-gold">
              {{ mpModal.info.loader
              }}{{ mpModal.info.loaderVersion ? ' ' + mpModal.info.loaderVersion : '' }}
            </span>
            <span
              v-if="mpModal.info.version && mpModal.info.version !== mpModal.info.innerName"
              class="tag"
              >版本 {{ mpModal.info.version }}</span
            >
          </div>
          <p class="mp-summary">
            {{ mpModal.info.fileCount }} 个清单文件 · {{ fmtPackBytes(mpModal.info.downloadBytes) }}
            <span v-if="mpModal.info.hasOverrides"> · overrides</span>
            <span v-if="mpModal.info.hasClientOverrides"> · client-overrides</span>
          </p>

          <p class="mp-label">目标游戏文件夹</p>
          <select v-model="mpModal.targetFolder" class="select" @change="onMpTargetFolderChange">
            <option v-for="folder in store.settings?.folders || []" :key="folder.path" :value="folder.path">
              {{ folder.name }}{{ folder.isDefault ? '（默认）' : '' }} · {{ folder.path }}
            </option>
          </select>

          <p class="mp-label">实例命名</p>
          <div class="mp-name-opts">
            <button
              class="mp-name-opt"
              :class="{ active: mpModal.nameSource === 'file' }"
              @click="setMpNameSource('file')"
            >
              <span class="mp-radio"></span>
              <span class="mp-name-text">
                <span class="mp-name-label">使用压缩包文件名</span>
                <span class="mp-name-value">{{ mpModal.info.fileName }}</span>
              </span>
            </button>
            <button
              class="mp-name-opt"
              :class="{ active: mpModal.nameSource === 'inner' }"
              @click="setMpNameSource('inner')"
            >
              <span class="mp-radio"></span>
              <span class="mp-name-text">
                <span class="mp-name-label">使用整合包名称</span>
                <span class="mp-name-value">{{ mpModal.info.innerName }}</span>
              </span>
            </button>
          </div>
          <input v-model="mpModal.customName" class="input mp-custom-name" maxlength="120" placeholder="自定义实例名称" @input="mpModal.confirmReplace = false; mpModal.error = ''" />

          <div v-if="mpRelatedExisting.length" class="mp-conflict">
            <strong>检测到实例冲突或相同整合包版本</strong>
            <span>
              {{ mpRelatedExisting.map(item => `${item.id}${item.samePackVersion ? '（同包同版本）' : ''}`).join('、') }}
            </span>
            <div class="mp-conflict-actions">
              <label><input v-model="mpModal.conflictAction" type="radio" value="rename" @change="onMpConflictActionChange" /> 重新命名</label>
              <label><input v-model="mpModal.conflictAction" type="radio" value="new" @change="onMpConflictActionChange" /> 作为新实例安装（自动加序号）</label>
              <label><input v-model="mpModal.conflictAction" type="radio" value="update" @change="onMpConflictActionChange" /> 更新现有实例</label>
              <label><input v-model="mpModal.conflictAction" type="radio" value="overwrite" @change="onMpConflictActionChange" /> 覆盖安装</label>
            </div>

            <template v-if="mpNeedsReplaceConfirm">
              <select v-model="mpModal.existingId" class="select mp-existing-select">
                <option v-for="item in mpExistingInFolder" :key="item.id" :value="item.id">
                  {{ item.id }}{{ item.samePackVersion ? ' · 同一整合包版本' : '' }}
                </option>
              </select>
              <div class="mp-impact" :class="{ danger: mpModal.conflictAction === 'overwrite' }">
                <template v-if="mpModal.conflictAction === 'update'">
                  将重建包管理文件并恢复用户存档、配置及非包管理文件；同名的新包 MOD 优先。操作失败会恢复完整备份。
                </template>
                <template v-else>
                  将重建实例包文件；存档、配置、截图、资源包及可识别的用户 MOD 会保留，其他未知顶层内容可能被移除。操作失败会恢复完整备份。
                </template>
              </div>
              <label class="mp-replace-confirm">
                <input v-model="mpModal.confirmReplace" type="checkbox" />
                <span>我已确认上述影响范围，并同意{{ mpModal.conflictAction === 'update' ? '更新' : '覆盖' }}所选实例。</span>
              </label>
            </template>
          </div>

          <p v-if="mpNameConflict && mpModal.conflictAction === 'rename'" class="mp-error">
            名称「{{ mpModal.customName }}」已存在，请重新命名或选择其他处理方式。
          </p>
          <p v-if="mpModal.error" class="mp-error">{{ mpModal.error }}</p>

          <div class="mp-actions">
            <button class="btn btn-ghost" @click="closeModpackImport">取消</button>
            <button class="btn btn-gold" @click="confirmModpackImport">确认导入</button>
          </div>
        </template>

        <!-- 解析失败 -->
        <template v-else>
          <p class="mp-error">{{ mpModal.error || '无法解析该整合包' }}</p>
          <div class="mp-actions">
            <button class="btn btn-ghost" @click="closeModpackImport">关闭</button>
          </div>
        </template>
      </div>
    </div>
  </Teleport>

  <!-- 编辑模式顶部悬浮提示条（fixed 居中，accent 底） -->
  <Teleport to="body">
    <Transition name="edit-tip">
      <div v-if="store.editMode" class="edit-tip">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 22C6.49 22 2 17.51 2 12S6.49 2 12 2s10 4.04 10 9c0 3.31-2.69 6-6 6h-1.77c-.28 0-.5.22-.5.5 0 .12.05.23.13.33.41.47.64 1.06.64 1.67A2.5 2.5 0 0 1 12 22Z" />
        </svg>
        <span>个性化编辑中 · 点击板块自定义颜色</span>
        <button class="edit-tip-done" @click="exitEditMode">完成</button>
      </div>
    </Transition>
  </Teleport>

  <!-- 开屏动画：初始化未完成或动画未播完时遮盖（splash 期间内容正常渲染），完成后淡出 400ms 再移除 -->
  <SplashScreen
    v-if="!splashRemoved"
    :leaving="splashLeaving"
    @done="splashAnimDone = true"
  />
</template>

<style scoped>
.shell {
  display: flex;
  height: 100%;
  background: var(--bg);
  position: relative;
  z-index: 1;
}
/* 自定义背景层：垫底铺满，不拦截交互 */
.app-bg {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
}
/* 激活自定义背景时界面底色透出背景层 */
.shell.has-bg {
  background: transparent;
}

/* ---------------- 左侧边栏 ---------------- */
.sidebar {
  width: var(--sidebar-w);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-2);
  border-right: 1px solid var(--border);
}

.logo-area {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 84px;
  padding: 0 20px;
  flex-shrink: 0;
}
.logo-svg {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
}
.logo-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.logo-name {
  font-size: 20px;
  font-weight: 800;
  letter-spacing: 2px;
  color: var(--text);
}
.logo-sub {
  font-size: 12px;
  color: var(--text-dim);
}

.nav {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 12px;
  overflow-y: auto;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 44px;
  padding: 0 14px;
  border: none;
  border-radius: 12px;
  background: transparent;
  color: var(--sidebar-text);
  font-size: 14px;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.16s ease, color 0.16s ease;
  flex-shrink: 0;
}
.nav-item:hover {
  color: var(--text);
  background: var(--hover);
}
.nav-item.active {
  background: var(--accent-soft);
  color: var(--accent);
}
.nav-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}
.nav-icon :deep(svg) {
  width: 19px;
  height: 19px;
  display: block;
}
.nav-label {
  font-weight: 500;
}
.nav-item.active .nav-label {
  font-weight: 600;
}

/* 资源管理子级菜单 */
.nav-parent .nav-caret {
  width: 14px;
  height: 14px;
  margin-left: auto;
  flex-shrink: 0;
  transition: transform 0.18s ease;
  opacity: 0.7;
}
.nav-parent .nav-caret.open {
  transform: rotate(90deg);
}
.nav-sub {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 2px 0 4px;
}
.nav-sub-item {
  height: 38px;
  padding-left: 30px;
  font-size: 13.5px;
  position: relative;
}
.nav-sub-item::before {
  content: '';
  position: absolute;
  left: 17px;
  top: 50%;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.4;
  transform: translateY(-50%);
}
.nav-sub-item.active::before {
  opacity: 1;
}
.nav-sub-item .nav-icon {
  width: 17px;
  height: 17px;
}
.nav-sub-item .nav-icon :deep(svg) {
  width: 16px;
  height: 16px;
}

/* ---------------- 右侧区域 ---------------- */
.main-area {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* 顶部栏 */
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: 64px;
  flex-shrink: 0;
  padding: 0 16px 0 22px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-2);
  -webkit-app-region: drag;
}

.search-box {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 400px;
  max-width: 46%;
  height: 38px;
  padding: 0 14px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text-dim);
  -webkit-app-region: no-drag;
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
}
.search-box:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.search-box svg {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
}
.search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  font-family: inherit;
}
.search-input::placeholder {
  color: var(--text-dim);
  opacity: 0.75;
}

.top-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  -webkit-app-region: no-drag;
}
.top-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 12px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--text-dim);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.top-btn:hover {
  background: var(--card-2);
  color: var(--accent-2);
}
.top-btn svg {
  width: 15px;
  height: 15px;
}

.top-icon-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.top-icon-btn:hover {
  background: var(--card-2);
  color: var(--text);
}
.top-icon-btn svg {
  width: 17px;
  height: 17px;
}
.bell-dot {
  position: absolute;
  top: 7px;
  right: 8px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  border: 1.5px solid var(--bg-2);
}

/* 通知中心面板（Teleport 到 body，fixed 定位） */
.notice-mask {
  position: fixed;
  inset: 0;
  z-index: 9000;
}
.notice-panel {
  position: fixed;
  top: 60px;
  right: 90px;
  width: 320px;
  max-height: 420px;
  z-index: 9001;
  display: flex;
  flex-direction: column;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}
.notice-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.notice-title {
  font-size: 14px;
  font-weight: 700;
}
.notice-empty {
  padding: 36px 0;
  text-align: center;
  color: var(--text-dim);
  font-size: 13px;
}
.notice-list {
  overflow-y: auto;
}
/* 下载中心 */
.dl-toggle {
  position: relative;
}
.dl-badge {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 11px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.dl-panel {
  width: 380px;
}
.dl-item {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.dl-item-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.dl-actions {
  display: inline-flex;
  gap: 4px;
  flex: none;
}
.dl-title {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dl-sub {
  margin-top: 3px;
  font-size: 12px;
  line-height: 1.5;
  word-break: break-all;
}
.dl-error .dl-title {
  color: var(--danger);
}
.dl-bar {
  margin-top: 7px;
  height: 5px;
  border-radius: 999px;
  background: var(--card-2);
  overflow: hidden;
}
.dl-bar-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--accent-2), var(--accent));
  transition: width 0.3s ease;
}
.dl-bar.is-indeterminate .dl-bar-fill {
  animation: dl-indeterminate 1.25s ease-in-out infinite;
}
@keyframes dl-indeterminate {
  from {
    transform: translateX(-120%);
  }
  to {
    transform: translateX(320%);
  }
}
.dl-dismiss {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 15px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}
.dl-dismiss:hover {
  color: var(--text);
}
/* 启动失败弹窗 */
.launchfail-modal {
  width: 480px;
}
.launchfail-text {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-dim);
  word-break: break-all;
  max-height: 220px;
  overflow-y: auto;
  white-space: pre-wrap;
}
.notice-item {
  display: flex;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
}
.notice-item:last-child {
  border-bottom: none;
}
.notice-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-top: 5px;
  flex-shrink: 0;
  background: var(--accent);
}
.notice-success .notice-dot {
  background: var(--ok);
}
.notice-error .notice-dot {
  background: var(--danger);
}
.notice-body {
  min-width: 0;
}
.notice-text {
  line-height: 1.5;
  word-break: break-all;
}
.notice-time {
  font-size: 11px;
  color: var(--text-dim);
}

.top-divider {
  width: 1px;
  height: 20px;
  background: var(--border);
  margin: 0 8px;
  flex-shrink: 0;
}

.win-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 34px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.win-btn svg {
  width: 15px;
  height: 15px;
}
.win-btn:hover {
  background: var(--card-2);
  color: var(--text);
}
.win-close:hover {
  background: var(--danger);
  color: #fff;
}

/* 内容区 */
.content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 22px 24px 28px;
}

/* ---------------- 整合包拖入遮罩 ---------------- */
.drop-mask {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  backdrop-filter: blur(2px);
  pointer-events: none; /* 遮罩不拦截拖拽事件，避免 dragleave 闪烁 */
}
.drop-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 52px 72px;
  border: 2px dashed var(--accent);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--accent) 8%, var(--card));
  color: var(--accent);
}
.drop-box svg {
  width: 48px;
  height: 48px;
}
.drop-title {
  font-size: 17px;
  font-weight: 600;
}

/* ---------------- 整合包导入确认弹窗 ---------------- */
.mp-modal {
  width: min(620px, calc(100vw - 40px));
  max-height: 88vh;
  overflow-y: auto;
}
.mp-title {
  font-size: 17px;
  margin-bottom: 18px;
}
.mp-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
}
.mp-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.mp-summary {
  margin: 10px 0 0;
  color: var(--text-dim);
  font-size: 11.5px;
}
.mp-label {
  font-size: 13px;
  color: var(--text-dim);
  margin: 16px 0 8px;
}
.mp-name-opts {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mp-name-opt {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 12px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--card-2);
  color: var(--text);
  font-size: 13px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
}
.mp-name-opt:hover {
  border-color: var(--text-dim);
}
.mp-name-opt.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.mp-radio {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--text-dim);
  flex-shrink: 0;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.mp-name-opt.active .mp-radio {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 3px var(--card), inset 0 0 0 8px var(--accent);
}
.mp-name-text {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.mp-name-label {
  flex-shrink: 0;
}
.mp-name-value {
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mp-name-opt.active .mp-name-value {
  color: var(--accent-2);
}
.mp-custom-name {
  width: 100%;
  margin-top: 9px;
}
.mp-conflict {
  display: grid;
  gap: 8px;
  margin-top: 13px;
  padding: 11px 12px;
  border: 1px solid color-mix(in srgb, #e5a323 48%, var(--border));
  border-radius: 9px;
  background: color-mix(in srgb, #e5a323 8%, var(--card));
  font-size: 11.5px;
  color: var(--text-dim);
}
.mp-conflict strong {
  color: var(--text);
}
.mp-conflict-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px 12px;
  margin-top: 3px;
}
.mp-conflict-actions label,
.mp-replace-confirm {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  line-height: 1.4;
}
.mp-conflict input {
  accent-color: var(--accent);
}
.mp-existing-select {
  margin-top: 3px;
}
.mp-impact {
  padding: 8px 9px;
  border-radius: 7px;
  background: var(--card-2);
  line-height: 1.55;
}
.mp-impact.danger {
  color: var(--danger);
}
.mp-error {
  font-size: 13px;
  color: var(--danger);
  line-height: 1.7;
  word-break: break-all;
}
.mp-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 22px;
}
</style>
