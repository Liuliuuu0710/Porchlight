import assert from 'node:assert/strict'
import { FULL, keepBox, modelView, outputSize } from './zones.ts'

const near = (a: number, b: number) => Math.abs(a - b) < 0.02

const tests: Record<string, () => void> = {
  '没有忽略区域：全图，不填'() {
    assert.deepEqual(modelView(null, []), { region: FULL, fills: [] })
  },
  '忽略区域在四周（上面一条天空、右边一条马路）：整条裁掉'() {
    const r = modelView(null, [
      { x: 0, y: 0, w: 1, h: 0.25 },
      { x: 0.8, y: 0, w: 0.2, h: 1 },
    ]).region
    assert.ok(near(r.x, 0) && near(r.y, 0.25) && near(r.w, 0.8) && near(r.h, 0.75), JSON.stringify(r))
  },
  '忽略区域在中间：裁不掉，填灰（坐标相对裁剪框）'() {
    const v = modelView(null, [{ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }])
    assert.deepEqual(v.region, FULL)
    assert.equal(v.fills.length, 1)
    assert.ok(near(v.fills[0].x, 0.4) && near(v.fills[0].w, 0.2))
  },
  '变化区域和忽略区域一起：先取交集，再填剩下的'() {
    const v = modelView({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, [{ x: 0.9, y: 0, w: 0.1, h: 1 }])
    assert.ok(near(v.region.x, 0.5) && near(v.region.w, 0.4), JSON.stringify(v.region))
    assert.equal(v.fills.length, 0, '右边一条已经裁掉了')
  },
  '全被忽略（不合理）：退回全图'() {
    assert.deepEqual(keepBox([{ x: 0, y: 0, w: 1, h: 1 }]), FULL)
  },
  '输出尺寸：按最长边或宽度缩小，不放大'() {
    assert.deepEqual(outputSize(1280, 720, FULL, { maxWidth: 1024 }), { width: 1024, height: 576 })
    assert.deepEqual(outputSize(1280, 720, { x: 0, y: 0, w: 0.25, h: 0.5 }, { maxSide: 512 }), { width: 320, height: 360 })
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
