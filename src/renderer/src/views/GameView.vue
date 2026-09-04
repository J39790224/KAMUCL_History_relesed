<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { cleanupPartialInstall, errText, formatSpeed, getManifest, getSettings, installVersion, listFabricApi, listJava, listLoaders, openDir, removeVersion, renameVersion, saveSettings, setVersionIsolation, setVersionJava } from '../api'
import { displayVersionName, displayVersionSub, fmtLastPlayed, isFavorite, progressMono, refreshInstalled, renameLastPlayed, sortWithFavorite, store, toast, toggleFavorite, versionIconUrl } from '../store'
import ConfirmModal from '../components/ConfirmModal.vue'
import IconPickerModal from '../components/IconPickerModal.vue'
import type {
  FabricApiVersion,
  InstallOptions,
  InstalledVersion,
  LoaderName,
  RemoteVersion
} from '@shared/types'

// ---------------- 清单加载 ----------------
const manifest = ref<RemoteVersion[]>([])
const loading = ref(false)
const loadError = ref('')

/** 顶部 Tab：版本下载 / 已安装（消灭内层嵌套滚动，localStorage 记忆） */
const TAB_KEY = 'kamucl.gameTab'
const tab = ref<'download' | 'installed'>(
  (localStorage.getItem(TAB_KEY) as 'download' | 'installed') === 'installed'
    ? 'installed'
    : 'download'
)
watch(tab, (t) => localStorage.setItem(TAB_KEY, t))

async function load(refresh = false) {
  loading.value = true
  loadError.value = ''
  try {
    manifest.value = await getManifest(refresh)
  } catch (e) {
    loadError.value = errText(e)
  } finally {
    loading.value = false
  }
}

onMounted(() => load())

// ---------------- 搜索与筛选（搜索框联动顶栏 store.searchKeyword） ----------------
type TypeFilter = 'all' | 'release' | 'snapshot' | 'old'
const typeFilter = ref<TypeFilter>('release')

const typeFilters: Array<{ value: TypeFilter; label: string }> = [
  { value: 'release', label: '正式版' },
  { value: 'all', label: '全部' },
  { value: 'snapshot', label: '快照' },
  { value: 'old', label: '旧版' }
]

const typeText: Record<RemoteVersion['type'], string> = {
  release: '正式版',
  snapshot: '快照',
  old_beta: 'Beta 旧版',
  old_alpha: 'Alpha 旧版'
}

/* release 金 / snapshot 青灰 / 旧版 dim */
const typeTagClass = (t: RemoteVersion['type']) =>
  t === 'release' ? 'tag-gold' : t === 'snapshot' ? 'tag-cyan' : ''

const keyword = computed(() => store.searchKeyword.trim().toLowerCase())

/** ETA 由主进程基于字节速度指数平滑；未知总量/暂停时不伪造。 */
const etaText = computed(() => {
  const p = store.progress
  const eta = p?.etaSeconds
  if (eta == null || !Number.isFinite(eta) || eta <= 3) return ''
  if (eta >= 3600) return `约剩 ${Math.ceil(eta / 3600)}h`
  if (eta >= 60) return `约剩 ${Math.ceil(eta / 60)}min`
  return `约剩 ${Math.round(eta)}s`
})

const filtered = computed(() =>
  manifest.value.filter((v) => {
    if (keyword.value && !v.id.toLowerCase().includes(keyword.value)) return false
    if (typeFilter.value === 'all') return true
    if (typeFilter.value === 'old') return v.type === 'old_beta' || v.type === 'old_alpha'
    return v.type === typeFilter.value
  })
)

const formatDate = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('zh-CN')
}

const isInstalled = (v: RemoteVersion) => store.installed.some((i) => i.mcVersion === v.id)

// ---------------- 安装模态框 ----------------
const loaderOptions: Array<{ value: '' | LoaderName; label: string }> = [
  { value: '', label: '不安装' },
  { value: 'forge', label: 'Forge' },
  { value: 'fabric', label: 'Fabric' },
  { value: 'quilt', label: 'Quilt' },
  { value: 'neoforge', label: 'NeoForge' }
]

const modal = reactive({
  open: false,
  version: null as RemoteVersion | null,
  loader: '' as '' | LoaderName,
  loaderVersions: [] as string[],
  loaderVersion: '',
  loadingLoaders: false,
  loadLoadersError: '',
  // Fabric API 联动
  apiOn: true,
  apiVersions: [] as FabricApiVersion[],
  apiVersion: '',
  loadingApi: false,
  apiError: '',
  instanceName: '',
  instanceEdited: false
})

