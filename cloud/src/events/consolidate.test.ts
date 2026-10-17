import assert from 'node:assert/strict'
import { candidatePairs, groupsFromPairs, labelEvents, mergeEventGroup, pairKey, pairSig, parseOpenChanges, parsePairAnswers } from './consolidate.ts'
import { startEvent, type HomiEvent } from './grouping.ts'
import { DEFAULT_CATEGORIES, groupOf } from '../memory/categories.ts'

const ev = (id: string, startedAt: number, endedAt: number, verdict: HomiEvent['verdict'] = 'record'): HomiEvent => ({
  ...startEvent(
    { id, startedAt, endedAt, change: `${id} 的描述`, verdict, category: 'passby', notes: [] },
    { segmentId: id, same: false, reason: '', byRule: true },
    [{ segmentId: id, index: 0, note: id }],
  ),
  id: `ev-${id}`,
})

// 故意打乱顺序：编号按开始时间
const events = [ev('c', 300_000, 310_000), ev('a', 0, 10_000, 'notice'), ev('b', 100_000, 120_000)]
const labeled = labelEvents(events)

const tests: Record<string, () => void> = {
  '按开始时间编号 E1、E2……'() {
    assert.deepEqual(
      labeled.map((l) => `${l.label}=${l.event.id}`),
      ['E1=ev-a', 'E2=ev-b', 'E3=ev-c'],
    )
  },
  '候选组合：时间重叠、前后紧挨、同一分类往前最近的一件'() {
    const at = (id: string, s: number, e: number, category: string, verdict: HomiEvent['verdict'] = 'record') => ({ ...ev(id, s, e, verdict), category })
    // 在家活动 → 快递（重叠）→ 接着在家活动 → 下午又一个快递
    const h1 = at('h1', 0, 1200, 'home')
    const p1 = at('p1', 600, 720, 'parcel', 'alert')
    const h2 = at('h2', 2400, 2700, 'home')
    const p2 = at('p2', 18000, 18180, 'parcel', 'alert')
    const keys = candidatePairs([p2, h2, p1, h1]).map(([a, b]) => `${a.id}~${b.id}`)
    assert.deepEqual(
      keys.sort(),
      ['ev-h1~ev-p1', 'ev-h1~ev-h2', 'ev-p1~ev-h2', 'ev-h2~ev-p2', 'ev-p1~ev-p2'].sort(),
      '中间夹着快递的两段在家活动也比到；上午下午两个快递也比（让模型说不是）',
    )
  },
  '候选组合：同一大类往前最近的一件也比（埋头开发 → 吃饭 → 团队讨论）'() {
    const at = (id: string, s: number, e: number, category: string) => ({ ...ev(id, s, e), category })
    const c = at('c', 0, 100, 'coding')
    const b = at('b', 5000, 5100, 'break')
    const d = at('d', 9000, 9100, 'discuss')
    const kind = (x: string) => groupOf(x, DEFAULT_CATEGORIES)
    const keys = candidatePairs([c, b, d], {}, kind).map(([x, y]) => `${x.id}~${y.id}`)
    assert.ok(keys.includes('ev-c~ev-d'), '开发和讨论都在“工作中”，隔着吃饭也比')
    assert.ok(!candidatePairs([c, b, d]).map(([x, y]) => `${x.id}~${y.id}`).includes('ev-c~ev-d'), '按小类不比')
  },
  '候选组合：违反硬规则的不要；判过且没变的跳过，又并进片段的重新判'() {
    const fall = { ...ev('f', 0, 10), category: 'fall', verdict: 'alert' as const }
    const home = { ...ev('h', 20, 30), category: 'home' }
    assert.deepEqual(candidatePairs([fall, home]), [], '摔倒不和在家活动比')
    const a = { ...ev('a', 0, 10), category: 'home' }
    const b = { ...ev('b', 20, 30), category: 'home' }
    const checked = { [pairKey(a, b)]: pairSig(a, b) }
    assert.equal(candidatePairs([a, b], checked).length, 0)
    const b2 = { ...b, segmentIds: ['b', 'b2'] }
    assert.equal(candidatePairs([a, b2], checked).length, 1)
  },
  '是非题的回答：编号对上才算，没回答当不是；连成组'() {
    const [a, b, c] = labeled.map((l) => l.event)
    const pairs: [HomiEvent, HomiEvent][] = [
      [a, b],
      [b, c],
      [a, c],
    ]
    const ans = parsePairAnswers({ pairs: [{ id: 'p1', same: true, reason: '接着做' }, { id: 'P2', same: true }, { id: 'P9', same: true }] }, pairs)
    assert.deepEqual(ans.map((x) => x.same), [true, true, false])
    assert.deepEqual(groupsFromPairs(ans.filter((x) => x.same).map((x) => x.pair)), [['ev-a', 'ev-b', 'ev-c']])
    assert.deepEqual(parsePairAnswers('不是对象', pairs).filter((x) => x.same), [])
  },
  '未结束的变化和关联：编号要存在，去掉给用户看的话里的编号'() {
    const r = parseOpenChanges(
      {
        open_changes: [{ event: 'E2', text: 'E2 拿走的钥匙还没放回' }, { event: 'E7', text: 'x' }],
        links: [{ from: 'E1', to: 'E3', relation: '放下的箱子被拿走' }, { from: 'E1', to: 'E1', relation: '自己' }],
      },
      labeled,
    )
    assert.deepEqual(r.openChanges, [{ eventId: 'ev-b', text: '钥匙还没放回' }])
    assert.deepEqual(r.links, [{ from: 'ev-a', to: 'ev-c', relation: '放下的箱子被拿走' }])
  },
  '合并一组：保留最早的 id，片段按时间接起来，档位取最高'() {
    const out = mergeEventGroup(events, ['ev-c', 'ev-a'], {
      summary: '有人整理东西，中途离开过一次',
      category: 'other',
      keyFrames: [{ segmentId: 'a', index: 0, note: '开始' }],
      reason: '动作连贯',
    })
    assert.equal(out.length, 2)
    const m = out.find((e) => e.id === 'ev-a')!
    assert.deepEqual(m.segmentIds, ['a', 'c'])
    assert.equal(m.startedAt, 0)
    assert.equal(m.endedAt, 310_000)
    assert.equal(m.verdict, 'notice')
    assert.equal(m.category, 'other')
    assert.equal(m.keyFrameStatus, 'ok')
    assert.ok(m.decisions.at(-1)!.reason.startsWith('统一整理'))
    assert.ok(out.some((e) => e.id === 'ev-b'), '没参与合并的不动')
  },
  '合并时选图没成功：两边关键图都留，标待选'() {
    const out = mergeEventGroup(events, ['ev-a', 'ev-b'], { summary: '', category: null, keyFrames: null, reason: '' })
    const m = out.find((e) => e.id === 'ev-a')!
    assert.equal(m.keyFrames.length, 2)
    assert.equal(m.keyFrameStatus, 'pending')
    assert.equal(m.summary, 'a 的描述', '没给描述时保留原描述')
    assert.equal(m.category, 'passby')
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
