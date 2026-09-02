<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  changeCape,
  deleteSkinHistory,
  errText,
  getSkinHistory,
  getSkinProfile,
  uploadSkin,
  uploadSkinFromHistory
} from '../api'
import { store, toast } from '../store'
import { renderCape, renderSkinFront } from '../skin-render'
import type { CapeInfo, ProfileSkins, SkinHistoryEntry, SkinVariant } from '@shared/types'

/** 仅微软正版账号可用 */
const isMs = computed(() => store.selectedAccount?.type === 'microsoft')

// ---------------- 档案 ----------------
const profile = ref<ProfileSkins | null>(null)
const loadingProfile = ref(false)
const currentRender = ref('')
const renderingCurrent = ref(false)

const currentSkin = computed(() => profile.value?.skins[0] ?? null)
const currentVariant = computed<SkinVariant>(() =>
  currentSkin.value?.variant === 'slim' ? 'slim' : 'classic'
)
const capes = computed(() => profile.value?.capes ?? [])

/** 渲染当前皮肤人偶（用主进程随档案返回的 dataUrl，避免直连 textures.minecraft.net；失败保留空串，模板兜底占位） */
async function renderCurrent() {
  const src = currentSkin.value?.dataUrl
  currentRender.value = ''
  if (!src) return
  renderingCurrent.value = true
  try {
    currentRender.value = await renderSkinFront(src, 12)
  } finally {
    renderingCurrent.value = false
  }
}

async function loadProfile() {
  loadingProfile.value = true
  try {
    profile.value = await getSkinProfile()
    void renderCurrent()
    void renderCapes()
  } catch (e) {
    toast('获取皮肤档案失败：' + errText(e), 'error')
  } finally {
    loadingProfile.value = false
  }
}

// ---------------- 披风 ----------------
const capeRenders = ref<Record<string, string>>({})
const capeBusy = ref<string | null>(null)

async function renderCapes() {
  const map: Record<string, string> = {}
  for (const c of capes.value) {
    if (c.dataUrl) map[c.id] = await renderCape(c.dataUrl, 100, 160)
  }
  capeRenders.value = map
}

/** 点击披风：使用中 → 卸下；其他 → 激活 */
async function onCapeClick(c: CapeInfo) {
  if (capeBusy.value) return
  capeBusy.value = c.id
  try {
    profile.value = await changeCape(c.active ? null : c.id)
    toast(c.active ? '已卸下披风' : `已换上披风「${c.alias}」`, 'success')
  } catch (e) {
    toast('披风更换失败：' + errText(e), 'error')
  } finally {
    capeBusy.value = null
  }
}

// ---------------- 历史皮肤 ----------------
const historyList = ref<SkinHistoryEntry[]>([])
const historyRenders = ref<Record<string, string>>({})
const loadingHistory = ref(false)
const historyBusy = ref<string | null>(null)

async function loadHistory() {
  loadingHistory.value = true
  try {
    historyList.value = await getSkinHistory()
    const map: Record<string, string> = {}
    for (const item of historyList.value) {
      map[item.id] = await renderSkinFront(item.dataUrl, 6)
    }
    historyRenders.value = map
  } catch (e) {
    toast('读取历史皮肤失败：' + errText(e), 'error')
  } finally {
    loadingHistory.value = false
  }
}

/** 换回历史皮肤：主进程走标准上传流程并返回最新档案 */
async function onRestore(item: SkinHistoryEntry) {
  if (historyBusy.value) return
  historyBusy.value = item.id
  try {
    profile.value = await uploadSkinFromHistory(item.id)
    toast('已换回历史皮肤', 'success')
    void renderCurrent()
    void loadHistory()
  } catch (e) {
    toast('换回皮肤失败：' + errText(e), 'error')
  } finally {
    historyBusy.value = null
  }
}

async function onDeleteHistory(item: SkinHistoryEntry) {
  if (historyBusy.value) return
  historyBusy.value = item.id
  try {
    historyList.value = await deleteSkinHistory(item.id)
    const map = { ...historyRenders.value }
    delete map[item.id]
    historyRenders.value = map
    toast('已删除历史皮肤', 'success')
  } catch (e) {
    toast('删除失败：' + errText(e), 'error')
  } finally {
    historyBusy.value = null
  }
}

