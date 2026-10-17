import assert from 'node:assert/strict'
import { applyRecordDiff, diffById, diffRecord, isEmptyDiff, upsertById } from './diff.ts'

const tests: Record<string, () => void> = {
  '只发变了的条目'() {
    const a = { x: 1 }
    const b = { x: 2 }
    const prev = { s1: a, s2: b }
    const next = { s1: a, s2: { x: 3 }, s3: { x: 4 } }
    const d = diffRecord(prev, next)
    assert.deepEqual(Object.keys(d.set).sort(), ['s2', 's3'])
    assert.deepEqual(d.del, [])
    assert.equal(isEmptyDiff(diffRecord(next, next)), true)
  },
  '删除的条目也同步'() {
    const d = diffRecord({ s1: 1, s2: 2 }, { s2: 2 })
    assert.deepEqual(d, { set: {}, del: ['s1'] })
  },
  '镜像页按变化还原出同样的数据'() {
    const prev = { s1: { v: 1 }, s2: { v: 2 } }
    const next = { s2: { v: 20 }, s3: { v: 3 } }
    assert.deepEqual(applyRecordDiff(prev, diffRecord(prev, next)), next)
  },
  '片段：新增、替换、删除，按时间新的在前'() {
    const s1 = { id: 'a', startedAt: 1 }
    const s2 = { id: 'b', startedAt: 2 }
    const sent = new Map([
      ['a', s1],
      ['b', s2],
    ])
    const s2b = { id: 'b', startedAt: 2, reduced: true }
    const s3 = { id: 'c', startedAt: 3 }
    const d = diffById(sent, [s3, s2b])
    assert.deepEqual(d.set.map((x) => x.id), ['c', 'b'])
    assert.deepEqual(d.del, ['a'])
    const mirror = upsertById([s2, s1], d.set, d.del)
    assert.deepEqual(mirror, [s3, s2b])
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
