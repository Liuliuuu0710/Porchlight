/**
 * 开发用：送图方案 A / B / C 对比（打开 http://localhost:5180/?dev=frames）。
 * 1. 用测试片段跑第一层，收集片段
 * 2. 每个片段 × 每种方案 × 每个模型各判断一次
 * 3. 对比：判断、摔倒、选的关键图（缩略图 + 说明）、耗时、输入额度
 * 测试视频仅供开发，不提交、不在路演播放。
 */
import { useRef, useState } from 'react'
import { MotionDetector, type Segment } from '../motion/detector'
import { TEST_CLIPS, createClipSource, type TestClip } from './test-clips'
import { judgeWith, type FrameScheme, type Judgment } from '../ai/judge'
import { seedContext } from '../memory/types'

/** 送图方案的变体：方案 + 裁剪图张数。?dev=frames&variants=B8,B6 指定要比的（默认比 B8 和 B6） */
interface Variant {
  id: string
  scheme: FrameScheme
  crops?: number
  desc: string
}
const ALL_VARIANTS: Variant[] = [
  { id: 'A', scheme: 'A', desc: '前后全图 + 均匀 4 张中间帧' },
  { id: 'B8', scheme: 'B', crops: 8, desc: '前后全图 + 变化最大 8 张（裁剪）' },
  { id: 'B6', scheme: 'B', crops: 6, desc: '前后全图 + 变化最大 6 张（裁剪）' },
  { id: 'C', scheme: 'C', crops: 6, desc: '前后全图 + 总览 1 张 + 变化最大 6 张（裁剪）' },
]
const SCHEMES: Variant[] = (() => {
  const want = new URLSearchParams(location.search).get('variants')?.split(',') ?? ['B8', 'B6']
  return ALL_VARIANTS.filter((v) => want.includes(v.id))
})()
const MODELS = [
  { id: 'flash', label: 'Flash', model: 'hackathon/v_model/deepseek-v4.1-flash', extra: { thinking: { type: 'disabled' } }, timeoutMs: 30000, hedgeAfterMs: 8000 },
  { id: 'kimi', label: 'Kimi', model: 'hackathon/v_model/kimi-k3', extra: undefined, timeoutMs: 90000, hedgeAfterMs: 30000 },
] as const
/** 默认选的片段：摔倒起不来 2 段、摔倒后起身 2 段、正常动作 2 段 */
const DEFAULT_CLIPS = ['fall-01', 'fall-05', 'fall-01-up', 'fall-10-up', 'adl-01', 'adl-20']
/** 同时最多几个请求（不刷量） */
const CONCURRENCY = 3

interface Collected {
  clip: TestClip
  seg: Segment
  /** 这个测试片段里的第几段 */
  n: number
}

