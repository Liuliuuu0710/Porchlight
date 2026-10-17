/**
 * 云端 Homi 服务（《产品逻辑》8.1）：一个 Node 进程，没有原生依赖。
 * - /auth：访问密码 → 通行证（这次打开期间有效；同时写一个会话 Cookie，图片和实时推送靠它）
 * - /ai-api/*：带 Key 转发到主办方网关（网页里的对话还在浏览器里组织提示词）
 * - /openapi-api/*：转发到 eufy 接口（采集端连 eufy 摄像头用；eufy 有的接口不允许网页跨域调用）
 * - /api/stream：实时推送（Server-Sent Events），消息格式沿用多标签页同步（snapshot / segments / record / shared）
 * - /api/cmd：界面发来的操作（整理、日报、提醒条按钮、改计划和记忆、改设置、开关画面……）
 * - /api/capture/*：采集端上传片段、回传“现在看一眼”的截图
 * - /api/images/*：截图原图（给用户看；送模型前才裁掉 / 填灰忽略区域）
 * - 其余：网页（dist/）
 *
 * 环境变量：AI_API_KEY（必填）、SHARE_PASSWORD（不填 = 本机开发，不要密码）、PORT（默认 8787）、HOST、
 *          TRUST_PROXY、PASS_TTL_MINUTES、DATA_DIR（默认 ./data）、DIST（默认 ./dist）、
 *          EUFY_CONFIG（eufy 鉴权参数 JSON，线上从 SSM 读）或 EUFY_CONFIG_FILE（本机：eufy.local.json）
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { extname, join, normalize, resolve } from 'node:path'
import { setImageOps } from '../src/ai/image-ops'
import { configureGateway } from '../src/ai/gateway'
import { diffById, diffRecord, isEmptyDiff } from '../src/sync/diff'
import type { Segment, Snapshot } from '../src/motion/detector'
import { nodeImageOps } from './image-ops-node'
import { Store, b64ToGray, imageUrl } from './store'
import { HomiEngine } from './engine'

const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? '0.0.0.0'
const KEY = process.env.AI_API_KEY ?? ''
const PASSWORD = process.env.SHARE_PASSWORD ?? ''
const DIST = resolve(process.env.DIST ?? 'dist')
const DATA_DIR = resolve(process.env.DATA_DIR ?? 'data')

/** eufy 摄像头的鉴权参数：给输过访问密码的采集端用，免得每次在网页里填；没配就让用户在网页里填 */
async function loadEufyConfig(): Promise<Record<string, string> | null> {
  try {
    const raw = process.env.EUFY_CONFIG || (process.env.EUFY_CONFIG_FILE ? await readFile(process.env.EUFY_CONFIG_FILE, 'utf8') : '')
    if (!raw.trim()) return null
    const c = JSON.parse(raw) as Record<string, unknown>
    return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, String(v ?? '').trim()]))
  } catch (e) {
    console.warn('eufy 参数读不了：', (e as Error).message)
    return null
  }
}
const EUFY_CONFIG = await loadEufyConfig()
const UPSTREAM = 'https://ai-router-cn-pub.anker-in.com'
const TOKEN_TTL_MS = Number(process.env.PASS_TTL_MINUTES ?? 30 * 24 * 60) * 60 * 1000
const LOGIN_LIMIT = 10
const GRAB_TIMEOUT_MS = 15_000

if (!KEY) {
  console.error('缺少环境变量 AI_API_KEY，不启动')
  process.exit(1)
}

// 模型调用直接走主办方网关（Key 只在这里）；图片用纯 JS 处理
configureGateway({
  endpoint: `${UPSTREAM}/chat/completions`,
  headers: () => ({ authorization: `Bearer ${KEY}` }),
  beforeRequest: async () => {},
  onAuthRejected: () => {},
})
setImageOps(nodeImageOps)

// ───── 访问密码 ─────

/**
 * 通行证：输对密码发一个，这次打开期间一直有效（10/16 起不再每 10 分钟重输；服务器最多留 30 天）。
 * 重新打开网页 / App 仍要输一次（网页和 App 都只把通行证放在内存里）。
 * 存盘（只存哈希）：服务器重启、更新后，开着的页面不用重输。
 */
