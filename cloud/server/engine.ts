/**
 * 云端 Homi（《产品逻辑》8.1）：一户一个，常驻运行。
 * 采集端上传片段 → 第二层看图判断 → 提醒 → 合并成事件 → 统一整理 → 日报；计划与记忆；保存在云端。
 * 网页、App 都只是显示和操作界面：状态通过 onChange 推给它们，操作通过 command 进来。
 *
 * 逻辑从网页版 dev/src/core/useHomi.ts（主控页那部分）搬过来，规则一致；不依赖浏览器。
 */
import type { Segment, Snapshot } from '../src/motion/detector'
import { DEFAULT_CONFIG, type Box, type MotionConfig } from '../src/motion/state-machine'
import { analyzeSegment, type Analysis } from '../src/ai/pipeline'
import { ensureKeyFrames, type KeyFrameResult } from '../src/ai/keyframes'
import { decideEvent, resummarize, type MergeFrame } from '../src/ai/merge'
import { recheckStillDown } from '../src/ai/recheck'
import { askOpenChanges, askSamePairs, confirmMerge } from '../src/ai/consolidate'
import { writeReportText } from '../src/ai/report'
import { primaryOf } from '../src/ai/step'
import type { Judgment } from '../src/ai/judge'
import {
  allowedTargets,
  appendToEvent,
  groupAllowed,
  lockedCategory,
  maxVerdict,
  openEvents,
  startEvent,
  takeSettled,
  type EventKeyFrame,
  type HomiEvent,
  type MergeDecision,
  type SegmentBrief,
} from '../src/events/grouping'
import {
  candidatePairs,
  groupsFromPairs,
  labelEvents,
  mergeEventGroup,
  pairKey,
  pairSig,
  parseOpenChanges,
  parsePairAnswers,
  type EventLink,
  type OpenChange,
} from '../src/events/consolidate'
import { dedupeQuestions, groupByCategory, isReportDue, parseReportText, type DailyReport, type ReportAlert, type ReportQuestion } from '../src/events/report'
import { decideUrgentQuestion } from '../src/events/urgent'
import { fallRuleOn, isPlanActive, seedContext, type HomeContext, type Plan } from '../src/memory/types'
import { findCategory, findLabel, groupOf } from '../src/memory/categories'
import { applyDraft, type ApplyResult, type Draft } from '../src/memory/apply'
import { EVENT_RETENTION_DAYS, REPORT_RETENTION_DAYS, dayKey, isExpired, isSameDay, sparseSequence } from '../src/store/retention'
import { reduceToKeyFrames, restoredAnalysis } from '../src/store/persist'
import type { Alert, ExpectAlert, FallAlert, QuestionAlert } from '../src/components/AlertBanner'
import type { FallWatch } from '../src/components/SegmentCard'
import type { Vote } from '../src/components/FeedbackBar'
import type { SetupChoices } from '../src/components/SetupSheet'
import { Store, grayToB64, imageUrl, type ServerStoredSegment } from './store'

const VERDICT_LABEL = { record: '记录', notice: '留意', alert: '提醒' } as const
const MAX_FULL_SEGMENTS = 30
const FALL_RECHECK_MS = 30_000
const FALL_SECOND_CHECK_MS = 120_000
const CONSOLIDATE_INTERVAL_MS = 2 * 60 * 60 * 1000
const CONSOLIDATE_RETRY_MS = 10 * 60 * 1000
const CONSOLIDATE_RETRIES = 2
const CONCURRENCY = 5

type KeyFrameState = KeyFrameResult | { status: 'picking' }

export interface FeedbackEntry {
  segmentId: string
  t: number
  vote?: Vote | null
  note?: string
  savedRef?: string
}

interface Consolidation {
  running: boolean
  at: number | null
  links: EventLink[]
  leftChanges: Record<string, string>
  openChanges: OpenChange[]
  note: string
  checked?: Record<string, string>
}

interface ReportState {
  data: DailyReport | null
  running: string | null
  error: string | null
}

/** 摄像头设置：第一层参数、忽略区域（存在云端，推给采集端） */
export interface CameraSettings {
  config: MotionConfig
  zones: Box[]
}

/** 存进 state.json 的部分 */
interface PersistedState {
  events: HomiEvent[]
  consolidation: Omit<Consolidation, 'running'>
  alertLog: ReportAlert[]
  doneKeys: string[]
  homeCtx: HomeContext
  reports: Record<string, DailyReport>
  fallWatches: Record<string, FallWatch>
  lastTimerReportAt: number | null
  feedbackLog: FeedbackEntry[]
  settings: CameraSettings
}

export interface EngineHooks {
  /** 状态变了（要推给界面、要保存） */
  onChange: () => void
  /** 向采集端要一张当前画面；没有采集端 / 超时为 null */
  requestSnapshot: () => Promise<Snapshot | null>
}

function applySetup(ctx: HomeContext, c: SetupChoices): HomeContext {
  return { ...ctx, memories: ctx.memories.map((m) => (m.rule === 'fall-alert' ? { ...m, enabled: c.fallAlert } : m)) }
}

function fallNote(f: FallWatch | undefined): string | null {
  if (!f) return null
  switch (f.state) {
    case 'waiting':
    case 'checking':
      return '疑似有人摔倒，正在等 30 秒后再看一眼'
    case 'up':
      return `30 秒后再看：已经不在地上了（${f.evidence ?? ''}），没有提醒`
    case 'alerted':
      return f.round > 1 ? '2 分钟后再看：仍在地上，已再次紧急提醒' : `30 秒后再看：仍在地上，已紧急提醒（${f.evidence ?? ''}）`
    case 'handled':
      return '摔倒紧急提醒，用户已处理'
    case 'false-alarm':
      return '用户标记摔倒提醒为误报'
    default:
      return null
  }
}