interface Run {
  key: string
  status: 'pending' | 'done' | 'error'
  judgment?: Judgment
  latencyMs?: number
  promptTokens?: number
  imageCount?: number
  error?: string
  raw?: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 跑一个测试片段，收集第一层切出的所有片段（动作播完、片段结束后停止） */
async function collect(clip: TestClip, onLog: (s: string) => void): Promise<Segment[]> {
  const segs: Segment[] = []
  const src = createClipSource(clip, 6000)
  const det = new MotionDetector({ onSegment: (s) => segs.push(s) })
  if (clip.motion) det.setConfig(clip.motion)
  await src.start()
  det.start(src)
  const t0 = Date.now()
  while (src.stage !== 'done' && Date.now() - t0 < 120000) await sleep(500)
  await sleep(1500)
  det.stop()
  src.stop()
  onLog(`${clip.label}：${segs.length} 段`)
  return segs
}

export function FrameEval() {
  // ?dev=frames&clips=a,b 可以直接指定要跑的片段
  const [picked, setPicked] = useState<string[]>(
    () => new URLSearchParams(location.search).get('clips')?.split(',').filter(Boolean) ?? DEFAULT_CLIPS,
  )
  const [items, setItems] = useState<Collected[]>([])
  const [runs, setRuns] = useState<Record<string, Run>>({})
  const [log, setLog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const stopRef = useRef(false)
  const addLog = (s: string) => setLog((l) => [...l, `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${s}`])

  const start = async () => {
    setBusy(true)
    stopRef.current = false
    setRuns({})
    const got: Collected[] = []
    for (const id of picked) {
      if (stopRef.current) break
      const clip = TEST_CLIPS.find((c) => c.id === id)!
      addLog(`开始跑 ${clip.label}`)
      const segs = await collect(clip, addLog)
      segs.forEach((seg, i) => got.push({ clip, seg, n: i + 1 }))
      setItems([...got])
    }
    // 判断：片段 × 方案 × 模型，限制并发
    const ctx = seedContext()
    const jobs = got.flatMap((it) =>
      SCHEMES.flatMap((v) => MODELS.map((m) => ({ it, v, m, key: `${it.seg.id}|${v.id}|${m.id}` }))),
    )
    addLog(`共 ${jobs.length} 次判断，最多同时 ${CONCURRENCY} 个`)
    let next = 0
    const worker = async () => {
      while (next < jobs.length && !stopRef.current) {
        const j = jobs[next++]
        setRuns((r) => ({ ...r, [j.key]: { key: j.key, status: 'pending' } }))
        try {
          const res = await judgeWith(j.m.model, j.it.seg, ctx, {
            extra: j.m.extra,
            timeoutMs: j.m.timeoutMs,
            hedgeAfterMs: j.m.hedgeAfterMs,
            scheme: j.v.scheme,
            crops: j.v.crops,
          })
          setRuns((r) => ({
            ...r,
            [j.key]: {
              key: j.key,
              status: res.judgment ? 'done' : 'error',
              judgment: res.judgment,
              latencyMs: res.latencyMs,
              promptTokens: res.usage?.prompt_tokens,
              imageCount: res.imageCount,
              error: res.error,
              raw: res.raw,
            },
          }))
        } catch (e) {
          setRuns((r) => ({ ...r, [j.key]: { key: j.key, status: 'error', error: (e as Error).message } }))
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    addLog('全部完成')
    setBusy(false)
  }

  // 方便在控制台里查看送模型的图（如总览图）
  ;(window as unknown as { __frameEval: Collected[] }).__frameEval = items
  const all = Object.values(runs).filter((r) => r.status === 'done')
  const summary = SCHEMES.map((v) => v.id).flatMap((s) =>
    MODELS.map((m) => {
      const rs = all.filter((r) => r.key.endsWith(`|${s}|${m.id}`))
      const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
      return {
        k: `${s} · ${m.label}`,
        n: rs.length,
        latency: avg(rs.map((r) => r.latencyMs ?? 0)) / 1000,
        tokens: avg(rs.filter((r) => r.promptTokens).map((r) => r.promptTokens!)),
        images: avg(rs.map((r) => r.imageCount ?? 0)),
        keyOk: rs.filter((r) => r.judgment!.keyFrames.length > 0).length,
        keyAvg: avg(rs.map((r) => r.judgment!.keyFrames.length)),
      }
    }),
  )

  return (
    <div className="app frame-eval">
      <h1>送图方案对比（开发用）</h1>
      <p className="muted small">
        {SCHEMES.map((v) => `${v.id}：${v.desc}`).join(' · ')}
      </p>
      <div className="fe-clips">
        {TEST_CLIPS.map((c) => (
          <label key={c.id} className="check">
            <input
              type="checkbox"
              checked={picked.includes(c.id)}
              disabled={busy}
              onChange={(e) => setPicked((p) => (e.target.checked ? [...p, c.id] : p.filter((x) => x !== c.id)))}
            />
            {c.label}
          </label>
        ))}
      </div>
      <p>
        <button className="btn primary" disabled={busy || picked.length === 0} onClick={start}>
          开始
        </button>{' '}
        {busy && (
          <button className="btn" onClick={() => (stopRef.current = true)}>
            停止
          </button>
        )}
      </p>

      <table className="fe-summary">
        <thead>
          <tr>
            <th>方案 · 模型</th>
            <th>完成</th>
            <th>平均耗时</th>
            <th>平均输入额度</th>
            <th>平均图片数</th>
            <th>选图有效</th>
            <th>平均选几张</th>
          </tr>
        </thead>
        <tbody>
          {summary.map((s) => (
            <tr key={s.k}>
              <td>{s.k}</td>
              <td>{s.n}</td>
              <td>{Number.isNaN(s.latency) ? '—' : `${s.latency.toFixed(1)}s`}</td>
              <td>{Number.isNaN(s.tokens) ? '—' : Math.round(s.tokens)}</td>
              <td>{Number.isNaN(s.images) ? '—' : s.images.toFixed(1)}</td>
              <td>{s.n ? `${s.keyOk}/${s.n}` : '—'}</td>
              <td>{Number.isNaN(s.keyAvg) ? '—' : s.keyAvg.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {items.map((it) => {
        const seq = [it.seg.before, ...it.seg.middle, it.seg.after]
        return (
          <section key={it.seg.id} className="panel fe-seg" data-seg={it.seg.id}>
            <h2>
              {it.clip.label} · 第 {it.n} 段 · {it.seg.middle.length} 张中间帧 · 期望：{it.clip.expect}
            </h2>
            {SCHEMES.map(({ id: s }) =>
              MODELS.map((m) => {
                const r = runs[`${it.seg.id}|${s}|${m.id}`]
                const j = r?.judgment
                return (
                  <div key={s + m.id} className="fe-run" data-key={`${s}|${m.id}`}>
                    <b>
                      {s} · {m.label}
                    </b>{' '}
                    {!r ? '—' : r.status === 'pending' ? '判断中…' : r.status === 'error' ? `出错：${r.error}` : null}
                    {j && (
                      <>
                        <span className="fe-meta">
                          {j.verdict} · {j.category} · 摔倒 {j.fall ? `${j.fall.suspected ? '是' : '否'}/${j.fall.onGroundAtEnd ? '在地上' : '不在地上'}` : '—'} ·{' '}
                          {((r.latencyMs ?? 0) / 1000).toFixed(1)}s · {r.promptTokens ?? '?'} 额度 · {r.imageCount} 张图
                        </span>
                        <div className="fe-change">{j.change}</div>
                        <div className="fe-keys">
                          {j.keyFrames.length === 0 && <span className="run-error">没选出有效的关键图</span>}
                          {j.keyFrames.map((k) => (
                            <figure key={k.index}>
                              <img src={seq[k.index]?.url} alt={`#${k.index}`} />
                              <figcaption>
                                #{k.index} {k.note}
                              </figcaption>
                            </figure>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )
              }),
            )}
          </section>
        )
      })}

      <pre className="fe-log">{log.join('\n')}</pre>
    </div>
  )
}
