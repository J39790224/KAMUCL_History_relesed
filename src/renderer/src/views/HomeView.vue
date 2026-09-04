<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import {
  errText,
  exportLaunchLogs,
  getSkinProfile,
  killGame,
  launchGame,
  listJava,
  openDir,
  removeVersion
} from '../api'
import {
  displayVersionName,
  displayVersionSub,
  fmtLastPlayed,
  isFavorite,
  progressMono,
  refreshInstalled,
  sortWithFavorite,
  store,
  toast,
  toggleFavorite,
  versionIconUrl
} from '../store'
import Avatar from '../components/Avatar.vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import SkinViewer3D from '../components/SkinViewer3D.vue'
import type {
  ImageFit,
  InstalledVersion,
  JavaInfo,
  ProfileSkins,
  SkinVariant
} from '@shared/types'
import { managedImageUrl } from '../managedAssets'
import banner1 from '../assets/banner1.png'
import banner2 from '../assets/banner2.png'
import banner3 from '../assets/banner3.png'

const LAST_VERSION_KEY = 'kamucl.lastVersion'
const builtInBanners = [banner1, banner2, banner3]

// ---------------- 当前实例与展示图 ----------------
const selectedId = ref('')

watch(
  () => store.installed,
  (versions) => {
    if (!versions.length) {
      selectedId.value = ''
      return
    }
    const remembered = localStorage.getItem(LAST_VERSION_KEY) ?? ''
    if (versions.some((version) => version.id === remembered)) {
      selectedId.value = remembered
    } else if (!versions.some((version) => version.id === selectedId.value)) {
      selectedId.value = versions[0].id
    }
  },
  { immediate: true }
)

watch(selectedId, (id) => {
  if (id) localStorage.setItem(LAST_VERSION_KEY, id)
})

const currentVersion = computed(() =>
  store.installed.find((version) => version.id === selectedId.value)
)
const versionLabel = (version: InstalledVersion) => displayVersionName(version)
const cap = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)
const loaderText = (version: InstalledVersion) =>
  version.loader ? `${cap(version.loader)} ${version.loaderVersion ?? ''}`.trim() : '正式版'
const heroVersion = computed(() =>
  currentVersion.value?.mcVersion || (currentVersion.value ? versionLabel(currentVersion.value) : '—')
)

function fitCss(fit: ImageFit): 'fill' | 'contain' | 'cover' {
  return fit === 'fill' ? 'fill' : fit === 'fit' ? 'contain' : 'cover'
}

const failedBanner = ref('')
const customBanner = computed(() => {
  const version = currentVersion.value
  if (version?.thumbnail) {
    return {
      path: version.thumbnail,
      src: managedImageUrl(version.thumbnail),
      fit: version.thumbnailFit ?? ('crop' as ImageFit)
    }
  }
  const global = store.settings?.launchThumbnail
  if (global?.image) {
    return { path: global.image, src: managedImageUrl(global.image), fit: global.fit }
  }
  return null
})

const banners = computed(() => {
  const custom = customBanner.value
  if (custom && failedBanner.value !== custom.path) {
    return [{ src: custom.src, fit: fitCss(custom.fit), custom: true, path: custom.path }]
  }
  return builtInBanners.map((src) => ({
    src,
    fit: 'cover' as const,
    custom: false,
    path: src
  }))
})
const bannerIndex = ref(0)
let bannerTimer: ReturnType<typeof setInterval> | null = null

function stopBannerTimer() {
  if (bannerTimer) clearInterval(bannerTimer)
  bannerTimer = null
}

function startBannerTimer() {
  stopBannerTimer()
  if (banners.value.length < 2) return
  bannerTimer = setInterval(() => {
    bannerIndex.value = (bannerIndex.value + 1) % banners.value.length
  }, 6500)
}

watch(
  () => customBanner.value?.path ?? '',
  () => {
    failedBanner.value = ''
    bannerIndex.value = 0
    startBannerTimer()
  }
)

function onBannerError(item: { custom: boolean; path: string }) {
  if (!item.custom) return
  failedBanner.value = item.path
  bannerIndex.value = 0
  startBannerTimer()
  toast('启动卡缩略图不可用，已回退到内置图片', 'error')
}

// ---------------- 启动、设置与日志 ----------------
const launching = computed(() => store.launchState?.status === 'launching')
const running = computed(() => store.launchState?.status === 'running')
const launchFailed = computed(
  () =>
    store.launchState?.status === 'error' ||
    (store.launchState?.status === 'exited' && store.launchState.code !== 0)
)
const percent = computed(() =>
  store.progress ? Math.round(progressMono(store.progress) * 100) : 0
)
const launchText = computed(() => {
  if (running.value) return '结束游戏'
  if (launching.value) return store.progress?.text || '正在启动…'
  return '开始游戏'
})
const heroStatus = computed(() => {
  const version = currentVersion.value
  if (!version) return { text: '等待选择', tone: 'idle' }
  if (running.value) return { text: '游戏运行中', tone: 'running' }
  if (launching.value) return { text: '正在准备', tone: 'running' }
  if (launchFailed.value || version.failed || version.incomplete) {
    return { text: '需要检查', tone: 'error' }
  }
  return { text: '就绪', tone: 'ready' }
})