const clockOf = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })

export class HomiEngine {
  // ───── 状态（推给界面）─────
  segments = new Map<string, Segment>()
  analyses: Record<string, Analysis> = {}
  keyFrames: Record<string, KeyFrameState> = {}
  fallWatches: Record<string, FallWatch> = {}
  events: HomiEvent[] = []
  consolidation: Consolidation = { running: false, at: null, links: [], leftChanges: {}, openChanges: [], note: '' }
  alerts: Alert[] = []
  alertLog: ReportAlert[] = []
  report: ReportState = { data: null, running: null, error: null }
  reports: Record<string, DailyReport> = {}
  lastTimerReportAt: number | null = null
  doneKeys = new Set<string>()
  homeCtx: HomeContext = seedContext()
  feedbackLog: FeedbackEntry[] = []
  settings: CameraSettings = { config: DEFAULT_CONFIG, zones: [] }
  /** 采集端（开着摄像头的页面）：null = 没有画面进来 */
  live: { name: string } | null = null
  note = ''

  // ───── 内部 ─────
  private settled = new Map<string, Judgment | null>()
  private kfDone = new Map<string, KeyFrameResult>()
  private segEvent = new Map<string, string>()
  /** 这次画面来源里的事：新片段只和其中正在进行的比 */
  liveEventIds: string[] = []
  mergeQueue: string[] = []
  private merging = false
  private waiting: Segment[] = []
  private active = 0
  private fallTimers = new Map<string, NodeJS.Timeout>()
  private segArrivedAt = new Map<string, number>()
  private retry: { count: number; timer?: NodeJS.Timeout } = { count: 0 }
  private reportRunning = false
  private prevAlertIds = new Set<string>()

  constructor(
    private store: Store,
    private hooks: EngineHooks,
  ) {}

  private changed() {
    this.trackAlertLog()
    this.hooks.onChange()
  }

  // ───── 读回 / 保存 ─────

  async load() {
    await this.store.init()
    const s = await this.store.loadState<PersistedState>()
    const now = Date.now()
    if (s) {
      // 分类清单跟着代码走（新增的默认分类能用上）
      this.homeCtx = { ...s.homeCtx, categories: seedContext().categories }
      this.events = s.events.filter((e) => !isExpired(e.endedAt, now, EVENT_RETENTION_DAYS)).map((e) => ({ ...e, busy: false }))
      this.consolidation = { ...this.consolidation, ...s.consolidation, running: false }
      this.alertLog = s.alertLog.filter((a) => !isExpired(a.at, now, EVENT_RETENTION_DAYS))
      this.doneKeys = new Set(s.doneKeys)
      this.reports = Object.fromEntries(Object.entries(s.reports ?? {}).filter(([, r]) => !isExpired(r.at, now, REPORT_RETENTION_DAYS)))
      this.report = { data: this.reports[dayKey(now)] ?? null, running: null, error: null }
      this.lastTimerReportAt = s.lastTimerReportAt
      this.feedbackLog = s.feedbackLog ?? []
      this.settings = { config: { ...DEFAULT_CONFIG, ...s.settings?.config }, zones: s.settings?.zones ?? [] }
      // 没完成的“再看一眼”接不上了
      this.fallWatches = Object.fromEntries(
        Object.entries(s.fallWatches ?? {}).map(([id, w]) =>
          w.state === 'waiting' || w.state === 'checking' ? [id, { ...w, state: 'stopped' as const, evidence: '服务重启，没有再看' }] : [id, w],
        ),
      )
    }
    const keep = new Set(this.events.flatMap((e) => e.segmentIds))
    for (const st of await this.store.loadSegments()) {
      if (!keep.has(st.id) && isExpired(st.endedAt, now, EVENT_RETENTION_DAYS)) {
        await this.store.deleteSegment(st.id)
        continue
      }
      try {
        const seg = await this.restoreSegment(st)
        this.segments.set(seg.id, seg)
        this.settled.set(seg.id, st.judgment)
        if (st.keyFrames) {
          this.kfDone.set(seg.id, st.keyFrames)
          this.keyFrames[seg.id] = st.keyFrames
        }
        const an = restoredAnalysis(st as never, { fast: primaryOf('judgeFast'), review: primaryOf('judgeReview') })
        if (an) this.analyses[seg.id] = an
      } catch (e) {
        console.warn('片段读不回来', st.id, (e as Error).message)
      }
    }
    // 事件里引用的片段没了（被删）：去掉引用；服务重启前没来得及合并的片段：
    // 已经看过的各自成为一件事；还没看完的（重启打断了分析）重新分析，再照常合并
    const inEvent = new Set(this.events.flatMap((e) => e.segmentIds))
    const unfinished: Segment[] = []
    for (const seg of [...this.segments.values()].sort((a, b) => a.startedAt - b.startedAt)) {
      if (inEvent.has(seg.id)) continue
      // 只补最近 2 小时的（更早的没看完就算了，免得每次重启都重新花一遍额度）
      if ((!this.settled.has(seg.id) || !this.settled.get(seg.id)) && now - seg.endedAt < 2 * 3600_000) {
        unfinished.push(seg)
        continue
      }
      const j = this.settled.get(seg.id) ?? null
      this.events.push(
        startEvent(
          { id: seg.id, startedAt: seg.startedAt, endedAt: seg.endedAt, change: j?.change ?? null, verdict: j?.verdict ?? null, category: j?.category ?? null, notes: [], left: j?.leftChange ?? null },
          { segmentId: seg.id, same: false, reason: '服务重启前没来得及合并', byRule: true },
          (this.kfDone.get(seg.id)?.frames ?? []).map((k) => ({ segmentId: seg.id, ...k })),
        ),
      )
    }
    this.events.sort((a, b) => a.startedAt - b.startedAt)
    this.events.forEach((e) => e.segmentIds.forEach((sid) => this.segEvent.set(sid, e.id)))
    this.prevAlertIds = new Set(this.alerts.map((a) => a.id))
    this.note = `读回 ${this.events.length} 件事、${this.segments.size} 个片段${unfinished.length ? `，${unfinished.length} 个没看完的重新分析` : ''}`
    this.startTimers()
    for (const seg of unfinished) {
      this.mergeQueue.push(seg.id)
      this.runAnalysis(seg)
    }
  }

