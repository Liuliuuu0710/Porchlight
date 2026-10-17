/**
 * 统一整理（见《产品逻辑》3.1.1a，10/15 改为拆成小问题）里不调用模型的部分。
 *
 * 原来一次调用让推理模型同时做四件事（合并、关联、分类、未结束的变化），5 件事就要想 7000 多 tokens、约 100 秒。
 * 现在能用代码算的交给代码，剩下的拆成简单的小问题：
 * ① 代码挑候选组合（candidatePairs），跳过上次判过、两件都没变的（checked 缓存）
 * ② 模型只答是非题：这两件，用户事后会不会当成一件来问？（是的再看图确认，然后合并）
 * ③ “留下的变化”在看图判断 / 实时合并时已经写好；这里只问哪些后来被处理了 → 剩下的是未结束的变化
 * 分类沿用实时合并定的。模型只合并、不拆分；不提示用户，有待确认的事放进待处理列表。
 */
import { groupAllowed, maxVerdict, type EventKeyFrame, type HomiEvent, type MergeDecision } from './grouping.ts'

/** 两件不同的事前后有关（如上午送来的箱子中午被拿走） */
export interface EventLink {
  from: string
  to: string
  relation: string
}

/** 还没结束的变化（如“钥匙被拿走，还没放回”），日报和待确认列表会用到 */
export interface OpenChange {
  eventId: string
  text: string
}

/** 按开始时间给事件编号 E1、E2……（模型用短编号，比长 id 不容易抄错） */
export function labelEvents(events: HomiEvent[]): { label: string; event: HomiEvent }[] {
  return [...events].sort((a, b) => a.startedAt - b.startedAt).map((event, i) => ({ label: `E${i + 1}`, event }))
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() && v !== 'null' ? v.trim() : null)
/** 模型偶尔把内部编号写进给用户看的话（如“E1 放置的纸箱”），去掉 */
const clean = (v: unknown) => {
  const s = str(v)
    ?.replace(/\b[EP]\d+\s*(的|放置的|放下的|拿走的)?\s*/g, '')
    .trim()
  return s || null
}

// ───── ① 候选组合 ─────

export type Pair = [HomiEvent, HomiEvent]

/** 一对事件的键（按开始先后）；签名是两件各有几个片段——任一件又并进了片段，就要重新判断 */
export const pairKey = (a: HomiEvent, b: HomiEvent) => `${a.id}~${b.id}`
export const pairSig = (a: HomiEvent, b: HomiEvent) => `${a.segmentIds.length}/${b.segmentIds.length}`

/**
 * 可能是同一件事的组合（10/15 用户确认的三条，满足任一条）：
 * 1. 时间有重叠；2. 按开始时间排好后前后紧挨着；3. 同一分类里往前最近的那一件（中间夹着别的事也能比到，
 *    如“在家活动 → 快递 → 接着在家活动”）。违反硬规则的不要（摔倒只和摔倒并、两件不同事由的提醒不并）；
 * 上次已经判过、两件都没变的跳过。
 */
/** kindOf：同一“类”的上一件也拿来比（默认按分类；整理时按大类，如“埋头开发”和“团队讨论”都在“工作中”） */
export function candidatePairs(events: HomiEvent[], checked: Record<string, string> = {}, kindOf: (category: string) => string = (c) => c): Pair[] {
  const list = [...events].sort((a, b) => a.startedAt - b.startedAt)
  const out = new Map<string, Pair>()
  const add = (a: HomiEvent, b: HomiEvent) => {
    const [x, y] = a.startedAt <= b.startedAt ? [a, b] : [b, a]
    if (x.id === y.id || !groupAllowed([x, y])) return
    if (checked[pairKey(x, y)] === pairSig(x, y)) return
    out.set(pairKey(x, y), [x, y])
  }
  list.forEach((e, i) => {
    if (i > 0) add(list[i - 1], e)
    for (let j = 0; j < i; j++) if (list[j].endedAt > e.startedAt) add(list[j], e)
    const prevSame = list.slice(0, i).reverse().find((p) => kindOf(p.category) === kindOf(e.category))
    if (prevSame) add(prevSame, e)
  })
  return [...out.values()]
}

