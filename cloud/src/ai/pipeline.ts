/**
 * 第二层判断流程：快速模型 + 复核模型同时看图，再由规则 + 文字比对定出最终判断。
 *
 *   分析中 ──快速模型先返回──▶ 先显示快速结果（复核中）──复核返回 + 比对──▶ 已确定
 *
 * - 两个看图模型同时发：快速模型偶尔“很确定地看错”（如把“箱子被拿走”看成“经过”），
 *   靠“拿不准才复核”拦不住；同时发也让网关偶发卡顿时互为备份
 * - 最终用哪个结果由代码按规则决定，比对模型只回答“两段描述的事实是否一致”，不写自己的结论
 *   （让它写结论时，它看不到图，曾把两个模型都判“需要留意”的结果改成“正常”）：
 *     档位不同，或“在等的事”是否发生判断不同 → 用复核结果（不再比对）
 *     档位相同、事实一致 → 沿用快速结果的措辞（用户已经看到它，保持稳定）
 *     档位相同、事实不同 → 用复核结果
 * - 只有一个看图模型成功时直接用它；比对失败时用复核结果
 */
import type { Segment } from '../motion/detector'
import type { HomeContext } from '../memory/types'
import { judgeSegment, extractJson, strOrNull, type JudgeRun, type Judgment } from './judge'
import { callStep, primaryOf } from './step'

/**
 * 用哪个模型、超时多久，按“模型与超时”面板的设置（ai/models.ts）。默认：
 * 快速判断 Flash，30 秒超时、10 秒没回再发一份（送图方案 B 图多，长片段 Flash 实测约 19 秒）；
 * 复核 Kimi，90 秒、30 秒（长片段实测 30–60 秒）；比对 Flash 关闭思考约 3 秒，备用 GLM。
 */
/** 复核模型先返回时，最多再等快速模型多久（快速模型可能遇到网关卡顿） */
const WAIT_FAST_AFTER_REVIEW_MS = 10000

export type AnalysisStatus = 'queued' | 'analyzing' | 'reviewing' | 'done' | 'error'

export interface ReconcileRun {
  status: 'pending' | 'done' | 'error' | 'skipped'
  /** 最终结论与快速结果是否基本一致 */
  agree?: boolean
  reason?: string
  raw?: string
  error?: string
  latencyMs?: number
  model?: string
}

export interface Analysis {
  status: AnalysisStatus
  startedAt: number
  finishedAt?: number
  /** 当前展示给用户的判断（先是快速结果，确定后是最终结果） */
  shown?: Judgment
  /** 最终判断；status 为 done 时才有 */
  final?: Judgment
  /** 最终判断来自哪里（调试用） */
  source?: 'reconciled' | 'fast-only' | 'review-only' | 'review-fallback' | 'restored'
  fast: JudgeRun
  review: JudgeRun
  reconcile: ReconcileRun
  error?: string
}

const RECONCILE_PROMPT = `比较同一个摄像头片段的两段描述 A 和 B，判断它们对“发生了什么”的事实是否一致。
重点看：有没有人、做了什么动作、有没有留下或拿走东西、东西最后在不在。
同一位置的不同说法（如“桌子右边”“桌面右侧”“画面右侧”）算一致；措辞不同但事实相同算一致。
只输出 JSON：{"same_facts": true 或 false, "reason": "一句话"}`

/** 只比对事实，不给结论：返回两段描述的事实是否一致 */
async function compareFacts(a: Judgment, b: Judgment) {
  // “关闭思考”经网关后仍可能思考一段，1024 曾被用完（两个模型都没给出正文）→ 4096（callStep 默认）
  const res = await callStep('reconcile', [
    { role: 'system', content: RECONCILE_PROMPT },
    { role: 'user', content: `A：${a.change}；${a.message}
B：${b.change}；${b.message}` },
  ])
  const obj = extractJson(res.text)
  if (typeof obj.same_facts !== 'boolean') throw new Error('比对结果缺少 same_facts')
  return { same: obj.same_facts as boolean, reason: strOrNull(obj.reason) ?? '', raw: res.text, latencyMs: res.latencyMs, model: res.model }
}

/**
 * 运行一次完整判断，每次状态变化都通过 onUpdate 回调最新的 Analysis。
 * 返回最终的 Analysis。
 */