const tokens = new Map<string, number>()
const PASSES_FILE = join(DATA_DIR, 'passes.json')
const attempts = new Map<string, number[]>()
const sha = (s: string) => createHash('sha256').update(s).digest()
const tokenKey = (t: string) => sha(t).toString('hex')
const passwordOk = (p: unknown) => typeof p === 'string' && timingSafeEqual(sha(p), sha(PASSWORD))
const cookieToken = (req: IncomingMessage) => /(?:^|;\s*)pl_pass=([0-9a-f]+)/.exec(req.headers.cookie ?? '')?.[1]

try {
  const saved = JSON.parse(await readFile(PASSES_FILE, 'utf8')) as Record<string, number>
  const now = Date.now()
  for (const [k, exp] of Object.entries(saved)) if (exp > now) tokens.set(k, exp)
} catch {
  // 第一次启动，或文件坏了：大家重输一次密码
}
let passesTimer: NodeJS.Timeout | null = null
const savePasses = () => {
  passesTimer ??= setTimeout(() => {
    passesTimer = null
    void mkdir(DATA_DIR, { recursive: true })
      .then(() => writeFile(PASSES_FILE, JSON.stringify(Object.fromEntries(tokens))))
      .catch((e) => console.warn('通行证存盘失败', e))
  }, 1000)
}

function authed(req: IncomingMessage): boolean {
  if (!PASSWORD) return true
  const t = (req.headers['x-porchlight-auth'] as string | undefined) ?? cookieToken(req)
  const k = t ? tokenKey(t) : null
  const exp = k ? tokens.get(k) : undefined
  if (!exp) return false
  if (Date.now() > exp) {
    tokens.delete(k!)
    savePasses()
    return false
  }
  return true
}
setInterval(() => {
  const now = Date.now()
  let changed = false
  for (const [k, exp] of tokens) if (now > exp) changed = tokens.delete(k)
  if (changed) savePasses()
}, 60_000).unref()

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}
const unauthorized = (res: ServerResponse) => json(res, 401, { error: { type: 'porchlight_auth', message: '需要输入访问密码' } })

const readBody = (req: IncomingMessage, limit = 40 * 1024 * 1024) =>
  new Promise<Buffer>((ok, fail) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        fail(new Error('请求太大'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => ok(Buffer.concat(chunks)))
    req.on('error', fail)
  })
const readJson = async (req: IncomingMessage) => JSON.parse((await readBody(req)).toString() || '{}')

const ip = (req: IncomingMessage) =>
  process.env.TRUST_PROXY === '1'
    ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || (req.socket.remoteAddress ?? '')
    : (req.socket.remoteAddress ?? '')

async function handleAuth(req: IncomingMessage, res: ServerResponse) {
  // GET /auth：要不要密码；带着通行证来问时顺便回答它还认不认（实时推送断了时网页靠这个判断要不要重输密码）
  if (req.method === 'GET') return json(res, 200, { required: !!PASSWORD, valid: authed(req) })
  if (req.method !== 'POST') return json(res, 405, { error: 'method' })
  const now = Date.now()
  const recent = (attempts.get(ip(req)) ?? []).filter((t) => now - t < 60_000)
  if (recent.length >= LOGIN_LIMIT) return json(res, 429, { error: '试得太多了，过一分钟再试' })
  recent.push(now)
  attempts.set(ip(req), recent)
  let password: unknown
  try {
    password = (await readJson(req)).password
  } catch {
    return json(res, 400, { error: '格式不对' })
  }
  if (!PASSWORD) return json(res, 200, { token: 'dev', expiresAt: now + TOKEN_TTL_MS })
  if (!passwordOk(password)) return json(res, 401, { error: '密码不对' })
  const token = randomBytes(32).toString('hex')
  const expiresAt = now + TOKEN_TTL_MS
  tokens.set(tokenKey(token), expiresAt)
  savePasses()
  const secure = process.env.TRUST_PROXY === '1' ? '; Secure' : ''
  return json(res, 200, { token, expiresAt }, { 'set-cookie': `pl_pass=${token}; Path=/; HttpOnly; SameSite=Lax${secure}` })
}

