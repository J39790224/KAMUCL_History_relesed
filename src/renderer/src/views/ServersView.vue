<script setup lang="ts">
// 服务器页：服务器列表管理 + SLP 实时状态 + 一键进服
import { computed, onMounted, reactive, ref } from 'vue'
import {
  addServer,
  bindServer,
  errText,
  getSettings,
  launchGame,
  listServers,
  pingServer,
  prepareServerLaunch,
  removeServer,
  syncServersFromDat
} from '../api'
import { refreshInstalled, store, toast } from '../store'
import type { InstalledVersion, ServerEntry, ServerPingResult } from '@shared/types'
import FriendConnect from '../components/FriendConnect.vue'

// ---------------- 列表与状态 ----------------
const servers = ref<ServerEntry[]>([])
const targets = ref<InstalledVersion[]>([])
const pings = reactive<Record<string, ServerPingResult | 'loading'>>({})
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    // 先从各版本 servers.dat 合并（游戏内添加的服务器自动纳入并标注所属版本）
    const r = await syncServersFromDat()
    servers.value = r.list
    targets.value = r.targets ?? store.installed
    if (r.added > 0) toast(`已从游戏内同步 ${r.added} 个服务器`, 'info')
    if (r.errors?.length) toast(`有 ${r.errors.length} 个服务器列表未能读取：${r.errors[0]}`, 'error')
  } catch (e) {
    toast('读取服务器列表失败：' + errText(e), 'error')
  } finally {
    loading.value = false
  }
  void pingAll()
}

async function syncNow() {
  loading.value = true
  try {
    const r = await syncServersFromDat()
    servers.value = r.list
    targets.value = r.targets ?? store.installed
    const detail = r.added || r.updated ? `新增 ${r.added}，更新 ${r.updated ?? 0}` : '没有发现变化'
    toast(`游戏内服务器同步完成：${detail}`, r.errors?.length ? 'error' : 'success')
    if (r.errors?.length) toast(r.errors[0], 'error')
  } catch (e) {
    toast('同步失败：' + errText(e), 'error')
  } finally {
    loading.value = false
  }
  void pingAll()
}

async function pingAll() {
  await Promise.allSettled(servers.value.map((s) => pingOne(s)))
}

async function pingOne(s: ServerEntry) {
  pings[s.id] = 'loading'
  try {
    pings[s.id] = await pingServer(s.address)
  } catch {
    pings[s.id] = {
      online: false,
      players: '-',
      motd: '无法连接（服务器离线或地址错误）',
      version: '-',
      latencyMs: 0
    }
  }
}

onMounted(() => {
  void load()
  if (!store.installed.length) void refreshInstalled()
})

// ---------------- 添加 ----------------
const addModal = reactive({ open: false, name: '', address: '', busy: false })

async function onAdd() {
  if (addModal.busy) return
  addModal.busy = true
  try {
    servers.value = await addServer(addModal.name, addModal.address)
    addModal.open = false
    addModal.name = ''
    addModal.address = ''
    toast('服务器已添加', 'success')
    const just = servers.value[servers.value.length - 1]
    if (just) void pingOne(just)
  } catch (e) {
    toast('添加失败：' + errText(e), 'error')
  } finally {
    addModal.busy = false
  }
}

// ---------------- 删除（二次确认） ----------------
const delModal = reactive({ open: false, target: null as ServerEntry | null, busy: false })

async function onDelete() {
  const t = delModal.target
  if (!t || delModal.busy) return
  delModal.busy = true
  try {
    servers.value = await removeServer(t.id)
    delete pings[t.id]
    delModal.open = false
    toast('已删除服务器', 'success')
  } catch (e) {
    toast('删除失败：' + errText(e), 'error')
  } finally {
    delModal.busy = false
  }
}

// ---------------- 一键进服 ----------------
const joinModal = reactive({ open: false, target: null as ServerEntry | null, versionId: '' })

const normalizedPath = (value: string) => value.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
const targetToken = (target: Pick<InstalledVersion, 'id' | 'folder'>) =>
  JSON.stringify({ id: target.id, folder: target.folder })
const parseTargetToken = (value: string): { id: string; folder: string } | null => {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as { id?: unknown; folder?: unknown }
    return typeof parsed.id === 'string' && typeof parsed.folder === 'string'
      ? { id: parsed.id, folder: parsed.folder }
      : null
  } catch {
    return null
  }
}
const targetOf = (server: ServerEntry): InstalledVersion | undefined =>
  targets.value.find(
    (target) =>
      target.id === server.versionId &&
      (!server.folder || normalizedPath(target.folder) === normalizedPath(server.folder))
  )
