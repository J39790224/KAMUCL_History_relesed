<script setup lang="ts">
/**
 * 重复 MOD 清理：单版本查重（默认保留最新版，可改选）+ 跨版本查重对比
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { errText, findModCrossDuplicates, findModDuplicates, removeFs } from '../api'
import { store, toast } from '../store'
import type { ModCrossDuplicate, ModDuplicateGroup } from '@shared/types'

const props = defineProps<{
  open: boolean
  /** 当前管理版本 id */
  versionId: string
  /** 当前版本 mods 相对目录（用于删除文件） */
  rel: string
}>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'deleted'): void }>()

const tab = ref<'single' | 'cross'>('single')

// ---------------- 单版本查重 ----------------
const loading = ref(false)
const groups = ref<ModDuplicateGroup[]>([])
/** 每组选中的保留文件名（默认最新版） */
const keepMap = reactive<Record<string, string>>({})

/** 将删除的文件清单 */
const deleteList = computed(() => {
  const out: Array<{ group: string; fileName: string }> = []
  for (const g of groups.value) {
    const keep = keepMap[g.modId] ?? g.files[0]?.fileName
    for (const f of g.files) {
      if (f.fileName !== keep) out.push({ group: g.name, fileName: f.fileName })
    }
  }
  return out
})

async function scanSingle() {
  loading.value = true
  groups.value = []
  try {
    const list = await findModDuplicates(props.versionId)
    groups.value = list
    for (const g of list) {
      keepMap[g.modId] = g.files.find((f) => f.latest)?.fileName ?? g.files[0]?.fileName ?? ''
    }
  } catch (e) {
    toast('扫描失败：' + errText(e), 'error')
  } finally {
    loading.value = false
  }
}

const deleting = ref(false)
async function onConfirmDelete() {
  if (deleting.value || !deleteList.value.length) return
  deleting.value = true
  let ok = 0
  try {
    for (const item of deleteList.value) {
      try {
        await removeFs(props.rel, item.fileName)
        ok++
      } catch {
        /* 单文件失败继续 */
      }
    }
    toast(`已删除 ${ok} 个重复 MOD 文件`, 'success')
    emit('deleted')
    emit('close')
  } finally {
    deleting.value = false
  }
}

// ---------------- 跨版本查重 ----------------
const crossSel = ref<string[]>([])
const crossLoading = ref(false)
const crossResults = ref<ModCrossDuplicate[] | null>(null)

async function scanCross() {
  if (!crossSel.value.length) {
    toast('请先勾选要对比的版本', 'info')
    return
  }
  crossLoading.value = true
  crossResults.value = null
  try {
    crossResults.value = await findModCrossDuplicates(crossSel.value)
  } catch (e) {
    toast('对比失败：' + errText(e), 'error')
  } finally {
    crossLoading.value = false
  }
}

function toggleCross(id: string) {
  const i = crossSel.value.indexOf(id)
  if (i >= 0) crossSel.value.splice(i, 1)
  else crossSel.value.push(id)
}

