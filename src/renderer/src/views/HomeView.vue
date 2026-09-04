<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import {
  errText,
  exportLaunchLogs,
  killGame,
  launchGame,
  listJava,
  openDir,
  removeVersion,
  selectAccount,
  selectFile
} from '../api'
import { displayVersionName, displayVersionSub, fmtLastPlayed, isFavorite, progressMono, refreshAccounts, refreshInstalled, sortWithFavorite, store, toast, toggleFavorite, versionIconUrl } from '../store'
import Avatar from '../components/Avatar.vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import type { InstalledVersion, JavaInfo } from '@shared/types'
import banner1 from '../assets/banner1.png'
import banner2 from '../assets/banner2.png'
import banner3 from '../assets/banner3.png'

const LS_KEY = 'kamucl.lastVersion'

// ---------------- Banner 三图轮播（5s 自动切换，圆点可点） ----------------
const banners = [banner1, banner2, banner3]
const bannerIdx = ref(0)

/** 打开卡慕SaMa 的 B 站页面（经主进程 setWindowOpenHandler 转系统浏览器） */
function openBilibili() {
  window.open('https://space.bilibili.com/9596327')
}
let bannerTimer: ReturnType<typeof setInterval> | null = null

function startBannerTimer() {
  stopBannerTimer()
  bannerTimer = setInterval(() => {
    bannerIdx.value = (bannerIdx.value + 1) % banners.length
  }, 5000)
}

function stopBannerTimer() {
  if (bannerTimer) {
    clearInterval(bannerTimer)
    bannerTimer = null
  }
}

function goBanner(i: number) {
  bannerIdx.value = i
  startBannerTimer() // 手动切换后重新计时
}

onMounted(startBannerTimer)
onUnmounted(stopBannerTimer)

// ---------------- 版本选择（记住上次） ----------------
const selectedId = ref('')

watch(
  () => store.installed,
  (list) => {
    if (!list.length) {
      selectedId.value = ''
      return
    }
    const remembered = localStorage.getItem(LS_KEY) ?? ''
    const valid = list.some((v) => v.id === remembered)
    if (valid) selectedId.value = remembered
    else if (!list.some((v) => v.id === selectedId.value)) selectedId.value = list[0].id
  },
  { immediate: true }
)

watch(selectedId, (id) => {
  if (id) localStorage.setItem(LS_KEY, id)
})

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
/** 实例主显示名（统一语义）：26.2 · Fabric 0.19.5 / 26.2 */
const versionLabel = (v: InstalledVersion) => displayVersionName(v)
const loaderText = (v: InstalledVersion) =>
  v.loader ? `${cap(v.loader)} ${v.loaderVersion ?? ''}`.trim() : '纯净版'

const currentVersion = computed(() =>
  store.installed.find((v) => v.id === selectedId.value)
)
const capsuleLabel = computed(() =>
  currentVersion.value ? versionLabel(currentVersion.value) : '未安装版本'
)

const heroStatus = computed(() => {
  const version = currentVersion.value
  if (!version) return { text: '等待选择', tone: 'idle' }
  if (running.value) return { text: '游戏运行中', tone: 'running' }
  if (launching.value) return { text: '正在准备', tone: 'running' }
  if (version.failed) return { text: '安装失败', tone: 'error' }
  if (version.incomplete) return { text: '需要修复', tone: 'error' }
  return { text: '就绪', tone: 'ready' }
})

function openVersionSettings() {
  if (selectedId.value) localStorage.setItem(LS_KEY, selectedId.value)
  store.currentView = 'game'
}

// ---------------- 启动状态 ----------------
const launching = computed(() => store.launchState?.status === 'launching')
const running = computed(() => store.launchState?.status === 'running')
const launchFailed = computed(
  () =>
    store.launchState?.status === 'error' ||
    (store.launchState?.status === 'exited' && store.launchState.code !== 0)
)
const exportingLogs = ref(false)

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

const percent = computed(() =>
  store.progress ? Math.round(progressMono(store.progress) * 100) : 0
)

const launchText = computed(() => {
  if (running.value) return '结束游戏'
  if (launching.value) {
    const p = store.progress
    if (!p) return '正在启动…'
    let t = p.text
    if (p.source) t += ` · ${p.source}`
    return t
  }
  return '启动游戏'
})

async function startVersion(id: string) {
  if (!id) return
  if (launching.value || running.value) {
    toast('已有游戏正在运行或启动中', 'info')
    return
  }
  if (!store.selectedAccount) {
    toast('请先在账号页选择或添加一个账号', 'error')
    return
  }
  store.launchingVersionId = id
  store.launchingFolder = store.settings?.activeFolder ?? store.settings?.gameDir ?? ''
  try {
    await launchGame(id)
  } catch (e) {
    toast('启动失败：' + errText(e), 'error')
  }
}

async function onLaunchClick() {
  if (running.value) {
    try {
      await killGame()
    } catch (e) {
      toast('结束游戏失败：' + errText(e), 'error')
    }
    return
  }
  if (launching.value) return
  startVersion(selectedId.value)
}

