import assert from 'node:assert/strict'
import { decideUrgentQuestion } from './urgent.ts'
import type { HomeContext, Plan } from '../memory/types.ts'

const now = 1_000_000
const plan = (over: Partial<Plan> = {}): Plan => ({ id: 'p1', kind: 'expect', text: '送快递的人到了', start: 0, end: now * 2, enabled: true, ...over })
const ctx = (p: Plan): HomeContext => ({ plans: [p], memories: [], categories: [] }) as unknown as HomeContext
const ask = (over = {}) => ({ question: '是送快递的人吗？', questionUrgent: true, questionAbout: 'plan:p1', expected: [{ id: 'plan:p1', matched: false }], ...over })

const tests: Record<string, () => void> = {
  '还在等：新的提问，推送'() {
    assert.deepEqual(decideUrgentQuestion(ask(), ctx(plan()), [], now), { kind: 'new', about: 'plan:p1' })
  },
  '计划已经到达：不再问（分析开始时还没到达的片段）'() {
    assert.equal(decideUrgentQuestion(ask(), ctx(plan({ matchedAt: now - 10 })), [], now).kind, 'skip')
  },
  '计划停用或过了时段：不再问'() {
    assert.equal(decideUrgentQuestion(ask(), ctx(plan({ enabled: false })), [], now).kind, 'skip')
    assert.equal(decideUrgentQuestion(ask(), ctx(plan({ end: now - 1 })), [], now).kind, 'skip')
  },
  '模型没说问的是哪条：对照的计划都已到达也不问'() {
    assert.equal(decideUrgentQuestion(ask({ questionAbout: null }), ctx(plan({ matchedAt: 1 })), [], now).kind, 'skip')
    assert.equal(decideUrgentQuestion(ask({ questionAbout: null }), ctx(plan()), [], now).kind, 'new')
  },
  '同一件事已有一条没回答：更新那一条，不再通知'() {
    const d = decideUrgentQuestion(ask(), ctx(plan()), [{ id: 'question-seg-1', about: 'plan:p1' }], now)
    assert.deepEqual(d, { kind: 'update', id: 'question-seg-1', about: 'plan:p1' })
  },
  '不是紧急提问、或已按期待型提醒：跳过'() {
    assert.equal(decideUrgentQuestion(ask({ questionUrgent: false }), ctx(plan()), [], now).kind, 'skip')
    assert.equal(decideUrgentQuestion(ask({ expected: [{ id: 'plan:p1', matched: true }] }), ctx(plan()), [], now).kind, 'skip')
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