const boundToken = (server: ServerEntry): string => {
  const target = targetOf(server)
  return target ? targetToken(target) : ''
}
const folderLabel = (folder: string): string =>
  store.settings?.folders.find(
    (item) => normalizedPath(item.path) === normalizedPath(folder)
  )?.name ?? folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder
const targetLabel = (target: InstalledVersion): string =>
  `${folderLabel(target.folder)} · ${target.id}${target.loader ? ` · ${target.loader} ${target.loaderVersion ?? ''}` : ''}`
const formatLastUsed = (value?: string): string => {
  if (!value) return '尚未从启动器进入'
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? '时间未知' : `上次启动 ${time.toLocaleString()}`
}

/** 双击卡片：已绑定版本直接启动进服；未绑定弹版本选择 */
function onCardDblClick(s: ServerEntry) {
  if (s.versionId) {
    const v = targetOf(s)
    if (v) {
      void doLaunch(s, s.versionId)
      return
    }
    relinkMissing(s)
    return
  }
  openJoin(s)
}

async function doLaunch(s: ServerEntry, versionId: string) {
  try {
    const target = targets.value.find(
      (item) => item.id === versionId && (!s.folder || normalizedPath(item.folder) === normalizedPath(s.folder))
    )
    const prepared = await prepareServerLaunch(s.id, versionId, target?.folder ?? s.folder)
    store.settings = await getSettings()
    await refreshInstalled()
    store.launchingVersionId = prepared.versionId
    store.launchingFolder = prepared.folder
    await launchGame(prepared.versionId, prepared.directJoin ? prepared.address : undefined)
    servers.value = await listServers()
    toast(
      prepared.directJoin
        ? `正在启动并进入 ${s.name}…`
        : `Minecraft ${prepared.minecraftVersion} 不支持快速进入，已启动正确实例`,
      'info'
    )
  } catch (e) {
    toast('启动失败：' + errText(e), 'error')
  }
}

/** 仅更新 KAMUCL 的实例关联；绝不写回或覆盖 Minecraft 的 servers.dat。 */
async function onBind(s: ServerEntry, token: string) {
  try {
    const target = parseTargetToken(token)
    servers.value = await bindServer(s.id, target?.id ?? '', target?.folder)
    toast(target ? `已关联到 ${target.id}` : '已解除实例关联', 'success')
  } catch (e) {
    toast('绑定失败：' + errText(e), 'error')
  }
}

function relinkMissing(s: ServerEntry) {
  toast('关联实例已缺失；可选择现有实例重新关联，或到游戏版本页重新下载', 'info')
  openJoin(s)
}

const versionMissing = (s: ServerEntry): boolean => !!s.versionId && !targetOf(s)

function openJoin(s: ServerEntry) {
  if (!targets.value.length) {
    toast('还没有安装任何版本，请先到游戏版本页安装', 'error')
    return
  }
  joinModal.target = s
  joinModal.versionId = targetOf(s) ? boundToken(s) : targetToken(targets.value[0])
  joinModal.open = true
}

async function onJoin() {
  const s = joinModal.target
  if (!s || !joinModal.versionId) return
  const target = parseTargetToken(joinModal.versionId)
  if (!target) return
  joinModal.open = false
  try {
    servers.value = await bindServer(s.id, target.id, target.folder)
    const linked = servers.value.find((server) => server.id === s.id) ?? s
    await doLaunch(linked, target.id)
  } catch (e) {
    toast('启动失败：' + errText(e), 'error')
  }
}

const pingOf = (s: ServerEntry): ServerPingResult | null =>
  pings[s.id] && pings[s.id] !== 'loading' ? (pings[s.id] as ServerPingResult) : null

