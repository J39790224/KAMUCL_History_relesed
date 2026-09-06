<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import ConnectionPanel from './connection/ConnectionPanel.vue'
import ConnectionStatus from './connection/ConnectionStatus.vue'
import NetworkOverview from './connection/NetworkOverview.vue'
import './connection/connection.css'
import { copyText, errText, getDirectOverview, getDirectState, getSettings, launchGame, prepareDirectJoin, resolveDirectInvitation, startDirectHost, stopDirectHost } from '../api'
import { refreshInstalled, store, toast } from '../store'
import type { DirectHostState, DirectJoinResult, DirectOverview } from '@shared/directConnect'

const overview = ref<DirectOverview | null>(null)
const state = ref<DirectHostState>({active:false,connections:0,endpoints:[],messages:[]})
const busy = ref(false), scanning = ref(false), checking = ref(false), joining = ref(false)
const error = ref(''), port = ref(''), publicAddress = ref(''), useUpnp = ref(true)
const hostTarget = ref(''), joinTarget = ref(''), invitation = ref('')
const resolved = ref<DirectJoinResult | null>(null)
const manualJoinAddress = ref('')
const instances = computed(() => overview.value?.instances.filter(item => !item.incomplete) ?? [])
const token = (item: { id:string; folder:string }) => JSON.stringify([item.folder,item.id])
const target = (value: string) => instances.value.find(item => token(item) === value)
const compatible = computed(() => instances.value.filter(item => {
  const invite = resolved.value?.invitation
  return invite && item.mcVersion === invite.minecraftVersion && (item.loader ?? '') === (invite.loader ?? '') && (!invite.loaderVersion || item.loaderVersion === invite.loaderVersion)
}))
let disposed = false
async function refresh() {
  if (scanning.value) return
  scanning.value = true; error.value = ''
  try {
    const data = await getDirectOverview()
    if (disposed) return
    overview.value = data; state.value = data.state
    if (data.detectedPort) port.value = String(data.detectedPort)
    if (!target(hostTarget.value)) hostTarget.value = token(instances.value.find(item => item.id === store.launchingVersionId) ?? instances.value[0] ?? {folder:'',id:''})
  } catch (e) { error.value = errText(e) }
  finally { scanning.value = false }
}
async function host() {
  const instance = target(hostTarget.value)
  if (!instance) { error.value = '请选择一个完整的游戏实例'; return }
  busy.value = true; error.value = ''
  try {
    state.value = await startDirectHost({versionId:instance.id,folder:instance.folder,port:port.value ? Number(port.value) : undefined,useUpnp:useUpnp.value,publicAddress:publicAddress.value})
  } catch (e) { error.value = errText(e) }
  finally { busy.value = false }
}
async function stop() {
  try { state.value = await stopDirectHost() }
  catch(e) { error.value = errText(e) }
}
async function copy(value?: string) {
  if (value) toast(await copyText(value) ? '已复制，请通过你自己的聊天工具发送给好友' : '复制失败', 'info')
}
async function check() {
  if (checking.value) return
  checking.value = true; error.value = ''; resolved.value = null; manualJoinAddress.value = ''
  try {
    resolved.value = await resolveDirectInvitation(invitation.value)
    joinTarget.value = compatible.value[0] ? token(compatible.value[0]) : ''
    if (!resolved.value.endpoint) error.value = '所有地址均不可达。请让房主检查网络映射与防火墙，或改用专门的内网穿透工具。'
  } catch(e) { error.value = errText(e) }
  finally { checking.value = false }
}
async function join() {
  const instance = target(joinTarget.value)
  if (!instance || !store.selectedAccount) { error.value = '请选择兼容实例并登录游戏账号'; return }
  joining.value = true; error.value = ''
  try {
    const prepared = await prepareDirectJoin(invitation.value, instance.id, instance.folder)
    store.settings = await getSettings(); await refreshInstalled()
    store.launchingVersionId = prepared.versionId; store.launchingFolder = prepared.folder
    if (!prepared.directJoin) manualJoinAddress.value = prepared.address
    await launchGame(prepared.versionId, prepared.directJoin ? prepared.address : undefined)
    toast(prepared.directJoin ? '已请求启动游戏并进入好友世界' : '此版本请在多人游戏中使用下方地址直接连接', 'info')
  } catch(e) { error.value = errText(e) }
  finally { joining.value = false }
}
let poll: ReturnType<typeof setInterval> | undefined
let polling = false
onMounted(() => {
  void refresh()
  poll = setInterval(async () => {
    if (polling || busy.value || disposed) return
    polling = true
    try { const next = await getDirectState(); if (!disposed) state.value = next } catch { /* 主窗口关闭 */ }
    finally { polling = false }
  }, 3000)
})
onUnmounted(() => { disposed = true; clearInterval(poll) })
</script>

