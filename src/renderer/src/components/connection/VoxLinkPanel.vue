<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import ConnectionPanel from './ConnectionPanel.vue'
import ConnectionStatus from './ConnectionStatus.vue'
import { toast } from '../../store'
import { copyText } from '../../api'

interface LobbyRoom { code: string; name: string; currentPlayers?: number; maxPlayers?: number; hasPassword?: boolean; category?: string; gameVersion?: string; loader?: string; clientTag?: string; natType?: string }
interface RoomInfo { code: string; name: string; currentPlayers: number; maxPlayers: number; isHost: boolean; gameVersion?: string; loader?: string }
interface Snapshot { state: string; room: RoomInfo | null; session: { state: string; code: string; isHost: boolean; room: RoomInfo | null }; settings: { allowRelay: boolean; theme: string } }

const state = ref<Snapshot | null>(null)
const busy = ref(false)
const error = ref('')
const logs = ref<string[]>([])
const tab = ref<'create' | 'join' | 'lobby'>('create')

// 创建房间
const roomName = ref('KAMUCL 房间')
const isPublic = ref(true)
// 加入房间
const joinCode = ref('')
// 大厅
const rooms = ref<LobbyRoom[]>([])
const search = ref('')
const loadingLobby = ref(false)
// 本地连接地址（加入成功后游戏里直接连）：guest 桥监听随机端口，
// 真实地址由引擎 conn:state 事件给出（p2p 成功带 detail=「本地代理 127.0.0.1:P」，中继成功 address 即本地代理）。
const localAddress = ref('')

let offEvent: (() => void) | undefined

function onEvent(payload: { type: string; data: unknown }): void {
  if (payload.type === 'state') {
    state.value = payload.data as Snapshot
    if (state.value.state === 'idle') localAddress.value = ''
    return
  }
  if (payload.type === 'log') {
    const d = payload.data as { level: string; msg: string }
    if (d?.msg) { logs.value.push(`[${d.level}] ${d.msg}`); if (logs.value.length > 200) logs.value.shift() }
    return
  }
  if (payload.type === 'bridge') logs.value.push(`[bridge] ${JSON.stringify(payload.data)}`)
  if (payload.type === 'conn:state') {
    const d = payload.data as { phase?: string; status?: string; address?: string; detail?: string }
    const text = `${d?.detail ?? ''} ${d?.address ?? ''}`
    const m = /127\.0\.0\.1:\d+/.exec(text)
    if (d?.status === 'success' && m) localAddress.value = m[0]
    else if (d?.status === 'failed') localAddress.value = ''
    logs.value.push(`[conn:${d?.phase ?? '?'}] ${d?.status ?? '?'} ${(d?.detail || d?.address || '').trim()}`)
  }
}

async function call<T>(channel: string, payload?: unknown): Promise<T | undefined> {
  try { return await window.kamucl.invoke(channel, payload) } catch (e) { error.value = (e as Error).message?.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') ?? '操作失败'; return undefined }
}

async function startHost(): Promise<void> {
  busy.value = true; error.value = ''
  const r = await call<{ ok: boolean }>('voxlink:start', { mode: 'host', roomName: roomName.value, isPublic: isPublic.value })
  if (r?.ok) { tab.value = 'create'; await status() }
  busy.value = false
}
async function startJoin(code: string): Promise<void> {
  const c = code.trim().toUpperCase()
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(c)) { error.value = 'VoxLink 房间码为 6 位字符（不含 I、L、O、0、1）'; return }
  busy.value = true; error.value = ''
  const r = await call<{ ok: boolean }>('voxlink:start', { mode: 'join', code: c })
  if (r?.ok) { tab.value = 'join'; await status() }
  busy.value = false
}
async function stop(): Promise<void> {
  busy.value = true
  await call('voxlink:stop')
  localAddress.value = ''
  await status()
  busy.value = false
}
async function status(): Promise<void> {
  const s = await call<Snapshot>('voxlink:status')
  if (s) state.value = s
}
async function loadLobby(): Promise<void> {
  loadingLobby.value = true
  const r = await call<{ rooms: LobbyRoom[] }>('voxlink:lobby', { search: search.value || undefined, size: 50 })
  if (r) rooms.value = r.rooms ?? []
  loadingLobby.value = false
}
async function toggleRelay(): Promise<void> {
  if (!state.value) return
  const allowRelay = await call<{ allowRelay: boolean }>('voxlink:settings', { allowRelay: !state.value.settings.allowRelay })
  if (allowRelay) state.value.settings.allowRelay = allowRelay.allowRelay
}
async function copy(value?: string | null): Promise<void> {
  if (value) toast(await copyText(value) ? '已复制' : '复制失败', 'info')
}

