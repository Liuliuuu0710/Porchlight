import type { Draft } from '../memory/apply'
import type { PlanKind } from '../memory/types'

/**
 * 草稿卡：Homi 把一句话理解成计划或记忆后，先给用户看、可以改，确认后才保存。
 * 计划和记忆弹层、底部输入都用它。
 */
export function DraftCard({
  reply,
  draft,
  error,
  onChange,
  onConfirm,
  onCancel,
}: {
  reply: string
  draft: Draft
  error?: string | null
  onChange: (patch: Partial<Draft>) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const isPlan = draft.intent === 'plan_add' || draft.intent === 'plan_update'
  const isUpdate = draft.intent === 'memory_update' || draft.intent === 'plan_update'
  return (
    <div className="h-draft">
      <p className="h-homi">Homi：{reply}</p>
      {!isUpdate && (
        <label>
          保存为
          <select
            value={draft.intent === 'memory_add' ? 'memory' : (draft.planKind ?? 'rule')}
            onChange={(e) =>
              e.target.value === 'memory'
                ? onChange({ intent: 'memory_add' })
                : onChange({ intent: 'plan_add', planKind: e.target.value as PlanKind })
            }
          >
            <option value="expect">短期计划 · 等一件事（看到就告诉我）</option>
            <option value="rule">短期计划 · 规定（不按规定才提醒）</option>
            <option value="relax">短期计划 · 放宽（这段时间不用提醒）</option>
            <option value="memory">长期记忆</option>
          </select>
        </label>
      )}
      <label>
        {isUpdate ? '改成' : '内容'}
        <textarea rows={2} value={draft.text} onChange={(e) => onChange({ text: e.target.value })} />
      </label>
      {isPlan && draft.planKind === 'expect' && (
        <label>
          怎么认出来（可不填）
          <input value={draft.cues ?? ''} placeholder="如：拿着纸盒子" onChange={(e) => onChange({ cues: e.target.value })} />
        </label>
      )}
      {isPlan && (
        <div className="h-times">
          <label>
            开始
            <input type="datetime-local" value={draft.start} onChange={(e) => onChange({ start: e.target.value })} />
          </label>
          <label>
            结束
            <input type="datetime-local" value={draft.end} onChange={(e) => onChange({ end: e.target.value })} />
          </label>
        </div>
      )}
      {error && <p className="h-error">{error}</p>}
      <div className="h-actions">
        <button className="h-primary" onClick={onConfirm} disabled={!draft.text.trim()}>
          好的，保存
        </button>
        <button className="h-secondary" onClick={onCancel}>
          不保存
        </button>
      </div>
    </div>
  )
}
