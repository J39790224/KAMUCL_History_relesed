<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import {
  addOfflineAccount,
  copyText,
  errText,
  getSelectedAccount,
  msBeginLogin,
  msCancelLogin,
  onMsLoginDone,
  removeAccount,
  selectAccount
} from '../api'
import { refreshAccounts, store, toast } from '../store'
import Avatar from '../components/Avatar.vue'
import type { Account, MsDeviceCodeInfo } from '@shared/types'

// ---------------- 添加离线账号 ----------------
const newName = ref('')
const adding = ref(false)

const NAME_RE = /^[A-Za-z0-9_]{3,16}$/
const nameError = computed(() => {
  if (!newName.value) return ''
  if (!NAME_RE.test(newName.value)) return '用户名需为 3-16 位字母、数字或下划线'
  return ''
})

async function onAddOffline() {
  const name = newName.value.trim()
  if (!NAME_RE.test(name)) {
    toast('用户名需为 3-16 位字母、数字或下划线', 'error')
    return
  }
  adding.value = true
  try {
    await addOfflineAccount(name)
    await refreshAccounts()
    newName.value = ''
    toast(`已添加离线账号 ${name}`, 'success')
  } catch (e) {
    toast('添加失败：' + errText(e), 'error')
  } finally {
    adding.value = false
  }
}

// ---------------- 微软登录 ----------------
const ms = reactive({
  open: false,
  waiting: false,
  starting: false,
  info: null as MsDeviceCodeInfo | null
})

async function beginMsLogin() {
  if (ms.starting) return
  ms.starting = true
  try {
    ms.info = await msBeginLogin()
    ms.open = true
    ms.waiting = true
  } catch (e) {
    toast('无法开始微软登录：' + errText(e), 'error')
  } finally {
    ms.starting = false
  }
}

async function cancelMsLogin() {
  ms.open = false
  ms.waiting = false
  try {
    await msCancelLogin()
  } catch {
    /* 忽略取消时的异常 */
  }
}

async function copyCode() {
  if (!ms.info) return
  const ok = await copyText(ms.info.userCode)
  toast(ok ? '已复制验证码' : '复制失败，请手动复制', ok ? 'success' : 'error')
}

function openVerifyPage() {
  if (ms.info) window.open(ms.info.verificationUri)
}

let offMsDone: (() => void) | null = null

onMounted(() => {
  offMsDone = onMsLoginDone(async (account) => {
    if (!ms.open) return
    ms.open = false
    ms.waiting = false
    ms.info = null
    if (account) {
      await refreshAccounts()
      toast(`登录成功，欢迎 ${account.username}`, 'success')
    } else {
      toast('微软登录失败或已取消', 'error')
    }
  })
})

onUnmounted(() => {
  offMsDone?.()
})

// ---------------- 账号卡片 ----------------
const removingId = ref<string | null>(null)
const selectingId = ref<string | null>(null)

async function onSelect(acc: Account) {
  if (store.selectedAccount?.id === acc.id) return
  selectingId.value = acc.id
  try {
    store.selectedAccount = await selectAccount(acc.id)
  } catch (e) {
    toast('切换账号失败：' + errText(e), 'error')
  } finally {
    selectingId.value = null
  }
}

async function onRemove(acc: Account) {
  removingId.value = acc.id
  try {
    store.accounts = await removeAccount(acc.id)
    if (store.selectedAccount?.id === acc.id) {
      store.selectedAccount = await getSelectedAccount()
    }
    toast(`已删除账号 ${acc.username}`, 'success')
  } catch (e) {
    toast('删除失败：' + errText(e), 'error')
  } finally {
    removingId.value = null
  }
}
</script>