async function startVersion(id: string) {
  if (!id) return
  selectedId.value = id
  if (launching.value || running.value) {
    toast('已有游戏正在运行或启动中', 'info')
    return
  }
  if (!store.selectedAccount) {
    toast('请先在账户页选择或添加账号', 'error')
    store.currentView = 'accounts'
    return
  }
  store.launchingVersionId = id
  store.launchingFolder = store.settings?.activeFolder ?? store.settings?.gameDir ?? ''
  try {
    await launchGame(id)
  } catch (error) {
    toast('启动失败：' + errText(error), 'error')
  }
}

async function onLaunchClick() {
  if (running.value) {
    try {
      await killGame()
    } catch (error) {
      toast('结束游戏失败：' + errText(error), 'error')
    }
    return
  }
  if (!launching.value) await startVersion(selectedId.value)
}

function openVersionSettings() {
  if (selectedId.value) localStorage.setItem(LAST_VERSION_KEY, selectedId.value)
  store.currentView = 'game'
}

const logOpen = ref(false)
const logBody = ref<HTMLElement | null>(null)
const exportingLogs = ref(false)

watch(
  () => store.logs.length,
  async () => {
    if (!logOpen.value) return
    await nextTick()
    if (logBody.value) logBody.value.scrollTop = logBody.value.scrollHeight
  }
)

async function exportFailureLogs() {
  if (exportingLogs.value) return
  exportingLogs.value = true
  try {
    const saved = await exportLaunchLogs(store.launchingVersionId || selectedId.value)
    if (saved) toast(`错误日志已导出：${saved}`, 'success')
  } catch (error) {
    toast(`导出失败：${errText(error)}`, 'error')
  } finally {
    exportingLogs.value = false
  }
}

// ---------------- Java 与内存摘要 ----------------
const javas = ref<JavaInfo[]>([])
const javaChecked = ref(false)
const javaText = computed(() => {
  const versionJava = currentVersion.value?.javaPath
  if (versionJava) {
    const match = javas.value.find((java) => java.path === versionJava)
    return match
      ? `Java ${match.version} (${match.architecture ?? (match.is64Bit ? '64-bit' : '32-bit')})`
      : versionJava
  }
  const java = javas.value[0]
  if (java) {
    return `Java ${java.version} (${java.architecture ?? (java.is64Bit ? '64-bit' : '32-bit')})`
  }
  return javaChecked.value ? '未检测到 Java' : '正在检测…'
})
const memoryText = computed(() => {
  const mb = store.settings?.memoryMB ?? 0
  if (!mb) return '—'
  return mb % 1024 === 0 ? `${mb / 1024} GB` : `${(mb / 1024).toFixed(1)} GB`
})

async function loadJavaSummary() {
  try {
    javas.value = await listJava()
  } catch {
    javas.value = []
  } finally {
    javaChecked.value = true
  }
}

// ---------------- 账户与 3D 皮肤 ----------------
const accountName = computed(() => store.selectedAccount?.username ?? '未登录')
const accountTypeLabel = computed(() => {
  const account = store.selectedAccount
  if (!account) return '添加账户后开始游戏'
  if (account.type === 'microsoft') return 'Microsoft 正版账户'
  if (account.type === 'yggdrasil') return account.providerName ?? '外置 Yggdrasil'
  return '离线账户'
})

const skinProfile = ref<ProfileSkins | null>(null)
const skinLoading = ref(false)
const skinError = ref('')
let skinRequestToken = 0

const currentSkin = computed(() => skinProfile.value?.skins[0] ?? null)
const skinSrc = computed(() => currentSkin.value?.dataUrl ?? '')
const skinVariant = computed<SkinVariant>(() =>
  currentSkin.value?.variant === 'slim' ? 'slim' : 'classic'
)

async function reloadSkin() {
  const request = ++skinRequestToken
  skinError.value = ''
  skinProfile.value = null
  if (!store.selectedAccount) return
  skinLoading.value = true
  try {
    const profile = await getSkinProfile()
    if (request === skinRequestToken) skinProfile.value = profile
  } catch (error) {
    if (request === skinRequestToken) skinError.value = errText(error)
  } finally {
    if (request === skinRequestToken) skinLoading.value = false
  }
}

watch(
  () => store.selectedAccount?.id,
  () => void reloadSkin()
)

// ---------------- 我的实例与菜单 ----------------
const recent = computed(() => {
  const sorted = sortWithFavorite(store.installed)
  const selected = currentVersion.value
  if (!selected) return sorted.slice(0, 4)
  return [selected, ...sorted.filter((version) => version.id !== selected.id)].slice(0, 4)
})
const sortedInstalled = computed(() => sortWithFavorite(store.installed))

const versionMenu = reactive({ open: false, top: 0, left: 0, width: 230 })
const versionMenuButton = ref<HTMLElement | null>(null)

function toggleVersionMenu() {
  if (!versionMenu.open && versionMenuButton.value) {
    const bounds = versionMenuButton.value.getBoundingClientRect()
    versionMenu.top = Math.min(window.innerHeight - 300, bounds.bottom + 8)
    versionMenu.left = Math.max(8, Math.min(window.innerWidth - 250, bounds.right - 230))
  }
  versionMenu.open = !versionMenu.open
}

