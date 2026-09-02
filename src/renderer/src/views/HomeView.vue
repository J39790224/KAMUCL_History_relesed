<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { errText, killGame, launchGame, listJava, openDir, removeVersion } from '../api'
import { fmtLastPlayed, refreshInstalled, store, toast } from '../store'
import Avatar from '../components/Avatar.vue'
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
/** 胶囊/卡片显示用版本名，如「26.2-Fabric」 */
const versionLabel = (v: InstalledVersion) =>
  v.loader && !v.id.toLowerCase().includes(v.loader) ? `${v.id}-${cap(v.loader)}` : v.id
const loaderText = (v: InstalledVersion) =>
  v.loader ? `${cap(v.loader)} ${v.loaderVersion ?? ''}`.trim() : '纯净版'

const currentVersion = computed(() =>
  store.installed.find((v) => v.id === selectedId.value)
)
const capsuleLabel = computed(() =>
  currentVersion.value ? versionLabel(currentVersion.value) : '未安装版本'
)

// ---------------- 启动状态 ----------------
const launching = computed(() => store.launchState?.status === 'launching')
const running = computed(() => store.launchState?.status === 'running')

const percent = computed(() =>
  store.progress ? Math.round(store.progress.progress * 100) : 0
)

const launchText = computed(() => {
  if (running.value) return '结束游戏'
  if (launching.value) return store.progress?.text || '正在启动…'
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
const recent = computed(() =>
  [...store.installed]
    .sort((a, b) => (store.lastPlayed[b.id] ?? 0) - (store.lastPlayed[a.id] ?? 0))
    .slice(0, 4)
)

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

const removingId = ref<string | null>(null)

/** 打开该版本的版本文件夹（versions/<id>） */
async function openVersionFolder(id: string) {
  cardMenu.id = ''
  try {
    await openDir('versions/' + id)
  } catch (e) {
    toast('打开文件夹失败：' + errText(e), 'error')
  }
}

async function removeRecent(v: InstalledVersion) {
  cardMenu.id = ''
  removingId.value = v.id
  try {
    await removeVersion(v.id)
    await refreshInstalled()
    toast(`已删除 ${v.id}`, 'success')
  } catch (e) {
    toast('删除失败：' + errText(e), 'error')
  } finally {
    removingId.value = null
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
    label: '下载资源',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/></svg>',
    act: () => (store.currentView = 'game')
  },
  {
    label: '打开游戏目录',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 11h18"/></svg>',
    act: openGameDir
  },
  {
    label: '安装模组',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/></svg>',
    act: () => (store.currentView = 'mods')
  },
  {
    label: '导入整合包',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4"/><path d="m7 8 5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg>',
    act: () => toast('敬请期待')
  }
]

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
</script>

<template>
  <div class="home">
    <!-- ================= 主列 ================= -->
    <div class="home-main">
      <!-- Banner 大卡片 -->
      <section class="banner" data-edit="banner">
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
          <p class="banner-hi">欢迎回来！</p>
          <h1 class="banner-name">{{ accountName }}</h1>
          <p class="banner-sub">准备好开启新的冒险了吗？</p>

          <div class="banner-actions">
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

            <!-- 版本选择胶囊 -->
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
      <section class="card log-drawer" data-edit="card">
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
          <div v-if="!store.logs.length" class="empty log-empty">暂无日志</div>
          <pre v-else class="log-lines"><div v-for="(line, i) in store.logs" :key="i" class="log-line">{{ line }}</div></pre>
        </div>
      </section>

      <!-- 最近游戏 -->
      <section class="block">
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
            <!-- 等距草方块图标 -->
            <svg class="grass-icon" viewBox="0 0 48 48" aria-hidden="true">
              <polygon points="24,5 43,14.5 24,24 5,14.5" fill="#79c144" />
              <polygon points="5,14.5 24,24 24,29.5 5,20" fill="#5da236" />
              <polygon points="24,24 43,14.5 43,20 24,29.5" fill="#4e8a2f" />
              <polygon points="5,20 24,29.5 24,43 5,33.5" fill="#8b5e34" />
              <polygon points="24,29.5 43,20 43,33.5 24,43" fill="#6f4a29" />
              <polygon points="10,23 15,25.5 15,28 10,25.5" fill="#7a5230" opacity="0.8" />
              <polygon points="30,30 36,27 36,30 30,33" fill="#5e3d22" opacity="0.8" />
            </svg>
            <div class="recent-id">{{ v.id }}</div>
            <div class="recent-loader">{{ loaderText(v) }}</div>
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

      <!-- 快速操作 -->
      <section class="block">
        <div class="block-head" data-edit="text">
          <h2 class="block-title">快速操作</h2>
        </div>
        <div class="quick-grid">
          <button v-for="q in quickActions" :key="q.label" class="quick-card" data-edit="card" @click="q.act">
            <span class="quick-icon" v-html="q.icon"></span>
            <span class="quick-label">{{ q.label }}</span>
          </button>
        </div>
      </section>
    </div>

    <!-- ================= 右侧面板（300px） ================= -->
    <aside class="home-side">
      <!-- 账户信息 -->
      <section class="card side-card" data-edit="card">
        <h3 class="side-title">账户信息</h3>

        <template v-if="store.selectedAccount">
          <div class="acc-head">
            <Avatar :size="48" />
            <div class="acc-meta" data-edit="text">
              <div class="acc-name">{{ store.selectedAccount.username }}</div>
              <div class="acc-type">{{ store.selectedAccount.type === 'microsoft' ? '微软正版' : '离线模式' }}</div>
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
              <label class="switch static">
                <input type="checkbox" :checked="isOffline" disabled />
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
      <section class="card side-card" data-edit="card">
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
            {__APP_VERSION__}
            <svg class="sys-icon ok" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
          </span>
        </div>
      </section>

      <!-- BILIBILI 卡慕SaMa -->
      <section class="card side-card bili-card" data-edit="card">
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
          v-for="v in store.installed"
          :key="v.id"
          class="menu-item"
          :class="{ active: v.id === selectedId }"
          @click="chooseVersion(v.id)"
        >
          <svg v-if="v.id === selectedId" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
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
  padding: 34px 36px;
}
/* Banner 文字位置：居中（默认靠左下） */
.banner-content.center {
  align-items: center;
  justify-content: center;
  text-align: center;
}
.banner-content.center .banner-actions {
  margin-top: 18px;
}
.banner-hi {
  font-size: 14px;
  color: var(--bn-text);
  opacity: 0.9;
}
.banner-name {
  font-size: 34px;
  font-weight: 800;
  color: var(--bn-text);
  letter-spacing: 0.5px;
  line-height: 1.15;
  max-width: 70%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.banner-sub {
  font-size: 13px;
  color: var(--bn-text);
  opacity: 0.85;
}
.banner-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: auto;
}

/* 启动按钮 */
.launch-btn {
  position: relative;
  overflow: hidden;
  width: 170px;
  height: 44px;
  border: none;
  border-radius: 10px;
  background: var(--accent-grad);
  color: var(--on-accent);
  font-size: 15px;
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
  height: 44px;
  padding: 0 16px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(10, 10, 13, 0.45);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  color: var(--bn-text);
  font-size: 13.5px;
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
  max-width: 180px;
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

/* 轮播圆点 */
.banner-dots {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
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
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
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
.recent-id {
  font-size: 14.5px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
