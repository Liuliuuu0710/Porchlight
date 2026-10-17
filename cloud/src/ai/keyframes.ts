/**
 * 关键图（第一轮压缩）：看图模型判断时顺便选出这一段的关键图。
 * 选得不合格（没选、编号不在候选里、重复）→ 只为选图再问一次模型，最多 2 次；
 * 还不行 → 保留全部候选图，标“待选图”，等统一整理时再选（不退回固定的“前 + 后”）。
 */
import type { Segment } from '../motion/detector'
import type { HomeContext } from '../memory/types'
import { callStep } from './step'
import { buildUserContent, extractJson, type Judgment } from './judge'
import { validKeyFrames, type KeyFrame } from './frames'

export const KEYFRAME_RETRIES = 2

const PROMPT = `下面是家用摄像头一个片段的图，每张都标了编号 #n（总览图里每格左上角也有编号）。已经知道这段时间里发生了什么（见文字说明）。
请选出能把这件事讲清楚的图：
- 在不丢失关键信息和关键动作的前提下，尽量少保留图片
- 一般要有开始和结束，中间只留关键动作（如放下、拿走、倒地、起身），意思重复的不要
- 只能用图上标的编号
- 每张写一句说明，只说“有人”和动作、位置，不写穿着
只输出 JSON：{"key_frames": [{"id": 编号（数字）, "note": "这张图说明了什么"}]}`

export interface KeyFrameResult {
  frames: KeyFrame[]
  /** ok：模型选好了；pending：重问后仍不合格，先保留全部候选，等统一整理时再选 */
  status: 'ok' | 'pending'
  /** 为选图额外问了几次 */
  retries: number
}

/** 只为选图问一次；不合格抛错 */
async function askKeyFrames(seg: Segment, ctx: HomeContext, final: Judgment): Promise<KeyFrame[]> {
  const { parts, candidates } = await buildUserContent(seg, ctx)
  // 第一段是判断用的背景文字（计划、记忆等），选图用不上，换成这段发生了什么
  parts[0] = { type: 'text', text: `这段时间里发生了什么：${final.change}` }
  const res = await callStep('keyframes', [
    { role: 'system', content: PROMPT },
    { role: 'user', content: parts },
  ])
  const frames = validKeyFrames(extractJson(res.text).key_frames, candidates)
  if (!frames) throw new Error(`选图不合格：${res.text.slice(0, 200)}`)
  return frames
}

export async function ensureKeyFrames(seg: Segment, ctx: HomeContext, final: Judgment): Promise<KeyFrameResult> {
  if (final.keyFrames.length > 0) return { frames: final.keyFrames, status: 'ok', retries: 0 }
  for (let i = 1; i <= KEYFRAME_RETRIES; i++) {
    try {
      return { frames: await askKeyFrames(seg, ctx, final), status: 'ok', retries: i }
    } catch {
      /* 再问一次 */
    }
  }
  const { candidates } = await buildUserContent(seg, ctx)
  return { frames: candidates.map((index) => ({ index, note: '' })), status: 'pending', retries: KEYFRAME_RETRIES }
}