function chooseVersion(id: string) {
  selectedId.value = id
  versionMenu.open = false
}

const cardMenu = reactive({ id: '', top: 0, left: 0 })
const cardMenuVersion = computed(() =>
  store.installed.find((version) => version.id === cardMenu.id)
)

function openCardMenu(event: MouseEvent, id: string) {
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
  cardMenu.id = cardMenu.id === id ? '' : id
  cardMenu.top = Math.min(window.innerHeight - 150, bounds.bottom + 6)
  cardMenu.left = Math.max(8, Math.min(window.innerWidth - 166, bounds.right - 154))
}

async function openVersionFolder(id: string) {
  cardMenu.id = ''
  try {
    await openDir(`versions/${id}`)
  } catch (error) {
    toast('打开文件夹失败：' + errText(error), 'error')
  }
}

const removeModal = reactive({
  open: false,
  target: null as InstalledVersion | null,
  busy: false
})

function requestRemove(version: InstalledVersion) {
  cardMenu.id = ''
  removeModal.target = version
  removeModal.open = true
}

async function confirmRemove() {
  const version = removeModal.target
  if (!version || removeModal.busy) return
  removeModal.busy = true
  try {
    await removeVersion(version.id)
    await refreshInstalled()
    removeModal.open = false
    toast(`已删除 ${version.id}`, 'success')
  } catch (error) {
    toast('删除失败：' + errText(error), 'error')
  } finally {
    removeModal.busy = false
  }
}

onMounted(() => {
  startBannerTimer()
  void loadJavaSummary()
  void reloadSkin()
})

onUnmounted(() => {
  stopBannerTimer()
  skinRequestToken++
})
</script>

