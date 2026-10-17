import { useState } from 'react'
import type { Segment } from '../motion/detector'
import type { Judgment } from '../ai/judge'
import type { FeedbackKind } from '../ai/feedback'
import type { HomeContext } from '../memory/types'
import type { ApplyResult, Draft } from '../memory/apply'
import { FeedbackSheet } from './FeedbackSheet'

export type Vote = 'agree' | 'disagree'

/**
 * 判断下方的反馈：两个大按钮「符合 / 不符合」+「其他」。
 * 点“不符合”后轻问一句原因，可忽略；“其他”直接进入输入页。
 */
export function FeedbackBar({
  event,
  judgment,
  ctx,
  onVote,
  onSave,
  onRejudge,
}: {
  event: Segment
  judgment: Judgment
  ctx: HomeContext
  onVote: (vote: Vote | null) => void
  onSave: (draft: Draft, note: string) => ApplyResult
  onRejudge: () => void
}) {
  const [vote, setVote] = useState<Vote | null>(null)
  const [askWhy, setAskWhy] = useState(false)
  const [sheet, setSheet] = useState<FeedbackKind | null>(null)
  const [saved, setSaved] = useState<{ label: string; text: string } | null>(null)

  const cast = (v: Vote | null) => {
    setVote(v)
    setAskWhy(v === 'disagree')
    onVote(v)
  }

  const handleSave = (draft: Draft, note: string): ApplyResult => {
    const res = onSave(draft, note)
    if (res.ok) {
      setSaved({ label: res.label, text: draft.intent === 'none' ? note : draft.text })
      setAskWhy(false)
    }
    return res
  }

  return (
    <div className="feedback">
      {vote === null && !saved && (
        <div className="vote-row">
          <button className="vote agree" onClick={() => cast('agree')}>符合</button>
          <button className="vote disagree" onClick={() => cast('disagree')}>不符合</button>
          <button className="vote-other" onClick={() => setSheet('other')}>
            {judgment.question ? '回答…' : '其他…'}
          </button>
        </div>
      )}

      {vote && (
        <p className="voted">
          已记下：{vote === 'agree' ? '符合 ✓' : '不符合'}
          <button className="link" onClick={() => cast(null)}>撤销</button>
        </p>
      )}

      {askWhy && !saved && (
        <p className="ask-why">
          要告诉 Homi 为什么吗？
          <button className="link" onClick={() => setSheet('disagree')}>告诉它</button>
          <button className="link muted" onClick={() => setAskWhy(false)}>不用了</button>
        </p>
      )}

      {saved && (
        <div className="saved">
          <p>
            <b>{saved.label}</b>
            {saved.text && <>：{saved.text}</>}
          </p>
          <button className="btn small" onClick={onRejudge}>用最新记忆重新判断这次事件</button>
        </div>
      )}

      {sheet && (
        <FeedbackSheet
          kind={sheet}
          event={event}
          judgment={judgment}
          ctx={ctx}
          onClose={() => setSheet(null)}
          onSave={handleSave}
        />
      )}
    </div>
  )
}
