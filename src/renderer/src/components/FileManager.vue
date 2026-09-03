<script setup lang="ts">
/**
 * 通用文件管理视图：模组 / 资源包 / 光影包共用。
 * 通过 IPC fs:list / fs:remove / app:openDir 管理游戏目录下的子目录。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { errText, listFs, openDir, removeFs } from '../api'
import { refreshInstalled, store, toast } from '../store'
import ConfirmModal from './ConfirmModal.vue'
import type { FsEntry } from '@shared/types'

const props = defineProps<{
  /** 页面标题，如「模组」 */
  title: string
  /** 相对游戏目录的子目录：mods / resourcepacks / shaderpacks */
  rel: string
  /** 打开目录按钮文字 */
  openLabel: string
  /** 空状态文案 */
  emptyText: string
  /** 标题旁与空状态的内联 SVG 图标 */
  icon: string
}>()

const entries = ref<FsEntry[]>([])
const loading = ref(true)
const loadError = ref('')
const opening = ref(false)

// ---------------- 版本上下文（模组/资源包/光影包按游戏版本管理） ----------------
/** 当前选中版本（默认第一个已装版本；store.resourceVersionId 三页共享） */
const currentVersion = computed(() => {
  const list = store.installed
  if (!list.length) return null
  return list.find((v) => v.id === store.resourceVersionId) ?? list[0]
})

/** 实际管理的相对目录：隔离版本 → versions/<id>/<rel>；共享版本 → <rel> */
const effectiveRel = computed(() => {
  const v = currentVersion.value
  if (v?.isolated) return `versions/${v.id}/${props.rel}`
  return props.rel
})

/** 目录不存在时视为空列表（隔离版本刚开启、尚未产生该子目录） */
async function load() {
  loading.value = true
  loadError.value = ''
  try {
    entries.value = await listFs(effectiveRel.value)
  } catch (e) {
    const msg = errText(e)
    // 目录不存在不算错误（新版本还没该子目录）
    entries.value = []
    loadError.value = msg.includes('非法目录') ? msg : ''
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  if (!store.installed.length) await refreshInstalled()
  if (!store.resourceVersionId && store.installed.length) {
    store.resourceVersionId = store.installed[0].id
  }
  void load()
})

watch(effectiveRel, () => void load())

// ---------------- 顶栏搜索联动（过滤文件名） ----------------
const keyword = computed(() => store.searchKeyword.trim().toLowerCase())
const filtered = computed(() =>
  keyword.value
    ? entries.value.filter((e) => e.name.toLowerCase().includes(keyword.value))
    : entries.value
)

async function onOpenDir() {
  opening.value = true
  try {
    await openDir(effectiveRel.value)
  } catch (e) {
    toast('打开文件夹失败：' + errText(e), 'error')
  } finally {
    opening.value = false
  }
}

const delModal = reactive({ open: false, target: null as FsEntry | null, busy: false })

function onRemove(entry: FsEntry) {
  delModal.open = true
  delModal.target = entry
}

async function onConfirmRemove() {
  const entry = delModal.target
  if (!entry || delModal.busy) return
  delModal.busy = true
  try {
    entries.value = await removeFs(effectiveRel.value, entry.name)
    delModal.open = false
    toast(`已删除 ${entry.name}`, 'success')
  } catch (e) {
    toast('删除失败：' + errText(e), 'error')
  } finally {
    delModal.busy = false
  }
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const fmtDate = (ts: number) => {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('zh-CN')
}
</script>

<template>
  <div class="page">
    <!-- 标题行 -->
    <div class="fm-head">
      <div class="page-head">
        <h1 class="page-title">{{ props.title }}</h1>
        <p class="page-sub">管理游戏目录 / {{ effectiveRel }} 下的文件</p>
      </div>
      <div class="fm-actions">
        <select
          v-if="store.installed.length"
          v-model="store.resourceVersionId"
          class="select fm-ver-select"
          title="选择要管理的游戏版本"
        >
          <option v-for="v in store.installed" :key="v.id" :value="v.id">
            {{ v.id }}{{ v.isolated ? '（已隔离）' : '（共享）' }}
          </option>
        </select>
        <button class="btn btn-ghost" :disabled="loading" @click="load">
          <span v-if="loading" class="spin"></span>
          <svg v-else viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
          刷新
        </button>
        <button class="btn btn-gold" :disabled="opening" @click="onOpenDir">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
          </svg>
          {{ props.openLabel }}
        </button>
      </div>
    </div>

    <!-- 未安装任何版本时提示 -->
    <div v-if="!store.installed.length" class="card empty" style="padding: 40px 20px">
      <span>还没有安装任何游戏版本，请先到「游戏」页安装</span>
    </div>

    <!-- 文件列表 -->
    <div class="card fm-card">
      <div v-if="loading" class="empty">
        <span class="spin"></span>
        <span>正在读取文件列表…</span>
      </div>
      <div v-else-if="loadError" class="empty">
        <span>读取失败：{{ loadError }}</span>
        <button class="btn btn-ghost btn-sm" @click="load">重试</button>
      </div>
      <div v-else-if="!entries.length" class="empty">
        <span class="empty-icon" v-html="props.icon"></span>
        <span>{{ props.emptyText }}</span>
        <button class="btn btn-ghost btn-sm" @click="onOpenDir">打开文件夹</button>
      </div>
      <div v-else-if="keyword && !filtered.length" class="empty">
        <span>没有匹配「{{ store.searchKeyword }}」的文件</span>
      </div>
      <div v-else class="fm-list">
        <div v-for="e in filtered" :key="e.name" class="fm-row">
          <span class="fm-file-icon">
            <svg v-if="e.isDir" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
            </svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
              <path d="M14 2v6h6" />
            </svg>
          </span>
          <span class="fm-name" :title="e.name">{{ e.name }}</span>
          <span class="muted fm-meta">{{ e.isDir ? '文件夹' : fmtSize(e.size) }}</span>
          <span class="muted fm-meta fm-date">{{ fmtDate(e.mtime) }}</span>
          <button class="btn btn-danger btn-sm fm-remove" @click="onRemove(e)">删除</button>
        </div>
      </div>
    </div>

    <!-- 删除文件二次确认 -->
    <ConfirmModal
      :open="delModal.open"
      title="删除文件"
      :message="`确定要删除「${delModal.target?.name}」吗？此操作不可恢复。`"
      :busy="delModal.busy"
      @cancel="delModal.open = false"
      @confirm="onConfirmRemove"
    />
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

.fm-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.fm-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.fm-ver-select {
  max-width: 240px;
}

.fm-card {
  padding: 8px;
}
.fm-list {
  display: flex;
  flex-direction: column;
}
.fm-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  transition: background 0.15s ease;
}
.fm-row:hover {
  background: var(--card-2);
}
.fm-file-icon {
  display: flex;
  width: 20px;
  height: 20px;
  color: var(--accent);
  flex-shrink: 0;
}
.fm-file-icon svg {
  width: 100%;
  height: 100%;
}
.fm-name {
  flex: 1;
  min-width: 0;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
}
.fm-meta {
  font-size: 12px;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.fm-date {
  width: 86px;
  text-align: right;
}
.fm-remove {
  flex-shrink: 0;
}
.empty-icon {
  display: flex;
  width: 44px;
  height: 44px;
  color: var(--accent);
  opacity: 0.8;
}
.empty-icon :deep(svg) {
  width: 100%;
  height: 100%;
}
</style>
