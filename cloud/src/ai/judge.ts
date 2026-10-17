/**
 * 第二层滤网：把片段图片 + 生效的短期计划 + 长期记忆交给视觉大模型，
 * 得到结构化判断：记录 / 留意 / 提醒（见《产品逻辑》3.2）。
 * 每个片段单独判断要不要提醒；片段合并成事件在 events.ts。
 */
import type { Segment, Snapshot } from '../motion/detector'
import { SCENE } from '../config/scene'
import { zonesToMask, type Box } from '../motion/state-machine'
import { isPlanActive, type HomeContext, type Plan } from '../memory/types'
import { categoryLines, normalizeCategory } from '../memory/categories'
import { GRAY_H, GRAY_W, describeCrop, evenly, middleChangeScores, motionCropBox, topChanged, validKeyFrames, type KeyFrame } from './frames'
import { modelImage, modelSheet } from './image-ops'
import { chat, chatHedged, type ChatMessage, type ChatResult, type ContentPart } from './gateway'
import { callStep, primaryOf } from './step'

/**
 * 看图模型按步骤设置（ai/models.ts，调试台“模型与超时”面板），这里的 id 是那里的选项 id。
 * 依据 2026-10-13 的 5 场景对比（见 方案与进度.md）：Kimi-K3 5/5 全对；
 * DeepSeek-V4.1-Flash 最快但偶尔把“箱子被拿走”看成“抱着箱子经过”；Qwen-Max 慢且两次额度用完；Nova Pro 错 2 个。
 */
export type JudgeModelId = string
export { modelLabel } from './models'

/** 记录 / 留意（不推送，高亮）/ 提醒（只限 4 种情况） */
export type Verdict = 'record' | 'notice' | 'alert'

export interface Judgment {
  /** 画面发生了什么变化 */
  change: string
  verdict: Verdict
  /** 引用的计划 / 记忆 id，如 "plan:p1"、"memory:m2" */
  basis: string[]
  /** 给用户的一句话 */
  message: string
  /** 要问用户的问题 */
  question: string | null
  /** 紧急提问（和提醒的几种情况有关但看不清）会马上推送；不紧急的等用户打开 App 再问 */
  questionUrgent: boolean
  /** 紧急提问是关于哪条计划 / 记忆的（如 "plan:p1"）；用来去重、计划到达后不再问。旧记录没有这个字段 */
  questionAbout?: string | null
  /** 建议新增的长期记忆（需用户确认） */
  suggested_memory: string | null
  /** 期待型计划的对照结果 */
  expected: ExpectedMatch[]
  /** 摔倒判断；摔倒规则关闭时为 null */
  fall: FallCheck | null
  /** 变化后的画面里还有没有人（人坐着不动时不会有新片段，用它判断“这段在场”是否还在继续）；没给为 null */
  presentAtEnd: boolean | null
  /** 这段留下的变化（多了 / 少了东西、东西换了位置）；没有为 null，旧记录没有这个字段 */
  leftChange?: string | null
  /** 分类 id（只能从分类清单里选，不在清单里的归“其他”） */
  category: string
  /** 模型选的关键图：index 是片段序列里的位置（0 = 变化前，1..n = 中间帧，n+1 = 变化后） */
  keyFrames: KeyFrame[]
}

/**
 * 送图方案（对比测试用，见《方案与进度》）：
 * - A：变化前、变化后全图 + 均匀挑 4 张中间帧（原做法）
 * - B：变化前、变化后全图 + 变化最大的 8 张中间帧（只裁变化区域）
 * - C：变化前、变化后全图 + 全部中间帧的总览图 1 张 + 变化最大的 6 张（裁剪）
 */
export type FrameScheme = 'A' | 'B' | 'C'
export type { KeyFrame }

export interface FallCheck {
  /** 是否疑似摔倒（突然倒地，而不是主动坐下、蹲下、躺下） */
  suspected: boolean
  /** 片段结束时（变化后画面）是否还有人倒在地上 */
  onGroundAtEnd: boolean
  evidence: string
}

