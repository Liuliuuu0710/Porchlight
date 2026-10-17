/**
 * 统一整理的模型调用（候选、校验、合并在 events/consolidate.ts）——10/15 拆成简单的小问题：
 * ① askSamePairs：代码挑好的候选组合，只问“是不是同一件事”（是非题，Flash 不用想很久）
 * ② confirmMerge：只给“是”的那几组看关键图，确认后重写描述、分类、关键图
 * ③ askOpenChanges：写了“留下的变化”的事，后来有没有被处理 → 未结束的变化、关联
 */
import type { ContentPart } from './gateway'
import { callStep } from './step'
import { extractJson, strOrNull, toDataUrl } from './judge'
import { validKeyFrames } from './frames'
import { KEYFRAME_RETRIES } from './keyframes'
import { SAME_EVENT_RULES, type MergeFrame } from './merge'
import type { EventKeyFrame } from '../events/grouping'
import { categoryLines, normalizeCategory, type Category } from '../memory/categories'

/** 模型按“模型与超时”面板：① ③ 默认 Flash 关闭思考 → GLM；② 看图确认默认 Flash */
const IMAGE_WIDTH = 512

const PRIVACY = `隐私要求：只说“有人”和动作、位置，不写穿着、外貌，不推测身份、年龄、性别、情绪；不同的事之间不要说“同一个人”“又是那个人”。`

/**
 * 是非题：每组两件事，是不是同一件。故意写得短、只问一件事——规则一多，推理模型会想很久
 * （10/15：原来一次做四件事的提示词，5 件事 V4-Pro 想了 7418 tokens、98 秒；Flash 关不掉思考、额度用完）
 */
export const PAIR_PROMPT = `你在整理家用摄像头今天的记录。下面每组（P1、P2……）是两件事的档案，按时间先后。对每组判断：这两件是不是同一件事。

判断标准：用户事后会不会把它们当成一件事来问。
- 同一个事由的前后动作是一件：送快递的人来、放下箱子、离开；在屋里走动、挪椅子、中途离开一会儿又回来接着做
- 用户会分别问的是两件：上午一个快递、下午又一个快递；事由不同的事即使时间重叠（如在家活动时快递到了）也是两件
- 依据只能是事由和活动接得上，不能是“看起来像同一个人”
- 拿不准时算同一件（之后还会看图确认）

只输出 JSON：{"pairs": [{"id": "P1", "same": true 或 false, "reason": "一句话"}]}，每组都要回答。`

/** 留下的变化后来有没有被处理 → 剩下的是未结束的变化；处理它的那件事和它关联 */
export const OPEN_PROMPT = `你在整理家用摄像头今天的记录。下面是今天的事（E1、E2……按时间先后），有的写了“留下的变化”。
对每个留下的变化，看它后面的事里有没有把它处理掉（如箱子被拿走、东西放回原处）：
- 处理了：在 links 里写 {"from": 留下变化的那件的编号, "to": 处理它的那件的编号, "relation": 一句话说明关系}
- 到现在还没处理：在 open_changes 里写 {"event": 留下变化的那件的编号, "text": 一句话说明还没结束的变化}
只看写了“留下的变化”的事，没写的不要列。档案里写了“用户已确认处理过”的不要再列。
event、from、to 只填编号（如 "E1"）；给用户看的 relation、text 里不要写编号。

${PRIVACY}

只输出 JSON，例如：{"open_changes": [{"event": "E1", "text": "右侧多了一个纸盒，一直没人收"}], "links": [{"from": "E2", "to": "E5", "relation": "放下的箱子后来被拿走了"}]}；没有的给空数组。`

const CONFIRM_PROMPT = `你在整理家用摄像头的记录。下面几件事（按时间先后）被认为可能是同一件事，图是它们已选好的关键图，每张标了编号 #n。

${SAME_EVENT_RULES}

先判断它们是不是同一件事（用户事后会把它们当成一件来问）；同一类事但用户会分别问的（如两次不同的快递）不算。
是同一件事时：
- summary：整件事一句话，按合适的粗细概括（琐碎动作不必逐个列），不超过 50 个字，讲清最后的结果，不写具体时刻
- category：从【事件分类】里选一个 id
- key_frames：从这些图里为整件事选关键图——在不丢失关键信息和关键动作的前提下尽量少保留；一般要有开始和结束，中间只留关键动作，意思重复的不要；只能用图上的编号；每张写一句说明，只说“有人”和动作、位置

${PRIVACY}

只输出 JSON：
{"same_event": true 或 false, "reason": "一句话", "summary": "…或 null", "category": "分类 id 或 null", "key_frames": [{"id": 编号（数字）, "note": "…"}] 或 null}`

