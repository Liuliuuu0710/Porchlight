import { useEffect, useRef } from 'react'
import type { Sample } from '../motion/detector'

const WINDOW_MS = 20000

/** 最近 20 秒的帧间变化率曲线；虚线为面积阈值，紫色底色表示处于运动事件中 */
export function RatioChart({ samples, threshold, version }: { samples: Sample[]; threshold: number; version: number }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const c = ref.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    const w = c.clientWidth
    const h = c.clientHeight
    if (c.width !== w * dpr) c.width = w * dpr
    if (c.height !== h * dpr) c.height = h * dpr
    const ctx = c.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const css = getComputedStyle(c)
    const now = samples.at(-1)?.t ?? Date.now()
    // 纵轴上限：至少是阈值的 3 倍，避免曲线贴顶
    const maxY = Math.max(threshold * 3, ...samples.map((s) => s.ratio), 0.01)
    const x = (t: number) => w - ((now - t) / WINDOW_MS) * w
    const y = (r: number) => h - (r / maxY) * (h - 4)

    // 运动区间底色
    ctx.fillStyle = css.getPropertyValue('--motion-bg')
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].phase === 'motion') ctx.fillRect(x(samples[i - 1].t), 0, x(samples[i].t) - x(samples[i - 1].t) + 1, h)
    }

    // 阈值线
    ctx.strokeStyle = css.getPropertyValue('--threshold')
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(0, y(threshold))
    ctx.lineTo(w, y(threshold))
    ctx.stroke()
    ctx.setLineDash([])

    // 变化率
    ctx.strokeStyle = css.getPropertyValue('--line')
    ctx.lineWidth = 1.5
    ctx.beginPath()
    samples.forEach((s, i) => (i ? ctx.lineTo(x(s.t), y(s.ratio)) : ctx.moveTo(x(s.t), y(s.ratio))))
    ctx.stroke()
  }, [samples, threshold, version])

  return <canvas ref={ref} className="ratio-chart" />
}

export { WINDOW_MS }