export interface ExpectedMatch {
  /** plan:pX */
  id: string
  matched: boolean
  /** 在画面里看到了什么 */
  evidence: string
}

export interface JudgeRun {
  model: JudgeModelId
  status: 'pending' | 'done' | 'error'
  startedAt: number
  judgment?: Judgment
  raw?: string
  error?: string
  latencyMs?: number
  usage?: ChatResult['usage']
  imageCount?: number
}

/** 送模型的图片尺寸 */
const KEY_FRAME_WIDTH = 1024
const MIDDLE_FRAME_WIDTH = 512
const MAX_MIDDLE_TO_MODEL = 4
/** 方案 B 送几张裁剪图（10/15 片段改 15 秒后比过 6 张：长片段会漏关键动作，只省 3–5% 额度 → 保持 8） */
export const B_CROPS = 8

const SYSTEM_PROMPT = `你是${SCENE.role}。摄像头检测到画面发生了变化，你要结合用户的「短期计划」和「长期记忆」，描述发生了什么，并把这次变化分到三档之一。

原则是少打扰：只有下面几种情况才算 "alert"（会推送通知给用户），其余一律不推送。

三档：
- "record"（记录）：日常、符合计划或记忆（如快递按计划放在了约定的位置——这不用通知，用户已经知道）、或无关紧要（光线变化、有人经过、宠物走动、东西拿起又放下）
- "notice"（留意）：值得用户之后看一眼，但用户没有为它设过规则，例如桌上多了个包、桌上的设备被拿走、有人在桌前停留较久。不推送，只在记录里高亮
- "alert"（提醒）：只限以下情况
  1. 【用户在等的事】里的某一条确实出现了
  2. 【需要马上通知的异常】里的情况出现了
  3. 违反了用户在计划或记忆里明确定下的规则（如计划说“快递放门边右侧”却放到了别处、“钥匙不能被拿走”却被拿走）
  4. 很可能是上面 1–3 的情况，但看不清、拿不准 → 在 question 里提一个简短、具体的问题，question_urgent 为 true
- 不要因为“陌生人”“没见过的东西”本身就给 "alert"：用户没设规则的事最多是 "notice"
- 保持一致：basis 里引用的计划或记忆说明这次变化是预期内的，verdict 必须是 "record"

提问（question）：
- 和上面第 4 条有关的问题：question_urgent 为 true（会马上问用户），question_about 写这个问题关于哪条计划或记忆的 id（如 plan:p1）
- 【当前生效的短期计划】里标了“（已到达）”的事，用户已经知道了，不要再为它提问
- 其他情况下，如果用户的回答能让你以后判断得更准（如“桌上的包是你们的吗？”“这种情况以后要记成日常吗？”），也可以提一个问题，question_urgent 为 false（不推送，用户打开 App 时再问）。没有必要就不问，question 为 null

【用户在等的事】：用户希望看到时被告知。逐条对照，在 expected 里给出结果：
- 只有画面中确实能看到描述的事情和识别特征，matched 才为 true；看不清或只符合一部分时为 false，按上面第 4 条提问
- 只要画面里出现了符合描述和识别特征的情况就算（例如只是经过也算），不要求停留或放下东西
- 任何一条 matched 为 true 时，verdict 为 "alert"，message 直接用计划里的说法告诉用户（如计划是“送快递的人到了”，就说“送快递的人到了”），并说清在画面哪里

【需要马上通知的异常】里列出的情况，在 fall 里给出判断（没有这一段时 fall 为 null）：
- 摔倒：有人在一两秒内从站立、行走突然倒在地上，姿势不自然。注意看每张图的时间，变化越突然越像摔倒
- 不是摔倒：主动坐下、蹲下、弯腰捡东西、有控制地慢慢躺下或趴下
- onGroundAtEnd：变化后的画面里，是否还有人倒在地上
- suspected 且 onGroundAtEnd 为 true 时，verdict 为 "alert"，message 如“有人摔倒了，还在地上”；摔倒后已经起身离开时，verdict 为 "notice"，message 如“有人摔了一下，已经起来了”

分类（category）：从【事件分类】里选一个最贴切的 id，只能用清单里的 id；都不合适时用 other。

关键图（key_frames）：每张图都标了编号 #n（总览图里每格左上角也有编号）。从中选出能把这次变化讲清楚的图：
- 在不丢失关键信息和关键动作的前提下，尽量少保留图片
- 一般要有开始和结束，中间只留关键动作（如放下、拿走、倒地、起身），意思重复的不要
- 每张写一句说明，只说“有人”和动作、位置，不写穿着

一个片段里先后发生了几件事（如一个人离开后又来了另一个人），在 change 里按先后顺序都写清楚。

隐私要求（必须遵守）：
- 只描述"有人"及其动作，不推测身份、年龄、性别、情绪，不做人脸识别
- 衣服颜色等穿着特征只能写在 expected 的 evidence 里，用来对照【用户在等的事】；change、message、question 里一律不写穿着，只说“有人”
- 只依据图片中能看到的内容，不要编造

输出要求：只输出一个 JSON 对象，不要输出任何其他文字或代码块标记。字段如下：
{
  "change": "用一两句话客观描述这段时间里发生了什么（按先后顺序）",
  "verdict": "record | notice | alert",
  "basis": ["引用的计划或记忆 id，如 plan:p1、memory:m2；没有就是空数组"],
  "message": "给用户的一句话，口语、简短、温和，不超过 30 个字",
  "question": "要问用户的问题，没有就是 null",
  "question_urgent": true 或 false,
  "question_about": "问题关于哪条计划或记忆的 id，如 plan:p1；没有提问或和计划、记忆无关时为 null",
  "suggested_memory": "如果这次变化看起来是这个家的固定习惯，给出一条建议记忆的文字，否则为 null",
  "expected": [{"id": "plan:p3", "matched": true 或 false, "evidence": "在画面里看到了什么"}]（没有【用户在等的事】就是空数组）,
  "fall": {"suspected": true 或 false, "onGroundAtEnd": true 或 false, "evidence": "看到了什么"}（没有【需要马上通知的异常】就是 null）,
  "category": "【事件分类】里的一个 id",
  "present_at_end": 变化后的画面里还有没有人（true 或 false）,
  "left_change": "和变化前相比，变化后的画面里留下了什么（多了 / 少了东西、东西换了位置），一句话；只是有人来去、东西拿起又放回、日常挪动家具的不算，没有就是 null",
  "key_frames": [{"id": 图的编号（数字）, "note": "这张图说明了什么"}]
}`

