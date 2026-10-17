import { useRef, useState, type PointerEvent } from 'react'
import type { Box } from '../motion/state-machine'

const MIN_SIZE = 0.02

type Drag = { x0: number; y0: number; x1: number; y1: number }

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/**
 * 叠在画面上的忽略区域：平时只显示；编辑时拖动鼠标（或手指）框出矩形，点 × 删除。
 * 坐标用 0–1 比例，与画面分辨率无关。
 */
export function IgnoreZones({
  zones,
  editing,
  onChange,
}: {
  zones: Box[]
  editing: boolean
  onChange: (zones: Box[]) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  // 正在画的框：用 ref 同步记录（事件来得快时 state 还没刷新），state 只用于显示
  const drawing = useRef<Drag | null>(null)
  const [draft, setDraftState] = useState<Drag | null>(null)
  const setDraft = (d: Drag | null) => {
    drawing.current = d
    setDraftState(d)
  }

  const toPoint = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) }
  }

  const onDown = (e: PointerEvent) => {
    if (!editing || (e.target as HTMLElement).closest('.zone-del')) return
    try {
      e.currentTarget.setPointerCapture(e.pointerId) // 拖出画面边缘也能继续跟踪
    } catch {
      /* 个别浏览器 / 合成事件不支持，不影响框选 */
    }
    const p = toPoint(e)
    setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
  }

  const onMove = (e: PointerEvent) => {
    const d = drawing.current
    if (!d) return
    const p = toPoint(e)
    setDraft({ ...d, x1: p.x, y1: p.y })
  }

  const onUp = (e: PointerEvent) => {
    const d = drawing.current
    if (!d) return
    const p = toPoint(e)
    const box = normalize({ ...d, x1: p.x, y1: p.y })
    setDraft(null)
    if (box.w >= MIN_SIZE && box.h >= MIN_SIZE) onChange([...zones, box])
  }

  return (
    <div
      ref={ref}
      className={`zones ${editing ? 'zones-editing' : ''}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => setDraft(null)}
    >
      {zones.map((z, i) => (
        <div key={i} className="zone" style={style(z)}>
          {editing && (
            <button
              className="zone-del"
              aria-label={`删除忽略区域 ${i + 1}`}
              onClick={() => onChange(zones.filter((_, j) => j !== i))}
            >
              ×
            </button>
          )}
        </div>
      ))}
      {draft && <div className="zone zone-draft" style={style(normalize(draft))} />}
      {editing && zones.length === 0 && !draft && <div className="zones-hint">在画面上拖动，框出不需要检测的区域</div>}
    </div>
  )
}

function normalize(d: Drag): Box {
  return { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) }
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`
const style = (z: Box) => ({ left: pct(z.x), top: pct(z.y), width: pct(z.w), height: pct(z.h) })