  private async restoreSegment(st: ServerStoredSegment): Promise<Segment> {
    const kept = new Map<number, Snapshot>()
    for (const f of st.frames) kept.set(f.index, await this.store.snapshot(st.id, f))
    const seq = sparseSequence(st.middleCount + 2, kept)
    return {
      id: st.id,
      startedAt: st.startedAt,
      endedAt: st.endedAt,
      endReason: st.endReason,
      measurements: st.measurements,
      ignoreZones: st.ignoreZones,
      before: seq[0],
      middle: seq.slice(1, -1),
      after: seq[seq.length - 1],
      keyFramesOnly: st.keyFramesOnly || st.frames.length < st.middleCount + 2,
    }
  }

  /** 片段存档：保留了哪几张截图就记哪几张 */
  private async saveSegmentRecord(seg: Segment) {
    // 片段已经删了（如“删除所有记录”时分析还没完成）：不再写回，免得留下没有截图的记录
    if (!this.segments.has(seg.id)) return
    const seq = [seg.before, ...seg.middle, seg.after]
    const frames = new Map<number, (typeof seq)[number]>()
    seq.forEach((s, i) => {
      const m = /\/(\d+)\.jpg$/.exec(s.url)
      const idx = m ? Number(m[1]) : i
      if (!frames.has(idx)) frames.set(idx, s)
    })
    await this.store.saveSegment({
      id: seg.id,
      startedAt: seg.startedAt,
      endedAt: seg.endedAt,
      endReason: seg.endReason,
      measurements: seg.measurements,
      ignoreZones: seg.ignoreZones,
      middleCount: seg.middle.length,
      frames: [...frames].map(([index, s]) => ({ index, t: s.t, width: s.width, height: s.height, gray: grayToB64(s.gray) })),
      keyFramesOnly: !!seg.keyFramesOnly,
      judgment: this.settled.get(seg.id) ?? null,
      keyFrames: this.kfDone.get(seg.id) ?? null,
    })
  }

  persistedState(): PersistedState {
    const { running: _r, ...consolidation } = this.consolidation
    return {
      events: this.events,
      consolidation,
      alertLog: this.alertLog,
      doneKeys: [...this.doneKeys],
      homeCtx: this.homeCtx,
      reports: this.reports,
      fallWatches: this.fallWatches,
      lastTimerReportAt: this.lastTimerReportAt,
      feedbackLog: this.feedbackLog,
      settings: this.settings,
    }
  }

  // ───── 采集端上传片段 ─────

  /** 新片段到达（截图已存好，url 指向 /api/images/…） */
  ingest(seg: Segment) {
    this.segArrivedAt.set(seg.id, Date.now())
    this.segments.set(seg.id, seg)
    this.reduceOld()
    this.mergeQueue.push(seg.id)
    this.runAnalysis(seg)
    void this.saveSegmentRecord(seg)
    this.changed()
  }

  /** 最近 30 个片段留全部截图（调试“全部 N 张”）；更早的只留关键图，其余截图删掉 */
  private reduceOld() {
    const list = [...this.segments.values()].sort((a, b) => b.startedAt - a.startedAt)
    list.slice(MAX_FULL_SEGMENTS).forEach((s) => {
      const kf = this.kfDone.get(s.id)
      if (s.keyFramesOnly || !kf) return
      const reduced = reduceToKeyFrames(s, kf)
      this.segments.set(s.id, reduced)
      const keep = [...new Set([reduced.before, ...reduced.middle, reduced.after].map((x) => Number(/\/(\d+)\.jpg$/.exec(x.url)?.[1] ?? -1)))]
      void this.store.pruneImages(s.id, keep).then(() => this.saveSegmentRecord(reduced))
    })
  }

  /** 换了画面来源：新片段不和旧来源的事件合并；没完成的“再看一眼”停下 */
  sourceChanged(name: string | null) {
    if (name) {
      this.liveEventIds = []
      this.mergeQueue = []
    }
    if (!name || name !== this.live?.name) this.stopAllFallWatches()
    this.live = name ? { name } : null
    this.changed()
  }

  // ───── 分析 ─────

  runAnalysis(seg: Segment) {
    if (this.waiting.some((s) => s.id === seg.id)) return
    const now = Date.now()
    this.analyses = {
      ...this.analyses,
      [seg.id]: {
        status: 'queued',
        startedAt: now,
        fast: { model: primaryOf('judgeFast'), status: 'pending', startedAt: now },
        review: { model: primaryOf('judgeReview'), status: 'pending', startedAt: now },
        reconcile: { status: 'pending' },
      },
    }
    this.waiting.push(seg)
    this.pump()
    this.changed()
  }

  private pump() {
    while (this.active < CONCURRENCY && this.waiting.length) {
      const seg = this.waiting.shift()!
      this.active++
      void this.analyzeOne(seg).finally(() => {
        this.active--
        this.pump()
      })
    }
  }

