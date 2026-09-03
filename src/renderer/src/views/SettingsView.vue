<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { addCustomJava, addFolder, errText, getSettings, hideJava, listFolders, listJava, migrateGameDir, onGameDirDone, refreshJava, removeFolder, saveSettings, selectDir, setActiveFolder, setDefaultFolder } from '../api'
import { enterEditMode, progressOverall, refreshInstalled, store, toast } from '../store'
import type { GameFolder, Settings } from '@shared/types'

// ---------------- 保存 ----------------
async function save(patch: Partial<Settings>) {
  try {
    store.settings = await saveSettings(patch)
  } catch (e) {
    toast('保存设置失败：' + errText(e), 'error')
  }
}

// ---------------- 游戏目录迁移 ----------------
const pickingDir = ref(false)
const migrateModal = reactive({
  open: false,
  newDir: '',
  migrating: false,
  migrateData: true
})

/** 迁移进度（复用全局 progress 事件 stage=migrate） */
const migratingProgress = computed(() =>
  migrateModal.migrating && store.progress?.stage === 'migrate'
    ? `${store.progress.text} ${Math.round(progressOverall(store.progress) * 100)}%`
    : ''
)

async function browseDir() {
  pickingDir.value = true
  try {
    const dir = await selectDir()
    if (!dir) return
    if (dir === store.settings?.gameDir) {
      toast('新目录与当前目录相同', 'info')
      return
    }
    migrateModal.newDir = dir
    migrateModal.migrateData = true
    migrateModal.open = true
  } catch (e) {
    toast('选择目录失败：' + errText(e), 'error')
  } finally {
    pickingDir.value = false
  }
}

/** 确认执行迁移（或从零开始）；完成/失败由 App.vue 订阅的 gameDirDone 统一收尾 */
function onConfirmMigrate() {
  migrateModal.open = false
  migrateModal.migrating = true
  void migrateGameDir(migrateModal.newDir, migrateModal.migrateData).catch((e) => {
    migrateModal.migrating = false
    toast('目录迁移失败：' + errText(e), 'error')
  })
}

// ---------------- 功能管理 ----------------
const featureToggles = [
  { key: 'mods', label: '模组（资源管理）' },
  { key: 'packs', label: '资源包' },
  { key: 'shaders', label: '光影包' },
  { key: 'servers', label: '服务器' },
  { key: 'skins', label: '皮肤与披风' },
  { key: 'community', label: '社区资源' }
]

function onToggleFeature(key: string, enabled: boolean) {
  const cur = store.settings?.disabledFeatures ?? []
  const next = enabled ? cur.filter((k) => k !== key) : [...new Set([...cur, key])]
  void save({ disabledFeatures: next })
}

// ---------------- 游戏文件夹 ----------------
const folders = ref<GameFolder[]>([])
const activeFolder = ref('')

async function loadFolders() {
  try {
    const r = await listFolders()
    folders.value = r.folders
    activeFolder.value = r.active
  } catch (e) {
    toast('读取游戏文件夹失败：' + errText(e), 'error')
  }
}

async function onAddFolder() {
  const dir = await selectDir()
  if (!dir) return
  try {
    folders.value = await addFolder(dir)
    await refreshInstalled()
    toast('已添加文件夹，其中版本已纳入列表', 'success')
  } catch (e) {
    toast('添加失败：' + errText(e), 'error')
  }
}

async function onSetActive(p: string) {
  try {
    await setActiveFolder(p)
    activeFolder.value = p
    store.settings = await getSettings()
    await refreshInstalled()
    toast('已切换活动文件夹', 'success')
  } catch (e) {
    toast('切换失败：' + errText(e), 'error')
  }
}

async function onSetDefault(p: string) {
  try {
    folders.value = await setDefaultFolder(p)
    toast('已设为默认文件夹', 'success')
  } catch (e) {
    toast('设置失败：' + errText(e), 'error')
  }
}

