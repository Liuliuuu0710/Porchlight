/**
 * 状态机单测：用合成灰度图模拟场景，运行 `npm test`。
 */
import assert from 'node:assert/strict'
import { MotionStateMachine, DEFAULT_CONFIG, diffGray, evenlySample, zonesToMask } from './state-machine.ts'
import type { MotionAction, MotionConfig } from './state-machine.ts'

const W = 64
const H = 48
const DT = 200 // 5 fps

/** 背景灰度 100；可在指定矩形区域填入另一个灰度值 */
function frame(rect?: { x: number; y: number; w: number; h: number; v: number }, noise = 0) {
  const g = new Uint8ClampedArray(W * H).fill(100)
  if (noise) for (let i = 0; i < g.length; i++) g[i] = 100 + Math.round((Math.random() - 0.5) * 2 * noise)
  if (rect) {
    for (let y = rect.y; y < rect.y + rect.h; y++)
      for (let x = rect.x; x < rect.x + rect.w; x++) g[y * W + x] = rect.v
  }
  return g
}

function run(frames: Uint8ClampedArray[], config: Partial<MotionConfig> = {}) {
  const sm = new MotionStateMachine(W, H, { ...DEFAULT_CONFIG, ...config })
  const log: { t: number; a: MotionAction }[] = []
  frames.forEach((f, i) => {
    const t = i * DT
    for (const a of sm.step(f, t).actions) if (a.type !== 'stable') log.push({ t, a })
  })
  return log
}

const repeat = <T,>(n: number, fn: (i: number) => T) => Array.from({ length: n }, (_, i) => fn(i))

