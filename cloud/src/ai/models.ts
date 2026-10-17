/**
 * 每一步用哪个模型（调试台右侧“模型与超时”面板，10/15）：
 * 每一步有首选模型、备用模型（最多 3 个，按顺序：首选没回 / 失败就发下一个）、超时、多久没回就同时发备用。
 * 设置存在本浏览器（各标签页自动同步）；最近的调用结果也记下来，选模型时有数据可看。
 * 这个文件不碰网络，便于测试；真正调用在 step.ts。
 */

export interface ModelOption {
  id: string
  label: string
  /** 网关的模型 ID；mock = 不调用模型 */
  model: string
  extra?: Record<string, unknown>
  /** 能看图 */
  vision: boolean
  note: string
}

/** 依据：10/13 五场景看图对比、10/14–15 实测（见《方案与进度》） */
export const MODEL_OPTIONS: ModelOption[] = [
  // 关闭思考：开着时偶尔思考过长、把输出额度用完或卡 60 秒；关闭后准确率不变
  { id: 'flash', label: 'DeepSeek-Flash', model: 'hackathon/v_model/deepseek-v4.1-flash', extra: { thinking: { type: 'disabled' } }, vision: true, note: '最快，看图约 5–15 秒；统一整理那种复杂文字推理会想到额度用完' },
  { id: 'kimi', label: 'Kimi-K3', model: 'hackathon/v_model/kimi-k3', vision: true, note: '看图最准，较慢（30–60 秒）' },
  { id: 'qwen-max', label: 'Qwen-Max', model: 'hackathon/v_model/qwen-max', vision: true, note: '慢，偶尔输出额度用完' },
  { id: 'nova-pro', label: 'Nova Pro', model: 'hackathon/v_model/nova-pro', vision: true, note: '快、不思考；看图常判错' },
  { id: 'v4-pro', label: 'DeepSeek-V4-Pro', model: 'hackathon/v_model/deepseek-v4-pro', extra: { reasoning_effort: 'low' }, vision: false, note: '文字推理强；10/15 常 60 秒超时' },
  { id: 'glm', label: 'GLM-5.2', model: 'hackathon/v_model/glm-5.2', extra: { thinking: { type: 'disabled' } }, vision: false, note: '文字；10/15 常 60 秒超时' },
  // 10/15 实测：网关上 thinking: disabled 对是非题这类提示词无效（Flash 照样想到额度用完），reasoning_effort: 'none' 才真的不思考（1.6 秒、约 40 tokens）
  { id: 'flash-none', label: 'DeepSeek-Flash 不思考', model: 'hackathon/v_model/deepseek-v4.1-flash', extra: { reasoning_effort: 'none' }, vision: true, note: '真正不思考，简单问题 1–2 秒' },
  { id: 'glm-none', label: 'GLM-5.2 不思考', model: 'hackathon/v_model/glm-5.2', extra: { reasoning_effort: 'none' }, vision: false, note: '真正不思考，简单问题约 4 秒' },
  { id: 'mock', label: '模拟', model: 'mock', vision: true, note: '不调用模型（只用于看图判断）' },
]

export const modelOption = (id: string) => MODEL_OPTIONS.find((m) => m.id === id)
export const modelLabel = (id: string) => modelOption(id)?.label ?? id

export type StepId =
  | 'judgeFast'
  | 'judgeReview'
  | 'reconcile'
  | 'keyframes'
  | 'merge'
  | 'recheck'
  | 'consolidatePlan'
  | 'consolidateConfirm'
  | 'consolidateOpen'
  | 'report'
  | 'assistant'
  | 'lookNow'

export interface StepConfig {
  /** 首选 + 备用（同一个模型写两次 = 没回就再发一份同样的请求） */
  chain: string[]
  timeoutMs: number
  /** 多久没回就同时发下一个 */
  hedgeAfterMs: number
}

export interface StepInfo {
  id: StepId
  label: string
  /** 要看图：只能选能看图的模型 */
  vision: boolean
  /** 可以选“模拟” */
  allowMock?: boolean
  desc: string
  defaults: StepConfig
  /** 输出额度（推理模型的思考也算在里面）；默认 4096 */
  maxTokens?: number
}

