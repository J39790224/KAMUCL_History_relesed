<script setup lang="ts">
/**
 * 默认配置：启动器级默认按键 + 其他游戏配置。
 * 左右分区：左侧按键配置，右侧其他游戏配置（FOV/灵敏度/亮度/视频/潜行疾跑/资源包）。
 * 两个同步开关独立：按键设置同步 / 其他设置同步，分别决定是否写入实例 options.txt。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { errText, getDefaultKeys, getDefaultOptions, resetDefaultKeys, resetDefaultOptions, setDefaultKey, setDefaultOption } from '../api'
import { store, toast } from '../store'
import { updateSettings } from '../settingsUpdates'
import { KEYBIND_CATEGORIES, VANILLA_KEYBINDS, VANILLA_OPTIONS, OPTION_CATEGORIES, codeToMcKey, mcKeyLabel, mouseButtonToMcKey } from '@shared/keybindings'
import type { GameOptionDef } from '@shared/keybindings'

const keys = ref<Record<string, string>>({})
const options = ref<Record<string, string>>({})
const loading = ref(true)
const keySearch = ref('')
const capturing = ref('')

const keySync = computed(() => store.settings?.keySync === true)
const optionsSync = computed(() => store.settings?.optionsSync === true)

async function toggleKeySync(on: boolean) {
  try {
    await updateSettings({ keySync: on })
    store.settings = { ...store.settings!, keySync: on }
    toast(on ? '已开启按键设置同步' : '已关闭按键设置同步', 'success')
  } catch (e) {
    toast('保存失败：' + errText(e), 'error')
  }
}
async function toggleOptionsSync(on: boolean) {
  try {
    await updateSettings({ optionsSync: on })
    store.settings = { ...store.settings!, optionsSync: on }
    toast(on ? '已开启其他设置同步' : '已关闭其他设置同步', 'success')
  } catch (e) {
    toast('保存失败：' + errText(e), 'error')
  }
}

// ---------------- 按键（左列） ----------------
const keyGrouped = computed(() => {
  const kw = keySearch.value.trim().toLowerCase()
  const match = (id: string, label: string, bind: string) =>
    !kw || label.toLowerCase().includes(kw) || id.toLowerCase().includes(kw) || mcKeyLabel(bind).toLowerCase().includes(kw)
  return KEYBIND_CATEGORIES.map((cat) => ({
    category: cat,
    items: VANILLA_KEYBINDS.filter((d) => d.category === cat && match(d.id, d.label, keys.value[d.id] ?? d.defaultBind))
  })).filter((g) => g.items.length)
})
const keyModifiedCount = computed(() =>
  VANILLA_KEYBINDS.filter((d) => (keys.value[d.id] ?? d.defaultBind) !== d.defaultBind).length
)

function startCapture(id: string) {
  capturing.value = id
  addEventListener('keydown', onCaptureKey, true)
  addEventListener('mousedown', onCaptureMouse, true)
}
function stopCapture() {
  capturing.value = ''
  removeEventListener('keydown', onCaptureKey, true)
  removeEventListener('mousedown', onCaptureMouse, true)
}
async function onCaptureKey(e: KeyboardEvent) {
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape') { stopCapture(); return }
  const bind = codeToMcKey(e.code)
  if (!bind) return
  const id = capturing.value
  stopCapture()
  await applyKey(id, bind)
}
async function onCaptureMouse(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  const bind = mouseButtonToMcKey(e.button)
  if (!bind) return
  const id = capturing.value
  stopCapture()
  await applyKey(id, bind)
}
async function applyKey(id: string, bind: string) {
  try {
    keys.value = await setDefaultKey(id, bind)
    toast('已更新默认按键', 'success')
  } catch (e) {
    toast('设置失败：' + errText(e), 'error')
  }
}
async function resetOneKey(id: string) {
  const def = VANILLA_KEYBINDS.find((d) => d.id === id)
  if (!def) return
  await applyKey(id, def.defaultBind)
}
async function resetAllKeys() {
  try {
    keys.value = await resetDefaultKeys()
    toast('按键已全部恢复为 MC 原版默认', 'success')
  } catch (e) {
    toast('重置失败：' + errText(e), 'error')
  }
}

// ---------------- 其他游戏配置（右列） ----------------
const optionGrouped = computed(() =>
  OPTION_CATEGORIES.map((cat) => ({
    category: cat,
    items: VANILLA_OPTIONS.filter((d) => d.category === cat)
  })).filter((g) => g.items.length)
)
const optionModifiedCount = computed(() =>
  VANILLA_OPTIONS.filter((d) => (options.value[d.id] ?? serialize(d.defaultValue)) !== serialize(d.defaultValue)).length
)
function serialize(v: number | string | boolean): string {
  return typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v)
}
function optionValue(def: GameOptionDef): string {
  return options.value[def.id] ?? serialize(def.defaultValue)
}
async function applyOption(def: GameOptionDef, value: string) {
  try {
    options.value = await setDefaultOption(def.id, value)
    toast(`已更新「${def.label}」`, 'success')
  } catch (e) {
    toast('设置失败：' + errText(e), 'error')
  }
}
async function resetOneOption(def: GameOptionDef) {
  await applyOption(def, serialize(def.defaultValue))
}
async function resetAllOptions() {
  try {
    options.value = await resetDefaultOptions()
    toast('其他配置已全部恢复为 MC 原版默认', 'success')
  } catch (e) {
    toast('重置失败：' + errText(e), 'error')
  }
}

onMounted(async () => {
  try {
    ;[keys.value, options.value] = await Promise.all([getDefaultKeys(), getDefaultOptions()])
  } catch (e) {
    toast('读取默认配置失败：' + errText(e), 'error')
  } finally {
    loading.value = false
  }
})
onUnmounted(stopCapture)
</script>

<template>
  <div class="page cfg-page">
    <div class="page-head">
      <h1 class="page-title">默认配置</h1>
      <p class="page-sub">按键与其他游戏配置的默认值；开启对应同步后，启动任何版本时自动写入该实例的 options.txt</p>
    </div>

    <!-- 两个独立同步开关 -->
    <div class="cfg-switches">
      <div class="card group-inline cfg-switch">
        <div>
          <h3 class="group-title">按键设置同步</h3>
          <p class="muted group-hint">启动任意版本时，用左侧默认按键覆盖该实例 options.txt 的 key_* 项</p>
        </div>
        <label class="switch">
          <input type="checkbox" :checked="keySync" @change="toggleKeySync(($event.target as HTMLInputElement).checked)" />
          <span class="switch-ui"></span>
        </label>
      </div>
      <div class="card group-inline cfg-switch">
        <div>
          <h3 class="group-title">其他设置同步</h3>
          <p class="muted group-hint">启动任意版本时，用右侧默认配置覆盖该实例 options.txt 的对应项（FOV/灵敏度/亮度/视频/操作方式/资源包）</p>
        </div>
        <label class="switch">
          <input type="checkbox" :checked="optionsSync" @change="toggleOptionsSync(($event.target as HTMLInputElement).checked)" />
          <span class="switch-ui"></span>
        </label>
      </div>
    </div>

    <div v-if="loading" class="card empty"><span class="spin"></span></div>
    <div v-else class="cfg-columns">
      <!-- 左：按键配置 -->
      <div class="card cfg-col">
        <div class="cfg-col-head">
          <div>
            <h3 class="group-title">按键配置</h3>
            <p class="muted group-hint" style="margin: 2px 0 0">对应游戏内「选项 → 控制 → 按键控制」</p>
          </div>
          <button class="btn btn-ghost btn-sm" :disabled="!keyModifiedCount" @click="resetAllKeys">全部恢复默认</button>
        </div>
        <input v-model="keySearch" class="input cfg-search" placeholder="搜索按键名称…" />
        <div class="cfg-scroll">
          <div v-for="group in keyGrouped" :key="group.category" class="cfg-group">
            <h4 class="cfg-cat">{{ group.category }}</h4>
            <div v-for="item in group.items" :key="item.id" class="cfg-row">
              <span class="cfg-label" :title="item.id">{{ item.label }}</span>
              <button
                class="cfg-bind"
                :class="{ capturing: capturing === item.id, modified: (keys[item.id] ?? item.defaultBind) !== item.defaultBind }"
                :title="capturing === item.id ? '按任意键设置，Esc 取消' : '点击后按任意键修改'"
                @click="startCapture(item.id)"
              >
                {{ capturing === item.id ? '按任意键…' : mcKeyLabel(keys[item.id] ?? item.defaultBind) }}
              </button>
              <button
                class="cfg-reset"
                :class="{ invisible: (keys[item.id] ?? item.defaultBind) === item.defaultBind }"
                title="恢复此项默认"
                @click="resetOneKey(item.id)"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9"/><path d="M3 4v5h5"/></svg>
              </button>
            </div>
          </div>
          <div v-if="!keyGrouped.length" class="empty"><span>没有匹配「{{ keySearch }}」的按键</span></div>
        </div>
      </div>

      <!-- 右：其他游戏配置 -->
      <div class="card cfg-col">
        <div class="cfg-col-head">
          <div>
            <h3 class="group-title">其他游戏配置</h3>
            <p class="muted group-hint" style="margin: 2px 0 0">对应游戏内「视频设置 / 鼠标设置 / 辅助功能 / 资源包」</p>
          </div>
          <button class="btn btn-ghost btn-sm" :disabled="!optionModifiedCount" @click="resetAllOptions">全部恢复默认</button>
        </div>
        <div class="cfg-scroll">
          <div v-for="group in optionGrouped" :key="group.category" class="cfg-group">
            <h4 class="cfg-cat">{{ group.category }}</h4>
            <div v-for="item in group.items" :key="item.id" class="cfg-row cfg-row-option">
              <span class="cfg-label" :title="item.description || item.id">
                {{ item.label }}
                <small v-if="item.description" class="cfg-label-desc">{{ item.description }}</small>
              </span>
              <!-- 滑块 -->
              <template v-if="item.type === 'slider'">
                <input
                  type="range"
                  class="slider cfg-slider"
                  :min="item.min"
                  :max="item.max"
                  :step="item.step"
                  :value="optionValue(item)"
                  @change="applyOption(item, ($event.target as HTMLInputElement).value)"
                />
                <span class="cfg-slider-val">{{ optionValue(item) }}{{ item.unit ?? '' }}</span>
              </template>
              <!-- 下拉 -->
              <select
                v-else-if="item.type === 'select'"
                class="select cfg-select"
                :value="optionValue(item)"
                @change="applyOption(item, ($event.target as HTMLSelectElement).value)"
              >
                <option v-for="o in item.options" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
              <!-- 开关 -->
              <label v-else-if="item.type === 'boolean'" class="switch cfg-switch-inline">
                <input
                  type="checkbox"
                  :checked="optionValue(item) === 'true'"
                  @change="applyOption(item, String(($event.target as HTMLInputElement).checked))"
                />
                <span class="switch-ui"></span>
              </label>
              <!-- 文本（资源包列表） -->
              <input
                v-else
                class="input cfg-text"
                :value="optionValue(item)"
                placeholder="file/包名.zip，逗号分隔"
                @change="applyOption(item, ($event.target as HTMLInputElement).value)"
              />
              <button
                class="cfg-reset"
                :class="{ invisible: optionValue(item) === serialize(item.defaultValue) }"
                title="恢复此项默认"
                @click="resetOneOption(item)"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9"/><path d="M3 4v5h5"/></svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="capturing" class="menu-overlay cfg-capture-mask" @click="stopCapture"></div>
  </div>
</template>

<style scoped>
.cfg-page { max-width: 1180px; }
.cfg-switches { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
.cfg-switch { align-items: flex-start; }
.cfg-columns {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
@media (max-width: 1100px) {
  .cfg-columns { grid-template-columns: 1fr; }
}
.cfg-col { display: flex; flex-direction: column; min-height: 0; }
.cfg-col-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.cfg-search { width: 100%; margin-bottom: 8px; }
.cfg-scroll { overflow-y: auto; max-height: calc(100vh - 330px); min-height: 220px; padding-right: 4px; }
.cfg-group { margin-top: 12px; }
.cfg-cat { font-size: 13px; color: var(--text-dim); margin: 0 0 6px; font-weight: 650; }
.cfg-row { display: flex; align-items: center; gap: 10px; padding: 7px 4px; border-radius: 8px; }
.cfg-row:hover { background: var(--card-2); }
.cfg-label { flex: 1; min-width: 0; font-size: 13px; display: flex; flex-direction: column; gap: 1px; }
.cfg-label-desc { font-size: 11px; color: var(--text-dim); font-weight: 400; }
.cfg-bind {
  min-width: 120px; padding: 6px 12px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--card-2); color: var(--text); font-size: 12px; font-family: inherit; cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.cfg-bind:hover { border-color: var(--accent); }
.cfg-bind.modified { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); background: var(--accent-soft); }
.cfg-bind.capturing { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); color: var(--accent-2); }
.cfg-reset {
  display: flex; align-items: center; justify-content: center; width: 26px; height: 26px;
  border: none; border-radius: 6px; background: transparent; color: var(--text-dim); cursor: pointer; flex-shrink: 0;
}
.cfg-reset:hover { color: var(--accent-2); background: var(--hover); }
.cfg-reset svg { width: 13px; height: 13px; }
.cfg-reset.invisible { visibility: hidden; }
.cfg-row-option { flex-wrap: wrap; }
.cfg-slider { flex: 0 0 150px; accent-color: var(--accent); }
.cfg-slider-val { min-width: 52px; text-align: right; font-size: 12px; color: var(--accent-2); font-variant-numeric: tabular-nums; }
.cfg-select { min-width: 130px; }
.cfg-text { flex: 1; min-width: 180px; font-size: 12px; }
.cfg-switch-inline { flex-shrink: 0; }
.cfg-capture-mask { z-index: 9000; }
</style>