  private async analyzeOne(seg: Segment) {
    if (!this.segments.has(seg.id)) return
    const update = (a: Analysis) => {
      // 分析途中片段被删了（删除所有记录）：结果不要了
      if (!this.segments.has(seg.id)) return
      this.analyses = { ...this.analyses, [seg.id]: a }
      if (a.fast.judgment) this.startFallWatch(seg, a.fast.judgment)
      this.changed()
    }
    try {
      const a = await analyzeSegment(seg, this.homeCtx, update)
      if (!this.segments.has(seg.id)) return
      if (a.status === 'done' && a.final) {
        this.raiseExpectedAlerts(seg, a.final)
        this.raiseUrgentQuestion(seg, a.final)
        this.startFallWatch(seg, a.final)
        const down = !!a.final.fall?.suspected && a.final.fall.onGroundAtEnd
        if (!down) this.cancelFallWatchIfPending(seg.id)
        if (a.final.keyFrames.length === 0) {
          this.keyFrames = { ...this.keyFrames, [seg.id]: { status: 'picking' } }
          this.changed()
        }
        const kf = await ensureKeyFrames(seg, this.homeCtx, a.final)
        this.kfDone.set(seg.id, kf)
        this.keyFrames = { ...this.keyFrames, [seg.id]: kf }
      }
      if (!this.settled.has(seg.id) || a.final) this.settled.set(seg.id, a.final ?? null)
    } catch (e) {
      update({
        status: 'error',
        startedAt: Date.now(),
        fast: { model: primaryOf('judgeFast'), status: 'error', startedAt: Date.now() },
        review: { model: primaryOf('judgeReview'), status: 'error', startedAt: Date.now() },
        reconcile: { status: 'skipped' },
        error: `出错：${(e as Error).message}`,
      })
      if (!this.settled.has(seg.id)) this.settled.set(seg.id, null)
    }
    void this.saveSegmentRecord(this.segments.get(seg.id) ?? seg)
    this.changed()
    void this.processMerges()
  }

  // ───── 合并成事件 ─────

  private commitEvents(next: HomiEvent[]) {
    this.events = next
    this.changed()
  }
  private patchEvent(id: string, patch: (e: HomiEvent) => HomiEvent) {
    this.commitEvents(this.events.map((e) => (e.id === id ? patch(e) : e)))
  }

  private briefOf(seg: Segment): SegmentBrief {
    const j = this.settled.get(seg.id) ?? null
    const notes: string[] = []
    for (const e of j?.expected ?? []) {
      const p = e.matched ? this.homeCtx.plans.find((x) => `plan:${x.id}` === e.id) : undefined
      if (p) notes.push(`已提醒用户：${p.text}`)
    }
    const f = fallNote(this.fallWatches[seg.id])
    if (f) notes.push(f)
    const fw = this.fallWatches[seg.id]?.state
    const onlyFall = j?.verdict === 'alert' && !j.expected.some((e) => e.matched) && !j.questionUrgent
    const verdict = onlyFall && (fw === 'up' || fw === 'false-alarm') ? 'notice' : (j?.verdict ?? null)
    return { id: seg.id, startedAt: seg.startedAt, endedAt: seg.endedAt, change: j?.change ?? null, verdict, category: j?.category ?? null, notes, left: j?.leftChange ?? null }
  }

  private segKeyFrames(seg: Segment): { frames: EventKeyFrame[]; status: HomiEvent['keyFrameStatus'] } {
    const kf = this.kfDone.get(seg.id)
    if (!kf) return { frames: [0, seg.middle.length + 1].map((index) => ({ segmentId: seg.id, index, note: '' })), status: 'pending' }
    return { frames: kf.frames.map((k) => ({ segmentId: seg.id, ...k })), status: kf.status }
  }

  private toMergeFrames(refs: EventKeyFrame[]): MergeFrame[] {
    return refs.flatMap((ref) => {
      const s = this.segments.get(ref.segmentId)
      const snap = s ? [s.before, ...s.middle, s.after][ref.index] : undefined
      return s && snap ? [{ ref, snap, zones: s.ignoreZones }] : []
    })
  }

  private presentAtEndOf = (ev: HomiEvent) => {
    const last = ev.segmentIds[ev.segmentIds.length - 1]
    return last ? (this.settled.get(last)?.presentAtEnd ?? null) : null
  }

  leftOf(ev: HomiEvent): string | null {
    return (ev.left !== undefined ? ev.left : this.consolidation.leftChanges[ev.id]) ?? null
  }

  private async mergeOne(seg: Segment) {
    const brief = this.briefOf(seg)
    const own = this.segKeyFrames(seg)
    const startNew = (decision: MergeDecision) => {
      const ev = startEvent(brief, decision, own.frames, own.status)
      this.segEvent.set(seg.id, ev.id)
      this.liveEventIds = [...this.liveEventIds, ev.id]
      this.commitEvents([...this.events, ev])
    }
    const byRule = (reason: string) => startNew({ segmentId: seg.id, same: false, reason, byRule: true })
    if (brief.change === null) return byRule('这段没能分析')
    const open = openEvents(this.events, this.liveEventIds, brief, this.presentAtEndOf)
    if (open.length === 0) return byRule('前面没有正在进行的事（隔了一段时间、最后画面里也没人了），等统一整理')
    const isFall = !!this.settled.get(seg.id)?.fall?.suspected
    const candidates = allowedTargets(open, brief, isFall).filter((e) => e.segmentIds.some((id) => this.segments.has(id)))
    if (candidates.length === 0) return byRule(isFall ? '疑似摔倒，必须单独成一件' : '这段是提醒，正在进行的事里没有同一事由的，单独成一件')
    const ids = candidates.map((e) => e.id)
    this.commitEvents(this.events.map((e) => (ids.includes(e.id) ? { ...e, busy: true } : e)))
    const unbusy = () => this.commitEvents(this.events.map((e) => (ids.includes(e.id) ? { ...e, busy: false } : e)))
    try {
      const r = await decideEvent({
        open: candidates.map((e) => ({
          id: e.id,
          summary: e.summary,
          category: e.category,
          left: this.leftOf(e),
          segments: e.segmentIds.map((id) => this.segments.get(id)).filter((s): s is Segment => !!s).map((s) => this.briefOf(s)),
          presentAtEnd: this.presentAtEndOf(e),
          frames: this.toMergeFrames(e.keyFrames),
        })),
        next: brief,
        nextFrames: this.toMergeFrames(own.frames),
        categories: this.homeCtx.categories,
      })
      const decision: MergeDecision = {
        segmentId: seg.id,
        same: r.targetId !== null,
        kind: r.targetId !== null ? 'same' : 'new',
        reason: r.reason,
        byRule: false,
        latencyMs: r.latencyMs,
        retries: r.retries,
      }
      unbusy()
      if (r.targetId) {
        this.segEvent.set(seg.id, r.targetId)
        this.patchEvent(r.targetId, (e) => {
          const category = lockedCategory([e, { category: brief.category ?? 'other', verdict: brief.verdict }]) ?? r.category
          return appendToEvent(e, brief, r.summary ?? '', decision, category, { picked: r.keyFrames, added: own.frames }, r.left)
        })
      } else {
        startNew(decision)
      }
    } catch (e) {
      unbusy()
      startNew({ segmentId: seg.id, same: false, reason: '', byRule: false, error: (e as Error).message })
    }
  }

