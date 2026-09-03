<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { Component } from 'vue'
import { errText, getSettings, installModpack, onInstallDone, onLaunchLog, onLaunchState, onProgress, probeModpack, selectFile } from './api'
import { exitEditMode, markNoticesRead, recordLastPlayed, refreshAccounts, refreshInstalled, store, toast } from './store'
import type { ViewName } from './store'
import type { CustomTheme, ModpackInfo, ThemeName } from '@shared/types'
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
    label: '游戏',
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
    key: 'servers',
    label: '服务器',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>'
  },
  {
    key: 'settings',
    label: '设置',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06-.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06-.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>'
  }
]

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
  }
]

/** 资源管理组是否展开（子级菜单显隐；当前在其中任一子页时强制展开高亮） */
const resourceExpanded = ref(true)
const inResourceGroup = computed(() =>
  ['mods', 'packs', 'shaders'].includes(store.currentView)
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
  const file = e.dataTransfer?.files?.[0]
  if (!file) return
  if (!/\.(mrpack|zip)$/i.test(file.name)) {
    toast('仅支持导入 .mrpack 或 .zip 格式的整合包', 'error')
    return
  }
  const filePath = window.kamucl.getFilePath(file)
  void openModpackImport(filePath)
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
}

const mpModal = reactive<ModpackModal>({
  open: false,
  probing: false,
  error: '',
  filePath: '',
  info: null,
  nameSource: 'file'
})

const mpFormatLabel = computed(() => (mpModal.info ? FORMAT_LABEL[mpModal.info.format] : ''))
const mpFormatTagClass = computed(() =>
  mpModal.info ? FORMAT_TAG_CLASS[mpModal.info.format] : ''
)

/** 拿到文件路径后先 probe 解析，弹确认框；解析失败在框内展示错误 */
async function openModpackImport(filePath: string) {
  if (!filePath) return
  Object.assign(mpModal, {
    open: true,
    probing: true,
    error: '',
    filePath,
    info: null,
    nameSource: 'file' as const
  })
  try {
    const info = await probeModpack(filePath)
    // 防止解析期间用户又发起了另一次导入，旧结果覆盖新弹窗
    if (mpModal.filePath === filePath) mpModal.info = info
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
  const filePath = mpModal.filePath
  const nameSource = mpModal.nameSource
  mpModal.open = false
  toast('开始解析并安装整合包…', 'info')
  void installModpack(filePath, { nameSource }).catch((e) => {
    toast('整合包安装失败：' + errText(e), 'error')
  })
}

/** 顶栏「导入」按钮：系统文件选择框选整合包 */
async function onImportClick() {
  try {
    const p = await selectFile()
    if (p) void openModpackImport(p)
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

function fmtNoticeTime(ts: number): string {
  const d = new Date(ts)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const today = new Date().toDateString() === d.toDateString()
  return today ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

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
    }),
    onInstallDone((r) => {
      store.installing.delete(r.versionId)
      store.progress = null
      if (r.ok) {
        toast(`版本 ${r.versionId} 安装完成`, 'success')
        void refreshInstalled()
      } else {
        toast('安装失败：' + (r.error ?? '未知错误'), 'error')
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
      if (s.status === 'error') toast('游戏启动出错：' + s.text, 'error')
      else if (s.status === 'exited')
        toast(s.code ? `游戏已退出（代码 ${s.code}）` : '游戏已退出', 'info')
    })
  )

  try {
    await Promise.all([
      (async () => {
        store.settings = await getSettings()
        await Promise.all([refreshAccounts(), refreshInstalled()])
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
  <div
    class="shell"
    :class="{ 'edit-mode': store.editMode }"
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
        <template v-for="item in navItems" :key="item.key">
          <button
            class="nav-item"
            :class="{ active: store.currentView === item.key }"
            @click="store.currentView = item.key"
          >
            <span class="nav-icon" v-html="item.icon"></span>
            <span class="nav-label">{{ item.label }}</span>
          </button>

          <!-- 资源管理子级菜单（插在「游戏」之后） -->
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
                v-for="sub in resourceSubItems"
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
          <button class="top-btn" @click="store.currentView = 'game'">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3v11" />
              <path d="m7 10 5 5 5-5" />
              <path d="M4 21h16" />
            </svg>
            下载
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
        <p class="drop-title">松开鼠标导入整合包（.mrpack / .zip）</p>
      </div>
    </div>
  </Teleport>

  <!-- 整合包导入确认弹窗 -->
  <Teleport to="body">
    <div v-if="mpModal.open" class="modal-mask" @click.self="closeModpackImport">
      <div class="modal">
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

          <p class="mp-label">实例命名</p>
          <div class="mp-name-opts">
            <button
              class="mp-name-opt"
              :class="{ active: mpModal.nameSource === 'file' }"
              @click="mpModal.nameSource = 'file'"
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
              @click="mpModal.nameSource = 'inner'"
            >
              <span class="mp-radio"></span>
              <span class="mp-name-text">
                <span class="mp-name-label">使用整合包名称</span>
                <span class="mp-name-value">{{ mpModal.info.innerName }}</span>
              </span>
            </button>
          </div>

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