async function onRemoveFolder(p: string) {
  try {
    folders.value = await removeFolder(p)
    await refreshInstalled()
    toast('已移除登记（文件保留）', 'success')
  } catch (e) {
    toast('移除失败：' + errText(e), 'error')
  }
}

// ---------------- 预设主题 ----------------
import { THEME_PRESETS, DEFAULT_CUSTOM_THEME } from '@shared/types'
import type { CustomTheme } from '@shared/types'

const presetThemes = Object.entries(THEME_PRESETS).map(([key, v]) => ({
  key,
  label: v.label,
  colors: v.colors
}))

/** 当前生效的预设（颜色与某预设完全一致时高亮） */
const activePreset = computed(() => {
  const c = store.settings?.custom.colors
  if (!c) return ''
  const hit = presetThemes.find((p) =>
    (Object.keys(p.colors) as Array<keyof CustomTheme['colors']>).every(
      (k) => p.colors[k].toLowerCase() === c[k].toLowerCase()
    )
  )
  return hit?.key ?? ''
})

function applyPreset(key: string) {
  const preset = THEME_PRESETS[key]
  if (!preset) return
  const custom: CustomTheme = {
    colors: { ...preset.colors },
    layout: { ...(store.settings?.custom.layout ?? DEFAULT_CUSTOM_THEME.layout) }
  }
  void save({ theme: 'custom', custom })
  toast(`已套用「${preset.label}」主题`, 'success')
}

// ---------------- Java 列表 ----------------
const javas = ref<Awaited<ReturnType<typeof listJava>>>([])
const javaLoading = ref(true)
const javaError = ref('')
const javaRefreshing = ref(false)
const javaAdding = ref(false)
const javaCustomInput = ref('')
const javaAddError = ref('')

async function onRefreshJava() {
  javaRefreshing.value = true
  try {
    javas.value = await refreshJava()
    toast('Java 扫描完成', 'success')
  } catch (e) {
    toast('扫描失败：' + errText(e), 'error')
  } finally {
    javaRefreshing.value = false
  }
}

async function onAddJava() {
  const p = javaCustomInput.value.trim()
  if (!p || javaAdding.value) return
  javaAdding.value = true
  javaAddError.value = ''
  try {
    await addCustomJava(p)
    javaCustomInput.value = ''
    javas.value = await listJava()
    toast('已添加 Java', 'success')
  } catch (e) {
    javaAddError.value = errText(e)
  } finally {
    javaAdding.value = false
  }
}

async function onHideJava(p: string) {
  try {
    await hideJava(p)
    javas.value = await listJava()
  } catch (e) {
    toast('操作失败：' + errText(e), 'error')
  }
}

onMounted(async () => {
  void loadFolders()
  try {
    javas.value = await listJava()
  } catch (e) {
    javaError.value = errText(e)
  } finally {
    javaLoading.value = false
  }
  // 目录迁移收尾：成功 → 重新拉取设置并提示；失败 → 配置已回滚，仅提示
  offGameDirDone = onGameDirDone(async (r) => {
    migrateModal.migrating = false
    if (r.ok) {
      store.settings = await getSettings()
      toast('游戏目录已切换，数据已刷新', 'success')
    } else {
      toast(`迁移失败：${r.error ?? '未知错误'}（配置未变更）`, 'error')
    }
  })
})

let offGameDirDone: (() => void) | null = null
onUnmounted(() => offGameDirDone?.())

const javaLabel = (j: { major: number; path: string; version: string }) =>
  `Java ${j.major}（${j.version}）· ${j.path}`

// ---------------- 内存显示与滑块填充 ----------------
const MEM_MIN = 1024
const MEM_MAX = 16384

