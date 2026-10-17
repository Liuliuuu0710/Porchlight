/**
 * 第一层滤网（浏览器端）：定时从帧来源采样，交给状态机判断，
 * 按状态机指令截图，产出“片段”：变化前 + 中间帧 + 变化后 + 测量值。
 * 只做运动检测，不判断场景；片段合并成事件是第二层的事。
 */
import type { Frame, FrameSource } from '../frame-source/types'
import {
  DEFAULT_CONFIG,
  MotionStateMachine,
  diffGray,
  evenlySample,
  zonesToMask,
  type Box,
  type FinishReason,
  type MotionConfig,
  type MotionPhase,
} from './state-machine'

export const GRID_W = 64
export const GRID_H = 48
/** 截图最大宽度（送模型前可再缩小） */
const SNAPSHOT_MAX_WIDTH = 1024
/**
 * “变化前”取片段开始前多久的静止帧。
 * 物体缓慢进入画面时，最初几帧变化低于阈值仍被当作“静止”，
 * 若直接用最后一张静止帧，变化前就已经带上了物体的一角。
 */
const PRE_ROLL_MS = 1500
/** 静止帧缓存：每 250ms 存一张，共 10 张（覆盖 2.5 秒） */
const STABLE_INTERVAL_MS = 250
const STABLE_RING_SIZE = 10

export interface Snapshot {
  t: number
  blob: Blob
  url: string
  width: number
  height: number
  /** 同一时刻的 64×48 灰度图，用于计算测量值（第二层挑图也可用） */
  gray: Uint8ClampedArray
}

/** 片段的测量值：只是数字，不是判断 */
export interface Measurements {
  /** 变化前 vs 变化后的像素差异占比（不含忽略区域） */
  netChange: number
  /** 变化前 vs 变化后的差异区域（0–1 比例坐标） */
  changeBox: Box | null
  /** 片段期间帧间变化的峰值 */
  peakRatio: number
}

export interface Segment {
  id: string
  startedAt: number
  endedAt: number
  endReason: FinishReason
  before: Snapshot
  /** 每秒 1 张，全部保留（超过安全上限才均匀抽取） */
  middle: Snapshot[]
  after: Snapshot
  measurements: Measurements
  /** 截取时的忽略区域：给用户看的图是完整的，送模型前据此裁掉或填灰 */
  ignoreZones: Box[]
  /**
   * 只剩关键图（从本机存储读回来的，或内存里为省空间丢掉了其余截图）：
   * 序列里没保存的位置用相邻的关键图补位，界面上不显示“全部 N 张”
   */
  keyFramesOnly?: boolean
}

export interface Sample {
  t: number
  ratio: number
  phase: MotionPhase
}

interface Pending {
  startedAt: number
  before: Promise<Snapshot>
  middle: Promise<Snapshot>[]
  peakRatio: number
}

interface StableFrame {
  canvas: HTMLCanvasElement
  gray: Uint8ClampedArray
  t: number
}

export interface DetectorCallbacks {
  onSample?: (s: Sample, mask: Uint8Array | null) => void
  onSegment?: (s: Segment) => void
}

export class MotionDetector {
  private sm = new MotionStateMachine(GRID_W, GRID_H, DEFAULT_CONFIG)
  private source: FrameSource | null = null
  private timer: number | null = null

  private grid = createCanvas(GRID_W, GRID_H)
  private gridCtx = this.grid.getContext('2d', { willReadFrequently: true })!

  /** 最近一段时间的静止帧，片段开始时从中挑选“变化前” */
  private stableRing: StableFrame[] = []

  private ignoreZones: Box[] = []
  private ignoreMask: Uint8Array | null = null

  private pending: Pending | null = null
  private lastNow = 0
  private seq = 0

  constructor(private callbacks: DetectorCallbacks = {}) {}

  get config(): MotionConfig {
    return this.sm.config
  }

  setConfig(patch: Partial<MotionConfig>) {
    const fpsChanged = patch.sampleFps !== undefined && patch.sampleFps !== this.sm.config.sampleFps
    this.sm.config = { ...this.sm.config, ...patch }
    if (fpsChanged && this.timer !== null) this.restartTimer()
  }

  setIgnoreZones(zones: Box[]) {
    this.ignoreZones = zones.map((z) => ({ ...z }))
    this.ignoreMask = zonesToMask(zones, GRID_W, GRID_H)
    this.sm.setIgnoreMask(this.ignoreMask)
  }

  start(source: FrameSource) {
    this.stop()
    this.source = source
    this.resetState()
    this.restartTimer()
  }

  stop() {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
    this.pending = null
  }

  private resetState() {
    this.sm.reset()
    this.stableRing = []
    this.pending = null
    this.lastNow = 0
  }

  /**
   * 不管画面有没有变化，立刻截一张当前画面（供第二层“再看一眼”）。
   * 帧来源未开启或还没出画面时返回 null。
   */
  grabSnapshot(): Promise<Snapshot> | null {
    const frame = this.source?.getFrame()
    if (!this.source || !frame) return null
    return capture(frame, this.toGray(frame), this.source.now())
  }

  private restartTimer() {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = window.setInterval(() => this.tick(), 1000 / this.sm.config.sampleFps)
  }

