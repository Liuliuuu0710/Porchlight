import assert from 'node:assert/strict'
import { applyDraft, type Draft } from './apply.ts'
import { planStatus, togglePlanEnabled, type HomeContext, type Plan } from './types.ts'

const ctx: HomeContext = {
  plans: [{ id: 'p1', kind: 'rule', text: '快递放右侧', start: 0, end: 1, enabled: true }],
  memories: [
    { id: 'm1', text: '工具放工具架正常', enabled: true },
    { id: 'm3', text: '猫会走动', enabled: false },
  ],
  categories: [],
}
const base: Draft = { intent: 'none', text: '', targetId: null, start: '', end: '' }

const tests: Record<string, () => void> = {
  '修改计划：改文字和时间，计划重新启用'() {
    const r = applyDraft(
      { ...ctx, plans: [{ ...ctx.plans[0], enabled: false }] },
      { ...base, intent: 'plan_update', targetId: 'p1', text: '快递放左边柜子', start: '2026-10-15T09:00', end: '2026-10-15T18:00' },
    )
    assert.ok(r.ok)
    const p = r.ctx.plans[0]
    assert.equal(p.text, '快递放左边柜子')
    assert.equal(p.enabled, true)
    assert.equal(p.start, new Date('2026-10-15T09:00').getTime())
    assert.equal(r.ref, 'plan:p1')
  },
  '修改计划：目标不存在或时间不对则报错'() {
    assert.equal(applyDraft(ctx, { ...base, intent: 'plan_update', targetId: 'p9', text: 'x', start: '2026-10-15T09:00', end: '2026-10-15T18:00' }).ok, false)
    assert.equal(applyDraft(ctx, { ...base, intent: 'plan_update', targetId: 'p1', text: 'x', start: '2026-10-15T19:00', end: '2026-10-15T18:00' }).ok, false)
  },
  '新增记忆：编号接着最大的往后排'() {
    const r = applyDraft(ctx, { ...base, intent: 'memory_add', text: ' 电动车停右边正常 ' })
    assert.ok(r.ok)
    assert.equal(r.ref, 'memory:m4')
    assert.deepEqual(r.ctx.memories.at(-1), { id: 'm4', text: '电动车停右边正常', enabled: true })
    assert.equal(ctx.memories.length, 2, '不修改原数据')
  },
  '修改记忆：替换文字并重新启用'() {
    const r = applyDraft(ctx, { ...base, intent: 'memory_update', text: '猫晚上也会走动', targetId: 'm3' })
    assert.ok(r.ok)
    assert.deepEqual(r.ctx.memories[1], { id: 'm3', text: '猫晚上也会走动', enabled: true })
  },
  '修改记忆：目标不存在则报错'() {
    const r = applyDraft(ctx, { ...base, intent: 'memory_update', text: 'x', targetId: 'm9' })
    assert.equal(r.ok, false)
  },
  '新增计划：解析本地时间'() {
    const r = applyDraft(ctx, { ...base, intent: 'plan_add', text: '周末快递放左边', start: '2026-10-17T00:00', end: '2026-10-18T23:59' })
    assert.ok(r.ok)
    const p = r.ctx.plans.at(-1)!
    assert.equal(p.id, 'p2')
    assert.equal(p.start, new Date(2026, 9, 17, 0, 0).getTime())
  },
  '新增期待型计划：保留识别特征；非期待型不存特征'() {
    const r = applyDraft(ctx, {
      ...base, intent: 'plan_add', text: '有快递送达', planKind: 'expect', cues: ' 穿红色冲锋衣的人，拿着纸盒子 ',
      start: '2026-10-14T09:00', end: '2026-10-14T23:59',
    })
    assert.ok(r.ok)
    assert.deepEqual(
      { kind: r.ctx.plans.at(-1)!.kind, cues: r.ctx.plans.at(-1)!.cues },
      { kind: 'expect', cues: '穿红色冲锋衣的人，拿着纸盒子' },
    )
    const r2 = applyDraft(ctx, { ...base, intent: 'plan_add', text: 'x', cues: '红衣服', start: '2026-10-14T09:00', end: '2026-10-14T10:00' })
    assert.ok(r2.ok)
    assert.equal(r2.ctx.plans.at(-1)!.kind, 'rule')
    assert.equal(r2.ctx.plans.at(-1)!.cues, undefined)
  },
  '新增计划：结束早于开始则报错'() {
    const r = applyDraft(ctx, { ...base, intent: 'plan_add', text: 'x', start: '2026-10-18T10:00', end: '2026-10-18T09:00' })
    assert.deepEqual(r, { ok: false, error: '结束时间要晚于开始时间' })
  },
  '内容为空则报错'() {
    assert.equal(applyDraft(ctx, { ...base, intent: 'memory_add', text: '  ' }).ok, false)
  },
  '开关计划：取消勾选显示已停用；重新勾选清除已到达'() {
    const p: Plan = { id: 'p1', kind: 'expect', text: '送快递的人到了', start: 0, end: 10, enabled: true, matchedAt: 5 }
    const fmt = (t: number) => String(t)
    assert.equal(planStatus(p, 6, fmt), '已到达 5')
    const off = togglePlanEnabled(p)
    assert.equal(off.enabled, false)
    assert.equal(planStatus(off, 6, fmt), '已停用')
    const on = togglePlanEnabled(off)
    assert.equal(on.enabled, true)
    assert.equal(on.matchedAt, undefined)
    assert.equal(planStatus(on, 6, fmt), '生效中')
    assert.equal(planStatus(on, 11, fmt), '不在时段内')
  },
  '不保存：数据不变'() {
    const r = applyDraft(ctx, base)
    assert.ok(r.ok)
    assert.equal(r.ctx, ctx)
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