const tests: Record<string, () => void> = {
  'diffGray: 计算占比与外接框'() {
    const a = frame()
    const b = frame({ x: 16, y: 12, w: 16, h: 12, v: 200 })
    const r = diffGray(a, b, W, H, 25)
    assert.equal(r.ratio, (16 * 12) / (W * H))
    assert.deepEqual(r.box, { x: 0.25, y: 0.25, w: 0.25, h: 0.25 })
  },

  'evenlySample: 保留首尾、均匀分布'() {
    assert.deepEqual(evenlySample(3, 8), [0, 1, 2])
    assert.deepEqual(evenlySample(10, 4), [0, 3, 6, 9])
  },

  '静止画面 + 轻微噪声：不触发'() {
    const log = run(repeat(50, () => frame(undefined, 8)))
    assert.equal(log.length, 0)
  },

  '单帧闪烁（光线跳变）：防抖后不触发'() {
    const frames = [...repeat(10, () => frame()), frame({ x: 0, y: 0, w: 64, h: 48, v: 180 }), ...repeat(10, () => frame())]
    // 闪一帧会产生两次跳变（亮、灭），仍不足 3 帧连续
    assert.equal(run(frames).length, 0)
  },

  '放下一个物体：开始 → 中间帧 → 稳定 2 秒后结束'() {
    // 0–2s 静止；2–5s 物体移动（每帧位置不同）；之后物体停在原地
    const frames = [
      ...repeat(10, () => frame()),
      ...repeat(15, (i) => frame({ x: 2 + i * 3, y: 10, w: 12, h: 12, v: 220 })),
      ...repeat(30, () => frame({ x: 44, y: 10, w: 12, h: 12, v: 220 })),
    ]
    const log = run(frames)
    const types = log.map((l) => l.a.type)
    assert.equal(types[0], 'start')
    assert.ok(types.filter((t) => t === 'middle').length >= 2, '应有中间帧')
    const finish = log.find((l) => l.a.type === 'finish')!
    assert.deepEqual(finish.a, { type: 'finish', reason: 'settled' })
    // 运动在第 25 帧（5.0s）停止，2s 后应结束
    assert.ok(finish.t >= 6800 && finish.t <= 7400, `结束时间 ${finish.t}`)
  },

  '持续运动超过上限：切成新片段'() {
    const frames = repeat(120, (i) => frame({ x: (i * 5) % 54, y: 10, w: 10, h: 10, v: 220 }))
    const log = run(frames, { maxSegmentMs: 8000 })
    const finishes = log.filter((l) => l.a.type === 'finish')
    assert.ok(finishes.length >= 2)
    assert.ok(finishes.every((f) => (f.a as any).reason === 'max-duration'))
    // 每次 max-duration 结束后紧跟一个 start
    finishes.forEach((f) => {
      const idx = log.indexOf(f)
      assert.equal(log[idx + 1]?.a.type, 'start')
    })
  },

  '设置了冷却时：冷却期内的运动不触发新片段'() {
    const moving = (n: number) => repeat(n, (i) => frame({ x: 2 + (i % 15) * 3, y: 10, w: 12, h: 12, v: 220 }))
    const still = (n: number) => repeat(n, () => frame())
    // 片段1 → 静止 2s 结束 → 冷却 5s 内（第 1s 起）再次运动 1s
    const frames = [...still(5), ...moving(10), ...still(12), ...moving(5), ...still(40)]
    const starts = run(frames, { cooldownMs: 5000 }).filter((l) => l.a.type === 'start')
    assert.equal(starts.length, 1)
  },

  '默认冷却为 0：片段结束后马上能开始下一段'() {
    const moving = (n: number) => repeat(n, (i) => frame({ x: 2 + (i % 15) * 3, y: 10, w: 12, h: 12, v: 220 }))
    const still = (n: number) => repeat(n, () => frame())
    // 同上：片段1 结束后 1 秒再次运动（如快递员放下箱子后转身离开）
    const frames = [...still(5), ...moving(10), ...still(12), ...moving(5), ...still(40)]
    const log = run(frames)
    assert.equal(log.filter((l) => l.a.type === 'start').length, 2)
    assert.equal(log.filter((l) => l.a.type === 'finish').length, 2)
  },

  'zonesToMask：按像素中心落在区域内计算'() {
    const m = zonesToMask([{ x: 0.25, y: 0.25, w: 0.25, h: 0.25 }], W, H)!
    let n = 0
    m.forEach((v) => (n += v))
    assert.equal(n, 16 * 12)
    assert.equal(m[12 * W + 16], 1)
    assert.equal(m[12 * W + 15], 0)
    assert.equal(zonesToMask([], W, H), null)
  },

  '忽略区域：占比的分母不含忽略像素'() {
    const ignore = zonesToMask([{ x: 0, y: 0, w: 0.5, h: 1 }], W, H)
    const r = diffGray(frame(), frame({ x: 32, y: 0, w: 32, h: 12, v: 200 }), W, H, 25, ignore)
    assert.equal(r.ratio, (32 * 12) / (32 * 48))
  },

  '忽略区域：只在区域内的运动不触发'() {
    const frames = repeat(60, (i) => frame({ x: (i * 4) % 20, y: 10, w: 10, h: 20, v: 220 }))
    const sm = new MotionStateMachine(W, H, DEFAULT_CONFIG)
    sm.setIgnoreMask(zonesToMask([{ x: 0, y: 0, w: 0.5, h: 1 }], W, H))
    const actions = frames.flatMap((f, i) => sm.step(f, i * DT).actions).filter((a) => a.type !== 'stable')
    assert.equal(actions.length, 0)
    // 对照：不设忽略区域时会触发
    assert.ok(run(frames).some((l) => l.a.type === 'start'))
  },

  'forceFinish：片段进行中时结束，空闲时无动作'() {
    const sm = new MotionStateMachine(W, H, DEFAULT_CONFIG)
    assert.equal(sm.forceFinish(), null)
    repeat(10, (i) => sm.step(frame({ x: 2 + i * 4, y: 10, w: 12, h: 12, v: 220 }), i * DT))
    assert.equal(sm.phase, 'motion')
    assert.deepEqual(sm.forceFinish(), { type: 'finish', reason: 'source-ended' })
    assert.equal(sm.phase, 'idle')
  },
}

let failed = 0
for (const [name, fn] of Object.entries(tests)) {
  try {
    fn()
    console.log(`✓ ${name}`)
  } catch (e) {
    failed++
    console.log(`✗ ${name}\n  ${(e as Error).message}`)
  }
}
console.log(failed ? `\n${failed} 项失败` : `\n全部 ${Object.keys(tests).length} 项通过`)
process.exit(failed ? 1 : 0)
