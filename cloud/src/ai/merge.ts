/**
 * 实时合并（《产品逻辑》3.1.1a，10/15 修订）：一件事 = 用户事后会单独找、单独问的一件事。
 * 同一时间可以有几件事在进行（如“在家活动”和“快递”）。新片段进来时，把正在进行的几件事
 * （一句话、分类、关键图）和新片段一起给模型，由它判断新片段并进哪一件、还是新开一件；
 * 并进去时同时重写这件事的一句话、分类，并为整件事选关键图。
 *
 * - 拿不准时偏向并进去（用户之后可以通过询问找到）
 * - 两条硬规则由程序先筛候选（events/grouping.ts allowedTargets）：摔倒只能并进摔倒那件；提醒档只能并进同一事由的事
 * - 合并的理由只能是活动和事由接得上，不能是“看起来像同一个人”。送的图是各件事已经选好的关键图
 * - 模型按“模型与超时”面板的“实时合并”（默认 Flash 关闭思考，8 秒没回再发一份）。并进去但关键图选得不合格 → 重问，最多 2 次
 * - 合并不影响提醒：提醒在每个片段分析完时就已决定
 */
import type { Snapshot } from '../motion/detector'
import type { Box } from '../motion/state-machine'
import type { EventKeyFrame, SegmentBrief } from '../events/grouping'
import type { ContentPart } from './gateway'
import { callStep } from './step'
import { extractJson, strOrNull, toDataUrl } from './judge'
import { validKeyFrames } from './frames'
import { KEYFRAME_RETRIES } from './keyframes'
import { categoryLines, findCategory, normalizeCategory, type Category } from '../memory/categories'

const IMAGE_WIDTH = 512

const PRIVACY = `隐私要求：只说“有人”和动作、位置，不写穿着、外貌，不推测身份、年龄、性别、情绪；描述里不写“同一个人”“又是那个人”。`

/** 什么算一件事（实时合并和统一整理共用） */
export const SAME_EVENT_RULES = `什么算一件事：
- 一件事 = 用户事后会单独找、单独问的一件事。关键问题：用户事后会不会单独问它？例如“快递几点到的”会问，是单独一件；“椅子几点挪的”不会问，并进它所在的那件事
- 用户通常会单独问的：【事件分类】里列的几类事（快递包裹、有人来访、进出家门、有人摔倒……）、用户计划里在等的事、用户定过规则的事
- 同一个事由的前后动作是一件：送快递的人来、放下箱子、离开 = 一件；起身、走动、挪椅子、拿水、坐回去 = 一件在家活动；快递员回车上拿第二个箱子再送来 = 一件
- 不同事由可以同时在进行：在屋里活动时快递到了，是“在家活动”和“快递”两件
- 同一类事出现两次、用户会分别问的，是两件：上午一个快递、下午又一个快递
- 琐碎动作（走动、起坐、拿水、伸懒腰、挪动家具、拿起又放下东西……）用户不会单独问，并进同一时间正在进行的那件事
- 拿不准时偏向并进去：用户之后可以通过询问找到
- 一件事何时结束：画面里没人，并且较长时间没人再出现。人坐着不动时摄像头不会截图，隔了一阵没有新片段不等于人走了：看那件事最后的画面里还有没有人
- 摄像头被挪动、画面视角变了，不是分开的理由
- 判断依据只能是活动和事由接得上，不能是“看起来像同一个人”（穿着、体型等）`