// ---------------- 待上传皮肤（选择 / 拖拽） ----------------
const pending = ref<{ path: string; name: string } | null>(null)
const pendingRender = ref('')
const variant = ref<SkinVariant>('classic')
const uploading = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

function fileToDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('读取文件失败'))
    r.readAsDataURL(f)
  })
}

/** 统一入口：文件选择框与拖拽都来此 */
async function pickFile(f: File | undefined | null) {
  if (!f) return
  if (!/\.png$/i.test(f.name)) {
    toast('请选择 PNG 格式的皮肤文件', 'error')
    return
  }
  const p = window.kamucl.getFilePath(f)
  if (!p) {
    toast('无法获取文件路径', 'error')
    return
  }
  pending.value = { path: p, name: f.name }
  try {
    pendingRender.value = await renderSkinFront(await fileToDataUrl(f), 12)
  } catch {
    pendingRender.value = ''
  }
}

function onInputChange(e: Event) {
  const input = e.target as HTMLInputElement
  void pickFile(input.files?.[0])
  input.value = '' // 允许再次选择同一文件
}

function clearPending() {
  pending.value = null
  pendingRender.value = ''
}

async function doUpload() {
  if (!pending.value || uploading.value) return
  uploading.value = true
  try {
    profile.value = await uploadSkin(pending.value.path, variant.value)
    toast('皮肤上传成功', 'success')
    clearPending()
    void renderCurrent()
    void loadHistory()
  } catch (e) {
    toast('皮肤上传失败：' + errText(e), 'error')
  } finally {
    uploading.value = false
  }
}

// ---------------- 卡片拖拽（stop 防止冒泡到 App 的整合包导入） ----------------
const dragOver = ref(false)
let dragDepth = 0
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')

function onCardDragEnter(e: DragEvent) {
  if (!hasFiles(e)) return
  dragDepth++
  dragOver.value = true
}

function onCardDragOver(e: DragEvent) {
  if (!hasFiles(e)) return
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  dragOver.value = true
}

function onCardDragLeave(e: DragEvent) {
  if (!hasFiles(e)) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragOver.value = false
}

function onCardDrop(e: DragEvent) {
  if (!hasFiles(e)) return
  dragDepth = 0
  dragOver.value = false
  void pickFile(e.dataTransfer?.files?.[0])
}