// ---------------- 版本下拉胶囊 ----------------
const verOpen = ref(false)
const verBtnEl = ref<HTMLElement | null>(null)
const verMenuPos = reactive({ top: 0, left: 0, width: 220 })

function toggleVerMenu() {
  if (!verOpen.value && verBtnEl.value) {
    const r = verBtnEl.value.getBoundingClientRect()
    verMenuPos.top = r.bottom + 8
    verMenuPos.left = r.left
    verMenuPos.width = Math.max(r.width, 220)
  }
  verOpen.value = !verOpen.value
}

function chooseVersion(id: string) {
  selectedId.value = id
  verOpen.value = false
}

// ---------------- 最近游戏 ----------------
const recent = computed(() => sortWithFavorite(store.installed).slice(0, 4))
/** 版本选择器菜单：收藏置顶 */
const sortedInstalledMenu = computed(() => sortWithFavorite(store.installed))

// ---------------- 首页布局（模块排序与显隐驱动） ----------------
/** 模块在布局中的 order 与 visible（缺省显示在最后并显示） */
function layoutOf(key: string, col: 'main' | 'side'): { order: number; visible: boolean } {
  const arr = store.settings?.homeLayout?.[col] ?? []
  const idx = arr.findIndex((m) => m.key === key)
  return idx >= 0 ? { order: idx, visible: arr[idx].visible } : { order: 99, visible: true }
}

const cardMenu = reactive({ id: '', top: 0, left: 0 })
const cardMenuVersion = computed(() =>
  store.installed.find((v) => v.id === cardMenu.id)
)

function openCardMenu(e: MouseEvent, id: string) {
  if (cardMenu.id === id) {
    cardMenu.id = ''
    return
  }
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  cardMenu.top = r.bottom + 6
  cardMenu.left = Math.max(8, r.right - 150)
  cardMenu.id = id
}

const removeModal = reactive({
  open: false,
  target: null as InstalledVersion | null,
  busy: false
})

/** 打开该版本的版本文件夹（versions/<id>） */
async function openVersionFolder(id: string) {
  cardMenu.id = ''
  try {
    await openDir('versions/' + id)
  } catch (e) {
    toast('打开文件夹失败：' + errText(e), 'error')
  }
}

/** ⋯菜单·删除：弹二次确认框 */
function removeRecent(v: InstalledVersion) {
  cardMenu.id = ''
  removeModal.open = true
  removeModal.target = v
}

async function onConfirmRemove() {
  const v = removeModal.target
  if (!v || removeModal.busy) return
  removeModal.busy = true
  try {
    await removeVersion(v.id)
    await refreshInstalled()
    removeModal.open = false
    toast(`已删除 ${v.id}`, 'success')
  } catch (e) {
    toast('删除失败：' + errText(e), 'error')
  } finally {
    removeModal.busy = false
  }
}

// ---------------- 快速操作 ----------------
async function openGameDir() {
  try {
    await openDir('')
  } catch (e) {
    toast('打开目录失败：' + errText(e), 'error')
  }
}

const quickActions = [
  {
    label: '下载游戏',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="11" rx="5.5"/><path d="M7.5 10.8v3.4M5.8 12.5h3.4"/><circle cx="15.6" cy="11.9" r="0.6" fill="currentColor" stroke="none"/><circle cx="18" cy="13.6" r="0.6" fill="currentColor" stroke="none"/></svg>',
    act: () => (store.currentView = 'game')
  },
  {
    label: '打开游戏目录',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 11h18"/></svg>',
    act: openGameDir
  },
  {
    label: '下载模组',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8"/><path d="m8.5 11.5 3.5 3.5 3.5-3.5"/></svg>',
    act: () => (store.currentView = 'community')
  },
  {
    label: '管理模组',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/></svg>',
    act: () => (store.currentView = 'mods')
  },
  {
    label: '导入整合包',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4"/><path d="m7 8 5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg>',
    act: onImportModpack
  }
]

/** 快速操作·导入整合包：选文件后交给 App.vue 注册的全局导入确认弹窗 */
async function onImportModpack() {
  try {
    const p = await selectFile()
    if (!p) return
    if (store.importHandler) store.importHandler(p)
    else toast('导入功能尚未就绪，请稍后再试', 'error')
  } catch (e) {
    toast('整合包安装失败：' + errText(e), 'error')
  }
}

// ---------------- 日志抽屉 ----------------
const logOpen = ref(false)
const logBodyEl = ref<HTMLElement | null>(null)

watch(
  () => store.logs.length,
  async () => {
    if (!logOpen.value) return
    await nextTick()
    if (logBodyEl.value) logBodyEl.value.scrollTop = logBodyEl.value.scrollHeight
  }
)

function clearLogs() {
  store.logs = []
}

// ---------------- 右侧面板：系统信息 ----------------
const javas = ref<JavaInfo[]>([])
const javaChecked = ref(false)

onMounted(async () => {
  try {
    javas.value = await listJava()
  } catch {
    /* 检测失败按「未找到」展示 */
  } finally {
    javaChecked.value = true
  }
})