/** 默认实例名（加载器类型+版本自动生成；纯净版固定为 MC 版本号） */
const defaultInstanceName = computed(() => {
  const mc = modal.version?.id ?? ''
  if (!modal.loader) return mc
  if (modal.loader === 'forge') return `${mc}-forge-${modal.loaderVersion || '?'}`
  if (modal.loader === 'neoforge') return `neoforge-${modal.loaderVersion || '?'}`
  return `${modal.loader}-loader-${modal.loaderVersion || '?'}-${mc}`
})

/** 实例名冲突/非法校验（返回错误文案，合法为 ''；与主进程 validateInstanceName 同规则） */
const instanceError = computed(() => {
  const n = (modal.instanceEdited ? modal.instanceName : defaultInstanceName.value).trim()
  if (!n) return '实例名不能为空'
  if (n.length > 64) return '实例名过长（最多 64 字符）'
  if (/[\\/:*?"<>|]/.test(n)) return '实例名不能包含 \\ / : * ? " < > | 字符'
  if (/^[.\s]|[.\s]$/.test(n)) return '实例名不能以空格或点开头/结尾'
  if (store.installed.some((v) => v.id === n)) return `实例「${n}」已存在，请改名后安装`
  return ''
})

/** 实际生效的实例名（纯净版默认 MC 版本号，加载器实例按规则生成，均可自定义） */
const effectiveInstanceName = computed(() =>
  modal.instanceEdited ? modal.instanceName.trim() : defaultInstanceName.value
)

function openInstall(v: RemoteVersion) {  modal.open = true
  modal.version = v
  modal.loader = ''
  modal.loaderVersions = []
  modal.loaderVersion = ''
  modal.loadingLoaders = false
  modal.loadLoadersError = ''
  modal.apiOn = true
  modal.apiVersions = []
  modal.apiVersion = ''
  modal.loadingApi = false
  modal.apiError = ''
  modal.instanceName = ''
  modal.instanceEdited = false
}

watch(
  () => modal.loader,
  async (loader) => {
    modal.loaderVersions = []
    modal.loaderVersion = ''
    modal.loadLoadersError = ''
    modal.apiVersions = []
    modal.apiVersion = ''
    modal.apiError = ''
    if (!loader || !modal.version) return
    modal.loadingLoaders = true
    try {
      const list = await listLoaders(loader, modal.version.id)
      modal.loaderVersions = list
      modal.loaderVersion = list[0] ?? ''
      if (!list.length) modal.loadLoadersError = '该版本暂无可用的加载器版本'
    } catch (e) {
      modal.loadLoadersError = '获取加载器版本失败：' + errText(e)
    } finally {
      modal.loadingLoaders = false
    }
    // 选择 Fabric 时联动拉取 Fabric API 版本列表
    if (loader === 'fabric' && modal.version) {
      modal.loadingApi = true
      try {
        const list = await listFabricApi(modal.version.id)
        modal.apiVersions = list
        modal.apiVersion = list[0]?.version ?? ''
        if (!list.length) modal.apiError = '该版本暂无适配的 Fabric API'
      } catch (e) {
        modal.apiError = '获取 Fabric API 列表失败：' + errText(e)
      } finally {
        modal.loadingApi = false
      }
    }
  }
)

const canConfirm = computed(
  () =>
    !!modal.version &&
    !modal.loadingLoaders &&
    (modal.loader === '' || !!modal.loaderVersion) &&
    !instanceError.value
)

async function confirmInstall() {
  const v = modal.version
  if (!v || !canConfirm.value) return
  const opts: InstallOptions = modal.loader
    ? {
        loader: modal.loader,
        loaderVersion: modal.loaderVersion || undefined,
        fabricApi:
          modal.loader === 'fabric' && modal.apiOn && modal.apiVersion
            ? modal.apiVersion
            : undefined,
        instanceName: effectiveInstanceName.value || undefined
      }
    : { instanceName: effectiveInstanceName.value || undefined }
  modal.open = false
  // 主进程后台异步下载，invoke 仅表示任务已受理；
  // 完成/失败由 App.vue 订阅的 installDone 事件统一提示并刷新已安装列表
  store.installing.add(v.id)
  toast(`开始下载版本 ${v.id}，请稍候…`, 'info')
  try {
    await installVersion(v.id, opts)
  } catch (e) {
    store.installing.delete(v.id)
    toast('安装失败：' + errText(e), 'error')
  }
}

// ---------------- 已安装区 ----------------
const removeModal = reactive({
  open: false,
  target: null as InstalledVersion | null,
  busy: false
})

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

/** 清理安装失败的残留目录 */
async function onCleanup(id: string) {
  try {
    await cleanupPartialInstall(id)
    await refreshInstalled()
    toast('残留已清理', 'success')
  } catch (e) {
    toast('清理失败：' + errText(e), 'error')
  }
}

/** 打开该版本的版本文件夹（versions/<id>） */
async function openVersionFolder(v: InstalledVersion) {
  try {
    await openDir('versions/' + v.id)
  } catch (e) {
    toast('打开文件夹失败：' + errText(e), 'error')
  }
}

// ---------------- 版本隔离开关 ----------------
const isoBusy = ref<string | null>(null)

// ---------------- 管理快捷菜单 ----------------
const manageMenu = reactive({ id: '', top: 0, left: 0 })

/** 下载源切换（镜像 ⇄ 官方），持久化并刷新版本清单 */
async function onToggleMirror() {
  const next = store.settings?.mirror === 'bmclapi' ? 'official' : 'bmclapi'
  try {
    await saveSettings({ mirror: next })
    store.settings = await getSettings()
    toast(next === 'bmclapi' ? '已切换为 BMCLAPI 镜像源' : '已切换为官方源', 'success')
    void load(true)
  } catch (e) {
    toast('切换下载源失败：' + errText(e), 'error')
  }
}

/** 重试安装失败的版本 */
function onRetry(versionId: string) {
  store.failedInstalls.delete(versionId)
  store.installing.add(versionId)
  toast(`重新开始下载版本 ${versionId}…`, 'info')
  void installVersion(versionId, {}).catch((e) => {
    store.installing.delete(versionId)
    toast('安装失败：' + errText(e), 'error')
  })
}

/** 安装中的版本（进度条显示在已安装页顶部） */
const installingVersions = computed(() => [...store.installing])

/** 文件夹路径简写（取末级目录名） */
const folderShortName = (p: string): string => {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/** 收藏置顶 + 组内最近游玩倒序 */
const sortedInstalled = computed(() => sortWithFavorite(store.installed))
/** 已收藏分组（不含残缺/失败版本） */
const favoriteInstalled = computed(() =>
  store.installed.filter((v) => isFavorite(v.id) && !v.incomplete && !v.failed)
)

function openManageMenu(e: MouseEvent, id: string) {
  if (manageMenu.id === id) {
    manageMenu.id = ''
    return
  }
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  manageMenu.top = r.bottom + 6
  manageMenu.left = Math.max(8, r.right - 140)
  manageMenu.id = id
}

/** 跳转资源管理对应子页，并把上下文版本切到该版本 */
function goManage(view: 'mods' | 'packs' | 'shaders') {
  store.resourceVersionId = manageMenu.id
  manageMenu.id = ''
  store.currentView = view
}

// ---------------- 实例重命名 ----------------
const renameModal = reactive({ open: false, id: '', name: '', error: '', busy: false })

// ---------------- 实例图标 ----------------
const iconModal = reactive({ open: false, id: '', current: '' })

function openIconPicker(id: string) {
  iconModal.id = id
  iconModal.current = store.installed.find((v) => v.id === id)?.icon ?? ''
  iconModal.open = true
  manageMenu.id = ''
}

// ---------------- 指定 Java ----------------
const javaModal = reactive({
  open: false,
  id: '',
  value: '',
  list: [] as Awaited<ReturnType<typeof listJava>>,
  busy: false
})

async function openJavaModal() {
  javaModal.id = manageMenu.id
  manageMenu.id = ''
  javaModal.busy = true
  javaModal.open = true
  try {
    javaModal.list = await listJava()
    const cur = store.installed.find((v) => v.id === javaModal.id)
    javaModal.value = cur?.javaPath ?? ''
  } catch (e) {
    toast('读取 Java 列表失败：' + errText(e), 'error')
  } finally {
    javaModal.busy = false
  }
}

async function onConfirmJava() {
  try {
    await setVersionJava(javaModal.id, javaModal.value)
    await refreshInstalled()
    javaModal.open = false
    toast(javaModal.value ? '已为该版本指定 Java' : '已恢复自动匹配 Java', 'success')
  } catch (e) {
    toast('设置失败：' + errText(e), 'error')
  }
}

function openRename() {
  openRenameFor(manageMenu.id)
  manageMenu.id = ''
}

/** 点击版本名直接进入改名 */
function openRenameFor(id: string) {
  renameModal.id = id
  renameModal.name = id
  renameModal.error = ''
  renameModal.open = true
}

async function onConfirmRename() {
  if (renameModal.busy) return
  renameModal.busy = true
  renameModal.error = ''
  const oldId = renameModal.id
  const newId = renameModal.name.trim()
  try {
    await renameVersion(oldId, newId)
    // 引用同步（渲染端）：最近游玩记录以版本 id 为键（收藏/服务器绑定由主进程同步）
    renameLastPlayed(oldId, newId)
    await refreshInstalled()
    renameModal.open = false
    toast('实例已重命名', 'success')
  } catch (e) {
    renameModal.error = errText(e)
  } finally {
    renameModal.busy = false
  }
}

async function onToggleIsolation(v: InstalledVersion) {
  if (isoBusy.value) return
  isoBusy.value = v.id
  const next = !v.isolated
  try {
    await setVersionIsolation(v.id, next)
    await refreshInstalled()
    toast(
      next
        ? `已为「${v.id}」开启版本隔离，共享的存档与模组已复制进版本目录`
        : `已为「${v.id}」关闭版本隔离，将重新使用共享游戏目录`,
      'success'
    )
  } catch (e) {
    toast('切换隔离失败：' + errText(e), 'error')
  } finally {
    isoBusy.value = null
  }
}
</script>

<template>
  <div class="page">
    <!-- 标题 -->
    <div class="page-head">
      <h1 class="page-title">游戏版本</h1>
      <p class="page-sub">浏览、安装与管理 Minecraft 版本</p>
    </div>

    <!-- 顶部 Tab：版本下载 / 已安装 -->
    <div class="game-tabs">
      <button class="game-tab" :class="{ active: tab === 'download' }" @click="tab = 'download'">
        版本下载
      </button>
      <button class="game-tab" :class="{ active: tab === 'installed' }" @click="tab = 'installed'">
        已安装<template v-if="store.installed.length">（{{ store.installed.length }}）</template>
      </button>
    </div>

    <template v-if="tab === 'download'">
    <!-- 工具行 -->
    <div class="toolbar">
      <div class="tool-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input v-model="store.searchKeyword" placeholder="搜索版本号…" />
      </div>

      <div class="filter-capsules">
        <button
          v-for="f in typeFilters"
          :key="f.value"
          class="capsule"
          :class="{ active: typeFilter === f.value }"
          @click="typeFilter = f.value"
        >
          {{ f.label }}
        </button>
      </div>

      <button class="btn btn-ghost tool-refresh" :disabled="loading" @click="load(true)">
        <span v-if="loading" class="spin"></span>
        <svg v-else viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <path d="M21 3v6h-6" />
        </svg>
        {{ loading ? '刷新中' : '刷新' }}
      </button>

      <button
        class="tag mirror-toggle"
        :class="store.settings?.mirror === 'bmclapi' ? 'tag-cyan' : ''"
        :title="store.settings?.mirror === 'bmclapi' ? '当前：BMCLAPI 镜像源，点击切换为官方源' : '当前：官方源，点击切换为 BMCLAPI 镜像源'"
        @click="onToggleMirror"
      >
        {{ store.settings?.mirror === 'bmclapi' ? 'BMCLAPI 镜像' : '官方源' }}
      </button>
    </div>

    <!-- 版本列表 -->
    <div class="card list-card">
      <div v-if="loading && !manifest.length" class="empty">
        <span class="spin"></span>
        <span>正在获取版本列表…</span>
      </div>
      <div v-else-if="loadError" class="empty">
        <span>加载失败：{{ loadError }}</span>
        <button class="btn btn-ghost btn-sm" @click="load(true)">重试</button>
      </div>
      <div v-else-if="!filtered.length" class="empty">
        <span>{{ keyword || typeFilter !== 'all' ? '没有匹配的版本' : '版本列表为空' }}</span>
      </div>
      <div v-else class="version-list">
        <div v-for="v in filtered" :key="v.id" class="version-row">
          <div class="version-info">
            <span class="version-id">{{ v.id }}</span>
            <span class="tag" :class="typeTagClass(v.type)">{{ typeText[v.type] }}</span>
            <span class="muted version-date">{{ formatDate(v.releaseTime) }}</span>
          </div>
          <div class="version-actions">
            <div v-if="store.installing.has(v.id) && store.progress" class="row-progress">
              <div class="row-bar">
                <div class="row-bar-fill" :style="{ width: Math.round(progressMono(store.progress) * 100) + '%' }"></div>
              </div>
              <span class="muted row-progress-text">
                {{ Math.round(progressMono(store.progress) * 100) }}%
                {{ store.progress.speed ? '· ' + formatSpeed(store.progress.speed) : '' }}
                {{ etaText ? '· ' + etaText : '' }}
                {{ store.progress.source ? '· ' + store.progress.source : '' }}
              </span>
            </div>
            <span v-if="isInstalled(v)" class="tag tag-success">已安装</span>
            <button
              class="btn btn-sm"
              :class="isInstalled(v) ? 'btn-ghost' : 'btn-gold'"
              :disabled="store.installing.size > 0"
              @click="openInstall(v)"
            >
              {{ store.installing.has(v.id) ? '下载中' : isInstalled(v) ? '再安装' : '安装' }}
            </button>
          </div>
        </div>
      </div>
    </div>
    </template>

    <!-- 已安装区 -->
    <template v-else>
    <div class="card installed-card">
      <!-- 安装中（进度显示） -->
      <div v-if="installingVersions.length" class="installing-block">
        <div v-for="id in installingVersions" :key="id" class="installed-row installing-row">
          <div class="inst-names">
            <span class="version-id">{{ id }}</span>
            <span class="muted">正在下载安装…</span>
          </div>
          <div v-if="store.progress" class="row-progress">
            <div class="row-bar">
              <div class="row-bar-fill" :style="{ width: Math.round(progressMono(store.progress) * 100) + '%' }"></div>
            </div>
            <span class="muted row-progress-text">
              {{ Math.round(progressMono(store.progress) * 100) }}%
              {{ store.progress.speed ? '· ' + formatSpeed(store.progress.speed) : '' }}
            </span>
          </div>
        </div>
      </div>

      <!-- 安装失败（重试入口） -->
      <div v-for="id in [...store.failedInstalls].filter((x) => !installingVersions.includes(x))" :key="'fail-' + id" class="installed-row failed-row">
        <div class="inst-names">
          <span class="version-id">{{ id }}</span>
          <span class="muted">上次安装失败</span>
        </div>
        <button class="btn btn-ghost btn-sm installed-folder" @click="onRetry(id)">重试</button>
      </div>

      <div v-if="!store.installed.length && !installingVersions.length" class="empty installed-empty">
        <span>还没有安装任何版本</span>
        <button class="btn btn-gold btn-sm" @click="tab = 'download'">去版本下载看看</button>
      </div>
      <div v-else class="installed-list">
        <!-- 已收藏分组（置顶） -->
        <template v-if="favoriteInstalled.length">
          <div class="fav-group-head">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01Z" /></svg>
            已收藏
          </div>
          <div v-for="v in favoriteInstalled" :key="'fav-' + v.id" class="installed-row">
            <button class="fav-btn on" title="取消收藏" @click="toggleFavorite(v.id)">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01Z" /></svg>
            </button>
            <button class="inst-icon" title="更换实例图标" @click="openIconPicker(v.id)">
              <img v-if="versionIconUrl(v)" :src="versionIconUrl(v)" alt="" />
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/></svg>
            </button>
            <div class="inst-names">
              <span class="version-id editable" :title="`点击改名（目录名：${v.id}）`" @click="openRenameFor(v.id)">{{ displayVersionName(v) }}</span>
            </div>
            <span class="muted played-text">最近游玩：{{ fmtLastPlayed(store.lastPlayed[v.id]) }}</span>
          </div>
        </template>

        <div v-for="v in sortedInstalled" :key="v.id" class="installed-row">
          <button
            class="fav-btn"
            :class="{ on: isFavorite(v.id) }"
            :title="isFavorite(v.id) ? '取消收藏' : '收藏'"
            @click="toggleFavorite(v.id)"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01Z" /></svg>
          </button>
          <button class="inst-icon" title="更换实例图标" @click="openIconPicker(v.id)">
            <img v-if="versionIconUrl(v)" :src="versionIconUrl(v)" alt="" />
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/></svg>
          </button>
          <div class="inst-names">
            <span class="version-id editable" :title="`点击改名（目录名：${v.id}）`" @click="openRenameFor(v.id)">{{ displayVersionName(v) }}</span>
            <span v-if="displayVersionSub(v) !== displayVersionName(v)" class="muted inst-sub">
              {{ displayVersionSub(v) }}
            </span>
          </div>
          <!-- 下载未完成的残缺版本：继续下载 / 删除 -->
          <template v-if="v.incomplete">
            <span class="tag tag-danger">下载未完成</span>
            <button
              class="btn btn-gold btn-sm installed-folder"
              :disabled="store.installing.has(v.id)"
              @click="onRetry(v.id)"
            >
              继续下载
            </button>
            <button
              class="btn btn-danger btn-sm installed-remove"
              @click="removeModal.open = true; removeModal.target = v"
            >
              删除残留
            </button>
          </template>
          <!-- 安装事务失败：清理残留 -->
          <template v-else-if="v.failed">
            <span class="tag tag-danger">安装失败</span>
            <button
              class="btn btn-danger btn-sm installed-remove"
              @click="onCleanup(v.id)"
            >
              清理残留
            </button>
          </template>
          <template v-else>
          <span v-if="v.modpackName" class="tag tag-accent">整合包 · {{ v.modpackName }}</span>
          <span v-else-if="!v.loader" class="tag">纯净版</span>
          <span v-if="v.isolated" class="tag">已隔离</span>
          <span class="tag tag-cyan" :title="v.folder">{{ folderShortName(v.folder) }}</span>
          <span class="muted played-text">最近游玩：{{ fmtLastPlayed(store.lastPlayed[v.id]) }}</span>
          <label
            v-if="!v.modpackName"
            class="iso-switch"
            :title="v.isolated ? '版本隔离已开启：使用独立的游戏目录（存档/模组/配置）。点击关闭' : '版本隔离已关闭：与全局共享游戏目录。点击开启（将把共享数据复制进版本目录）'"
          >
            <span class="muted iso-label">隔离</span>
            <span class="switch">
              <input
                type="checkbox"
                :checked="!!v.isolated"
                :disabled="isoBusy === v.id"
                @change="onToggleIsolation(v)"
              />
              <span class="switch-ui"></span>
            </span>
          </label>
          <button
            class="icon-btn installed-folder"
            :title="`打开 ${v.id} 的版本文件夹`"
            @click="openVersionFolder(v)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
            </svg>
          </button>
          <button
            class="icon-btn installed-folder"
            :title="`管理 ${v.id} 的模组/资源包/光影包`"
            @click="openManageMenu($event, v.id)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 21v-7a8 8 0 0 1 16 0v7" />
              <path d="M12 3v3M5.6 5.6l2.2 2.2M18.4 5.6l-2.2 2.2M3 13h3M18 13h3" />
            </svg>
          </button>
          <button
            class="btn btn-danger btn-sm installed-remove"
            @click="removeModal.open = true; removeModal.target = v"
          >
            删除
          </button>
          </template>
        </div>
      </div>
    </div>
    </template>

    <!-- 管理快捷菜单（模组/资源包/光影包） -->
    <Teleport to="body">
      <div v-if="manageMenu.id" class="menu-overlay" @click="manageMenu.id = ''"></div>
      <div
        v-if="manageMenu.id"
        class="float-menu"
        :style="{ top: manageMenu.top + 'px', left: manageMenu.left + 'px' }"
      >
        <button class="menu-item" @click="goManage('mods')">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/></svg>
          模组
        </button>
        <button class="menu-item" @click="goManage('packs')">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>
          资源包
        </button>
        <button class="menu-item" @click="goManage('shaders')">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
          光影包
        </button>
        <button class="menu-item" @click="openRename">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
          重命名
        </button>
        <button class="menu-item" @click="openIconPicker(manageMenu.id)">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>
          更换图标
        </button>
        <button class="menu-item" @click="openJavaModal">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8h1a3 3 0 0 1 0 6h-1M3 8h15v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M7 12h6M7 15h4"/></svg>
          指定 Java
        </button>
      </div>
    </Teleport>

    <!-- 指定 Java 弹窗 -->
    <Teleport to="body">
      <div v-if="javaModal.open" class="modal-mask" @click.self="javaModal.open = false">
        <div class="modal">
          <h3 class="modal-title">指定 Java · {{ javaModal.id }}</h3>
          <p class="modal-label">选择该版本使用的 Java（默认自动匹配）</p>
          <div v-if="javaModal.busy" class="loaders-loading">
            <span class="spin"></span><span class="muted">读取 Java 列表…</span>
          </div>
          <template v-else>
            <select v-model="javaModal.value" class="select">
              <option value="">自动匹配（按版本需求选择，推荐）</option>
              <option v-for="j in javaModal.list" :key="j.path" :value="j.path">
                Java {{ j.major }}（{{ j.source === 'manual' ? '手动' : '自动' }}）· {{ j.path }}
              </option>
            </select>
          </template>
          <div class="modal-actions">
            <button class="btn btn-ghost" @click="javaModal.open = false">取消</button>
            <button class="btn btn-gold" @click="onConfirmJava">确定</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 实例重命名弹窗 -->
    <Teleport to="body">
      <div v-if="renameModal.open" class="modal-mask" @click.self="renameModal.open = false">
        <div class="modal">
          <h3 class="modal-title">重命名实例</h3>
          <p class="modal-label">新实例名（将作为文件夹名 versions/&lt;名&gt;/）</p>
          <input
            v-model="renameModal.name"
            class="input mono"
            spellcheck="false"
            @keyup.enter="onConfirmRename"
          />
          <p v-if="renameModal.error" class="loaders-error">{{ renameModal.error }}</p>
          <div class="modal-actions">
            <button class="btn btn-ghost" @click="renameModal.open = false">取消</button>
            <button class="btn btn-gold" :disabled="renameModal.busy" @click="onConfirmRename">
              {{ renameModal.busy ? '重命名中…' : '确认重命名' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 实例图标选择弹窗 -->
    <IconPickerModal
      :open="iconModal.open"
      :version-id="iconModal.id"
      :current-icon="iconModal.current"
      @close="iconModal.open = false"
    />

    <!-- 删除版本二次确认 -->
    <ConfirmModal
      :open="removeModal.open"
      title="删除版本"
      :message="`确定要删除版本「${removeModal.target?.id}」吗？该版本的游戏文件将被移除（共享的依赖库与资源会保留），此操作不可恢复。`"
      :busy="removeModal.busy"
      @cancel="removeModal.open = false"
      @confirm="onConfirmRemove"
    />

    <!-- 安装模态框 -->
    <Teleport to="body">
      <div v-if="modal.open" class="modal-mask" @click.self="modal.open = false">
        <div class="modal">
          <h3 class="modal-title">安装 {{ modal.version?.id }}</h3>

          <p class="modal-label">选择模组加载器</p>
          <div class="loader-options">
            <button
              v-for="opt in loaderOptions"
              :key="opt.value"
              class="loader-option"
              :class="{ active: modal.loader === opt.value }"
              @click="modal.loader = opt.value"
            >
              {{ opt.label }}
            </button>
          </div>

          <template v-if="modal.loader">
            <p class="modal-label">加载器版本</p>
            <div v-if="modal.loadingLoaders" class="loaders-loading">
              <span class="spin"></span>
              <span class="muted">正在获取 {{ modal.loader }} 版本列表…</span>
            </div>
            <template v-else>
              <select v-if="modal.loaderVersions.length" v-model="modal.loaderVersion" class="select">
                <option v-for="lv in modal.loaderVersions" :key="lv" :value="lv">{{ lv }}</option>
              </select>
              <p v-if="modal.loadLoadersError" class="loaders-error">{{ modal.loadLoadersError }}</p>
            </template>

            <!-- Fabric 联动：Fabric API 自动选择 -->
            <template v-if="modal.loader === 'fabric'">
              <div class="fapi-head">
                <p class="modal-label" style="margin: 0">Fabric API</p>
                <label class="fapi-switch">
                  <span class="muted">同时安装（大多数 Fabric 模组需要）</span>
                  <span class="switch">
                    <input v-model="modal.apiOn" type="checkbox" />
                    <span class="switch-ui"></span>
                  </span>
                </label>
              </div>
              <template v-if="modal.apiOn">
                <div v-if="modal.loadingApi" class="loaders-loading">
                  <span class="spin"></span>
                  <span class="muted">正在获取 Fabric API 版本…</span>
                </div>
                <template v-else>
                  <select v-if="modal.apiVersions.length" v-model="modal.apiVersion" class="select">
                    <option v-for="a in modal.apiVersions" :key="a.version" :value="a.version">
                      {{ a.version }}{{ a.date ? `（${formatDate(a.date)}）` : '' }}
                    </option>
                  </select>
                  <p v-if="modal.apiError" class="loaders-error">{{ modal.apiError }}</p>
                  <p class="muted fapi-tip">安装完成后将自动放入 mods 文件夹</p>
                </template>
              </template>
            </template>
          </template>

          <!-- 实例名（所有实例均可自定义；纯净版默认 MC 版本号，加载器实例按规则生成） -->
          <p class="modal-label">实例名</p>
          <input
            v-model="modal.instanceName"
            class="input mono"
            :placeholder="defaultInstanceName"
            spellcheck="false"
            @input="modal.instanceEdited = true"
          />
          <p v-if="instanceError" class="loaders-error">{{ instanceError }}</p>
          <p v-else class="muted inst-hint">实例将安装为 versions/{{ effectiveInstanceName }}/，可自定义（同 MC 版本可共存多个实例）</p>

          <div class="modal-actions">
            <button class="btn btn-ghost" @click="modal.open = false">取消</button>
            <button class="btn btn-gold" :disabled="!canConfirm" @click="confirmInstall">确认安装</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 940px;
  margin: 0 auto;
}

/* 工具行 */
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.tool-search {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 180px;
  height: 38px;
  padding: 0 13px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--card-2);
  color: var(--text-dim);
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
}
.tool-search:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.tool-search svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.tool-search input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  font-family: inherit;
}
.tool-search input::placeholder {
  color: var(--text-dim);
  opacity: 0.75;
}

.filter-capsules {
  display: flex;
  gap: 6px;
}
.capsule {
  padding: 7px 14px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--card-2);
  color: var(--text-dim);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
}
.capsule:hover {
  color: var(--text);
}
.capsule.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-2);
}
.tool-refresh {
  flex-shrink: 0;
}

