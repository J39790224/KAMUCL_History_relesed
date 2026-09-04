<script setup lang="ts">
/**
 * 账号方块头像：watch 当前选中账号 → getSkinAvatar()
 * - 微软：返回整皮肤 dataURL，renderSkinHead 裁头部渲染 MC 方块头像
 * - 离线：minotar 已是成品头盔头像，直接展示
 * - null / 加载失败：首字母圆形头像兜底
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import type { Account } from '@shared/types'
import { getSkinAvatar } from '../api'
import { renderSkinHead } from '../skin-render'
import { store } from '../store'

const props = withDefaults(defineProps<{ size?: number; account?: Account | null }>(), { size: 48 })
const account = computed(() => props.account === undefined ? store.selectedAccount : props.account)

const head = ref('')
let generation = 0
onUnmounted(() => { generation++ })

async function load() {
  const request = ++generation
  head.value = ''
  const acc = account.value
  if (!acc) return
  let data: string | null = null
  try {
    data = await getSkinAvatar(acc.id)
  } catch {
    data = null
  }
  // 账号在加载期间被切换则丢弃过期结果
  if (!data || request !== generation) return
  const rendered = acc.type !== 'offline' ? await renderSkinHead(data, Math.max(64, props.size * 2)) : data
  if (request === generation) head.value = rendered
}

watch(() => account.value?.id, load, { immediate: true })

const letter = computed(() => account.value?.username.charAt(0).toUpperCase() ?? '?')
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
