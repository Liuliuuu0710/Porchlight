import type { HomiEvent } from '../events/grouping'
import { Panel } from './Panel'

const clock = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false })

const KIND = { same: '并入', separate: '单独成卡并关联', new: '另起一段' } as const

/**
 * 右侧调试栏：选中事件的合并依据（每个片段是怎么归进来的：按规则还是问了模型、模型的理由、耗时）。
 * 事件卡上不放这些，保持简洁。
 */
export function EventDebug({ event }: { event: HomiEvent | null }) {
  return (
    <Panel id="event-debug" title="选中的事件：合并依据" defaultOpen={false}>
      {!event ? (
        <p className="muted small">点左侧的事件卡查看。</p>
      ) : (
        <>
          <p className="small">
            {clock(event.startedAt)}–{clock(event.endedAt)} · {event.segmentIds.length} 段 · 关键图 {event.keyFrames.length} 张
            {event.keyFrameStatus === 'pending' && '（待选）'}
          </p>
          <ol className="debug-decisions">
            {event.decisions.map((d, i) => (
              <li key={`${d.segmentId}-${i}`}>
                <b>{d.byRule ? '按规则' : d.error ? '没能判断' : d.kind ? KIND[d.kind] : d.same ? '并入' : '另起'}</b>
                {d.error ? `：${d.error}，先单独成为一件事` : d.reason ? `：${d.reason}` : ''}
                {d.latencyMs !== undefined && <small className="muted"> · {(d.latencyMs / 1000).toFixed(1)} 秒</small>}
                {!!d.retries && <small className="muted"> · 选图重问 {d.retries} 次</small>}
              </li>
            ))}
          </ol>
        </>
      )}
    </Panel>
  )
}