const MERGE_PROMPT = `你在整理家用摄像头的记录。摄像头只在画面有变化时截取“片段”，人停住不动时不截，所以同一件事常被切成几段。
现在有几件“正在进行的事”（编号 E1、E2……，每件由一个或多个片段组成）和一个“新片段”，判断新片段属于哪一件。

${SAME_EVENT_RULES}

结论：
- target 为某件事的编号（如 "E1"）：新片段是这件事的一部分，并进去
- target 为 null：新片段不属于任何一件正在进行的事，新开一件（只在确实是用户会单独问的另一件事，或之前的事已经结束时）

target 不为 null 时，再为并进去之后的整件事：
- summary：一句话，按合适的粗细概括（琐碎动作不必逐个列），讲清最后的结果，不超过 50 个字，不写具体时刻
- category：从【事件分类】里为整件事选一个 id（看整件事的事由，不只看新片段）
- left：整件事到现在为止，画面里留下的变化（多了 / 少了东西、东西换了位置），一句话；后面的片段把它处理掉了（如放下的箱子又被拿走）就不算；只是有人来去、东西拿起又放回、日常挪动家具的不算；没有为 null
- key_frames：从“这件事的关键图”和“新片段的关键图”里为整件事选关键图——在不丢失关键信息和关键动作的前提下，尽量少保留图片；一般要有开始和结束，中间只留关键动作，意思重复的不要；只能用图上标的编号，不能用别的事的图；每张写一句说明，只说“有人”和动作、位置

${PRIVACY}

只输出 JSON：
{"target": "E1 或 null", "reason": "一句话理由（说事由和活动，不说长相穿着）", "summary": "target 不为 null 时：整件事一句话，否则为 null", "category": "target 不为 null 时：整件事的分类 id，否则为 null", "left": "target 不为 null 时：整件事留下的变化或 null", "key_frames": target 不为 null 时 [{"id": 编号（数字）, "note": "这张图说明了什么"}]，否则为 null}`

const SUMMARY_PROMPT = `你在整理家用摄像头的记录。下面是同一件事的几个片段（按时间先后），每段下面是补充信息。用一句话概括整件事和最后的结果（如“已经起来了，没有提醒”）：按合适的粗细概括，琐碎动作不必逐个列，不超过 50 个字，不写具体时刻。

${PRIVACY}

只输出 JSON：{"summary": "……"}`

const clock = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false })

function briefText(b: SegmentBrief, i: number | undefined, categories: Category[]) {
  const cat = b.category ? `（分类：${findCategory(b.category, categories).name}）` : ''
  const head = `${i !== undefined ? `片段 ${i + 1}，` : ''}${clock(b.startedAt)}–${clock(b.endedAt)}${cat}`
  return [
    `- ${head}：${b.change ?? '（这段没能看懂）'}`,
    ...(b.left ? [`  这段留下的变化：${b.left}`] : []),
    ...b.notes.map((n) => `  ${n}`),
  ].join('\n')
}

/** 送去合并的一张关键图 */
export interface MergeFrame {
  ref: EventKeyFrame
  snap: Snapshot
  zones: Box[]
}

/** 一件正在进行的事 */
export interface OpenEventInput {
  /** 事件 id（不给模型看，模型只看 E1、E2） */
  id: string
  summary: string
  category: string
  /** 这件事目前留下的变化 */
  left?: string | null
  /** 这件事的所有片段（按时间先后） */
  segments: SegmentBrief[]
  /** 这件事最后的画面里还有没有人（null = 不知道） */
  presentAtEnd: boolean | null
  /** 这件事目前的关键图 */
  frames: MergeFrame[]
}

export interface MergeInput {
  /** 正在进行的几件事（已按硬规则筛过，按开始时间先后） */
  open: OpenEventInput[]
  next: SegmentBrief
  /** 新片段的关键图 */
  nextFrames: MergeFrame[]
  categories: Category[]
}

export interface MergeResult {
  /** 并进哪件事（事件 id）；null = 新开一件 */
  targetId: string | null
  reason: string
  summary: string | null
  /** 并进去时整件事的分类（已校验在清单里） */
  category: string | null
  /** 并进去时整件事留下的变化（null = 没有）；新开一件时 undefined */
  left?: string | null
  /** 并进去时整件事的关键图；重问后仍不合格为 null（调用方保留两边全部关键图） */
  keyFrames: EventKeyFrame[] | null
  /** 为选图额外问了几次 */
  retries: number
  latencyMs: number
  raw: string
}

const presenceText = (p: boolean | null) => (p === null ? '' : p ? '这件事最后的画面里还有人。' : '这件事最后的画面里已经没有人了。')

