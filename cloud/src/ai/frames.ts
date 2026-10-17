/**
 * 送模型前挑图（不调用模型、不碰画布，方便单测）：
 * - 每张中间帧的“变化分”：和前后相邻帧的灰度差异，越大越可能是关键动作
 * - 变化区域：整个片段里所有动过的地方合起来的框，中间帧只裁这一块送模型
 * 用的是第一层已经存好的 64×48 灰度图（Snapshot.gray）。
 */
import { diffGray, type Box } from '../motion/state-machine.ts'

export const GRAY_W = 64
export const GRAY_H = 48
/** 灰度差异超过多少算“这个像素变了”（与第一层默认一致） */
const PIXEL_THRESHOLD = 25
/** 变化区域四周多留的边（占画面比例） */
const BOX_MARGIN = 0.06
/** 变化区域超过画面这么大时，裁剪没意义，直接用全图 */
export const FULL_FRAME_AREA = 0.6

type Gray = Uint8ClampedArray | Uint8Array

/**
 * 序列 = [变化前, ...中间帧, 变化后]。返回每张中间帧的变化分（和前一张、后一张差异的较大值）。
 */
export function middleChangeScores(seq: Gray[], ignore: Uint8Array | null = null): number[] {
  const step = (a: Gray, b: Gray) => diffGray(a, b, GRAY_W, GRAY_H, PIXEL_THRESHOLD, ignore).ratio
  const scores: number[] = []
  for (let i = 1; i < seq.length - 1; i++) scores.push(Math.max(step(seq[i - 1], seq[i]), step(seq[i], seq[i + 1])))
  return scores
}

/** 按变化分挑 k 张，返回中间帧下标（按时间先后排好） */
export function topChanged(scores: number[], k: number): number[] {
  return scores
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, Math.max(0, k))
    .map((x) => x.i)
    .sort((a, b) => a - b)
}

/** 从 n 张里均匀挑 k 张（现有做法，对照用） */
export function evenly(n: number, k: number): number[] {
  if (n <= k) return Array.from({ length: n }, (_, i) => i)
  const step = (n - 1) / (k - 1)
  return Array.from({ length: k }, (_, i) => Math.round(i * step))
}

export function unionBox(boxes: (Box | null)[]): Box | null {
  const bs = boxes.filter((b): b is Box => !!b)
  if (bs.length === 0) return null
  const x0 = Math.min(...bs.map((b) => b.x))
  const y0 = Math.min(...bs.map((b) => b.y))
  const x1 = Math.max(...bs.map((b) => b.x + b.w))
  const y1 = Math.max(...bs.map((b) => b.y + b.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export function expandBox(b: Box, margin = BOX_MARGIN): Box {
  const x0 = Math.max(0, b.x - margin)
  const y0 = Math.max(0, b.y - margin)
  const x1 = Math.min(1, b.x + b.w + margin)
  const y1 = Math.min(1, b.y + b.h + margin)
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * 整个片段里动过的区域（相邻帧差异的框合起来，再留边）。
 * 没有变化，或变化区域太大（人从画面一头走到另一头、光线整体变化）→ null，表示用全图。
 */
export function motionCropBox(seq: Gray[], ignore: Uint8Array | null = null): Box | null {
  const boxes: (Box | null)[] = []
  for (let i = 1; i < seq.length; i++) boxes.push(diffGray(seq[i - 1], seq[i], GRAY_W, GRAY_H, PIXEL_THRESHOLD, ignore).box)
  const u = unionBox(boxes)
  if (!u) return null
  const e = expandBox(u)
  return e.w * e.h >= FULL_FRAME_AREA ? null : e
}

/** 给模型的位置说明，如“画面右下区域（横向 60%–95%，纵向 50%–100%）” */
export function describeCrop(b: Box): string {
  const p = (v: number) => `${Math.round(v * 100)}%`
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  const h = cx < 1 / 3 ? '左' : cx > 2 / 3 ? '右' : '中'
  const v = cy < 1 / 3 ? '上' : cy > 2 / 3 ? '下' : '中'
  const where = h === '中' && v === '中' ? '中间' : `${h === '中' ? '' : h}${v === '中' ? '' : v}${h !== '中' && v !== '中' ? '' : '侧'}`
  return `画面${where}区域（横向 ${p(b.x)}–${p(b.x + b.w)}，纵向 ${p(b.y)}–${p(b.y + b.h)}）`
}

/** 模型选的关键图：index 是片段序列里的位置（0 = 变化前，1..n = 中间帧，n+1 = 变化后） */
export interface KeyFrame {
  index: number
  note: string
}

/**
 * 校验模型选的关键图：编号必须在候选里、不重复，至少一张；编号可以是数字或 "#3"。
 * 不合格返回 null（调用方重新问模型，不退回固定方案）。
 */
export function validKeyFrames(raw: unknown, candidates: number[]): KeyFrame[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: KeyFrame[] = []
  for (const k of raw as { id?: unknown; note?: unknown }[]) {
    const id = typeof k?.id === 'number' ? k.id : Number(String(k?.id ?? '').replace('#', '').trim() || NaN)
    if (!Number.isInteger(id) || !candidates.includes(id) || out.some((o) => o.index === id)) return null
    out.push({ index: id, note: typeof k?.note === 'string' ? k.note.trim() : '' })
  }
  return out.sort((a, b) => a.index - b.index)
}