onMounted(() => {
  crossSel.value = props.versionId ? [props.versionId] : []
  void scanSingle()
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" @click.self="emit('close')">
      <div class="modal dup-modal">
        <h3 class="modal-title">清理重复 MOD</h3>

        <div class="dup-tabs">
          <button class="game-tab" :class="{ active: tab === 'single' }" @click="tab = 'single'">本版本清理</button>
          <button class="game-tab" :class="{ active: tab === 'cross' }" @click="tab = 'cross'">跨版本查重</button>
        </div>

        <!-- 单版本 -->
        <template v-if="tab === 'single'">
          <div v-if="loading" class="dup-loading"><span class="spin"></span><span class="muted">正在解析 MOD 文件…</span></div>
          <div v-else-if="!groups.length" class="dup-empty muted">该版本没有重复的 MOD ✓</div>
          <template v-else>
            <p class="muted dup-hint">发现 {{ groups.length }} 组重复 MOD（同一 mod id 多文件共存）。每组选择一个保留版本，其余将删除：</p>
            <div class="dup-list">
              <div v-for="g in groups" :key="g.modId" class="dup-group">
                <div class="dup-group-head">
                  <span class="dup-group-name">{{ g.name }}</span>
                  <span class="muted">{{ g.modId }}</span>
                </div>
                <label
                  v-for="f in g.files"
                  :key="f.fileName"
                  class="dup-file"
                  :class="{ keep: keepMap[g.modId] === f.fileName }"
                >
                  <input
                    v-model="keepMap[g.modId]"
                    type="radio"
                    :value="f.fileName"
                    :name="'keep-' + g.modId"
                  />
                  <span class="dup-file-name">{{ f.fileName }}</span>
                  <span class="muted">v{{ f.version || '?' }}</span>
                  <span v-if="f.latest" class="tag">最新</span>
                </label>
              </div>
            </div>
            <div class="modal-actions">
              <span class="muted del-count">将删除 {{ deleteList.length }} 个文件</span>
              <button class="btn btn-ghost" @click="emit('close')">取消</button>
              <button class="btn btn-danger" :disabled="deleting || !deleteList.length" @click="onConfirmDelete">
                {{ deleting ? '删除中…' : `确认删除（${deleteList.length}）` }}
              </button>
            </div>
          </template>
        </template>

        <!-- 跨版本 -->
        <template v-else>
          <p class="modal-label">勾选要对比的版本（≥2 个）</p>
          <div class="cross-versions">
            <label
              v-for="v in store.installed"
              :key="v.id"
              class="ver-chip"
              :class="{ active: crossSel.includes(v.id) }"
            >
              <input type="checkbox" :checked="crossSel.includes(v.id)" @change="toggleCross(v.id)" />
              {{ v.id }}
            </label>
          </div>
          <button class="btn btn-gold btn-sm" :disabled="crossLoading" @click="scanCross">
            {{ crossLoading ? '对比中…' : '开始对比' }}
          </button>
          <div v-if="crossResults" class="dup-list" style="margin-top: 12px">
            <div v-if="!crossResults.length" class="dup-empty muted">所选版本间没有重复 MOD ✓</div>
            <div v-for="g in crossResults" :key="g.modId" class="dup-group">
              <div class="dup-group-head">
                <span class="dup-group-name">{{ g.name }}</span>
                <span class="tag">×{{ g.presentIn.length }} 个版本</span>
              </div>
              <div v-for="p in g.presentIn" :key="p.versionId" class="dup-file cross-row">
                <span class="dup-file-name">{{ p.versionId }}</span>
                <span class="muted">{{ p.fileName }}</span>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.dup-modal {
  width: 560px;
  max-height: 84vh;
  overflow-y: auto;
}
.dup-tabs {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card-2);
  margin-bottom: 12px;
}
.game-tab {
  padding: 6px 16px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--text-dim);
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.game-tab.active {
  background: var(--accent-grad);
  color: var(--on-accent);
}
.dup-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 24px 0;
  justify-content: center;
}
.dup-empty {
  padding: 28px 0;
  text-align: center;
}
.dup-hint {
  font-size: 12.5px;
  line-height: 1.6;
  margin-bottom: 10px;
}
.dup-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 380px;
  overflow-y: auto;
}
.dup-group {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card-2);
  padding: 8px 10px;
}
.dup-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.dup-group-name {
  font-size: 13.5px;
  font-weight: 700;
}
.dup-file {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 12.5px;
}
.dup-file.keep {
  background: var(--accent-soft);
}
.dup-file input {
  accent-color: var(--accent);
}
.dup-file-name {
  flex: 1;
  min-width: 0;
  word-break: break-all;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
}
.cross-row {
  cursor: default;
}
.del-count {
  margin-right: auto;
  font-size: 12.5px;
}
.cross-versions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}
.ver-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 11px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card-2);
  font-size: 12.5px;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.ver-chip.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-2);
}
.ver-chip input {
  display: none;
}
</style>
