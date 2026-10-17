import { useState } from 'react'

/** 首次使用时可勾选的预设提醒；以后可以加别的 */
export interface SetupChoices {
  fallAlert: boolean
}

export const DEFAULT_SETUP: SetupChoices = { fallAlert: true }

/**
 * 首次使用设置页（知情同意）：告诉用户 Homi 会主动提醒哪些事，由用户勾选。
 * 摔倒提醒默认勾选、可以取消；之后在“计划与记忆”里随时开关。
 */
export function SetupSheet({ initial, onDone }: { initial: SetupChoices; onDone: (c: SetupChoices) => void }) {
  const [c, setC] = useState(initial)
  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-labelledby="setup-title">
      <div className="sheet setup">
        <h2 id="setup-title">Homi 可以帮你留意这些事</h2>
        <p className="muted">
          平时 Homi 只记录、不打扰。只有你勾选的事、你等着的事，或者需要马上问你的事，才会通知你。
        </p>
        <label className="setup-item">
          <input type="checkbox" checked={c.fallAlert} onChange={(e) => setC({ ...c, fallAlert: e.target.checked })} />
          <span>
            <b>有人摔倒在地上起不来时，马上通知我</b>
            <small>疑似摔倒后，Homi 会在 30 秒后再看一眼，确认还在地上才通知；2 分钟后仍在地上会再通知一次。只通知，不会替你报警。</small>
          </span>
        </label>
        <p className="muted small">
          你也可以随时告诉 Homi：“今天有快递，到了告诉我”。这些选择之后都能在“计划与记忆”里修改。
        </p>
        <div className="sheet-actions">
          <button className="btn primary" onClick={() => onDone(c)}>
            好的，开始
          </button>
        </div>
      </div>
    </div>
  )
}