onMounted(async () => {
  offEvent = window.kamucl.on('voxlink:event', onEvent)
  await status()
  if (state.value?.state === 'idle') await loadLobby()
})
onUnmounted(() => { offEvent?.() })
</script>

<template>
  <div class="voxlink-panel">
    <div class="connection-columns">
      <ConnectionPanel title="创建房间" subtitle="拿到 6 位码发给好友" step="01">
        <template v-if="state?.state === 'idle' || !state">
          <label class="connection-field">房间名<input v-model="roomName" class="input" maxlength="32" placeholder="大厅里显示的名字" :disabled="busy" /></label>
          <label class="connection-toggle"><span>公开房间<small>出现在大厅列表，任何人可通过房间码加入</small></span><input v-model="isPublic" type="checkbox" :disabled="busy" /><span class="connection-toggle-track" aria-hidden="true"></span></label>
          <p class="connection-muted">先启动游戏并对局域网开放世界，VoxLink 会自动探测端口。</p>
          <div class="connection-actions"><button class="btn btn-gold" :disabled="busy" @click="startHost">{{ busy ? '创建中…' : '创建房间' }}</button></div>
        </template>
        <template v-else>
          <div class="connection-result success" aria-live="polite">
            <ConnectionStatus :tone="state.state === 'in_room' || state.state === 'hosting' ? 'success' : 'pending'" :label="state.state === 'hosting' ? '房间开放中' : state.state === 'in_room' ? '已加入房间' : state.state" />
            <p v-if="state.session.code" class="room-code"><code>{{ state.session.code.slice(0, 3) + ' ' + state.session.code.slice(3) }}</code></p>
            <p class="connection-muted">把 6 位房间码发给好友，好友在 VoxLink 选择「加入房间」输入即可。</p>
            <p v-if="state.room"><span class="connection-muted">房间：</span>{{ state.room.name }} · {{ state.room.currentPlayers }}/{{ state.room.maxPlayers }} 人</p>
            <div class="connection-actions">
              <button class="btn btn-gold" :disabled="!state.session.code" @click="copy(state.session.code)">复制房间码</button>
              <button class="btn btn-ghost" :disabled="busy" @click="stop">离开房间</button>
            </div>
          </div>
        </template>
      </ConnectionPanel>

      <ConnectionPanel title="加入房间" subtitle="输入好友的 6 位码" step="02">
        <template v-if="state?.state === 'idle' || !state">
          <label class="connection-field">房间码<input v-model="joinCode" class="input room-input" maxlength="7" placeholder="例如 ABC123" :disabled="busy" @keydown.enter="startJoin(joinCode)" /></label>
          <div class="connection-actions"><button class="btn btn-gold" :disabled="busy || joinCode.trim().length < 6" @click="startJoin(joinCode)">{{ busy ? '连接中…' : '加入房间' }}</button></div>
          <p class="connection-muted">连接成功后会得到本地地址，在游戏的「多人游戏 → 直接连接」填入即可（KAMUCL 也会自动提示）。</p>
        </template>
        <template v-else-if="state.state === 'in_room'">
          <div class="connection-result success" aria-live="polite">
            <ConnectionStatus tone="success" label="已连接到房主" />
            <p v-if="localAddress">本地地址 <code>{{ localAddress }}</code><button class="btn btn-ghost copy-mini" @click="copy(localAddress)">复制</button></p>
            <p class="connection-muted">在游戏内「多人游戏 → 直接连接」填入上方地址。</p>
            <div class="connection-actions"><button class="btn btn-ghost" :disabled="busy" @click="stop">离开房间</button></div>
          </div>
        </template>
        <template v-else>
          <ConnectionStatus tone="pending" :label="state.state === 'hosting' ? '你是房主' : state.state" />
          <div class="connection-actions"><button class="btn btn-ghost" :disabled="busy" @click="stop">退出</button></div>
        </template>
      </ConnectionPanel>
    </div>

    <ConnectionPanel title="公共大厅" subtitle="加入公开房间，或看看谁在联机" step="03">
      <template #action><button class="btn btn-ghost" :disabled="loadingLobby" @click="loadLobby">{{ loadingLobby ? '刷新中…' : '刷新' }}</button></template>
      <label class="connection-field lobby-search">搜索<input v-model="search" class="input" placeholder="按房间名搜索" @keydown.enter="loadLobby" /></label>
      <p v-if="!rooms.length && !loadingLobby" class="connection-muted">大厅暂时没有公开房间。</p>
      <ul v-else class="lobby-list">
        <li v-for="room in rooms" :key="room.code" class="lobby-item">
          <div class="lobby-main">
            <strong>{{ room.name }}</strong>
            <span v-if="room.clientTag === 'kamucl'" class="kamucl-badge" title="此房间由 KAMUCL 启动器创建">KAMUCL 启动器创建</span>
            <small>{{ [room.gameVersion, room.loader, room.category].filter(Boolean).join(' · ') }}</small>
          </div>
          <div class="lobby-side">
            <span class="connection-muted">{{ room.currentPlayers ?? '?' }}/{{ room.maxPlayers ?? '?' }} 人</span>
            <button class="btn btn-gold" :disabled="busy || state?.state !== 'idle'" @click="startJoin(room.code)">加入</button>
          </div>
        </li>
      </ul>
    </ConnectionPanel>

    <ConnectionPanel title="设置与日志" subtitle="中继共享与引擎运行日志" step="04">
      <label class="connection-toggle"><span>允许为他人提供中继<small>关闭后不再为别人中继，但自己也无法使用玩家中继</small></span><input type="checkbox" :checked="state?.settings.allowRelay ?? true" :disabled="!!state && state.state !== 'idle'" @change="toggleRelay" /><span class="connection-toggle-track" aria-hidden="true"></span></label>
      <details class="connection-details" open><summary>运行日志</summary><div class="log-scroll" aria-live="polite"><p v-for="(line, i) in logs" :key="i">{{ line }}</p><p v-if="!logs.length" class="connection-muted">暂无日志。</p></div></details>
      <p v-if="error" class="connection-error" role="alert">{{ error }}</p>
    </ConnectionPanel>
  </div>
</template>
<style scoped>
.room-code { font-size: 30px; letter-spacing: 0.12em; margin: 8px 0; }
.room-code code { font-weight: 700; }
.room-input { text-transform: uppercase; letter-spacing: 0.2em; font-weight: 600; }
.copy-mini { padding: 2px 10px; margin-left: 8px; font-size: 11px; }
.lobby-search { max-width: 320px; }
.lobby-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.lobby-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border: 1px solid var(--border-strong); border-radius: 12px; background: var(--card-2); }
.lobby-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.lobby-main strong { font-size: 13px; }
.lobby-main small { color: var(--text-dim); font-size: 11px; }
.lobby-side { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
.kamucl-badge { display: inline-block; margin-left: 8px; padding: 1px 8px; border-radius: 999px; font-size: 10.5px; vertical-align: 1px; border: 1px solid color-mix(in srgb, var(--accent, #c9a227) 55%, transparent); color: var(--accent, #c9a227); }
.log-scroll { max-height: 180px; overflow: auto; display: flex; flex-direction: column; gap: 2px; font-family: var(--mono, monospace); font-size: 11px; line-height: 1.6; color: var(--text-dim); }
</style>