/** 模型对每组的回答：只认编号存在的；没回答的当“不是” */
export function parsePairAnswers(raw: unknown, pairs: Pair[]): { pair: Pair; same: boolean; reason: string }[] {
  const answers = Array.isArray((raw as { pairs?: unknown })?.pairs) ? ((raw as { pairs: unknown[] }).pairs as Record<string, unknown>[]) : []
  return pairs.map((pair, i) => {
    const a = answers.find((x) => typeof x?.id === 'string' && x.id.trim().toUpperCase() === `P${i + 1}`)
    return { pair, same: a?.same === true, reason: str(a?.reason) ?? '' }
  })
}

/** “是同一件”的组合连成组（A=B、B=C → A、B、C 一组），组内按开始先后 */
export function groupsFromPairs(pairs: Pair[]): string[][] {
  const parent = new Map<string, string>()
  const start = new Map<string, number>()
  const find = (x: string): string => {
    const p = parent.get(x) ?? x
    if (p === x) return x
    const r = find(p)
    parent.set(x, r)
    return r
  }
  for (const [a, b] of pairs) {
    start.set(a.id, a.startedAt)
    start.set(b.id, b.startedAt)
    parent.set(find(a.id), find(b.id))
  }
  const groups = new Map<string, string[]>()
  for (const id of start.keys()) {
    const r = find(id)
    groups.set(r, [...(groups.get(r) ?? []), id])
  }
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort((x, y) => start.get(x)! - start.get(y)!))
}

// ───── ③ 未结束的变化 ─────

/** 模型说哪些“留下的变化”还没结束、被哪件后来的事处理了：编号要存在，给用户看的话去掉编号 */
export function parseOpenChanges(
  raw: unknown,
  labeled: { label: string; event: HomiEvent }[],
): { openChanges: OpenChange[]; links: EventLink[] } {
  const obj = (raw ?? {}) as Record<string, unknown>
  const idOf = new Map(labeled.map((l) => [l.label, l.event.id]))
  const toId = (v: unknown) => (typeof v === 'string' ? idOf.get(v.trim().toUpperCase()) : undefined)
  const openChanges: OpenChange[] = []
  for (const o of Array.isArray(obj.open_changes) ? obj.open_changes : []) {
    const id = toId(o?.event)
    const text = clean(o?.text)
    if (id && text) openChanges.push({ eventId: id, text })
  }
  const links: EventLink[] = []
  for (const l of Array.isArray(obj.links) ? obj.links : []) {
    const from = toId(l?.from)
    const to = toId(l?.to)
    const relation = clean(l?.relation)
    if (from && to && from !== to && relation) links.push({ from, to, relation })
  }
  return { openChanges, links }
}

/** 把一组事件合成一件（留最早那件的 id）；描述、分类、关键图用看图确认的结果；留下的变化取最后一件写了的 */
export function mergeEventGroup(
  events: HomiEvent[],
  ids: string[],
  result: { summary: string; category: string | null; keyFrames: EventKeyFrame[] | null; reason: string },
): HomiEvent[] {
  const group = events.filter((e) => ids.includes(e.id)).sort((a, b) => a.startedAt - b.startedAt)
  if (group.length < 2) return events
  const [first] = group
  const decision: MergeDecision = { segmentId: group[1].segmentIds[0], same: true, reason: `统一整理：${result.reason}`, byRule: false }
  const merged: HomiEvent = {
    ...first,
    segmentIds: group.flatMap((e) => e.segmentIds),
    startedAt: Math.min(...group.map((e) => e.startedAt)),
    endedAt: Math.max(...group.map((e) => e.endedAt)),
    summary: result.summary || first.summary,
    verdict: group.reduce<HomiEvent['verdict']>((v, e) => maxVerdict(v, e.verdict), null),
    category: result.category || first.category,
    keyFrames: result.keyFrames ?? group.flatMap((e) => e.keyFrames),
    keyFrameStatus: result.keyFrames ? 'ok' : 'pending',
    left: [...group].reverse().find((e) => e.left)?.left ?? null,
    busy: false,
    decisions: [...group.flatMap((e) => e.decisions), decision],
  }
  return events.filter((e) => !ids.includes(e.id) || e.id === first.id).map((e) => (e.id === first.id ? merged : e))
}
