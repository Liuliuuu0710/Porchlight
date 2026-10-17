/**
 * 按“模型与超时”面板的设置调用一步（models.ts）：首选模型先发，没回 / 失败按顺序发备用，取先成功的；
 * 每次调用的结果记下来（成功率、耗时、超时、结果来自哪个模型），面板上显示。
 */
import { chat, chatHedged, type ChatMessage, type ChatResult } from './gateway'
import { getStepConfig, modelOption, optionIdOf, recordCall, stepInfo, type StepId } from './models'

export async function callStep(step: StepId, messages: ChatMessage[], opts: { maxTokens?: number } = {}): Promise<ChatResult> {
  const cfg = getStepConfig(step)
  const attempts = cfg.chain.map((id) => {
    const m = modelOption(id)!
    return { model: m.model, extra: m.extra }
  })
  const t0 = performance.now()
  try {
    const res = await chatHedged(attempts, messages, {
      maxTokens: opts.maxTokens ?? stepInfo(step).maxTokens ?? 4096,
      timeoutMs: cfg.timeoutMs,
      hedgeAfterMs: cfg.hedgeAfterMs,
    })
    recordCall(step, { t: Date.now(), ok: true, ms: res.latencyMs, model: optionIdOf(res.model, cfg.chain) })
    return res
  } catch (e) {
    recordCall(step, {
      t: Date.now(),
      ok: false,
      ms: Math.round(performance.now() - t0),
      model: cfg.chain[0],
      error: (e as Error).message.slice(0, 200),
    })
    throw e
  }
}

/** 这一步现在的首选模型（界面上显示“用的是谁”） */
export const primaryOf = (step: StepId) => getStepConfig(step).chain[0]

/** “测一下”：给模型发一句很短的话，看它现在多快能回（几乎不花额度；不计入统计） */
export async function pingModel(id: string, timeoutMs: number): Promise<number> {
  const m = modelOption(id)
  if (!m || m.model === 'mock') return 0
  const res = await chat(m.model, [{ role: 'user', content: '只回答一个字：好' }], { maxTokens: 512, timeoutMs, extra: m.extra })
  return res.latencyMs
}
