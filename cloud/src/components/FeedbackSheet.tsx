import { useEffect, useRef, useState } from 'react'
import type { Segment } from '../motion/detector'
import type { Judgment } from '../ai/judge'
import { interpretFeedback, toLocalInput, type FeedbackKind, type Intent, type Interpretation } from '../ai/feedback'
import { GatewayError } from '../ai/gateway'
import type { HomeContext } from '../memory/types'
import type { ApplyResult, Draft } from '../memory/apply'

const INTENT_LABEL: Record<Intent, string> = {
  memory_add: '存为新的长期记忆',
  memory_update: '修改一条已有记忆',
  plan_add: '新增短期计划',
  none: '不保存，只记下这次反馈',
}

type Phase =
  | { name: 'input' }
  | { name: 'interpreting' }
  | { name: 'draft'; interp: Interpretation }
  | { name: 'error'; message: string }

function endOfToday() {
  const d = new Date()
  d.setHours(23, 59, 0, 0)
  return d.getTime()
}

/**
 * 反馈输入页：文字（语音在第 6 步接入）→ 模型理解 → 草稿卡片 → 用户确认后保存。
 */
export function FeedbackSheet({
  kind,
  event,
  judgment,
  ctx,
  onClose,
  onSave,
}: {
  kind: FeedbackKind
  event: Segment
  judgment: Judgment
  ctx: HomeContext
  onClose: () => void
  /** 返回保存结果；失败时草稿保持打开并显示原因 */
  onSave: (draft: Draft, note: string) => ApplyResult
}) {
  const [mode, setMode] = useState<'text' | 'voice'>('text')
  const [note, setNote] = useState('')
  const [phase, setPhase] = useState<Phase>({ name: 'input' })
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const send = async () => {
    const text = note.trim()
    if (!text) return
    setPhase({ name: 'interpreting' })
    try {
      const interp = await interpretFeedback({ kind, text, judgment, ctx })
      setDraft({
        intent: interp.intent,
        text: interp.text ?? text,
        targetId: interp.targetId ?? ctx.memories[0]?.id ?? null,
        start: interp.start ?? toLocalInput(Date.now()),
        end: interp.end ?? toLocalInput(endOfToday()),
      })
      setSaveError(null)
      setPhase({ name: 'draft', interp })
    } catch (e) {
      setPhase({
        name: 'error',
        message: e instanceof GatewayError ? e.message : `没能理解这条反馈：${(e as Error).message}`,
      })
    }
  }

  const save = (d: Draft) => {
    const res = onSave(d, note.trim())
    if (res.ok) onClose()
    else setSaveError(res.error)
  }

  const title =
    kind === 'disagree' ? '告诉 Homi 哪里不对' : judgment.question ? '回答 Homi 的问题' : '告诉 Homi 你的想法'

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>{title}</h2>
          <button className="link" onClick={onClose}>关闭</button>
        </header>

        <div className="sheet-context">
          <img src={event.before.url} alt="变化前" />
          <img src={event.after.url} alt="变化后" />
          <div>
            <p className="homi">Homi：{judgment.message}</p>
            {judgment.question && <p className="question">问：{judgment.question}</p>}
          </div>
        </div>

        {(phase.name === 'input' || phase.name === 'error') && (
          <>
            <div className="composer">
              <button
                className="mode-toggle"
                onClick={() => setMode((m) => (m === 'text' ? 'voice' : 'text'))}
                aria-label={mode === 'text' ? '切换到语音' : '切换到文字'}
              >
                {mode === 'text' ? '🎤' : '⌨'}
              </button>
              {mode === 'text' ? (
                <textarea
                  ref={inputRef}
                  value={note}
                  rows={3}
                  placeholder={
                    kind === 'disagree'
                      ? '比如：这是我自己放的，以后放这里都正常'
                      : '比如：这周末我出差，快递放左边柜子里'
                  }
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send()
                  }}
                />
              ) : (
                <div className="voice-placeholder">按住说话（第 6 步接入语音识别），先用文字输入</div>
              )}
            </div>
            {phase.name === 'error' && <p className="run-error">{phase.message}</p>}
            <div className="sheet-actions">
              <button className="btn primary" disabled={!note.trim() || mode === 'voice'} onClick={send}>
                发送
              </button>
            </div>
          </>
        )}

        {phase.name === 'interpreting' && <p className="muted">Homi 正在理解…</p>}

        {phase.name === 'draft' && draft && (
          <div className="draft">
            <p className="you">你：{note}</p>
            <p className="homi">Homi：{phase.interp.reply}</p>

            <label className="field">
              <span className="field-label">Homi 打算</span>
              <select value={draft.intent} onChange={(e) => setDraft({ ...draft, intent: e.target.value as Intent })}>
                {(Object.keys(INTENT_LABEL) as Intent[]).map((i) => (
                  <option key={i} value={i} disabled={i === 'memory_update' && ctx.memories.length === 0}>
                    {INTENT_LABEL[i]}
                  </option>
                ))}
              </select>
            </label>

            {draft.intent === 'memory_update' && (
              <label className="field">
                <span className="field-label">修改哪一条</span>
                <select value={draft.targetId ?? ''} onChange={(e) => setDraft({ ...draft, targetId: e.target.value })}>
                  {ctx.memories.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}：{m.text}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {draft.intent !== 'none' && (
              <label className="field">
                <span className="field-label">{draft.intent === 'plan_add' ? '计划内容' : '记忆内容'}</span>
                <textarea value={draft.text} rows={2} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
              </label>
            )}

            {draft.intent === 'plan_add' && (
              <div className="time-row">
                <label className="field">
                  <span className="field-label">开始</span>
                  <input type="datetime-local" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} />
                </label>
                <label className="field">
                  <span className="field-label">结束</span>
                  <input type="datetime-local" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} />
                </label>
              </div>
            )}

            {saveError && <p className="run-error">{saveError}</p>}

            <div className="sheet-actions">
              <button className="btn" onClick={() => setPhase({ name: 'input' })}>
                重新说
              </button>
              <button className="btn" onClick={() => save({ ...draft, intent: 'none' })}>
                不保存
              </button>
              <button className="btn primary" onClick={() => save(draft)}>
                {draft.intent === 'none' ? '好的' : '确认保存'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
