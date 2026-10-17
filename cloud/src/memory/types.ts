import { DEFAULT_CATEGORIES, type Category } from './categories.ts'

/**
 * 短期计划的三种类型（见《产品逻辑》5.1）：
 * - relax 放宽：时段内这类事不提醒（如“朋友来家里做客”）
 * - rule  规定：不按规定发生才提醒（如“快递放左边柜子”）
 * - expect 期待：发生了就提醒（如“快递到了告诉我”）
 */
export type PlanKind = 'relax' | 'rule' | 'expect'

export const PLAN_KIND_LABEL: Record<PlanKind, string> = { relax: '放宽', rule: '规定', expect: '期待' }

/** 短期计划：有时效的临时安排 */
export interface Plan {
  id: string
  kind: PlanKind
  text: string
  /** 期待型的识别特征，如“穿红色冲锋衣的人，拿着纸盒子”；只用于对照，不用于识别身份 */
  cues?: string
  /** 毫秒时间戳 */
  start: number
  end: number
  enabled: boolean
  /** 期待型：已经看到并提醒过的时间（同一个计划只提醒一次） */
  matchedAt?: number
}

/** 长期记忆：对这个家日常习惯的理解 */
export interface Memory {
  id: string
  text: string
  enabled: boolean
  /**
   * 内置规则：需要“再看一眼”等特殊处理的异常。
   * fall-alert：有人摔倒在地上起不来 → 片段结束 30 秒后再看一眼，还在地上就紧急提醒
   */
  rule?: 'fall-alert'
}

/** 摔倒规则是否开着 */
export const fallRuleOn = (ctx: HomeContext) => ctx.memories.some((m) => m.rule === 'fall-alert' && m.enabled)

export interface HomeContext {
  plans: Plan[]
  memories: Memory[]
  /** 事件分类清单（模型只能从这里选） */
  categories: Category[]
}

export const isPlanActive = (p: Plan, now: number) => p.enabled && p.start <= now && now <= p.end

/**
 * 开关一条计划。重新打开时清除“已到达”：期待型计划再勾上 = 重新开始等，下次看到再提醒一次
 * （如今天还有第二个快递，或反复测试）。
 */
export function togglePlanEnabled(p: Plan): Plan {
  if (p.enabled) return { ...p, enabled: false }
  const { matchedAt: _, ...rest } = p
  return { ...rest, enabled: true }
}

/** 计划当前状态的文字：停用优先，其次已到达，再看是否在时段内 */
export function planStatus(p: Plan, now: number, fmt: (t: number) => string): string {
  if (!p.enabled) return '已停用'
  if (p.matchedAt) return `已到达 ${fmt(p.matchedAt)}`
  return isPlanActive(p, now) ? '生效中' : '不在时段内'
}

/** 示例数据（比赛展台，见 config/scene.ts；10/16 从家庭场景改过来），便于测试第二层 */
export function seedContext(now = new Date()): HomeContext {
  const at = (h: number, m = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m).getTime()
  return {
    plans: [
      {
        id: 'p1',
        kind: 'expect',
        text: '我们点的外卖送到了',
        cues: '拎着外卖袋或餐盒走到桌前的人',
        start: at(0),
        end: at(23, 59),
        enabled: true,
      },
      { id: 'p2', kind: 'relax', text: '下午 2 点到 5 点评委巡场，来桌前交流的人会比较多', start: at(14), end: at(17), enabled: true },
    ],
    memories: [
      { id: 'm1', text: '队员在桌前写代码、讨论、走动是日常，不用提醒', enabled: true },
      { id: 'm2', text: '桌上的东西被拿起、放下是日常，不用提醒', enabled: true },
      { id: 'm3', text: '有人对着镜头挥手、摆弄摄像头是在测试，不用提醒', enabled: true },
      { id: 'm4', text: '有人摔倒在地上起不来，要马上通知我', enabled: true, rule: 'fall-alert' },
    ],
    categories: DEFAULT_CATEGORIES,
  }
}
