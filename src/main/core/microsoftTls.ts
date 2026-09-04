import https from 'node:https'
import { checkServerIdentity } from 'node:tls'

const MICROSOFT_HOSTS = new Set([
  'login.microsoftonline.com', 'user.auth.xboxlive.com',
  'xsts.auth.xboxlive.com', 'api.minecraftservices.com'
])

export function microsoftEndpoint(input: string): URL {
  const url = new URL(input)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      (url.port && url.port !== '443') || !MICROSOFT_HOSTS.has(url.hostname))
    throw new Error('正版登录只允许连接受信任的 Microsoft / Xbox / Minecraft HTTPS 地址')
  return url
}

export function certificateError(error: NodeJS.ErrnoException): Error {
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|TLS/i.test(error.code ?? ''))
    return new Error(`SSL 证书验证失败（${error.code}）。请检查系统时间、代理或网络证书；登录已中止。`)
  return new Error(`正版登录连接失败：${error.code ?? error.message}`)
}

/** 校验真实认证连接的证书链、主机名和有效期；不跟随重定向发送凭据。
 * 单独使用 HTTPS Agent，避免外部全局 fetch dispatcher 或 TLS 环境变量绕过验证。
 */
export function microsoftFetch(input: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {}): Promise<Response> {
  const url = microsoftEndpoint(input)
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: init.method ?? 'GET', headers: init.headers, signal: init.signal,
      agent: false, rejectUnauthorized: true, checkServerIdentity, minVersion: 'TLSv1.2'
    }, res => {
      const status = res.statusCode ?? 500
      if (status >= 300 && status < 400) {
        res.destroy(); reject(new Error('正版认证端点返回了重定向，已阻止发送登录凭据')); return
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 2 * 1024 * 1024) res.destroy(new Error('正版认证响应超过大小限制'))
        else chunks.push(chunk)
      })
      res.once('error', reject)
      res.once('end', () => resolve(new Response(Buffer.concat(chunks), { status })))
    })
    req.setTimeout(30000, () => req.destroy(new Error('正版认证连接超时')))
    req.once('error', error => reject(certificateError(error)))
    req.end(init.body)
  })
}