async function handleProxy(req: IncomingMessage, res: ServerResponse) {
  if (!authed(req)) return unauthorized(res)
  const path = req.url!.replace(/^\/ai-api/, '')
  try {
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req)
    const up = await fetch(UPSTREAM + path, {
      method: req.method,
      headers: { 'content-type': (req.headers['content-type'] as string) ?? 'application/json', authorization: `Bearer ${KEY}` },
      body: body ? new Uint8Array(body) : undefined,
    })
    res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' })
    res.end(Buffer.from(await up.arrayBuffer()))
  } catch (e) {
    json(res, 502, { error: { message: `连不上 AI 网关：${(e as Error).message}` } })
  }
}

const EUFY_API = 'https://openapi-us.eufylife.com'
/** 原样转发的请求头之外，这些不转：本服务自己的（Cookie 里有通行证）、连接相关的、浏览器来源 */
const EUFY_DROP = /^(host|cookie|connection|content-length|accept-encoding|origin|referer|x-porchlight-auth|x-forwarded-.*|sec-.*)$/i

async function handleEufyProxy(req: IncomingMessage, res: ServerResponse) {
  if (!authed(req)) return unauthorized(res)
  const path = req.url!.replace(/^\/openapi-api/, '')
  try {
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req, 1024 * 1024)
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !EUFY_DROP.test(k)) headers[k] = Array.isArray(v) ? v.join(', ') : v
    const up = await fetch(EUFY_API + path, { method: req.method, headers, body: body ? new Uint8Array(body) : undefined })
    if (up.status >= 400) console.warn('eufy 接口返回', up.status, path.split('?')[0])
    res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' })
    res.end(Buffer.from(await up.arrayBuffer()))
  } catch (e) {
    json(res, 502, { message: `连不上 eufy 接口：${(e as Error).message}` })
  }
}

// ───── 实时推送（SSE）和状态同步 ─────

interface Client {
  id: string
  res: ServerResponse
}
const clients = new Map<string, Client>()
/** 正在上传画面的采集端（一户同一时间一个） */
let captureClientId: string | null = null
const grabs = new Map<string, (s: Snapshot | null) => void>()

const send = (c: Client, msg: unknown) => c.res.write(`data: ${JSON.stringify(msg)}\n\n`)
const broadcast = (msg: unknown) => clients.forEach((c) => send(c, msg))

const store = new Store(DATA_DIR)
const engine = new HomiEngine(store, {
  onChange: () => scheduleFlush(),
  requestSnapshot,
})

/** 给界面的片段：截图只给地址（图片另外取），不带原图数据和灰度图 */
const snapOut = (s: Snapshot) => ({ t: s.t, url: s.url, width: s.width, height: s.height })
const segOut = (s: Segment) => ({ ...s, before: snapOut(s.before), middle: s.middle.map(snapOut), after: snapOut(s.after) })
const segList = () => [...engine.segments.values()].sort((a, b) => b.startedAt - a.startedAt)

function sharedState() {
  return {
    events: engine.events,
    liveEventIds: engine.liveEventIds,
    mergeQueue: engine.mergeQueue,
    consolidation: engine.consolidation,
    alerts: engine.alerts,
    alertLog: engine.alertLog,
    report: engine.report,
    lastTimerReportAt: engine.lastTimerReportAt,
    doneKeys: [...engine.doneKeys],
    homeCtx: engine.homeCtx,
    feedbackLog: engine.feedbackLog,
    storage: { loaded: true, usage: null, note: engine.note },
    live: engine.live,
    settings: engine.settings,
  }
}

function snapshotMsg() {
  return {
    type: 'snapshot',
    segments: segList().map(segOut),
    analyses: engine.analyses,
    keyFrames: engine.keyFrames,
    fallWatches: engine.fallWatches,
    state: sharedState(),
  }
}

/** 已经推过的（只推变了的） */
const sent = {
  segs: new Map<string, Segment>(),
  analyses: {} as Record<string, unknown>,
  keyFrames: {} as Record<string, unknown>,
  fallWatches: {} as Record<string, unknown>,
  shared: '',
}
let flushTimer: NodeJS.Timeout | null = null
let saveTimer: NodeJS.Timeout | null = null

