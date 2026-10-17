import { Panel } from './Panel'
import { useState } from 'react'
import { planStatus, PLAN_KIND_LABEL, togglePlanEnabled, type HomeContext, type PlanKind } from '../memory/types'
import { applyDraft, type Draft } from '../memory/apply'
import { interpretInstruction } from '../ai/instruction'
import { toLocalInput } from '../ai/feedback'
import { GatewayError } from '../ai/gateway'

/** 今天只显示时分，其他日期带上月日 */
const hm = (t: number) => {
  const d = new Date(t)
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  return d.toDateString() === new Date().toDateString() ? time : `${d.getMonth() + 1}月${d.getDate()}日 ${time}`
}

const endOfToday = () => {
  const d = new Date()
  d.setHours(23, 59, 0, 0)
  return d.getTime()
}

type AddState =
  | { phase: 'idle' }
  | { phase: 'thinking' }
  | { phase: 'draft'; reply: string; draft: Draft }
  | { phase: 'error'; message: string }

/**
 * 计划与记忆：一句话添加（模型理解 → 草稿 → 确认），以及查看 / 开关。
 * onAdded：保存成功后回调（如新增期待型计划时请求浏览器通知权限）。
 */
export function ContextPanel({
  ctx,
  onChange,
  onAdded,
}: {
  ctx: HomeContext
  onChange: (ctx: HomeContext) => void
  onAdded?: (draft: Draft) => void
}) {
  const now = Date.now()
  const [input, setInput] = useState('')
  const [add, setAdd] = useState<AddState>({ phase: 'idle' })
  const [saveError, setSaveError] = useState<string | null>(null)

  const togglePlan = (id: string) =>
    onChange({ ...ctx, plans: ctx.plans.map((p) => (p.id === id ? togglePlanEnabled(p) : p)) })
  const toggleMemory = (id: string) =>
    onChange({ ...ctx, memories: ctx.memories.map((m) => (m.id === id ? { ...m, enabled: !m.enabled } : m)) })

  const submit = async () => {
    const text = input.trim()
    if (!text) return
    setAdd({ phase: 'thinking' })
    setSaveError(null)
    try {
      const r = await interpretInstruction(text, ctx)
      setAdd({
        phase: 'draft',
        reply: r.reply,
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
      setAdd({ phase: 'error', message: e instanceof GatewayError ? e.message : `没能理解：${(e as Error).message}` })
    }
  }

  const confirm = (draft: Draft) => {
    const res = applyDraft(ctx, draft)
    if (!res.ok) return setSaveError(res.error)
    onChange(res.ctx)
    onAdded?.(draft)
    setInput('')
    setAdd({ phase: 'idle' })
  }

  const d = add.phase === 'draft' ? add.draft : null
  const setD = (patch: Partial<Draft>) => add.phase === 'draft' && setAdd({ ...add, draft: { ...add.draft, ...patch } })

  return (
    <Panel id="context" title="计划与记忆">

      <div className="add-row">
        <input
          value={input}
          placeholder="例：今天有快递，快递员穿红色冲锋衣、拿纸盒子，到了告诉我"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && submit()}
          disabled={add.phase === 'thinking'}
        />
        <button className="btn small primary" onClick={submit} disabled={!input.trim() || add.phase === 'thinking'}>
          {add.phase === 'thinking' ? '理解中…' : '告诉 Homi'}
        </button>
      </div>
      {add.phase === 'error' && <p className="run-error">{add.message}</p>}

      {d && add.phase === 'draft' && (
        <div className="draft inline-draft">
          <p className="homi">Homi：{add.reply}</p>
          <label className="field">
            <span className="field-label">保存为</span>
            <select
              value={d.intent === 'memory_add' ? 'memory' : d.planKind}
              onChange={(e) =>
                e.target.value === 'memory'
                  ? setD({ intent: 'memory_add' })
                  : setD({ intent: 'plan_add', planKind: e.target.value as PlanKind })
              }
            >
              <option value="expect">短期计划 · 期待（看到就提醒我）</option>
              <option value="rule">短期计划 · 规定（不按规定才提醒）</option>
              <option value="relax">短期计划 · 放宽（这段时间不用提醒）</option>
              <option value="memory">长期记忆</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">内容</span>
            <textarea rows={2} value={d.text} onChange={(e) => setD({ text: e.target.value })} />
          </label>
          {d.intent === 'plan_add' && d.planKind === 'expect' && (
            <label className="field">
              <span className="field-label">识别特征（可选）</span>
              <textarea
                rows={2}
                value={d.cues ?? ''}
                placeholder="如：穿红色冲锋衣的人，拿着纸盒子"
                onChange={(e) => setD({ cues: e.target.value })}
              />
              <small>只用来认出这件事，不用来识别是谁；事件记录里不保存穿着</small>
            </label>
          )}
          {d.intent === 'plan_add' && (
            <div className="time-row">
              <label className="field">
                <span className="field-label">开始</span>
                <input type="datetime-local" value={d.start} onChange={(e) => setD({ start: e.target.value })} />
              </label>
              <label className="field">
                <span className="field-label">结束</span>
                <input type="datetime-local" value={d.end} onChange={(e) => setD({ end: e.target.value })} />
              </label>
            </div>
          )}
          {saveError && <p className="run-error">{saveError}</p>}
          <div className="sheet-actions">
            <button className="btn small" onClick={() => setAdd({ phase: 'idle' })}>
              取消
            </button>
            <button className="btn small primary" onClick={() => confirm(d)}>
              确认保存
            </button>
          </div>
        </div>
      )}

      <h3 className="sub">短期计划</h3>
      {ctx.plans.map((p) => {
        return (
          <label key={p.id} className="ctx-item">
            <input type="checkbox" checked={p.enabled} onChange={() => togglePlan(p.id)} />
            <span>
              <span className={`kind kind-${p.kind}`}>{PLAN_KIND_LABEL[p.kind]}</span> {p.text}
              {p.cues && <small>识别特征：{p.cues}</small>}
              <small>
                {hm(p.start)}–{hm(p.end)} · {planStatus(p, now, hm)}
              </small>
            </span>
          </label>
        )
      })}
      <h3 className="sub">长期记忆</h3>
      {ctx.memories.map((m) => (
        <label key={m.id} className="ctx-item">
          <input type="checkbox" checked={m.enabled} onChange={() => toggleMemory(m.id)} />
          <span>{m.text}</span>
        </label>
      ))}
    </Panel>
  )
}
