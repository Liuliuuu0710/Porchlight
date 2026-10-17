/**
 * 第一层滤网的核心逻辑：纯函数 + 状态机，不依赖 DOM，便于单测。
 *
 * 第一层只做运动检测：画面变了就开始截图，不变了就停。产出叫“片段”，
 * 不判断场景；多个片段由第二层合并成事件。
 *
 * 输入：每次采样得到的小尺寸灰度图（默认 64×48）。
 * 输出：动作指令（开始片段 / 截中间帧 / 结束片段），由外层负责真正截图。
 */

export interface MotionConfig {
  /** 每秒采样次数 */
  sampleFps: number
  /** 单像素灰度差超过多少算“变了”（0–255） */
  pixelThreshold: number
  /** 变化像素占比超过多少算“有运动”（0–1，分母不含忽略区域） */
  areaThreshold: number
  /** 连续多少帧超阈值才确认运动（防抖） */
  debounceFrames: number
  /** 运动期间每隔多久截一张中间帧 */
  middleIntervalMs: number
  /** 中间帧上限（安全上限，正常情况下全部保留），超出则均匀抽取 */
  maxMiddleFrames: number
  /** 运动停止后需静止多久才截“变化后”、结束片段 */
  settleMs: number
  /** 单个片段最长时长，到时强制结束并立即开下一段 */
  maxSegmentMs: number
  /** 片段结束后的冷却时间；合并交给第二层后默认为 0 */
  cooldownMs: number
}

export const DEFAULT_CONFIG: MotionConfig = {
  sampleFps: 5,
  pixelThreshold: 25,
  areaThreshold: 0.02,
  debounceFrames: 3,
  middleIntervalMs: 1000,
  maxMiddleFrames: 15,
  settleMs: 2000,
  // 10/15 从 30 秒改为 15 秒：长时间持续活动里发生的事（如摔倒）最多约 15 秒就开始分析；切开的片段由第二层合并
  maxSegmentMs: 15000,
  cooldownMs: 0,
}

/** 矩形区域，坐标为 0–1 的比例 */
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** 把忽略区域（比例坐标）转成网格掩码：1 = 忽略 */
export function zonesToMask(zones: Box[], width: number, height: number): Uint8Array | null {
  if (zones.length === 0) return null
  const mask = new Uint8Array(width * height)
  for (const z of zones) {
    // 像素中心落在区域内即忽略
    const x0 = Math.max(0, Math.ceil(z.x * width - 0.5))
    const x1 = Math.min(width - 1, Math.floor((z.x + z.w) * width - 0.5))
    const y0 = Math.max(0, Math.ceil(z.y * height - 0.5))
    const y1 = Math.min(height - 1, Math.floor((z.y + z.h) * height - 0.5))
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) mask[y * width + x] = 1
  }
  return mask
}

export interface DiffResult {
  /** 变化像素占比（分母为未被忽略的像素数） */
  ratio: number
  mask: Uint8Array
  box: Box | null
}