function scheduleFlush() {
  if (!flushTimer) flushTimer = setTimeout(flush, 50)
  if (!saveTimer) {
    saveTimer = setTimeout(() => {
      saveTimer = null
      void store.saveState(engine.persistedState()).catch((e) => console.warn('保存失败', e))
    }, 1000)
  }
}

function flush() {
  flushTimer = null
  const list = segList()
  const d = diffById(sent.segs, list)
  if (d.set.length || d.del.length) {
    sent.segs = new Map(list.map((s) => [s.id, s]))
    broadcast({ type: 'segments', set: d.set.map(segOut), del: d.del, mergeQueue: engine.mergeQueue })
  }
  for (const key of ['analyses', 'keyFrames', 'fallWatches'] as const) {
    const next = engine[key] as Record<string, unknown>
    const rd = diffRecord(sent[key], next)
    sent[key] = next
    if (!isEmptyDiff(rd)) broadcast({ type: 'record', key, diff: rd })
  }
  const shared = sharedState()
  const s = JSON.stringify(shared)
  if (s !== sent.shared) {
    sent.shared = s
    broadcast({ type: 'shared', state: shared })
  }
}

function handleStream(req: IncomingMessage, res: ServerResponse) {
  if (!authed(req)) return unauthorized(res)
  const id = randomBytes(8).toString('hex')
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
  const c = { id, res }
  clients.set(id, c)
  send(c, { type: 'welcome', clientId: id })
  send(c, snapshotMsg())
  if (lastFrame && id !== captureClientId) send(c, { type: 'frame', jpeg: lastFrame })
  tellViewers()
  // 心跳用一条真消息（注释行网页收不到）：网页 45 秒没收到任何消息就自己重连
  const ping = setInterval(() => send(c, { type: 'ping' }), 15_000)
  req.on('close', () => {
    clearInterval(ping)
    clients.delete(id)
    if (captureClientId === id) {
      captureClientId = null
      engine.sourceChanged(null)
      relayFrame(null)
    }
    tellViewers()
  })
}

/**
 * 实时画面转给其他界面（沿用多标签页同步的主控 → 镜像：采集端约每秒发一张缩小的截图，云端转给其他所有界面）。
 * 只有采集端一路直播；没人看时采集端不发（云端告诉它现在有几个界面在看）。
 */
let lastFrame: string | null = null
/** extra：一起转的变化率采样、变化区域（调试台看过程用） */
function relayFrame(jpeg: string | null, extra: { samples?: unknown[]; mask?: string | null } = {}) {
  lastFrame = jpeg
  for (const c of clients.values()) if (c.id !== captureClientId) send(c, { type: 'frame', jpeg, ...extra })
}
function tellViewers() {
  const c = captureClientId ? clients.get(captureClientId) : undefined
  if (c) send(c, { type: 'viewers', count: clients.size - 1 })
}

/** 向采集端要一张当前画面（摔倒再看一眼、现在看一眼） */
function requestSnapshot(): Promise<Snapshot | null> {
  const c = captureClientId ? clients.get(captureClientId) : undefined
  if (!c) return Promise.resolve(null)
  const reqId = randomBytes(6).toString('hex')
  return new Promise((ok) => {
    const timer = setTimeout(() => {
      grabs.delete(reqId)
      ok(null)
    }, GRAB_TIMEOUT_MS)
    grabs.set(reqId, (s) => {
      clearTimeout(timer)
      grabs.delete(reqId)
      ok(s)
    })
    send(c, { type: 'grab', reqId })
  })
}

interface UploadSnap {
  t: number
  width: number
  height: number
  /** JPEG（base64） */
  jpeg: string
  /** 64×48 灰度图（base64） */
  gray: string
}

const SAFE_ID = /^[\w.-]{1,80}$/

