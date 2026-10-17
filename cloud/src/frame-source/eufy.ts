import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Frame, FrameSource } from './types'
import { loadSdk, type WebSDK } from '../eufy/sdk'
import { connectEufy } from '../eufy/connect'
import { missingFields, type EufyConfig } from '../eufy/config'

/** 取帧间隔：和第一层每秒看 5 帧一致；第一层每次只取最新一帧 */
const FRAME_INTERVAL_MS = 200
/** 开流后多久还没出第一帧算连不上 */
const FIRST_FRAME_TIMEOUT_MS = 45_000
/** 已经在出画面时，多久没有新帧就当断流、自动重连 */
const STALL_MS = 8_000
/** 重连等待：先等 SDK 销毁旧连接（示例里约 100 ms，留余量），失败多次后逐步拉长 */
const RECONNECT_DELAYS_MS = [300, 2_000, 5_000, 10_000]

/** 画面里的转圈 + 一句话（连接中 / 重连中） */
const busy = (text: string) =>
  createElement('div', { className: 'eufy-live__msg' }, createElement('span', { className: 'eufy-spinner', 'aria-hidden': true }), text)

/**
 * eufy 摄像头帧来源（T8171 云台摄像头 / T8214 门铃）。
 * 照赛事方示例：Provider + DeviceLiveLayout 开流并显示实时画面；subscribeMediaChannelFrames 每 0.2 秒拿一帧解码后的图片，
 * 第一层来取时给最新一帧。电池设备连续直播一段时间会被设备端挂断（示例里说明是正常现象）→ 自动重连，
 * 重连期间 getFrame 返回 null，第一层暂停，不会把黑屏当成变化。
 */
export class EufySource implements FrameSource {
  readonly name = 'eufy 摄像头'
  readonly ended = false
  private host: HTMLDivElement
  private root: Root | null = null
  private sdk: WebSDK | null = null
  private integration: unknown = null
  private latest: { bitmap: ImageBitmap; width: number; height: number } | null = null
  private lastFrameAt = 0
  private seq = 0
  private unsubscribe: (() => void) | null = null
  private retryTimer: number | null = null
  /** 重连后等画面的计时 */
  private checkTimer: number | null = null
  private watchdog: number | null = null
  private mountKey = 0
  private stopped = false
  private state: 'connecting' | 'live' | 'reconnecting' = 'connecting'
  private failures = 0
  /** 第一次出画面（start 等它） */
  private firstFrame: { ok: () => void; fail: (e: Error) => void } | null = null

  constructor(private config: EufyConfig) {
    this.host = document.createElement('div')
    this.host.className = 'eufy-live'
  }

  get previewElement() {
    return this.host
  }

  /** 'muted' = 正在重连（不推提醒，画面里转圈显示“重连中”） */
  get health(): 'ok' | 'ended' | 'muted' {
    if (this.stopped) return 'ended'
    return this.state === 'live' ? 'ok' : 'muted'
  }

  async start() {
    const miss = missingFields(this.config)
    if (miss.length) throw new Error(`eufy 设置还缺：${miss.join('、')}`)
    this.sdk = await loadSdk()
    this.integration = await connectEufy(this.sdk, this.config)
    if (this.stopped) return
    this.root = createRoot(this.host)
    const first = new Promise<void>((ok, fail) => (this.firstFrame = { ok, fail }))
    const timer = window.setTimeout(
      () =>
        this.firstFrame?.fail(
          new Error('eufy 摄像头一直没出画面：确认设备在线（可先在 eufy App 里打开一次直播）、设备 SN 正确，浏览器已在 chrome://flags 关掉 WebRTC PQC for DTLS'),
        ),
      FIRST_FRAME_TIMEOUT_MS,
    )
    this.mount()
    try {
      await first
    } finally {
      window.clearTimeout(timer)
      this.firstFrame = null
    }
    this.watchdog = window.setInterval(() => {
      if (this.state === 'live' && Date.now() - this.lastFrameAt > STALL_MS) this.reconnect('画面停了')
    }, 1000)
  }

