<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import ConnectionPanel from './ConnectionPanel.vue'
import ConnectionStatus from './ConnectionStatus.vue'

type FrpStatus = 'idle' | 'starting' | 'running' | 'auth_failed' | 'tunnel_offline' | 'error' | 'stopped'
interface FrpState {
  status: FrpStatus
  config: { accessKey: string; tunnelId: string; localPort: number } | null
  remoteAddress: string | null
  pid: number | null
  startedAt: string | null
  message: string
  logs: Array<{ ts: string; stream: 'stdout' | 'stderr' | 'system'; text: string }>
}
interface FrpEvent {
  type: 'status' | 'log' | 'ready' | 'error' | 'stopped'
  status?: FrpStatus
  remoteAddress?: string | null
  data?: { ts: string; stream: 'stdout' | 'stderr' | 'system'; text: string } | string
  message?: string
}

const kamucl = (window as unknown as {
  kamucl: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
    on: (channel: string, cb: (...args: unknown[]) => void) => () => void
  }
}).kamucl

const state = ref<FrpState>({
  status: 'idle',
  config: null,
  remoteAddress: null,
  pid: null,
  startedAt: null,
  message: '尚未启动',
  logs: []
})
const busy = ref(false)
const errorMsg = ref('')

const form = reactive({
  accessKey: '',
  tunnelId: '',
  localPort: '' // 留空 → 自动读取 MC 局域网端口
})

const statusLabel: Record<FrpStatus, string> = {
  idle: '尚未启动',
  starting: '正在连接',
  running: '已连接',
  auth_failed: '认证失败',
  tunnel_offline: '隧道离线',
  error: '异常',
  stopped: '已停止'
}
const statusTone = (s: FrpStatus): 'neutral' | 'success' | 'danger' | 'pending' => {
  if (s === 'running' || s === 'starting') return s === 'running' ? 'success' : 'pending'
  if (s === 'auth_failed' || s === 'tunnel_offline' || s === 'error') return 'danger'
  return 'neutral'
}

async function refreshStatus(): Promise<void> {
  try {
    const res = (await kamucl.invoke('frp:status')) as FrpState
    state.value = res
    if (res.config) {
      form.accessKey = res.config.accessKey
      form.tunnelId = res.config.tunnelId
      form.localPort = res.config.localPort ? String(res.config.localPort) : ''
    }
  } catch (e) {
    // 首次启动可能尚未实现 IPC，吞掉即可
    void e
  }
}

async function onStart(): Promise<void> {
  if (busy.value) return
  errorMsg.value = ''
  busy.value = true
  try {
    const localPort = Number(form.localPort) || 0
    await kamucl.invoke('frp:start', {
      accessKey: form.accessKey.trim(),
      tunnelId: form.tunnelId.trim(),
      localPort
    })
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
    void refreshStatus()
  }
}

async function onStop(): Promise<void> {
  if (busy.value) return
  errorMsg.value = ''
  busy.value = true
  try {
    await kamucl.invoke('frp:stop')
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
    void refreshStatus()
  }
}

async function copyRemote(): Promise<void> {
  if (!state.value.remoteAddress) return
  try {
    await navigator.clipboard.writeText(state.value.remoteAddress)
    errorMsg.value = '已复制远程地址'
  } catch {
    errorMsg.value = '复制失败'
  }
}

const logsContainer = ref<HTMLElement | null>(null)
function handleEvent(event: FrpEvent): void {
  if (!event) return
  if (event.type === 'log' && event.data && typeof event.data === 'object') {
    state.value.logs = [...state.value.logs, event.data].slice(-200)
    void nextTickScroll()
    return
  }
  if (event.type === 'status') {
    state.value.status = event.status ?? state.value.status
    if (event.message) state.value.message = event.message
  }
  if (event.type === 'ready') {
    state.value.remoteAddress = event.remoteAddress ?? null
    state.value.status = 'running'
    state.value.message = `已连接，远程地址 ${state.value.remoteAddress}`
  }
  if (event.type === 'error') {
    state.value.status = 'error'
    if (event.message) state.value.message = event.message
  }
  if (event.type === 'stopped') {
    state.value.status = event.status ?? 'stopped'
    state.value.message = event.message ?? state.value.message
  }
}

