/**
 * 理解用户主动说的一句话（布置任务 / 添加记忆），生成草稿；用户确认后才保存。
 * 与 feedback.ts 的区别：这里没有“针对哪次事件”的上下文。
 */
import { isPlanActive, type HomeContext, type PlanKind } from '../memory/types'
import { SCENE } from '../config/scene'
import { callStep } from './step'
import { extractJson, strOrNull } from './judge'
import { toLocalInput } from './feedback'

/** 纯文字：模型按“模型与超时”面板的“理解你说的话”（默认 DeepSeek-V4-Pro 低思考 → GLM） */

export interface Instruction {
  intent: 'plan_add' | 'memory_add'
  planKind: PlanKind
  text: string
  cues: string | null
  start: string | null
  end: string | null
  reply: string
}

const SYSTEM_PROMPT = `你是${SCENE.role}。用户刚对你说了一句话，要你记住一件事。把它整理成一条短期计划或长期记忆。

分类：
- 有时间范围的（今天、明天、这周末、几点到几点）→ "plan_add"，填 start 和 end；没说结束就到当天 23:59，没说开始就从现在开始
  - plan_kind：
    - "expect" 期待：用户在等某件事发生，希望看到时告诉他（如“快递到了告诉我”“今天有快递送达”）
    - "relax"  放宽：这段时间某类事不用提醒（如“朋友会在家里待一会儿”）
    - "rule"   规定：某件事应该怎样（如“快递放左边柜子”）
- 长期、反复的习惯或偏好 → "memory_add"

字段：
- text：简洁客观的陈述，如“有快递送达”
- cues：仅期待型，用户给出的识别特征（衣服颜色、携带的物品等），原样整理，如“穿红色冲锋衣的人，拿着纸盒子”；没有就是 null
- 不要记录人名或能识别身份的信息，用“快递员”“朋友”“家人”等角色
- reply：Homi 对用户说的一句话，确认你的理解，不超过 30 字

只输出一个 JSON 对象：
{"intent": "plan_add | memory_add", "plan_kind": "expect | relax | rule", "text": "...", "cues": "... 或 null", "start": "YYYY-MM-DDTHH:mm 或 null", "end": "YYYY-MM-DDTHH:mm 或 null", "reply": "..."}`

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/
const KINDS: PlanKind[] = ['expect', 'relax', 'rule']

export async function interpretInstruction(text: string, ctx: HomeContext, now = Date.now()): Promise<Instruction> {
  const weekday = new Date(now).toLocaleDateString('zh-CN', { weekday: 'long' })
  const active = ctx.plans.filter((p) => isPlanActive(p, now))
  const user = [
    `现在：${toLocalInput(now)}（${weekday}）`,
    '',
    '【当前生效的短期计划】',
    ...(active.length ? active.map((p) => `- ${p.id}：${p.text}`) : ['（无）']),
    '',
    `【用户说】${text}`,
  ].join('\n')
  const res = await callStep('assistant', [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ])
  const obj = extractJson(res.text)
  const time = (v: unknown) => {
    const s = strOrNull(v)
    return s && TIME_RE.test(s) ? s : null
  }
  return {
    intent: obj.intent === 'memory_add' ? 'memory_add' : 'plan_add',
    planKind: KINDS.includes(obj.plan_kind) ? obj.plan_kind : 'rule',
    text: strOrNull(obj.text) ?? text,
    cues: strOrNull(obj.cues),
    start: time(obj.start),
    end: time(obj.end),
    reply: strOrNull(obj.reply) ?? '好的，记下了。',
  }
}