// ---------------- 顶栏搜索联动（过滤名称/地址/MOTD） ----------------
const keyword = computed(() => store.searchKeyword.trim().toLowerCase())
const filteredServers = computed(() =>
  keyword.value
    ? servers.value.filter((s) => {
        const ping = pingOf(s)
        return (
          s.name.toLowerCase().includes(keyword.value) ||
          s.address.toLowerCase().includes(keyword.value) ||
          (ping?.motd.toLowerCase().includes(keyword.value) ?? false)
        )
      })
    : servers.value
)
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">服务器</h1>
      <p class="page-sub">收藏常用服务器，实时查看状态并一键进入</p>
    </div>

    <!-- 工具行 -->
    <FriendConnect />
    <div class="toolbar">
      <button class="btn btn-gold" @click="addModal.open = true">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
        添加服务器
      </button>
      <button class="btn btn-ghost" @click="pingAll">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
        刷新状态
      </button>
      <button class="btn btn-ghost" :disabled="loading" @click="syncNow">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7h-5V2" /><path d="M4 17h5v5" /><path d="M5.1 9a8 8 0 0 1 13.2-3L20 7M4 17l1.7 1A8 8 0 0 0 18.9 15" /></svg>
        同步游戏列表
      </button>
    </div>

    <!-- 列表 -->
    <div v-if="loading" class="card empty">
      <span class="spin"></span>
      <span>正在读取服务器列表…</span>
    </div>
    <div v-else-if="!servers.length" class="card empty servers-empty">
      <svg class="servers-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="4" width="18" height="7" rx="2" />
        <rect x="3" y="13" width="18" height="7" rx="2" />
        <path d="M7 7.5h.01M7 16.5h.01" />
      </svg>
      <p class="servers-text">还没有收藏服务器，点击上方「添加服务器」吧</p>
    </div>

    <div v-else class="server-list">
      <div v-for="s in filteredServers" :key="s.id" class="card server-card" @dblclick="onCardDblClick(s)">
        <span class="status-dot" :class="pingOf(s)?.online ? 'on' : 'off'"></span>
        <div class="server-main">
          <div class="server-title">
            <span class="server-name">{{ s.name }}</span>
            <span class="muted server-addr">{{ s.address }}</span>
          </div>
          <p class="server-motd" :class="{ muted: !pingOf(s)?.online }">
            <span v-if="pings[s.id] === 'loading'" class="muted">正在连接…</span>
            <template v-else>{{ pingOf(s)?.motd }}</template>
          </p>
          <div class="server-bind">
            <select
              class="bind-select"
              :value="boundToken(s)"
              :title="s.versionId ? '双击卡片直接启动该版本进服' : '绑定版本后可双击进服'"
              @change="onBind(s, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">未关联实例</option>
              <option v-for="v in targets" :key="`${v.folder}\u0000${v.id}`" :value="targetToken(v)">
                {{ targetLabel(v) }}{{ v.isolated ? '（隔离）' : '' }}
              </option>
            </select>
            <template v-if="versionMissing(s)">
              <span class="tag tag-danger">关联实例缺失</span>
              <button class="btn btn-ghost btn-sm" @click="relinkMissing(s)">重新关联</button>
              <button class="btn btn-ghost btn-sm" @click="store.currentView = 'game'">前往版本页</button>
            </template>
            <span v-else-if="s.candidateVersionIds?.length" class="tag">共享目录，待确认实例</span>
          </div>
          <div class="server-instance-meta">
            <span v-if="s.minecraftVersion">Minecraft {{ s.minecraftVersion }}</span>
            <span v-if="s.loader">{{ s.loader }} {{ s.loaderVersion ?? '' }}</span>
            <span>{{ formatLastUsed(s.lastUsedAt) }}</span>
          </div>
        </div>
        <div class="server-meta">
          <template v-if="pingOf(s)?.online">
            <span class="tag">{{ pingOf(s)?.version }}</span>
            <span class="muted meta-text">在线 {{ pingOf(s)?.players }}</span>
            <span class="muted meta-text">{{ pingOf(s)?.latencyMs }}ms</span>
          </template>
          <span v-else-if="pings[s.id] !== 'loading'" class="tag">离线</span>
        </div>
        <div class="server-actions">
          <button
            class="btn btn-gold btn-sm"
            :disabled="!!store.launchState && store.launchState.status === 'running'"
            @click="s.versionId && !versionMissing(s) ? doLaunch(s, s.versionId) : openJoin(s)"
          >
            {{ s.versionId && !versionMissing(s) ? '一键启动' : '选择实例' }}
          </button>
          <button class="btn btn-danger btn-sm" @click="delModal.open = true; delModal.target = s">删除</button>
        </div>
      </div>
    </div>

    <!-- 添加模态框 -->
    <Teleport to="body">
      <div v-if="addModal.open" class="modal-mask" @click.self="addModal.open = false">
        <div class="modal">
          <h3 class="modal-title">添加服务器</h3>
          <p class="modal-label">服务器名称</p>
          <input v-model="addModal.name" class="input" placeholder="例如：好友的生存服" maxlength="30" />
          <p class="modal-label">服务器地址</p>
          <input
            v-model="addModal.address"
            class="input mono"
            placeholder="例如：mc.example.com 或 1.2.3.4:25565"
            spellcheck="false"
            @keyup.enter="onAdd"
          />
          <div class="modal-actions">
            <button class="btn btn-ghost" @click="addModal.open = false">取消</button>
            <button class="btn btn-gold" :disabled="addModal.busy" @click="onAdd">
              {{ addModal.busy ? '添加中…' : '添加' }}
            </button>
          </div>
        </div>
      </div>

      <!-- 删除确认 -->
      <div v-if="delModal.open" class="modal-mask" @click.self="delModal.open = false">
        <div class="modal">
          <h3 class="modal-title">删除服务器</h3>
          <p class="confirm-text">
            确定要从 KAMUCL 删除「{{ delModal.target?.name }}」吗？这只会删除启动器记录，不会修改 Minecraft 的 servers.dat；下次同步时，游戏内仍存在的条目可能再次出现。
          </p>
          <div class="modal-actions">
            <button class="btn btn-ghost" @click="delModal.open = false">取消</button>
            <button class="btn btn-danger" :disabled="delModal.busy" @click="onDelete">
              {{ delModal.busy ? '删除中…' : '确认删除' }}
            </button>
          </div>
        </div>
      </div>

      <!-- 进入游戏（选版本） -->
      <div v-if="joinModal.open" class="modal-mask" @click.self="joinModal.open = false">
        <div class="modal">
          <h3 class="modal-title">进入 {{ joinModal.target?.name }}</h3>
          <p class="modal-label">选择游戏实例（将保存关联并启动 {{ joinModal.target?.address }}）</p>
          <select v-model="joinModal.versionId" class="select">
            <option v-for="v in targets" :key="`${v.folder}\u0000${v.id}`" :value="targetToken(v)">
              {{ targetLabel(v) }}
            </option>
          </select>
          <p class="muted join-hint">
            Java 1.20 及以上会使用官方 Quick Play 直接进入；更旧版本只启动正确实例，并保留服务器记录。
          </p>
          <div class="modal-actions">
            <button class="btn btn-ghost" @click="joinModal.open = false">取消</button>
            <button class="btn btn-gold" @click="onJoin">启动并进入</button>
          </div>
        </div>
      </div>
    </Teleport>
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
.toolbar {
  display: flex;
  gap: 10px;
}
.toolbar .btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 60px 20px;
  color: var(--text-dim);
}
.servers-icon {
  width: 52px;
  height: 52px;
  color: var(--accent);
  opacity: 0.8;
}
.servers-text {
  font-size: 14px;
}

