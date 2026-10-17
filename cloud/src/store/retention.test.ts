import assert from 'node:assert/strict'
import { DAY_MS, dayKey, expiredReportKeys, isExpired, isSameDay, sparseSequence } from './retention.ts'

const at = (day: number, h = 12) => new Date(2026, 9, day, h, 0).getTime()

const tests: Record<string, () => void> = {
  '日期键'() {
    assert.equal(dayKey(at(14)), '2026-10-14')
    assert.equal(dayKey(new Date(2026, 0, 5, 1).getTime()), '2026-01-05')
    assert.equal(isSameDay(at(14, 0), at(14, 23)), true)
    assert.equal(isSameDay(at(14, 23), at(15, 0)), false)
  },
  '7 天保留：今天和往前 6 天'() {
    const now = at(14, 9)
    assert.equal(isExpired(at(8, 0), now, 7), false, '10/8 0 点还在')
    assert.equal(isExpired(at(7, 23), now, 7), true, '10/7 已过期')
    assert.equal(isExpired(now - DAY_MS, now, 7), false)
  },
  '日报 30 天'() {
    const now = at(31)
    assert.deepEqual(expiredReportKeys(['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-31'], now), ['2026-09-30', '2026-10-01'])
  },
  '只存关键图时还原完整序列'() {
    const kept = new Map([
      [2, 'b'],
      [5, 'e'],
    ])
    assert.deepEqual(sparseSequence(7, kept), ['b', 'b', 'b', 'b', 'b', 'e', 'e'])
    assert.throws(() => sparseSequence(3, new Map()))
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
