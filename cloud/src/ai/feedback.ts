/**
 * 理解用户反馈：把“其他 / 不符合的原因”转成记忆或计划的草稿，由用户确认后保存。
 */
import { isPlanActive, type HomeContext } from '../memory/types'
import { SCENE } from '../config/scene'
import { callStep } from './step'
import { extractJson, strOrNull, type Judgment } from './judge'

/** 纯文本任务：模型按“模型与超时”面板的“理解你说的话”（默认 DeepSeek-V4-Pro 低思考，通常 2–4 秒 → GLM） */

export type FeedbackKind = 'disagree' | 'other'

export type Intent = 'memory_add' | 'memory_update' | 'plan_add' | 'none'

export interface Interpretation {
  intent: Intent
  /** Homi 对用户的一句回应 */
  reply: string
  /** 要保存的记忆 / 计划文字 */
  text: string | null
  /** memory_update 时要修改的记忆 id */
  targetId: string | null
  /** plan_add 时的起止，格式 YYYY-MM-DDTHH:mm（本地时间） */
  start: string | null
  end: string | null
}

const SYSTEM_PROMPT = `你是${SCENE.role}。用户刚对你的一次判断给了反馈，你要理解这条反馈，决定是否需要保存为记忆或计划。

分类规则：
- 长期、反复出现的习惯或偏好（如"以后…"、"平时…"、"每天…"）→ "memory_add"
- 是在修正某条已有记忆 → "memory_update"，target_id 填那条记忆的 id
- 有时间范围的临时安排（如"今天"、"明天"、"这周末"、"出差期间"）→ "plan_add"，填 start 和 end；没说结束时间就到当天 23:59
- 只是评价这次判断、没有值得保存的信息 → "none"

写作要求：
- text 用简洁、客观的陈述句，便于以后判断时引用，如"快递盒放在桌上是正常的"
- 不要记录人名或能识别身份的信息，用"家人"、"朋友"、"快递员"等角色代替
- reply 是 Homi 对用户说的一句话，确认你的理解，口语、温和，不超过 30 个字

只输出一个 JSON 对象，不要输出其他文字：
{"intent": "memory_add | memory_update | plan_add | none", "reply": "...", "text": "... 或 null", "target_id": "... 或 null", "start": "YYYY-MM-DDTHH:mm 或 null", "end": "YYYY-MM-DDTHH:mm 或 null"}`

const pad = (n: number) => String(n).padStart(2, '0')
export const toLocalInput = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const INTENTS: Intent[] = ['memory_add', 'memory_update', 'plan_add', 'none']
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

export async function interpretFeedback(input: {
  kind: FeedbackKind
  text: string
  judgment: Judgment
  ctx: HomeContext
  now?: number
}): Promise<Interpretation> {
  const { kind, text, judgment, ctx, now = Date.now() } = input
  const weekday = new Date(now).toLocaleDateString('zh-CN', { weekday: 'long' })
  const verdictText = { record: '记录', notice: '留意', alert: '提醒' }[judgment.verdict]
  const activePlans = ctx.plans.filter((p) => isPlanActive(p, now))
  const user = [
    `现在：${toLocalInput(now)}（${weekday}）`,
    '',
    '【这次事件】',
    `画面变化：${judgment.change}`,
    `你的判断：${verdictText}`,
    `你对用户说：${judgment.message}`,
    ...(judgment.question ? [`你问用户：${judgment.question}`] : []),
    '',
    `【用户反馈】${kind === 'disagree' ? '用户认为你的判断不符合，原因是：' : ''}${text}`,
    '',
    '【已有长期记忆】',
    ...(ctx.memories.length ? ctx.memories.map((m) => `- ${m.id}：${m.text}${m.enabled ? '' : '（已停用）'}`) : ['（无）']),
    '',
    '【当前生效的短期计划】',
    ...(activePlans.length ? activePlans.map((p) => `- ${p.id}：${p.text}`) : ['（无）']),
  ].join('\n')

  // 推理模型的思考也计入额度，给足空间（callStep 默认 4096）
  const res = await callStep('assistant', [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ])
  const obj = extractJson(res.text)
  const intent: Intent = INTENTS.includes(obj.intent) ? obj.intent : 'none'
  const time = (v: unknown) => {
    const s = strOrNull(v)
    return s && TIME_RE.test(s) ? s : null
  }
  return {
    intent,
    reply: strOrNull(obj.reply) ?? '收到，谢谢你告诉我。',
    text: strOrNull(obj.text),
    targetId: strOrNull(obj.target_id),
    start: time(obj.start),
    end: time(obj.end),
  }
}