const javaText = computed(() => {
  if (javas.value.length) return javas.value[0].version
  return javaChecked.value ? '未找到' : '检测中…'
})

const memoryGB = computed(() => {
  const mb = store.settings?.memoryMB ?? 0
  if (!mb) return '—'
  return mb % 1024 === 0 ? `${mb / 1024} GB` : `${(mb / 1024).toFixed(1)} GB`
})
const memoryPct = computed(() =>
  Math.min(100, Math.round(((store.settings?.memoryMB ?? 0) / 16384) * 100))
)

const accountName = computed(() => store.selectedAccount?.username ?? '冒险家')
const isOffline = computed(() => store.selectedAccount?.type === 'offline')
const accountTypeLabel = computed(() => {
  const account = store.selectedAccount
  if (!account) return '尚未选择账号'
  if (account.type === 'microsoft') return 'Microsoft 正版 · 在线'
  if (account.type === 'yggdrasil') return `${account.providerName ?? '外置 Yggdrasil'} · 在线`
  return '离线账号'
})

/** 离线模式开关：在离线/微软账号间快速切换；无目标类型账号时引导去账号页 */
async function onToggleAccountType() {
  const cur = store.selectedAccount
  if (!cur) return
  const wantType = cur.type === 'offline' ? 'microsoft' : 'offline'
  const target = store.accounts.find((a) => a.type === wantType)
  if (!target) {
    toast(
      wantType === 'microsoft' ? '还没有微软账号，请先登录' : '还没有离线账号，请先添加',
      'info'
    )
    store.currentView = 'accounts'
    return
  }
  try {
    await selectAccount(target.id)
    await refreshAccounts()
    toast(`已切换到 ${target.username}（${wantType === 'microsoft' ? '微软正版' : '离线'}）`, 'success')
  } catch (e) {
    toast('切换账号失败：' + errText(e), 'error')
  }
}
</script>

