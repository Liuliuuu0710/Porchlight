import type { ReactNode } from 'react'
import type { DailyReport } from '../events/report'
import type { HomiEvent } from '../events/grouping'
import { findLabel, type Category } from '../memory/categories'

const clock = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

const ALERT_STATUS = { open: '未处理', handled: '已处理', 'false-alarm': '误报' } as const

/**
 * 今天的日报（《产品逻辑》3.5）：一句话总结 → 按分类分组（每组一句小结 + 数量 + 时间范围，点开是事件）
 * → 今天的提醒 → 值得看一眼 → 还没结束的变化 → Homi 想问你（在下面的待确认里回答）。
 */
export function ReportPanel({
  report,
  running,
  error,
  events,
  categories,
  onGenerate,
  renderEvent,
}: {
  report: DailyReport | null
  running: string | null
  error: string | null
  events: HomiEvent[]
  categories: Category[]
  onGenerate: () => void
  /** 点开分组后显示的事件卡片 */
  renderEvent: (ev: HomiEvent) => ReactNode
}) {
  const eventById = (id: string) => events.find((e) => e.id === id)
  return (
    <section className="panel report">
      <div className="panel-head">
        <h2>
          今天的日报
          {report && (
            <small>
              {' '}
              · {report.trigger === 'timer' ? '每晚定时' : '今天到目前为止'}，{clock(report.at)} 生成
            </small>
          )}
        </h2>
        <button className="btn small" onClick={onGenerate} disabled={!!running}>
          {running ? running : report ? '更新到现在' : '生成日报'}
        </button>
      </div>
      {error && <p className="run-error">{error}</p>}
      {!report && !running && <p className="muted small">每晚 21:00 自动生成；也可以现在生成“今天到目前为止”。生成前会先把今天的事件整理一遍。</p>}
      {report && (
        <>
          <p className="report-headline">{report.headline}</p>
          {report.unconsolidated && <p className="muted small">写日报前的整理没成功，这份日报按实时合并好的事件写的。</p>}

          {report.groups.map((g) => {
            const c = findLabel(g.categoryId, categories)
            const evs = g.eventIds.map(eventById).filter((e): e is HomiEvent => !!e)
            return (
              <details key={g.categoryId} className="report-group">
                <summary>
                  <span className="report-group-name">
                    {c.icon} {c.name}
                  </span>
                  <span className="report-group-line">{g.line}</span>
                  <small className="muted">
                    {g.count} 件 · {clock(g.from)}–{clock(g.to)}
                  </small>
                </summary>
                {evs.map((e) => (
                  <div key={e.id}>{renderEvent(e)}</div>
                ))}
                {evs.length < g.count && <p className="muted small">有 {g.count - evs.length} 件的截图已清除</p>}
              </details>
            )
          })}

          {report.alerts.length > 0 && (
            <div className="report-section">
              <h3>今天的提醒</h3>
              <ul>
                {report.alerts.map((a) => (
                  <li key={a.id}>
                    <b>{clock(a.at)}</b> {a.message} <span className={`tag report-alert-${a.status}`}>{ALERT_STATUS[a.status]}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report.notices.length > 0 && (
            <div className="report-section">
              <h3>值得看一眼</h3>
              <ul>
                {report.notices.map(eventById).map(
                  (e) =>
                    e && (
                      <li key={e.id}>
                        <b>{clock(e.startedAt)}</b> {e.summary}
                      </li>
                    ),
                )}
              </ul>
            </div>
          )}

          {report.openChanges.length > 0 && (
            <div className="report-section">
              <h3>还没结束的变化</h3>
              <ul>
                {report.openChanges.map((o) => (
                  <li key={`${o.eventId}-${o.text}`}>{o.text}</li>
                ))}
              </ul>
            </div>
          )}

          {report.questions.length > 0 && (
            <div className="report-section">
              <h3>Homi 想问你</h3>
              <ul>
                {report.questions.map((q) => (
                  <li key={q.key}>{q.text}</li>
                ))}
              </ul>
              <p className="muted small">在下面“需要您确认”里回答。</p>
            </div>
          )}
        </>
      )}
    </section>
  )
}
