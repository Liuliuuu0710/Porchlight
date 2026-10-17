import assert from 'node:assert/strict'
import { GRAY_H, GRAY_W, describeCrop, evenly, middleChangeScores, motionCropBox, topChanged, validKeyFrames } from './frames.ts'

/** 64×48 灰度图：背景 100，在 (x, y) 放一个 w×h 的亮块 */
function frame(blocks: [number, number, number, number][] = []): Uint8ClampedArray {
  const g = new Uint8ClampedArray(GRAY_W * GRAY_H).fill(100)
  for (const [x0, y0, w, h] of blocks)
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) g[y * GRAY_W + x] = 220
  return g
}

const tests: Record<string, () => void> = {
  '变化分：动得最大的那张分最高'() {
    // 前 → 中1（不动）→ 中2（右下出现大块）→ 中3（同中2）→ 后
    const seq = [frame(), frame(), frame([[40, 30, 16, 12]]), frame([[40, 30, 16, 12]]), frame([[40, 30, 16, 12]])]
    const s = middleChangeScores(seq)
    assert.equal(s.length, 3)
    assert.equal(s[0], s[1], '中1 和中2 之间的变化同时算给两张')
    assert.equal(s[2], 0, '中3 前后都没变')
    assert.ok(s[1] > 0)
  },
  '按变化分挑图，结果按时间先后'() {
    assert.deepEqual(topChanged([0.1, 0.5, 0, 0.3], 2), [1, 3])
    assert.deepEqual(topChanged([0.1, 0.5], 5), [0, 1])
    assert.deepEqual(topChanged([], 3), [])
  },
  '均匀挑图'() {
    assert.deepEqual(evenly(3, 4), [0, 1, 2])
    assert.deepEqual(evenly(30, 4), [0, 10, 19, 29])
  },
  '裁剪区域：只框动过的地方并留边'() {
    const seq = [frame(), frame([[44, 32, 8, 8]]), frame([[48, 36, 8, 8]]), frame([[48, 36, 8, 8]])]
    const b = motionCropBox(seq)!
    assert.ok(b, '有变化')
    assert.ok(b.x < 44 / GRAY_W && b.x > 0.5, `左边界留边：${b.x}`)
    assert.ok(b.y + b.h <= 1)
    assert.ok(b.w * b.h < 0.3)
  },
  '变化区域太大或没有变化：用全图'() {
    const wide = [frame(), frame([[0, 0, 64, 48]])]
    assert.equal(motionCropBox(wide), null)
    assert.equal(motionCropBox([frame(), frame()]), null)
  },
  '位置说明'() {
    assert.equal(describeCrop({ x: 0.6, y: 0.5, w: 0.35, h: 0.5 }), '画面右下区域（横向 60%–95%，纵向 50%–100%）')
    assert.equal(describeCrop({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }), '画面中间区域（横向 40%–60%，纵向 40%–60%）')
    assert.equal(describeCrop({ x: 0, y: 0.4, w: 0.2, h: 0.2 }), '画面左侧区域（横向 0%–20%，纵向 40%–60%）')
  },
  '关键图校验：编号在候选里、不重复、至少一张'() {
    const c = [0, 2, 5, 9]
    assert.deepEqual(validKeyFrames([{ id: 9, note: '后' }, { id: '#0', note: '前' }], c), [
      { index: 0, note: '前' },
      { index: 9, note: '后' },
    ])
    assert.equal(validKeyFrames([], c), null, '一张都没选')
    assert.equal(validKeyFrames([{ id: 3 }], c), null, '编号不在候选里')
    assert.equal(validKeyFrames([{ id: 2 }, { id: 2 }], c), null, '重复')
    assert.equal(validKeyFrames('#2', c), null, '格式不对')
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