const memoryText = computed(() => {
  const mb = store.settings?.memoryMB ?? 0
  return mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`
})

/* 已填充段 = accent 渐变 */
const sliderFill = computed(() => {
  const mb = store.settings?.memoryMB ?? MEM_MIN
  const pct = Math.max(0, Math.min(100, ((mb - MEM_MIN) / (MEM_MAX - MEM_MIN)) * 100))
  return `linear-gradient(90deg, var(--accent-2), var(--accent) ${pct}%, var(--card-2) ${pct}%)`
})

// ---------------- 分辨率 ----------------
function saveResolution() {
  const s = store.settings
  if (!s) return
  const width = Math.max(854, Math.min(7680, Math.round(s.resolution.width) || 854))
  const height = Math.max(480, Math.min(4320, Math.round(s.resolution.height) || 480))
  s.resolution.width = width
  s.resolution.height = height
  save({ resolution: { ...s.resolution } })
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">设置</h1>
      <p class="page-sub">游戏目录、内存、Java 与启动行为</p>
    </div>

    <div v-if="!store.settings" class="card empty">
      <span class="spin"></span>
      <span>正在加载设置…</span>
    </div>

    <template v-else>
      <!-- 外观主题 -->
      <div class="card group">
        <h3 class="group-title">主题</h3>
        <div class="theme-options">
          <button
            class="theme-option"
            :class="{ active: store.settings.theme === 'light' }"
            @click="save({ theme: 'light' })"
          >
            <span class="theme-preview preview-light">
              <span class="tp-side"><span class="tp-dot"></span></span>
              <span class="tp-main">
                <span class="tp-top"></span>
                <span class="tp-body">
                  <span class="tp-block"></span>
                  <span class="tp-btn"></span>
                </span>
              </span>
              <svg v-if="store.settings.theme === 'light'" class="tp-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            </span>
            <span class="theme-label">亮色</span>
          </button>
          <button
            class="theme-option"
            :class="{ active: store.settings.theme === 'dark' }"
            @click="save({ theme: 'dark' })"
          >
            <span class="theme-preview preview-dark">
              <span class="tp-side"><span class="tp-dot"></span></span>
              <span class="tp-main">
                <span class="tp-top"></span>
                <span class="tp-body">
                  <span class="tp-block"></span>
                  <span class="tp-btn"></span>
                </span>
              </span>
              <svg v-if="store.settings.theme === 'dark'" class="tp-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            </span>
            <span class="theme-label">暗色</span>
          </button>
          <button
            class="theme-option"
            :class="{ active: store.settings.theme === 'custom' }"
            @click="save({ theme: 'custom' })"
          >
            <span class="theme-preview preview-custom">
              <span class="tp-custom-grad"></span>
              <svg class="tp-palette" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 22C6.49 22 2 17.51 2 12S6.49 2 12 2s10 4.04 10 9c0 3.31-2.69 6-6 6h-1.77c-.28 0-.5.22-.5.5 0 .12.05.23.13.33.41.47.64 1.06.64 1.67A2.5 2.5 0 0 1 12 22Z" />
                <circle cx="7.5" cy="11.5" r="1" fill="currentColor" stroke="none" />
                <circle cx="12" cy="7.5" r="1" fill="currentColor" stroke="none" />
                <circle cx="16.5" cy="11.5" r="1" fill="currentColor" stroke="none" />
              </svg>
              <svg v-if="store.settings.theme === 'custom'" class="tp-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            </span>
            <span class="theme-label">自定义颜色</span>
          </button>
          <!-- 预设主题：与上方主题卡片同格式，套用自定义颜色快捷方案 -->
          <button
            v-for="p in presetThemes"
            :key="p.key"
            class="theme-option"
            :class="{ active: store.settings.theme === 'custom' && activePreset === p.key }"
            :title="`套用「${p.label}」主题`"
            @click="applyPreset(p.key)"
          >
            <span class="theme-preview" :style="{ background: p.colors.bg }">
              <span
                class="tp-side"
                :style="{ background: p.colors.sidebarBg, borderRight: '1px solid ' + p.colors.border }"
              >
                <span class="tp-dot" :style="{ background: p.colors.accent }"></span>
              </span>
              <span class="tp-main">
                <span
                  class="tp-top"
                  :style="{ background: p.colors.card, borderBottom: '1px solid ' + p.colors.border }"
                ></span>
                <span class="tp-body">
                  <span
                    class="tp-block"
                    :style="{ background: p.colors.card, border: '1px solid ' + p.colors.border }"
                  ></span>
                  <span class="tp-btn" :style="{ background: p.colors.accent }"></span>
                </span>
              </span>
              <svg v-if="store.settings.theme === 'custom' && activePreset === p.key" class="tp-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            </span>
            <span class="theme-label">{{ p.label }}</span>
          </button>
        </div>

        <p class="muted group-hint">预设主题为自定义颜色的快捷方案，套用后仍可在「个性化」中微调。</p>
        <button
          v-if="store.settings.theme === 'custom'"
          class="btn personalize-btn"
          @click="enterEditMode"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
            <path d="M1 14h6M9 8h6M17 16h6" />
          </svg>
          个性化
        </button>
      </div>

      <!-- 功能管理 -->
      <div class="card group">
        <h3 class="group-title">功能管理</h3>
        <p class="muted group-hint" style="margin-top: 0; margin-bottom: 12px">
          关闭的功能将从侧边栏隐藏入口。核心功能（首页/游戏/设置）不可关闭。
        </p>
        <div v-for="f in featureToggles" :key="f.key" class="feature-row">
          <span class="feature-name">{{ f.label }}</span>
          <span class="switch">
            <input
              type="checkbox"
              :checked="!store.settings.disabledFeatures.includes(f.key)"
              @change="onToggleFeature(f.key, ($event.target as HTMLInputElement).checked)"
            />
            <span class="switch-ui"></span>
          </span>
        </div>
      </div>

      <!-- 首页布局与背景（个性化） -->
      <HomeLayoutEditor />

      <!-- 游戏文件夹（多目录体系） -->
      <div class="card group">
        <h3 class="group-title">游戏文件夹</h3>
        <p class="muted group-hint">
          登记多个游戏文件夹（官方 .minecraft、其他启动器目录等），版本按所属文件夹管理；「默认」文件夹承接新安装与共享库，「活动」为当前操作目标。
        </p>
        <div v-if="!folders.length" class="muted">加载中…</div>
        <div v-for="f in folders" :key="f.path" class="folder-row">
          <div class="folder-meta">
            <div class="folder-name-row">
              <span class="folder-name">{{ f.name }}</span>
              <span v-if="f.isDefault" class="tag tag-gold">默认</span>
              <span v-if="f.path === activeFolder" class="tag">活动中</span>
            </div>
            <span class="muted folder-path" :title="f.path">{{ f.path }}</span>
          </div>
          <div class="folder-actions">
            <button v-if="f.path !== activeFolder" class="btn btn-ghost btn-sm" @click="onSetActive(f.path)">切换</button>
            <button v-if="!f.isDefault" class="btn btn-ghost btn-sm" @click="onSetDefault(f.path)">设为默认</button>
            <button v-if="!f.isDefault" class="btn btn-danger btn-sm" @click="onRemoveFolder(f.path)">移除</button>
          </div>
        </div>
        <button class="btn btn-ghost" style="align-self: flex-start; margin-top: 8px" @click="onAddFolder">
          + 添加已有文件夹…
        </button>
      </div>

      <!-- 游戏目录 -->
      <div class="card group">
        <h3 class="group-title">游戏安装目录</h3>
        <div class="dir-row">
          <input class="input mono" :value="store.settings.gameDir" readonly title="游戏目录" />
          <button class="btn btn-ghost dir-btn" :disabled="pickingDir || migrateModal.migrating" @click="browseDir">
            {{ pickingDir ? '选择中…' : '更改…' }}
          </button>
        </div>
        <p class="muted group-hint">
          默认位于系统盘（%AppData%\.kamucl）。更改时可选择将已有游戏文件完整迁移到新目录。
        </p>
        <p v-if="migrateModal.migrating" class="migrate-status">
          <span class="spin"></span>
          {{ migratingProgress || '正在迁移游戏文件…' }}
        </p>
      </div>

      <!-- 默认版本隔离 -->
      <div class="card group">
        <label class="java-auto-row">
          <span class="java-auto-text">
            <span class="java-auto-title">新版本默认开启版本隔离（推荐）</span>
            <span class="muted java-auto-desc">
              每个新安装的版本使用独立的存档/模组/配置目录，互不干扰。关闭后新版本与全局共享游戏目录；已安装的版本可在游戏版本页单独开关。
            </span>
          </span>
          <span class="switch">
            <input
              type="checkbox"
              :checked="store.settings.defaultIsolation"
              @change="save({ defaultIsolation: ($event.target as HTMLInputElement).checked })"
            />
            <span class="switch-ui"></span>
          </span>
        </label>
      </div>

      <!-- 内存 -->
      <div class="card group">
        <h3 class="group-title">内存分配</h3>
        <div class="memory-row">
          <input
            v-model.number="store.settings.memoryMB"
            type="range"
            class="slider"
            :style="{ background: sliderFill }"
            :min="MEM_MIN"
            :max="MEM_MAX"
            step="512"
            @change="save({ memoryMB: store.settings!.memoryMB })"
          />
          <span class="memory-value">{{ memoryText }}</span>
        </div>
        <p class="muted group-hint">分配给游戏进程的最大内存（1024 - 16384 MB）</p>
      </div>

      <!-- Java -->
      <div class="card group">
        <h3 class="group-title">Java 运行时</h3>
        <label class="java-auto-row">
          <span class="java-auto-text">
            <span class="java-auto-title">自动检测并下载所需 Java（推荐）</span>
            <span class="muted java-auto-desc">
              启动时按游戏版本自动选择匹配的 Java；本机没有时自动下载安装。关闭后使用下方手动选择的 Java。
            </span>
          </span>
          <span class="switch">
            <input
              type="checkbox"
              :checked="store.settings.javaAuto"
              @change="save({ javaAuto: ($event.target as HTMLInputElement).checked })"
            />
            <span class="switch-ui"></span>
          </span>
        </label>
        <div v-if="javaLoading" class="java-loading">
          <span class="spin"></span>
          <span class="muted">正在检测本机 Java…</span>
        </div>
        <template v-else>
          <select
            v-model="store.settings.javaPath"
            class="select"
            :disabled="store.settings.javaAuto"
            @change="save({ javaPath: store.settings!.javaPath })"
          >
            <option value="">自动选择（推荐）</option>
            <option v-for="j in javas" :key="j.path" :value="j.path">{{ javaLabel(j) }}</option>
          </select>
          <p v-if="javaError" class="group-error">Java 检测失败：{{ javaError }}</p>
          <p v-else-if="!javas.length" class="muted group-hint">
            未检测到本机 Java，将使用「自动选择」或在启动时自动下载。
          </p>

          <!-- 已识别的 Java 列表（版本/位数/来源，支持移除） -->
          <div v-if="javas.length" class="java-list">
            <div class="java-list-head">
              <span class="muted">已识别 {{ javas.length }} 个 Java</span>
              <button class="btn btn-ghost btn-sm" :disabled="javaRefreshing" @click="onRefreshJava">
                {{ javaRefreshing ? '扫描中…' : '重新扫描' }}
              </button>
            </div>
            <div v-for="j in javas" :key="j.path" class="java-item">
              <span class="tag" :class="j.source === 'manual' ? 'tag-accent' : ''">
                {{ j.source === 'manual' ? '手动' : '自动' }}
              </span>
              <span class="java-item-ver">Java {{ j.major }}</span>
              <span class="muted java-item-path" :title="j.path">{{ j.path }}</span>
              <button class="java-item-hide" title="从列表隐藏" @click="onHideJava(j.path)">×</button>
            </div>
          </div>

          <!-- 手动添加 Java -->
          <div class="java-add-row">
            <input
              v-model="javaCustomInput"
              class="input mono"
              placeholder="手动添加 java 可执行文件完整路径…"
              spellcheck="false"
              @keyup.enter="onAddJava"
            />
            <button class="btn btn-ghost" :disabled="javaAdding" @click="onAddJava">
              {{ javaAdding ? '校验中…' : '添加' }}
            </button>
          </div>
          <p v-if="javaAddError" class="group-error">{{ javaAddError }}</p>
        </template>
      </div>

      <!-- 窗口分辨率 -->
      <div class="card group">
        <h3 class="group-title">窗口分辨率</h3>
        <div class="resolution-row">
          <div class="res-field">
            <span class="muted res-label">宽</span>
            <input
              v-model.number="store.settings.resolution.width"
              type="number"
              class="input"
              min="854"
              max="7680"
              @change="saveResolution"
            />
          </div>
          <span class="muted res-x">×</span>
          <div class="res-field">
            <span class="muted res-label">高</span>
            <input
              v-model.number="store.settings.resolution.height"
              type="number"
              class="input"
              min="480"
              max="4320"
              @change="saveResolution"
            />
          </div>
          <div class="fullscreen-toggle">
            <span class="muted">全屏</span>
            <label class="switch">
              <input
                v-model="store.settings.resolution.fullscreen"
                type="checkbox"
                @change="save({ resolution: { ...store.settings!.resolution } })"
              />
              <span class="switch-ui"></span>
            </label>
          </div>
        </div>
      </div>

      <!-- JVM 参数 -->
      <div class="card group">
        <h3 class="group-title">JVM 参数</h3>
        <input
          v-model="store.settings.jvmArgs"
          class="input mono"
          placeholder="例如：-XX:+UseG1GC -XX:+ParallelRefProcEnabled"
          @change="save({ jvmArgs: store.settings!.jvmArgs })"
        />
        <p class="muted group-hint">高级选项，留空则使用默认参数</p>
      </div>

      <!-- 下载镜像 -->
      <div class="card group">
        <h3 class="group-title">下载镜像</h3>
        <div class="mirror-options">
          <label class="mirror-option" :class="{ active: store.settings.mirror === 'official' }">
            <input v-model="store.settings.mirror" type="radio" value="official" @change="save({ mirror: 'official' })" />
            <span>官方源</span>
          </label>
          <label class="mirror-option" :class="{ active: store.settings.mirror === 'bmclapi' }">
            <input v-model="store.settings.mirror" type="radio" value="bmclapi" @change="save({ mirror: 'bmclapi' })" />
            <span>BMCLAPI 镜像（国内更快）</span>
          </label>
        </div>
      </div>

      <!-- 微软登录 Client ID -->
      <div class="card group">
        <h3 class="group-title">微软登录 Client ID</h3>
        <input
          v-model="store.settings.msClientId"
          class="input mono"
          placeholder="Azure 应用 client_id"
          @change="save({ msClientId: store.settings!.msClientId })"
        />
        <p class="muted group-hint">使用 device code 流程的 Azure 应用 ID</p>
      </div>

      <!-- 启动后关闭 -->
      <div class="card group group-inline">
        <div>
          <h3 class="group-title">启动后关闭启动器</h3>
          <p class="muted group-hint">游戏成功启动后自动退出 KAMUCL</p>
        </div>
        <label class="switch">
          <input
            v-model="store.settings.closeAfterLaunch"
            type="checkbox"
            @change="save({ closeAfterLaunch: store.settings!.closeAfterLaunch })"
          />
          <span class="switch-ui"></span>
        </label>
      </div>
    </template>

    <!-- 游戏目录迁移确认弹窗 -->
    <Teleport to="body">
      <div v-if="migrateModal.open" class="modal-mask" @click.self="migrateModal.open = false">
        <div class="modal">
          <h3 class="modal-title">更改游戏安装目录</h3>
          <p class="modal-label">新目录</p>
          <input class="input mono" :value="migrateModal.newDir" readonly />
          <p class="modal-label">已有游戏文件</p>
          <label class="migrate-option" :class="{ active: migrateModal.migrateData }">
            <input v-model="migrateModal.migrateData" type="radio" :value="true" />
            <span>
              <strong>迁移到新目录（推荐）</strong>
              <span class="muted">完整迁移 versions、模组、存档等全部游戏数据，迁移前自动校验磁盘空间与权限；旧目录数据保留作备份。</span>
            </span>
          </label>
          <label class="migrate-option" :class="{ active: !migrateModal.migrateData }">
            <input v-model="migrateModal.migrateData" type="radio" :value="false" />
            <span>
              <strong>新目录从零开始</strong>
              <span class="muted">不迁移任何数据，新目录下的启动器从空白开始。</span>
            </span>
          </label>
          <div class="modal-actions">
            <button class="btn btn-ghost" @click="migrateModal.open = false">取消</button>
            <button class="btn btn-gold" @click="onConfirmMigrate">确认更改</button>
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
  max-width: 720px;
  margin: 0 auto;
}

.group {
  display: flex;
  flex-direction: column;
}
.group-title {
  font-size: 15px;
  margin-bottom: 12px;
}
/* Java 列表 */
.java-list {
  margin-top: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.java-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--card-2);
  font-size: 12px;
}
.java-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-top: 1px solid var(--border);
  font-size: 12.5px;
}
.java-item-ver {
  font-weight: 600;
  flex-shrink: 0;
}
.java-item-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11.5px;
}
.java-item-hide {
  border: none;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 14px;
  padding: 0 4px;
  border-radius: 6px;
}
.java-item-hide:hover {
  color: var(--danger);
  background: var(--danger-soft);
}
.java-add-row {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
/* 游戏文件夹列表 */
.folder-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 0;
  border-bottom: 1px solid var(--border);
}
.folder-row:last-of-type {
  border-bottom: none;
}
.folder-meta {
  flex: 1;
  min-width: 0;
}
.folder-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.folder-name {
  font-size: 13.5px;
  font-weight: 600;
}
.folder-path {
  font-size: 11.5px;
  font-family: ui-monospace, Consolas, monospace;
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.folder-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.java-auto-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 10px 12px;
  margin-bottom: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card-2);
  cursor: pointer;
}
.java-auto-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.java-auto-title {
  font-size: 13.5px;
  font-weight: 600;
}
.java-auto-desc {
  font-size: 12px;
  line-height: 1.6;
}
.select:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
/* 迁移状态与选项 */
.migrate-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  font-size: 12.5px;
  color: var(--accent-2);
}
.migrate-option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  margin-bottom: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card-2);
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.migrate-option.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.migrate-option input {
  margin-top: 3px;
  accent-color: var(--accent);
}
.migrate-option span strong {
  display: block;
  font-size: 13.5px;
  margin-bottom: 3px;
}
.migrate-option span .muted {
  font-size: 12px;
  line-height: 1.6;
}
.feature-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 2px;
  border-bottom: 1px solid var(--border);
}
.feature-row:last-child {
  border-bottom: none;
}
.feature-name {
  font-size: 13.5px;
}
.group-hint {
  font-size: 12px;
  margin-top: 8px;
}
.group-error {
  font-size: 12px;
  margin-top: 8px;
  color: var(--danger);
}
.group-inline {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.group-inline .group-title {
  margin-bottom: 4px;
}
.group-inline .group-hint {
  margin-top: 0;
}

/* 主题选择 */
.theme-options {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.theme-option {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: none;
  background: transparent;
  font-family: inherit;
  cursor: pointer;
}
.theme-preview {
  position: relative;
  display: flex;
  width: 150px;
  height: 84px;
  border-radius: 10px;
  border: 1.5px solid var(--border);
  overflow: hidden;
  transition: border-color 0.16s ease, box-shadow 0.16s ease, transform 0.12s ease;
}
.theme-option:hover .theme-preview {
  transform: translateY(-1px);
  border-color: var(--border-strong);
}
.theme-option.active .theme-preview {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.theme-option:active .theme-preview {
  transform: scale(0.98);
}
.theme-label {
  font-size: 13px;
  color: var(--text-dim);
  transition: color 0.16s ease;
}
.theme-option.active .theme-label {
  color: var(--accent);
  font-weight: 600;
}
/* 迷你界面：侧栏 + 顶栏 + 内容块（各主题预览固定用自身配色，不跟随当前主题） */
.tp-side {
  width: 26px;
  flex-shrink: 0;
  display: flex;
  justify-content: center;
  padding-top: 8px;
}
.tp-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.tp-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.tp-top {
  height: 14px;
  flex-shrink: 0;
}
.tp-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 7px;
}
.tp-block {
  flex: 1;
  border-radius: 4px;
}
.tp-btn {
  height: 12px;
  flex-shrink: 0;
  border-radius: 4px;
}
.tp-check {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  padding: 3.5px;
}
/* 亮色预览：白底蓝点 */
.preview-light {
  background: #ffffff;
}
.preview-light .tp-side {
  background: #f5f7fb;
  border-right: 1px solid #e1e6f0;
}
.preview-light .tp-dot {
  background: #2563eb;
}
.preview-light .tp-top {
  background: #f5f7fb;
  border-bottom: 1px solid #e1e6f0;
}
.preview-light .tp-block {
  background: #f2f5fa;
  border: 1px solid #e1e6f0;
}
.preview-light .tp-btn {
  background: linear-gradient(135deg, #4a86ff, #2563eb);
}
/* 暗色预览：黑底橙点 */
.preview-dark {
  background: #16161d;
}
.preview-dark .tp-side {
  background: #111116;
  border-right: 1px solid #26262f;
}
.preview-dark .tp-dot {
  background: #f97316;
}
.preview-dark .tp-top {
  background: #111116;
  border-bottom: 1px solid #26262f;
}
.preview-dark .tp-block {
  background: #1c1c25;
  border: 1px solid #26262f;
}
.preview-dark .tp-btn {
  background: linear-gradient(135deg, #fb923c, #f97316);
}
/* 自定义预览：彩虹渐变色块 + 调色盘图标 */
.preview-custom {
  align-items: center;
  justify-content: center;
  background: #16161d;
}
.tp-custom-grad {
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, #f43f5e 0%, #f97316 25%, #eab308 45%, #22c55e 65%, #3b82f6 85%, #a855f7 100%);
  opacity: 0.85;
}
.tp-palette {
  position: relative;
  width: 30px;
  height: 30px;
  color: #ffffff;
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.45));
}
/* 「个性化」入口（选中自定义主题后出现） */
.personalize-btn {
  align-self: flex-start;
  margin-top: 14px;
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
  font-weight: 600;
}
.personalize-btn:hover:not(:disabled) {
  filter: brightness(1.06);
  border-color: var(--accent);
  color: var(--accent);
}

/* 目录 */
.dir-row {
  display: flex;
  gap: 10px;
}
.dir-row .input {
  flex: 1;
  min-width: 0;
  font-size: 13px;
}
.dir-btn {
  flex-shrink: 0;
}

/* 内存 */
.memory-row {
  display: flex;
  align-items: center;
  gap: 16px;
}
.memory-value {
  flex-shrink: 0;
  min-width: 72px;
  text-align: right;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--accent-2);
}

/* 分辨率 */
.resolution-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.res-field {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
.res-label {
  font-size: 13px;
  flex-shrink: 0;
}
.res-x {
  flex-shrink: 0;
}
.fullscreen-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  margin-left: 8px;
  font-size: 14px;
}

/* 镜像 */
.mirror-options {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.mirror-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 16px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card-2);
  color: var(--text);
  font-size: 13.5px;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
}
.mirror-option input {
  display: none;
}
.mirror-option:hover {
  border-color: var(--text-dim);
}
.mirror-option.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-2);
}

.mono {
  font-size: 13px;
}

.java-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
}
</style>
