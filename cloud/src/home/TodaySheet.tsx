import type { Homi } from '../core/useHomi'
import type { HomiEvent } from '../events/grouping'
import type { Segment } from '../motion/detector'
import { EventCard } from '../components/EventCard'
import { PendingList } from '../components/PendingList'
import { FeedbackSheet } from '../components/FeedbackSheet'
import { findLabel } from '../memory/categories'
import { isSameDay } from '../store/retention'
import { Sheet } from './Sheet'

const hm = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
const ALERT_STATUS = { open: '未处理', handled: '已处理', 'false-alarm': '误报' } as const

/** 过程里的一段（给用户看的简版：关键图 + Homi 的话，不放调试信息） */
function StepDetail({ seg, homi }: { seg: Segment; homi: Homi }) {
  const j = homi.analyses[seg.id]?.final
  const kf = homi.keyFrames[seg.id]
  const seq = [seg.before, ...seg.middle, seg.after]
  const frames = kf && 'frames' in kf ? kf.frames : [{ index: 0, note: '开始' }, { index: seq.length - 1, note: '结束' }]
  return (
    <div className="h-step">
      <div className="keyframes">
        {frames.map((k) =>
          seq[k.index] ? (
            <figure key={k.index} className="keyframe">
              <img src={seq[k.index].url} alt={k.note} />
              <figcaption>
                <b>{hm(seq[k.index].t)}</b> {k.note}
              </figcaption>
            </figure>
          ) : null,
        )}
      </div>
      {j?.change && <p className="h-muted">{j.change}</p>}
    </div>
  )
}

/**
 * “今天”（点 Homi 那一句话打开）：日报 → 需要您确认的事 → 今天的事件卡 → 更早的记录。
 * 平时不推送，用户自己点开看。
 */
export function TodaySheet({ homi, onClose }: { homi: Homi; onClose: () => void }) {
  const { report, events, segments, analyses, homeCtx, consolidation } = homi
  const today = events.filter((e) => isSameDay(e.startedAt, Date.now()))
  const segsOf = (ev: HomiEvent) => ev.segmentIds.map((id) => segments.find((s) => s.id === id)).filter((s): s is Segment => !!s)
  const card = (ev: HomiEvent) => {
    const segs = segsOf(ev)
    return segs.length ? (
      <EventCard
        key={ev.id}
        event={ev}
        categories={homeCtx.categories}
        segments={segs}
        judgmentOf={(id) => analyses[id]?.final ?? analyses[id]?.shown}
        snapOf={homi.snapOf}
        left={homi.leftOf(ev) ?? undefined}
        links={homi.linksOf(ev)}
        renderSegment={(s) => <StepDetail seg={s} homi={homi} />}
      />
    ) : null
  }
  const r = report.data
  const newer = r ? today.filter((e) => e.endedAt > r.at).length : 0

  return (
    <Sheet title="今天" onClose={onClose} wide>
      {/* 日报 */}
      <section className="h-report">
        <div className="h-row">
          <p className="h-headline">
            {r && !newer ? r.headline : today.length ? `今天记录了 ${today.length} 件事。` : '今天还没有画面变化。'}
          </p>
          <button className="h-secondary" onClick={() => void homi.generateReport('manual')} disabled={!!report.running}>
            {report.running ?? (r ? '更新到现在' : '写今天的日报')}
          </button>
        </div>
        {report.error && <p className="h-error">{report.error}</p>}
        {r && (
          <>
            <p className="h-muted">
              日报{r.trigger === 'timer' ? '（每晚定时）' : ''}写于 {hm(r.at)}
              {newer > 0 && `，之后又有 ${newer} 件事，点“更新到现在”重写`}
              {r.unconsolidated && '（这次没能先整理，按已经记下的事写的）'}
            </p>
            {newer > 0 && <p className="h-muted">上次日报：{r.headline}</p>}
            <ul className="h-groups">
              {r.groups.map((g) => {
                const c = findLabel(g.categoryId, homeCtx.categories)
                return (
                  <li key={g.categoryId}>
                    <span className="h-group-name">
                      {c.icon} {c.name} <small>{g.count} 件</small>
                    </span>
                    <span>{g.line}</span>
                  </li>
                )
              })}
            </ul>
            {r.alerts.length > 0 && (
              <>
                <h3>今天的提醒</h3>
                <ul className="h-list">
                  {r.alerts.map((a) => (
                    <li key={a.id}>
                      <b>{hm(a.at)}</b> {a.message} <span className={`h-pill status-${a.status}`}>{ALERT_STATUS[a.status]}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {r.openChanges.length > 0 && (
              <>
                <h3>还没结束的变化</h3>
                <ul className="h-list">
                  {r.openChanges.map((o) => (
                    <li key={`${o.eventId}-${o.text}`}>{o.text}</li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </section>

      {/* 需要您确认的事 */}
      <PendingList items={homi.pending} onDone={homi.markDone} onAnswer={homi.setAnswering} />
      {homi.answering && homi.answeringSeg && homi.answeringJudgment && (
        <FeedbackSheet
          kind="other"
          event={homi.answeringSeg}
          judgment={homi.answeringJudgment}
          ctx={homeCtx}
          onClose={() => homi.setAnswering(null)}
          onSave={(d, note) => {
            const res = homi.saveDraft(homi.answeringSeg!.id, d, note)
            if (res.ok) homi.markDone(homi.answering!.key)
            return res
          }}
        />
      )}

      {/* 今天的事件 */}
      <h3>今天发生的事</h3>
      {today.length === 0 && <p className="h-muted">还没有。摄像头开着时，画面有变化 Homi 会记下来。</p>}
      {[...today].reverse().map(card)}

      {/* 更早的记录（保留 7 天） */}
      {homi.earlierDays.map(([day, evs]) => (
        <details key={day} className="h-earlier">
          <summary>
            {day} · {evs.length} 件事
          </summary>
          {evs.map(card)}
        </details>
      ))}
    </Sheet>
  )
}