function nextTickScroll(): void {
  requestAnimationFrame(() => {
    const el = logsContainer.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

let unsubscribe: (() => void) | null = null
onMounted(() => {
  unsubscribe = kamucl.on('frp:event', (raw) => handleEvent(raw as FrpEvent))
  void refreshStatus()
})
onBeforeUnmount(() => {
  unsubscribe?.()
})
</script>

<template>
  <ConnectionPanel
    title="樱花穿透（SakuraFrp）"
    subtitle="使用官方 frpc 把本地局域网世界映射到公网。需要 natfrp.com 的访问密钥与隧道 ID。"
  >
    <template #action>
      <ConnectionStatus :tone="statusTone(state.status)" :label="statusLabel[state.status]" />
    </template>

    <div class="connection-columns">
      <label class="connection-field">
        <span>访问密钥</span>
        <input
          v-model="form.accessKey"
          class="input"
          type="password"
          autocomplete="off"
          placeholder="natfrp.com 用户信息页查看"
        />
        <small>密钥仅保存在本机 userData/frp-config.json，日志中默认打码显示。</small>
      </label>

      <label class="connection-field">
        <span>隧道 ID</span>
        <input
          v-model="form.tunnelId"
          class="input"
          inputmode="numeric"
          placeholder="例如 12345"
        />
        <small>在 natfrp.com 隧道列表创建，本地 IP 填写 127.0.0.1，本地端口与 MC 局域网一致。</small>
      </label>
    </div>

    <div class="connection-columns">
      <label class="connection-field">
        <span>本地端口（MC 局域网端口）</span>
        <input
          v-model="form.localPort"
          class="input"
          inputmode="numeric"
          placeholder="留空自动读取游戏内局域网端口"
        />
        <small>在游戏中选择「对局域网开放」后会写入 latest.log，启动器会尝试自动识别。</small>
      </label>

      <div class="connection-field">
        <span>远程地址</span>
        <div class="connection-result" :class="{ success: state.remoteAddress }">
          <h3>
            <code class="mono">{{ state.remoteAddress ?? '尚未分配' }}</code>
          </h3>
          <p class="connection-muted">{{ state.message }}</p>
          <div v-if="state.remoteAddress" class="connection-actions">
            <button class="btn btn-ghost" type="button" @click="copyRemote">复制地址</button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="errorMsg" class="connection-error">{{ errorMsg }}</div>

    <div class="connection-actions">
      <button
        v-if="state.status === 'idle' || state.status === 'stopped' || state.status === 'error' || state.status === 'auth_failed' || state.status === 'tunnel_offline'"
        class="btn btn-gold"
        :disabled="busy || !form.accessKey.trim() || !form.tunnelId.trim()"
        @click="onStart"
      >
        {{ busy ? '启动中…' : '启动 frpc' }}
      </button>
      <button
        v-else
        class="btn btn-ghost"
        :disabled="busy"
        @click="onStop"
      >
        {{ busy ? '停止中…' : '停止' }}
      </button>
      <button class="btn btn-ghost" :disabled="busy" @click="refreshStatus">刷新状态</button>
    </div>

    <details class="connection-details">
      <summary>frpc 运行日志（{{ state.logs.length }} 条）</summary>
      <div ref="logsContainer" class="connection-detail-content connection-log-viewport">
        <p v-if="!state.logs.length" class="connection-muted">尚无日志。</p>
        <p v-for="(entry, i) in state.logs" :key="i" class="mono connection-log-line">
          <span class="connection-muted">[{{ entry.stream }}]</span> {{ entry.text }}
        </p>
      </div>
    </details>
  </ConnectionPanel>
</template>

<style scoped>
.connection-log-viewport {
  max-height: 240px;
  overflow: auto;
  background: var(--card-2);
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 11px;
  line-height: 1.6;
}
.connection-log-line { word-break: break-all; }
</style>