<template>
  <div class="home">
    <!-- ================= 主列 ================= -->
    <div class="home-main">
      <!-- Banner 大卡片 -->
      <section
        class="banner"
        data-edit="banner"
        :style="{ order: layoutOf('banner', 'main').order }"
        v-show="layoutOf('banner', 'main').visible"
      >
        <!-- 三图轮播背景（绝对定位叠放，opacity 过渡） -->
        <img
          v-for="(src, i) in banners"
          :key="i"
          :src="src"
          class="banner-img"
          :class="{ active: i === bannerIdx }"
          alt=""
          aria-hidden="true"
        />
        <div class="banner-shade"></div>

        <div class="banner-content" :class="{ center: store.bannerAlign === 'center' }" data-edit="bannerText">
          <div class="hero-eyebrow">
            <span class="banner-hi">当前实例</span>
            <button ref="verBtnEl" class="ver-capsule" @click="toggleVerMenu">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 8 12 3 3 8v8l9 5 9-5Z" />
                <path d="m3 8 9 5 9-5" />
                <path d="M12 13v8" />
              </svg>
              <span class="ver-capsule-label">{{ capsuleLabel }}</span>
              <svg class="ver-chevron" :class="{ open: verOpen }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
          </div>
          <h1 class="banner-name">{{ currentVersion ? versionLabel(currentVersion) : '选择游戏版本' }}</h1>
          <p class="banner-sub">
            <template v-if="currentVersion">
              Minecraft {{ currentVersion.mcVersion }} · {{ loaderText(currentVersion) }}
            </template>
            <template v-else>安装或选择一个实例后即可开始冒险</template>
          </p>

          <div class="banner-actions">
            <button class="hero-settings-btn" :disabled="!currentVersion" @click="openVersionSettings">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.08V21h-4v-.08A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.08-.4H3v-4h.08A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.08V3h4v.08A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.13.38.34.72.6 1 .3.28.68.42 1.08.4H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
              </svg>
              版本设置
            </button>
            <!-- 启动按钮 -->
            <button
              class="launch-btn"
              data-edit="accent"
              :class="{ launching, running }"
              :disabled="launching || (!running && (!selectedId || !store.installed.length))"
              @click="onLaunchClick"
            >
              <span v-if="launching" class="launch-fill" :style="{ width: percent + '%' }"></span>
              <span class="launch-inner">
                <svg v-if="running" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                <svg v-else-if="!launching" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5Z" /></svg>
                <span class="launch-text">{{ launchText }}</span>
              </span>
            </button>
          </div>

          <div class="hero-runtime">
            <span class="hero-runtime-item">
              <small>运行环境</small>
              <strong>{{ javaText }}</strong>
            </span>
            <span class="hero-runtime-item">
              <small>内存分配</small>
              <strong>{{ memoryGB }}</strong>
            </span>
            <span class="hero-runtime-item hero-state" :class="heroStatus.tone">
              <small>运行状态</small>
              <strong><i></i>{{ heroStatus.text }}</strong>
            </span>
          </div>
        </div>

        <!-- 轮播圆点（点击切换，当前点 accent 实心） -->
        <div class="banner-dots">
          <button
            v-for="(_, i) in banners"
            :key="i"
            class="dot"
            :class="{ active: i === bannerIdx }"
            :aria-label="`切换到第 ${i + 1} 张`"
            @click="goBanner(i)"
          ></button>
        </div>
      </section>

      <!-- 启动日志抽屉 -->
      <section
        class="card log-drawer"
        data-edit="card"
        :style="{ order: layoutOf('logDrawer', 'main').order }"
        v-show="layoutOf('logDrawer', 'main').visible"
      >
        <div
          class="log-header"
          role="button"
          tabindex="0"
          @click="logOpen = !logOpen"
          @keydown.enter="logOpen = !logOpen"
        >
          <span class="log-title">
            <svg class="log-chevron" :class="{ open: logOpen }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m9 6 6 6-6 6" />
            </svg>
            启动日志
          </span>
          <span class="log-side">
            <span class="muted">{{ store.logs.length }} 行</span>
            <button v-if="store.logs.length" class="btn btn-ghost btn-sm" @click.stop="clearLogs">清空</button>
          </span>
        </div>
        <div v-show="logOpen" ref="logBodyEl" class="log-body">
          <div v-if="launchFailed" class="log-failure-result">
            <span>检测到本次游戏启动失败或异常退出。</span>
            <button class="btn btn-gold btn-sm" :disabled="exportingLogs" @click="exportFailureLogs">
              {{ exportingLogs ? '导出中…' : '导出错误日志' }}
            </button>
          </div>
          <div v-if="!store.logs.length" class="empty log-empty">暂无日志</div>
          <pre v-else class="log-lines"><div v-for="(line, i) in store.logs" :key="i" class="log-line">{{ line }}</div></pre>
        </div>
      </section>

      <!-- 最近游戏 -->
      <section
        class="block"
        :style="{ order: layoutOf('recentGames', 'main').order }"
        v-show="layoutOf('recentGames', 'main').visible"
      >
        <div class="block-head" data-edit="text">
          <h2 class="block-title">最近游戏</h2>
          <button class="link-btn" @click="store.currentView = 'game'">查看全部</button>
        </div>

        <div v-if="!store.installed.length" class="card empty recent-empty" data-edit="card">
          <span>还没有安装任何游戏版本</span>
          <button class="btn btn-gold btn-sm" @click="store.currentView = 'game'">去安装一个版本</button>
        </div>

        <div v-else class="recent-grid">
          <article v-for="v in recent" :key="v.id" class="recent-card" data-edit="card">
            <button
              class="fav-btn recent-fav"
              :class="{ on: isFavorite(v.id) }"
              :title="isFavorite(v.id) ? '取消收藏' : '收藏'"
              @click.stop="toggleFavorite(v.id)"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01Z" /></svg>
            </button>
            <!-- 实例图标（未设置时用等距草方块） -->
            <img v-if="versionIconUrl(v)" class="grass-icon inst-icon-img" :src="versionIconUrl(v)" alt="" />
            <svg v-else class="grass-icon" viewBox="0 0 48 48" aria-hidden="true">
              <polygon points="24,5 43,14.5 24,24 5,14.5" fill="#79c144" />
              <polygon points="5,14.5 24,24 24,29.5 5,20" fill="#5da236" />
              <polygon points="24,24 43,14.5 43,20 24,29.5" fill="#4e8a2f" />
              <polygon points="5,20 24,29.5 24,43 5,33.5" fill="#8b5e34" />
              <polygon points="24,29.5 43,20 43,33.5 24,43" fill="#6f4a29" />
              <polygon points="10,23 15,25.5 15,28 10,25.5" fill="#7a5230" opacity="0.8" />
              <polygon points="30,30 36,27 36,30 30,33" fill="#5e3d22" opacity="0.8" />
            </svg>
            <div class="recent-id">{{ versionLabel(v) }}</div>
            <div class="recent-loader muted">{{ displayVersionSub(v) }}</div>
            <div class="recent-played">最近游玩：{{ fmtLastPlayed(store.lastPlayed[v.id]) }}</div>
            <div class="recent-foot">
              <button
                class="play-btn"
                :title="`启动 ${v.id}`"
                :disabled="launching || removingId === v.id"
                @click="startVersion(v.id)"
              >
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5Z" /></svg>
              </button>
              <button class="icon-btn more-btn" title="更多" @click="openCardMenu($event, v.id)">
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="5" cy="12" r="1.8" />
                  <circle cx="12" cy="12" r="1.8" />
                  <circle cx="19" cy="12" r="1.8" />
                </svg>
              </button>
            </div>
          </article>
        </div>
      </section>
    </div>

    <!-- ================= 右侧面板（300px） ================= -->
    <aside class="home-side">
      <!-- 账户信息 -->
      <section
        class="card side-card"
        data-edit="card"
        :style="{ order: layoutOf('accountCard', 'side').order }"
        v-show="layoutOf('accountCard', 'side').visible"
      >
        <h3 class="side-title">账户信息</h3>

        <template v-if="store.selectedAccount">
          <div class="acc-head">
            <Avatar :size="48" />
            <div class="acc-meta" data-edit="text">
              <div class="acc-name">{{ store.selectedAccount.username }}</div>
              <div class="acc-type">{{ accountTypeLabel }}</div>
            </div>
            <button class="icon-btn" title="编辑账户" @click="store.currentView = 'accounts'">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              </svg>
            </button>
          </div>

          <div class="acc-rows">
            <button class="acc-row" @click="store.currentView = 'accounts'">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M8 3 4 7l4 4" />
                <path d="M4 7h16" />
                <path d="m16 21 4-4-4-4" />
                <path d="M20 17H4" />
              </svg>
              切换账户
            </button>
            <button class="acc-row" @click="store.currentView = 'accounts'">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" />
              </svg>
              账户设置
            </button>
            <div class="acc-row static" title="由当前账号类型决定">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
              </svg>
              <span>离线模式</span>
              <label class="switch static" title="在离线账号与微软账号之间快速切换">
                <input type="checkbox" :checked="isOffline" @change="onToggleAccountType" />
                <span class="switch-ui"></span>
              </label>
            </div>
          </div>
        </template>

        <template v-else>
          <div class="acc-head">
            <div class="acc-avatar empty">?</div>
            <div class="acc-meta">
              <div class="acc-name">未登录</div>
              <div class="acc-type">尚未选择账号</div>
            </div>
          </div>
          <button class="btn btn-gold add-acc-btn" @click="store.currentView = 'accounts'">去添加账号</button>
        </template>
      </section>

      <!-- 系统信息 -->
      <section
        class="card side-card"
        data-edit="card"
        :style="{ order: layoutOf('sysInfo', 'side').order }"
        v-show="layoutOf('sysInfo', 'side').visible"
      >
        <h3 class="side-title">系统信息</h3>
        <div class="sys-row">
          <span class="sys-key">Java 版本</span>
          <span class="sys-val">
            {{ javaText }}
            <svg v-if="javas.length" class="sys-icon ok" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            <svg v-else-if="javaChecked" class="sys-icon warn" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 21h20Z" /><path d="M12 10v5M12 18.5h.01" /></svg>
          </span>
        </div>
        <div class="sys-row sys-row-col">
          <div class="sys-row-top">
            <span class="sys-key">内存使用</span>
            <span class="sys-val">{{ memoryGB }}</span>
          </div>
          <div class="mem-bar">
            <div class="mem-fill" :style="{ width: memoryPct + '%' }"></div>
          </div>
        </div>
        <div class="sys-row">
          <span class="sys-key">启动器版本</span>
          <span class="sys-val">
            {{ __APP_VERSION__ }}
            <svg class="sys-icon ok" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
          </span>
        </div>
      </section>

      <!-- 快速操作（右栏空白区，首屏免滚动可达） -->
      <section
        class="card side-card"
        data-edit="card"
        :style="{ order: layoutOf('quickActions', 'side').order }"
        v-show="layoutOf('quickActions', 'side').visible"
      >
        <h3 class="side-title">快速操作</h3>
        <div class="quick-grid quick-grid-side">
          <button v-for="q in quickActions" :key="q.label" class="quick-card" data-edit="card" @click="q.act">
            <span class="quick-icon" v-html="q.icon"></span>
            <span class="quick-label">{{ q.label }}</span>
          </button>
        </div>
      </section>

      <!-- BILIBILI 卡慕SaMa -->
      <section
        class="card side-card bili-card"
        data-edit="card"
        :style="{ order: layoutOf('authorCard', 'side').order }"
        v-show="layoutOf('authorCard', 'side').visible"
      >
        <svg class="bili-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2.5" y="7" width="19" height="14" rx="3.5" />
          <path d="m8 2.5 3.5 4 3.5-4" />
          <path d="M8.5 12v3.5M15.5 12v3.5" />
        </svg>
        <h3 class="bili-title">卡慕SaMa</h3>
        <p class="bili-desc">由 世界上最伟大的UP主<br />卡慕SaMa 制作</p>
        <button class="btn bili-btn" @click="openBilibili">去 B 站看看</button>
      </section>
    </aside>

    <!-- 版本下拉菜单（Teleport 避免被 Banner 裁剪） -->
    <Teleport to="body">
      <div v-if="verOpen" class="menu-overlay" @click="verOpen = false"></div>
      <div
        v-if="verOpen"
        class="float-menu"
        :style="{ top: verMenuPos.top + 'px', left: verMenuPos.left + 'px', width: verMenuPos.width + 'px' }"
      >
        <button
          v-for="v in sortedInstalledMenu"
          :key="v.id"
          class="menu-item"
          :class="{ active: v.id === selectedId }"
          @click="chooseVersion(v.id)"
        >
          <svg v-if="isFavorite(v.id)" class="menu-fav" viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01Z" /></svg>
          <svg v-else-if="v.id === selectedId" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
          <span v-else class="menu-item-spacer"></span>
          {{ versionLabel(v) }}
        </button>
        <div v-if="!store.installed.length" class="menu-empty">暂无已安装版本</div>
      </div>
    </Teleport>

    <!-- 最近游戏 ⋯ 菜单 -->
    <Teleport to="body">
      <div v-if="cardMenu.id" class="menu-overlay" @click="cardMenu.id = ''"></div>
      <div
        v-if="cardMenu.id && cardMenuVersion"
        class="float-menu"
        :style="{ top: cardMenu.top + 'px', left: cardMenu.left + 'px' }"
      >
        <button class="menu-item" @click="cardMenu.id = ''; startVersion(cardMenuVersion!.id)">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M8 5.5v13l11-6.5Z" /></svg>
          启动
        </button>
        <button class="menu-item" @click="openVersionFolder(cardMenuVersion!.id)">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>
          打开文件夹
        </button>
        <button class="menu-item danger" @click="removeRecent(cardMenuVersion!)">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6Z" /><path d="M10 11v6M14 11v6" /></svg>
          删除
        </button>
      </div>
    </Teleport>

    <!-- 删除版本二次确认 -->
    <ConfirmModal
      :open="removeModal.open"
      title="删除版本"
      :message="`确定要删除版本「${removeModal.target?.id}」吗？该版本的游戏文件将被移除（共享的依赖库与资源会保留），此操作不可恢复。`"
      :busy="removeModal.busy"
      @cancel="removeModal.open = false"
      @confirm="onConfirmRemove"
    />
  </div>
