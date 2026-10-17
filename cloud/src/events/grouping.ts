/**
 * 片段 → 事件（见《产品逻辑》3.1.1a）。这里只放不调用模型的部分，方便单测。
 *
 * - 片段是最小单位，不拆；事件由一个或多个片段组成
 * - 是不是同一件事由模型判断，模型只合并、不拆分
 * - 时间间隔只决定“什么时候送模型判断”：距上一件事 ≤ 90 秒 → 马上问（实时合并）；
 *   更远的先各自成为一件事，等统一整理（每 2–3 小时 / 用户点“整理” / 生成日报前）
 * - 必须按片段的先后顺序合并：片段是并行分析的，先返回的不一定是先发生的
 */
import type { Verdict } from '../ai/judge'

export const MERGE_GAP_MS = 90_000

/** 送去合并时，一个片段的文字部分（图片另外带） */
export interface SegmentBrief {
  id: string
  startedAt: number
  endedAt: number
  /** 分析失败时为 null */
  change: string | null
  verdict: Verdict | null
  /** 看图模型给的分类 id；分析失败为 null */
  category: string | null
  /** 已经发出的提醒、“再看一眼”的结果等，原样告诉合并模型 */
  notes: string[]
  /** 看图判断写的“这段留下的变化”；没有为 null（旧记录没有这个字段） */
  left?: string | null
}

export interface MergeDecision {
  segmentId: string
  /** 和上一件事是同一件事吗 */
  same: boolean
  /** 实时合并的结论：并入 / 新的一件（按规则决定时没有）；separate 是 10/15 以前的记录（单独成卡并关联） */
  kind?: 'same' | 'separate' | 'new'
  /** 模型给的理由，或按规则决定的原因 */
  reason: string
  /** true：没问模型，按规则决定（间隔太远、分析失败等） */
  byRule: boolean
  latencyMs?: number
  /** 选图不合格、为选图重问的次数 */
  retries?: number
  error?: string
}

/** 事件的一张关键图：哪个片段的第几张（0 = 变化前，1..n = 中间帧，n+1 = 变化后） */
export interface EventKeyFrame {
  segmentId: string
  index: number
  note: string
}

export interface HomiEvent {
  id: string
  segmentIds: string[]
  startedAt: number
  endedAt: number
  /** 一句话把这件事讲清楚（合并时由模型更新） */
  summary: string
  /** 组成它的片段里最高的一档 */
  verdict: Verdict | null
  /** 临时分类：单个片段用看图模型给的，合并时由合并模型重选；统一整理时再确认 */
  category: string
  /** 整件事的关键图（模型逐轮选：片段分析时 → 合并时 → 统一整理时） */
  keyFrames: EventKeyFrame[]
  /** pending：合并时选图没成功，先保留两边全部关键图，等统一整理时再选 */
  keyFrameStatus: 'ok' | 'pending'
  /** 这件事到现在为止画面里留下的变化（多了 / 少了东西、东西换了位置；临时挪动不算），看图判断和实时合并时写；没有为 null，旧记录没有这个字段 */
  left?: string | null
  /** 正在问模型（新片段是否并入 / 重写描述） */
  busy: boolean
  decisions: MergeDecision[]
}

const RANK: Record<Verdict, number> = { record: 0, notice: 1, alert: 2 }

export const maxVerdict = (a: Verdict | null, b: Verdict | null): Verdict | null =>
  a === null ? b : b === null ? a : RANK[b] > RANK[a] ? b : a

/**
 * 新片段要不要送模型判断和“当前这段在场”的关系：间隔在 90 秒内，
 * 或者这段在场最后的画面里还有人（人坐着不动时不会有新片段，隔多久都可能还是同一段在场）。
 * 间隔为负（换了画面来源、视频往回拖）当作新的一件事。
 */
export function shouldAskMerge(
  last: HomiEvent | null,
  seg: Pick<SegmentBrief, 'startedAt'>,
  gapMs = MERGE_GAP_MS,
  lastPresentAtEnd: boolean | null = null,
): boolean {
  if (!last) return false
  const gap = seg.startedAt - last.endedAt
  return gap >= 0 && (gap <= gapMs || lastPresentAtEnd === true)
}

/** 同时拿来比的“正在进行的事”最多几件（每件都要送关键图） */
export const MAX_OPEN_EVENTS = 3

/**
 * 正在进行的事（《产品逻辑》3.1.1a，10/15）：这次画面来源里、和新片段隔得不远（或最后的画面里还有人）的事，
 * 取最近的几件，按开始时间先后排。
 */