async function toSnapshot(segId: string, index: number, u: UploadSnap): Promise<Snapshot> {
  const buf = Buffer.from(u.jpeg, 'base64')
  await store.saveImage(segId, index, buf)
  return { t: u.t, blob: new Blob([new Uint8Array(buf)], { type: 'image/jpeg' }), url: imageUrl(segId, index), width: u.width, height: u.height, gray: b64ToGray(u.gray) }
}

async function handleCapture(req: IncomingMessage, res: ServerResponse, path: string) {
  if (!authed(req)) return unauthorized(res)
  const body = await readJson(req)
  if (path === '/api/capture/segment') {
    // 只收当前采集端的片段：两个页面同时采集会让片段重复、分析排长队（10/16 线上出过）。
    // 云端重启后还不知道谁在采集：谁先传就认谁（采集端重新连上时也会再报一次到）
    const from = typeof body.clientId === 'string' ? body.clientId : null
    if (from && !captureClientId && clients.has(from)) {
      captureClientId = from
      engine.sourceChanged(typeof body.sourceName === 'string' ? body.sourceName : '摄像头')
      tellViewers()
    }
    if (!from || from !== captureClientId) {
      const c = from ? clients.get(from) : undefined
      if (c) send(c, { type: 'capture-stop', reason: '另一个页面在采集' })
      return json(res, 409, { error: '另一个页面在采集画面，这个页面的片段没收' })
    }
    if (typeof body.id !== 'string' || !SAFE_ID.test(body.id) || !Array.isArray(body.snaps) || body.snaps.length < 2) return json(res, 400, { error: '片段格式不对' })
    const snaps = await Promise.all((body.snaps as UploadSnap[]).map((s, i) => toSnapshot(body.id, i, s)))
    const seg: Segment = {
      id: body.id,
      startedAt: body.startedAt,
      endedAt: body.endedAt,
      endReason: body.endReason,
      measurements: body.measurements,
      ignoreZones: Array.isArray(body.ignoreZones) ? body.ignoreZones : engine.settings.zones,
      before: snaps[0],
      middle: snaps.slice(1, -1),
      after: snaps[snaps.length - 1],
    }
    engine.ingest(seg)
    return json(res, 200, { ok: true })
  }
  if (path === '/api/capture/frame') {
    // 只认当前采集端；图不存盘
    if (body.clientId !== captureClientId) return json(res, 409, { error: '不是当前采集端' })
    if (body.jpeg !== null && (typeof body.jpeg !== 'string' || body.jpeg.length > 400_000)) return json(res, 400, { error: '画面格式不对' })
    const samples = Array.isArray(body.samples) ? body.samples.slice(-50) : []
    const mask = typeof body.mask === 'string' && body.mask.length < 20_000 ? body.mask : null
    relayFrame(body.jpeg, { samples, mask })
    return json(res, 200, { ok: true })
  }
  if (path === '/api/capture/grab') {
    const done = grabs.get(body.reqId)
    if (!done) return json(res, 404, { error: '这张图已经不需要了' })
    done(body.snap ? await toSnapshot(`grab-${Date.now()}`, 0, body.snap as UploadSnap) : null)
    return json(res, 200, { ok: true })
  }
  return json(res, 404, { error: 'not found' })
}

