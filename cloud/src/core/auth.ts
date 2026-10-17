/**
 * 访问密码（部署到服务器后才有；本机开发时不需要）：
 * - 每次新打开网页都要输密码（通行证只存在页面内存里，刷新就没了）
 * - 这次打开期间一直有效，不再每 10 分钟重输（服务器决定有效期，最多 30 天；服务器不认了才再输一次）
 * - 需要密码时，发往 AI 网关的请求先等着，输完密码自动继续，不会失败
 */
type Listener = () => void

let required: boolean | null = null
let token: string | null = null
let expiresAt = 0
let expireTimer: number | undefined
const listeners = new Set<Listener>()
let waiters: (() => void)[] = []

const notify = () => listeners.forEach((l) => l())

export function subscribeAuth(l: Listener) {
  listeners.add(l)
  return () => listeners.delete(l)
}

export const authState = () => ({ required, authed: !!token && Date.now() < expiresAt, expiresAt })

/** 服务器是否要求密码：部署的服务器 GET /auth 返回 { required: true }；本机开发时没有这个接口 */
export async function checkAuthRequired(): Promise<boolean> {
  if (required !== null) return required
  try {
    const res = await fetch('/auth', { headers: { accept: 'application/json' } })
    const body = res.ok && (res.headers.get('content-type') ?? '').includes('application/json') ? await res.json() : null
    required = body?.required === true
  } catch {
    required = false
  }
  notify()
  return required
}

function expire() {
  token = null
  expiresAt = 0
  window.clearTimeout(expireTimer)
  notify()
}

export async function login(password: string): Promise<string | null> {
  const res = await fetch('/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) return body.error ?? `登录失败（${res.status}）`
  token = body.token
  expiresAt = body.expiresAt
  window.clearTimeout(expireTimer)
  // setTimeout 最长约 24.8 天，更长的不设定时器（whenAuthed 每次请求前也会检查是否过期）
  const left = expiresAt - Date.now()
  if (left < 2 ** 31 - 1) expireTimer = window.setTimeout(expire, Math.max(0, left))
  const w = waiters
  waiters = []
  w.forEach((r) => r())
  notify()
  return null
}

/** 发请求前调用：需要密码且还没输（或已过期）时，等用户输完 */
export async function whenAuthed(): Promise<void> {
  if (!(await checkAuthRequired())) return
  if (token && Date.now() < expiresAt) return
  if (token) expire()
  await new Promise<void>((r) => waiters.push(r))
}

export const authHeaders = (): Record<string, string> => (token ? { 'x-porchlight-auth': token } : {})

/** 服务器说通行证无效（过期了）：清掉，界面会弹出密码框 */
export function authRejected() {
  expire()
}
