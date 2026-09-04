<script setup lang="ts">
import { ref, watch } from 'vue'
import {
  errText,
  resetVersionThumbnail,
  setVersionThumbnailFit,
  uploadVersionThumbnail
} from '../api'
import { refreshInstalled, toast } from '../store'
import { managedImageUrl } from '../managedAssets'
import type { ImageFit } from '@shared/types'

const props = defineProps<{
  open: boolean
  versionId: string
  currentPath: string
  currentFit: ImageFit
}>()
const emit = defineEmits<{ close: [] }>()

const imagePath = ref('')
const fit = ref<ImageFit>('crop')
const busy = ref(false)
const previewFailed = ref(false)
const fitOptions: Array<{ value: ImageFit; label: string }> = [
  { value: 'fill', label: '填充' },
  { value: 'fit', label: '适应' },
  { value: 'crop', label: '裁切' }
]

watch(
  () => [props.open, props.currentPath, props.currentFit] as const,
  ([open, currentPath, currentFit]) => {
    if (!open) return
    imagePath.value = currentPath
    fit.value = currentFit
    previewFailed.value = false
  },
  { immediate: true }
)

function objectFit(value: ImageFit): 'fill' | 'contain' | 'cover' {
  return value === 'fill' ? 'fill' : value === 'fit' ? 'contain' : 'cover'
}

async function importImage() {
  if (busy.value) return
  busy.value = true
  try {
    const imported = await uploadVersionThumbnail(props.versionId)
    if (!imported) return
    imagePath.value = imported
    previewFailed.value = false
    await refreshInstalled()
    toast('实例启动卡缩略图已更新', 'success')
  } catch (error) {
    toast('导入缩略图失败：' + errText(error), 'error')
  } finally {
    busy.value = false
  }
}

async function chooseFit(value: ImageFit) {
  if (!imagePath.value || busy.value) return
  busy.value = true
  try {
    await setVersionThumbnailFit(props.versionId, value)
    fit.value = value
    await refreshInstalled()
  } catch (error) {
    toast('保存显示方式失败：' + errText(error), 'error')
  } finally {
    busy.value = false
  }
}

async function resetImage() {
  if (busy.value) return
  busy.value = true
  try {
    await resetVersionThumbnail(props.versionId)
    imagePath.value = ''
    previewFailed.value = false
    await refreshInstalled()
    toast('已恢复全局启动卡图片', 'success')
  } catch (error) {
    toast('恢复失败：' + errText(error), 'error')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" @pointerdown.self="emit('close')">
      <div class="modal thumbnail-modal">
        <div class="thumbnail-head">
          <div>
            <h3 class="modal-title">启动卡缩略图 · {{ versionId }}</h3>
            <p class="modal-label">实例图片优先于个性化设置中的全局默认图片。</p>
          </div>
          <button class="icon-btn" title="关闭" @click="emit('close')">×</button>
        </div>

        <div v-if="imagePath && !previewFailed" class="thumbnail-preview">
          <img
            :src="managedImageUrl(imagePath)"
            :style="{ objectFit: objectFit(fit) }"
            alt="实例启动卡预览"
            @error="previewFailed = true"
          />
        </div>
        <div v-else class="thumbnail-preview thumbnail-empty">
          {{ previewFailed ? '图片不可用，首页将自动回退' : '当前跟随全局图片或内置轮播' }}
        </div>

        <div class="thumbnail-actions">
          <button class="btn btn-gold" :disabled="busy" @click="importImage">
            {{ busy ? '处理中…' : '导入图片…' }}
          </button>
          <button class="btn btn-ghost" :disabled="busy || !imagePath" @click="resetImage">
            恢复全局默认
          </button>
        </div>

        <div class="thumbnail-fit">
          <span class="muted">显示方式</span>
          <div class="thumbnail-fit-options">
            <button
              v-for="option in fitOptions"
              :key="option.value"
              class="capsule"
              :class="{ active: fit === option.value }"
              :disabled="busy || !imagePath"
              @click="chooseFit(option.value)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>
        <p class="thumbnail-note muted">PNG、JPG、JPEG、WebP 会经过尺寸与内容校验，并复制到 KAMUCL 管理目录；原文件移动后不受影响。</p>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.thumbnail-modal {
  width: min(600px, calc(100vw - 48px));
}
.thumbnail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.thumbnail-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 16 / 7;
  margin: 18px 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card-2);
}
.thumbnail-preview img {
  width: 100%;
  height: 100%;
}
.thumbnail-empty {
  padding: 24px;
  color: var(--text-dim);
  font-size: 13px;
  text-align: center;
}
.thumbnail-actions,
.thumbnail-fit,
.thumbnail-fit-options {
  display: flex;
  align-items: center;
  gap: 8px;
}
.thumbnail-actions {
  margin-bottom: 16px;
}
.thumbnail-fit {
  justify-content: space-between;
  padding: 12px 0;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}
.thumbnail-note {
  margin-top: 14px;
  font-size: 11.5px;
  line-height: 1.55;
}
</style>
