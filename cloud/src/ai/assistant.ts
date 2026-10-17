/**
 * 底部统一输入（《产品逻辑》第 4 节）：用户说一句话，Homi 判断意图再处理——
 * - plan_add / plan_update：布置或修改计划 → 草稿，用户确认后才生效
 * - memory_add / memory_update：新增或修改记忆 → 草稿，用户确认后才生效
 * - query：问发生过什么 → 只根据事件档案回答，附事件作为证据；没看到就说没看到
 * - look_now：问现在的画面 → 当场截一张图再回答（lookNow）
 * - chat：闲聊，简短
 * 模型按“模型与超时”面板：文字理解“理解你说的话”（默认 DeepSeek-V4-Pro 低思考，GLM 备用）；看画面“现在看一眼”（默认 Flash）。
 */
import type { Snapshot } from '../motion/detector'
import type { Box } from '../motion/state-machine'
import type { HomeContext, PlanKind } from '../memory/types'
import { SCENE } from '../config/scene'
import { callStep } from './step'
import { extractJson, strOrNull, toDataUrl } from './judge'
import { toLocalInput } from './feedback'

export type AskIntent = 'plan_add' | 'plan_update' | 'memory_add' | 'memory_update' | 'query' | 'look_now' | 'chat'
const INTENTS: AskIntent[] = ['plan_add', 'plan_update', 'memory_add', 'memory_update', 'query', 'look_now', 'chat']
const KINDS: PlanKind[] = ['expect', 'rule', 'relax']
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

const PROMPT = `你是 Homi，${SCENE.role}。用户在底部输入框对你说了一句话，先判断他想做什么（intent），再回应。

intent：
- "plan_add"：布置一件有时间范围的事（今天、明天、几点到几点）。plan.kind：expect 等一件事、看到就告诉他（如“快递到了告诉我”）；relax 这段时间某类事不用提醒（如“朋友会来坐一会儿”）；rule 某件事应该怎样（如“快递放左边柜子”）
- "plan_update"：修改已有的某条计划（改时间、改内容），plan.target 填计划 id
- "memory_add"：长期、反复的习惯或偏好（如“猫会在客厅走动，不用提醒”）
- "memory_update"：修正已有的某条记忆，memory.target 填记忆 id
- "query"：问发生过什么（如“今天快递到了吗”“下午有人来过吗”）
- "look_now"：问现在的画面（如“展台现在怎么样”“看一眼”）
- "chat"：闲聊或其他

回答 query 时：
- 只能根据【事件档案】回答，用 evidence 列出依据的事件编号（如 ["E3"]），最多 3 个
- 档案里没有就如实说没看到，并说明摄像头只记录画面有变化的时刻、事件保留 7 天；不要编造
- 只说“有人”和动作，不推测身份，不写穿着；不同的事之间不要说“同一个人”

plan / memory 的写法：
- text 简洁客观；不记录人名或能识别身份的信息，用“快递员”“朋友”“家人”等角色
- plan 的 start / end 用 YYYY-MM-DDTHH:mm；没说结束就到当天 23:59，没说开始就从现在开始
- plan.cues 只在 expect 时填用户给出的识别特征（如“拿着纸盒子”），没有就是 null

reply：Homi 对用户说的话，口语、简短、温和，不超过 60 个字；布置或修改时，确认你的理解，并说明“确认后生效”。

只输出一个 JSON 对象：
{"intent": "...", "reply": "...", "evidence": ["E1"] 或 [], "plan": {"kind": "expect | rule | relax", "text": "...", "cues": "... 或 null", "start": "...", "end": "...", "target": "计划 id 或 null"} 或 null, "memory": {"text": "...", "target": "记忆 id 或 null"} 或 null}`

export interface AskInput {
  now: number
  ctx: HomeContext
  /** 最近 7 天的事件档案（每行以编号开头，如 “E1 …”）；编号 → 事件 id */
  archive: { label: string; eventId: string; line: string }[]
  /** 最近几轮对话（理解“那后来呢”这类追问） */
  history: { role: 'user' | 'homi'; text: string }[]
}

