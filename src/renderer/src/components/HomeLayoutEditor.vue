<script setup lang="ts">
/**
 * 首页布局编辑器：两列模块拖拽排序 + 显隐开关 + 恢复默认。
 * 布局存 settings.homeLayout（main=主列，side=右栏，数组顺序即渲染顺序）。
 */
import { reactive, ref } from 'vue'
import { errText, saveSettings, selectImage } from '../api'
import { store, toast } from '../store'
import { DEFAULT_BACKGROUND, DEFAULT_HOME_LAYOUT, HOME_MODULE_LABELS } from '@shared/types'
import type { BackgroundSettings, HomeLayout, Settings } from '@shared/types'

function save(patch: Partial<Settings>) {
  void saveSettings(patch)
    .then((s) => (store.settings = s))
    .catch((e) => toast('保存失败：' + errText(e), 'error')
  )
}

// ---------------- 拖拽排序 ----------------
const dragState = reactive({ col: '' as 'main' | 'side' | '', idx: -1 })

function onDragStart(col: 'main' | 'side', idx: number) {
  dragState.col = col
  dragState.idx = idx
}

function onDrop(col: 'main' | 'side', target: number) {
  if (dragState.col !== col || dragState.idx < 0 || !store.settings) return
  const arr = [...store.settings.homeLayout[col]]
  const [moved] = arr.splice(dragState.idx, 1)
  arr.splice(target, 0, moved)
  save({ homeLayout: { ...store.settings.homeLayout, [col]: arr } as HomeLayout })
  dragState.idx = -1
  dragState.col = ''
}

function onToggleVisible(col: 'main' | 'side', idx: number) {
  if (!store.settings) return
  const arr = store.settings.homeLayout[col].map((m, i) =>
    i === idx ? { ...m, visible: !m.visible } : m
  )
  save({ homeLayout: { ...store.settings.homeLayout, [col]: arr } as HomeLayout })
}

function resetLayout() {
  save({ homeLayout: structuredClone(DEFAULT_HOME_LAYOUT) })
  toast('已恢复默认布局', 'success')
}

// ---------------- 背景 ----------------
const bgModes = [
  { value: 'none', label: '默认底色' },
  { value: 'color', label: '纯色' },
  { value: 'image', label: '图片' }
] as const

function setBg(patch: Partial<BackgroundSettings>) {
  if (!store.settings) return
  save({ background: { ...store.settings.background, ...patch } })
}

async function pickImage() {
  try {
    const p = await selectImage()
    if (p) setBg({ image: p, mode: 'image' })
  } catch (e) {
    toast('选择图片失败：' + errText(e), 'error')
  }
}

function resetBg() {
  save({ background: structuredClone(DEFAULT_BACKGROUND) })
  toast('背景已恢复默认', 'success')
}
</script>

<template>
  <!-- 首页布局 -->
  <div class="card group">
    <div class="layout-head">
      <h3 class="group-title" style="margin-bottom: 0">首页布局</h3>
      <button class="btn btn-ghost btn-sm" @click="resetLayout">恢复默认布局</button>
    </div>
    <p class="muted group-hint">拖动 ☰ 手柄调整模块顺序，开关控制显示/隐藏，即时生效。</p>

    <div class="layout-cols">
      <div v-for="col in (['main', 'side'] as const)" :key="col" class="layout-col">
        <h4 class="layout-col-title">{{ col === 'main' ? '主列（左侧内容区）' : '右栏（信息面板）' }}</h4>
        <div
          v-for="(m, idx) in store.settings?.homeLayout?.[col] ?? []"
          :key="m.key"
          class="layout-item"
          :class="{ dragging: dragState.col === col && dragState.idx === idx }"
          draggable="true"
          @dragstart="onDragStart(col, idx)"
          @dragover.prevent
          @drop="onDrop(col, idx)"
        >
          <span class="layout-grip" title="拖动排序">☰</span>
          <span class="layout-name" :class="{ off: !m.visible }">{{ HOME_MODULE_LABELS[m.key] ?? m.key }}</span>
          <span class="switch">
            <input type="checkbox" :checked="m.visible" @change="onToggleVisible(col, idx)" />
            <span class="switch-ui"></span>
          </span>
        </div>
      </div>
    </div>
  </div>

  <!-- 背景 -->
  <div class="card group">
    <div class="layout-head">
      <h3 class="group-title" style="margin-bottom: 0">背景</h3>
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
      <div class="bg-row">
        <span class="muted bg-label">背景图片</span>
        <button class="btn btn-ghost btn-sm" @click="pickImage">选择图片…</button>
        <span class="muted bg-img-path" :title="store.settings.background.image">
          {{ store.settings.background.image ? '已选择' : '未选择' }}
        </span>
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
</template>

<style scoped>
.layout-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.layout-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-top: 8px;
}
.layout-col-title {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text-dim);
  margin-bottom: 8px;
}
.layout-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  margin-bottom: 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card-2);
  cursor: grab;
  transition: border-color 0.15s ease, opacity 0.15s ease;
}
.layout-item.dragging {
  opacity: 0.4;
  border-color: var(--accent);
}
.layout-grip {
  color: var(--text-dim);
  cursor: grab;
  font-size: 13px;
  user-select: none;
}
.layout-name {
  flex: 1;
  font-size: 13px;
}
.layout-name.off {
  color: var(--text-dim);
  text-decoration: line-through;
}

/* 背景 */
.bg-modes {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
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
