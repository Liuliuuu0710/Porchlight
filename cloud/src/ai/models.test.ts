import assert from 'node:assert/strict'
import { modelsFor, normalizeConfig, optionIdOf, stepInfo, summarize } from './models.ts'

const tests: Record<string, () => void> = {
  '看图的步骤只能选能看图的模型；文字步骤都能选；模拟只给看图判断'() {
    const vision = modelsFor(stepInfo('merge')).map((m) => m.id)
    assert.ok(vision.includes('flash') && vision.includes('kimi'))
    assert.ok(!vision.includes('v4-pro') && !vision.includes('glm') && !vision.includes('mock'))
    const text = modelsFor(stepInfo('report')).map((m) => m.id)
    assert.ok(text.includes('v4-pro') && text.includes('flash') && !text.includes('mock'))
    assert.ok(modelsFor(stepInfo('judgeFast')).some((m) => m.id === 'mock'))
  },
  '统一整理拆成小问题后：是非题和未结束的变化都用真正不思考的 Flash → GLM'() {
    assert.deepEqual(stepInfo('consolidatePlan').defaults.chain, ['flash-none', 'glm-none'])
    assert.deepEqual(stepInfo('consolidateOpen').defaults.chain, ['flash-none', 'glm-none'])
  },
  '保存的设置不合法：去掉不能用的模型，空了用默认，最多 3 个'() {
    const s = stepInfo('merge')
    assert.deepEqual(normalizeConfig(s, { chain: ['v4-pro', 'kimi'] }).chain, ['kimi'], '看图步骤不能用 V4-Pro')
    assert.deepEqual(normalizeConfig(s, { chain: [] }).chain, s.defaults.chain)
    assert.deepEqual(normalizeConfig(s, undefined), s.defaults)
    assert.equal(normalizeConfig(stepInfo('report'), { chain: ['flash', 'glm', 'v4-pro', 'kimi'] }).chain.length, 3)
    assert.deepEqual(normalizeConfig(stepInfo('judgeFast'), { chain: ['mock', 'flash'] }).chain, ['mock'], '模拟单独用')
  },
  '超时 5–180 秒；备用不晚于超时'() {
    const s = stepInfo('report')
    assert.equal(normalizeConfig(s, { chain: ['glm'], timeoutMs: 999_000 }).timeoutMs, 180_000)
    assert.equal(normalizeConfig(s, { chain: ['glm'], timeoutMs: 100 }).timeoutMs, 5_000)
    const c = normalizeConfig(s, { chain: ['glm'], timeoutMs: 20_000, hedgeAfterMs: 50_000 })
    assert.equal(c.hedgeAfterMs, 20_000)
  },
  '最近调用的统计：成功率、平均耗时、超时、结果来自哪个模型'() {
    const st = summarize([
      { t: 1, ok: true, ms: 1000, model: 'flash' },
      { t: 2, ok: true, ms: 3000, model: 'glm' },
      { t: 3, ok: false, ms: 60000, model: 'v4-pro', error: 'v4-pro：请求超时（60 秒）' },
    ])
    assert.deepEqual(st, { n: 3, ok: 2, avgMs: 2000, timeouts: 1, byModel: { flash: 1, glm: 1 } })
    assert.equal(summarize([]).avgMs, null)
  },
  '网关返回的模型名对回选项'() {
    assert.equal(optionIdOf('hackathon/v_model/deepseek-v4.1-flash'), 'flash')
    assert.equal(optionIdOf('deepseek-v4-1-flash-260910'), 'flash', '网关返回的变形名字')
    assert.equal(optionIdOf('glm-5-2-260617'), 'glm')
    assert.equal(optionIdOf('glm-5-2-260617', ['flash-none', 'glm-none']), 'glm-none', '先在这一步的设置里找')
    assert.equal(optionIdOf('DeepSeek-V4-Pro'), 'v4-pro')
    assert.equal(optionIdOf('unknown-x'), 'unknown-x')
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