/* 服务器卡片 */
.server-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.server-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 18px;
}
.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-dim);
}
.status-dot.on {
  background: var(--ok);
  box-shadow: 0 0 8px var(--ok);
}
.server-main {
  flex: 1;
  min-width: 0;
}
.server-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.server-name {
  font-size: 15px;
  font-weight: 700;
}
.server-addr {
  font-size: 12px;
  font-family: ui-monospace, Consolas, monospace;
}
.server-motd {
  margin-top: 4px;
  font-size: 12.5px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
/* 绑定版本行 */
.server-bind {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 7px;
}
.bind-select {
  max-width: min(360px, 100%);
  padding: 4px 9px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card-2);
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
}
.server-instance-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 5px 12px;
  margin-top: 7px;
  color: var(--text-dim);
  font-size: 11.5px;
}
.server-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  flex-shrink: 0;
}
.meta-text {
  font-size: 12px;
}
.server-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.modal-label {
  margin: 14px 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-dim);
}
.confirm-text {
  font-size: 13.5px;
  line-height: 1.7;
}
.join-hint {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.6;
}

@media (max-width: 820px) {
  .server-card {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .server-main {
    min-width: calc(100% - 28px);
  }
  .server-meta {
    flex-direction: row;
    align-items: center;
    margin-left: 24px;
  }
  .server-actions {
    margin-left: auto;
  }
}
</style>