  private async processMerges() {
    if (this.merging) return
    this.merging = true
    try {
      for (;;) {
        const ready = takeSettled(this.mergeQueue, (id) => this.settled.has(id))
        if (ready.length === 0) break
        const id = this.mergeQueue.shift()!
        const seg = this.segments.get(id)
        if (seg) await this.mergeOne(seg)
      }
    } finally {
      this.merging = false
    }
  }

  // ───── 统一整理 ─────

  private archiveLine(label: string, ev: HomiEvent) {
    const segs = ev.segmentIds.map((id) => this.segments.get(id)).filter((s): s is Segment => !!s)
    const notes = segs.flatMap((s) => this.briefOf(s).notes)
    const left = this.leftOf(ev)
    const cat = findCategory(ev.category, this.homeCtx.categories).name
    const verdict = ev.verdict ? VERDICT_LABEL[ev.verdict] : '没能分析'
    return [
      `- ${label} ${clockOf(ev.startedAt)}–${clockOf(ev.endedAt)}（${cat}，${verdict}，${ev.segmentIds.length} 个片段）：${ev.summary}`,
      ...notes.map((n) => `  ${n}`),
      ...(left ? [`  留下的变化：${left}`] : []),
      ...(this.doneKeys.has(`open-${ev.id}`) ? ['  用户已确认：这件事留下的变化已经处理过了'] : []),
    ].join('\n')
  }

  async consolidate(trigger: 'manual' | 'timer' | 'report' | 'retry', wait = false) {
    if (wait) {
      const t = Date.now()
      while ((this.merging || this.consolidation.running) && Date.now() - t < 120_000) await new Promise((r) => setTimeout(r, 500))
    }
    if (this.merging || this.consolidation.running) return
    const ready = this.events.filter((e) => !e.busy && isSameDay(e.startedAt, Date.now()))
    if (ready.length === 0) return
    this.merging = true
    this.consolidation = { ...this.consolidation, running: true }
    this.changed()
    const t0 = Date.now()
    const cats = this.homeCtx.categories
    let note = ''
    try {
      const checked = this.consolidation.checked ?? {}
      const pairs = candidatePairs(ready, checked, (c) => groupOf(c, this.homeCtx.categories))
      const answers = pairs.length ? parsePairAnswers(await askSamePairs(pairs.map(([a, b]) => [this.archiveLine('A', a), this.archiveLine('B', b)])), pairs) : []
      const renamed = new Map<string, string>()
      const unsure = new Set<string>()
      let merged = 0
      for (const ids of groupsFromPairs(answers.filter((x) => x.same).map((x) => x.pair))) {
        const group = ids.map((id) => this.events.find((e) => e.id === id)).filter((e): e is HomiEvent => !!e)
        if (group.length < 2 || !groupAllowed(group)) continue
        const reason = answers.find((x) => x.same && ids.includes(x.pair[0].id))?.reason ?? ''
        try {
          const r = await confirmMerge({ lines: group.map((e, i) => this.archiveLine(`E${i + 1}`, e)), frames: this.toMergeFrames(group.flatMap((e) => e.keyFrames)), categories: cats })
          if (!r.same) continue
          const keep = group[0].id
          this.events = mergeEventGroup(this.events, ids, { ...r, category: lockedCategory(group) ?? r.category, reason: r.reason || reason })
          for (const e of group) {
            e.segmentIds.forEach((sid) => this.segEvent.set(sid, keep))
            if (e.id !== keep) renamed.set(e.id, keep)
          }
          this.liveEventIds = [...new Set(this.liveEventIds.map((id) => renamed.get(id) ?? id))]
          merged++
          this.changed()
        } catch {
          ids.forEach((id) => unsure.add(id))
        }
      }
      const alive = new Set(this.events.map((e) => e.id))
      const nextChecked = Object.fromEntries(
        [
          ...Object.entries(checked),
          ...answers.filter(({ pair: [a, b] }) => !unsure.has(a.id) && !unsure.has(b.id)).map(({ pair: [a, b] }) => [pairKey(a, b), pairSig(a, b)] as const),
        ].filter(([k]) => k.split('~').every((id) => alive.has(id))),
      )
      const today = labelEvents(this.events.filter((e) => isSameDay(e.startedAt, Date.now())))
      const open = today.some((l) => this.leftOf(l.event))
        ? parseOpenChanges(await askOpenChanges(today.map((l) => this.archiveLine(l.label, l.event))), today)
        : { openChanges: [], links: [] }
      const re = (id: string) => renamed.get(id) ?? id
      this.consolidation = {
        ...this.consolidation,
        links: [...this.consolidation.links, ...open.links]
          .map((l) => ({ ...l, from: re(l.from), to: re(l.to) }))
          .filter((l) => l.from !== l.to && alive.has(l.from) && alive.has(l.to))
          .filter((l, i, all) => all.findIndex((x) => x.from === l.from && x.to === l.to) === i),
        openChanges: open.openChanges,
        checked: nextChecked,
      }
      note = `${{ manual: '手动', timer: '定时', report: '日报前', retry: '自动重试' }[trigger]}整理：${ready.length} 件事，比较 ${pairs.length} 组（${answers.filter((x) => x.same).length} 组像同一件），合并 ${merged} 组，关联 ${open.links.length} 条，未结束的变化 ${open.openChanges.length} 条，${((Date.now() - t0) / 1000).toFixed(1)} 秒`
      this.retry.count = 0
    } catch (e) {
      const r = this.retry
      if (trigger !== 'retry') r.count = 0
      if (r.timer) clearTimeout(r.timer)
      if (r.count < CONSOLIDATE_RETRIES) {
        r.count++
        r.timer = setTimeout(() => void this.consolidate('retry'), CONSOLIDATE_RETRY_MS)
        note = `整理没成功：${(e as Error).message}（${CONSOLIDATE_RETRY_MS / 60000} 分钟后自动再试，第 ${r.count} 次）`
      } else {
        note = `整理没成功：${(e as Error).message}（已自动重试 ${CONSOLIDATE_RETRIES} 次，等下次定时整理）`
      }
    } finally {
      this.merging = false
      this.consolidation = { ...this.consolidation, running: false, at: Date.now(), note }
      this.changed()
      void this.processMerges()
    }
  }

