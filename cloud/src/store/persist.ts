/**
 * 片段 ↔ 本机存储。只存关键图（没被选中的中间帧不存，数据最小化），读回来时还原成完整序列。
 * 事件、日报、计划与记忆本身就是可序列化的普通对象，直接存。
 */
import type { Segment, Snapshot } from '../motion/detector'
import type { Judgment } from '../ai/judge'
import type { KeyFrameResult } from '../ai/keyframes'
import type { Analysis } from '../ai/pipeline'
import { sparseSequence } from './retention'

interface StoredFrame {
  index: number
  t: number
  blob: Blob
  width: number
  height: number
  gray: Uint8ClampedArray
}

export interface StoredSegment {
  id: string
  startedAt: number
  endedAt: number
  endReason: Segment['endReason']
  measurements: Segment['measurements']
  ignoreZones: Segment['ignoreZones']
  /** 原来有几张中间帧（还原序列长度用） */
  middleCount: number
  frames: StoredFrame[]
  /** 最终判断；分析失败为 null */
  judgment: Judgment | null
  keyFrames: KeyFrameResult | null
}

const seqOf = (s: Segment) => [s.before, ...s.middle, s.after]

/** 要保存的图：关键图；没有关键图（分析失败）时存变化前、变化后 */
function keptIndices(seg: Segment, kf: KeyFrameResult | null): number[] {
  const last = seg.middle.length + 1
  const idx = kf && kf.frames.length ? kf.frames.map((k) => k.index) : [0, last]
  return [...new Set(idx)].filter((i) => i >= 0 && i <= last).sort((a, b) => a - b)
}

export function toStored(seg: Segment, judgment: Judgment | null, kf: KeyFrameResult | null): StoredSegment {
  const seq = seqOf(seg)
  return {
    id: seg.id,
    startedAt: seg.startedAt,
    endedAt: seg.endedAt,
    endReason: seg.endReason,
    measurements: seg.measurements,
    ignoreZones: seg.ignoreZones,
    middleCount: seg.middle.length,
    frames: keptIndices(seg, kf).map((index) => {
      const s = seq[index]
      return { index, t: s.t, blob: s.blob, width: s.width, height: s.height, gray: s.gray }
    }),
    judgment,
    keyFrames: kf,
  }
}

/** 按“保留的位置 → 截图”还原一个只剩关键图的片段 */
function rebuild(base: Omit<Segment, 'before' | 'middle' | 'after' | 'keyFramesOnly'>, middleCount: number, kept: Map<number, Snapshot>): Segment {
  const seq = sparseSequence(middleCount + 2, kept)
  return { ...base, before: seq[0], middle: seq.slice(1, -1), after: seq[seq.length - 1], keyFramesOnly: true }
}

export function fromStored(s: StoredSegment): Segment {
  const kept = new Map<number, Snapshot>(
    s.frames.map((f) => [f.index, { t: f.t, blob: f.blob, url: URL.createObjectURL(f.blob), width: f.width, height: f.height, gray: f.gray }]),
  )
  const { frames: _f, judgment: _j, keyFrames: _k, middleCount, ...base } = s
  return rebuild(base, middleCount, kept)
}

/**
 * 内存里只留关键图（较早的片段，省内存）：没选中的中间帧释放掉。
 * 变化前 / 变化后可能和相邻片段共用同一张截图，不释放，只释放中间帧。
 */
export function reduceToKeyFrames(seg: Segment, kf: KeyFrameResult | null): Segment {
  if (seg.keyFramesOnly) return seg
  const seq = seqOf(seg)
  const keep = keptIndices(seg, kf)
  const kept = new Map(keep.map((i) => [i, seq[i]]))
  seg.middle.forEach((s, i) => {
    if (!keep.includes(i + 1)) URL.revokeObjectURL(s.url)
  })
  const { before: _b, middle: _m, after: _a, keyFramesOnly: _o, ...base } = seg
  return rebuild(base, seg.middle.length, kept)
}

/** 读回来的片段在界面上显示的判断（只有最终结果；快速 / 复核的原始输出不存） */
export function restoredAnalysis(s: StoredSegment, models: { fast: Analysis['fast']['model']; review: Analysis['review']['model'] }): Analysis | null {
  if (!s.judgment) return null
  return {
    status: 'done',
    startedAt: s.endedAt,
    finishedAt: s.endedAt,
    shown: s.judgment,
    final: s.judgment,
    source: 'restored',
    fast: { model: models.fast, status: 'done', startedAt: s.endedAt },
    review: { model: models.review, status: 'done', startedAt: s.endedAt },
    reconcile: { status: 'skipped', reason: '从本机记录读回，只保存了最终判断' },
  }
}
