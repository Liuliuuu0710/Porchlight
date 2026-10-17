/**
 * 每日报告（见《产品逻辑》3.5）里不调用模型的部分：按分类分组、挑问题、校验模型写的文字、判断该不该定时生成。
 *
 * 报告结构：开头一句话总结 → 按分类分组（每组一句小结 + 数量 + 时间范围，点开是事件）
 * → 今天的提醒（已处理 / 未处理）→ 值得看一眼 → 还没结束的变化 → Homi 想问你（每天最多 3 个）。
 */
import type { HomiEvent } from './grouping.ts'
import type { OpenChange } from './consolidate.ts'

/** 每天几点自动生成（用户点击时随时生成“今天到目前为止”） */
export const REPORT_HOUR = 21
/** 不紧急的提问每天最多问几个 */
export const MAX_QUESTIONS = 3

export interface ReportGroup {
  categoryId: string
  /** 模型写的一句小结 */
  line: string
  count: number
  from: number
  to: number
  /** 按时间先后 */
  eventIds: string[]
}

export interface ReportAlert {
  id: string
  at: number
  message: string
  /** open：还没处理；handled：用户点了“知道了 / 已处理”；false-alarm：用户说是误报 */
  status: 'open' | 'handled' | 'false-alarm'
  /** 提醒来自哪个片段（系统提醒为 null）；生成日报时换成所在事件 */
  segmentId: string | null
  eventId: string | null
}

export interface ReportQuestion {
  key: string
  segmentId: string
  text: string
}

export interface DailyReport {
  at: number
  trigger: 'manual' | 'timer'
  headline: string
  groups: ReportGroup[]
  alerts: ReportAlert[]
  /** “留意”档的事件 */
  notices: string[]
  openChanges: OpenChange[]
  questions: ReportQuestion[]
  /** 写日报前的整理没成功：照样按实时合并好的事件写，并标出来（旧日报没有这个字段） */
  unconsolidated?: boolean
}

/**
 * 按分类分组：事件多的组排前面，组内按时间先后。
 * keyOf：按什么分组（日报按大类：分类 → 大类 id；不给就按分类）；分组的 categoryId 就是这个 key
 */
export function groupByCategory(events: HomiEvent[], keyOf: (category: string) => string = (c) => c): Omit<ReportGroup, 'line'>[] {
  const by = new Map<string, HomiEvent[]>()
  for (const e of [...events].sort((a, b) => a.startedAt - b.startedAt)) {
    const k = keyOf(e.category)
    by.set(k, [...(by.get(k) ?? []), e])
  }
  return [...by.entries()]
    .map(([categoryId, es]) => ({
      categoryId,
      count: es.length,
      from: es[0].startedAt,
      to: Math.max(...es.map((e) => e.endedAt)),
      eventIds: es.map((e) => e.id),
    }))
    .sort((a, b) => b.count - a.count || a.from - b.from)
}

/** 去掉明显重复的问题（去掉标点和空白后相同） */
export function dedupeQuestions(qs: ReportQuestion[]): ReportQuestion[] {
  const norm = (s: string) => s.replace(/[\s，。？！、,.?!“”"'：:；;（）()]/g, '')
  const seen = new Set<string>()
  return qs.filter((q) => {
    const k = norm(q.text)
    if (!k || seen.has(k)) return false
    seen.add(k)
    return true
  })
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() && v !== 'null' ? v.trim() : null)

/**
 * 校验模型写的报告文字：一句话总结；每组一句小结（按分类 id 对上，缺的用“共 N 件”兜底）；
 * 问题按编号 Q1… 挑，最多 3 个、不重复，编号不存在的丢掉。
 */
export function parseReportText(
  raw: unknown,
  groups: Omit<ReportGroup, 'line'>[],
  questions: ReportQuestion[],
): { headline: string; groups: ReportGroup[]; questions: ReportQuestion[] } {
  const obj = (raw ?? {}) as Record<string, unknown>
  const lines = new Map<string, string>()
  for (const g of Array.isArray(obj.groups) ? obj.groups : []) {
    const id = str(g?.category)
    const line = str(g?.line)
    if (id && line && !lines.has(id)) lines.set(id, line)
  }
  const picked: ReportQuestion[] = []
  for (const q of Array.isArray(obj.questions) ? obj.questions : []) {
    const n = Number(String(q ?? '').replace(/^Q/i, ''))
    const item = Number.isInteger(n) ? questions[n - 1] : undefined
    if (item && !picked.includes(item) && picked.length < MAX_QUESTIONS) picked.push(item)
  }
  return {
    headline: str(obj.headline) ?? `今天记录了 ${groups.reduce((s, g) => s + g.count, 0)} 件事。`,
    groups: groups.map((g) => ({ ...g, line: lines.get(g.categoryId) ?? `共 ${g.count} 件` })),
    questions: picked,
  }
}

/** 定时生成：到了 REPORT_HOUR 点，且今天还没定时生成过 */
export function isReportDue(now: number, lastTimerReportAt: number | null, hour = REPORT_HOUR): boolean {
  const d = new Date(now)
  if (d.getHours() < hour) return false
  if (lastTimerReportAt === null) return true
  return new Date(lastTimerReportAt).toDateString() !== d.toDateString()
}