  private async refreshEventFor(segmentId: string) {
    const evId = this.segEvent.get(segmentId)
    const ev = this.events.find((e) => e.id === evId)
    if (!ev) return
    const segs = ev.segmentIds.map((id) => this.segments.get(id)).filter((s): s is Segment => !!s)
    this.patchEvent(ev.id, (e) => ({ ...e, busy: true }))
    try {
      const briefs = segs.map((s) => this.briefOf(s))
      const summary = await resummarize(briefs, this.homeCtx.categories)
      const verdict = briefs.reduce<HomiEvent['verdict']>((v, b) => maxVerdict(v, b.verdict), null)
      this.patchEvent(ev.id, (e) => ({ ...e, summary, verdict, busy: false }))
    } catch {
      this.patchEvent(ev.id, (e) => ({ ...e, busy: false }))
    }
  }

  // ───── 提醒 ─────

  private raiseExpectedAlerts(seg: Segment, final: Judgment) {
    const hits = final.expected
      .filter((e) => e.matched)
      .map((e) => this.homeCtx.plans.find((p) => `plan:${p.id}` === e.id))
      .filter((p): p is Plan => !!p && p.kind === 'expect' && !p.matchedAt && isPlanActive(p, seg.endedAt))
    if (hits.length === 0) return
    const at = Date.now()
    this.homeCtx = { ...this.homeCtx, plans: this.homeCtx.plans.map((p) => (hits.includes(p) ? { ...p, matchedAt: at } : p)) }
    const answered = new Set(hits.map((p) => `plan:${p.id}`))
    const stillOpen = (a: Alert) => !(a.kind === 'question' && a.about && answered.has(a.about))
    this.alerts = [
      ...hits.map<ExpectAlert>((p) => ({ kind: 'expect', id: `alert-${seg.id}-${p.id}`, planId: p.id, planText: p.text, segmentId: seg.id, message: final.message, imageUrl: seg.after.url, at })),
      ...this.alerts.filter(stillOpen),
    ]
    this.changed()
  }

  private raiseUrgentQuestion(seg: Segment, final: Judgment) {
    const open = this.alerts.flatMap((a) => (a.kind === 'question' ? [{ id: a.id, about: a.about ?? null }] : []))
    const d = decideUrgentQuestion(final, this.homeCtx, open, Date.now())
    if (d.kind === 'skip') return
    const alert: QuestionAlert = {
      kind: 'question',
      id: d.kind === 'update' ? d.id : `question-${seg.id}`,
      segmentId: seg.id,
      message: final.question!,
      imageUrl: seg.after.url,
      at: Date.now(),
      about: d.about,
    }
    this.alerts = [alert, ...this.alerts.filter((a) => a.id !== alert.id)]
    this.changed()
  }

  /** 提醒记录：新出现的记下来；从提醒条消失的标为已处理（2 分钟再提醒替换掉的第一次不算处理） */
  private trackAlertLog() {
    const now = new Set(this.alerts.map((a) => a.id))
    const added = this.alerts.filter((a) => !this.prevAlertIds.has(a.id))
    const removed = [...this.prevAlertIds].filter((id) => !now.has(id))
    this.prevAlertIds = now
    if (added.length === 0 && removed.length === 0) return
    const replaced = (id: string) => {
      const old = this.alertLog.find((l) => l.id === id)
      return !!old?.segmentId && id.startsWith('fall-') && this.alerts.some((a) => a.kind === 'fall' && a.segmentId === old.segmentId)
    }
    this.alertLog = [
      ...this.alertLog
        .filter((l) => !(removed.includes(l.id) && replaced(l.id)))
        .map((l) => (removed.includes(l.id) && l.status === 'open' ? { ...l, status: 'handled' as const } : l)),
      ...added.map((a) => ({ id: a.id, at: a.at, message: a.message, status: 'open' as const, segmentId: a.segmentId || null, eventId: null })),
    ]
  }

