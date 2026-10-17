import assert from 'node:assert/strict'
import {
  MERGE_GAP_MS,
  allowedTargets,
  appendToEvent,
  groupAllowed,
  lockedCategory,
  openEvents,
  maxVerdict,
  shouldAskMerge,
  startEvent,
  takeSettled,
  type MergeDecision,
  type SegmentBrief,
} from './grouping.ts'

const brief = (id: string, startedAt: number, endedAt: number, verdict: SegmentBrief['verdict'] = 'record'): SegmentBrief => ({
  id,
  startedAt,
  endedAt,
  change: `${id} 的描述`,
  verdict,
  category: 'passby',
  notes: [],
})
const d = (segmentId: string, same: boolean): MergeDecision => ({ segmentId, same, reason: '', byRule: false })

const tests: Record<string, () => void> = {
  '间隔 90 秒以内才问模型'() {
    const ev = startEvent(brief('a', 0, 10_000), d('a', false))
    assert.equal(shouldAskMerge(ev, { startedAt: 10_000 + MERGE_GAP_MS }), true)
    assert.equal(shouldAskMerge(ev, { startedAt: 10_001 + MERGE_GAP_MS }), false)
    assert.equal(shouldAskMerge(null, { startedAt: 0 }), false)
  },
  '超过 90 秒但这段在场最后还有人：也要问'() {
    const ev = startEvent(brief('a', 0, 10_000), d('a', false))
    assert.equal(shouldAskMerge(ev, { startedAt: 10_000 + 10 * MERGE_GAP_MS }, MERGE_GAP_MS, true), true)
    assert.equal(shouldAskMerge(ev, { startedAt: 10_000 + 10 * MERGE_GAP_MS }, MERGE_GAP_MS, false), false)
    assert.equal(shouldAskMerge(ev, { startedAt: 5_000 }, MERGE_GAP_MS, true), false, '时间倒退仍然不问')
  },
  '时间倒退（换来源 / 往回拖）不问，当新的一件事'() {
    const ev = startEvent(brief('a', 50_000, 60_000), d('a', false))
    assert.equal(shouldAskMerge(ev, { startedAt: 1_000 }), false)
  },
  '并入：起止时间、描述、档位取最高'() {
    let ev = startEvent(brief('a', 0, 10_000, 'notice'), d('a', false))
    ev = appendToEvent(ev, brief('b', 40_000, 55_000, 'record'), '有人放下箱子后离开了', d('b', true))
    assert.deepEqual(ev.segmentIds, ['a', 'b'])
    assert.equal(ev.startedAt, 0)
    assert.equal(ev.endedAt, 55_000)
    assert.equal(ev.summary, '有人放下箱子后离开了')
    assert.equal(ev.verdict, 'notice')
    assert.equal(ev.decisions.length, 2)
    assert.equal(ev.category, 'passby', '合并模型没给分类时保留原分类')
  },
  '合并时可改分类'() {
    let ev = startEvent(brief('a', 0, 10_000), d('a', false))
    ev = appendToEvent(ev, brief('b', 20_000, 30_000), '有人来门口等了一会儿', d('b', true), 'visitor')
    assert.equal(ev.category, 'visitor')
  },
  '关键图：合并模型选好就用它的，没选成功就两边都留并标待选'() {
    const a = { segmentId: 'a', index: 0, note: '开始' }
    const b = { segmentId: 'b', index: 4, note: '结束' }
    const ev = startEvent(brief('a', 0, 10_000), d('a', false), [a])
    const ok = appendToEvent(ev, brief('b', 20_000, 30_000), 'x', d('b', true), null, { picked: [a, b], added: [b] })
    assert.deepEqual(ok.keyFrames, [a, b])
    assert.equal(ok.keyFrameStatus, 'ok')
    const bad = appendToEvent(ev, brief('b', 20_000, 30_000), 'x', d('b', true), null, { picked: null, added: [b] })
    assert.deepEqual(bad.keyFrames, [a, b])
    assert.equal(bad.keyFrameStatus, 'pending')
  },
  '模型没给新描述时保留原描述'() {
    let ev = startEvent(brief('a', 0, 10_000), d('a', false))
    ev = appendToEvent(ev, brief('b', 20_000, 30_000), '', d('b', true))
    assert.equal(ev.summary, 'a 的描述')
  },
  '分析失败的片段也能成为事件'() {
    const ev = startEvent({ ...brief('a', 0, 1), change: null, verdict: null, category: null }, d('a', false))
    assert.equal(ev.category, 'other')
    assert.equal(ev.summary, '（这段没能看懂）')
    assert.equal(maxVerdict(ev.verdict, 'alert'), 'alert')
  },
  '正在进行的事：这次来源里、隔得不远或最后还有人的，最多 3 件，按开始先后'() {
    const evs = ['a', 'b', 'c', 'd', 'e'].map((id, i) => startEvent(brief(id, i * 10_000, i * 10_000 + 5_000), d(id, false)))
    const live = evs.map((e) => e.id).filter((id) => id !== 'ev-b')
    const seg = { startedAt: 100_000 }
    // a 结束于 5 秒，离新片段 95 秒：太远；但它最后还有人 → 也算
    const present = (e: { id: string }) => (e.id === 'ev-a' ? true : null)
    const open = openEvents(evs, live, seg, present)
    assert.deepEqual(open.map((e) => e.id), ['ev-c', 'ev-d', 'ev-e'], '取最近 3 件；b 不是这次来源的')
    assert.deepEqual(openEvents(evs.slice(0, 1), ['ev-a'], seg, () => null).length, 0, 'a 太远且没人')
  },
  '硬规则：摔倒只能并进摔倒那件；提醒只能并进同一事由的事'() {
    const home = { ...startEvent(brief('h', 0, 1), d('h', false)), category: 'home' }
    const parcel = { ...startEvent(brief('p', 0, 1), d('p', false)), category: 'parcel' }
    const fall = { ...startEvent(brief('f', 0, 1), d('f', false)), category: 'fall' }
    const open = [home, parcel, fall]
    assert.deepEqual(allowedTargets(open, { verdict: 'record', category: 'home' }, false), open, '普通片段哪件都能并')
    assert.deepEqual(allowedTargets(open, { verdict: 'alert', category: 'parcel' }, false), [parcel])
    assert.deepEqual(allowedTargets(open, { verdict: 'alert', category: 'fall' }, true), [fall])
    assert.deepEqual(allowedTargets([home], { verdict: 'alert', category: 'fall' }, true), [], '没有摔倒那件 → 单独成一件')
  },
  '统一整理的硬规则和并完的分类'() {
    const ev = (category: string, verdict: SegmentBrief['verdict']) => ({ category, verdict })
    assert.equal(groupAllowed([ev('home', 'record'), ev('object', 'notice')]), true)
    assert.equal(groupAllowed([ev('parcel', 'alert'), ev('object', 'record')]), true, '快递到了 + 放下箱子')
    assert.equal(groupAllowed([ev('fall', 'alert'), ev('home', 'record')]), false, '摔倒不并进在家活动')
    assert.equal(groupAllowed([ev('fall', 'alert'), ev('fall', 'notice')]), true)
    assert.equal(groupAllowed([ev('parcel', 'alert'), ev('visitor', 'alert')]), false, '两件不同事由的提醒')
    assert.equal(lockedCategory([ev('home', 'record'), ev('parcel', 'alert')]), 'parcel')
    assert.equal(lockedCategory([ev('home', 'record'), ev('object', 'notice')]), null)
  },
  '按发生顺序：队头没分析完，后面的要等'() {
    const done = new Set(['b', 'c'])
    assert.deepEqual(takeSettled(['a', 'b', 'c'], (id) => done.has(id)), [])
    done.add('a')
    assert.deepEqual(takeSettled(['a', 'b', 'c', 'd'], (id) => done.has(id)), ['a', 'b', 'c'])
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
