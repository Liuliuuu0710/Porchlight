import { useState, type ReactNode } from 'react'
import type { EventKeyFrame, HomiEvent } from '../events/grouping'
import type { Segment, Snapshot } from '../motion/detector'
import type { Judgment } from '../ai/judge'
import { VERDICT_LABEL } from './SegmentCard'
import { findCategory, type Category } from '../memory/categories'

const clock = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false })
const hm = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

function duration(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.round(s / 60)
  return m < 60 ? `约 ${m} 分钟` : `约 ${(m / 60).toFixed(1)} 小时`
}

/**
 * 事件卡（《产品逻辑》3.1.1a）：以简洁为主——一句话、整件事的关键图、一条细时间条；
 * “过程”默认收起，展开后每段一行（时间 + 一句话 + 档位），重要的那行高亮，点一行才展开这一段的完整卡片（调试用）。
 * 合并依据不在卡片上，点卡片后在右侧调试栏看。
 */
export function EventCard({
  event,
  categories,
  segments,
  judgmentOf,
  snapOf,
  left,
  links = [],
  selected = false,
  onSelect,
  renderSegment,
}: {
  event: HomiEvent
  categories: Category[]
  /** 组成这件事的片段（按时间先后；截图已清除的不在里面） */
  segments: Segment[]
  judgmentOf: (segmentId: string) => Judgment | undefined
  snapOf: (ref: EventKeyFrame) => Snapshot | undefined
  /** 统一整理时记下的“留下的变化” */
  left?: string
  /** 和别的事的关联（已写成一句话） */
  links?: string[]
  selected?: boolean
  onSelect?: () => void
  /** 展开某一段时显示的完整片段卡片；不传就不显示“过程”（如日报里） */
  renderSegment?: (s: Segment) => ReactNode
}) {
  const [openSeg, setOpenSeg] = useState<string | null>(null)
  const cat = findCategory(event.category, categories)
  const span = Math.max(1, event.endedAt - event.startedAt)
  const pos = (t: number) => `${(((t - event.startedAt) / span) * 100).toFixed(2)}%`

  return (
    <article className={`event-card ec-${event.verdict ?? 'none'} ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <header className="ec-head">
        <span className="event-time">
          {hm(event.startedAt)}–{hm(event.endedAt)}
        </span>
        <span className="muted small">{duration(event.endedAt - event.startedAt)}</span>
        <span className="tag" title={cat.desc}>
          {cat.icon} {cat.name}
        </span>
        {event.verdict && event.verdict !== 'record' && (
          <span className={`verdict v-${event.verdict}`}>{VERDICT_LABEL[event.verdict]}</span>
        )}
        {event.busy && (
          <span className="muted small status-busy">
            <i className="spinner" aria-hidden /> 整理中…
          </span>
        )}
      </header>

      <p className="ec-summary">{event.summary}</p>

      {event.keyFrames.length > 0 && (
        <div className="keyframes ec-keyframes">
          {event.keyFrames.map((k) => {
            const snap = snapOf(k)
            return snap ? (
              <figure key={`${k.segmentId}-${k.index}`} className="keyframe">
                <img src={snap.url} alt={k.note || '关键图'} />
                <figcaption>
                  <b>{hm(snap.t)}</b> {k.note}
                </figcaption>
              </figure>
            ) : null
          })}
        </div>
      )}

      {segments.length > 1 && (
        <div className="ec-timeline" title="每一格是一段画面变化，空白是画面没变（人离开或停着不动）">
          {segments.map((s) => {
            const v = judgmentOf(s.id)?.verdict
            return (
              <i
                key={s.id}
                className={`ec-tick ec-tick-${v ?? 'none'}`}
                style={{ left: pos(s.startedAt), width: `max(3px, calc(${pos(s.endedAt)} - ${pos(s.startedAt)}))` }}
              />
            )
          })}
        </div>
      )}

      {left && <p className="small ec-left">留下的变化：{left}</p>}
      {links.map((l) => (
        <p key={l} className="small muted ec-link">
          🔗 {l}
        </p>
      ))}
      {event.keyFrameStatus === 'pending' && <p className="muted small">关键图还没选好，统一整理时再选</p>}

      {renderSegment && segments.length > 0 && (
        <details className="ec-process" onClick={(e) => e.stopPropagation()}>
          <summary>过程（{segments.length} 段）</summary>
          <ol>
            {segments.map((s) => {
              const j = judgmentOf(s.id)
              const important = j?.verdict === 'notice' || j?.verdict === 'alert'
              return (
                <li key={s.id} className={important ? 'ec-step important' : 'ec-step'}>
                  <button className="ec-step-row" onClick={() => setOpenSeg((o) => (o === s.id ? null : s.id))}>
                    <span className="ec-step-time">{clock(s.startedAt)}</span>
                    <span className="ec-step-text">{j?.message || j?.change || '分析中…'}</span>
                    {j && <span className={`verdict v-${j.verdict}`}>{VERDICT_LABEL[j.verdict]}</span>}
                    <span className="muted">{openSeg === s.id ? '收起' : '›'}</span>
                  </button>
                  {openSeg === s.id && <div className="ec-step-detail">{renderSegment(s)}</div>}
                </li>
              )
            })}
          </ol>
        </details>
      )}
    </article>
  )
}
