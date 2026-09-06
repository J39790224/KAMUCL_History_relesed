<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import ConnectionPanel from './ConnectionPanel.vue'
import ConnectionStatus from './ConnectionStatus.vue'
import { toast } from '../../store'
import { copyText } from '../../api'

interface TcStatus { phase: string; room?: string; url?: string; stateRaw?: string; error?: string; binaryReady: boolean; running: boolean }

const status = ref<TcStatus | null>(null)
const busy = ref(false)
const error = ref('')
const logs = ref<string[]>([])
const mode = ref<'host' | 'join'>('host')
const roomCode = ref('')
const playerName = ref('')

let offEvent: (() => void) | undefined

function onEvent(payload: { type: string; data: unknown }): void {
  if (payload.type === 'log') {
    const d = payload.data as { level: string; msg: string }
    if (d?.msg) { logs.value.push(`[${d.level}] ${d.msg}`); if (logs.value.length > 200) logs.value.shift() }
  } else if (payload.type === 'error') {
    error.value = String(payload.data)
  } else if (payload.type === 'stopped') {
    void refresh()
  } else if (payload.type === 'ready') {
    void refresh()
  }
}

async function refresh(): Promise<void> {
  try { status.value = await window.kamucl.invoke('tc:status') } catch { /* 窗口关闭 */ }
}

async function start(): Promise<void> {
  busy.value = true; error.value = ''
  try {
    const result = await window.kamucl.invoke<TcStatus>('tc:start', { mode: mode.value, code: roomCode.value.trim().toUpperCase(), playerName: playerName.value || undefined })
    status.value = result
  } catch (e) { error.value = (e as Error).message?.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') ?? '操作失败' }
  finally { busy.value = false; void refresh() }
}
async function stop(): Promise<void> {
  busy.value = true
  try { await window.kamucl.invoke('tc:stop') } catch { /* 忽略 */ }
  finally { busy.value = false; void refresh() }
}
async function copy(value?: string | null): Promise<void> {
  if (value) toast(await copyText(value) ? '已复制' : '复制失败', 'info')
}

onMounted(() => {
  offEvent = window.kamucl.on('tc:event', onEvent)
  void refresh()
})
onUnmounted(() => { offEvent?.() })
</script>

<template>
  <div class="tc-panel">
    <div class="connection-columns">
      <ConnectionPanel title="创建房间" subtitle="与陶瓦联机玩家互连" step="01">
        <template v-if="!status?.running || (status.phase !== 'hosting' && status.phase !== 'ready' && status.phase !== 'joining')">
          <label class="connection-field">游戏内名字<input v-model="playerName" class="input" maxlength="16" placeholder="可选，默认 KAMUCL" /></label>
          <p class="connection-muted">先启动游戏并对局域网开放世界。首次使用会自动从官方渠道下载陶瓦工具并做 SHA-256 校验。</p>
          <div class="connection-actions"><button class="btn btn-gold" :disabled="busy" @click="mode = 'host'; start()">{{ busy ? '处理中…' : '创建陶瓦房间' }}</button></div>
        </template>
        <template v-else>
          <div class="connection-result success" aria-live="polite">
            <ConnectionStatus :tone="status.phase === 'ready' ? 'success' : 'pending'" :label="status.phase === 'hosting' ? '等待玩家…' : status.phase === 'ready' ? '房间就绪' : status.phase" />
            <p v-if="status.room" class="room-code"><code>{{ status.room }}</code></p>
            <p class="connection-muted">把房间码发给好友（陶瓦码以 U/ 开头）。好友既可以用 KAMUCL 加入，也可以在陶瓦联机官方工具里输入。</p>
            <div class="connection-actions">
              <button class="btn btn-gold" :disabled="!status.room" @click="copy(status.room)">复制房间码</button>
              <button class="btn btn-ghost" :disabled="busy" @click="stop">关闭房间</button>
            </div>
          </div>
        </template>
      </ConnectionPanel>

      <ConnectionPanel title="加入房间" subtitle="输入陶瓦房间码" step="02">
        <template v-if="!(status?.running && (status.phase === 'ready' || status.phase === 'joining'))">
          <label class="connection-field">房间码<input v-model="roomCode" class="input room-input" placeholder="U/XXXX-XXXX-XXXX" :disabled="busy" @keydown.enter="mode = 'join'; start()" /></label>
          <div class="connection-actions"><button class="btn btn-gold" :disabled="busy || roomCode.trim().length < 3" @click="mode = 'join'; start()">{{ busy ? '连接中…' : '加入房间' }}</button></div>
          <p class="connection-muted">连接成功后会得到一个本地地址，在游戏「多人游戏 → 直接连接」里填入。</p>
        </template>
        <template v-else>
          <div class="connection-result success" aria-live="polite">
            <ConnectionStatus tone="success" label="已连接" />
            <p v-if="status.url">本地地址 <code>{{ status.url }}</code><button class="btn btn-ghost copy-mini" @click="copy(status.url)">复制</button></p>
            <div class="connection-actions"><button class="btn btn-ghost" :disabled="busy" @click="stop">断开</button></div>
          </div>
        </template>
      </ConnectionPanel>
    </div>

    <ConnectionPanel title="状态与日志" subtitle="陶瓦引擎运行详情" step="03">
      <div class="tc-metrics">
        <div><span>二进制</span><ConnectionStatus :tone="status?.binaryReady ? 'success' : 'neutral'" :label="status?.binaryReady ? '已就绪' : '待下载'" /></div>
        <div><span>进程</span><ConnectionStatus :tone="status?.running ? 'success' : 'neutral'" :label="status?.running ? '运行中' : '未运行'" /></div>
        <div><span>引擎状态</span><strong>{{ status?.stateRaw ?? '—' }}</strong></div>
      </div>
      <p v-if="error" class="connection-error" role="alert">{{ error }}</p>
      <details class="connection-details" open><summary>运行日志</summary><div class="log-scroll" aria-live="polite"><p v-for="(line, i) in logs" :key="i">{{ line }}</p><p v-if="!logs.length" class="connection-muted">暂无日志。</p></div></details>
    </ConnectionPanel>
  </div>
</template>
<style scoped>
.room-code { font-size: 20px; letter-spacing: 0.06em; margin: 8px 0; }
.room-code code { font-weight: 700; }
.room-input { text-transform: uppercase; letter-spacing: 0.1em; }
.copy-mini { padding: 2px 10px; margin-left: 8px; font-size: 11px; }
.tc-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-bottom: 12px; }
.tc-metrics > div { display: flex; flex-direction: column; gap: 6px; padding: 12px; border: 1px solid var(--border-strong); border-radius: 12px; background: var(--card-2); }
.tc-metrics span { font-size: 11px; color: var(--text-dim); }
.tc-metrics strong { font-size: 13px; }
.log-scroll { max-height: 180px; overflow: auto; display: flex; flex-direction: column; gap: 2px; font-family: var(--mono, monospace); font-size: 11px; line-height: 1.6; color: var(--text-dim); }
</style>
