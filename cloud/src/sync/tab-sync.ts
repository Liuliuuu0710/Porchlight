/**
 * 云端版（《产品逻辑》8.1）：Homi 运行在云端，网页只是界面。接口沿用多标签页同步（这个文件原来的样子），
 * 换成和云端通信：
 * - 收：/api/stream（Server-Sent Events），消息格式不变（snapshot / segments / record / shared …）
 * - 发：操作 POST /api/cmd；需要回答的（askId）把结果包成 reply 消息交回去
 * 网页永远是“镜像”（界面），云端是唯一的主控；开着摄像头的页面另外当采集端（见 useHomi）。
 */
import { authHeaders, authRejected, whenAuthed } from '../core/auth'

export type Role = 'starting' | 'leader' | 'mirror'

export const SYNC_VERSION = 1

export interface SyncMessage {
  type: string
  [k: string]: unknown
}

type RoleListener = (role: Role) => void
type MessageListener = (msg: SyncMessage) => void

let role: Role = 'starting'
let started = false
let source: EventSource | null = null
/** 云端给这条连接的编号（采集端上报、要截图时用） */
let clientId: string | null = null
const roleListeners = new Set<RoleListener>()
const messageListeners = new Set<MessageListener>()
const mismatchListeners = new Set<() => void>()
const connListeners = new Set<(connected: boolean) => void>()

export const supported = () => typeof EventSource !== 'undefined'
export const getRole = () => role
export const versionMismatch = () => false
export const getClientId = () => clientId

function setRole(r: Role) {
  if (r === role) return
  role = r
  roleListeners.forEach((l) => l(r))
}

export function subscribeRole(l: RoleListener) {
  roleListeners.add(l)
  return () => void roleListeners.delete(l)
}
export function subscribeMessages(l: MessageListener) {
  messageListeners.add(l)
  return () => void messageListeners.delete(l)
}
export function subscribeMismatch(l: () => void) {
  mismatchListeners.add(l)
  return () => void mismatchListeners.delete(l)
}
/** 和云端的连接断开 / 恢复 */
export function subscribeConnection(l: (connected: boolean) => void) {
  connListeners.add(l)
  return () => void connListeners.delete(l)
}

const dispatch = (msg: SyncMessage) => messageListeners.forEach((l) => l(msg))

/** 最近一次收到云端消息的时间（心跳每 15 秒一次）；太久没有就当连接卡住了，自己重连 */
let lastMessageAt = 0
const STALE_MS = 45_000
let watchdog: ReturnType<typeof setInterval> | null = null

/** 连接看起来连着、其实已经不通（如云端重启时中间的代理没断开）：关掉重连 */
export function reconnect() {
  source?.close()
  source = null
  connListeners.forEach((l) => l(false))
  void checkPass().then(() => connect())
}

async function connect() {
  await whenAuthed()
  source?.close()
  const es = new EventSource('/api/stream')
  source = es
  lastMessageAt = Date.now()
  watchdog ??= setInterval(() => {
    if (source && Date.now() - lastMessageAt > STALE_MS) reconnect()
  }, 5_000)
  es.onmessage = (ev) => {
    lastMessageAt = Date.now()
    let msg: SyncMessage
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    if (msg.type === 'ping') return
    if (msg.type === 'welcome') {
      clientId = msg.clientId as string
      setRole('mirror')
      connListeners.forEach((l) => l(true))
      dispatch(msg)
      return
    }
    dispatch(msg)
  }
  es.onerror = () => {
    connListeners.forEach((l) => l(false))
    // 浏览器会自己重连；被拒绝时连接关闭：先问云端通行证还认不认（服务器重启等），不认就弹出密码框，输完再连
    if (es.readyState === EventSource.CLOSED && source === es) {
      setTimeout(() => void checkPass().then(() => connect()), 2000)
    }
  }
}

/** 通行证云端不认了：清掉，页面弹出密码框（whenAuthed 会等用户输完） */
async function checkPass() {
  try {
    const res = await fetch('/auth', { headers: { accept: 'application/json', ...authHeaders() } })
    const body = await res.json()
    if (body?.required && body.valid === false) authRejected()
  } catch {
    // 连不上云端：照样重连，浏览器断网恢复后会好
  }
}

/** 带通行证发请求；云端说通行证不认（401）就弹出密码框，输完再发一次 */
async function authedFetch(path: string, init: RequestInit): Promise<Response> {
  await whenAuthed()
  const send = () => fetch(path, { ...init, headers: { ...(init.headers as Record<string, string>), ...authHeaders() } })
  const res = await send()
  if (res.status !== 401) return res
  authRejected()
  await whenAuthed()
  return send()
}

/** 页面打开时调用一次：连上云端（重复调用无效） */
export function startLeadership() {
  if (started) return
  started = true
  if (!supported()) return
  void connect()
}

/** 调用云端的操作；返回云端的结果 */
export async function command(name: string, args: unknown[] = []): Promise<unknown> {
  const res = await authedFetch('/api/cmd', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, args, clientId }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error?.message ?? body?.error ?? `云端出错（${res.status}）`)
  return body.value
}

/** 沿用原来的发送接口：cmd 发给云端；需要回答的把结果包成 reply 消息 */
export function post(msg: SyncMessage) {
  if (msg.type === 'hello') {
    void command('hello').catch(() => {})
    return
  }
  if (msg.type !== 'cmd') return
  const askId = msg.askId as string | undefined
  command(msg.name as string, (msg.args as unknown[]) ?? []).then(
    (value) => askId && dispatch({ type: 'reply', askId, value }),
    (e: Error) => (askId ? dispatch({ type: 'reply', askId, error: e.message }) : console.warn('云端操作失败', msg.name, e)),
  )
}

/** 云端版没有“抢主控”：开画面的页面当采集端，不用切换 */
export async function takeOver(): Promise<void> {}

/** 采集端上传（片段、截图） */
export async function upload(path: string, body: unknown): Promise<void> {
  const res = await authedFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  // 409：云端不认这个页面是采集端。可能是连接卡住、云端已经不认识这个页面了——重连一下（重连后会重新报到）
  if (res.status === 409 && source && Date.now() - lastMessageAt > 20_000) reconnect()
  if (!res.ok) throw new Error(`上传失败（${res.status}）`)
}
