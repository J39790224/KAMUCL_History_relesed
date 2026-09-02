/**
 * 账号模块：离线账号 + 微软 device code 登录（XBL → XSTS → MC）
 * 存储：userData/accounts.json
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Account, MsDeviceCodeInfo } from '../../shared/types'
import { getSettings } from './settings'

/** 微软 OAuth 端点（consumers 租户：支持个人 MSA 账号的 device code 流程） */
const MS_SCOPE = 'XboxLive.signin offline_access'

/** client_id 统一走 consumers 租户（默认 Prism 公开应用 / 用户自注册应用均为该租户） */
function msAuthBase(_clientId: string): string {
  return 'https://login.microsoftonline.com/consumers/oauth2/v2.0'
}

interface AccountsFile {
  accounts: Account[]
  selectedId: string | null
}

let cached: AccountsFile | null = null

function storeFile(): string {
  return path.join(app.getPath('userData'), 'accounts.json')
}

function load(): AccountsFile {
  if (cached) return cached
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf-8')) as AccountsFile
    cached = {
      accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
      selectedId: raw.selectedId ?? null
    }
  } catch {
    cached = { accounts: [], selectedId: null }
  }
  return cached
}

function persist(): void {
  const data = load()
  try {
    fs.mkdirSync(path.dirname(storeFile()), { recursive: true })
    fs.writeFileSync(storeFile(), JSON.stringify(data, null, 2), 'utf-8')
  } catch (e) {
    console.error('[KAMUCL] 账号写入失败:', e)
  }
}

/** 插入或更新账号（按 uuid 去重），并设为当前选中 */
function upsert(account: Account): Account {
  const data = load()
  const idx = data.accounts.findIndex((a) => a.uuid === account.uuid)
  if (idx >= 0) data.accounts[idx] = { ...data.accounts[idx], ...account }
  else data.accounts.push(account)
  data.selectedId = account.id
  persist()
  return account
}

// ---------------- 基础操作 ----------------

export function listAccounts(): Account[] {
  return load().accounts
}

export function selectedAccount(): Account | null {
  const data = load()
  return data.accounts.find((a) => a.id === data.selectedId) ?? null
}

export function selectAccount(id: string): Account | null {
  const data = load()
  const acc = data.accounts.find((a) => a.id === id) ?? null
  if (acc) {
    data.selectedId = acc.id
    persist()
  }
  return acc
}

export function removeAccount(id: string): Account[] {
  const data = load()
  data.accounts = data.accounts.filter((a) => a.id !== id)
  if (data.selectedId === id) data.selectedId = data.accounts[0]?.id ?? null
  persist()
  return data.accounts
}

// ---------------- 离线账号 ----------------

/** 32 位 hex 格式化为 8-4-4-4-12，并设置 version 3 / variant 位（与 MC 离线模式一致） */
function offlineUuid(username: string): string {
  const hex = crypto.createHash('md5').update(`OfflinePlayer:${username}`, 'utf-8').digest('hex')
  const fixed = hex.slice(0, 12) + '3' + hex.slice(13, 16) + '8' + hex.slice(17)
  return `${fixed.slice(0, 8)}-${fixed.slice(8, 12)}-${fixed.slice(12, 16)}-${fixed.slice(16, 20)}-${fixed.slice(20)}`
}

export function addOffline(username: string): Account {
  const name = username.trim()
  if (!name) throw new Error('用户名不能为空')
  const uuid = offlineUuid(name)
  const account: Account = {
    id: uuid,
    type: 'offline',
    username: name,
    uuid,
    accessToken: crypto.randomBytes(16).toString('hex')
  }
  return upsert(account)
}

// ---------------- 微软登录 ----------------

/** 轮询取消标记 */
let pollAbort: AbortController | null = null

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('已取消'))
    }
    if (signal?.aborted) {
      clearTimeout(timer)
      reject(new Error('已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function postForm(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(30000)
  })
  return (await res.json().catch(() => ({}))) as Record<string, unknown>
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const xerr = data.XErr ? ` (XErr ${String(data.XErr)})` : ''
    throw new Error(`请求失败 HTTP ${res.status}${xerr}: ${url}`)
  }
  return data
}

async function getJson(url: string, bearer: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(30000)
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new Error(`请求失败 HTTP ${res.status}: ${url}`)
  return data
}