function describeBox(box: Box): string {
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const h = cx < 1 / 3 ? '左侧' : cx > 2 / 3 ? '右侧' : '中间'
  const v = cy < 1 / 3 ? '上部' : cy > 2 / 3 ? '下部' : '中部'
  const area = Math.round(box.w * box.h * 100)
  return `画面${h}${v}，约占画面 ${area}%`
}

/** 第一层的测量值，原样转述给模型，由模型自己理解 */
function describeMeasurements(seg: Segment): string {
  const { netChange, changeBox } = seg.measurements
  const pct = (netChange * 100).toFixed(1)
  return changeBox ? `变化前后像素差异 ${pct}%，差异区域在${describeBox(changeBox)}` : `变化前后像素差异 ${pct}%`
}

function formatTime(t: number) {
  return new Date(t).toLocaleString('zh-CN', { weekday: 'long', hour12: false, month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** 片段背景 + 生效的计划 + 启用的记忆；withImages 为 false 时用于纯文字复核 */
export function buildContextText(seg: Segment, ctx: HomeContext, withImages = true): string {
  const now = seg.endedAt
  const active = ctx.plans.filter((p) => isPlanActive(p, now))
  // 期待型且还没到达的，单独列出来让模型对照；已到达的当普通计划
  const waiting = active.filter((p) => p.kind === 'expect' && !p.matchedAt)
  const plans = active.filter((p) => !waiting.includes(p))
  // 内置规则（如摔倒）单独列在【需要马上通知的异常】，其余记忆照常列出
  const memories = ctx.memories.filter((m) => m.enabled && !m.rule)
  const urgentRules = ctx.memories.filter((m) => m.enabled && m.rule)
  const planLine = (p: Plan) =>
    `- plan:${p.id}：${p.text}${p.kind === 'expect' && p.matchedAt ? '（已到达）' : ''}`
  const lines = [
    `当前时间：${formatTime(now)}`,
    `片段时长：${((seg.endedAt - seg.startedAt) / 1000).toFixed(1)} 秒`,
    `测量值（仅供参考）：${describeMeasurements(seg)}`,
    ...(withImages && seg.ignoreZones.length ? ['用户设置了忽略区域：画面边上的已经裁掉，图中的灰色块也是忽略区域，不用管它。'] : []),
    '',
    ...(waiting.length
      ? [
          '【用户在等的事】（看到了就要告诉用户）',
          ...waiting.map((p) => `- plan:${p.id}：${p.text}${p.cues ? `。识别特征：${p.cues}` : ''}`),
          '',
        ]
      : []),
    ...(urgentRules.length
      ? ['【需要马上通知的异常】', ...urgentRules.map((m) => `- memory:${m.id}：${m.text}`), '']
      : []),
    '【当前生效的短期计划】',
    ...(plans.length ? plans.map(planLine) : ['（无）']),
    '',
    '【长期记忆】',
    ...(memories.length ? memories.map((m) => `- memory:${m.id}：${m.text}`) : ['（无）']),
    '',
    '【事件分类】',
    ...categoryLines(ctx.categories),
    ...(withImages ? ['', '下面依次是：变化前、中间过程、变化后的画面。'] : []),
  ]
  return lines.join('\n')
}

/** 送模型的整张图：忽略区域先裁掉四周、剩下的填灰（zones.ts）；只针对送模型的图，给用户看的原图不变 */
export async function toDataUrl(snap: Snapshot, maxWidth: number, ignoreZones: Box[]): Promise<string> {
  return modelImage(snap, null, { maxWidth }, ignoreZones)
}

export interface UserContent {
  parts: ContentPart[]
  imageCount: number
  /** 模型能看到、能选为关键图的编号 */
  candidates: number[]
}

/** 打包送模型的内容。图都按片段序列编号：#0 变化前，#1..#n 中间帧，#n+1 变化后 */
/** 默认送图方案：B（10/14 对比：Flash 判摔倒比 A 准，额度只多约 1%–8%）；C 等更长的测试视频再比 */
export const DEFAULT_SCHEME: FrameScheme = 'B'

export async function buildUserContent(
  seg: Segment,
  ctx: HomeContext,
  scheme: FrameScheme = DEFAULT_SCHEME,
  crops = scheme === 'B' ? B_CROPS : 6,
): Promise<UserContent> {
  const zones = seg.ignoreZones
  const n = seg.middle.length
  const afterIdx = n + 1
  const rel = (s: Snapshot) => `+${((s.t - seg.before.t) / 1000).toFixed(1)}s`
  const parts: ContentPart[] = [{ type: 'text', text: buildContextText(seg, ctx) }]
  const img = (url: string): ContentPart => ({ type: 'image_url', image_url: { url } })
  const candidates = new Set<number>([0, afterIdx])
  let imageCount = 2

  parts.push({ type: 'text', text: '【#0 变化前，全图】' })
  parts.push(img(await toDataUrl(seg.before, KEY_FRAME_WIDTH, zones)))

  if (scheme === 'A') {
    const picks = evenly(n, MAX_MIDDLE_TO_MODEL)
    for (const i of picks) {
      parts.push({ type: 'text', text: `【#${i + 1} 中间过程，${rel(seg.middle[i])}】` })
      parts.push(img(await toDataUrl(seg.middle[i], MIDDLE_FRAME_WIDTH, zones)))
      candidates.add(i + 1)
    }
    imageCount += picks.length
  } else {
    const seq = [seg.before, ...seg.middle, seg.after].map((s) => s.gray)
    // 忽略区域里的变化不算（挑图、裁剪都不看它）
    const ignore = zones.length ? zonesToMask(zones, GRAY_W, GRAY_H) : null
    const scores = middleChangeScores(seq, ignore)
    const crop = motionCropBox(seq, ignore)
    const where = crop ? `裁剪：${describeCrop(crop)}` : '全图'
    if (scheme === 'C' && n > 0) {
      const labels = seg.middle.map((s, i) => `#${i + 1} ${rel(s)}`)
      parts.push({ type: 'text', text: `【总览：#1–#${n} 全部中间帧按时间排列（${where}），每格左上角是编号和时间】` })
      parts.push(img(await modelSheet(seg.middle, labels, crop, 1024, zones)))
      seg.middle.forEach((_, i) => candidates.add(i + 1))
      imageCount += 1
    }
    // C 有总览图兜底，但裁剪图也不能太少（3 张时关键动作的细节不够）
    const picks = topChanged(scores, crops)
    for (const i of picks) {
      parts.push({ type: 'text', text: `【#${i + 1} 中间过程，${rel(seg.middle[i])}，${where}】` })
      parts.push(img(await modelImage(seg.middle[i], crop, { maxSide: MIDDLE_FRAME_WIDTH }, zones)))
      candidates.add(i + 1)
    }
    imageCount += picks.length
  }

  parts.push({ type: 'text', text: `【#${afterIdx} 变化后，${rel(seg.after)}，全图】` })
  parts.push(img(await toDataUrl(seg.after, KEY_FRAME_WIDTH, zones)))
  return { parts, imageCount, candidates: [...candidates].sort((x, y) => x - y) }
}

const VERDICTS: Verdict[] = ['record', 'notice', 'alert']

/** 从模型输出中取出 JSON 对象：容忍代码块标记和前后多余文字 */
export function extractJson(raw: string): any {
  const text = raw.replace(/```(?:json)?/gi, '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('返回内容里没有 JSON')
  return JSON.parse(text.slice(start, end + 1))
}

/** 非空字符串或 null（模型偶尔会输出字符串 "null"） */
export const strOrNull = (v: unknown) => (typeof v === 'string' && v.trim() && v !== 'null' ? v.trim() : null)

/** candidates：模型能选的关键图编号；选得不合格时 keyFrames 为空数组（由调用方决定是否重问） */
export function parseJudgment(raw: string, ctx?: HomeContext, candidates: number[] = []): Judgment {
  const obj = extractJson(raw)
  if (!VERDICTS.includes(obj.verdict)) throw new Error(`verdict 无效：${obj.verdict}`)
  const str = strOrNull
  return {
    change: str(obj.change) ?? '',
    verdict: obj.verdict,
    basis: Array.isArray(obj.basis) ? obj.basis.filter((b: unknown) => typeof b === 'string') : [],
    message: str(obj.message) ?? '',
    question: str(obj.question),
    questionUrgent: !!str(obj.question) && obj.question_urgent === true,
    questionAbout: str(obj.question) && typeof obj.question_about === 'string' && /^(plan|memory):/.test(obj.question_about) ? obj.question_about : null,
    suggested_memory: str(obj.suggested_memory),
    expected: Array.isArray(obj.expected)
      ? obj.expected
          .filter((e: any) => e && typeof e.id === 'string' && /^plan:/.test(e.id))
          .map((e: any) => ({ id: e.id, matched: e.matched === true, evidence: str(e.evidence) ?? '' }))
      : [],
    fall:
      obj.fall && typeof obj.fall === 'object'
        ? {
            suspected: obj.fall.suspected === true,
            onGroundAtEnd: obj.fall.onGroundAtEnd === true,
            evidence: str(obj.fall.evidence) ?? '',
          }
        : null,
    category: ctx ? normalizeCategory(str(obj.category), ctx.categories) : (str(obj.category) ?? 'other'),
    presentAtEnd: typeof obj.present_at_end === 'boolean' ? obj.present_at_end : null,
    leftChange: str(obj.left_change),
    keyFrames: validKeyFrames(obj.key_frames, candidates) ?? [],
  }
}

/** 模拟判断（不调用模型）：只为跑通流程，粗略按测量值给结果 */
function mockJudge(seg: Segment): Judgment {
  const { netChange, changeBox } = seg.measurements
  const keyFrames = [
    { index: 0, note: '变化前' },
    { index: seg.middle.length + 1, note: '变化后' },
  ]
  return netChange < 0.02 || !changeBox
    ? {
        change: '有人或物体经过，前后画面没有明显变化',
        verdict: 'record',
        basis: [],
        message: '有人经过，一切如常',
        question: null,
        questionUrgent: false,
        suggested_memory: null,
        expected: [],
        fall: null,
        category: 'visit',
        keyFrames,
        presentAtEnd: null,
      }
    : {
        change: `${describeBox(changeBox)}出现变化`,
        verdict: 'notice',
        basis: [],
        message: '画面里有东西变了，看一眼？',
        question: null,
        questionUrgent: false,
        suggested_memory: null,
        expected: [],
        fall: null,
        category: 'object',
        keyFrames,
        presentAtEnd: null,
      }
}

/** 按“模型与超时”面板里这一步的设置判断一个片段（快速判断 / 复核） */
export async function judgeSegment(
  step: 'judgeFast' | 'judgeReview',
  seg: Segment,
  ctx: HomeContext,
): Promise<Omit<JudgeRun, 'model' | 'status' | 'startedAt'>> {
  if (primaryOf(step) === 'mock') {
    await new Promise((r) => setTimeout(r, 400))
    const judgment = mockJudge(seg)
    return { judgment, raw: JSON.stringify(judgment, null, 2), latencyMs: 400, imageCount: 0 }
  }
  const { parts, imageCount, candidates } = await buildUserContent(seg, ctx)
  const res = await callStep(step, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: parts },
  ])
  try {
    return { judgment: parseJudgment(res.text, ctx, candidates), raw: res.text, latencyMs: res.latencyMs, usage: res.usage, imageCount }
  } catch (e) {
    return { error: `解析失败：${(e as Error).message}`, raw: res.text, latencyMs: res.latencyMs, usage: res.usage, imageCount }
  }
}

/** 指定网关模型 ID 和参数判断一个片段（评测不同参数时直接用） */
export async function judgeWith(
  gatewayModel: string,
  seg: Segment,
  ctx: HomeContext,
  // 推理模型的思考过程也占额度，给足空间
  opts: { extra?: Record<string, unknown>; maxTokens?: number; timeoutMs?: number; hedgeAfterMs?: number; scheme?: FrameScheme; crops?: number } = {},
): Promise<Omit<JudgeRun, 'model' | 'status' | 'startedAt'>> {
  const { parts, imageCount, candidates } = await buildUserContent(seg, ctx, opts.scheme, opts.crops)
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: parts },
  ]
  const callOpts = { maxTokens: opts.maxTokens ?? 4096, timeoutMs: opts.timeoutMs }
  // 网关偶发很慢（同样的请求实测 7 秒 / 67 秒都有）：设了 hedgeAfterMs 时，超过这个时间还没回就再发一份，取先返回的
  const res = opts.hedgeAfterMs
    ? await chatHedged(
        [
          { model: gatewayModel, extra: opts.extra },
          { model: gatewayModel, extra: opts.extra },
        ],
        messages,
        { ...callOpts, hedgeAfterMs: opts.hedgeAfterMs },
      )
    : await chat(gatewayModel, messages, { ...callOpts, extra: opts.extra })
  try {
    return { judgment: parseJudgment(res.text, ctx, candidates), raw: res.text, latencyMs: res.latencyMs, usage: res.usage, imageCount }
  } catch (e) {
    return { error: `解析失败：${(e as Error).message}`, raw: res.text, latencyMs: res.latencyMs, usage: res.usage, imageCount }
  }
}
