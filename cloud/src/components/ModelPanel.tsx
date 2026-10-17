import { useState, useSyncExternalStore } from 'react'
import { Panel } from './Panel'
import {
  MAX_CHAIN,
  STEPS,
  getCalls,
  getStepConfig,
  isCustom,
  modelLabel,
  modelsFor,
  resetStepConfig,
  setStepConfig,
  subscribeModels,
  summarize,
  type StepInfo,
} from '../ai/models'
import { pingModel } from '../ai/step'

/** 设置或统计变了就重新渲染（本页改的、别的标签页改的都算） */
let version = 0
const subscribe = (cb: () => void) =>
  subscribeModels(() => {
    version++
    cb()
  })
const useModelsVersion = () => useSyncExternalStore(subscribe, () => version)

const sec = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} 秒`)

function StepRow({ s }: { s: StepInfo }) {
  const cfg = getStepConfig(s.id)
  const options = modelsFor(s)
  const stats = summarize(getCalls(s.id))
  const [ping, setPing] = useState<string | null>(null)
  const setChain = (i: number, id: string) => {
    const chain = [...cfg.chain]
    if (id) chain[i] = id
    else chain.splice(i)
    setStepConfig(s.id, { ...cfg, chain: chain.filter(Boolean) })
  }
  const test = async () => {
    setPing('测试中…')
    const results = await Promise.all(
      [...new Set(cfg.chain)].map((id) =>
        pingModel(id, cfg.timeoutMs).then(
          (ms) => `${modelLabel(id)} ${sec(ms)}`,
          (e: Error) => `${modelLabel(id)} 没回（${e.message}）`,
        ),
      ),
    )
    setPing(results.join('；'))
  }
  const mock = cfg.chain[0] === 'mock'
  return (
    <div className="model-step">
      <div className="model-step-head">
        <b>{s.label}</b>
        {isCustom(s.id) && <span className="model-tag">已改</span>}
        <small className="muted">{s.desc}</small>
      </div>
      <div className="model-chain">
        {Array.from({ length: mock ? 1 : Math.min(cfg.chain.length + 1, MAX_CHAIN) }, (_, i) => (
          <label key={i}>
            <span>{i === 0 ? '首选' : `备用 ${i}`}</span>
            <select value={cfg.chain[i] ?? ''} onChange={(e) => setChain(i, e.target.value)}>
              {i > 0 && <option value="">无</option>}
              {options
                .filter((m) => i === 0 || m.id !== 'mock')
                .map((m) => (
                  <option key={m.id} value={m.id} title={m.note}>
                    {m.label}
                    {i > 0 && m.id === cfg.chain[i - 1] ? '（再发一份）' : ''}
                  </option>
                ))}
            </select>
          </label>
        ))}
      </div>
      {!mock && (
        <div className="model-times">
          超时
          <input
            type="number"
            min={5}
            max={180}
            value={cfg.timeoutMs / 1000}
            onChange={(e) => setStepConfig(s.id, { ...cfg, timeoutMs: Number(e.target.value) * 1000 })}
          />
          秒 ·
          <input
            type="number"
            min={1}
            max={cfg.timeoutMs / 1000}
            value={cfg.hedgeAfterMs / 1000}
            onChange={(e) => setStepConfig(s.id, { ...cfg, hedgeAfterMs: Number(e.target.value) * 1000 })}
          />
          秒没回就同时发下一个
        </div>
      )}
      <div className="model-stats">
        {stats.n === 0 ? (
          <span className="muted">还没有调用记录</span>
        ) : (
          <span>
            最近 {stats.n} 次：成功 {stats.ok}，平均 {sec(stats.avgMs)}
            {stats.timeouts > 0 && <b className="model-bad">，超时 {stats.timeouts}</b>}
            {Object.keys(stats.byModel).length > 0 &&
              `；结果来自 ${Object.entries(stats.byModel)
                .map(([id, n]) => `${modelLabel(id)} ${n}`)
                .join('、')}`}
          </span>
        )}
        <span className="model-actions">
          {!mock && (
            <button className="link" onClick={() => void test()}>
              测一下
            </button>
          )}
          {isCustom(s.id) && (
            <button className="link" onClick={() => resetStepConfig(s.id)}>
              恢复默认
            </button>
          )}
        </span>
      </div>
      {ping && <div className="model-ping muted">{ping}</div>}
    </div>
  )
}

/**
 * 调试台右侧“模型与超时”：每一步用哪个模型（首选 + 最多 2 个备用）、超时、多久没回发备用，
 * 以及最近的调用结果。设置存在本浏览器，同一浏览器的页面自动同步。
 */
export function ModelPanel() {
  useModelsVersion()
  const custom = STEPS.some((s) => isCustom(s.id))
  return (
    <Panel
      id="model-steps"
      title="模型与超时"
      defaultOpen={false}
      actions={
        custom && (
          <button className="link" onClick={() => resetStepConfig()}>
            全部恢复默认
          </button>
        )
      }
    >
      <p className="muted small">
        首选模型先发；超过设定时间没回、或失败了，按顺序发备用，取先回来的。备用选同一个模型 = 没回就再发一份同样的请求。
        设置和统计存在本浏览器（同一浏览器的页面自动同步）。所有人共用一个 Key 的额度，换成更慢、更贵的模型会影响大家。
      </p>
      {STEPS.map((s) => (
        <StepRow key={s.id} s={s} />
      ))}
    </Panel>
  )
}