  // ───── 摔倒“再看一眼” ─────

  private startFallWatch(seg: Segment, final: Judgment) {
    if (!fallRuleOn(this.homeCtx) || !final.fall?.suspected || !final.fall.onGroundAtEnd) return
    if (this.fallTimers.has(seg.id)) return
    const delay = Math.max(0, (this.segArrivedAt.get(seg.id) ?? Date.now()) + FALL_RECHECK_MS - Date.now())
    this.fallWatches = { ...this.fallWatches, [seg.id]: { state: 'waiting', round: 1, dueAt: Date.now() + delay } }
    this.fallTimers.set(seg.id, setTimeout(() => void this.fallCheck(seg, 1), delay))
    this.changed()
  }

  private async fallCheck(seg: Segment, round: number) {
    this.fallWatches = { ...this.fallWatches, [seg.id]: { state: 'checking', round } }
    this.changed()
    const snap = await this.hooks.requestSnapshot()
    let stillDown = true
    let evidence = ''
    let image = seg.after.url
    if (!snap) {
      evidence = '画面已关闭，无法再确认，请看一眼'
    } else {
      try {
        image = snap.url
        const r = await recheckStillDown(seg.after, snap, seg.ignoreZones)
        stillDown = r.stillDown
        evidence = r.evidence
      } catch (e) {
        evidence = `没能确认（${(e as Error).message}），请看一眼`
      }
    }
    if (!stillDown) {
      this.fallTimers.delete(seg.id)
      this.fallWatches = { ...this.fallWatches, [seg.id]: { state: 'up', round, evidence } }
      this.changed()
      void this.refreshEventFor(seg.id)
      return
    }
    this.fallWatches = { ...this.fallWatches, [seg.id]: { state: 'alerted', round, evidence } }
    void this.refreshEventFor(seg.id)
    const message = round === 1 ? '有人摔倒了，现在还在地上' : '有人摔倒后，2 分钟了还在地上'
    const alert: FallAlert = { kind: 'fall', id: `fall-${seg.id}-${round}`, segmentId: seg.id, message, imageUrl: image, at: Date.now(), evidence, round }
    this.alerts = [alert, ...this.alerts.filter((a) => !(a.kind === 'fall' && a.segmentId === seg.id))]
    if (round === 1) this.fallTimers.set(seg.id, setTimeout(() => void this.fallCheck(seg, 2), FALL_SECOND_CHECK_MS))
    else this.fallTimers.delete(seg.id)
    this.changed()
  }

  private cancelFallWatchIfPending(segmentId: string) {
    if (this.fallWatches[segmentId]?.state !== 'waiting') return
    clearTimeout(this.fallTimers.get(segmentId))
    this.fallTimers.delete(segmentId)
    const { [segmentId]: _, ...rest } = this.fallWatches
    this.fallWatches = rest
    this.changed()
  }

  private stopFallWatch(segmentId: string) {
    clearTimeout(this.fallTimers.get(segmentId))
    this.fallTimers.delete(segmentId)
  }

  private stopAllFallWatches() {
    this.fallTimers.forEach((t) => clearTimeout(t))
    this.fallTimers.clear()
    this.fallWatches = Object.fromEntries(
      Object.entries(this.fallWatches).map(([id, f]) => (f.state === 'waiting' || f.state === 'checking' || f.state === 'alerted' ? [id, { ...f, state: 'stopped' as const }] : [id, f])),
    )
  }

  // ───── 日报 ─────

  async generateReport(trigger: 'manual' | 'timer') {
    if (this.reportRunning) return
    this.reportRunning = true
    this.report = { ...this.report, running: '先整理今天的事件…', error: null }
    this.changed()
    try {
      const before = this.consolidation.at
      await this.consolidate('report', true)
      const unconsolidated = this.consolidation.at === before || this.consolidation.note.startsWith('整理没成功')
      this.report = { ...this.report, running: '正在写日报…' }
      this.changed()
      const events = this.events.filter((e) => isSameDay(e.startedAt, Date.now()))
      const cats = this.homeCtx.categories
      // 日报按大类分组（埋头开发、团队讨论、调试设备都在“工作中”）
      const groups = groupByCategory(events, (c) => groupOf(c, cats))
      const alertsToday = this.alertLog
        .filter((a) => isSameDay(a.at, Date.now()))
        .map((a) => ({ ...a, eventId: a.segmentId ? (this.segEvent.get(a.segmentId) ?? null) : null }))
      const candidates = dedupeQuestions(
        [...this.segments.values()]
          .filter((s) => isSameDay(s.startedAt, Date.now()))
          .flatMap((s): ReportQuestion[] => {
            const j = this.settled.get(s.id)
            const key = `q-${s.id}`
            return j?.question && !j.questionUrgent && !this.doneKeys.has(key) ? [{ key, segmentId: s.id, text: j.question }] : []
          }),
      )
      const open = this.consolidation.openChanges
      const verdictName = (v: HomiEvent['verdict']) => (v ? VERDICT_LABEL[v] : '没能分析')
      const input = [
        `现在：${new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}`,
        '',
        '【今天的事件，按大类】',
        ...groups.flatMap((g) => {
          const c = findLabel(g.categoryId, cats)
          return [
            `${c.icon} ${c.name}（大类 id：${g.categoryId}，${g.count} 件，${clockOf(g.from)}–${clockOf(g.to)}）`,
            ...g.eventIds.map((id) => {
              const e = events.find((x) => x.id === id)!
              return `  - ${clockOf(e.startedAt)} [${findCategory(e.category, cats).name}] ${e.summary}（${verdictName(e.verdict)}）`
            }),
          ]
        }),
        '',
        '【今天的提醒】',
        ...(alertsToday.length
          ? alertsToday.map((a) => `- ${clockOf(a.at)} ${a.message}（${{ open: '还没处理', handled: '已处理', 'false-alarm': '用户说是误报' }[a.status]}）`)
          : ['（没有）']),
        '',
        '【还没结束的变化】',
        ...(open.length ? open.map((o) => `- ${o.text}`) : ['（没有）']),
        '',
        '【候选问题】',
        ...(candidates.length ? candidates.map((q, i) => `Q${i + 1}：${q.text}`) : ['（没有）']),
      ].join('\n')
      const text = events.length ? parseReportText((await writeReportText(input)).obj, groups, candidates) : { headline: '今天还没有记录到画面变化。', groups: [], questions: [] }
      const data: DailyReport = {
        at: Date.now(),
        trigger,
        ...text,
        alerts: alertsToday,
        notices: events.filter((e) => e.verdict === 'notice').map((e) => e.id),
        openChanges: open,
        unconsolidated: unconsolidated && events.length > 0,
      }
      if (trigger === 'timer') this.lastTimerReportAt = data.at
      this.report = { data, running: null, error: null }
      this.reports = { ...this.reports, [dayKey(data.at)]: data }
    } catch (e) {
      this.report = { ...this.report, running: null, error: `日报没生成成功：${(e as Error).message}` }
    } finally {
      this.reportRunning = false
      this.changed()
    }
  }

