/**
 * 写日报的文字：一句话总结 + 每组一句小结，并从候选问题里挑最多 3 个。
 * 分组、数量、时间都由代码算好，模型只写话、只挑问题（结构在 events/report.ts 里校验）。
 */
import { callStep } from './step'
import { extractJson } from './judge'
import { SCENE } from '../config/scene'

/** 模型按“模型与超时”面板的“写日报”（默认 DeepSeek-V4-Pro 低思考 → GLM） */

const PROMPT = `你是${SCENE.role}。根据今天摄像头记录的事件，写一份很短的日报文字。摄像头位置：${SCENE.name}，说到地点时按这个位置说。

要求：
- headline：开头一句话总结今天，口语、平和，不超过 45 个字。先说整体（如“今天展台挺热闹”），再点出最重要的一两件（如提醒过的事、还没结束的变化）。例：“今天展台挺热闹：上午主要在埋头开发，下午来交流的有 6 拨、演示了 4 次，中午外卖到了。”
- groups：每个大类一句小结，不超过 25 个字，说清这类事大概是什么情况（时段、次数、里面主要是哪几类小事，如“上午埋头开发，下午讨论和调试”）；category 用给出的大类 id
- questions：从【候选问题】里挑最多 3 个最值得问的（用编号 Q1、Q2…），意思重复的只留一个；用户的回答要能让以后判断得更准；没有值得问的就给空数组
- 不夸大、不制造紧张，没提醒过的事不要说成危险；不要用“有点情况”“出事了”这类让人紧张的说法
- 只说看到了什么，不判断伤情和健康（不说“无大碍”“没受伤”），例：“有人摔了一下，后来自己起来了”
- 只说“有人”和动作，不写穿着，不推测身份；不同的事之间不要说“同一个人”

只输出 JSON：{"headline": "…", "groups": [{"category": "大类 id", "line": "…"}], "questions": ["Q1"]}`

export async function writeReportText(input: string): Promise<{ obj: unknown; raw: string; latencyMs: number }> {
  const res = await callStep('report', [
    { role: 'system', content: PROMPT },
    { role: 'user', content: input },
  ])
  return { obj: extractJson(res.text), raw: res.text, latencyMs: res.latencyMs }
}