/** 一次最多问几组（组多了分几次同时发） */
const PAIRS_PER_CALL = 8

/** 是非题：pairLines[i] 是第 i 组两件事的档案（两行）；返回模型的原始回答（按 P1、P2…… 编号，调用方校验） */
export async function askSamePairs(pairLines: [string, string][]): Promise<{ pairs: unknown[] }> {
  const chunks: { start: number; lines: [string, string][] }[] = []
  for (let i = 0; i < pairLines.length; i += PAIRS_PER_CALL) chunks.push({ start: i, lines: pairLines.slice(i, i + PAIRS_PER_CALL) })
  const answers = await Promise.all(
    chunks.map(async (ch) => {
      const res = await callStep('consolidatePlan', [
        { role: 'system', content: PAIR_PROMPT },
        { role: 'user', content: ch.lines.map(([a, b], k) => `P${k + 1}\n  ${a}\n  ${b}`).join('\n\n') },
      ])
      const obj = extractJson(res.text)
      const list: Record<string, unknown>[] = Array.isArray(obj?.pairs) ? obj.pairs : []
      // 每批里编号从 P1 起，换回全局编号
      return list.map((p) => {
        const n = Number(String(p?.id ?? '').replace(/\D/g, ''))
        return { ...p, id: n ? `P${ch.start + n}` : p?.id }
      })
    }),
  )
  return { pairs: answers.flat() }
}

/** 未结束的变化：lines 是今天全部事件的档案（E1、E2……） */
export async function askOpenChanges(lines: string[]): Promise<unknown> {
  const res = await callStep('consolidateOpen', [
    { role: 'system', content: OPEN_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ])
  return extractJson(res.text)
}

export interface ConfirmInput {
  /** 每件事的档案文字（按时间先后） */
  lines: string[]
  /** 这几件事的关键图（按时间先后） */
  frames: MergeFrame[]
  categories: Category[]
}

export interface ConfirmResult {
  same: boolean
  reason: string
  summary: string
  category: string | null
  /** 选图重问后仍不合格为 null（合并时保留两边全部关键图并标“待选图”） */
  keyFrames: EventKeyFrame[] | null
  retries: number
  latencyMs: number
}

export async function confirmMerge(c: ConfirmInput): Promise<ConfirmResult> {
  const ids = c.frames.map((_, i) => i + 1)
  const content: ContentPart[] = [
    { type: 'text', text: ['【这几件事】', ...c.lines, '', '【事件分类】', ...categoryLines(c.categories)].join('\n') },
  ]
  for (let i = 0; i < c.frames.length; i++) {
    const f = c.frames[i]
    const t = new Date(f.snap.t).toLocaleTimeString('zh-CN', { hour12: false })
    content.push({ type: 'text', text: `【#${i + 1}，${t}${f.ref.note ? `：${f.ref.note}` : ''}】` })
    content.push({ type: 'image_url', image_url: { url: await toDataUrl(f.snap, IMAGE_WIDTH, f.zones) } })
  }
  let latencyMs = 0
  for (let attempt = 0; ; attempt++) {
    const res = await callStep('consolidateConfirm', [
      { role: 'system', content: CONFIRM_PROMPT },
      { role: 'user', content },
    ])
    latencyMs += res.latencyMs
    const obj = extractJson(res.text)
    if (typeof obj.same_event !== 'boolean') throw new Error('返回里缺少 same_event')
    const base = {
      same: obj.same_event as boolean,
      reason: strOrNull(obj.reason) ?? '',
      summary: strOrNull(obj.summary) ?? '',
      category: obj.same_event ? normalizeCategory(strOrNull(obj.category), c.categories) : null,
      retries: attempt,
      latencyMs,
    }
    if (!base.same) return { ...base, keyFrames: null }
    const picked = validKeyFrames(obj.key_frames, ids)
    if (picked) {
      return { ...base, keyFrames: picked.map((k) => ({ ...c.frames[k.index - 1].ref, note: k.note || c.frames[k.index - 1].ref.note })) }
    }
    if (attempt >= KEYFRAME_RETRIES) return { ...base, keyFrames: null }
  }
}