  private startTimers() {
    // 每晚定时日报（到点后、今天还没生成过、今天有事件）
    setInterval(() => {
      const hasToday = this.events.some((e) => isSameDay(e.startedAt, Date.now()))
      if (hasToday && isReportDue(Date.now(), this.lastTimerReportAt)) void this.generateReport('timer')
      // 跨天：今天的日报换成新的一天
      if (this.report.data && !isSameDay(this.report.data.at, Date.now()) && !this.report.running) {
        this.report = { data: null, running: null, error: null }
        this.changed()
      }
    }, 60_000).unref()
    setInterval(() => void this.consolidate('timer'), CONSOLIDATE_INTERVAL_MS).unref()
  }

  // ───── 界面发来的操作 ─────

  dismissAlert(id: string) {
    const a = this.alerts.find((x) => x.id === id)
    if (a?.kind === 'fall') {
      this.stopFallWatch(a.segmentId)
      this.fallWatches = { ...this.fallWatches, [a.segmentId]: { ...this.fallWatches[a.segmentId], state: 'handled' } }
    }
    this.alerts = this.alerts.filter((x) => x.id !== id)
    this.changed()
  }

  markFalseAlarm(a: FallAlert) {
    this.stopFallWatch(a.segmentId)
    this.fallWatches = { ...this.fallWatches, [a.segmentId]: { ...this.fallWatches[a.segmentId], state: 'false-alarm' } }
    void this.refreshEventFor(a.segmentId)
    this.alertLog = this.alertLog.map((l) => (l.id === a.id ? { ...l, status: 'false-alarm' } : l))
    this.alerts = this.alerts.filter((x) => x.id !== a.id)
    this.feedbackLog = [...this.feedbackLog, { segmentId: a.segmentId, t: Date.now(), note: '摔倒提醒是误报' }]
    this.changed()
  }

  endPlan(alert: ExpectAlert) {
    this.homeCtx = { ...this.homeCtx, plans: this.homeCtx.plans.map((p) => (p.id === alert.planId ? { ...p, enabled: false, end: Date.now() } : p)) }
    this.alerts = this.alerts.filter((a) => a.id !== alert.id)
    this.changed()
  }

  recordVote(segmentId: string, vote: Vote | null) {
    this.feedbackLog = [...this.feedbackLog, { segmentId, t: Date.now(), vote }]
    this.changed()
  }

  saveDraft(segmentId: string, draft: Draft, note: string): ApplyResult {
    const res = applyDraft(this.homeCtx, draft)
    if (res.ok) {
      this.homeCtx = res.ctx
      this.feedbackLog = [...this.feedbackLog, { segmentId, t: Date.now(), note, savedRef: res.ref || undefined }]
      this.changed()
    }
    return res
  }

  markDone(key: string) {
    this.doneKeys = new Set(this.doneKeys).add(key)
    this.changed()
  }

  setHomeCtx(ctx: HomeContext) {
    this.homeCtx = { ...ctx, categories: this.homeCtx.categories }
    this.changed()
  }

  applySetup(c: SetupChoices) {
    this.homeCtx = applySetup(this.homeCtx, c)
    this.changed()
  }

  rerun(segmentId: string) {
    const seg = this.segments.get(segmentId)
    if (seg) this.runAnalysis(seg)
  }

  setSettings(patch: Partial<CameraSettings>) {
    this.settings = { ...this.settings, ...patch }
    this.changed()
  }

  async deleteAll() {
    this.stopAllFallWatches()
    const ids = new Set(this.segments.keys())
    this.segments.clear()
    this.fallWatches = {}
    this.alerts = this.alerts.filter((a) => !ids.has(a.segmentId))
    this.analyses = {}
    this.feedbackLog = []
    this.events = []
    this.consolidation = { running: false, at: null, links: [], leftChanges: {}, openChanges: [], note: '' }
    this.report = { data: null, running: null, error: null }
    this.reports = {}
    this.alertLog = []
    this.doneKeys = new Set()
    this.keyFrames = {}
    this.kfDone.clear()
    this.mergeQueue = []
    // 排队等分析的也不看了（删掉的片段不再花模型额度）
    this.waiting = []
    this.settled.clear()
    this.segEvent.clear()
    this.liveEventIds = []
    this.lastTimerReportAt = null
    await this.store.deleteRecords()
    this.note = '已删除所有记录（计划、记忆和首次设置保留）'
    this.changed()
  }
}

export { imageUrl }