<template>
  <div class="home-dashboard">
    <div class="home-main">
      <section class="hero-card" data-edit="banner">
        <img
          v-for="(item, index) in banners"
          :key="item.path"
          :src="item.src"
          class="hero-image"
          :class="{ active: index === bannerIndex }"
          :style="{ objectFit: item.fit }"
          alt=""
          aria-hidden="true"
          @error="onBannerError(item)"
        />
        <div class="hero-shade"></div>

        <div class="hero-content" data-edit="bannerText">
          <span class="hero-kicker">当前版本</span>
          <h1>{{ heroVersion }}</h1>
          <div class="hero-edition">
            <span>Java 版</span>
            <span v-if="currentVersion" class="loader-badge">{{ loaderText(currentVersion) }}</span>
          </div>

          <div class="hero-actions">
            <div class="hero-secondary-actions">
              <button class="hero-settings" :disabled="!currentVersion" @click="openVersionSettings">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1.4 1.68V21h-4v-.08A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15 1.7 1.7 0 0 0 3 13.6H3v-4h.08A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10.4 3H14a1.7 1.7 0 0 0 1.4 1.6 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9 1.7 1.7 0 0 0 21 10.4V14a1.7 1.7 0 0 0-1.6 1Z" /></svg>
                版本设置
              </button>
              <button
                class="hero-more"
                :disabled="!currentVersion"
                title="更多实例操作"
                @click="currentVersion && openCardMenu($event, currentVersion.id)"
              >
                <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
              </button>
            </div>

            <div class="launch-combo" data-edit="accent">
              <button
                class="launch-main"
                :class="{ launching, running }"
                :disabled="launching || (!running && !currentVersion)"
                @click="onLaunchClick"
              >
                <span v-if="launching" class="launch-progress" :style="{ width: percent + '%' }"></span>
                <span class="launch-content">
                  <svg v-if="running" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                  <svg v-else viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5Z" /></svg>
                  <span>{{ launchText }}</span>
                </span>
              </button>
              <button ref="versionMenuButton" class="launch-arrow" title="选择游戏实例" @click="toggleVersionMenu">
                <svg :class="{ open: versionMenu.open }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg>
              </button>
            </div>
          </div>
        </div>
      </section>

      <section class="runtime-strip" data-edit="card">
        <button class="runtime-item" @click="store.currentView = 'settings'">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4M16 2v4M7 8h10a4 4 0 0 1 4 4v0a8 8 0 0 1-8 8h-2a8 8 0 0 1-8-8v0a4 4 0 0 1 4-4Z" /><path d="M8 13h8M9 17h6" /></svg>
          <span><small>运行环境</small><strong>{{ javaText }}</strong></span>
          <svg class="runtime-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6" /></svg>
        </button>
        <button class="runtime-item" @click="store.currentView = 'settings'">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="2" /><path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4M9 9h6v6H9Z" /></svg>
          <span><small>内存分配</small><strong>{{ memoryText }}</strong></span>
          <svg class="runtime-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6" /></svg>
        </button>
        <button class="runtime-item runtime-state" :class="heroStatus.tone" @click="logOpen = true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2-7 4 14 2-7h6" /></svg>
          <span><small>运行状态</small><strong><i></i>{{ heroStatus.text }}</strong></span>
          <svg class="runtime-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6" /></svg>
        </button>
      </section>

      <section class="instances-block">
        <div class="instances-head">
          <h2>我的实例</h2>
          <button class="manage-instances" @click="store.currentView = 'game'">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
            管理实例
          </button>
        </div>

        <div v-if="store.installed.length" class="instance-grid">
          <article
            v-for="version in recent"
            :key="version.id"
            class="instance-card"
            :class="{ selected: version.id === selectedId }"
            data-edit="card"
            @click="chooseVersion(version.id)"
          >
            <img v-if="versionIconUrl(version)" class="instance-icon image" :src="versionIconUrl(version)" alt="" />
            <svg v-else class="instance-icon" viewBox="0 0 48 48" aria-hidden="true"><polygon points="24,5 43,14.5 24,24 5,14.5" fill="#79c144" /><polygon points="5,14.5 24,24 24,29.5 5,20" fill="#5da236" /><polygon points="24,24 43,14.5 43,20 24,29.5" fill="#4e8a2f" /><polygon points="5,20 24,29.5 24,43 5,33.5" fill="#8b5e34" /><polygon points="24,29.5 43,20 43,33.5 24,43" fill="#6f4a29" /></svg>
            <div class="instance-copy">
              <strong :title="versionLabel(version)">{{ versionLabel(version) }}</strong>
              <span>{{ displayVersionSub(version) }}</span>
            </div>
            <button class="instance-more" title="更多" @click.stop="openCardMenu($event, version.id)">
              <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
            </button>
            <span class="instance-last">上次游玩：{{ fmtLastPlayed(store.lastPlayed[version.id]) }}</span>
            <button
              class="instance-play"
              :disabled="launching || running"
              :title="`启动 ${version.id}`"
              @click.stop="startVersion(version.id)"
            >
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5Z" /></svg>
            </button>
          </article>
        </div>
        <button v-else class="empty-instances" @click="store.currentView = 'game'">
          尚未安装游戏实例，点击前往版本管理
        </button>
      </section>
    </div>

    <aside class="home-side">
      <section class="account-panel" data-edit="card">
        <template v-if="store.selectedAccount">
          <div class="account-head">
            <Avatar :size="54" />
            <div class="account-copy" data-edit="text">
              <strong>{{ accountName }}</strong>
              <span><i></i>在线</span>
            </div>
            <button class="account-more" title="账户管理" @click="store.currentView = 'accounts'">
              <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
            </button>
          </div>
          <button class="account-provider" @click="store.currentView = 'accounts'">
            <span class="provider-mark" :class="store.selectedAccount.type">{{ store.selectedAccount.type === 'microsoft' ? 'M' : store.selectedAccount.type === 'yggdrasil' ? 'Y' : 'O' }}</span>
            <span>{{ accountTypeLabel }}</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6" /></svg>
          </button>
        </template>
        <template v-else>
          <div class="account-head">
            <div class="account-placeholder">?</div>
            <div class="account-copy"><strong>未登录</strong><span class="offline-state">请选择账户</span></div>
          </div>
          <button class="account-provider" @click="store.currentView = 'accounts'">
            <span class="provider-mark offline">+</span><span>添加或选择账户</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6" /></svg>
          </button>
        </template>
      </section>

      <section class="skin-panel" data-edit="card">
        <div class="skin-head">
          <div><h3>皮肤预览</h3><span>{{ currentSkin ? (skinVariant === 'slim' ? '纤细模型' : '经典模型') : '动态角色' }}</span></div>
          <button class="skin-refresh" :disabled="skinLoading || !store.selectedAccount" title="刷新皮肤" @click="reloadSkin">
            <svg :class="{ spinning: skinLoading }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M6.1 9A7 7 0 0 1 18 6l2 1M4 17l2 1a7 7 0 0 0 11.9-3" /></svg>
          </button>
        </div>
        <div class="skin-stage" @dblclick="store.currentView = store.selectedAccount ? 'skins' : 'accounts'">
          <div class="skin-aura"></div>
          <SkinViewer3D :src="skinSrc" :variant="skinVariant" />
          <div v-if="skinLoading" class="skin-overlay"><span class="spin"></span><span>正在加载皮肤…</span></div>
          <button v-else-if="!store.selectedAccount" class="skin-overlay action" @click="store.currentView = 'accounts'">登录后加载角色皮肤</button>
          <button v-else-if="skinError" class="skin-overlay action error" :title="skinError" @click="reloadSkin">皮肤加载失败，点击重试</button>
        </div>
        <button class="skin-tip" @click="store.currentView = store.selectedAccount ? 'skins' : 'accounts'">
          拖动可旋转 · 行走动画
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6" /></svg>
        </button>
      </section>
    </aside>

    <Teleport to="body">
      <div v-if="versionMenu.open" class="menu-overlay" @click="versionMenu.open = false"></div>
      <div
        v-if="versionMenu.open"
        class="float-menu"
        :style="{ top: versionMenu.top + 'px', left: versionMenu.left + 'px', width: versionMenu.width + 'px' }"
      >
        <button
          v-for="version in sortedInstalled"
          :key="version.id"
          class="menu-item"
          :class="{ active: version.id === selectedId }"
          @click="chooseVersion(version.id)"
        >
          <svg v-if="isFavorite(version.id)" viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01Z" /></svg>
          <span v-else class="menu-spacer"></span>
          {{ versionLabel(version) }}
        </button>
        <div v-if="!sortedInstalled.length" class="menu-empty">暂无已安装实例</div>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="cardMenu.id" class="menu-overlay" @click="cardMenu.id = ''"></div>
      <div
        v-if="cardMenu.id && cardMenuVersion"
        class="float-menu card-float-menu"
        :style="{ top: cardMenu.top + 'px', left: cardMenu.left + 'px' }"
      >
        <button class="menu-item" @click="startVersion(cardMenuVersion.id); cardMenu.id = ''">启动实例</button>
        <button class="menu-item" @click="toggleFavorite(cardMenuVersion.id); cardMenu.id = ''">
          {{ isFavorite(cardMenuVersion.id) ? '取消收藏' : '收藏实例' }}
        </button>
        <button class="menu-item" @click="openVersionFolder(cardMenuVersion.id)">打开文件夹</button>
        <button class="menu-item danger" @click="requestRemove(cardMenuVersion)">删除实例</button>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="logOpen" class="log-mask" @click.self="logOpen = false">
        <section class="log-dialog">
          <header>
            <div><h3>启动日志</h3><span>{{ store.logs.length }} 行 · {{ heroStatus.text }}</span></div>
            <button class="log-close" title="关闭" @click="logOpen = false">×</button>
          </header>
          <div v-if="launchFailed" class="log-failure">
            <span>检测到启动失败或异常退出</span>
            <button :disabled="exportingLogs" @click="exportFailureLogs">{{ exportingLogs ? '导出中…' : '导出错误日志' }}</button>
          </div>
          <div ref="logBody" class="log-body">
            <p v-if="!store.logs.length" class="log-empty">暂无启动日志</p>
            <pre v-else><span v-for="(line, index) in store.logs" :key="index">{{ line }}</span></pre>
          </div>
          <footer><button class="btn btn-ghost btn-sm" :disabled="!store.logs.length" @click="store.logs = []">清空日志</button></footer>
        </section>
      </div>
    </Teleport>

    <ConfirmModal
      :open="removeModal.open"
      title="删除版本"
      :message="`确定要删除版本「${removeModal.target?.id}」吗？该版本的游戏文件将被移除（共享依赖与资源保留），此操作不可恢复。`"
      :busy="removeModal.busy"
      @cancel="removeModal.open = false"
      @confirm="confirmRemove"
    />
  </div>
