<script setup lang="ts">
/**
 * 账号方块头像：watch 当前选中账号 → getSkinAvatar()
 * - 微软：返回整皮肤 dataURL，renderSkinHead 裁头部渲染 MC 方块头像
 * - 离线：minotar 已是成品头盔头像，直接展示
 * - null / 加载失败：首字母圆形头像兜底
 */
import { computed, ref, watch } from 'vue'
import { getSkinAvatar } from '../api'
import { renderSkinHead } from '../skin-render'
import { store } from '../store'

const props = withDefaults(defineProps<{ size?: number }>(), { size: 48 })

const head = ref('')

async function load() {
  head.value = ''
  const acc = store.selectedAccount
  if (!acc) return
  let data: string | null = null
  try {
    data = await getSkinAvatar()
  } catch {
    data = null
  }
  // 账号在加载期间被切换则丢弃过期结果
  if (!data || store.selectedAccount?.id !== acc.id) return
  head.value =
    acc.type === 'microsoft' ? await renderSkinHead(data, Math.max(64, props.size * 2)) : data
}

watch(() => store.selectedAccount?.id, load, { immediate: true })

const letter = computed(() => store.selectedAccount?.username.charAt(0).toUpperCase() ?? '?')
const px = computed(() => `${props.size}px`)
const fontPx = computed(() => `${Math.round(props.size * 0.42)}px`)
</script>

<template>
  <img v-if="head" :src="head" class="mc-avatar" :style="{ width: px, height: px }" alt="头像" />
  <div v-else class="mc-avatar letter" :style="{ width: px, height: px, fontSize: fontPx }">
    {{ letter }}
  </div>
</template>

<style scoped>
.mc-avatar {
  border-radius: 8px;
  image-rendering: pixelated;
  flex-shrink: 0;
}
.letter {
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 800;
  color: var(--on-accent);
  background: var(--accent-grad);
  border-radius: 50%;
}
</style>