<template>
  <div class="connect-page friend-connect">
    <header class="connection-header">
      <div><span class="connection-eyebrow">PLAY TOGETHER</span><h1>好友直连</h1><p>从一个人的世界，到一起冒险。玩家本机直连，无平台服务器或外部中继。</p></div>
      <ConnectionStatus :tone="state.active ? 'success' : 'neutral'" :label="state.active ? '房间运行中' : '准备联机'" />
    </header>
    <NetworkOverview :overview="overview" :state="state" :scanning="scanning" @refresh="refresh" />
    <aside class="connection-notice" aria-label="直连限制与安全提示">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m12 3 9 4v5c0 5-9 9-9 9s-9-4-9-9V7Z"/><path d="M12 8v5m0 3v1"/></svg>
      <div><strong>先了解网络边界，再开始联机</strong><p>CGNAT、手机热点、校园网等环境下可能无法作为公网房主，但仍可能加入他人可达的世界。若希望更稳定地联机，建议使用专业内网穿透工具。开启房间会向可达网络开放世界端口，请仅向可信好友分享邀请。</p></div>
    </aside>
    <p v-if="error" class="connection-error" role="alert">{{ error }}</p>
    <div class="connection-columns">
      <ConnectionPanel title="创建房间" subtitle="邀请好友进入你的世界" step="01">
        <p class="connection-muted">先启动游戏，在世界内选择“对局域网开放”，再填写游戏显示的端口。</p>
        <label class="connection-field">房主实例<select v-model="hostTarget" class="select" :disabled="busy || state.active"><option value="" disabled>选择实例</option><option v-for="item in instances" :key="token(item)" :value="token(item)">{{ item.id }} · {{ item.folder }}</option></select></label>
        <p v-if="overview && !instances.length" class="connection-muted">暂无完整实例。<button class="btn btn-ghost" @click="store.currentView = 'game'">前往安装实例</button></p>
        <label class="connection-field">局域网端口<input v-model="port" class="input" type="number" min="1" max="65535" placeholder="例如 54321" :disabled="busy || state.active" /><small>优先从本次启动日志识别，也可手动输入游戏内显示的端口。</small></label>
        <label class="connection-toggle"><span>UPnP 临时端口映射<small>尝试让路由器自动建立映射，不保证成功</small></span><input v-model="useUpnp" type="checkbox" :disabled="busy || state.active" /><span class="connection-toggle-track" aria-hidden="true"></span></label>
        <details class="connection-details"><summary>高级设置 · 手动 IPv4 映射</summary><div class="connection-detail-content"><label class="connection-field">公网 IPv4<input v-model="publicAddress" class="input" placeholder="可选：路由器的公网 IPv4" :disabled="busy || state.active" /></label><p>开启后按显示的开放端口配置路由器，外部和内部端口保持一致。</p></div></details>
        <p v-if="store.settings?.closeAfterLaunch" class="connection-error">已开启“启动后退出启动器”。请在设置中关闭该选项，保持启动器运行以维持直连。</p>
        <div class="connection-actions">
          <button v-if="!state.active" class="btn btn-gold" :disabled="busy || scanning || !hostTarget" @click="host">{{ busy ? '正在建立直连…' : '开启房间' }}</button>
          <button v-if="busy || state.active" class="btn btn-ghost" @click="stop">{{ busy ? '取消创建' : '关闭房间' }}</button>
        </div>
        <div v-if="state.active" class="connection-result success" aria-live="polite">
          <ConnectionStatus tone="success" :label="'房间已开启 · ' + state.connections + ' 个连接'" />
          <p>世界端口 <code>{{ state.localPort }}</code> → 开放 TCP <code>{{ state.exposedPort }}</code></p>
          <p v-for="endpoint in state.endpoints" :key="endpoint.host"><code>{{ endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host }}:{{ endpoint.port }}</code><br /><span class="connection-muted">{{ endpoint.kind === 'lan' ? '仅局域网' : '公网候选，需好友验证' }}</span></p>
          <button class="btn btn-gold" :disabled="!state.invite" @click="copy(state.invite)">复制邀请信息</button>
        </div>
        <div v-if="state.messages.length" class="connection-result" aria-live="polite"><p v-for="message in state.messages" :key="message" class="connection-muted">{{ message }}</p></div>
      </ConnectionPanel>
      <ConnectionPanel title="加入好友" subtitle="有邀请，就从这里出发" step="02">
        <label class="connection-field">好友的邀请信息<textarea v-model="invitation" class="input invite-input" placeholder="在这里粘贴 KAMUCL-DIRECT-1:… 邀请信息" maxlength="16384" spellcheck="false" @input="resolved = null; manualJoinAddress = ''" /><small>邀请信息包含连接地址与版本要求，请勿向陌生人转发。</small></label>
        <div class="connection-actions"><button class="btn" :class="resolved ? 'btn-ghost' : 'btn-gold'" :disabled="checking || !invitation.trim()" @click="check">{{ checking ? '正在检测地址…' : '识别并检测连接' }}</button></div>
        <div v-if="!resolved" class="join-placeholder"><span class="connection-step" aria-hidden="true">↗</span><div><h3>等待一份邀请</h3><p>粘贴后将检测可达地址，并列出本机兼容实例。</p></div></div>
        <template v-if="resolved">
          <div class="connection-result" :class="{ success: resolved.endpoint }" aria-live="polite">
            <h3>{{ resolved.invitation.name }}</h3><p class="connection-muted">Minecraft {{ resolved.invitation.minecraftVersion }} · {{ resolved.invitation.loader || '原版' }} {{ resolved.invitation.loaderVersion || '' }}</p>
            <ConnectionStatus :tone="resolved.endpoint ? 'success' : 'danger'" :label="resolved.endpoint ? '找到可达地址' : '没有可达地址'" />
            <p v-if="resolved.endpoint" class="connection-muted">TCP 连通已验证，游戏登录仍需通过服务器认证。</p>
            <details v-if="resolved.failures.length" class="connection-details"><summary>未连通的地址</summary><div class="connection-detail-content"><p v-for="message in resolved.failures" :key="message">{{ message }}</p></div></details>
          </div>
          <label class="connection-field">兼容实例<select v-model="joinTarget" class="select"><option value="" disabled>选择兼容实例</option><option v-for="item in compatible" :key="token(item)" :value="token(item)">{{ item.id }} · {{ item.folder }}</option></select></label>
          <p class="connection-muted">版本和加载器匹配不代表 MOD 完全兼容，请与房主确认模组列表相同。游戏沿用所选账号的正常认证。</p>
          <p v-if="!store.selectedAccount" class="connection-muted">加入前请先登录游戏账号。</p>
          <div class="connection-actions"><button v-if="!compatible.length" class="btn btn-ghost" @click="store.currentView = 'game'">下载或导入兼容实例</button><button class="btn btn-gold" :disabled="joining || !joinTarget || !resolved.endpoint || store.launchState?.status === 'running' || store.launchState?.status === 'launching'" @click="join">{{ joining ? '准备启动…' : '启动并加入好友' }}</button></div>
        </template>
        <div v-if="manualJoinAddress" class="connection-result"><p>请在游戏的“多人游戏 → 直接连接”中填入 <code>{{ manualJoinAddress }}</code></p><button class="btn btn-ghost" @click="copy(manualJoinAddress)">复制地址</button></div>
      </ConnectionPanel>
    </div>
  </div>
</template>
<style scoped>
.invite-input { min-height: 145px; resize: vertical; line-height: 1.7; }
.join-placeholder { display: flex; align-items: center; gap: 14px; padding: 22px 18px; border: 1px dashed var(--border-strong); border-radius: 12px; background: var(--card-2); }
.join-placeholder h3 { font-size: 13px; margin-bottom: 6px; }
.join-placeholder p { color: var(--text-dim); font-size: 12px; line-height: 1.7; }
</style>
