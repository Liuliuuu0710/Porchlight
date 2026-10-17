/**
 * 官方 AI 网关（OpenAI 协议）。
 * 请求发到同源 /ai-api，由 vite 代理转发并注入 Key（见 vite.config.ts）。
 */

import { authHeaders, authRejected, whenAuthed } from '../core/auth'

/**
 * 调用方式可配置：浏览器默认走同源 /ai-api（服务器带上 Key、要访问密码）；
 * 云端服务启动时 configureGateway 改成直接调主办方网关（Key 在服务器环境变量里，不用访问密码）。
 */
interface GatewayConfig {
  endpoint: string
  headers: () => Record<string, string>
  beforeRequest: () => Promise<void>
  onAuthRejected: () => void
}
let config: GatewayConfig = {
  endpoint: '/ai-api/chat/completions',
  headers: authHeaders,
  beforeRequest: whenAuthed,
  onAuthRejected: authRejected,
}
export function configureGateway(c: Partial<GatewayConfig>) {
  config = { ...config, ...c }
}

/** 部署的服务器说访问密码的通行证过期了（不是网关的 Key 问题） */
class AuthExpired extends Error {}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  /** 音频（OpenAI 协议）：data 是 base64，不带 data: 前缀 */
  | { type: 'input_audio'; input_audio: { data: string; format: 'wav' | 'mp3' } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

export interface ChatResult {
  text: string
  /** 网关返回的实际模型名 */
  model: string
  latencyMs: number
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export interface Attempt {
  model: string
  extra?: Record<string, unknown>
}

/**
 * 网关偶尔会卡住约 60 秒（实测）。先发第一个模型，若 hedgeAfterMs 内没有返回，
 * 再并行发下一个，取先成功的结果并取消其余请求；某个请求失败也会立即启动下一个。
 */
export function chatHedged(
  attempts: Attempt[],
  messages: ChatMessage[],
  opts: { maxTokens?: number; hedgeAfterMs?: number; timeoutMs?: number } = {},
): Promise<ChatResult> {
  const { hedgeAfterMs = 8000, ...rest } = opts
  return new Promise((resolve, reject) => {
    const ctrls: AbortController[] = []
    const errors: string[] = []
    let next = 0
    let running = 0
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const launch = () => {
      if (done || next >= attempts.length) return
      const a = attempts[next++]
      const ctrl = new AbortController()
      ctrls.push(ctrl)
      running++
      globalThis.clearTimeout(timer)
      if (next < attempts.length) timer = globalThis.setTimeout(launch, hedgeAfterMs)
      chat(a.model, messages, { ...rest, extra: a.extra, signal: ctrl.signal })
        .then((res) => {
          if (done) return
          done = true
          globalThis.clearTimeout(timer)
          ctrls.forEach((c) => c !== ctrl && c.abort(new GatewayError('已被更快的请求取代')))
          resolve(res)
        })
        .catch((e: Error) => {
          running--
          if (done) return
          errors.push(`${a.model.split('/').pop()}：${e.message}`)
          if (next < attempts.length) launch()
          else if (running === 0) {
            done = true
            reject(new GatewayError(errors.join('；')))
          }
        })
    }
    launch()
  })
}

export async function chat(
  model: string,
  messages: ChatMessage[],
  opts: {
    maxTokens?: number
    temperature?: number
    timeoutMs?: number
    signal?: AbortSignal
    /** 透传给网关的额外参数，如 { reasoning_effort: 'low' } */
    extra?: Record<string, unknown>
  } = {},
): Promise<ChatResult> {
  // 部署后需要访问密码：先等用户输完（等待不算进超时）；通行证中途过期就再等一次、重发
  for (let attempt = 0; ; attempt++) {
    await config.beforeRequest()
    try {
      return await chatOnce(model, messages, opts)
    } catch (e) {
      if (e instanceof AuthExpired && attempt < 2) continue
      if (e instanceof AuthExpired) throw new GatewayError('需要输入访问密码', 401)
      throw e
    }
  }
}

async function chatOnce(
  model: string,
  messages: ChatMessage[],
  opts: Parameters<typeof chat>[2] = {},
): Promise<ChatResult> {
  const { maxTokens = 1024, temperature = 0.2, timeoutMs = 60000, extra } = opts
  const ctrl = new AbortController()
  const timer = globalThis.setTimeout(() => ctrl.abort(new GatewayError(`请求超时（${timeoutMs / 1000} 秒）`)), timeoutMs)
  opts.signal?.addEventListener('abort', () => ctrl.abort(opts.signal!.reason))
  const t0 = performance.now()

  try {
    let res: Response
    try {
      res = await fetch(config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...config.headers() },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, ...extra }),
        signal: ctrl.signal,
      })
    } catch (e) {
      if (ctrl.signal.aborted) throw ctrl.signal.reason instanceof Error ? ctrl.signal.reason : new GatewayError('请求已取消')
      throw new GatewayError(`网络错误：${(e as Error).message}`)
    }

    const body = await res.text()
    if (res.status === 401 && body.includes('porchlight_auth')) {
      config.onAuthRejected()
      throw new AuthExpired()
    }
    if (!res.ok) {
      let msg = body.slice(0, 300)
      try {
        msg = JSON.parse(body).error?.message ?? msg
      } catch {
        /* 非 JSON 错误体，原样显示 */
      }
      if (res.status === 401) msg = `Key 无效或缺失（${msg}）。检查 dev/.env 后重启 npm run dev`
      throw new GatewayError(`HTTP ${res.status}：${msg}`, res.status)
    }

    const data = JSON.parse(body)
    const choice = data.choices?.[0]
    const text: string | undefined = choice?.message?.content
    if (!text) {
      // 推理模型（如 Qwen-Max）的思考过程也计入 max_tokens，额度用完时正文为空
      throw new GatewayError(
        choice?.finish_reason === 'length'
          ? `输出额度用完（max_tokens=${maxTokens}），模型还没给出正文；推理模型需要更大的额度`
          : '模型没有返回内容',
      )
    }
    return { text, model: data.model ?? model, latencyMs: Math.round(performance.now() - t0), usage: data.usage }
  } finally {
    globalThis.clearTimeout(timer)
  }
}