export function openEvents(
  events: HomiEvent[],
  liveIds: string[],
  seg: Pick<SegmentBrief, 'startedAt'>,
  presentAtEnd: (ev: HomiEvent) => boolean | null,
  gapMs = MERGE_GAP_MS,
): HomiEvent[] {
  return events
    .filter((e) => liveIds.includes(e.id) && shouldAskMerge(e, seg, gapMs, presentAtEnd(e)))
    .sort((a, b) => b.endedAt - a.endedAt)
    .slice(0, MAX_OPEN_EVENTS)
    .sort((a, b) => a.startedAt - b.startedAt)
}

/** 两条硬规则：摔倒只能并进摔倒那件（如摔倒后又一段）；提醒档只能并进同一事由（同一分类）的事 */
export function allowedTargets(open: HomiEvent[], brief: Pick<SegmentBrief, 'verdict' | 'category'>, isFall: boolean): HomiEvent[] {
  if (isFall) return open.filter((e) => e.category === 'fall')
  if (brief.verdict === 'alert') return open.filter((e) => e.category === brief.category)
  return open
}

/**
 * 统一整理时同样的硬规则：摔倒的事只和摔倒的事并；不同事由（不同分类）的两件提醒不能并成一件。
 * 普通的事可以并进有提醒的事（如快递到了之后放下箱子），并完的分类见 lockedCategory。
 */
export function groupAllowed(group: Pick<HomiEvent, 'category' | 'verdict'>[]): boolean {
  const cats = new Set(group.map((e) => e.category))
  if (cats.has('fall') && cats.size > 1) return false
  return new Set(group.filter((e) => e.verdict === 'alert').map((e) => e.category)).size <= 1
}

/** 并成一件后分类不能改的情况：有摔倒 → 摔倒；有提醒 → 提醒那件的分类（快递到了不能被并成“在家活动”） */
export function lockedCategory(group: Pick<HomiEvent, 'category' | 'verdict'>[]): string | null {
  if (group.some((e) => e.category === 'fall')) return 'fall'
  return group.find((e) => e.verdict === 'alert')?.category ?? null
}

export function startEvent(
  brief: SegmentBrief,
  decision: MergeDecision,
  keyFrames: EventKeyFrame[] = [],
  keyFrameStatus: HomiEvent['keyFrameStatus'] = 'ok',
): HomiEvent {
  return {
    id: `ev-${brief.id}`,
    segmentIds: [brief.id],
    startedAt: brief.startedAt,
    endedAt: brief.endedAt,
    summary: brief.change ?? '（这段没能看懂）',
    verdict: brief.verdict,
    category: brief.category ?? 'other',
    keyFrames,
    keyFrameStatus,
    left: brief.left ?? null,
    busy: false,
    decisions: [decision],
  }
}

export function appendToEvent(
  ev: HomiEvent,
  brief: SegmentBrief,
  summary: string,
  decision: MergeDecision,
  category?: string | null,
  /** 合并模型为整件事选的关键图；null = 没选成功，保留两边全部关键图并标“待选图” */
  keyFrames?: { picked: EventKeyFrame[] | null; added: EventKeyFrame[] },
  /** 合并模型写的整件事“留下的变化”：undefined = 没给，保留原来的；null = 没有留下变化 */
  left?: string | null,
): HomiEvent {
  return {
    ...ev,
    segmentIds: [...ev.segmentIds, brief.id],
    endedAt: Math.max(ev.endedAt, brief.endedAt),
    summary: summary || ev.summary,
    verdict: maxVerdict(ev.verdict, brief.verdict),
    category: category || ev.category,
    ...(left !== undefined ? { left } : {}),
    ...(keyFrames
      ? keyFrames.picked
        ? { keyFrames: keyFrames.picked, keyFrameStatus: 'ok' as const }
        : { keyFrames: [...ev.keyFrames, ...keyFrames.added], keyFrameStatus: 'pending' as const }
      : {}),
    busy: false,
    decisions: [...ev.decisions, decision],
  }
}

/**
 * 合并队列里能处理的部分：从队头开始，连续“分析已结束”的片段。
 * 队头还在分析时，后面的即使已经结束也要等，保证按发生顺序合并。
 */
export function takeSettled(queue: string[], settled: (id: string) => boolean): string[] {
  const out: string[] = []
  for (const id of queue) {
    if (!settled(id)) break
    out.push(id)
  }
  return out
}