</template>

<style scoped>
.home {
  display: flex;
  gap: 20px;
  align-items: flex-start;
}

/* ================= 主列 ================= */
.home-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* ---------------- Banner ---------------- */
.banner {
  position: relative;
  height: var(--banner-h);
  border-radius: 20px;
  overflow: hidden;
  border: 1px solid var(--border);
  flex-shrink: 0;
}
.banner-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
  transition: opacity 0.6s ease;
}
.banner-img.active {
  opacity: 1;
}
/* 文字遮罩保持深色渐变，保证白字可读 */
.banner-shade {
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, rgba(20, 28, 40, 0.72) 0%, rgba(20, 28, 40, 0.32) 45%, transparent 70%);
}
.banner-content {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  height: 100%;
  padding: 24px 28px;
}
/* Banner 文字位置：居中（默认靠左下） */
.banner-content.center {
  align-items: center;
  justify-content: center;
  text-align: center;
}
.banner-content.center .banner-actions {
  margin-top: auto;
}
.banner-content.center .hero-eyebrow,
.banner-content.center .hero-runtime {
  align-self: stretch;
}
.hero-eyebrow {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.banner-hi {
  flex-shrink: 0;
  padding: 5px 9px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 7px;
  background: rgba(7, 14, 16, 0.34);
  backdrop-filter: blur(8px);
  font-size: 12px;
  font-weight: 700;
  color: var(--bn-text);
  opacity: 0.96;
}
.banner-name {
  font-weight: 800;
  color: var(--bn-text);
  letter-spacing: 0.5px;
  line-height: 1.15;
  max-width: 78%;
  /* 超长实例名允许断行（最多两行），不侵入操作区。 */
  word-break: break-all;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: clamp(30px, 5vw, 46px);
  text-shadow: 0 3px 18px rgba(0, 0, 0, 0.34);
}
.banner-sub {
  font-size: 13px;
  color: var(--bn-text);
  opacity: 0.85;
}
.banner-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: auto;
}

