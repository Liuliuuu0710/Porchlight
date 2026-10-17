import type { Frame, FrameSource } from './types'

/**
 * 开发用：把一串 JPEG 当成视频播放（如 CAVIAR 数据集，原视频是 MPEG-2，浏览器放不了）。
 * 开头停在第一帧 leadMs，结尾停在最后一帧 tailMs；按真实时间取帧，页面在后台也照常走。
 */
export interface ImageSequenceOptions {
  /** 第 i 帧的地址 */
  url: (i: number) => string
  count: number
  fps: number
  leadMs?: number
  tailMs?: number
}

const STEP_MS = 40
/** 往前预读几帧，减少等图 */
const PRELOAD = 8

export class ImageSequenceSource implements FrameSource {
  readonly name: string
  private canvas = document.createElement('canvas')
  private ctx = this.canvas.getContext('2d')!
  private timer: number | null = null
  private startedAt = 0
  private shown = -1
  private loading = new Map<number, HTMLImageElement>()
  private hasFrame = false
  private done = false
  private readonly opts: Required<ImageSequenceOptions>

  constructor(label: string, opts: ImageSequenceOptions) {
    this.name = `测试片段：${label}`
    this.opts = { leadMs: 3000, tailMs: 6000, ...opts }
    this.canvas.className = 'clip-canvas'
  }

  get previewElement() {
    return this.canvas
  }

  get ended() {
    return this.done
  }

  /** 和 ClipSource 一样给评测页判断是否播完 */
  get stage(): 'done' | 'playing' {
    return this.done ? 'done' : 'playing'
  }

  async start() {
    const first = await this.load(0)
    this.canvas.width = first.naturalWidth
    this.canvas.height = first.naturalHeight
    this.paint(0, first)
    this.startedAt = Date.now()
    this.timer = window.setInterval(() => this.tick(), STEP_MS)
  }

  stop() {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
    this.done = true
    this.loading.clear()
  }

  now() {
    return Date.now()
  }

  getFrame(): Frame | null {
    if (!this.hasFrame) return null
    return { image: this.canvas, width: this.canvas.width, height: this.canvas.height }
  }

  private load(i: number): Promise<HTMLImageElement> {
    let img = this.loading.get(i)
    if (!img) {
      img = new Image()
      img.src = this.opts.url(i)
      this.loading.set(i, img)
    }
    const el = img
    return el.complete && el.naturalWidth
      ? Promise.resolve(el)
      : new Promise((resolve, reject) => {
          el.addEventListener('load', () => resolve(el), { once: true })
          el.addEventListener('error', () => reject(new Error(`测试图片加载失败：${el.src}`)), { once: true })
        })
  }

  private paint(i: number, img: HTMLImageElement) {
    this.ctx.drawImage(img, 0, 0, this.canvas.width, this.canvas.height)
    this.shown = i
    this.hasFrame = true
  }

  private tick() {
    const { count, fps, leadMs, tailMs } = this.opts
    const t = Date.now() - this.startedAt - leadMs
    if (t < 0) return
    const target = Math.min(count - 1, Math.floor((t / 1000) * fps))
    if (target === count - 1 && t / 1000 - (count - 1) / fps > tailMs / 1000) {
      this.done = true
      return
    }
    for (let k = target + 1; k <= Math.min(count - 1, target + PRELOAD); k++) void this.load(k).catch(() => {})
    if (target === this.shown) return
    const img = this.loading.get(target)
    if (img?.complete && img.naturalWidth) {
      this.paint(target, img)
      // 已经画过的帧不再需要
      for (const k of this.loading.keys()) if (k < target) this.loading.delete(k)
    } else void this.load(target).catch(() => {})
  }
}
