import { useState } from 'react'
import type { Segment, Snapshot } from '../motion/detector'
import type { Box } from '../motion/state-machine'
import type { Judgment } from '../ai/judge'
import type { Analysis } from '../ai/pipeline'
import type { HomeContext } from '../memory/types'
import type { ApplyResult, Draft } from '../memory/apply'
import { FeedbackBar, type Vote } from './FeedbackBar'
import { findCategory } from '../memory/categories'
import type { KeyFrameResult } from '../ai/keyframes'

const pct = (v: number) => `${(v * 100).toFixed(1)}%`
const clock = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false })

function Shot({ snap, label, box }: { snap: Snapshot; label: string; box?: Box | null }) {
  return (
    <figure className="shot">
      <div className="shot-img">
        <img src={snap.url} alt={label} />
        {box && (
          <div
            className="change-box"
            style={{ left: pct(box.x), top: pct(box.y), width: pct(box.w), height: pct(box.h) }}
          />
        )}
      </div>
      <figcaption>
        {label} · {clock(snap.t)}
      </figcaption>
    </figure>
  )
}

/** 摔倒“再看一眼”的进度（显示在片段卡片上） */
export interface FallWatch {
  state: 'waiting' | 'checking' | 'up' | 'alerted' | 'handled' | 'false-alarm' | 'stopped'
  round: number
  dueAt?: number
  evidence?: string
}

const FALL_STATE: Record<FallWatch['state'], string> = {
  waiting: '疑似有人摔倒，30 秒后再看一眼',
  checking: '正在再看一眼…',
  up: '再看一眼：已经起来了，只做记录',
  alerted: '再看一眼：还在地上，已紧急提醒',
  handled: '紧急提醒已处理',
  'false-alarm': '已标记为误报',
  stopped: '画面已切换，已停止再看',
}

export const VERDICT_LABEL = { record: '记录', notice: '留意', alert: '提醒' } as const

export function resolveBasis(ref: string, ctx: HomeContext) {
  const [kind, id] = ref.split(':')
  const item = kind === 'plan' ? ctx.plans.find((p) => p.id === id) : ctx.memories.find((m) => m.id === id)
  return item ? item.text : '（未找到，模型可能编造了引用）'
}

/** Homi 的判断：只展示结论，不展示用了哪个模型（模型细节在右侧调试栏） */
function JudgmentView({ analysis, ctx }: { analysis: Analysis; ctx: HomeContext }) {
  const j: Judgment | undefined = analysis.shown
  const busy = analysis.status === 'queued' || analysis.status === 'analyzing' || analysis.status === 'reviewing'
  const busyLabel = { queued: '排队中…', analyzing: '分析中…', reviewing: '复核中…' } as Record<string, string>
  return (
    <div className={`run run-${j?.verdict ?? analysis.status}`}>
      <div className="run-head">
        {j && <span className={`verdict v-${j.verdict}`}>{VERDICT_LABEL[j.verdict]}</span>}
        {j && (
          <span className="tag muted small">
            {findCategory(j.category, ctx.categories).icon} {findCategory(j.category, ctx.categories).name}
          </span>
        )}
        {busy && (
          <span className="muted small status-busy">
            <i className="spinner" aria-hidden /> {busyLabel[analysis.status]}
          </span>
        )}
      </div>
      {j && (
        <>
          <p className="homi">Homi：{j.message}</p>
          {j.question && <p className="question">{j.questionUrgent ? '马上问' : '之后再问'}：{j.question}</p>}
          <p className="small">变化：{j.change}</p>
          {j.basis.length > 0 && (
            <ul className="basis">
              {j.basis.map((b) => (
                <li key={b}>依据：{resolveBasis(b, ctx)}</li>
              ))}
            </ul>
          )}
        </>
      )}
      {analysis.status === 'error' && <p className="run-error">{analysis.error}</p>}
    </div>
  )
}

const END_REASON = { settled: '停下来了', 'max-duration': '到达最长时长', 'source-ended': '视频结束' } as const

/**
 * 片段卡片：默认只看“变化前 / 变化后”，中间帧收起；展开后用滑块逐张查看。
 * 下方是 Homi 的判断（分析中 → 先显示快速结果、复核中 → 确定）。点卡片可在右侧栏查看判断细节。
 */
