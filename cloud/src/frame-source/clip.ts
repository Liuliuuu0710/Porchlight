import type { Frame, FrameSource } from './types'
import type { Box } from '../motion/state-machine'
import { fixDuration } from './video-file'

/**
 * 开发用测试播放器：把一段短视频变成适合测试第一 / 二层的画面。
 * - crop：只取画面的一部分（UR 摔倒数据集是“深度图 + 彩色图”左右拼接，只取右半边）
 * - 开头先停在第一帧 leadMs，让第一层有“变化前”的静止画面
 * - ending = 'hold'：播完停在最后一帧 tailMs（模拟摔倒后起不来）
 * - ending = 'reverse'：播完在最后一帧停 pauseMs，再倒着播回去，最后停在第一帧（模拟摔倒后自己站起来）
 * 不用 video.play()，而是按真实时间逐帧跳转：页面在后台时 Chrome 会暂停无声视频，跳转不受影响。
 */
export interface ClipOptions {
  crop?: Box
  leadMs?: number
  ending?: 'hold' | 'reverse'
  pauseMs?: number
  tailMs?: number
}

type Phase = 'lead' | 'forward' | 'pause' | 'backward' | 'tail' | 'done'

const STEP_MS = 80

export class ClipSource implements FrameSource {
  readonly name: string
  private video = document.createElement('video')
  private canvas = document.createElement('canvas')
  private ctx = this.canvas.getContext('2d')!
  private timer: number | null = null
  private phase: Phase = 'lead'
  private phaseAt = 0
  private seeking = false
  private hasFrame = false
  private readonly opts: Required<Omit<ClipOptions, 'crop'>> & { crop: Box }

  constructor(url: string, label: string, opts: ClipOptions = {}) {
    this.name = `测试片段：${label}`
    this.video.src = url
    this.video.muted = true
    this.video.preload = 'auto'
    this.opts = {
      crop: opts.crop ?? { x: 0, y: 0, w: 1, h: 1 },
      leadMs: opts.leadMs ?? 3000,
      ending: opts.ending ?? 'hold',
      pauseMs: opts.pauseMs ?? 8000,
      tailMs: opts.tailMs ?? 45000,
    }
    this.canvas.className = 'clip-canvas'
    this.video.addEventListener('seeked', () => {
      this.seeking = false
      this.draw()
    })
  }

  get previewElement() {
    return this.canvas
  }

  get ended() {
    return this.phase === 'done'
  }

  /** 播放到哪一步了（评测时用来判断动作是否已经播完） */
  get stage(): Phase {
    return this.phase
  }

  async start() {
    await new Promise<void>((resolve, reject) => {
      if (this.video.readyState >= HTMLMediaElement.HAVE_METADATA) return resolve()
      this.video.addEventListener('loadedmetadata', () => resolve(), { once: true })
      this.video.addEventListener('error', () => reject(new Error('测试视频加载失败')), { once: true })
    })
    // 浏览器自己录的 .webm 没有时长，按时间跳转前要先算出来
    await fixDuration(this.video)
    const { crop } = this.opts
    this.canvas.width = Math.round(this.video.videoWidth * crop.w)
    this.canvas.height = Math.round(this.video.videoHeight * crop.h)
    this.setPhase('lead')
    this.seek(0)
    this.timer = window.setInterval(() => this.tick(), STEP_MS)
  }

  stop() {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
    this.phase = 'done'
    this.video.removeAttribute('src')
    this.video.load()
  }

  now() {
    return Date.now()
  }

  getFrame(): Frame | null {
    if (!this.hasFrame) return null
    return { image: this.canvas, width: this.canvas.width, height: this.canvas.height }
  }

  private setPhase(p: Phase) {
    this.phase = p
    this.phaseAt = Date.now()
  }

  private seek(t: number) {
    this.seeking = true
    this.video.currentTime = Math.max(0, Math.min(t, this.video.duration - 0.05))
  }

  private draw() {
    const { crop } = this.opts
    const v = this.video
    this.ctx.drawImage(
      v,
      v.videoWidth * crop.x,
      v.videoHeight * crop.y,
      v.videoWidth * crop.w,
      v.videoHeight * crop.h,
      0,
      0,
      this.canvas.width,
      this.canvas.height,
    )
    this.hasFrame = true
  }

  private tick() {
    const o = this.opts
    const dur = this.video.duration
    const elapsed = Date.now() - this.phaseAt
    switch (this.phase) {
      case 'lead':
        if (elapsed >= o.leadMs) this.setPhase('forward')
        break
      case 'forward':
        if (elapsed / 1000 >= dur) {
          this.seek(dur)
          this.setPhase(o.ending === 'reverse' ? 'pause' : 'tail')
        } else if (!this.seeking) this.seek(elapsed / 1000)
        break
      case 'pause':
        if (elapsed >= o.pauseMs) this.setPhase('backward')
        break
      case 'backward':
        if (elapsed / 1000 >= dur) {
          this.seek(0)
          this.setPhase('tail')
        } else if (!this.seeking) this.seek(dur - elapsed / 1000)
        break
      case 'tail':
        if (elapsed >= o.tailMs) this.phase = 'done'
        break
    }
  }
}