export async function decideEvent(m: MergeInput): Promise<MergeResult> {
  // 图按“每件事的关键图 → 新片段的关键图”编号；记下每张属于哪件事，选图时只能用目标那件和新片段的
  const frames: { f: MergeFrame; owner: number }[] = [
    ...m.open.flatMap((ev, i) => ev.frames.map((f) => ({ f, owner: i }))),
    ...m.nextFrames.map((f) => ({ f, owner: -1 })),
  ]
  const labelOf = (i: number) => `E${i + 1}`
  const text = [
    '【正在进行的事】',
    ...m.open.flatMap((ev, i) => {
      const ids = frames.map((x, k) => (x.owner === i ? k + 1 : 0)).filter(Boolean)
      return [
        `${labelOf(i)}（分类：${findCategory(ev.category, m.categories).name}）目前的描述：${ev.summary}${ev.left ? `；目前留下的变化：${ev.left}` : ''}`,
        ...ev.segments.map((b, k) => briefText(b, k, m.categories)),
        presenceText(ev.presentAtEnd),
        `距新片段：${Math.round((m.next.startedAt - ev.segments.at(-1)!.endedAt) / 1000)} 秒；关键图 ${ids.length ? ids.map((n) => `#${n}`).join('、') : '（无）'}`,
        '',
      ]
    }),
    '【新片段】',
    briefText(m.next, undefined, m.categories),
    `关键图 ${frames.map((x, k) => (x.owner === -1 ? `#${k + 1}` : '')).filter(Boolean).join('、')}`,
    '',
    '【事件分类】',
    ...categoryLines(m.categories),
  ].join('\n')
  const content: ContentPart[] = [{ type: 'text', text }]
  for (let k = 0; k < frames.length; k++) {
    const { f, owner } = frames[k]
    const side = owner === -1 ? '新片段' : labelOf(owner)
    content.push({ type: 'text', text: `【#${k + 1} ${side}，${clock(f.snap.t)}${f.ref.note ? `：${f.ref.note}` : ''}】` })
    content.push({ type: 'image_url', image_url: { url: await toDataUrl(f.snap, IMAGE_WIDTH, f.zones) } })
  }
  const messages = [
    { role: 'system' as const, content: MERGE_PROMPT },
    { role: 'user' as const, content },
  ]

  let latencyMs = 0
  for (let attempt = 0; ; attempt++) {
    const res = await callStep('merge', messages)
    latencyMs += res.latencyMs
    const obj = extractJson(res.text)
    const label = strOrNull(obj.target)
    const idx = label ? m.open.findIndex((_, i) => labelOf(i) === label.toUpperCase()) : -1
    if (label && idx < 0) throw new Error(`target 无效：${label}`)
    const base = {
      targetId: idx >= 0 ? m.open[idx].id : null,
      reason: strOrNull(obj.reason) ?? '',
      summary: idx >= 0 ? strOrNull(obj.summary) : null,
      category: idx >= 0 ? normalizeCategory(strOrNull(obj.category), m.categories) : null,
      left: idx >= 0 ? strOrNull(obj.left) : undefined,
      retries: attempt,
      latencyMs,
      raw: res.text,
    }
    if (idx < 0) return { ...base, keyFrames: null }
    // 只能用目标那件事和新片段的图
    const ids = frames.map((x, k) => (x.owner === idx || x.owner === -1 ? k + 1 : 0)).filter(Boolean)
    const picked = validKeyFrames(obj.key_frames, ids)
    if (picked) {
      const keyFrames = picked.map((k) => ({ ...frames[k.index - 1].f.ref, note: k.note || frames[k.index - 1].f.ref.note }))
      return { ...base, keyFrames }
    }
    // 并进去了但选图不合格：重问；问够了就保留两边全部关键图
    if (attempt >= KEYFRAME_RETRIES) return { ...base, keyFrames: null }
  }
}

/** 只用文字重写一件事的描述（如“再看一眼”有了结果之后），不重发图片 */
export async function resummarize(briefs: SegmentBrief[], categories: Category[]): Promise<string> {
  const res = await callStep('reconcile', [
    { role: 'system', content: SUMMARY_PROMPT },
    { role: 'user', content: briefs.map((b, i) => briefText(b, i, categories)).join('\n') },
  ])
  const summary = strOrNull(extractJson(res.text).summary)
  if (!summary) throw new Error('返回里缺少 summary')
  return summary
}
