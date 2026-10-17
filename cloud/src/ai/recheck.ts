/**
 * “再看一眼”：疑似有人摔倒、片段结束时人还在地上 → 过一会儿主动截一张图，只问一个问题：人还在地上吗？
 * 这是第二层反过来请第一层截图的最小版本：不依赖画面变化，到时间就看。
 */
import type { Snapshot } from '../motion/detector'
import type { Box } from '../motion/state-machine'
import { callStep } from './step'
import { extractJson, strOrNull, toDataUrl } from './judge'

/**
 * 只问一个问题，模型按“模型与超时”面板的“摔倒·再看一眼”（默认最快的 Flash 关闭思考，10 秒没回再发一份）。
 * 两张全图，网关慢时 20 秒不够（10/14 实测两份请求都超时，按“没能确认”误报了一次）→ 默认 30 秒
 */

const PROMPT = `你在帮忙确认一个可能摔倒的人现在怎么样了。
第一张图是之前疑似有人摔倒后的画面，第二张图是现在的画面。
只回答：现在画面里是否还有人倒在地上（躺着、趴着、坐在地上起不来都算；已经站起来、离开画面都不算）。
evidence 只说“有人”和姿势、位置，不写穿着、外貌，不推测身份、年龄、性别。
只输出 JSON：{"stillDown": true 或 false, "evidence": "一句话说明看到了什么"}`

export interface RecheckResult {
  stillDown: boolean
  evidence: string
  latencyMs: number
}

export async function recheckStillDown(before: Snapshot, now: Snapshot, ignoreZones: Box[]): Promise<RecheckResult> {
  const res = await callStep('recheck', [
    { role: 'system', content: PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: '【之前：疑似摔倒后】' },
        { type: 'image_url', image_url: { url: await toDataUrl(before, 1024, ignoreZones) } },
        { type: 'text', text: '【现在】' },
        { type: 'image_url', image_url: { url: await toDataUrl(now, 1024, ignoreZones) } },
      ],
    },
  ])
  const obj = extractJson(res.text)
  if (typeof obj.stillDown !== 'boolean') throw new Error('返回里缺少 stillDown')
  return { stillDown: obj.stillDown, evidence: strOrNull(obj.evidence) ?? '', latencyMs: res.latencyMs }
}
