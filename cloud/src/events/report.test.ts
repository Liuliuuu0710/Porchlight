import assert from 'node:assert/strict'
import { dedupeQuestions, groupByCategory, isReportDue, parseReportText, type ReportQuestion } from './report.ts'
import { startEvent, type HomiEvent } from './grouping.ts'
import { DEFAULT_CATEGORIES, groupOf } from '../memory/categories.ts'

const ev = (id: string, startedAt: number, category: string): HomiEvent => ({
  ...startEvent(
    { id, startedAt, endedAt: startedAt + 5000, change: id, verdict: 'record', category, notes: [] },
    { segmentId: id, same: false, reason: '', byRule: true },
  ),
  id: `ev-${id}`,
})

const events = [ev('c', 300, 'parcel'), ev('a', 100, 'passby'), ev('b', 200, 'passby')]
const q = (n: number, text: string): ReportQuestion => ({ key: `q${n}`, segmentId: `s${n}`, text })

const tests: Record<string, () => void> = {
  '按分类分组：多的在前，组内按时间'() {
    const g = groupByCategory(events)
    assert.deepEqual(
      g.map((x) => `${x.categoryId}:${x.count}:${x.eventIds.join(',')}`),
      ['passby:2:ev-a,ev-b', 'parcel:1:ev-c'],
    )
    assert.equal(g[0].from, 100)
    assert.equal(g[0].to, 5200)
  },
  '按大类分组：埋头开发、团队讨论都算“工作中”'() {
    const es = [ev('a', 100, 'coding'), ev('b', 200, 'discuss'), ev('c', 300, 'supply'), ev('d', 400, 'debug')]
    const g = groupByCategory(es, (c) => groupOf(c, DEFAULT_CATEGORIES))
    assert.deepEqual(
      g.map((x) => `${x.categoryId}:${x.count}`),
      ['work:3', 'items:1'],
    )
    assert.equal(groupOf('不存在的分类', DEFAULT_CATEGORIES), 'other')
  },
  '问题去重：只差标点空白算重复'() {
    const out = dedupeQuestions([q(1, '门口的箱子是你的吗？'), q(2, '门口的箱子 是你的吗'), q(3, '要记成日常吗？')])
    assert.deepEqual(out.map((x) => x.key), ['q1', 'q3'])
  },
  '报告文字校验：小结按分类对上，缺的兜底；问题最多 3 个、不重复'() {
    const groups = groupByCategory(events)
    const qs = [q(1, 'a'), q(2, 'b'), q(3, 'c'), q(4, 'd')]
    const r = parseReportText(
      {
        headline: '今天门口很平静。',
        groups: [{ category: 'passby', line: '有人经过 2 次' }],
        questions: ['Q2', 'Q2', 'Q9', 'Q1', 'Q3', 'Q4'],
      },
      groups,
      qs,
    )
    assert.equal(r.headline, '今天门口很平静。')
    assert.deepEqual(r.groups.map((g) => g.line), ['有人经过 2 次', '共 1 件'])
    assert.deepEqual(r.questions.map((x) => x.key), ['q2', 'q1', 'q3'])
  },
  '报告文字格式不对：用兜底'() {
    const r = parseReportText(null, groupByCategory(events), [])
    assert.equal(r.headline, '今天记录了 3 件事。')
    assert.deepEqual(r.questions, [])
  },
  '定时生成：到点且今天还没生成过'() {
    const at = (h: number, day = 14) => new Date(2026, 9, day, h, 0).getTime()
    assert.equal(isReportDue(at(20), null), false, '还没到点')
    assert.equal(isReportDue(at(21), null), true)
    assert.equal(isReportDue(at(22), at(21)), false, '今天已经生成过')
    assert.equal(isReportDue(at(21, 15), at(21, 14)), true, '第二天')
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