<template>
  <div class="page">
    <!-- 返回 + 标题 -->
    <div class="acc-top">
      <button class="back-btn" @click="store.currentView = 'home'">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 12H5" />
          <path d="m12 19-7-7 7-7" />
        </svg>
        返回首页
      </button>
      <div class="page-head">
        <h1 class="page-title">账号</h1>
        <p class="page-sub">管理离线账号与微软正版账号</p>
      </div>
    </div>

    <!-- 添加账号 -->
    <div class="card">
      <h3 class="section-title">添加账号</h3>
      <div class="add-row">
        <div class="add-input-wrap">
          <input
            v-model="newName"
            class="input"
            :class="{ 'input-error': nameError }"
            placeholder="离线账号用户名（3-16 位字母数字下划线）"
            maxlength="16"
            @keyup.enter="onAddOffline"
          />
          <p v-if="nameError" class="field-error">{{ nameError }}</p>
        </div>
        <button
          class="btn btn-gold add-btn"
          :disabled="adding || !newName || !!nameError"
          @click="onAddOffline"
        >
          {{ adding ? '添加中…' : '添加离线账号' }}
        </button>
        <button class="btn btn-ghost ms-btn" :disabled="ms.starting" @click="beginMsLogin">
          <span v-if="ms.starting" class="spin"></span>
          <svg v-else viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
            <path d="M3 3h8.5v8.5H3zM12.5 3H21v8.5h-8.5zM3 12.5h8.5V21H3zM12.5 12.5H21V21h-8.5z" />
          </svg>
          {{ ms.starting ? '正在获取登录码…' : '微软登录' }}
        </button>
      </div>
    </div>

    <!-- 账号列表 -->
    <div class="card">
      <h3 class="section-title">我的账号（{{ store.accounts.length }}）</h3>
      <div v-if="!store.accounts.length" class="empty list-empty">
        <span>还没有账号，先添加一个离线账号或登录微软账号吧</span>
      </div>
      <div v-else class="account-list">
        <div
          v-for="acc in store.accounts"
          :key="acc.id"
          class="account-row"
          :class="{ selected: store.selectedAccount?.id === acc.id }"
          @click="onSelect(acc)"
        >
          <!-- 头像 IPC 仅支持当前选中账号：选中行显示 MC 方块头像（微软=皮肤头 / 离线=Steve 风像素头），其余首字母 -->
          <Avatar v-if="store.selectedAccount?.id === acc.id" :size="42" />
          <div v-else class="avatar">{{ acc.username.charAt(0).toUpperCase() }}</div>
          <div class="account-meta">
            <div class="account-name">
              {{ acc.username }}
              <span class="tag" :class="acc.type === 'microsoft' ? 'tag-gold' : ''">
                {{ acc.type === 'microsoft' ? '微软' : '离线' }}
              </span>
            </div>
            <span class="muted uuid">{{ acc.uuid.slice(0, 8) }}</span>
          </div>
          <span v-if="store.selectedAccount?.id === acc.id" class="selected-badge">使用中</span>
          <span v-else-if="selectingId === acc.id" class="spin"></span>
          <button
            class="btn btn-danger btn-sm remove-btn"
            :disabled="removingId === acc.id"
            @click.stop="onRemove(acc)"
          >
            {{ removingId === acc.id ? '删除中…' : '删除' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 微软登录模态框 -->
    <Teleport to="body">
      <div v-if="ms.open" class="modal-mask">
        <div class="modal ms-modal">
          <h3 class="modal-title">微软账号登录</h3>
          <p class="muted ms-tip">
            请在浏览器中打开验证地址，输入下方代码完成授权。登录成功后本窗口会自动关闭。
          </p>

          <button class="user-code" title="点击复制" @click="copyCode">
            {{ ms.info?.userCode }}
          </button>
          <p class="muted copy-hint">点击代码即可复制</p>

          <div class="ms-uri-row">
            <input class="input" :value="ms.info?.verificationUri" readonly />
            <button class="btn btn-gold" @click="openVerifyPage">打开验证页面</button>
          </div>

          <div v-if="ms.waiting" class="ms-waiting">
            <span class="spin"></span>
            <span class="muted">正在等待授权完成…</span>
          </div>

          <div class="modal-actions">
            <button class="btn btn-ghost" @click="cancelMsLogin">取消登录</button>
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
  max-width: 720px;
  margin: 0 auto;
}

.acc-top {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.back-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  align-self: flex-start;
  padding: 6px 12px 6px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-dim);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.back-btn:hover {
  background: var(--card-2);
  color: var(--accent-2);
}
.back-btn svg {
  width: 15px;
  height: 15px;
}

.section-title {
  font-size: 15px;
  margin-bottom: 14px;
}

/* 添加账号 */
.add-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.add-input-wrap {
  flex: 1;
  min-width: 0;
}
.input-error {
  border-color: var(--danger);
}
.field-error {
  margin-top: 6px;
  font-size: 12px;
  color: var(--danger);
}
.add-btn,
.ms-btn {
  flex-shrink: 0;
}

/* 账号列表 */
.list-empty {
  padding: 28px;
}
.account-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.account-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--card-2);
  cursor: pointer;
  transition: border-color 0.18s ease, background 0.18s ease;
}
.account-row:hover {
  border-color: var(--accent-deep);
}
.account-row.selected {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.avatar {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  font-weight: 800;
  color: var(--on-accent);
  background: var(--accent-grad);
  flex-shrink: 0;
}
.account-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1;
}
.account-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  overflow: hidden;
  white-space: nowrap;
}
.uuid {
  font-size: 12px;
  font-family: 'Cascadia Code', Consolas, monospace;
}
.selected-badge {
  font-size: 12px;
  color: var(--accent);
  flex-shrink: 0;
}
.remove-btn {
  flex-shrink: 0;
}

/* 微软登录模态框 */
.ms-modal {
  text-align: center;
}
.modal-title {
  font-size: 17px;
  margin-bottom: 10px;
}
.ms-tip {
  font-size: 13px;
  line-height: 1.6;
}
.user-code {
  margin: 18px auto 6px;
  padding: 14px 24px;
  border: 1px dashed var(--accent);
  border-radius: 12px;
  background: var(--accent-soft);
  color: var(--accent-2);
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 28px;
  font-weight: 700;
  letter-spacing: 4px;
  cursor: pointer;
  transition: background 0.15s ease;
}
.user-code:hover {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
}
.copy-hint {
  font-size: 12px;
  margin-bottom: 16px;
}
.ms-uri-row {
  display: flex;
  gap: 10px;
}
.ms-uri-row .input {
  flex: 1;
  min-width: 0;
  font-size: 13px;
}
.ms-uri-row .btn {
  flex-shrink: 0;
}
.ms-waiting {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 18px;
}
.modal-actions {
  display: flex;
  justify-content: center;
  margin-top: 20px;
}
</style>