/* 列表 */
.list-card {
  padding: 8px;
}
.version-list {
  /* 不再限制高度——整页单条外滚动，消灭内层嵌套滚动 */
  display: flex;
  flex-direction: column;
}
.version-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  transition: background 0.15s ease;
}
.version-row:hover {
  background: var(--card-2);
}
.version-info {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.version-id {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.version-id.editable {
  cursor: pointer;
  border-bottom: 1px dashed transparent;
  transition: color 0.15s ease, border-color 0.15s ease;
}
.version-id.editable:hover {
  color: var(--accent);
  border-bottom-color: var(--accent);
}
/* 实例图标按钮 */
.inst-icon {
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card-2);
  color: var(--text-dim);
  cursor: pointer;
  transition: border-color 0.15s ease, transform 0.12s ease;
}
.inst-icon:hover {
  border-color: var(--accent);
  transform: scale(1.05);
}
.inst-icon img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  image-rendering: pixelated;
}
.version-date {
  font-size: 12px;
  flex-shrink: 0;
}
.version-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.row-progress {
  display: flex;
  align-items: center;
  gap: 8px;
}
.row-bar {
  width: 90px;
  height: 6px;
  border-radius: 999px;
  background: var(--card-2);
  border: 1px solid var(--border);
  overflow: hidden;
}
.row-bar-fill {
  height: 100%;
  background: var(--accent-grad);
  transition: width 0.25s ease;
}
.row-progress-text {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

/* 已安装 */
.section-title {
  font-size: 15px;
  margin-bottom: 12px;
}
.installed-empty {
  padding: 24px;
}
.installed-list {
  display: flex;
  flex-direction: column;
}
.installed-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 4px;
  border-bottom: 1px solid var(--border);
}
.installed-row:last-child {
  border-bottom: none;
}
/* 实例名称（主名 + 技术 id 副标） */
.inst-names {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}
.inst-sub {
  font-size: 11.5px;
  font-family: ui-monospace, Consolas, monospace;
  word-break: break-all;
}
/* 下载源切换按钮 */
.mirror-toggle {
  cursor: pointer;
  user-select: none;
  transition: transform 0.12s ease, filter 0.15s ease;
}
.mirror-toggle:hover {
  filter: brightness(1.15);
}
.mirror-toggle:active {
  transform: scale(0.96);
}

