<script setup lang="ts">
/** 图一固定布局下的个性化背景与启动卡图片管理。 */
import { ref } from 'vue'
import {
  errText,
  importBackground,
  importLaunchThumbnail,
  resetBackground,
  resetLaunchThumbnail,
  saveSettings
} from '../api'
import { store, toast } from '../store'
import { managedImageUrl } from '../managedAssets'
import type { BackgroundSettings, ImageFit, Settings } from '@shared/types'

function save(patch: Partial<Settings>) {
  void saveSettings(patch)
    .then((s) => (store.settings = s))
    .catch((e) => toast('保存失败：' + errText(e), 'error')
  )
}

// ---------------- 背景 ----------------
const bgModes = [
  { value: 'none', label: '系统桌面' },
  { value: 'color', label: '纯色' },
  { value: 'image', label: '图片' }
] as const
const fitModes: Array<{ value: ImageFit; label: string }> = [
  { value: 'fill', label: '填充' },
  { value: 'fit', label: '适应' },
  { value: 'crop', label: '裁切' }
]
const importingBackground = ref(false)
const importingThumbnail = ref(false)
const backgroundPreviewFailed = ref(false)
const thumbnailPreviewFailed = ref(false)

function fitCss(fit: ImageFit): 'fill' | 'contain' | 'cover' {
  return fit === 'fill' ? 'fill' : fit === 'fit' ? 'contain' : 'cover'
}

function setBg(patch: Partial<BackgroundSettings>) {
  if (!store.settings) return
  save({ background: { ...store.settings.background, ...patch } })
}

async function pickImage() {
  if (importingBackground.value) return
  importingBackground.value = true
  try {
    const settings = await importBackground()
    if (settings) {
      store.settings = settings
      backgroundPreviewFailed.value = false
      toast('背景已复制并优化到 KAMUCL 资源目录', 'success')
    }
  } catch (e) {
    toast('导入背景失败：' + errText(e), 'error')
  } finally {
    importingBackground.value = false
  }
}

async function resetBg() {
  try {
    store.settings = await resetBackground()
    backgroundPreviewFailed.value = false
    toast('背景已恢复默认', 'success')
  } catch (error) {
    toast('恢复背景失败：' + errText(error), 'error')
  }
}

async function pickLaunchThumbnail() {
  if (importingThumbnail.value) return
  importingThumbnail.value = true
  try {
    const settings = await importLaunchThumbnail()
    if (settings) {
      store.settings = settings
      thumbnailPreviewFailed.value = false
      toast('启动卡缩略图已保存到 KAMUCL 资源目录', 'success')
    }
  } catch (error) {
    toast('导入缩略图失败：' + errText(error), 'error')
  } finally {
    importingThumbnail.value = false
  }
}

async function resetThumbnail() {
  try {
    store.settings = await resetLaunchThumbnail()
    thumbnailPreviewFailed.value = false
    toast('启动卡已恢复内置轮播图片', 'success')
  } catch (error) {
    toast('恢复缩略图失败：' + errText(error), 'error')
  }
}

function setLaunchFit(fit: ImageFit) {
  if (!store.settings) return
  save({ launchThumbnail: { ...store.settings.launchThumbnail, fit } })
}
</script>