.hero-settings-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  height: 50px;
  flex-shrink: 0;
  padding: 0 13px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 11px;
  background: rgba(8, 15, 17, 0.48);
  color: var(--bn-text);
  font: 600 13px inherit;
  cursor: pointer;
  white-space: nowrap;
  backdrop-filter: blur(10px);
  transition: background 0.16s ease, border-color 0.16s ease, transform 0.12s ease;
}
.hero-settings-btn:hover:not(:disabled) {
  background: rgba(8, 15, 17, 0.65);
  border-color: var(--accent-2);
}
.hero-settings-btn:active:not(:disabled) {
  transform: scale(0.97);
}
.hero-settings-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.hero-settings-btn svg {
  width: 16px;
  height: 16px;
}

/* 启动按钮 */
.launch-btn {
  position: relative;
  overflow: hidden;
  width: 196px;
  min-width: 164px;
  height: 50px;
  border: none;
  border-radius: 10px;
  background: var(--accent-grad);
  color: var(--on-accent);
  font-size: 16px;
  font-weight: 700;
  font-family: inherit;
  cursor: pointer;
  box-shadow: 0 6px 20px var(--accent-soft);
  transition: filter 0.18s ease, transform 0.12s ease, background 0.2s ease, box-shadow 0.2s ease;
}
.launch-btn:hover:not(:disabled) {
  filter: brightness(1.08);
}
.launch-btn:active:not(:disabled) {
  transform: scale(0.98);
}
.launch-btn:disabled {
  cursor: not-allowed;
}
.launch-btn.launching {
  filter: saturate(0.92);
}
.launch-btn.running {
  background: linear-gradient(135deg, #e5484d, #c73a3f);
  color: #fff;
  box-shadow: 0 6px 20px rgba(229, 72, 77, 0.3);
}
.launch-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  background: rgba(255, 255, 255, 0.28);
  transition: width 0.25s ease;
}
.launch-inner {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 0 10px;
}
.launch-inner svg {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
}
.launch-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.launching .launch-text {
  font-size: 12.5px;
  font-weight: 600;
}