</template>

<style scoped>
.home-dashboard {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 286px;
  gap: 14px;
  width: 100%;
  max-width: 1160px;
  margin: 0 auto;
  min-width: 0;
  min-height: calc(100vh - 132px);
}
.home-main {
  display: flex;
  min-width: 0;
  min-height: inherit;
  flex-direction: column;
  gap: 14px;
}
.hero-card {
  position: relative;
  height: var(--banner-h);
  min-height: 330px;
  flex: none;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--border) 95%, white 4%);
  border-radius: 16px;
  background: #17231f;
  box-shadow: 0 16px 38px rgba(0, 0, 0, 0.18);
}
.hero-image { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; transition: opacity 0.8s ease; }
.hero-image.active { opacity: 1; }
.hero-shade {
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, rgba(8, 14, 15, 0.66), rgba(8, 14, 15, 0.24) 54%, rgba(8, 14, 15, 0.08)), linear-gradient(0deg, rgba(5, 10, 9, 0.38), transparent 52%);
}
.hero-content { position: relative; z-index: 1; display: flex; height: 100%; padding: 48px 36px 30px; flex-direction: column; align-items: flex-start; color: var(--bn-text); }
.hero-kicker { display: inline-flex; align-items: center; min-height: 34px; padding: 0 14px; border: 1px solid rgba(255, 255, 255, 0.13); border-radius: 7px; background: rgba(9, 13, 14, 0.48); backdrop-filter: blur(12px); font-size: 13px; font-weight: 650; }
.hero-content h1 { max-width: 78%; margin-top: 18px; overflow: hidden; color: #fff; font-size: clamp(46px, 5.2vw, 64px); font-weight: 850; line-height: 1; letter-spacing: -1px; text-overflow: ellipsis; text-shadow: 0 4px 24px rgba(0, 0, 0, 0.32); white-space: nowrap; }
.hero-edition { display: flex; align-items: center; gap: 12px; margin-top: 16px; font-size: 17px; font-weight: 650; }
.loader-badge { padding: 5px 11px; border: 1px solid color-mix(in srgb, var(--accent-2) 34%, transparent); border-radius: 999px; background: color-mix(in srgb, var(--accent) 30%, rgba(20, 30, 24, 0.46)); color: #f6fff8; font-size: 11px; font-weight: 650; }
.hero-actions { display: flex; width: 100%; margin-top: auto; align-items: flex-end; justify-content: space-between; gap: 18px; }
.hero-secondary-actions, .launch-combo { display: flex; align-items: stretch; }
.hero-settings, .hero-more { height: 52px; border: 1px solid rgba(255, 255, 255, 0.14); background: rgba(10, 16, 17, 0.58); color: #f4f7f5; backdrop-filter: blur(13px); cursor: pointer; }
.hero-settings { display: inline-flex; align-items: center; gap: 10px; min-width: 150px; padding: 0 18px; border-radius: 10px 0 0 10px; font-family: inherit; font-size: 14px; font-weight: 650; }
.hero-settings svg { width: 18px; height: 18px; }
.hero-more { width: 52px; border-left: 0; border-radius: 0 10px 10px 0; }
.hero-more svg { width: 19px; height: 19px; }
.hero-settings:hover:not(:disabled), .hero-more:hover:not(:disabled) { background: rgba(19, 29, 29, 0.76); }
.hero-settings:disabled, .hero-more:disabled { opacity: 0.45; cursor: default; }
.launch-combo { min-width: 310px; height: 70px; border-radius: 11px; box-shadow: 0 10px 28px color-mix(in srgb, var(--accent) 30%, transparent); overflow: hidden; }
.launch-main, .launch-arrow { position: relative; overflow: hidden; border: 0; background: var(--accent-grad); color: var(--on-accent); cursor: pointer; }
.launch-main { flex: 1; min-width: 0; padding: 0 24px; font-family: inherit; font-size: 20px; font-weight: 750; }
.launch-content { position: relative; z-index: 1; display: flex; align-items: center; justify-content: center; gap: 12px; }
.launch-content svg { width: 22px; height: 22px; flex: none; }
.launch-content span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.launch-progress { position: absolute; inset: 0 auto 0 0; background: rgba(255, 255, 255, 0.25); transition: width 0.25s ease; }
.launch-main.running { background: linear-gradient(135deg, #eb6267, #c83d43); }
.launch-main:disabled { cursor: not-allowed; filter: saturate(0.75); }
.launch-arrow { width: 62px; border-left: 1px solid rgba(255, 255, 255, 0.22); }
.launch-arrow:hover, .launch-main:hover:not(:disabled) { filter: brightness(1.08); }
.launch-arrow svg { width: 22px; height: 22px; transition: transform 0.18s ease; }
.launch-arrow svg.open { transform: rotate(180deg); }

.runtime-strip { display: grid; grid-template-columns: 1.12fr 0.95fr 0.92fr; min-height: 78px; flex: none; overflow: hidden; border: 1px solid var(--border); border-radius: 13px; background: color-mix(in srgb, var(--card) 80%, transparent); box-shadow: var(--shadow); }
.runtime-item { display: grid; grid-template-columns: 34px minmax(0, 1fr) 15px; align-items: center; gap: 11px; min-width: 0; padding: 0 18px; border: 0; background: transparent; color: var(--text); text-align: left; cursor: pointer; }
.runtime-item + .runtime-item { border-left: 1px solid var(--border); }
.runtime-item:hover { background: var(--hover); }
.runtime-item > svg:first-child { width: 27px; height: 27px; color: var(--text); }
.runtime-item > span { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
.runtime-item small { color: var(--text-dim); font-size: 10px; }
.runtime-item strong { overflow: hidden; font-size: 13px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.runtime-chevron { width: 14px; height: 14px; color: var(--text-dim); opacity: 0.7; }
.runtime-state > svg:first-child { color: var(--accent-2); }
.runtime-state strong { display: flex; align-items: center; gap: 7px; color: var(--accent-2); }
.runtime-state i { width: 7px; height: 7px; flex: none; border-radius: 50%; background: #9ca3af; }
.runtime-state.ready i, .runtime-state.running i { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); }
.runtime-state.error strong { color: var(--danger); }
.runtime-state.error i { background: var(--danger); box-shadow: 0 0 0 3px var(--danger-soft); }

.instances-block { min-width: 0; margin-top: 28px; }
.instances-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 11px; }
.instances-head h2 { font-size: 17px; font-weight: 750; }
.manage-instances { display: inline-flex; align-items: center; gap: 7px; min-height: 34px; padding: 0 12px; border: 1px solid var(--border); border-radius: 9px; background: var(--card-2); color: var(--text-dim); font-family: inherit; font-size: 12px; font-weight: 550; cursor: pointer; }
.manage-instances:hover { color: var(--text); border-color: var(--border-strong); }
.manage-instances svg { width: 15px; height: 15px; }
.instance-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.instance-card { position: relative; display: grid; grid-template-columns: 50px minmax(0, 1fr) 24px; grid-template-rows: 1fr auto; gap: 8px 11px; min-width: 0; min-height: 130px; padding: 17px 14px 13px; border: 1px solid var(--border); border-radius: 13px; background: color-mix(in srgb, var(--card) 82%, transparent); cursor: pointer; transition: border-color 0.18s ease, background 0.18s ease, transform 0.15s ease; }
.instance-card:hover { border-color: var(--border-strong); background: var(--card-2); transform: translateY(-1px); }
.instance-card.selected { border-color: var(--accent-2); box-shadow: inset 0 0 0 1px var(--accent), 0 8px 24px var(--accent-soft); }
.instance-icon { align-self: center; width: 48px; height: 48px; }
.instance-icon.image { object-fit: contain; image-rendering: pixelated; }
.instance-copy { align-self: center; display: flex; min-width: 0; flex-direction: column; gap: 4px; }
.instance-copy strong { overflow: hidden; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.instance-copy span, .instance-last { overflow: hidden; color: var(--text-dim); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.instance-more { align-self: start; width: 24px; height: 24px; border: 0; border-radius: 7px; background: transparent; color: var(--text-dim); cursor: pointer; }
.instance-more:hover { background: var(--hover); color: var(--text); }
.instance-more svg { width: 15px; height: 15px; }
.instance-last { grid-column: 1 / 3; align-self: center; }
.instance-play { display: inline-flex; align-items: center; justify-content: center; width: 38px; height: 32px; justify-self: end; border: 0; border-radius: 8px; background: color-mix(in srgb, var(--accent) 18%, var(--card-2)); color: var(--accent-2); cursor: pointer; }
.instance-play:hover:not(:disabled) { background: var(--accent); color: var(--on-accent); }
.instance-play:disabled { opacity: 0.45; cursor: default; }
.instance-play svg { width: 15px; height: 15px; }
.empty-instances { width: 100%; min-height: 110px; border: 1px dashed var(--border-strong); border-radius: 13px; background: var(--card); color: var(--text-dim); cursor: pointer; }

.home-side { display: flex; min-width: 0; flex-direction: column; gap: 12px; }
.account-panel, .skin-panel { border: 1px solid var(--border); border-radius: 14px; background: color-mix(in srgb, var(--card) 78%, transparent); box-shadow: var(--shadow); }
.account-panel { min-height: 146px; padding: 18px; }
.account-head { display: flex; align-items: center; gap: 13px; }
.account-head :deep(.mc-avatar) { border-radius: 12px; box-shadow: 0 0 0 4px color-mix(in srgb, var(--text) 8%, transparent); }
.account-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 5px; }
.account-copy strong { overflow: hidden; font-size: 16px; text-overflow: ellipsis; white-space: nowrap; }
.account-copy span { display: flex; align-items: center; gap: 7px; color: var(--accent-2); font-size: 11px; }
.account-copy span i { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); }
.account-copy .offline-state { color: var(--text-dim); }
.account-more, .skin-refresh { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border: 0; border-radius: 8px; background: transparent; color: var(--text-dim); cursor: pointer; }
.account-more:hover, .skin-refresh:hover:not(:disabled) { color: var(--text); background: var(--hover); }
.account-more svg, .skin-refresh svg { width: 17px; height: 17px; }
.account-placeholder { display: flex; align-items: center; justify-content: center; width: 54px; height: 54px; border: 1px dashed var(--border-strong); border-radius: 12px; color: var(--text-dim); font-size: 20px; }
.account-provider { display: grid; grid-template-columns: 26px minmax(0, 1fr) 15px; align-items: center; gap: 10px; width: 100%; min-height: 44px; margin-top: 15px; padding: 0 11px; border: 1px solid var(--border); border-radius: 9px; background: var(--card-2); color: var(--text); font-family: inherit; font-size: 12px; font-weight: 550; text-align: left; cursor: pointer; }
.account-provider:hover { border-color: var(--border-strong); }
.account-provider > svg { width: 15px; height: 15px; color: var(--text-dim); }
.provider-mark { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 6px; background: linear-gradient(135deg, #f35325 0 48%, #81bc06 48% 100%); color: #fff; font-size: 10px; font-weight: 800; }
.provider-mark.yggdrasil { background: linear-gradient(135deg, #65bd78, #268e54); }
.provider-mark.offline { background: var(--card); color: var(--text-dim); }

.skin-panel { min-height: 352px; padding: 15px 14px 12px; }
.skin-head { display: flex; align-items: flex-start; justify-content: space-between; padding: 0 2px 8px; }
.skin-head > div { display: flex; flex-direction: column; gap: 3px; }
.skin-head h3 { font-size: 14px; font-weight: 700; }
.skin-head span { color: var(--text-dim); font-size: 10px; }
.skin-refresh:disabled { opacity: 0.4; cursor: default; }
.skin-refresh .spinning { animation: spin 0.8s linear infinite; }
.skin-stage { position: relative; height: 260px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--border) 78%, transparent); border-radius: 11px; background: radial-gradient(circle at 50% 82%, color-mix(in srgb, var(--accent) 13%, transparent), transparent 38%), linear-gradient(180deg, transparent, color-mix(in srgb, var(--bg) 18%, transparent)); }
.skin-stage :deep(.viewer3d) { height: 100%; --sv3d-height: 100%; background: transparent; }
.skin-aura { position: absolute; z-index: 0; left: 50%; bottom: 17px; width: 126px; height: 25px; border: 2px solid color-mix(in srgb, var(--accent-2) 62%, transparent); border-radius: 50%; background: color-mix(in srgb, var(--accent) 18%, transparent); box-shadow: 0 0 18px color-mix(in srgb, var(--accent) 46%, transparent), inset 0 0 18px color-mix(in srgb, var(--accent) 25%, transparent); transform: translateX(-50%); }
.skin-overlay { position: absolute; z-index: 2; right: 12px; bottom: 12px; left: 12px; display: flex; min-height: 34px; align-items: center; justify-content: center; gap: 9px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 9px; background: color-mix(in srgb, var(--card) 78%, transparent); color: var(--text-dim); font-family: inherit; font-size: 11px; font-weight: 550; backdrop-filter: blur(12px); }
.skin-overlay.action { cursor: pointer; }
.skin-overlay.action:hover { color: var(--text); }
.skin-overlay.error { color: var(--danger); }
.skin-tip { display: flex; align-items: center; justify-content: center; gap: 5px; width: 100%; margin-top: 8px; border: 0; background: transparent; color: var(--text-dim); font-family: inherit; font-size: 10px; font-weight: 500; cursor: pointer; }
.skin-tip:hover { color: var(--accent-2); }
.skin-tip svg { width: 12px; height: 12px; }

.menu-overlay { position: fixed; inset: 0; z-index: 8000; }
.float-menu { position: fixed; z-index: 8001; max-height: 280px; overflow-y: auto; padding: 6px; border: 1px solid var(--border); border-radius: 10px; background: color-mix(in srgb, var(--card) 94%, transparent); box-shadow: var(--shadow-lg); backdrop-filter: blur(24px); }
.card-float-menu { width: 154px; }
.menu-item { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 34px; padding: 0 10px; border: 0; border-radius: 7px; background: transparent; color: var(--text); font-family: inherit; font-size: 12px; font-weight: 500; text-align: left; cursor: pointer; }
.menu-item:hover, .menu-item.active { background: var(--accent-soft); color: var(--accent-2); }
.menu-item.danger { color: var(--danger); }
.menu-spacer { width: 12px; flex: none; }
.menu-empty { padding: 20px 8px; color: var(--text-dim); font-size: 12px; text-align: center; }

.log-mask { position: fixed; z-index: 9100; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--mask); backdrop-filter: blur(5px); }
.log-dialog { display: flex; width: min(760px, calc(100vw - 64px)); max-height: min(620px, calc(100vh - 80px)); flex-direction: column; overflow: hidden; border: 1px solid var(--border); border-radius: 16px; background: color-mix(in srgb, var(--card) 94%, transparent); box-shadow: var(--shadow-lg); }
.log-dialog header { display: flex; align-items: center; justify-content: space-between; padding: 16px 18px; border-bottom: 1px solid var(--border); }
.log-dialog header div { display: flex; flex-direction: column; gap: 3px; }
.log-dialog h3 { font-size: 16px; }
.log-dialog header span { color: var(--text-dim); font-size: 11px; }
.log-close { width: 32px; height: 32px; border: 0; border-radius: 8px; background: transparent; color: var(--text-dim); font-size: 20px; cursor: pointer; }
.log-close:hover { background: var(--hover); color: var(--text); }
.log-failure { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 18px; background: var(--danger-soft); color: var(--danger); font-size: 12px; }
.log-failure button { padding: 6px 10px; border: 1px solid var(--danger-border); border-radius: 7px; background: transparent; color: var(--danger); cursor: pointer; }
.log-body { min-height: 220px; flex: 1; overflow: auto; padding: 14px 18px; background: color-mix(in srgb, var(--bg) 42%, transparent); user-select: text; }
.log-body pre { display: flex; flex-direction: column; color: var(--text-dim); font: 11.5px/1.65 'Cascadia Code', Consolas, monospace; white-space: pre-wrap; word-break: break-all; }
.log-empty { padding: 70px 0; color: var(--text-dim); text-align: center; }
.log-dialog footer { display: flex; justify-content: flex-end; padding: 11px 16px; border-top: 1px solid var(--border); }

@media (max-width: 1180px) {
  .home-dashboard { grid-template-columns: minmax(0, 1fr) 248px; gap: 12px; }
  .hero-content { padding: 38px 26px 25px; }
  .launch-combo { min-width: 242px; height: 62px; }
  .launch-main { padding: 0 16px; font-size: 17px; }
  .launch-arrow { width: 50px; }
  .hero-settings { min-width: 126px; padding: 0 13px; }
  .hero-more { width: 46px; }
  .runtime-item { grid-template-columns: 28px minmax(0, 1fr); padding: 0 12px; }
  .runtime-item > svg:first-child { width: 23px; height: 23px; }
  .runtime-chevron { display: none; }
  .instance-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 1010px) {
  .home-dashboard { grid-template-columns: minmax(0, 1fr) 226px; }
  .hero-card { min-height: 320px; }
  .hero-content h1 { font-size: 42px; }
  .hero-actions { gap: 10px; }
  .hero-settings { min-width: 112px; font-size: 12px; }
  .launch-combo { min-width: 210px; }
  .launch-main { font-size: 15px; }
  .runtime-item { padding: 0 9px; gap: 8px; }
  .runtime-item strong { font-size: 11px; }
  .skin-panel { padding-inline: 10px; }
}

@media (max-height: 760px) {
  .home-dashboard { min-height: 660px; }
  .hero-card { height: 340px; }
  .hero-content { padding-top: 30px; }
  .skin-stage { height: 230px; }
  .skin-panel { min-height: 322px; }
}
</style>