export async function analyzeSegment(
  seg: Segment,
  ctx: HomeContext,
  onUpdate: (a: Analysis) => void,
): Promise<Analysis> {
  const startedAt = Date.now()
  const models = { fast: primaryOf('judgeFast'), review: primaryOf('judgeReview') }
  let a: Analysis = {
    status: 'analyzing',
    startedAt,
    fast: { model: models.fast, status: 'pending', startedAt },
    review: { model: models.review, status: 'pending', startedAt },
    reconcile: { status: 'pending' },
  }
  const emit = (patch: Partial<Analysis>) => {
    a = { ...a, ...patch }
    onUpdate(a)
  }
  emit({})

  const run = (step: 'judgeFast' | 'judgeReview', model: string): Promise<JudgeRun> =>
    judgeSegment(step, seg, ctx).then(
      (r) => ({ model, startedAt, ...r, status: r.error ? 'error' : 'done' }),
      (e: Error) => ({ model, startedAt, status: 'error', error: e.message }),
    )

  const fastP = run('judgeFast', models.fast).then((fast) => {
    // 快速结果先展示（若复核结果还没到）
    emit({ fast, ...(fast.judgment && !a.shown ? { shown: fast.judgment, status: 'reviewing' as const } : {}) })
    return fast
  })
  const reviewP = run('judgeReview', models.review).then((review) => {
    emit({ review, ...(review.judgment && !a.shown ? { shown: review.judgment, status: 'reviewing' as const } : {}) })
    return review
  })

  const review = await reviewP
  // 复核模型先回来：快速模型最多再等一会儿，避免被网关卡顿拖住
  const fast = await Promise.race([
    fastP,
    new Promise<JudgeRun>((r) =>
      setTimeout(
        () => r({ ...a.fast, status: 'error', error: '复核结果已到，快速模型仍未返回，不再等待' }),
        WAIT_FAST_AFTER_REVIEW_MS,
      ),
    ),
  ])

  const finish = (final: Judgment, source: Analysis['source'], reconcileRun: ReconcileRun) =>
    emit({ status: 'done', final, shown: final, source, reconcile: reconcileRun, finishedAt: Date.now() })

  if (fast.judgment && review.judgment && (fast.model === 'mock' || review.model === 'mock')) {
    // 模拟模式：不联网做最终判断
    finish(review.judgment, 'review-only', { status: 'skipped', reason: '模拟模式不做最终判断' })
  } else if (fast.judgment && review.judgment) {
    const f = fast.judgment
    const r = review.judgment
    const fallDown = (j: Judgment) => !!j.fall?.suspected && j.fall.onGroundAtEnd
    const matchedIds = (j: Judgment) =>
      j.expected
        .filter((e) => e.matched)
        .map((e) => e.id)
        .sort()
        .join(',')
    if (f.verdict !== r.verdict) {
      finish(r, 'reconciled', { status: 'skipped', agree: false, reason: '档位不同，以复核结果为准' })
    } else if (fallDown(f) !== fallDown(r)) {
      finish(r, 'reconciled', { status: 'skipped', agree: false, reason: '是否有人摔倒在地判断不同，以复核结果为准' })
    } else if (f.questionUrgent !== r.questionUrgent) {
      finish(r, 'reconciled', { status: 'skipped', agree: false, reason: '是否需要马上问用户判断不同，以复核结果为准' })
    } else if (matchedIds(f) !== matchedIds(r)) {
      finish(r, 'reconciled', { status: 'skipped', agree: false, reason: '“你在等的事”是否发生判断不同，以复核结果为准' })
    } else {
      try {
        const c = await compareFacts(f, r)
        finish(c.same ? f : r, 'reconciled', {
          status: 'done',
          agree: c.same,
          reason: c.reason,
          raw: c.raw,
          latencyMs: c.latencyMs,
          model: c.model,
        })
      } catch (e) {
        // 比对失败：以复核模型为准
        finish(r, 'review-fallback', { status: 'error', error: (e as Error).message })
      }
    }
  } else if (review.judgment) {
    finish(review.judgment, 'review-only', { status: 'skipped', reason: '快速模型没有结果' })
  } else if (fast.judgment) {
    finish(fast.judgment, 'fast-only', { status: 'skipped', reason: '复核模型没有结果' })
  } else {
    emit({
      status: 'error',
      finishedAt: Date.now(),
      reconcile: { status: 'skipped' },
      error: `两个看图模型都没有结果：${fast.error ?? '—'}；${review.error ?? '—'}`,
    })
  }
  return a
}