const c = (chain: string[], timeoutS: number, hedgeS: number): StepConfig => ({ chain, timeoutMs: timeoutS * 1000, hedgeAfterMs: hedgeS * 1000 })

export const STEPS: StepInfo[] = [
  { id: 'judgeFast', label: '看图·快速判断', vision: true, allowMock: true, desc: '每个片段先出一个结果给用户看', defaults: c(['flash', 'flash'], 30, 10) },
  { id: 'judgeReview', label: '看图·复核', vision: true, allowMock: true, desc: '和快速判断同时发，结果为准', defaults: c(['kimi', 'kimi'], 90, 30) },
  { id: 'reconcile', label: '比对 / 重写描述', vision: false, desc: '两个看图结果是否一致；“再看一眼”后重写事件描述', defaults: c(['flash', 'glm'], 30, 8) },
  { id: 'keyframes', label: '选关键图（重问）', vision: true, desc: '看图判断选的关键图不合格时重问', defaults: c(['flash', 'flash'], 30, 8) },
  { id: 'merge', label: '实时合并', vision: true, desc: '新片段并进哪件正在进行的事', defaults: c(['flash', 'flash'], 30, 8) },
  { id: 'recheck', label: '摔倒·再看一眼', vision: true, desc: '30 秒后再截一张，看人还在不在地上', defaults: c(['flash', 'flash'], 30, 10) },
  // 10/15 原来一次做四件事的提示词：V4-Pro 98 秒、思考 7418 tokens，Flash 关不掉思考、额度用完 → 拆成是非题，Flash 就够
  { id: 'consolidatePlan', label: '统一整理·是不是同一件', vision: false, desc: '代码挑好的候选组合，只问是不是同一件事', defaults: c(['flash-none', 'glm-none'], 30, 8) },
  { id: 'consolidateConfirm', label: '统一整理·看图确认', vision: true, desc: '只给合并候选看关键图，确认后合并', defaults: c(['flash', 'flash'], 30, 8) },
  { id: 'consolidateOpen', label: '统一整理·还没结束的变化', vision: false, desc: '留下的变化后来有没有被处理', defaults: c(['flash-none', 'glm-none'], 30, 8) },
  { id: 'report', label: '写日报', vision: false, desc: '一句话总结、每组小结、挑问题', defaults: c(['v4-pro', 'glm'], 60, 15) },
  { id: 'assistant', label: '理解你说的话', vision: false, desc: '底部对话、“告诉 Homi”、反馈', defaults: c(['v4-pro', 'glm'], 60, 15) },
  { id: 'lookNow', label: '现在看一眼', vision: true, desc: '对话里让 Homi 看一眼现在的画面', defaults: c(['flash', 'flash'], 30, 10) },
]

export const stepInfo = (id: StepId) => STEPS.find((s) => s.id === id)!

/** 这一步能选哪些模型 */
export const modelsFor = (s: StepInfo) => MODEL_OPTIONS.filter((m) => (m.id === 'mock' ? !!s.allowMock : !s.vision || m.vision))

export const MAX_CHAIN = 3
const clamp = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback

/** 校验保存的设置：模型不在这一步的可选范围里就去掉；空了用默认；超时 5–180 秒，备用不晚于超时 */
export function normalizeConfig(s: StepInfo, raw: Partial<StepConfig> | undefined): StepConfig {
  const allowed = new Set(modelsFor(s).map((m) => m.id))
  const chain = Array.isArray(raw?.chain) ? raw!.chain.filter((id) => typeof id === 'string' && allowed.has(id)).slice(0, MAX_CHAIN) : []
  // 模拟只能单独用（没有备用的意义）
  const fixed = chain[0] === 'mock' ? ['mock'] : chain.filter((id) => id !== 'mock')
  const timeoutMs = clamp(raw?.timeoutMs, 5000, 180000, s.defaults.timeoutMs)
  return {
    chain: fixed.length ? fixed : s.defaults.chain,
    timeoutMs,
    hedgeAfterMs: clamp(raw?.hedgeAfterMs, 1000, timeoutMs, Math.min(s.defaults.hedgeAfterMs, timeoutMs)),
  }
}

// ───── 保存在本浏览器 ─────