// ---------------- 工具 ----------------
function fmtTime(t: number): string {
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ---------------- 生命周期 ----------------
function loadAll() {
  void loadProfile()
  void loadHistory()
}

onMounted(() => {
  if (isMs.value) loadAll()
})

/** 切换账号后重置并重新加载 */
watch(
  () => store.selectedAccount?.id,
  () => {
    profile.value = null
    historyList.value = []
    historyRenders.value = {}
    capeRenders.value = {}
    currentRender.value = ''
    clearPending()
    if (isMs.value) loadAll()
  }
)
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">皮肤与披风</h1>
      <p class="page-sub">管理微软正版账号的皮肤与披风</p>
    </div>

    <!-- 非微软账号：整页引导 -->
    <div v-if="!isMs" class="card empty need-ms">
      <svg class="need-ms-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="m9 4-6 3 2 5 3-1v9h8v-9l3 1 2-5-6-3a3 3 0 0 1-6 0Z" />
      </svg>
      <p class="need-ms-text">皮肤与披风功能需要微软正版账号</p>
      <button class="btn btn-gold" @click="store.currentView = 'accounts'">去登录</button>
    </div>

    <template v-else>
      <!-- ============ 当前皮肤 ============ -->
      <div
        class="card skin-card"
        :class="{ 'drag-over': dragOver }"
        @dragenter.stop.prevent="onCardDragEnter"
        @dragover.stop.prevent="onCardDragOver"
        @dragleave.stop.prevent="onCardDragLeave"
        @drop.stop.prevent="onCardDrop"
      >
        <h3 class="section-title">当前皮肤</h3>
        <div class="skin-main">
          <!-- 左：人偶预览 -->
          <div class="preview-box">
            <span v-if="loadingProfile || renderingCurrent" class="spin"></span>
            <img v-else-if="currentRender" :src="currentRender" class="skin-img" alt="当前皮肤" />
            <div v-else class="preview-placeholder">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21v-1a8 8 0 0 1 16 0v1" />
              </svg>
              <span>暂无皮肤</span>
            </div>
            <div v-if="dragOver" class="drag-hint">松开以选择皮肤文件</div>
          </div>

          <!-- 右：信息与操作 -->
          <div class="skin-side">
            <div class="skin-name-row">
              <span class="skin-username">{{ profile?.username || store.selectedAccount?.username }}</span>
              <span class="tag" :class="currentVariant === 'slim' ? 'tag-cyan' : 'tag-gold'">
                {{ currentVariant === 'slim' ? '纤细' : '经典' }}
              </span>
            </div>

            <!-- 待上传文件 -->
            <div v-if="pending" class="pending-box">
              <img v-if="pendingRender" :src="pendingRender" class="pending-img" alt="待上传皮肤" />
              <div class="pending-meta">
                <span class="pending-name" :title="pending.name">{{ pending.name }}</span>
                <div class="seg">
                  <button
                    class="seg-btn"
                    :class="{ active: variant === 'classic' }"
                    @click="variant = 'classic'"
                  >
                    经典 Classic
                  </button>
                  <button
                    class="seg-btn"
                    :class="{ active: variant === 'slim' }"
                    @click="variant = 'slim'"
                  >
                    纤细 Slim
                  </button>
                </div>
              </div>
              <button class="icon-btn" title="移除待上传文件" @click="clearPending">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>

            <div class="skin-actions">
              <button class="btn btn-ghost" @click="fileInput?.click()">选择皮肤文件…</button>
              <button class="btn btn-gold" :disabled="!pending || uploading" @click="doUpload">
                {{ uploading ? '上传中…' : '上传' }}
              </button>
            </div>
            <p class="muted skin-hint">支持 64×64 的 PNG 皮肤文件，可直接拖拽到本卡片</p>
          </div>
        </div>
        <input
          ref="fileInput"
          type="file"
          accept=".png,image/png"
          class="hidden-input"
          @change="onInputChange"
        />
      </div>

      <!-- ============ 披风 ============ -->
      <div class="card">
        <h3 class="section-title">披风（{{ capes.length }}）</h3>
        <div v-if="loadingProfile" class="empty cape-loading"><span class="spin"></span></div>
        <div v-else-if="!capes.length" class="empty cape-empty">
          <span>该账号暂无披风</span>
        </div>
        <div v-else class="cape-grid">
          <button
            v-for="c in capes"
            :key="c.id"
            class="cape-item"
            :class="{ active: c.active }"
            :disabled="capeBusy !== null"
            :title="c.active ? '点击卸下披风' : '点击使用该披风'"
            @click="onCapeClick(c)"
          >
            <div class="cape-preview">
              <img v-if="capeRenders[c.id]" :src="capeRenders[c.id]" class="cape-img" :alt="c.alias" />
              <span v-else class="cape-alias">{{ c.alias }}</span>
            </div>
            <span class="cape-name">{{ c.alias }}</span>
            <span v-if="capeBusy === c.id" class="spin cape-spin"></span>
            <span v-else-if="c.active" class="tag tag-gold">使用中</span>
          </button>
        </div>
      </div>

      <!-- ============ 历史皮肤 ============ -->
      <div class="card">
        <h3 class="section-title">历史皮肤（{{ historyList.length }}）</h3>
        <div v-if="loadingHistory" class="empty cape-loading"><span class="spin"></span></div>
        <div v-else-if="!historyList.length" class="empty history-empty">
          <span>暂无历史皮肤，上传皮肤后会自动保存到这里，方便随时换回</span>
        </div>
        <div v-else class="history-grid">
          <div v-for="item in historyList" :key="item.id" class="history-item">
            <div class="history-preview">
              <img
                :src="historyRenders[item.id] || item.dataUrl"
                class="history-img"
                alt="历史皮肤"
              />
              <div class="history-overlay">
                <button
                  class="btn btn-gold btn-sm"
                  :disabled="historyBusy !== null"
                  @click="onRestore(item)"
                >
                  {{ historyBusy === item.id ? '处理中…' : '换回' }}
                </button>
                <button
                  class="btn btn-danger btn-sm"
                  :disabled="historyBusy !== null"
                  @click="onDeleteHistory(item)"
                >
                  删除
                </button>
              </div>
            </div>
            <div class="history-meta">
              <span class="tag" :class="item.variant === 'slim' ? 'tag-cyan' : 'tag-gold'">
                {{ item.variant === 'slim' ? '纤细' : '经典' }}
              </span>
              <span class="muted history-time">{{ fmtTime(item.time) }}</span>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 860px;
  margin: 0 auto;
}

