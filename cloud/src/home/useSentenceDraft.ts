import { useState } from 'react'
import { interpretInstruction } from '../ai/instruction'
import { toLocalInput } from '../ai/feedback'
import { GatewayError } from '../ai/gateway'
import { applyDraft, type Draft } from '../memory/apply'
import type { HomeContext } from '../memory/types'

const endOfToday = () => {
  const d = new Date()
  d.setHours(23, 59, 0, 0)
  return d.getTime()
}

export type SentenceState =
  | { phase: 'idle' }
  | { phase: 'thinking' }
  | { phase: 'draft'; reply: string; draft: Draft; error: string | null }
  | { phase: 'error'; message: string }

/** 一句话 → Homi 理解成计划或记忆草稿 → 用户改、确认后保存（计划 / 记忆弹层里用） */
export function useSentenceDraft(ctx: HomeContext, onSaved: (next: HomeContext, draft: Draft) => void) {
  const [state, setState] = useState<SentenceState>({ phase: 'idle' })

  const submit = async (text: string) => {
    if (!text.trim()) return
    setState({ phase: 'thinking' })
    try {
      const r = await interpretInstruction(text.trim(), ctx)
      setState({
        phase: 'draft',
        reply: r.reply,
        error: null,
        draft: {
          intent: r.intent,
          text: r.text,
          targetId: null,
          planKind: r.planKind,
          cues: r.cues ?? '',
          start: r.start ?? toLocalInput(Date.now()),
          end: r.end ?? toLocalInput(endOfToday()),
        },
      })
    } catch (e) {
      setState({ phase: 'error', message: e instanceof GatewayError ? e.message : `没能理解：${(e as Error).message}` })
    }
  }

  const change = (patch: Partial<Draft>) =>
    setState((s) => (s.phase === 'draft' ? { ...s, draft: { ...s.draft, ...patch }, error: null } : s))

  const confirm = () => {
    if (state.phase !== 'draft') return false
    const res = applyDraft(ctx, state.draft)
    if (!res.ok) {
      setState({ ...state, error: res.error })
      return false
    }
    onSaved(res.ctx, state.draft)
    setState({ phase: 'idle' })
    return true
  }

  const cancel = () => setState({ phase: 'idle' })

  return { state, submit, change, confirm, cancel }
}
