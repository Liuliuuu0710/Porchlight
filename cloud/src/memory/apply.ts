import type { Intent } from '../ai/feedback'
import type { HomeContext, PlanKind } from './types'

/** 草稿的意图：反馈理解的那几种，加上“修改一条计划”（底部输入用：如“把快递那条改到明天”） */
export type DraftIntent = Intent | 'plan_update'

/** 用户在草稿卡片上确认（可能修改过）的内容 */
export interface Draft {
  intent: DraftIntent
  text: string
  targetId: string | null
  /** YYYY-MM-DDTHH:mm，本地时间 */
  start: string
  end: string
  /** 新增计划时的类型，默认“规定” */
  planKind?: PlanKind
  /** 期待型的识别特征 */
  cues?: string
}

export type ApplyResult = { ok: true; ctx: HomeContext; label: string; ref: string } | { ok: false; error: string }

function nextId(prefix: string, ids: string[]) {
  const max = ids.reduce((n, id) => Math.max(n, Number(id.slice(prefix.length)) || 0), 0)
  return `${prefix}${max + 1}`
}

/** 把草稿写入计划 / 记忆；校验失败时返回错误信息，不修改数据 */
export function applyDraft(ctx: HomeContext, draft: Draft): ApplyResult {
  const text = draft.text.trim()
  if (draft.intent !== 'none' && !text) return { ok: false, error: '内容不能为空' }

  switch (draft.intent) {
    case 'memory_add': {
      const id = nextId('m', ctx.memories.map((m) => m.id))
      return {
        ok: true,
        ctx: { ...ctx, memories: [...ctx.memories, { id, text, enabled: true }] },
        label: '已存为长期记忆',
        ref: `memory:${id}`,
      }
    }
    case 'memory_update': {
      const target = ctx.memories.find((m) => m.id === draft.targetId)
      if (!target) return { ok: false, error: '请选择要修改的记忆' }
      return {
        ok: true,
        ctx: { ...ctx, memories: ctx.memories.map((m) => (m.id === target.id ? { ...m, text, enabled: true } : m)) },
        label: `已修改记忆 ${target.id}`,
        ref: `memory:${target.id}`,
      }
    }
    case 'plan_add': {
      const start = new Date(draft.start).getTime()
      const end = new Date(draft.end).getTime()
      if (Number.isNaN(start) || Number.isNaN(end)) return { ok: false, error: '请填写开始和结束时间' }
      if (end <= start) return { ok: false, error: '结束时间要晚于开始时间' }
      const kind = draft.planKind ?? 'rule'
      const cues = draft.cues?.trim()
      const id = nextId('p', ctx.plans.map((p) => p.id))
      return {
        ok: true,
        ctx: {
          ...ctx,
          plans: [...ctx.plans, { id, kind, text, ...(kind === 'expect' && cues ? { cues } : {}), start, end, enabled: true }],
        },
        label: kind === 'expect' ? '已新增期待型计划（看到就提醒你）' : '已新增短期计划',
        ref: `plan:${id}`,
      }
    }
    case 'plan_update': {
      const target = ctx.plans.find((p) => p.id === draft.targetId)
      if (!target) return { ok: false, error: '请选择要修改的计划' }
      const start = new Date(draft.start).getTime()
      const end = new Date(draft.end).getTime()
      if (Number.isNaN(start) || Number.isNaN(end)) return { ok: false, error: '请填写开始和结束时间' }
      if (end <= start) return { ok: false, error: '结束时间要晚于开始时间' }
      const cues = draft.cues?.trim()
      return {
        ok: true,
        ctx: {
          ...ctx,
          plans: ctx.plans.map((p) =>
            p.id === target.id
              ? { ...p, text, start, end, enabled: true, ...(p.kind === 'expect' ? { cues: cues || p.cues } : {}) }
              : p,
          ),
        },
        label: `已修改计划 ${target.id}`,
        ref: `plan:${target.id}`,
      }
    }
    case 'none':
      return { ok: true, ctx, label: '已记录反馈，未保存记忆', ref: '' }
  }
}
