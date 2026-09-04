<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
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
  <section class="friend-connect card">
    <div class="friend-heading"><div><h2>好友直连</h2><p class="muted">玩家本机直连 · 无平台服务器、第三方匹配或外部中继</p></div><button class="btn btn-ghost btn-sm" :disabled="scanning" @click="refresh">{{scanning ? '检测网络中…' : '刷新网络与端口'}}</button></div>
    <p class="friend-note">自带联机有局限性：CGNAT、手机热点、校园网可能无法作为公网房主，但仍可加入可达好友的世界。想体验完整的内网穿透联机功能，建议使用专门的内网穿透工具。</p>
    <details v-if="overview" class="network-details"><summary>本机网络检测结果</summary>
      <p v-for="item in overview.network.addresses" :key="item.address">{{item.kind === 'ipv6' ? '公网 IPv6 候选' : item.kind === 'ipv4' ? '公网 IPv4 候选' : '局域网 IPv4'}} · {{item.name}} · <code>{{item.address}}</code></p>
      <p v-for="item in overview.network.gateways" :key="item.address">网关 {{item.address}} · WAN {{item.externalAddress}}：{{item.diagnosis}}</p>
      <p v-for="message in overview.network.messages" :key="message">{{message}}</p>
    </details>
    <div class="friend-columns">
      <div class="friend-side">
        <h3>创建房间</h3>
        <p class="muted">先启动游戏，在世界内选择“对局域网开放”。开启后会对可达网络开放世界端口，请只向可信好友分享邀请。</p>
        <label>房主实例<select v-model="hostTarget" class="select" :disabled="busy || state.active"><option value="" disabled>选择实例</option><option v-for="item in instances" :key="token(item)" :value="token(item)">{{item.id}} · {{item.folder}}</option></select></label>
        <label>游戏内显示的局域网端口<input v-model="port" class="input" type="number" min="1" max="65535" placeholder="自动从本次启动日志识别，也可手动输入" :disabled="busy || state.active" /></label>
        <label class="check-row"><input v-model="useUpnp" type="checkbox" :disabled="busy || state.active" /> 尝试 UPnP 临时端口映射</label>
        <details><summary>手动 IPv4 映射</summary><input v-model="publicAddress" class="input" placeholder="可选：路由器的公网 IPv4" :disabled="busy || state.active" /><p class="muted">开启后按显示的开放端口配置路由器，外部和内部端口保持一致。</p></details>
        <p v-if="store.settings?.closeAfterLaunch" class="friend-note">已开启“启动后退出启动器”。请保持启动器运行以维持直连，可在设置中关闭该选项。</p>
        <button v-if="!state.active" class="btn btn-gold" :disabled="busy || scanning || !hostTarget" @click="host">{{busy ? '正在建立直连…' : '开启房间'}}</button>
        <button v-if="busy || state.active" class="btn btn-danger" @click="stop">{{busy ? '取消创建' : '关闭房间'}}</button>
        <template v-if="state.active">
          <p>房间已开启 · {{state.connections}} 个连接 · 世界端口 {{state.localPort}} → 开放 TCP {{state.exposedPort}}</p>
          <p v-for="endpoint in state.endpoints" :key="endpoint.host"><code>{{endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host}}:{{endpoint.port}}</code> · {{endpoint.kind === 'lan' ? '仅局域网' : '公网候选，需好友验证'}}</p>
          <button class="btn btn-gold" :disabled="!state.invite" @click="copy(state.invite)">复制邀请信息</button>
        </template>
        <p v-for="message in state.messages" :key="message" class="muted">{{message}}</p>
      </div>
      <div class="friend-side">
        <h3>加入好友</h3>
        <label>好友的邀请信息<textarea v-model="invitation" class="input invite-input" placeholder="粘贴 KAMUCL-DIRECT-1:…" maxlength="16384" @input="resolved = null" /></label>
        <button class="btn btn-ghost" :disabled="checking || !invitation.trim()" @click="check">{{checking ? '正在检测地址…' : '识别并检测连接'}}</button>
        <template v-if="resolved">
          <p>{{resolved.invitation.name}} · Minecraft {{resolved.invitation.minecraftVersion}} · {{resolved.invitation.loader || '原版'}} {{resolved.invitation.loaderVersion || ''}}</p>
          <p :class="resolved.endpoint ? 'connected' : 'error'">{{resolved.endpoint ? '已找到 TCP 可达地址，游戏登录仍需通过服务器认证' : '没有可达地址'}}</p>
          <details v-if="resolved.failures.length"><summary>未连通的地址</summary><p v-for="message in resolved.failures" :key="message" class="muted">{{message}}</p></details>
          <label>兼容实例<select v-model="joinTarget" class="select"><option value="" disabled>选择兼容实例</option><option v-for="item in compatible" :key="token(item)" :value="token(item)">{{item.id}} · {{item.folder}}</option></select></label>
          <p class="muted">版本和加载器匹配不代表 MOD 完全兼容，请与房主确认模组列表相同。游戏沿用所选账号的正常认证。</p>
          <button v-if="!compatible.length" class="btn btn-ghost" @click="store.currentView = 'game'">下载或导入兼容实例</button>
          <button class="btn btn-gold" :disabled="joining || !joinTarget || !resolved.endpoint || store.launchState?.status === 'running' || store.launchState?.status === 'launching'" @click="join">{{joining ? '准备启动…' : '启动并加入好友'}}</button>
        </template>
        <p v-if="manualJoinAddress">请在游戏的“多人游戏 → 直接连接”中填入 <code>{{manualJoinAddress}}</code><button class="btn btn-ghost btn-sm" @click="copy(manualJoinAddress)">复制地址</button></p>
      </div>
    </div>
    <p v-if="error" class="error" role="alert">{{error}}</p>
  </section>
</template>

<style scoped>
.friend-connect { margin: 0 0 24px; padding: 22px; }
.friend-heading { display:flex; justify-content:space-between; align-items:center; gap:16px; }
.friend-heading h2 { margin:0 0 6px; font-size:20px; }
.friend-heading p { margin:0; }
.friend-note { padding:12px 14px; background:var(--accent-soft); border:1px solid var(--border); border-radius:10px; line-height:1.7; }
.friend-columns { display:grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap:24px; margin-top:18px; }
.friend-side { min-width:0; display:flex; flex-direction:column; align-items:stretch; gap:12px; }
.friend-side h3, .friend-side p { margin:0; line-height:1.65; }
.friend-side label { display:flex; flex-direction:column; gap:7px; }
.friend-side .check-row { flex-direction:row; align-items:center; }
.friend-side .btn { align-self:flex-start; }
.friend-side code, .network-details code { overflow-wrap:anywhere; }
.friend-side select { width:100%; }
.invite-input { min-height:105px; resize:vertical; }
summary { cursor:pointer; color:var(--text-dim); margin-bottom:8px; }
.error { color:var(--danger); white-space:pre-wrap; }
.connected { color:var(--ok); }
@media(max-width:1050px) { .friend-columns { grid-template-columns:1fr; } .friend-heading { align-items:flex-start; flex-direction:column; } }
</style>