export function SegmentCard({
  segment,
  analysis,
  ctx,
  selected,
  onSelect,
  onVote,
  onSaveDraft,
  onRejudge,
  fallWatch,
  keyFrames,
}: {
  segment: Segment
  analysis?: Analysis
  fallWatch?: FallWatch
  /** 模型选的关键图；有了就只显示这几张，全部截图收起（调试用） */
  keyFrames?: KeyFrameResult | { status: 'picking' }
  ctx: HomeContext
  selected: boolean
  onSelect: () => void
  onVote: (vote: Vote | null) => void
  onSaveDraft: (draft: Draft, note: string) => ApplyResult
  onRejudge: () => void
}) {
  const [open, setOpen] = useState(false)
  const [idx, setIdx] = useState(0)
  const m = segment.measurements
  const seq = [segment.before, ...segment.middle, segment.after]
  const duration = (segment.endedAt - segment.startedAt) / 1000
  const current = seq[idx]
  const label = idx === 0 ? '变化前' : idx === seq.length - 1 ? '变化后' : `中间 ${idx}/${segment.middle.length}`

  return (
    <article id={segment.id} className={`event ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <header className="event-head">
        <span className="event-time">{clock(segment.startedAt)}</span>
        <span className="tag muted">
          {duration.toFixed(1)} 秒 · {END_REASON[segment.endReason]}
        </span>
      </header>

      {keyFrames && 'frames' in keyFrames ? (
        <div className="keyframes">
          {keyFrames.frames.map((k) => {
            const snap = seq[k.index]
            return snap ? (
              <figure key={k.index} className="keyframe">
                <img src={snap.url} alt={k.note || `#${k.index}`} />
                <figcaption>
                  <b>{clock(snap.t)}</b> {k.note}
                </figcaption>
              </figure>
            ) : null
          })}
          {segment.keyFramesOnly ? (
            <span className="muted small keyframes-only" title="其余截图没有保存（数据最小化）">只保存了关键图</span>
          ) : (
            <button className="middle-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open} title="调试用：查看第一层截的全部图">
              <span>全部</span>
              <span>{seq.length} 张</span>
              <span>{open ? '收起' : '展开'}</span>
            </button>
          )}
          {keyFrames.status === 'pending' && <p className="muted small keyframes-note">选图没成功，先保留全部候选图，统一整理时再选</p>}
        </div>
      ) : (
        <div className="pair">
          <Shot snap={segment.before} label="变化前" />
          {!segment.keyFramesOnly && (
            <button className="middle-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              <span>···</span>
              <span>{segment.middle.length} 张</span>
              <span>{open ? '收起' : '展开'}</span>
            </button>
          )}
          <Shot snap={segment.after} label="变化后" box={m.changeBox} />
        </div>
      )}
      {keyFrames?.status === 'picking' && <p className="muted small">关键图没选好，正在重新选…</p>}

      {open && !segment.keyFramesOnly && (
        <div className="scrubber">
          <img src={current.url} alt={label} />
          <div className="scrubber-bar">
            <input
              type="range"
              min={0}
              max={seq.length - 1}
              value={idx}
              onChange={(e) => setIdx(Number(e.target.value))}
            />
            <span>
              {label} · +{((current.t - segment.before.t) / 1000).toFixed(1)}s
            </span>
          </div>
        </div>
      )}

      {analysis && (
        <div className="judge">
          <JudgmentView analysis={analysis} ctx={ctx} />
          {fallWatch && (
            <p className={`fall-watch fall-${fallWatch.state}`}>
              {fallWatch.state === 'waiting' || fallWatch.state === 'checking' ? (
                <i className="spinner" aria-hidden />
              ) : fallWatch.state === 'alerted' ? (
                '🚨'
              ) : (
                '✅'
              )}{' '}
              {fallWatch.round > 1 && fallWatch.state === 'alerted' ? '2 分钟后再看：仍在地上，已再次提醒' : FALL_STATE[fallWatch.state]}
              {fallWatch.evidence && <small>（{fallWatch.evidence}）</small>}
            </p>
          )}
          {analysis.status === 'done' && analysis.final && (
            <FeedbackBar
              key={analysis.startedAt}
              event={segment}
              judgment={analysis.final}
              ctx={ctx}
              onVote={onVote}
              onSave={onSaveDraft}
              onRejudge={onRejudge}
            />
          )}
        </div>
      )}

      <dl className="stats">
        <div><dt>中间帧</dt><dd>{segment.middle.length} 张</dd></div>
        <div title="变化前 vs 变化后的像素差异（不含忽略区域）"><dt>前后差异</dt><dd>{pct(m.netChange)}</dd></div>
        <div title="片段期间帧间变化的峰值"><dt>峰值</dt><dd>{pct(m.peakRatio)}</dd></div>
        {segment.ignoreZones.length > 0 && (
          <div><dt>忽略区域</dt><dd>{segment.ignoreZones.length} 个（送模型时裁掉或填灰）</dd></div>
        )}
      </dl>
    </article>
  )
}
