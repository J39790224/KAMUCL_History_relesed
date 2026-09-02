<script setup lang="ts">
// 服务器页：服务器列表管理 + SLP 实时状态 + 一键进服
import { onMounted, reactive, ref } from 'vue'
import {
  addServer,
  errText,
  launchGame,
  listServers,
  pingServer,
  removeServer
} from '../api'
import { refreshInstalled, store, toast } from '../store'
import type { ServerEntry, ServerPingResult } from '@shared/types'

// ---------------- 列表与状态 ----------------
const servers = ref<ServerEntry[]>([])
const pings = reactive<Record<string, ServerPingResult | 'loading'>>({})
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    servers.value = await listServers()
  } catch (e) {
    toast('读取服务器列表失败：' + errText(e), 'error')
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

function openJoin(s: ServerEntry) {
  if (!store.installed.length) {
    toast('还没有安装任何版本，请先到游戏页安装', 'error')
    return
  }
  joinModal.target = s
  joinModal.versionId = store.installed[0]?.id ?? ''
  joinModal.open = true
}

async function onJoin() {
  const s = joinModal.target
  if (!s || !joinModal.versionId) return
  joinModal.open = false
  try {
    await launchGame(joinModal.versionId, s.address)
    toast(`正在启动并进入 ${s.name}…`, 'info')
  } catch (e) {
    toast('启动失败：' + errText(e), 'error')
  }
}

const pingOf = (s: ServerEntry): ServerPingResult | null =>
  pings[s.id] && pings[s.id] !== 'loading' ? (pings[s.id] as ServerPingResult) : null
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">服务器</h1>
      <p class="page-sub">收藏常用服务器，实时查看状态并一键进入</p>
    </div>

    <!-- 工具行 -->
    <div class="toolbar">
      <button class="btn btn-gold" @click="addModal.open = true">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
        添加服务器
      </button>
      <button class="btn btn-ghost" @click="pingAll">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
        刷新状态
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
      <div v-for="s in servers" :key="s.id" class="card server-card">
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
          <button class="btn btn-gold btn-sm" :disabled="!!store.launchState && store.launchState.status === 'running'" @click="openJoin(s)">进入游戏</button>
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
          <p class="confirm-text">确定要删除「{{ delModal.target?.name }}」吗？此操作不可恢复。</p>
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
          <p class="modal-label">选择游戏版本（将进入服务器 {{ joinModal.target?.address }}）</p>
          <select v-model="joinModal.versionId" class="select">
            <option v-for="v in store.installed" :key="v.id" :value="v.id">{{ v.id }}</option>
          </select>
          <p class="muted join-hint">服务器版本不匹配时可能无法进入，请留意服务器提示的所需版本。</p>
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
</style>