export interface AskResult {
  intent: AskIntent
  reply: string
  /** query 的依据（事件 id） */
  evidence: string[]
  plan: { kind: PlanKind; text: string; cues: string | null; start: string; end: string; target: string | null } | null
  memory: { text: string; target: string | null } | null
}

const endOfDay = (now: number) => {
  const d = new Date(now)
  d.setHours(23, 59, 0, 0)
  return d.getTime()
}

export async function askHomi(text: string, input: AskInput): Promise<AskResult> {
  const { now, ctx } = input
  const weekday = new Date(now).toLocaleDateString('zh-CN', { weekday: 'long' })
  const user = [
    `现在：${toLocalInput(now)}（${weekday}）`,
    '',
    '【短期计划】',
    ...(ctx.plans.length
      ? ctx.plans.map((p) => `- ${p.id}（${p.kind}，${p.enabled ? '启用' : '停用'}）：${p.text}，${toLocalInput(p.start)} 到 ${toLocalInput(p.end)}`)
      : ['（无）']),
    '',
    '【长期记忆】',
    ...(ctx.memories.length ? ctx.memories.map((m) => `- ${m.id}${m.enabled ? '' : '（停用）'}：${m.text}`) : ['（无）']),
    '',
    '【事件档案】（最近 7 天，按时间先后）',
    ...(input.archive.length ? input.archive.map((a) => a.line) : ['（没有记录）']),
    '',
    ...(input.history.length
      ? ['【最近的对话】', ...input.history.map((h) => `${h.role === 'user' ? '用户' : 'Homi'}：${h.text}`), '']
      : []),
    `【用户说】${text}`,
  ].join('\n')
  const res = await callStep('assistant', [
    { role: 'system', content: PROMPT },
    { role: 'user', content: user },
  ])
  const obj = extractJson(res.text)
  const intent: AskIntent = INTENTS.includes(obj.intent) ? obj.intent : 'chat'
  const idOf = new Map(input.archive.map((a) => [a.label, a.eventId]))
  const evidence = (Array.isArray(obj.evidence) ? obj.evidence : [])
    .map((l: unknown) => idOf.get(String(l).trim().toUpperCase()))
    .filter((x: string | undefined): x is string => !!x)
    .slice(0, 3)
  const time = (v: unknown, fallback: number) => (typeof v === 'string' && TIME_RE.test(v) ? v : toLocalInput(fallback))
  const p = obj.plan && typeof obj.plan === 'object' ? obj.plan : null
  const m = obj.memory && typeof obj.memory === 'object' ? obj.memory : null
  return {
    intent,
    reply: strOrNull(obj.reply) ?? '好的。',
    evidence: intent === 'query' ? evidence : [],
    plan:
      p && (intent === 'plan_add' || intent === 'plan_update')
        ? {
            kind: KINDS.includes(p.kind) ? p.kind : 'rule',
            text: strOrNull(p.text) ?? '',
            cues: strOrNull(p.cues),
            start: time(p.start, now),
            end: time(p.end, endOfDay(now)),
            target: strOrNull(p.target),
          }
        : null,
    memory: m && (intent === 'memory_add' || intent === 'memory_update') ? { text: strOrNull(m.text) ?? '', target: strOrNull(m.target) } : null,
  }
}

const LOOK_PROMPT = `你是 Homi，${SCENE.role}。用户想知道现在画面里的情况，下面是刚截的一张图（用户设置的忽略区域已裁掉或填成灰色，不用管）。
用一两句话回答用户的问题，口语、简短。只说“有人”和动作、位置，不写穿着，不推测身份、年龄、性别、情绪；看不清就说看不清，不要编造。
只输出回答本身，不要输出 JSON。`

/** “Homi 现在看一眼”：当场截的一张图 + 用户的问题 → 一两句话 */
export async function lookNow(snap: Snapshot, zones: Box[], question: string): Promise<string> {
  const res = await callStep('lookNow', [
    { role: 'system', content: LOOK_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: `用户问：${question}` },
        { type: 'image_url', image_url: { url: await toDataUrl(snap, 1024, zones) } },
      ],
    },
  ])
  return res.text.trim() || '我看了一眼，但没能说清楚画面里的情况。'
}
