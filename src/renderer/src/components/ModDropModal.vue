<script setup lang="ts">
/**
 * MOD 拖入即装：解析结果确认 + 版本匹配 + 四分支处理
 * 流程：静默解析 → 匹配本地版本 → 有匹配（选版本装入）/ 无匹配（自动或自定义下载后装入）
 */
import { computed, reactive, ref, watch } from 'vue'
import { errText, installMods, installVersion, parseMods } from '../api'
import { displayVersionName, store, toast } from '../store'
import type { InstalledVersion, LoaderName, ModInfo } from '@shared/types'

const props = defineProps<{
  open: boolean
  files: string[]
}>()
const emit = defineEmits<{ (e: 'close'): void }>()

// ---------------- 版本范围匹配（与主进程同规则简版） ----------------
function cmpVer(a: string, b: string): number {
  const pa = a.split(/[.-]/)
  const pb = b.split(/[.-]/)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const xa = parseInt(pa[i] ?? '0', 10) || 0
    const xb = parseInt(pb[i] ?? '0', 10) || 0
    if (xa !== xb) return xa - xb
  }
  return 0
}
function matchOne(seg: string, mc: string): boolean {
  const s = seg.trim()
  if (!s || s === '*') return true
  const range = /^([\[(])([^,]*),([^\])]*)[\])]$/.exec(s)
  if (range) {
    const [, , minS, maxS] = range
    const closedEnd = s.endsWith(']')
    if (minS && cmpVer(mc, minS) < 0) return false
    if (maxS) {
      const c = cmpVer(mc, maxS)
      if (closedEnd ? c > 0 : c >= 0) return false
    }
    return true
  }
  if (s.startsWith('~')) {
    const base = s.slice(1)
    const p = base.split('.')
    const upper = `${p[0]}.${(parseInt(p[1] ?? '0', 10) || 0) + 1}`
    return cmpVer(mc, base) >= 0 && cmpVer(mc, upper) < 0
  }
  const op = /^(>=|<=|>|<)(.+)$/.exec(s)
  if (op) {
    const c = cmpVer(mc, op[2].trim())
    return op[1] === '>=' ? c >= 0 : op[1] === '<=' ? c <= 0 : op[1] === '>' ? c > 0 : c < 0
  }
  if (s.endsWith('.x')) return mc.startsWith(s.slice(0, -1))
  return cmpVer(mc, s) === 0
}
function matchRange(range: string, mc: string): boolean {
  const r = (range ?? '').trim()
  if (!r || r === '*') return true
  return r.split(/\s*,\s*|\s+/).some((seg) => matchOne(seg, mc))
}

// ---------------- 状态 ----------------
const parsing = ref(false)
const mods = ref<ModInfo[]>([])
const selectedVersion = ref('')
const installing = ref(false)

/** 解析成功的有效 MOD */
const validMods = computed(() => mods.value.filter((m) => !m.error))
/** 解析失败（非 MOD/损坏） */
const failedMods = computed(() => mods.value.filter((m) => !!m.error))

/** 某 MOD 与某已装版本是否匹配（loader 一致 + MC 版本在范围内 + 加载器版本满足要求） */
function modMatchesVersion(m: ModInfo, v: InstalledVersion): boolean {
  if (!m.loader) return false
  if (v.loader !== m.loader || !matchRange(m.mcRange, v.mcVersion)) return false
  // 加载器版本维度：MOD 声明了 loader 版本范围时需本地实例满足
  if (m.loaderRange && v.loaderVersion && !matchRange(m.loaderRange, v.loaderVersion)) return false
  return true
}

/** 每个 MOD 匹配到的版本 id 集合 */
const matchMap = computed(() => {
  const map: Record<string, string[]> = {}
  for (const m of validMods.value) {
    map[m.filePath] = store.installed.filter((v) => modMatchesVersion(m, v)).map((v) => v.id)
  }
  return map
})