<template>
  <!-- 背景 -->
  <div class="card group">
    <div class="layout-head">
      <div>
        <h3 class="group-title" style="margin-bottom: 2px">窗口背景</h3>
        <p class="muted group-hint" style="margin: 0">默认透出并模糊真实系统桌面；图片模式仅在你主动选择时启用。</p>
      </div>
      <button class="btn btn-ghost btn-sm" @click="resetBg">恢复默认</button>
    </div>

    <div class="bg-modes">
      <button
        v-for="m in bgModes"
        :key="m.value"
        class="capsule"
        :class="{ active: store.settings?.background.mode === m.value }"
        @click="setBg({ mode: m.value })"
      >
        {{ m.label }}
      </button>
    </div>

    <template v-if="store.settings?.background.mode === 'color'">
      <div class="bg-row">
        <span class="muted bg-label">背景色</span>
        <input
          type="color"
          class="color-swatch"
          :value="store.settings.background.color"
          @input="setBg({ color: ($event.target as HTMLInputElement).value })"
        />
        <span class="mono muted">{{ store.settings.background.color }}</span>
      </div>
    </template>

    <template v-if="store.settings?.background.mode === 'image'">
      <div v-if="store.settings.background.image && !backgroundPreviewFailed" class="image-preview background-preview">
        <img
          :src="managedImageUrl(store.settings.background.image)"
          :style="{ objectFit: fitCss(store.settings.background.fit) }"
          alt="自定义背景预览"
          @error="backgroundPreviewFailed = true"
        />
      </div>
      <div v-else class="image-preview image-preview-empty">
        {{ backgroundPreviewFailed ? '受管背景不可用，将自动回退默认背景' : '尚未导入背景图片' }}
      </div>
      <div class="bg-row">
        <span class="muted bg-label">背景图片</span>
        <button class="btn btn-ghost btn-sm" :disabled="importingBackground" @click="pickImage">
          {{ importingBackground ? '处理中…' : '导入图片…' }}
        </button>
        <span class="muted bg-img-path" :title="store.settings.background.image">
          {{ store.settings.background.image ? '已由 KAMUCL 管理' : '未选择' }}
        </span>
      </div>
      <div class="bg-row">
        <span class="muted bg-label">显示方式</span>
        <div class="fit-options">
          <button
            v-for="fit in fitModes"
            :key="fit.value"
            class="capsule"
            :class="{ active: store.settings.background.fit === fit.value }"
            @click="setBg({ fit: fit.value })"
          >
            {{ fit.label }}
          </button>
        </div>
      </div>
      <div class="bg-row">
        <span class="muted bg-label">透明度</span>
        <input
          type="range"
          class="slider"
          min="0.05"
          max="1"
          step="0.05"
          :value="store.settings.background.opacity"
          @input="setBg({ opacity: Number(($event.target as HTMLInputElement).value) })"
        />
        <span class="muted bg-val">{{ Math.round(store.settings.background.opacity * 100) }}%</span>
      </div>
      <div class="bg-row">
        <span class="muted bg-label">模糊度</span>
        <input
          type="range"
          class="slider"
          min="0"
          max="40"
          step="2"
          :value="store.settings.background.blur"
          @input="setBg({ blur: Number(($event.target as HTMLInputElement).value) })"
        />
        <span class="muted bg-val">{{ store.settings.background.blur }}px</span>
      </div>
    </template>
  </div>

  <!-- 首页启动卡全局缩略图 -->
  <div class="card group">
    <div class="layout-head">
      <div>
        <h3 class="group-title" style="margin-bottom: 2px">首页启动卡</h3>
        <p class="muted group-hint" style="margin: 0">实例专属图片优先；未设置时使用这里的全局图片，再回退内置轮播。</p>
      </div>
      <button class="btn btn-ghost btn-sm" @click="resetThumbnail">恢复内置轮播</button>
    </div>
    <div v-if="store.settings?.launchThumbnail.image && !thumbnailPreviewFailed" class="image-preview launch-preview">
      <img
        :src="managedImageUrl(store.settings.launchThumbnail.image)"
        :style="{ objectFit: fitCss(store.settings.launchThumbnail.fit) }"
        alt="启动卡缩略图预览"
        @error="thumbnailPreviewFailed = true"
      />
    </div>
    <div v-else class="image-preview image-preview-empty">
      {{ thumbnailPreviewFailed ? '缩略图不可用，将自动使用内置轮播' : '当前使用内置三图轮播' }}
    </div>
    <div class="bg-row">
      <span class="muted bg-label">默认图片</span>
      <button class="btn btn-ghost btn-sm" :disabled="importingThumbnail" @click="pickLaunchThumbnail">
        {{ importingThumbnail ? '处理中…' : '导入图片…' }}
      </button>
      <span class="muted bg-img-path">
        {{ store.settings?.launchThumbnail.image ? '已由 KAMUCL 管理' : '内置轮播' }}
      </span>
    </div>
    <div class="bg-row">
      <span class="muted bg-label">显示方式</span>
      <div class="fit-options">
        <button
          v-for="fit in fitModes"
          :key="fit.value"
          class="capsule"
          :class="{ active: store.settings?.launchThumbnail.fit === fit.value }"
          @click="setLaunchFit(fit.value)"
        >
          {{ fit.label }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.layout-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
/* 背景 */
.bg-modes {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
}
.fit-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.image-preview {
  width: 100%;
  height: 150px;
  margin: 12px 0 6px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card-2);
}
.image-preview img {
  display: block;
  width: 100%;
  height: 100%;
}
.image-preview-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  color: var(--text-dim);
  font-size: 12.5px;
  text-align: center;
}
.launch-preview {
  aspect-ratio: 16 / 7;
  height: auto;
  max-height: 220px;
}
.bg-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 0;
}
.bg-label {
  flex: 0 0 60px;
  font-size: 13px;
}
.bg-val {
  flex-shrink: 0;
  min-width: 44px;
  text-align: right;
  font-weight: 700;
  color: var(--accent-2);
  font-size: 12.5px;
}
.bg-img-path {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.color-swatch {
  -webkit-appearance: none;
  appearance: none;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: transparent;
  cursor: pointer;
}
.color-swatch::-webkit-color-swatch-wrapper {
  padding: 3px;
}
.color-swatch::-webkit-color-swatch {
  border: none;
  border-radius: 6px;
}
.mono {
  font-size: 12px;
}
</style>