export const CONFIG_KEY = 'porchlight-model-steps-v1'
export const STATS_KEY = 'porchlight-model-stats-v1'
/** 每一步记最近多少次调用 */
export const STATS_KEEP = 20

const listeners = new Set<() => void>()
export function subscribeModels(l: () => void) {
  listeners.add(l)
  return () => void listeners.delete(l)
}
const notify = () => listeners.forEach((l) => l())

function read<T>(key: string, fallback: T): T {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function write(key: string, v: unknown) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* 存不了不影响使用 */
  }
}

let configCache: Partial<Record<StepId, Partial<StepConfig>>> | null = null
let statsCache: Partial<Record<StepId, CallRecord[]>> | null = null

// 别的标签页改了设置或记了调用：清掉缓存、通知界面
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === CONFIG_KEY) configCache = null
    else if (e.key === STATS_KEY) statsCache = null
    else return
    notify()
  })
}

export function getStepConfig(id: StepId): StepConfig {
  configCache ??= read(CONFIG_KEY, {})
  return normalizeConfig(stepInfo(id), configCache[id])
}

export function setStepConfig(id: StepId, cfg: StepConfig) {
  configCache ??= read(CONFIG_KEY, {})
  configCache = { ...configCache, [id]: normalizeConfig(stepInfo(id), cfg) }
  write(CONFIG_KEY, configCache)
  notify()
}

/** 恢复默认（不给 id = 全部） */
export function resetStepConfig(id?: StepId) {
  configCache ??= read(CONFIG_KEY, {})
  if (id) {
    const { [id]: _, ...rest } = configCache
    configCache = rest
  } else configCache = {}
  write(CONFIG_KEY, configCache)
  notify()
}

/** 改过设置（和默认不同） */
export const isCustom = (id: StepId) => JSON.stringify(getStepConfig(id)) !== JSON.stringify(stepInfo(id).defaults)

// ───── 最近的调用结果 ─────

export interface CallRecord {
  t: number
  ok: boolean
  ms: number
  /** 实际返回结果的模型（id）；失败时为首选模型 */
  model: string
  /** 失败原因（简短） */
  error?: string
}

export function recordCall(id: StepId, rec: CallRecord) {
  statsCache ??= read(STATS_KEY, {})
  statsCache = { ...statsCache, [id]: [...(statsCache[id] ?? []), rec].slice(-STATS_KEEP) }
  write(STATS_KEY, statsCache)
  notify()
}

export const getCalls = (id: StepId): CallRecord[] => {
  statsCache ??= read(STATS_KEY, {})
  return statsCache[id] ?? []
}

export interface StepStats {
  n: number
  ok: number
  /** 成功的平均耗时（毫秒） */
  avgMs: number | null
  timeouts: number
  /** 成功结果分别来自哪个模型 */
  byModel: Record<string, number>
}

export function summarize(calls: CallRecord[]): StepStats {
  const ok = calls.filter((c) => c.ok)
  return {
    n: calls.length,
    ok: ok.length,
    avgMs: ok.length ? Math.round(ok.reduce((s, c) => s + c.ms, 0) / ok.length) : null,
    timeouts: calls.filter((c) => !c.ok && /超时/.test(c.error ?? '')).length,
    byModel: ok.reduce<Record<string, number>>((m, c) => ({ ...m, [c.model]: (m[c.model] ?? 0) + 1 }), {}),
  }
}

/** 网关返回的模型名 → 选项 id（统计“结果来自哪个模型”） */
// 网关返回的名字会变形（如 glm-5.2 → glm-5-2-260617、deepseek-v4.1-flash → deepseek-v4-1-flash-260910）：只比字母数字
const bare = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
/** candidates：这一步设置里的模型，先在里面找（同一个网关模型有“不思考”等几个选项时分得清） */
export const optionIdOf = (gatewayModel: string, candidates: string[] = []) => {
  const hit = (m: ModelOption) => m.model !== 'mock' && bare(gatewayModel).includes(bare(m.model.split('/').pop()!))
  return (
    candidates.map(modelOption).find((m): m is ModelOption => !!m && hit(m))?.id ?? MODEL_OPTIONS.find(hit)?.id ?? gatewayModel
  )
}
