import { Panel } from './Panel'
import { modelLabel, type JudgeRun } from '../ai/judge'
import type { Analysis } from '../ai/pipeline'
import { VERDICT_LABEL } from './SegmentCard'

export type AutoPolicy = 'changed' | 'all' | 'manual'

const POLICIES: { id: AutoPolicy; label: string; hint: string }[] = [
  { id: 'all', label: '全部片段', hint: '每个片段都送模型（默认）' },
  { id: 'changed', label: '仅前后有差异的片段', hint: '按第一层测量值筛：前后差异 ≥ 面积阈值才送，省钱但会漏掉“来了又走”' },
  { id: 'manual', label: '手动', hint: '只在点“重新分析”时送' },
]

const SOURCE_LABEL = {
  reconciled: '两个结果按规则定夺',
  'fast-only': '只有快速模型有结果',
  'review-only': '只有复核模型有结果',
  'review-fallback': '事实比对失败，采用复核结果',
  restored: '从本机记录读回（只保存了最终判断）',
} as const

const secs = (ms?: number) => (ms === undefined ? '' : `${(ms / 1000).toFixed(1)}s`)

function RunDetail({ title, run }: { title: string; run: JudgeRun }) {
  const j = run.judgment
  return (
    <div className="detail-run">
      <div className="detail-head">
        <b>{title}</b> · {modelLabel(run.model)}
        <span className="muted"> {run.status === 'pending' ? '进行中…' : secs(run.latencyMs)}</span>
        {run.usage?.total_tokens && <span className="muted"> · {run.usage.total_tokens} tokens</span>}
      </div>
      {j && (
        <p>
          <span className={`verdict v-${j.verdict}`}>{VERDICT_LABEL[j.verdict]}</span> {j.message}
          <br />
          <small className="muted">变化：{j.change}</small>
        </p>
      )}
      {run.error && <p className="run-error">{run.error}</p>}
      {run.raw && (
        <details>
          <summary>原始返回</summary>
          <pre>{run.raw}</pre>
        </details>
      )}
    </div>
  )
}

/**
 * 第二层的设置与调试：自动送模型策略、同时分析数、统计，以及选中片段的判断细节。
 * 每一步用哪个模型在“模型与超时”面板（ModelPanel）。片段卡片上只显示 Homi 的结论，模型细节都在这里。
 */
export function JudgeSettings({
  policy,
  onPolicy,
  analyses,
  selected,
  onReanalyze,
  concurrency,
  onConcurrency,
}: {
  concurrency: number
  onConcurrency: (n: number) => void
  policy: AutoPolicy
  onPolicy: (p: AutoPolicy) => void
  analyses: Analysis[]
  /** 选中片段的判断；null 表示没有选中 */
  selected: { label: string; analysis?: Analysis } | null
  onReanalyze: () => void
}) {
  const done = analyses.filter((a) => a.status === 'done')
  const reconciled = done.filter((a) => a.source === 'reconciled')
  const rewritten = reconciled.filter((a) => a.reconcile.agree === false)
  const verdictChanged = reconciled.filter((a) => a.fast.judgment && a.final && a.fast.judgment.verdict !== a.final.verdict)
  const avg = (xs: number[]) => (xs.length ? secs(xs.reduce((s, x) => s + x, 0) / xs.length) : '—')
  const a = selected?.analysis

  return (
    <Panel id="judge-settings" title="第二层：判断设置" defaultOpen={false}>
      <div className="field">
        <span className="field-label">最终判断规则</span>
        <small>
          快速判断和复核同时看图；档位不同 → 用复核结果；档位相同 → 比对两边事实，一致沿用快速结果，不一致用复核结果。
          每一步用哪个模型，在下面的“模型与超时”里设置
        </small>
      </div>
      <label className="field">
        <span className="field-label">
          同时分析的片段数<b>{concurrency} 个</b>
        </span>
        <input type="range" min={1} max={10} step={1} value={concurrency} onChange={(e) => onConcurrency(Number(e.target.value))} />
        <small>片段一出现就送去分析，超过这个数的先排队</small>
      </label>
      <div className="field">
        <span className="field-label">自动送模型</span>
        {POLICIES.map((p) => (
          <label key={p.id} className="radio" title={p.hint}>
            <input type="radio" name="policy" checked={policy === p.id} onChange={() => onPolicy(p.id)} />
            {p.label}
            <small>{p.hint}</small>
          </label>
        ))}
      </div>

      <h3 className="sub">统计（本页）</h3>
      <dl className="stats-grid">
        <dt>已确定</dt>
        <dd>{done.length} 个片段</dd>
        <dt>快速结果被改写</dt>
        <dd>
          {rewritten.length}/{reconciled.length}
          {verdictChanged.length > 0 && `（档位变了 ${verdictChanged.length} 次）`}
        </dd>
        <dt>快速结果平均</dt>
        <dd>{avg(done.flatMap((x) => (x.fast.latencyMs !== undefined ? [x.fast.latencyMs] : [])))}</dd>
        <dt>确定平均</dt>
        <dd>{avg(done.flatMap((x) => (x.finishedAt ? [x.finishedAt - x.startedAt] : [])))}</dd>
      </dl>

      <h3 className="sub">选中片段的判断细节</h3>
      {!selected ? (
        <p className="muted small">点左侧任意片段卡片查看。</p>
      ) : (
        <div className="detail">
          <div className="detail-head">
            <b>{selected.label}</b>
            <button
              className="btn small"
              onClick={onReanalyze}
              disabled={a?.status === 'queued' || a?.status === 'analyzing' || a?.status === 'reviewing'}
            >
              重新分析
            </button>
          </div>
          {!a ? (
            <p className="muted small">还没有分析。</p>
          ) : (
            <>
              <RunDetail title="快速" run={a.fast} />
              <RunDetail title="复核" run={a.review} />
              <div className="detail-run">
                <div className="detail-head">
                  <b>定夺</b>
                  {a.reconcile.model && <span className="muted"> · {a.reconcile.model}</span>}
                  <span className="muted"> {a.reconcile.status === 'pending' ? '等待中…' : secs(a.reconcile.latencyMs)}</span>
                </div>
                {a.source && <p className="small">{SOURCE_LABEL[a.source]}</p>}
                {a.reconcile.agree !== undefined && (
                  <p className="small">{a.reconcile.agree ? '事实一致，沿用快速结果' : '已改用复核结果'}：{a.reconcile.reason}</p>
                )}
                {a.reconcile.status === 'skipped' && a.reconcile.reason && <p className="small muted">{a.reconcile.reason}</p>}
                {a.reconcile.error && <p className="run-error">{a.reconcile.error}</p>}
                {a.reconcile.raw && (
                  <details>
                    <summary>原始返回</summary>
                    <pre>{a.reconcile.raw}</pre>
                  </details>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </Panel>
  )
}