  private tick() {
    const source = this.source
    const frame = source?.getFrame()
    if (!source || !frame) return
    const now = source.now()

    // 视频往回拖：时间倒流，丢弃进行中的片段，重新开始
    if (now < this.lastNow) this.resetState()
    this.lastNow = now

    if (source.ended) {
      const a = this.sm.forceFinish()
      if (a && a.type === 'finish' && this.pending) this.finish(frame, this.toGray(frame), now, a.reason)
      return
    }

    const gray = this.toGray(frame)
    const { ratio, mask, phase, actions } = this.sm.step(gray, now)

    let justFinishedAfter: Promise<Snapshot> | null = null
    for (const a of actions) {
      switch (a.type) {
        case 'stable':
          this.saveStable(frame, gray, now)
          break
        case 'start': {
          const stable = this.pickBefore(now)
          const before =
            justFinishedAfter ?? (stable ? encode(stable.canvas, stable.gray, stable.t) : capture(frame, gray, now))
          this.pending = { startedAt: now, before, middle: [capture(frame, gray, now)], peakRatio: ratio }
          break
        }
        case 'middle':
          this.pending?.middle.push(capture(frame, gray, now))
          break
        case 'finish':
          if (this.pending) justFinishedAfter = this.finish(frame, gray, now, a.reason)
          break
      }
    }
    if (this.pending) this.pending.peakRatio = Math.max(this.pending.peakRatio, ratio)

    this.callbacks.onSample?.({ t: now, ratio, phase }, mask)
  }

  /** 结束进行中的片段，返回“变化后”截图（可作为紧接着的下个片段的“变化前”） */
  private finish(frame: Frame, gray: Uint8ClampedArray, now: number, reason: FinishReason) {
    const p = this.pending!
    this.pending = null
    const after = capture(frame, gray, now)
    void this.finalize(p, after, now, reason)
    // “变化后”就是新的静止画面：清空旧的静止帧，避免下个片段拿到本片段之前的画面当“变化前”
    this.stableRing = []
    this.saveStable(frame, gray, now)
    return after
  }

  private async finalize(p: Pending, afterP: Promise<Snapshot>, endedAt: number, endReason: FinishReason) {
    const [before, after, ...allMiddle] = await Promise.all([p.before, afterP, ...p.middle])
    const keep = new Set(evenlySample(allMiddle.length, this.sm.config.maxMiddleFrames))
    const middle = allMiddle.filter((s, i) => {
      if (keep.has(i)) return true
      URL.revokeObjectURL(s.url)
      return false
    })
    const net = diffGray(before.gray, after.gray, GRID_W, GRID_H, this.sm.config.pixelThreshold, this.ignoreMask)
    this.callbacks.onSegment?.({
      id: `seg-${Date.now()}-${++this.seq}`,
      startedAt: p.startedAt,
      endedAt,
      endReason,
      before,
      middle,
      after,
      measurements: { netChange: net.ratio, changeBox: net.box, peakRatio: p.peakRatio },
      ignoreZones: this.ignoreZones,
    })
  }

  private toGray(frame: Frame): Uint8ClampedArray {
    this.gridCtx.drawImage(frame.image, 0, 0, GRID_W, GRID_H)
    const { data } = this.gridCtx.getImageData(0, 0, GRID_W, GRID_H)
    const gray = new Uint8ClampedArray(GRID_W * GRID_H)
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
      gray[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8
    }
    return gray
  }

  private saveStable(frame: Frame, gray: Uint8ClampedArray, t: number) {
    const ring = this.stableRing
    const last = ring.at(-1)
    if (last && t - last.t < STABLE_INTERVAL_MS) return
    const { w, h } = fitWidth(frame)
    // 复用被挤出的画布，避免频繁创建
    let canvas = ring.length >= STABLE_RING_SIZE ? ring.shift()!.canvas : createCanvas(w, h)
    if (canvas.width !== w || canvas.height !== h) canvas = createCanvas(w, h)
    canvas.getContext('2d')!.drawImage(frame.image, 0, 0, w, h)
    ring.push({ canvas, gray, t })
  }

  /** 取片段开始前 PRE_ROLL_MS 或更早的最新静止帧；缓存不够久就取最早的一张 */
  private pickBefore(now: number) {
    const ring = this.stableRing
    for (let i = ring.length - 1; i >= 0; i--) {
      if (ring[i].t <= now - PRE_ROLL_MS) return ring[i]
    }
    return ring[0] ?? null
  }
}

function createCanvas(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

function fitWidth(frame: Frame) {
  const scale = Math.min(1, SNAPSHOT_MAX_WIDTH / frame.width)
  return { w: Math.round(frame.width * scale), h: Math.round(frame.height * scale) }
}

function capture(frame: Frame, gray: Uint8ClampedArray, t: number): Promise<Snapshot> {
  const { w, h } = fitWidth(frame)
  const c = createCanvas(w, h)
  c.getContext('2d')!.drawImage(frame.image, 0, 0, w, h)
  return encode(c, gray, t)
}

/** toBlob 在调用时同步复制画布内容，之后画布被改写也不影响结果 */
function encode(canvas: HTMLCanvasElement, gray: Uint8ClampedArray, t: number): Promise<Snapshot> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error('截图编码失败'))
        resolve({ t, blob, url: URL.createObjectURL(blob), width: canvas.width, height: canvas.height, gray })
      },
      'image/jpeg',
      0.85,
    )
  })
}