/* 版本选择胶囊 */
.ver-capsule {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  min-width: 0;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(10, 10, 13, 0.45);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  color: var(--bn-text);
  font-size: 12.5px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.16s ease, background 0.16s ease;
}
.ver-capsule:hover {
  border-color: var(--accent-2);
  background: rgba(10, 10, 13, 0.6);
}
.ver-capsule > svg:first-child {
  width: 15px;
  height: 15px;
  color: var(--accent-2);
  flex-shrink: 0;
}
.ver-capsule-label {
  max-width: 210px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ver-chevron {
  width: 13px;
  height: 13px;
  color: var(--bn-text);
  opacity: 0.75;
  transition: transform 0.18s ease;
  flex-shrink: 0;
}
.ver-chevron.open {
  transform: rotate(180deg);
}
.menu-item-spacer {
  width: 13px;
  flex-shrink: 0;
}

.hero-runtime {
  display: grid;
  grid-template-columns: 1.25fr 1fr 0.9fr;
  width: min(100%, 560px);
  min-height: 48px;
  margin-top: 10px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 11px;
  background: rgba(7, 14, 16, 0.43);
  color: var(--bn-text);
  backdrop-filter: blur(10px);
  overflow: hidden;
}
.hero-runtime-item {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  min-width: 0;
  padding: 8px 13px;
}
.hero-runtime-item + .hero-runtime-item {
  border-left: 1px solid rgba(255, 255, 255, 0.12);
}
.hero-runtime-item small {
  font-size: 10px;
  opacity: 0.68;
}
.hero-runtime-item strong {
  overflow: hidden;
  font-size: 12px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hero-state strong {
  display: flex;
  align-items: center;
  gap: 6px;
}
.hero-state i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #aab2b0;
}
.hero-state.ready i,
.hero-state.running i {
  background: #55d66d;
  box-shadow: 0 0 0 3px rgba(85, 214, 109, 0.16);
}
.hero-state.error i {
  background: #ff6b6b;
  box-shadow: 0 0 0 3px rgba(255, 107, 107, 0.14);
}

/* 轮播圆点 */
.banner-dots {
  position: absolute;
  top: 18px;
  right: 20px;
  display: flex;
  gap: 7px;
  z-index: 1;
}
.dot {
  width: 6px;
  height: 6px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.4);
  cursor: pointer;
  transition: background 0.2s ease, transform 0.2s ease;
}
.dot:hover {
  transform: scale(1.3);
}
.dot.active {
  background: var(--accent);
}

/* ---------------- 日志抽屉 ---------------- */
.log-failure-result {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid color-mix(in srgb, #e5484d 34%, var(--border));
  background: color-mix(in srgb, #e5484d 10%, var(--card));
  color: var(--text);
  font-size: 12.5px;
}
.log-drawer {
  padding: 0;
  overflow: hidden;
}
.log-header {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 18px;
  cursor: pointer;
  transition: background 0.15s ease;
}
.log-header:hover {
  background: var(--card-2);
}
.log-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 14px;
}
.log-chevron {
  width: 14px;
  height: 14px;
  color: var(--text-dim);
  transition: transform 0.2s ease;
}
.log-chevron.open {
  transform: rotate(90deg);
}
.log-side {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
}
.log-body {
  max-height: 240px;
  overflow-y: auto;
  border-top: 1px solid var(--border);
  padding: 12px 18px;
  background: var(--bg);
}
.log-empty {
  padding: 24px;
}
.log-lines {
  font-family: 'Cascadia Code', Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-dim);
  user-select: text;
}
.log-line {
  white-space: pre-wrap;
  word-break: break-all;
}

/* ---------------- 区块标题 ---------------- */
.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.block-title {
  font-size: 17px;
  font-weight: 700;
}
.link-btn {
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 6px;
  transition: color 0.15s ease, background 0.15s ease;
}
.link-btn:hover {
  color: var(--accent-2);
  background: var(--accent-soft);
}