/** 比较两张同尺寸灰度图，返回变化像素占比、变化掩码与外接框；ignore 中为 1 的像素不参与 */
export function diffGray(
  a: Uint8ClampedArray | Uint8Array,
  b: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  pixelThreshold: number,
  ignore: Uint8Array | null = null,
): DiffResult {
  const mask = new Uint8Array(width * height)
  let changed = 0
  let counted = 0
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (ignore?.[i]) continue
      counted++
      if (Math.abs(a[i] - b[i]) > pixelThreshold) {
        mask[i] = 1
        changed++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  const box =
    changed > 0
      ? {
          x: minX / width,
          y: minY / height,
          w: (maxX - minX + 1) / width,
          h: (maxY - minY + 1) / height,
        }
      : null
  return { ratio: counted ? changed / counted : 0, mask, box }
}

/** 从 n 个元素中均匀抽取 k 个的下标（保留首尾） */
export function evenlySample(n: number, k: number): number[] {
  if (n <= k) return Array.from({ length: n }, (_, i) => i)
  if (k <= 1) return [0]
  return Array.from({ length: k }, (_, i) => Math.round((i * (n - 1)) / (k - 1)))
}

export type MotionPhase = 'idle' | 'motion' | 'cooldown'

export type FinishReason = 'settled' | 'max-duration' | 'source-ended'

export type MotionAction =
  /** 运动确认：用稳定帧作为“变化前”，并截当前帧作为第一张中间帧 */
  | { type: 'start' }
  /** 运动中：截一张中间帧 */
  | { type: 'middle' }
  /** 片段结束：截当前帧作为“变化后” */
  | { type: 'finish'; reason: FinishReason }
  /** 画面静止：用当前帧刷新稳定帧缓存（作为下个片段的“变化前”） */
  | { type: 'stable' }

export interface StepResult {
  ratio: number
  mask: Uint8Array | null
  phase: MotionPhase
  actions: MotionAction[]
}

export class MotionStateMachine {
  config: MotionConfig
  phase: MotionPhase = 'idle'

  private prev: Uint8ClampedArray | Uint8Array | null = null
  private ignore: Uint8Array | null = null
  private overCount = 0
  private segmentStart = 0
  private lastMiddleAt = 0
  private quietSince: number | null = null
  private cooldownUntil = 0

  private readonly width: number
  private readonly height: number

  constructor(width: number, height: number, config: MotionConfig = DEFAULT_CONFIG) {
    this.width = width
    this.height = height
    this.config = { ...config }
  }

  /** 设置忽略区域掩码（1 = 忽略），null 表示不忽略 */
  setIgnoreMask(mask: Uint8Array | null) {
    this.ignore = mask
  }

  reset() {
    this.phase = 'idle'
    this.prev = null
    this.overCount = 0
    this.quietSince = null
  }

  /** 帧来源结束（如视频播完）时，若片段进行中则立即结束 */
  forceFinish(): MotionAction | null {
    if (this.phase !== 'motion') return null
    this.phase = 'idle'
    return { type: 'finish', reason: 'source-ended' }
  }

  step(gray: Uint8ClampedArray | Uint8Array, now: number): StepResult {
    const c = this.config
    const actions: MotionAction[] = []

    if (!this.prev) {
      this.prev = gray
      actions.push({ type: 'stable' })
      return { ratio: 0, mask: null, phase: this.phase, actions }
    }

    const { ratio, mask } = diffGray(this.prev, gray, this.width, this.height, c.pixelThreshold, this.ignore)
    this.prev = gray
    const moving = ratio >= c.areaThreshold

    if (this.phase === 'cooldown' && now >= this.cooldownUntil) {
      this.phase = 'idle'
      this.overCount = 0
    }

    switch (this.phase) {
      case 'idle':
        if (moving) {
          this.overCount++
          if (this.overCount >= c.debounceFrames) {
            this.beginSegment(now)
            actions.push({ type: 'start' })
          }
        } else {
          this.overCount = 0
          actions.push({ type: 'stable' })
        }
        break

      case 'motion':
        if (now - this.lastMiddleAt >= c.middleIntervalMs) {
          this.lastMiddleAt = now
          actions.push({ type: 'middle' })
        }
        if (moving) {
          this.quietSince = null
        } else {
          this.quietSince ??= now
        }
        if (this.quietSince !== null && now - this.quietSince >= c.settleMs) {
          actions.push({ type: 'finish', reason: 'settled' })
          if (c.cooldownMs > 0) {
            this.phase = 'cooldown'
            this.cooldownUntil = now + c.cooldownMs
          } else {
            this.phase = 'idle'
            this.overCount = 0
          }
        } else if (now - this.segmentStart >= c.maxSegmentMs) {
          // 持续运动：结束当前片段并立即开始新片段（新片段的“变化前”= 本片段的“变化后”）
          actions.push({ type: 'finish', reason: 'max-duration' })
          this.beginSegment(now)
          actions.push({ type: 'start' })
        }
        break

      case 'cooldown':
        if (!moving) actions.push({ type: 'stable' })
        break
    }

    return { ratio, mask, phase: this.phase, actions }
  }

  private beginSegment(now: number) {
    this.phase = 'motion'
    this.segmentStart = now
    this.lastMiddleAt = now
    this.quietSince = null
    this.overCount = 0
  }
}
