import { Panel } from './Panel'
import type { MotionConfig } from '../motion/state-machine'

interface Field {
  key: keyof MotionConfig
  label: string
  min: number
  max: number
  step: number
  format: (v: number) => string
  hint: string
}

const sec = (v: number) => `${(v / 1000).toFixed(1)} 秒`

const FIELDS: Field[] = [
  { key: 'areaThreshold', label: '面积阈值', min: 0.002, max: 0.2, step: 0.002, format: (v) => `${(v * 100).toFixed(1)}%`, hint: '变化像素占比超过它算“有运动”。误触发多就调高' },
  { key: 'pixelThreshold', label: '像素阈值', min: 5, max: 80, step: 1, format: (v) => `${v}`, hint: '单像素灰度差超过它算“变了”。噪点多就调高' },
  { key: 'debounceFrames', label: '防抖帧数', min: 1, max: 10, step: 1, format: (v) => `${v} 帧`, hint: '连续多少帧超阈值才确认运动' },
  { key: 'settleMs', label: '稳定时间', min: 500, max: 5000, step: 100, format: sec, hint: '运动停止后静止多久才截“变化后”' },
  { key: 'middleIntervalMs', label: '中间帧间隔', min: 300, max: 3000, step: 100, format: sec, hint: '运动期间多久截一张中间帧' },
  { key: 'maxMiddleFrames', label: '中间帧上限', min: 5, max: 60, step: 1, format: (v) => `${v} 张`, hint: '安全上限，正常全部保留；超出才均匀抽取' },
  { key: 'maxSegmentMs', label: '片段最长', min: 5000, max: 60000, step: 1000, format: sec, hint: '持续运动到这个时长就结束当前片段，立即开始下一段' },
  { key: 'cooldownMs', label: '冷却时间', min: 0, max: 20000, step: 500, format: sec, hint: '片段结束后多久内不再触发。默认 0：合并交给第二层，冷却只会丢信息' },
  { key: 'sampleFps', label: '采样频率', min: 1, max: 10, step: 1, format: (v) => `${v} 次/秒`, hint: '运动检测的采样频率' },
]

export function ConfigPanel({
  config,
  onChange,
  onReset,
}: {
  config: MotionConfig
  onChange: (patch: Partial<MotionConfig>) => void
  onReset: () => void
}) {
  return (
    <Panel
      id="motion-config"
      title="第一层参数"
      defaultOpen={false}
      actions={<button className="link" onClick={onReset}>恢复默认</button>}
    >
      {FIELDS.map((f) => (
        <label key={f.key} className="field" title={f.hint}>
          <span className="field-label">
            {f.label}
            <b>{f.format(config[f.key])}</b>
          </span>
          <input
            type="range"
            min={f.min}
            max={f.max}
            step={f.step}
            value={config[f.key]}
            onChange={(e) => onChange({ [f.key]: Number(e.target.value) })}
          />
          <small>{f.hint}</small>
        </label>
      ))}
    </Panel>
  )
}