/* 顶部 Tab 分段 */
.game-tabs {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card-2);
  align-self: flex-start;
}
.game-tab {
  padding: 7px 20px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--text-dim);
  font-size: 13.5px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.game-tab:hover {
  color: var(--text);
}
.game-tab.active {
  background: var(--accent-grad);
  color: var(--on-accent);
  box-shadow: 0 2px 8px var(--accent-soft);
}

/* 安装中/失败行 */
.installing-block {
  border-bottom: 1px solid var(--border);
  margin-bottom: 4px;
}
.failed-row .installed-folder {
  margin-left: auto;
}
.played-text {
  margin-left: auto;
  font-size: 12px;
  flex-shrink: 0;
}

/* 收藏星标按钮与分组标题 */
.fav-btn {
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
  flex-shrink: 0;
  transition: color 0.15s ease, background 0.15s ease, transform 0.12s ease;
}
.fav-btn:hover {
  color: var(--accent);
  background: var(--accent-soft);
}
.fav-btn.on {
  color: #f5b301;
}
.fav-btn:active {
  transform: scale(0.9);
}
.fav-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 4px 4px;
  font-size: 12.5px;
  font-weight: 700;
  color: #f5b301;
}

/* 版本隔离开关 */
.iso-switch {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.iso-label {
  font-size: 12px;
}
.iso-switch + .installed-folder,
.iso-switch ~ .installed-folder {
  margin-left: 0;
}
.installed-folder {
  margin-left: auto;
}
.installed-remove {
  flex-shrink: 0;
}

/* 模态框 */
.modal-title {
  font-size: 17px;
  margin-bottom: 18px;
}
.modal-label {
  font-size: 13px;
  color: var(--text-dim);
  margin: 14px 0 8px;
}
.loader-options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.loader-option {
  padding: 7px 14px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--card-2);
  color: var(--text);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
}
.loader-option:hover {
  border-color: var(--text-dim);
}
.loader-option.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-2);
}
.loaders-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
}
.loaders-error {
  margin-top: 8px;
  font-size: 13px;
  color: var(--danger);
}
.inst-hint {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.5;
}
/* Fabric API 联动区块 */
.fapi-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 18px;
}
.fapi-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 13px;
}
.fapi-tip {
  margin-top: 6px;
  font-size: 12px;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 22px;
}
</style>
