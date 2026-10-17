import { useState } from 'react'
import { PLAN_KIND_LABEL, planStatus, togglePlanEnabled, type HomeContext, type Plan } from '../memory/types'
import { toLocalInput } from '../ai/feedback'
import type { Draft } from '../memory/apply'
import { Sheet } from './Sheet'
import { DraftCard } from './DraftCard'
import { useSentenceDraft } from './useSentenceDraft'

const hm = (t: number) => {
  const d = new Date(t)
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  return d.toDateString() === new Date().toDateString() ? time : `${d.getMonth() + 1}月${d.getDate()}日 ${time}`
}

const KIND_HINT = { expect: '看到就告诉你', rule: '不按规定才提醒', relax: '这段时间不用提醒' } as const

/** 一张计划卡：直接改文字、识别特征、时间；开关；删除（再点一次确认） */
function PlanCard({ plan, onSave, onToggle, onDelete }: {
  plan: Plan
  onSave: (p: Plan) => string | null
  onToggle: () => void
  onDelete: () => void
}) {
  const [text, setText] = useState(plan.text)
  const [cues, setCues] = useState(plan.cues ?? '')
  const [start, setStart] = useState(toLocalInput(plan.start))
  const [end, setEnd] = useState(toLocalInput(plan.end))
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const dirty = text !== plan.text || cues !== (plan.cues ?? '') || start !== toLocalInput(plan.start) || end !== toLocalInput(plan.end)
  const status = planStatus(plan, Date.now(), hm)

  const save = () => {
    const s = new Date(start).getTime()
    const e = new Date(end).getTime()
    if (!text.trim()) return setError('内容不能是空的')
    if (!(e > s)) return setError('结束时间要晚于开始时间')
    setError(onSave({ ...plan, text: text.trim(), cues: plan.kind === 'expect' ? cues.trim() || undefined : plan.cues, start: s, end: e }))
  }

  return (
    <div className={`h-card ${plan.enabled ? '' : 'off'}`}>
      <div className="h-card-head">
        <span className="h-pill">{PLAN_KIND_LABEL[plan.kind]} · {KIND_HINT[plan.kind]}</span>
        <span className="h-muted">{status}</span>
      </div>
      <label>
        内容
        <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      {plan.kind === 'expect' && (
        <label>
          怎么认出来
          <input value={cues} placeholder="如：拿着纸盒子" onChange={(e) => setCues(e.target.value)} />
        </label>
      )}
      <div className="h-times">
        <label>
          开始
          <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label>
          结束
          <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
      </div>
      {error && <p className="h-error">{error}</p>}
      <div className="h-actions">
        {dirty && (
          <button className="h-primary" onClick={save}>
            保存修改
          </button>
        )}
        <button className="h-secondary" onClick={onToggle}>
          {plan.enabled ? '停用' : plan.matchedAt ? '重新开始等' : '启用'}
        </button>
        {confirmDelete ? (
          <>
            <button className="h-danger" onClick={onDelete}>
              确定删除
            </button>
            <button className="h-secondary" onClick={() => setConfirmDelete(false)}>
              不删了
            </button>
          </>
        ) : (
          <button className="h-link" onClick={() => setConfirmDelete(true)}>
            删除
          </button>
        )}
      </div>
    </div>
  )
}

/** 短期计划弹层（V2：时间变了直接改卡片；也可以用一句话新增） */
export function PlansSheet({
  ctx,
  onChange,
  onAdded,
  onClose,
}: {
  ctx: HomeContext
  onChange: (next: HomeContext) => void
  onAdded?: (draft: Draft) => void
  onClose: () => void
}) {
  const [input, setInput] = useState('')
  const sentence = useSentenceDraft(ctx, (next, draft) => {
    onChange(next)
    onAdded?.(draft)
    setInput('')
  })
  const plans = [...ctx.plans].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.start - b.start)
  const replace = (p: Plan) => onChange({ ...ctx, plans: ctx.plans.map((x) => (x.id === p.id ? p : x)) })

  return (
    <Sheet title="短期计划" description="临时的安排放在这里。时间变了，直接改卡片就好。" onClose={onClose}>
      {plans.length === 0 && <p className="h-muted">还没有计划。在下面说一句就能加。</p>}
      {plans.map((p) => (
        <PlanCard
          key={p.id}
          plan={p}
          onSave={(next) => (replace(next), null)}
          onToggle={() => replace(togglePlanEnabled(p))}
          onDelete={() => onChange({ ...ctx, plans: ctx.plans.filter((x) => x.id !== p.id) })}
        />
      ))}
      <SentenceBox
        placeholder="用一句话新增，如：明天下午有快递，到了告诉我"
        input={input}
        setInput={setInput}
        sentence={sentence}
      />
    </Sheet>
  )
}

/** 弹层底部的“说一句”输入框和草稿 */
export function SentenceBox({
  placeholder,
  input,
  setInput,
  sentence,
}: {
  placeholder: string
  input: string
  setInput: (v: string) => void
  sentence: ReturnType<typeof useSentenceDraft>
}) {
  const s = sentence.state
  return (
    <div className="h-sentence">
      {s.phase === 'draft' ? (
        <DraftCard
          reply={s.reply}
          draft={s.draft}
          error={s.error}
          onChange={sentence.change}
          onConfirm={sentence.confirm}
          onCancel={sentence.cancel}
        />
      ) : (
        <div className="h-sentence-row">
          <input
            value={input}
            placeholder={placeholder}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && void sentence.submit(input)}
            disabled={s.phase === 'thinking'}
          />
          <button className="h-primary" onClick={() => void sentence.submit(input)} disabled={!input.trim() || s.phase === 'thinking'}>
            {s.phase === 'thinking' ? '理解中…' : '告诉 Homi'}
          </button>
        </div>
      )}
      {s.phase === 'error' && <p className="h-error">{s.message}</p>}
    </div>
  )
}