/** 所有有效 MOD 的版本交集（可同时装入全部 MOD 的版本） */
const commonVersions = computed(() => {
  if (!validMods.value.length) return []
  return store.installed.filter((v) => validMods.value.every((m) => modMatchesVersion(m, v)))
})

/** 无交集时退而求其次：能装最多 MOD 的版本（含兼容状态标记） */
const bestEffortVersions = computed(() => {
  if (commonVersions.value.length) return []
  const scored = store.installed
    .map((v) => ({
      v,
      ok: validMods.value.filter((m) => modMatchesVersion(m, v)),
      bad: validMods.value.filter((m) => !modMatchesVersion(m, v))
    }))
    .filter((x) => x.ok.length > 0)
    .sort((a, b) => b.ok.length - a.ok.length)
  return scored
})

type Branch = 'parse' | 'matched' | 'partial' | 'none'
const branch = computed<Branch>(() => {
  if (parsing.value) return 'parse'
  if (!validMods.value.length) return 'none'
  if (commonVersions.value.length) return 'matched'
  if (bestEffortVersions.value.length) return 'partial'
  return 'none'
})

const LOADER_TAG: Record<LoaderName, string> = {
  forge: 'Forge',
  neoforge: 'NeoForge',
  fabric: 'Fabric',
  quilt: 'Quilt'
}

// ---------------- 打开时解析 ----------------
watch(
  () => props.open,
  async (open) => {
    if (!open) return
    mods.value = []
    parsing.value = true
    try {
      mods.value = await parseMods(props.files)
      // 默认选中交集第一个
      selectedVersion.value = commonVersions.value[0]?.id ?? bestEffortVersions.value[0]?.v.id ?? ''
    } catch (e) {
      toast('MOD 识别失败：' + errText(e), 'error')
      emit('close')
    } finally {
      parsing.value = false
    }
  }
)

// ---------------- 分支动作 ----------------
async function onInstallSelected() {
  const vid = selectedVersion.value
  if (!vid || installing.value) return
  // 部分匹配分支下只装入兼容的 MOD
  const targets = validMods.value.filter((m) =>
    branch.value === 'matched'
      ? true
      : bestEffortVersions.value.find((x) => x.v.id === vid)?.ok.includes(m)
  )
  if (!targets.length) {
    toast('所选版本与全部 MOD 均不兼容', 'error')
    return
  }
  installing.value = true
  try {
    const results = await installMods(targets.map((m) => m.filePath), vid)
    const okCount = results.filter((r) => r.ok).length
    const vname = store.installed.find((v) => v.id === vid)
    toast(
      `已将 ${okCount} 个 MOD 装入 ${vname ? displayVersionName(vname) : vid}`,
      okCount ? 'success' : 'error'
    )
    store.fsRefreshTick++
    emit('close')
  } catch (e) {
    toast('装入失败：' + errText(e), 'error')
  } finally {
    installing.value = false
  }
}

/** 「下载新版本」：跳游戏页，提示装完后再装入 */
function onDownloadNew() {
  emit('close')
  store.currentView = 'game'
  toast('请在游戏页选择兼容的版本安装，完成后重新拖入 MOD 即可装入', 'info')
}

