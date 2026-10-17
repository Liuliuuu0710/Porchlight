/**
 * 第二层评测用的固定场景：真实露台照片做背景，叠加箱子和人。
 * 只在开发时从浏览器控制台调用：
 *   const E = await import('/src/dev/eval-scenes.ts'); const scenes = await E.buildScenes()
 */
import type { Segment, Snapshot } from '../motion/detector'
import type { HomeContext } from '../memory/types'
import { DEFAULT_CATEGORIES } from '../memory/categories'
import type { Verdict } from '../ai/judge'

const W = 640
const H = 609
const RIGHT: [number, number] = [440, 430]
const MID: [number, number] = [270, 450]

type Draw = (g: CanvasRenderingContext2D) => void

function box(g: CanvasRenderingContext2D, x: number, y: number) {
  g.fillStyle = '#b98a52'
  g.fillRect(x, y, 95, 70)
  g.fillStyle = '#9c7140'
  g.fillRect(x, y, 95, 14)
  g.fillStyle = '#d8c39a'
  g.fillRect(x + 40, y, 14, 70)
  g.strokeStyle = '#6e4e2a'
  g.lineWidth = 2
  g.strokeRect(x, y, 95, 70)
}

function person(g: CanvasRenderingContext2D, x: number, carry: boolean) {
  g.fillStyle = '#2b2f3a'
  g.beginPath()
  g.arc(x + 35, 260, 24, 0, Math.PI * 2)
  g.fill()
  g.fillRect(x + 8, 288, 55, 150)
  g.fillRect(x + 12, 438, 20, 90)
  g.fillRect(x + 40, 438, 20, 90)
  if (carry) box(g, x - 5, 330)
}

export interface EvalScene {
  id: string
  title: string
  expect: Verdict
  segment: Segment
  ctx: HomeContext
}

export async function buildScenes(): Promise<EvalScene[]> {
  const bg = new Image()
  // 不用 decode()：页面在后台时它可能一直不返回
  await new Promise<void>((resolve, reject) => {
    bg.onload = () => resolve()
    bg.onerror = () => reject(new Error('评测背景图加载失败'))
    bg.src = '/eval/terrace.jpg'
  })

  const shot = async (draw: Draw, t: number): Promise<Snapshot> => {
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const g = c.getContext('2d')!
    g.drawImage(bg, 0, 0, W, H)
    draw(g)
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.9))
    return { t, blob, url: URL.createObjectURL(blob), width: W, height: H, gray: new Uint8ClampedArray(64 * 48) }
  }

  const seg = async (id: string, frames: Draw[], netChange: number, changeBox: Segment['measurements']['changeBox']) => {
    const t0 = Date.now() - 20000
    const s = await Promise.all(frames.map((f, i) => shot(f, t0 + i * 2000)))
    const segment: Segment = {
      id,
      startedAt: t0,
      endedAt: t0 + (frames.length - 1) * 2000,
      endReason: 'settled',
      before: s[0],
      middle: s.slice(1, -1),
      after: s[s.length - 1],
      measurements: { netChange, changeBox, peakRatio: 0.08 },
      ignoreZones: [],
    }
    return segment
  }

  const none: Draw = () => {}
  // 固定的露台场景上下文（不跟随 seedContext：示例数据已改为室内）
  const base: HomeContext = {
    plans: [{ id: 'p1', kind: 'rule', text: '今天快递放门边右侧', start: Date.now() - 3600_000, end: Date.now() + 3600_000, enabled: true }],
    memories: [{ id: 'm1', text: '家人经常在阳台走动，是日常', enabled: true }],
    categories: DEFAULT_CATEGORIES,
  }
  const p1off: HomeContext = { ...base, plans: base.plans.map((p) => (p.id === 'p1' ? { ...p, enabled: false } : p)) }
  const rightBox = { x: 0.69, y: 0.7, w: 0.15, h: 0.12 }

  const placeRight = await seg(
    'S1',
    [none, (g) => person(g, 520, true), (g) => (person(g, 450, false), box(g, ...RIGHT)), (g) => box(g, ...RIGHT)],
    0.04,
    rightBox,
  )
  return [
    { id: 'S1', title: '箱子放右侧，计划“快递放右侧”生效', expect: 'record', segment: placeRight, ctx: base },
    { id: 'S2', title: '同上，计划关闭', expect: 'notice', segment: { ...placeRight, id: 'S2' }, ctx: p1off },
    {
      id: 'S3',
      title: '有人经过，前后一样',
      expect: 'record',
      segment: await seg('S3', [none, (g) => person(g, 150, false), (g) => person(g, 300, false), (g) => person(g, 450, false), none], 0, null),
      ctx: base,
    },
    {
      id: 'S4',
      title: '箱子被拿走，无相关计划',
      expect: 'notice',
      segment: await seg(
        'S4',
        [(g) => box(g, ...RIGHT), (g) => (box(g, ...RIGHT), person(g, 500, false)), (g) => person(g, 420, true), none],
        0.04,
        rightBox,
      ),
      ctx: p1off,
    },
    {
      id: 'S5',
      title: '箱子放在通道中间（违反计划“放门边右侧”）',
      expect: 'alert',
      segment: await seg(
        'S5',
        [none, (g) => person(g, 350, true), (g) => (person(g, 420, false), box(g, ...MID)), (g) => box(g, ...MID)],
        0.04,
        { x: 0.42, y: 0.74, w: 0.15, h: 0.12 },
      ),
      ctx: base,
    },
  ]
}

export const isCorrect = (expect: EvalScene['expect'], got?: Verdict) =>
  got === expect