/** 界面发来的操作 */
async function handleCmd(req: IncomingMessage, res: ServerResponse) {
  if (!authed(req)) return unauthorized(res)
  const { name, args = [], clientId } = await readJson(req)
  const a = args as unknown[]
  let value: unknown = null
  switch (name) {
    case 'hello': {
      const c = clients.get(clientId)
      if (c) send(c, snapshotMsg())
      break
    }
    case 'consolidate':
      void engine.consolidate('manual')
      break
    case 'generateReport':
      void engine.generateReport('manual')
      break
    case 'deleteAll':
      await engine.deleteAll()
      break
    case 'dismissAlert':
      engine.dismissAlert(a[0] as string)
      break
    case 'markFalseAlarm':
      engine.markFalseAlarm(a[0] as never)
      break
    case 'endPlan':
      engine.endPlan(a[0] as never)
      break
    case 'recordVote':
      engine.recordVote(a[0] as string, a[1] as never)
      break
    case 'saveDraft':
      value = engine.saveDraft(a[0] as string, a[1] as never, a[2] as string)
      break
    case 'markDone':
      engine.markDone(a[0] as string)
      break
    case 'setHomeCtx':
      engine.setHomeCtx(a[0] as never)
      break
    case 'applySetup':
      engine.applySetup(a[0] as never)
      break
    case 'runAnalysis':
      engine.rerun(a[0] as string)
      break
    case 'setConfig':
      engine.setSettings({ config: a[0] as never })
      break
    case 'setZones':
      engine.setSettings({ zones: a[0] as never })
      break
    case 'captureStart': {
      // 换了采集端：原来那个停下
      if (captureClientId && captureClientId !== clientId) {
        const old = clients.get(captureClientId)
        if (old) send(old, { type: 'capture-stop', reason: '另一个页面开了画面' })
      }
      captureClientId = clientId
      engine.sourceChanged(String(a[0] ?? '摄像头'))
      tellViewers()
      break
    }
    case 'captureStop':
      if (captureClientId === clientId) {
        captureClientId = null
        engine.sourceChanged(null)
        relayFrame(null)
      }
      break
    case 'stop': {
      const c = captureClientId ? clients.get(captureClientId) : undefined
      if (c) send(c, { type: 'capture-stop', reason: '在另一个页面点了停止' })
      break
    }
    case 'grabSnapshot': {
      const s = await requestSnapshot()
      value = s ? snapOut(s) : null
      break
    }
    default:
      return json(res, 400, { error: `不认识的操作：${name}` })
  }
  return json(res, 200, { value })
}

async function handleImage(req: IncomingMessage, res: ServerResponse, path: string) {
  if (!authed(req)) return unauthorized(res)
  const m = /^\/api\/images\/([\w.-]+)\/(\d+)\.jpg$/.exec(path)
  if (!m) return json(res, 404, { error: 'not found' })
  try {
    const data = await store.readImage(m[1], Number(m[2]))
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400' })
    res.end(data)
  } catch {
    json(res, 404, { error: '图片已经删掉了' })
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
}

async function handleStatic(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url!, 'http://x')
  let file = normalize(join(DIST, decodeURIComponent(url.pathname)))
  if (!file.startsWith(DIST)) return json(res, 403, { error: 'forbidden' })
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html')
  } catch {
    file = join(DIST, 'index.html')
  }
  try {
    const data = await readFile(file)
    const hashed = file.includes(join(DIST, 'assets'))
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      'permissions-policy': 'camera=(self), microphone=(self)',
    })
    res.end(data)
  } catch {
    json(res, 404, { error: 'not found' })
  }
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url!, 'http://x').pathname
  try {
    if (path.startsWith('/auth')) return await handleAuth(req, res)
    if (path.startsWith('/ai-api/')) return await handleProxy(req, res)
    if (path.startsWith('/openapi-api/')) return await handleEufyProxy(req, res)
    if (path === '/api/eufy-config') return authed(req) ? json(res, EUFY_CONFIG ? 200 : 404, EUFY_CONFIG ?? { error: '云端没有配置 eufy 参数' }) : unauthorized(res)
    if (path === '/healthz') return json(res, 200, { ok: true, clients: clients.size, capturing: !!captureClientId })
    if (path === '/api/stream') return handleStream(req, res)
    if (path === '/api/cmd' && req.method === 'POST') return await handleCmd(req, res)
    if (path.startsWith('/api/capture/') && req.method === 'POST') return await handleCapture(req, res, path)
    if (path.startsWith('/api/images/')) return await handleImage(req, res, path)
    if (path.startsWith('/api/')) return json(res, 404, { error: 'not found' })
    return await handleStatic(req, res)
  } catch (e) {
    console.warn('请求出错', path, e)
    if (!res.headersSent) json(res, 500, { error: { message: (e as Error).message } })
  }
})

await engine.load()
server.listen(PORT, HOST, () => console.log(`云端 Homi 已启动：http://${HOST}:${PORT}（数据 ${DATA_DIR}；eufy 参数${EUFY_CONFIG ? '已配置' : '未配置'}；${PASSWORD ? '要访问密码' : '本机开发，不要密码'}）`))