/** 「自动下载最新兼容版本」：取 MOD 支持的最高 release + 多数派加载器，走现有下载链路 */
const autoState = reactive({ busy: false })
async function onAutoDownload() {
  if (autoState.busy) return
  autoState.busy = true
  try {
    // 多数派加载器
    const loaderCount = new Map<LoaderName, number>()
    for (const m of validMods.value) {
      if (m.loader) loaderCount.set(m.loader, (loaderCount.get(m.loader) ?? 0) + 1)
    }
    const loader = [...loaderCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    if (!loader) throw new Error('没有可识别的加载器类型')
    // 取发布清单中满足所有该 loader MOD 范围的最高 release
    const { getManifest } = await import('../api')
    const manifest = await getManifest()
    const releases = manifest.filter((v) => v.type === 'release')
    const target = releases.find((v) =>
      validMods.value.every((m) => !m.loader || matchRange(m.mcRange, v.id))
    ) ?? releases.find((v) =>
      validMods.value.filter((m) => matchRange(m.mcRange, v.id)).length > 0
    )
    if (!target) throw new Error('没有找到兼容的正式版 MC')
    // 加载器版本维度：取该加载器适配该 MC 的最新版本，且满足 MOD 声明的 loader 版本范围
    const { listLoaders } = await import('../api')
    const loaderVersions = await listLoaders(loader, target.id)
    if (!loaderVersions.length) throw new Error(`${LOADER_TAG[loader]} 没有适配 ${target.id} 的版本`)
    const loaderVersion =
      loaderVersions.find((lv) =>
        validMods.value.every((m) => !m.loaderRange || matchRange(m.loaderRange, lv))
      ) ?? loaderVersions[0]
    emit('close')
    toast(
      `开始自动下载 ${target.id} + ${LOADER_TAG[loader]} ${loaderVersion}，完成后请重新拖入 MOD 装入`,
      'info'
    )
    store.installing.add(target.id)
    await installVersion(target.id, { loader, loaderVersion })
  } catch (e) {
    toast('自动下载失败：' + errText(e), 'error')
  } finally {
    autoState.busy = false
  }
}

function onCustomDownload() {
  onDownloadNew()
}

const modCompatOf = (m: ModInfo): string[] => matchMap.value[m.filePath] ?? []
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" @click.self="emit('close')">
      <div class="modal moddrop-modal">
        <h3 class="modal-title">MOD 识别与安装</h3>

        <!-- 解析中 -->
        <div v-if="parsing" class="parse-loading">
          <span class="spin"></span>
          <span class="muted">正在识别 MOD 信息…</span>
        </div>

        <template v-else>
          <!-- 识别结果列表 -->
          <div class="mod-list">
            <div v-for="m in mods" :key="m.filePath + m.fileName" class="mod-row" :class="{ failed: !!m.error }">
              <img v-if="m.iconDataUrl" class="mod-icon" :src="m.iconDataUrl" alt="" />
              <span v-else class="mod-icon mod-icon-empty">{{ (m.name || m.fileName).charAt(0) }}</span>
              <div class="mod-meta">
                <div class="mod-title-row">
                  <span class="mod-name">{{ m.name || m.fileName }}</span>
                  <span v-if="m.version" class="muted">v{{ m.version }}</span>
                  <span v-if="m.loader" class="tag">{{ LOADER_TAG[m.loader] }}</span>
                </div>
                <div class="mod-sub muted">
                  <template v-if="m.error">⚠ {{ m.error }}</template>
                  <template v-else>
                    <span v-if="m.mcRange">MC {{ m.mcRange }}</span>
                    <span v-if="m.loaderRange"> · Loader {{ m.loaderRange }}</span>
                    <span v-if="m.dependencies.length"> · 前置：{{ m.dependencies.join(', ') }}</span>
                    <span v-if="!m.error && branch !== 'none'" :class="modCompatOf(m).length ? 'compat-ok' : 'compat-bad'">
                      {{ modCompatOf(m).length ? ` · 匹配 ${modCompatOf(m).length} 个本地版本` : ' · 无匹配版本' }}
                    </span>
                  </template>
                </div>
              </div>
            </div>
          </div>

          <!-- 分支：全部匹配 -->
          <template v-if="branch === 'matched'">
            <p class="modal-label">选择装入版本（{{ commonVersions.length }} 个版本可装入全部 {{ validMods.length }} 个 MOD）</p>
            <div class="ver-list">
              <label v-for="v in commonVersions" :key="v.id" class="ver-option" :class="{ active: selectedVersion === v.id }">
                <input v-model="selectedVersion" type="radio" :value="v.id" />
                <span class="ver-name">{{ displayVersionName(v) }}</span>
                <span v-if="v.isolated" class="tag">已隔离</span>
              </label>
            </div>
            <div class="modal-actions">
              <button class="btn btn-ghost" @click="emit('close')">取消</button>
              <button class="btn btn-ghost" @click="onDownloadNew">下载新版本</button>
              <button class="btn btn-gold" :disabled="installing" @click="onInstallSelected">
                {{ installing ? '装入中…' : '装入所选版本' }}
              </button>
            </div>
          </template>

          <!-- 分支：部分匹配 -->
          <template v-else-if="branch === 'partial'">
            <p class="modal-label">
              没有能装入全部 MOD 的版本，以下为可装入部分 MOD 的版本（不兼容项将被跳过）：
            </p>
            <div class="ver-list">
              <label v-for="x in bestEffortVersions" :key="x.v.id" class="ver-option" :class="{ active: selectedVersion === x.v.id }">
                <input v-model="selectedVersion" type="radio" :value="x.v.id" />
                <span class="ver-name">{{ displayVersionName(x.v) }}</span>
                <span class="muted">可装 {{ x.ok.length }}/{{ validMods.length }}</span>
              </label>
            </div>
            <div class="modal-actions">
              <button class="btn btn-ghost" @click="emit('close')">取消</button>
              <button class="btn btn-ghost" @click="onDownloadNew">下载新版本</button>
              <button class="btn btn-gold" :disabled="installing" @click="onInstallSelected">
                {{ installing ? '装入中…' : '装入兼容的 MOD' }}
              </button>
            </div>
          </template>

          <!-- 分支：全无匹配 -->
          <template v-else-if="branch === 'none'">
            <div class="none-hint">
              <p>当前没有可装入这些 MOD 的游戏版本（需要与 MOD 加载器一致且 MC 版本在支持范围内）。</p>
            </div>
            <div class="modal-actions">
              <button class="btn btn-ghost" @click="emit('close')">取消</button>
              <button class="btn btn-ghost" @click="onCustomDownload">自定义下载</button>
              <button class="btn btn-gold" :disabled="autoState.busy" @click="onAutoDownload">
                {{ autoState.busy ? '分析中…' : '自动下载最新兼容版本' }}
              </button>
            </div>
          </template>

          <!-- 失败文件原因汇总 -->
          <div v-if="failedMods.length" class="failed-summary muted">
            {{ failedMods.length }} 个文件无法识别（详见上方列表），已跳过，不影响其他 MOD 安装。
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.moddrop-modal {
  width: 520px;
  max-height: 82vh;
  overflow-y: auto;
}
.parse-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 24px 0;
  justify-content: center;
}
.mod-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 6px 0 4px;
  max-height: 300px;
  overflow-y: auto;
}
.mod-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card-2);
}
.mod-row.failed {
  border-color: var(--danger-border);
  background: var(--danger-soft);
}
.mod-icon {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  flex-shrink: 0;
  object-fit: contain;
  image-rendering: pixelated;
}
.mod-icon-empty {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 700;
  font-size: 15px;
}
.mod-meta {
  min-width: 0;
  flex: 1;
}
.mod-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.mod-name {
  font-size: 13.5px;
  font-weight: 700;
  word-break: break-all;
}
.mod-sub {
  margin-top: 3px;
  font-size: 12px;
  line-height: 1.5;
  word-break: break-all;
}
.compat-ok {
  color: var(--ok);
}
.compat-bad {
  color: var(--danger);
}
.ver-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 200px;
  overflow-y: auto;
}
.ver-option {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card-2);
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.ver-option.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.ver-option input {
  accent-color: var(--accent);
}
.ver-name {
  flex: 1;
  font-size: 13.5px;
  font-weight: 600;
  word-break: break-all;
}
.none-hint {
  padding: 12px 14px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  color: var(--text-dim);
  font-size: 13px;
  line-height: 1.7;
  margin-bottom: 4px;
}
.failed-summary {
  margin-top: 10px;
  font-size: 12px;
  line-height: 1.6;
}
</style>