/* ---------------- 最近游戏 ---------------- */
.recent-empty {
  padding: 32px;
}
.recent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 14px;
  /* 严格限制在主列区域内，任何情况下不侵入右侧栏 */
  width: 100%;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
}
.recent-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 14px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  transition: border-color 0.16s ease, background 0.16s ease, transform 0.16s ease;
}
.recent-card:hover {
  border-color: var(--border-strong);
  background: var(--card-2);
}
.grass-icon {
  width: 40px;
  height: 40px;
  margin-bottom: 4px;
}
.inst-icon-img {
  object-fit: contain;
  image-rendering: pixelated;
}
/* 卡片右上角收藏星标 */
.recent-fav {
  position: absolute;
  top: 8px;
  right: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease, transform 0.12s ease;
  z-index: 2;
}
.recent-fav:hover {
  color: var(--accent);
  background: var(--accent-soft);
}
.recent-fav.on {
  color: #f5b301;
}
.menu-fav {
  color: #f5b301;
  flex-shrink: 0;
}
.recent-id {
  font-size: 14.5px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  /* 长实例名最多两行，完整可读且绝不撑破卡片 */
  word-break: break-all;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.35;
}
.recent-loader {
  font-size: 12px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.recent-played {
  font-size: 12px;
  color: var(--text-dim);
}
.recent-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
}
.play-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 50%;
  background: var(--accent-grad);
  color: var(--on-accent);
  cursor: pointer;
  box-shadow: 0 4px 12px var(--accent-soft);
  transition: filter 0.16s ease, transform 0.12s ease;
}
.play-btn:hover:not(:disabled) {
  filter: brightness(1.1);
}
.play-btn:active:not(:disabled) {
  transform: scale(0.94);
}
.play-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.play-btn svg {
  width: 14px;
  height: 14px;
  margin-left: 1px;
}
.more-btn {
  width: 30px;
  height: 30px;
}

/* ---------------- 快速操作 ---------------- */
.quick-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
}
/* 右栏形态：两列紧凑布局 */
.quick-grid-side {
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
}
.quick-grid-side .quick-card {
  height: 76px;
  gap: 6px;
  font-size: 12.5px;
}
.quick-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  height: 92px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);
  color: var(--text);
  font-size: 13.5px;
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.16s ease, background 0.16s ease, transform 0.12s ease;
}
.quick-card:hover {
  background: var(--card-2);
  border-color: var(--accent-deep);
}
.quick-card:active {
  transform: scale(0.98);
}
.quick-icon {
  display: flex;
  width: 24px;
  height: 24px;
  color: var(--accent);
}
.quick-icon :deep(svg) {
  width: 100%;
  height: 100%;
}
.quick-label {
  font-weight: 500;
}

/* ================= 右侧面板 ================= */
.home-side {
  width: 300px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.side-card {
  padding: 18px;
}
.side-title {
  font-size: 15px;
  font-weight: 700;
  margin-bottom: 14px;
}

/* 账户信息 */
.acc-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.acc-avatar {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  font-weight: 800;
  color: var(--on-accent);
  background: var(--accent-grad);
  flex-shrink: 0;
}
.acc-avatar.empty {
  background: transparent;
  border: 1.5px dashed var(--border);
  color: var(--text-dim);
  font-weight: 600;
}
.acc-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.acc-name {
  font-size: 15px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.acc-type {
  font-size: 12px;
  color: var(--text-dim);
}
.acc-rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 14px;
}
.acc-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--text);
  font-size: 13.5px;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
  text-align: left;
}
.acc-row:hover {
  background: var(--card-2);
  color: var(--accent-2);
}
.acc-row svg {
  width: 16px;
  height: 16px;
  color: var(--text-dim);
  flex-shrink: 0;
}
.acc-row:hover svg {
  color: var(--accent-2);
}
.acc-row.static {
  cursor: default;
}
.acc-row.static:hover {
  background: transparent;
  color: var(--text);
}
.acc-row.static:hover svg {
  color: var(--text-dim);
}
.acc-row.static .switch {
  margin-left: auto;
}
.add-acc-btn {
  width: 100%;
  margin-top: 14px;
}

/* 系统信息 */
.sys-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 0;
  border-bottom: 1px solid var(--border);
  font-size: 13.5px;
}
.sys-row:last-child {
  border-bottom: none;
}
.sys-row-col {
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
}
.sys-row-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.sys-key {
  color: var(--text-dim);
}
.sys-val {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-align: right;
  overflow: hidden;
}
.sys-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.sys-icon.ok {
  color: var(--ok);
}
.sys-icon.warn {
  color: var(--accent);
}
.mem-bar {
  height: 6px;
  border-radius: 999px;
  background: var(--card-2);
  border: 1px solid var(--border);
  overflow: hidden;
}
.mem-fill {
  height: 100%;
  background: var(--accent-grad);
  border-radius: 999px;
  transition: width 0.3s ease;
}

/* BILIBILI 卡慕SaMa（固定 bilibili 蓝，不随主题 accent 变化） */
.bili-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 6px;
  padding: 22px 18px;
  background: linear-gradient(160deg, rgba(0, 161, 214, 0.14), var(--card) 55%);
  border-color: rgba(0, 161, 214, 0.32);
}
.bili-icon {
  width: 34px;
  height: 34px;
  color: #00a1d6;
  margin-bottom: 2px;
}
.bili-title {
  font-size: 16px;
  font-weight: 800;
  letter-spacing: 0.5px;
}
.bili-desc {
  font-size: 12.5px;
  color: var(--text-dim);
  line-height: 1.7;
}
.bili-btn {
  width: 100%;
  margin-top: 10px;
  background: linear-gradient(135deg, #25c0f0 0%, #00a1d6 55%, #0088c0 100%);
  color: #fff;
  border: none;
}
.bili-btn:hover {
  filter: brightness(1.06);
}
</style>