function uuidWithHyphens(id: string): string {
  const hex = id.replace(/-/g, '').toLowerCase()
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * 拿到微软 oauth token 后的完整链路：
 * XBL → XSTS → MC 登录 → 拥有权检查 → 档案
 */
async function completeMsLogin(
  msAccessToken: string,
  refreshToken: string,
  expiresIn: number
): Promise<Account> {
  // 1. XBL 认证
  const xbl = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: `d=${msAccessToken}`
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT'
  })
  const xblToken = xbl.Token as string
  if (!xblToken) throw new Error('Xbox Live 认证失败')

  // 2. XSTS 授权
  const xsts = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT'
  })
  const xstsToken = xsts.Token as string
  const xui = (xsts.DisplayClaims as { xui?: { uhs?: string }[] } | undefined)?.xui
  const uhs = xui?.[0]?.uhs
  if (!xstsToken || !uhs) {
    throw new Error('XSTS 授权失败（该账号可能尚未创建 Xbox 档案，请先在 xbox.com 登录一次）')
  }

  // 3. MC 登录
  const mc = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${uhs};${xstsToken}`
  })
  const mcToken = mc.access_token as string
  const mcExpires = (mc.expires_in as number | undefined) ?? expiresIn
  if (!mcToken) throw new Error('Minecraft 登录失败')

  // 4. 拥有权检查
  const entitlements = await getJson(
    'https://api.minecraftservices.com/entitlements/mcstore',
    mcToken
  )
  const items = (entitlements.items as { name?: string }[] | undefined) ?? []
  if (!items.some((i) => i.name === 'product_minecraft')) {
    throw new Error('该账号未拥有 Minecraft')
  }

  // 5. 档案
  const profile = await getJson('https://api.minecraftservices.com/minecraft/profile', mcToken)
  const pid = profile.id as string
  const pname = profile.name as string
  if (!pid || !pname) throw new Error('获取 Minecraft 档案失败')

  const uuid = uuidWithHyphens(pid)
  const account: Account = {
    id: uuid,
    type: 'microsoft',
    username: pname,
    uuid,
    accessToken: mcToken,
    refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + mcExpires
  }
  return upsert(account)
}

/** 后台轮询 token 端点直到成功/过期/取消 */
async function pollDeviceCode(
  deviceCode: string,
  intervalSec: number,
  expiresInSec: number,
  signal: AbortSignal
): Promise<Account> {
  const clientId = getSettings().msClientId
  let interval = Math.max(1, intervalSec) * 1000
  const deadline = Date.now() + expiresInSec * 1000
  while (Date.now() < deadline) {
    await sleep(interval, signal)
    const t = await postForm(`${msAuthBase(clientId)}/token`, {
      client_id: clientId,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode
    })
    if (typeof t.access_token === 'string') {
      return await completeMsLogin(
        t.access_token,
        (t.refresh_token as string | undefined) ?? '',
        (t.expires_in as number | undefined) ?? 86400
      )
    }
    const err = t.error as string | undefined
    if (err === 'authorization_pending') continue
    if (err === 'slow_down') {
      interval += 5000
      continue
    }
    throw new Error((t.error_description as string | undefined) ?? err ?? '登录失败')
  }
  throw new Error('登录超时，设备码已过期')
}

/**
 * 开始 device code 登录：返回展示信息给前端，后台轮询，
 * 完成后调用 onDone(account)（失败/取消时 onDone(null)）
 */
export async function beginMsDeviceCode(
  onDone: (account: Account | null) => void
): Promise<MsDeviceCodeInfo> {
  cancelMsLogin() // 取消上一次未完成的轮询
  const clientId = getSettings().msClientId
  const dc = await postForm(`${msAuthBase(clientId)}/devicecode`, {
    client_id: clientId,
    scope: MS_SCOPE
  })
  const deviceCode = dc.device_code as string | undefined
  if (!deviceCode) {
    throw new Error((dc.error_description as string | undefined) ?? '获取设备码失败')
  }

  pollAbort = new AbortController()
  const signal = pollAbort.signal
  void pollDeviceCode(
    deviceCode,
    (dc.interval as number | undefined) ?? 5,
    (dc.expires_in as number | undefined) ?? 900,
    signal
  )
    .then((account) => onDone(account))
    .catch((e) => {
      if (!signal.aborted) console.error('[KAMUCL] 微软登录失败:', e)
      onDone(null)
    })

  return {
    userCode: (dc.user_code as string | undefined) ?? '',
    verificationUri: (dc.verification_uri as string | undefined) ?? '',
    message: (dc.message as string | undefined) ?? ''
  }
}

/** 取消进行中的微软登录轮询 */
export function cancelMsLogin(): void {
  pollAbort?.abort()
  pollAbort = null
}

/** 用 refresh_token 重走整个 XBL→XSTS→MC 链，更新存储 */
export async function refreshMicrosoft(account: Account): Promise<Account> {
  if (!account.refreshToken) throw new Error('缺少 refresh_token，请重新登录')
  const t = await postForm(`${msAuthBase(getSettings().msClientId)}/token`, {
    client_id: getSettings().msClientId,
    grant_type: 'refresh_token',
    refresh_token: account.refreshToken,
    scope: MS_SCOPE
  })
  if (typeof t.access_token !== 'string') {
    throw new Error((t.error_description as string | undefined) ?? '微软令牌刷新失败，请重新登录')
  }
  const refreshed = await completeMsLogin(
    t.access_token,
    (t.refresh_token as string | undefined) ?? account.refreshToken,
    (t.expires_in as number | undefined) ?? 86400
  )
  // 保持原选中 id 不变（completeMsLogin 内部 upsert 已处理）
  return refreshed
}

/** 返回可用账号：离线直接返回；微软临期（<5分钟）自动刷新 */
export async function getValidAccount(account: Account): Promise<Account> {
  if (account.type === 'offline') return account
  const now = Math.floor(Date.now() / 1000)
  if (!account.accessToken || !account.expiresAt || account.expiresAt - now < 300) {
    return await refreshMicrosoft(account)
  }
  return account
}