.section-title {
  font-size: 15px;
  margin-bottom: 14px;
}

/* ---------------- 非微软账号引导 ---------------- */
.need-ms {
  padding: 72px 20px;
}
.need-ms-icon {
  width: 52px;
  height: 52px;
  color: var(--accent);
  opacity: 0.8;
}
.need-ms-text {
  font-size: 14px;
}

/* ---------------- 当前皮肤卡片 ---------------- */
.skin-card {
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
}
.skin-card.drag-over {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.skin-main {
  display: flex;
  gap: 22px;
  align-items: flex-start;
}
.preview-box {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 168px;
  height: 300px;
  flex-shrink: 0;
  border: 1px dashed var(--border-strong);
  border-radius: 12px;
  background: var(--card-2);
  overflow: hidden;
}
.skin-img {
  width: 144px;
  image-rendering: pixelated;
}
.preview-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: var(--text-dim);
  font-size: 12px;
}
.preview-placeholder svg {
  width: 40px;
  height: 40px;
  opacity: 0.6;
}
.drag-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  color: var(--accent-2);
  font-size: 13px;
  font-weight: 600;
  text-align: center;
  padding: 0 12px;
}

.skin-side {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.skin-name-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.skin-username {
  font-size: 17px;
  font-weight: 700;
}

/* 待上传 */
.pending-box {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--accent);
  border-radius: 12px;
  background: var(--accent-soft);
}
.pending-img {
  width: 36px;
  height: 72px;
  flex-shrink: 0;
  image-rendering: pixelated;
}
.pending-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pending-name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 模型分段选择 */
.seg {
  display: inline-flex;
  align-self: flex-start;
  gap: 3px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--card-2);
}
.seg-btn {
  padding: 5px 14px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-dim);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
  white-space: nowrap;
}
.seg-btn:hover:not(.active) {
  color: var(--text);
}
.seg-btn.active {
  background: var(--accent-grad);
  color: var(--on-accent);
  font-weight: 600;
}

.skin-actions {
  display: flex;
  gap: 10px;
}
.skin-hint {
  font-size: 12px;
}
.hidden-input {
  display: none;
}

/* ---------------- 披风 ---------------- */
.cape-loading {
  padding: 28px;
}
.cape-empty {
  padding: 28px;
}
.cape-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 12px;
}
.cape-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 14px 10px 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--card-2);
  color: var(--text);
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.18s ease, background 0.18s ease, transform 0.12s ease;
}
.cape-item:hover:not(:disabled) {
  border-color: var(--accent-deep);
  transform: translateY(-2px);
}
.cape-item:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.cape-item.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.cape-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 72px;
  height: 112px;
  border-radius: 8px;
  background: var(--card);
  border: 1px solid var(--border);
  overflow: hidden;
}
.cape-img {
  width: 60px;
  image-rendering: pixelated;
}
.cape-alias {
  font-size: 12px;
  color: var(--text-dim);
  text-align: center;
  padding: 0 6px;
  word-break: break-all;
}
.cape-name {
  font-size: 13px;
  font-weight: 600;
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.cape-spin {
  margin: 2px 0;
}

/* ---------------- 历史皮肤 ---------------- */
.history-empty {
  padding: 28px;
}
.history-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 12px;
}
.history-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.history-preview {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 168px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--card-2);
  overflow: hidden;
}
.history-img {
  height: 144px;
  image-rendering: pixelated;
}
.history-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--mask);
  opacity: 0;
  transition: opacity 0.16s ease;
}
.history-preview:hover .history-overlay {
  opacity: 1;
}
.history-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.history-time {
  font-size: 11px;
  white-space: nowrap;
}
</style>
