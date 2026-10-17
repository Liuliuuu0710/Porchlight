/**
 * 紧急提问要不要推送（《产品逻辑》3.2 第 4 种：很可能是用户在等的事 / 违反规则，但看不清 → 马上问）。
 * 几个片段会同时分析，每个片段开始分析时拿的是当时的计划：前一个片段刚确认“送快递的人到了”，
 * 后面的片段可能还按“在等”来判断、又来问。所以提问发出前要按现在的计划再查一次，并且同一件事只留一条。
 */
import { isPlanActive, type HomeContext } from '../memory/types.ts'

export interface UrgentQuestionInput {
  question: string | null
  questionUrgent: boolean
  questionAbout?: string | null
  expected: { id: string; matched: boolean }[]
}

/** 还没回答的紧急提问（提醒条上的） */
export interface OpenQuestion {
  id: string
  about: string | null
}

export type UrgentDecision =
  /** 不推送：不是紧急提问 / 已按期待型提醒过 / 问的事用户已经知道了 */
  | { kind: 'skip'; reason: string }
  /** 同一件事已经有一条没回答的提问：更新那一条，不再通知 */
  | { kind: 'update'; id: string; about: string | null }
  /** 新的提问：显示并通知 */
  | { kind: 'new'; about: string | null }

/** 已经到达（或停用、过了时段）的期待型计划：用户已经知道了，不用再问 */
function settledPlan(id: string, ctx: HomeContext, now: number): boolean {
  const p = ctx.plans.find((x) => `plan:${x.id}` === id)
  return !!p && p.kind === 'expect' && (!!p.matchedAt || !isPlanActive(p, now))
}

export function decideUrgentQuestion(j: UrgentQuestionInput, ctx: HomeContext, open: OpenQuestion[], now: number): UrgentDecision {
  if (!j.questionUrgent || !j.question) return { kind: 'skip', reason: '不是紧急提问' }
  if (j.expected.some((e) => e.matched)) return { kind: 'skip', reason: '已经按期待型提醒过' }
  const about = j.questionAbout ?? null
  if (about && settledPlan(about, ctx, now)) return { kind: 'skip', reason: '问的这件事已经到达，用户已经知道了' }
  // 模型没说问的是哪条：这次对照的期待型计划现在都已经到达了，也不再问
  if (!about && j.expected.length > 0 && j.expected.every((e) => settledPlan(e.id, ctx, now))) {
    return { kind: 'skip', reason: '对照的计划都已经到达，用户已经知道了' }
  }
  const same = about ? open.find((q) => q.about === about) : undefined
  return same ? { kind: 'update', id: same.id, about } : { kind: 'new', about }
}