  stop() {
    this.stopped = true
    this.firstFrame?.fail(new Error('已停止'))
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer)
    if (this.checkTimer !== null) window.clearTimeout(this.checkTimer)
    if (this.watchdog !== null) window.clearInterval(this.watchdog)
    this.root?.unmount()
    this.root = null
    this.latest?.bitmap.close()
    this.latest = null
  }

  now() {
    return Date.now()
  }

  getFrame(): Frame | null {
    if (this.state !== 'live' || !this.latest) return null
    return { image: this.latest.bitmap, width: this.latest.width, height: this.latest.height }
  }

  /** 挂上播放组件，然后反复尝试订阅帧（流还没建立时订阅会报错，示例里也是这样轮询） */
  private mount() {
    const { Provider, DeviceLiveLayout } = this.sdk!
    const sn = this.config.stationSn.trim()
    this.mountKey += 1
    this.root!.render(
      createElement(Provider, {
        key: this.mountKey,
        config: { stationSn: sn, integration: this.integration },
        loadingComponent: busy('正在连接 eufy 摄像头…'),
        children: createElement(DeviceLiveLayout, { deviceSn: sn, onError: (err: string) => this.reconnect(`直播中断：${err}`) }),
      }),
    )
    this.trySubscribe()
  }

  private trySubscribe() {
    if (this.stopped) return
    try {
      this.unsubscribe = this.sdk!.subscribeMediaChannelFrames(this.config.stationSn.trim(), (f) => void this.onFrame(f.blob, f.width, f.height), {
        intervalMs: FRAME_INTERVAL_MS,
        mimeType: 'image/jpeg',
        quality: 0.9,
        onError: (e) => console.warn('eufy 帧处理出错', e),
      })
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      if (/仅支持 MediaChannel|不支持 MediaStreamTrackProcessor|无法获取设备/.test(msg)) {
        this.firstFrame?.fail(new Error(`这台设备或浏览器取不了画面：${msg}（请用 Chrome，设备用 T8171 / T8214）`))
        return
      }
      // 流还没建立（如 Transport not found）：稍后再试
      this.retryTimer = window.setTimeout(() => this.trySubscribe(), 500)
    }
  }

  private async onFrame(blob: Blob, width: number, height: number) {
    const n = ++this.seq
    let bitmap: ImageBitmap
    try {
      bitmap = await createImageBitmap(blob)
    } catch {
      return
    }
    // 解码可能乱序完成：只留最新的；第一层画图是同步的，换掉旧帧时可以直接释放
    if (this.stopped || n < this.seq) return bitmap.close()
    this.latest?.bitmap.close()
    this.latest = { bitmap, width: width || bitmap.width, height: height || bitmap.height }
    this.lastFrameAt = Date.now()
    if (this.state !== 'live') {
      if (this.state === 'reconnecting') console.info('eufy 摄像头已重连')
      this.state = 'live'
      this.failures = 0
    }
    this.firstFrame?.ok()
  }

  private reconnect(reason: string) {
    if (this.stopped || this.state === 'reconnecting' || !this.root) return
    // 还没出过画面时出错：交给 start 的超时去报错，不在这里反复重连
    if (this.state === 'connecting') return console.warn('eufy 开流出错', reason)
    console.warn('eufy 摄像头断开，自动重连：', reason)
    this.state = 'reconnecting'
    this.unsubscribe?.()
    this.unsubscribe = null
    this.latest?.bitmap.close()
    this.latest = null
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer)
    if (this.checkTimer !== null) window.clearTimeout(this.checkTimer)
    // 先卸掉播放组件，等 SDK 销毁旧连接，再挂新的（示例的做法）
    this.root.render(busy('eufy 摄像头重连中…'))
    const delay = RECONNECT_DELAYS_MS[Math.min(this.failures, RECONNECT_DELAYS_MS.length - 1)]
    this.failures += 1
    this.retryTimer = window.setTimeout(() => {
      if (this.stopped) return
      this.mount()
      // 这次也没出画面：再来一次
      this.checkTimer = window.setTimeout(() => {
        if (this.state === 'reconnecting') {
          this.state = 'live'
          this.reconnect('重连后仍没有画面')
        }
      }, FIRST_FRAME_TIMEOUT_MS)
    }, delay)
  }
}
