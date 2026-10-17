/**
 * Porchlight 的核心逻辑（两个页面共用：正式页面、调试台）：
 * 帧来源 → 第一层运动检测 → 第二层分析（快速 + 复核）→ 提醒（期待型 / 摔倒再看一眼 / 紧急提问 / 系统）
 * → 片段合并成事件 → 统一整理 → 日报 / 待确认；计划与记忆；本机记录（IndexedDB）。
 * 页面只负责显示，调用这里返回的状态和操作。
 * 多标签页（sync/tab-sync.ts）：同一时间只有主控页运行这些逻辑；镜像页接收主控页的状态，操作转给主控页做。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { WebcamSource } from '../frame-source/webcam'
import { VideoFileSource } from '../frame-source/video-file'
import { EufySource } from '../frame-source/eufy'
import { fetchCloudEufyConfig, type EufyConfig } from '../eufy/config'
import { authHeaders } from './auth'
import { StreamRecorder, download } from '../frame-source/recorder'
import type { FrameSource } from '../frame-source/types'
import { MotionDetector, GRID_H, GRID_W, type Sample, type Segment } from '../motion/detector'
import { DEFAULT_CONFIG, type Box, type MotionConfig } from '../motion/state-machine'
import { WINDOW_MS } from '../components/RatioChart'
import { DEFAULT_SETUP, type SetupChoices } from '../components/SetupSheet'
import type { AutoPolicy } from '../components/JudgeSettings'
import { primaryOf } from '../ai/step'
import {
  notifySystem,
  playUrgentSound,
  requestNotifyPermission,
  type Alert,
  type ExpectAlert,
  type FallAlert,
  type QuestionAlert,
  type SystemAlert,
} from '../components/AlertBanner'
import { recheckStillDown } from '../ai/recheck'
import { decideEvent, resummarize, type MergeFrame } from '../ai/merge'
import { ensureKeyFrames, type KeyFrameResult } from '../ai/keyframes'
import { askOpenChanges, askSamePairs, confirmMerge } from '../ai/consolidate'
import { writeReportText } from '../ai/report'
import {
  dedupeQuestions,
  groupByCategory,
  isReportDue,
  parseReportText,
  type DailyReport,
  type ReportAlert,
  type ReportQuestion,
  MAX_QUESTIONS,
} from '../events/report'
import { fromStored, reduceToKeyFrames, restoredAnalysis, toStored } from '../store/persist'
import {
  deleteRecords,
  loadRecords,
  saveAlertLog,
  saveConsolidation,
  saveDoneKeys,
  saveEvents,
  saveFallWatches,
  saveHomeCtx,
  saveLastTimerReportAt,
  saveReport,
  saveSegment,
} from '../store/records'
import { usage } from '../store/db'
import { dayKey, isSameDay } from '../store/retention'
import type { PendingItem } from '../components/PendingList'
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
} from '../events/consolidate'
import { decideUrgentQuestion } from '../events/urgent'
import { findCategory, findLabel, groupOf } from '../memory/categories'
import { VERDICT_LABEL, type FallWatch } from '../components/SegmentCard'
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
} from '../events/grouping'
import type { Judgment } from '../ai/judge'
import { analyzeSegment, type Analysis } from '../ai/pipeline'
import { fallRuleOn, isPlanActive, seedContext, type HomeContext, type Plan } from '../memory/types'
import { applyDraft, type ApplyResult, type Draft } from '../memory/apply'
import type { Vote } from '../components/FeedbackBar'
import type { Snapshot } from '../motion/detector'
import {
  command,
  getClientId,
  getRole,
  post,
  startLeadership,
  upload,
  subscribeMessages,
  subscribeMismatch,
  subscribeRole,
  supported as syncSupported,
  takeOver,
  versionMismatch,
  type Role,
  type SyncMessage,
} from '../sync/tab-sync'
import { applyRecordDiff, diffById, diffRecord, isEmptyDiff, upsertById, type RecordDiff } from '../sync/diff'

/** 反馈记录（之后会用来改进判断，并支持查看与删除） */
export interface FeedbackEntry {
  segmentId: string
  t: number
  vote?: Vote | null
  note?: string
  savedRef?: string
}

// v2：第一层规格调整（冷却 0、中间帧全保留），旧版保存的参数不再沿用
// v3：片段最长 30 → 15 秒（换名字让已保存的旧参数不再盖住新默认值）
const CONFIG_KEY = 'porchlight-motion-config-v3'
const JUDGE_KEY = 'porchlight-judge-settings-v4'
const ZONES_KEY = 'porchlight-ignore-zones'
// 每一步用哪个模型在“模型与超时”面板（ai/models.ts）；这里只剩送模型的策略和同时分析数
// 默认全部片段都送模型：“来了又走”等判断属于第二层，第一层不预先筛
// 最多同时分析 5 个片段，其余排队：一个片段最多约 5 个请求（两个看图 + 备份 + 比对），不设上限会刷量、触发网关限流
const DEFAULT_JUDGE: { policy: AutoPolicy; concurrency: number } = {
  policy: 'all',
  concurrency: 5,
}
const MAX_SEGMENTS = 30
/** 摔倒：片段结束后多久再看一眼；紧急提醒后多久再确认一次 */
const FALL_RECHECK_MS = 30000
const FALL_SECOND_CHECK_MS = 120000

const SETUP_KEY = 'porchlight-setup-v1'
/** 开发用：?mergeGap=秒 改实时合并的间隔（如 0 = 关掉实时合并，全靠统一整理） */
const DEV_MERGE_GAP_MS = (() => {
  const v = import.meta.env.DEV ? new URLSearchParams(location.search).get('mergeGap') : null
  return v !== null && Number.isFinite(Number(v)) ? Number(v) * 1000 : undefined
})()
/** 统一整理的间隔（《产品逻辑》3.1.1a：每 2–3 小时一次；另有“整理一下”按钮和日报前整理） */
const CONSOLIDATE_INTERVAL_MS = 2 * 60 * 60 * 1000
/** 整理失败（网关慢、模型都超时）后多久自动再试、最多试几次（10/15 用户确认） */
const CONSOLIDATE_RETRY_MS = 10 * 60 * 1000
const CONSOLIDATE_RETRIES = 2
/** 摄像头画面停了多久算断开（短暂的 muted 不报） */
const CAMERA_LOST_MS = 5000

/** 首次设置的勾选写进对应的内置记忆（摔倒提醒） */
function applySetup(ctx: HomeContext, c: SetupChoices): HomeContext {
  return { ...ctx, memories: ctx.memories.map((m) => (m.rule === 'fall-alert' ? { ...m, enabled: c.fallAlert } : m)) }
}

/** 合并时告诉模型“再看一眼”的结果 */
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

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw) {
      const v = JSON.parse(raw)
      return Array.isArray(fallback) ? v : { ...fallback, ...v }
    }
  } catch {
    /* 读不到就用默认值 */
  }
  return fallback
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 存不了不影响使用 */
  }
}

function revokeSegment(s: Segment) {
  for (const snap of [s.before, ...s.middle, s.after]) URL.revokeObjectURL(snap.url)
}

/** 保存失败不影响使用，只在控制台提示 */
const quiet = (p: Promise<unknown>) => void p.catch((e) => console.warn('本机记录保存失败', e))

export const clockOf = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false })

/** 主控页发给镜像页的画面截图：间隔、宽度 */
const MIRROR_FRAME_MS = 600
const MIRROR_FRAME_WIDTH = 480
/** 云端版：采集端经云端转给其他界面的画面（走公网，比本机多标签页省一点：每秒一张、质量 0.6，约 20–30 KB） */
const CLOUD_FRAME_MS = 1000

type KeyFrameState = KeyFrameResult | { status: 'picking' }

/** 采集端上传用：字节 → base64 */
/** 云端转来的画面（base64 JPEG）→ Blob */
const b64Jpeg = (b64: string) => {
  const bin = atob(b64)
  const buf = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
  return new Blob([buf], { type: 'image/jpeg' })
}
const bytesB64 = (buf: Uint8Array) => {
  let s = ''
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return btoa(s)
}
/** 一张截图的上传格式：原图 JPEG + 64×48 灰度图（云端挑图、裁剪要用） */
const snapUp = async (s: Snapshot) => ({
  t: s.t,
  width: s.width,
  height: s.height,
  jpeg: bytesB64(new Uint8Array(await s.blob.arrayBuffer())),
  gray: bytesB64(new Uint8Array(s.gray.buffer, s.gray.byteOffset, s.gray.byteLength)),
})

export function useHomi() {
  const [config, setConfig] = useState<MotionConfig>(() => load(CONFIG_KEY, DEFAULT_CONFIG))
  const [zones, setZones] = useState<Box[]>(() => load<Box[]>(ZONES_KEY, []))
  const [editingZones, setEditingZones] = useState(false)
  const [source, setSource] = useState<FrameSource | null>(null)
  const [recording, setRecording] = useState<StreamRecorder | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [segments, setSegments] = useState<Segment[]>([])
  const [showMask, setShowMask] = useState(true)
  const [version, setVersion] = useState(0)
  /** 看图判断现在用的模型（按“模型与超时”面板，界面上显示“用的是谁”） */
  const models = { fast: primaryOf('judgeFast'), review: primaryOf('judgeReview') }
  const [policy, setPolicy] = useState<AutoPolicy>(() => load(JUDGE_KEY, DEFAULT_JUDGE).policy)
  const [concurrency, setConcurrency] = useState<number>(() => load(JUDGE_KEY, DEFAULT_JUDGE).concurrency)
  /** 首次使用的选择；null = 还没设置过，显示设置页 */
  const [setup, setSetup] = useState<SetupChoices | null>(() => {
    const raw = (() => {
      try {
        return localStorage.getItem(SETUP_KEY)
      } catch {
        return null
      }
    })()
    return raw ? load(SETUP_KEY, DEFAULT_SETUP) : null
  })
  const [homeCtx, setHomeCtx] = useState<HomeContext>(() => applySetup(seedContext(), setup ?? DEFAULT_SETUP))
  const [analyses, setAnalyses] = useState<Record<string, Analysis>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** 选中的事件（右侧调试栏显示它的合并依据） */
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [fallWatches, setFallWatches] = useState<Record<string, FallWatch>>({})
  const fallTimers = useRef(new Map<string, number>())
  /** 片段到达时的真实时间（“再看一眼”从这里算起） */
  const segArrivedAt = useRef(new Map<string, number>())
  const [feedbackLog, setFeedbackLog] = useState<FeedbackEntry[]>([])

  /**
   * 片段 → 事件（实时合并）：片段按发生顺序排队，队头分析完才合并；距上一件事 ≤ 90 秒就问模型是不是同一件事。
   * 用 ref 保存，合并是一串异步步骤，不能依赖渲染时的 state。
   */
  const [events, setEvents] = useState<HomiEvent[]>([])
  const eventsRef = useRef<HomiEvent[]>([])
  const mergeQueueRef = useRef<string[]>([])
  /** 片段的最终判断（分析失败为 null）；有记录 = 分析已结束 */
  const settledRef = useRef(new Map<string, Judgment | null>())
  const segByIdRef = useRef(new Map<string, Segment>())
  const segEventRef = useRef(new Map<string, string>())
  /** 这次画面来源里的事：新片段只和其中正在进行的比；换来源时清空 */
  const liveEventIdsRef = useRef<string[]>([])
  /** 合并锁：实时合并和统一整理都会改事件，同一时间只跑一个 */
  const mergingRef = useRef(false)
  /** 统一整理的结果：关联、留下的变化、未结束的变化；上次整理的时间和概况（调试用） */
  const [consolidation, setConsolidation] = useState<{
    running: boolean
    at: number | null
    links: EventLink[]
    /** 10/15 以前统一整理写的留下的变化（之后写在事件的 left 里，见 leftOf） */
    leftChanges: Record<string, string>
    openChanges: OpenChange[]
    note: string
    /** 判过“是不是同一件”的组合 → 当时两件各有几个片段 */
    checked?: Record<string, string>
  }>({ running: false, at: null, links: [], leftChanges: {}, openChanges: [], note: '' })
  const consolidationRef = useRef(consolidation)
  consolidationRef.current = consolidation

  /** 今天的提醒记录（提醒条关掉后也保留，日报里列出已处理 / 未处理） */
  const [alertLog, setAlertLog] = useState<ReportAlert[]>([])
  const alertLogRef = useRef(alertLog)
  alertLogRef.current = alertLog
  const prevAlertIds = useRef(new Set<string>())
  /** 日报；lastTimerReportAt：今天是否已经定时生成过 */
  const [report, setReport] = useState<{ data: DailyReport | null; running: string | null; error: string | null }>({
    data: null,
    running: null,
    error: null,
  })
  const lastTimerReportAt = useRef<number | null>(null)
  /** 待确认里已经处理过的条目 */
  const [doneKeys, setDoneKeys] = useState<Set<string>>(new Set())
  /** 正在回答的待确认条目（打开反馈输入页） */
  const [answering, setAnswering] = useState<PendingItem | null>(null)
  const doneKeysRef = useRef(doneKeys)
  doneKeysRef.current = doneKeys
  const reportRunningRef = useRef(false)
  /** 每个片段的关键图（第一轮压缩）；picking = 选得不合格，正在重问 */
  const [keyFrames, setKeyFrames] = useState<Record<string, KeyFrameResult | { status: 'picking' }>>({})
  const keyFramesRef = useRef(new Map<string, KeyFrameResult>())
  const fallWatchesRef = useRef(fallWatches)
  fallWatchesRef.current = fallWatches
  /** 本机记录读回来之前不保存（否则会用空状态覆盖已有记录） */
  const loadedRef = useRef(false)
  const [storage, setStorage] = useState<{ loaded: boolean; usage: number | null; note: string }>({
    loaded: false,
    usage: null,
    note: '',
  })

  // 多标签页：先打开的页面当主控（运行 Homi），其他页面当镜像（只显示）
  startLeadership()
  const [role, setRoleState] = useState<Role>(getRole)
  const isLeaderRef = useRef(getRole() === 'leader')
  const prevRoleRef = useRef<Role>('starting')
  /** 镜像页：主控页的画面来源（null = 主控页没开画面） */
  const [remote, setRemote] = useState<{ name: string } | null>(null)
  /** 镜像页：主控页发来的画面截图 */
  const [mirrorFrame, setMirrorFrame] = useState<string | null>(null)
  const [syncMismatch, setSyncMismatch] = useState(versionMismatch)
  /** 主控页：已经发给镜像页的片段和各组记录（只发变了的） */
  const sentRef = useRef({
    segs: new Map<string, Segment>(),
    analyses: {} as Record<string, Analysis>,
    keyFrames: {} as Record<string, KeyFrameState>,
    fallWatches: {} as Record<string, FallWatch>,
  })
  /** 镜像页：主控页截图的地址 → 本页的地址（截图地址只在创建它的页面里可靠） */
  const urlMapRef = useRef(new Map<string, string>())
  /** 云端推来的摄像头设置（JSON），区分“本页改的”和“云端推来的”；空 = 还没收到 */
  const serverSettingsRef = useRef({ config: '', zones: '' })
  /** 已经见过的提醒（新出现的才弹系统通知）；null = 还没连上 */
  const knownAlertIdsRef = useRef<Set<string> | null>(null)
  /** 镜像页：问主控页、等回答（如“现在看一眼”的截图） */
  const asksRef = useRef(new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>())

  // 检测器回调只创建一次，通过 ref 读取最新设置
  const latest = useRef({ models, policy, homeCtx, config, concurrency })
  latest.current = { models, policy, homeCtx, config, concurrency }
  /** 并发控制：正在分析的片段数，以及排队等待的片段 */
  const activeRef = useRef(0)
  const waitingRef = useRef<Segment[]>([])

  const samplesRef = useRef<Sample[]>([])
  const detectorRef = useRef<MotionDetector | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const maskRef = useRef<HTMLCanvasElement>(null)
  const showMaskRef = useRef(showMask)
  showMaskRef.current = showMask

  const drawMask = useCallback((mask: Uint8Array | null) => {
    const c = maskRef.current
    if (!c) return
    const ctx = c.getContext('2d')!
    ctx.clearRect(0, 0, GRID_W, GRID_H)
    if (!mask || !showMaskRef.current) return
    const img = ctx.createImageData(GRID_W, GRID_H)
    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) {
        img.data[i * 4] = 255
        img.data[i * 4 + 1] = 64
        img.data[i * 4 + 2] = 96
        img.data[i * 4 + 3] = 150
      }
    }
    ctx.putImageData(img, 0, 0)
  }, [])

  /** 分析一个片段：快速 + 复核同时看图，再按规则定夺。结果按片段 ID 存放，先后返回都能对上 */
  const analyzeOne = async (seg: Segment) => {
    const update = (a: Analysis) => {
      setAnalyses((all) => ({ ...all, [seg.id]: a }))
      // 快速结果一出来就开始摔倒倒计时（再看一眼本身就是第二次确认，不必等复核）
      if (a.fast.judgment) startFallWatch(seg, a.fast.judgment)
    }
    try {
      const a = await analyzeSegment(seg, latest.current.homeCtx, update)
      // 分析期间主控被别的页面接走了：新主控页会重新分析这个片段
      if (!isLeaderRef.current) return
      if (a.status === 'done' && a.final) {
        // 提醒不等选图
        raiseExpectedAlerts(seg, a.final)
        raiseUrgentQuestion(seg, a.final)
        startFallWatch(seg, a.final)
        // 复核认为不是摔倒（或已起身），且还没提醒过：取消倒计时
        const down = !!a.final.fall?.suspected && a.final.fall.onGroundAtEnd
        if (!down) cancelFallWatchIfPending(seg.id)
        // 关键图：用最终结果那个模型选的；不合格就重问（合并要等关键图定下来）
        if (a.final.keyFrames.length === 0) setKeyFrames((k) => ({ ...k, [seg.id]: { status: 'picking' } }))
        const kf = await ensureKeyFrames(seg, latest.current.homeCtx, a.final)
        if (!isLeaderRef.current) return
        keyFramesRef.current.set(seg.id, kf)
        setKeyFrames((k) => ({ ...k, [seg.id]: kf }))
        // 存本机：只存最终判断和关键图
        quiet(saveSegment(toStored(seg, a.final, kf)))
      } else if (!settledRef.current.has(seg.id)) {
        quiet(saveSegment(toStored(seg, null, null)))
      }
      if (!settledRef.current.has(seg.id) || a.final) settledRef.current.set(seg.id, a.final ?? null)
    } catch (e) {
      update({
        status: 'error',
        startedAt: Date.now(),
        fast: { model: latest.current.models.fast, status: 'error', startedAt: Date.now() },
        review: { model: latest.current.models.review, status: 'error', startedAt: Date.now() },
        reconcile: { status: 'skipped' },
        error: `出错：${(e as Error).message}`,
      })
      if (!settledRef.current.has(seg.id)) {
        settledRef.current.set(seg.id, null)
        quiet(saveSegment(toStored(seg, null, null)))
      }
    }
    void processMerges()
  }

  const commitEvents = (next: HomiEvent[]) => {
    eventsRef.current = next
    setEvents(next)
  }
  const patchEvent = (id: string, patch: (e: HomiEvent) => HomiEvent) =>
    commitEvents(eventsRef.current.map((e) => (e.id === id ? patch(e) : e)))

  const briefOf = (seg: Segment): SegmentBrief => {
    const j = settledRef.current.get(seg.id) ?? null
    const ctx = latest.current.homeCtx
    const notes: string[] = []
    for (const e of j?.expected ?? []) {
      const p = e.matched ? ctx.plans.find((x) => `plan:${x.id}` === e.id) : undefined
      if (p) notes.push(`已提醒用户：${p.text}`)
    }
    const f = fallNote(fallWatchesRef.current[seg.id])
    if (f) notes.push(f)
    // 只因“疑似摔倒”而判为提醒、再看一眼已经起来了（或用户说是误报）：这一段实际没有提醒，降为留意
    const fw = fallWatchesRef.current[seg.id]?.state
    const onlyFall = j?.verdict === 'alert' && !j.expected.some((e) => e.matched) && !j.questionUrgent
    const verdict = onlyFall && (fw === 'up' || fw === 'false-alarm') ? 'notice' : (j?.verdict ?? null)
    return {
      id: seg.id,
      startedAt: seg.startedAt,
      endedAt: seg.endedAt,
      change: j?.change ?? null,
      verdict,
      category: j?.category ?? null,
      notes,
      left: j?.leftChange ?? null,
    }
  }

  /** 合并一个片段：问模型是否并入上一件事，否则另起一件 */
  /** 片段的关键图（换成事件里的写法）；分析失败没有关键图时用变化前、变化后 */
  const segKeyFrames = (seg: Segment): { frames: EventKeyFrame[]; status: HomiEvent['keyFrameStatus'] } => {
    const kf = keyFramesRef.current.get(seg.id)
    if (!kf) return { frames: [0, seg.middle.length + 1].map((index) => ({ segmentId: seg.id, index, note: '' })), status: 'pending' }
    return { frames: kf.frames.map((k) => ({ segmentId: seg.id, ...k })), status: kf.status }
  }

  /** 事件关键图 → 送合并模型的图（找回截图和忽略区域；截图已被清除的跳过） */
  const toMergeFrames = (refs: EventKeyFrame[]): MergeFrame[] =>
    refs.flatMap((ref) => {
      const s = segByIdRef.current.get(ref.segmentId)
      const snap = s ? [s.before, ...s.middle, s.after][ref.index] : undefined
      return s && snap ? [{ ref, snap, zones: s.ignoreZones }] : []
    })

  /** 一件事最后的画面里还有没有人（看它最后一个片段的判断） */
  const presentAtEndOf = (ev: HomiEvent) => {
    const last = ev.segmentIds[ev.segmentIds.length - 1]
    return last ? (settledRef.current.get(last)?.presentAtEnd ?? null) : null
  }

  /**
   * 合并一个片段（《产品逻辑》3.1.1a，10/15）：一件事 = 用户事后会单独问的事，同一时间可以有几件在进行。
   * 把正在进行的几件事和新片段一起给模型，判断并进哪一件、还是新开一件；拿不准时偏向并进去。
   * 硬规则先筛候选：摔倒只能并进摔倒那件；提醒档只能并进同一事由的事。
   */
  const mergeOne = async (seg: Segment) => {
    const brief = briefOf(seg)
    const own = segKeyFrames(seg)
    const startNew = (decision: MergeDecision) => {
      const ev = startEvent(brief, decision, own.frames, own.status)
      segEventRef.current.set(seg.id, ev.id)
      liveEventIdsRef.current = [...liveEventIdsRef.current, ev.id]
      commitEvents([...eventsRef.current, ev])
      return ev
    }
    const byRule = (reason: string) => void startNew({ segmentId: seg.id, same: false, reason, byRule: true })
    if (brief.change === null) return byRule('这段没能分析')
    const open = openEvents(eventsRef.current, liveEventIdsRef.current, brief, presentAtEndOf, DEV_MERGE_GAP_MS)
    if (open.length === 0) return byRule('前面没有正在进行的事（隔了一段时间、最后画面里也没人了），等统一整理')
    const j = settledRef.current.get(seg.id)
    const isFall = !!j?.fall?.suspected
    const candidates = allowedTargets(open, brief, isFall).filter((e) => e.segmentIds.some((id) => segByIdRef.current.has(id)))
    if (candidates.length === 0) {
      return byRule(isFall ? '疑似摔倒，必须单独成一件' : '这段是提醒，正在进行的事里没有同一事由的，单独成一件')
    }
    const ids = candidates.map((e) => e.id)
    commitEvents(eventsRef.current.map((e) => (ids.includes(e.id) ? { ...e, busy: true } : e)))
    const unbusy = () => commitEvents(eventsRef.current.map((e) => (ids.includes(e.id) ? { ...e, busy: false } : e)))
    try {
      const r = await decideEvent({
        open: candidates.map((e) => ({
          id: e.id,
          summary: e.summary,
          category: e.category,
          left: leftOf(e),
          segments: e.segmentIds.map((id) => segByIdRef.current.get(id)).filter((s): s is Segment => !!s).map(briefOf),
          presentAtEnd: presentAtEndOf(e),
          frames: toMergeFrames(e.keyFrames),
        })),
        next: brief,
        nextFrames: toMergeFrames(own.frames),
        categories: latest.current.homeCtx.categories,
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
        segEventRef.current.set(seg.id, r.targetId)
        patchEvent(r.targetId, (e) => {
          // 摔倒、提醒那件的分类不变（快递到了之后的动作并进来，仍是快递）
          const category = lockedCategory([e, { category: brief.category ?? 'other', verdict: brief.verdict }]) ?? r.category
          return appendToEvent(e, brief, r.summary ?? '', decision, category, { picked: r.keyFrames, added: own.frames }, r.left)
        })
      } else {
        startNew(decision)
      }
    } catch (e) {
      // 合并失败不影响提醒；先单独成为一件事，统一整理时再合
      unbusy()
      startNew({ segmentId: seg.id, same: false, reason: '', byRule: false, error: (e as Error).message })
    }
  }
  /** 按发生顺序处理合并队列；同一时间只跑一个 */
  const processMerges = async () => {
    if (mergingRef.current || !isLeaderRef.current) return
    mergingRef.current = true
    try {
      for (;;) {
        const ready = takeSettled(mergeQueueRef.current, (id) => settledRef.current.has(id))
        if (ready.length === 0) break
        const id = mergeQueueRef.current.shift()!
        const seg = segByIdRef.current.get(id)
        if (seg) await mergeOne(seg)
        if (!isLeaderRef.current) break
      }
    } finally {
      mergingRef.current = false
    }
  }

  /** 一件事留下的变化：事件自己写的（10/15 起看图判断 / 实时合并时写），旧记录用当时统一整理写的 */
  const leftOf = (ev: HomiEvent): string | null =>
    (ev.left !== undefined ? ev.left : consolidationRef.current.leftChanges[ev.id]) ?? null

  /** 一件事的档案文字（统一整理只送档案，不送原始片段） */
  const archiveLine = (label: string, ev: HomiEvent) => {
    const segs = ev.segmentIds.map((id) => segByIdRef.current.get(id)).filter((s): s is Segment => !!s)
    const notes = segs.flatMap((s) => briefOf(s).notes)
    const left = leftOf(ev)
    const cat = findCategory(ev.category, latest.current.homeCtx.categories).name
    const verdict = ev.verdict ? VERDICT_LABEL[ev.verdict] : '没能分析'
    return [
      `- ${label} ${clockOf(ev.startedAt)}–${clockOf(ev.endedAt)}（${cat}，${verdict}，${ev.segmentIds.length} 个片段）：${ev.summary}`,
      ...notes.map((n) => `  ${n}`),
      ...(left ? [`  留下的变化：${left}`] : []),
      ...(doneKeysRef.current.has(`open-${ev.id}`) ? ['  用户已确认：这件事留下的变化已经处理过了'] : []),
    ].join('\n')
  }

  /**
   * 统一整理（《产品逻辑》3.1.1a，10/15 拆成小问题，见 events/consolidate.ts）：
   * ① 代码挑候选组合，模型只答“是不是同一件”；② 是的看关键图确认后合并；③ 留下的变化后来有没有被处理 → 未结束的变化。
   * 判过、两件都没变的组合不再问。不提示用户；有需要确认的事进待确认列表。和实时合并共用一把锁。
   */
  const setConsolidationNow = (patch: (c: typeof consolidation) => typeof consolidation) => {
    // 同步更新 ref：生成日报时整理完要马上读结果，不能等重新渲染
    consolidationRef.current = patch(consolidationRef.current)
    setConsolidation(consolidationRef.current)
  }

  /** 整理失败后的自动重试：第几次、计时器 */
  const retryRef = useRef<{ count: number; timer?: number }>({ count: 0 })

  /** wait：生成日报前的整理要等实时合并 / 上一次整理结束再做（最多等 2 分钟），不能跳过 */
  const consolidate = async (trigger: 'manual' | 'timer' | 'report' | 'retry', wait = false) => {
    if (wait) {
      const t = Date.now()
      while ((mergingRef.current || consolidationRef.current.running) && Date.now() - t < 120000) {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    if (mergingRef.current || consolidationRef.current.running || !isLeaderRef.current) return
    // 只整理今天的事件（更早的留在事件库里）
    const ready = eventsRef.current.filter((e) => !e.busy && isSameDay(e.startedAt, Date.now()))
    if (ready.length === 0) return
    mergingRef.current = true
    setConsolidationNow((c) => ({ ...c, running: true }))
    const t0 = Date.now()
    const cats = latest.current.homeCtx.categories
    let note = ''
    try {
      // ① 候选组合 → 是非题
      const checked = consolidationRef.current.checked ?? {}
      const pairs = candidatePairs(ready, checked, (c) => groupOf(c, latest.current.homeCtx.categories))
      const answers = pairs.length
        ? parsePairAnswers(await askSamePairs(pairs.map(([a, b]) => [archiveLine('A', a), archiveLine('B', b)])), pairs)
        : []
      // ② 是同一件的连成组，看关键图确认后合并
      const renamed = new Map<string, string>()
      const unsure = new Set<string>()
      let merged = 0
      const groups = groupsFromPairs(answers.filter((x) => x.same).map((x) => x.pair))
      for (const ids of groups) {
        const group = ids.map((id) => eventsRef.current.find((e) => e.id === id)).filter((e): e is HomiEvent => !!e)
        if (group.length < 2 || !groupAllowed(group)) continue
        const reason = answers.find((x) => x.same && ids.includes(x.pair[0].id))?.reason ?? ''
        try {
          const r = await confirmMerge({
            lines: group.map((e, i) => archiveLine(`E${i + 1}`, e)),
            frames: toMergeFrames(group.flatMap((e) => e.keyFrames)),
            categories: cats,
          })
          if (!r.same) continue
          const keep = group[0].id
          commitEvents(
            mergeEventGroup(eventsRef.current, ids, { ...r, category: lockedCategory(group) ?? r.category, reason: r.reason || reason }),
          )
          for (const e of group) {
            e.segmentIds.forEach((sid) => segEventRef.current.set(sid, keep))
            if (e.id !== keep) renamed.set(e.id, keep)
          }
          liveEventIdsRef.current = [...new Set(liveEventIdsRef.current.map((id) => renamed.get(id) ?? id))]
          merged++
        } catch {
          // 这一组看图确认失败：先不合并，下次整理再问
          ids.forEach((id) => unsure.add(id))
        }
      }
      // 判过的组合记下来（看图确认失败的除外），两件都没变就不再问
      const alive = new Set(eventsRef.current.map((e) => e.id))
      const nextChecked = Object.fromEntries(
        [
          ...Object.entries(checked),
          ...answers
            .filter(({ pair: [a, b] }) => !unsure.has(a.id) && !unsure.has(b.id))
            .map(({ pair: [a, b] }) => [pairKey(a, b), pairSig(a, b)] as const),
        ].filter(([k]) => k.split('~').every((id) => alive.has(id))),
      )
      // ③ 留下的变化后来有没有被处理 → 未结束的变化、关联
      const today = labelEvents(eventsRef.current.filter((e) => isSameDay(e.startedAt, Date.now())))
      const open = today.some((l) => leftOf(l.event))
        ? parseOpenChanges(await askOpenChanges(today.map((l) => archiveLine(l.label, l.event))), today)
        : { openChanges: [], links: [] }
      const re = (id: string) => renamed.get(id) ?? id
      setConsolidationNow((c) => ({
        ...c,
        links: [...c.links, ...open.links]
          .map((l) => ({ ...l, from: re(l.from), to: re(l.to) }))
          .filter((l) => l.from !== l.to && alive.has(l.from) && alive.has(l.to))
          .filter((l, i, all) => all.findIndex((x) => x.from === l.from && x.to === l.to) === i),
        openChanges: open.openChanges,
        checked: nextChecked,
      }))
      note = `${{ manual: '手动', timer: '定时', report: '日报前', retry: '自动重试' }[trigger]}整理：${ready.length} 件事，比较 ${pairs.length} 组（${answers.filter((x) => x.same).length} 组像同一件），合并 ${merged} 组，关联 ${open.links.length} 条，未结束的变化 ${open.openChanges.length} 条，${((Date.now() - t0) / 1000).toFixed(1)} 秒`
      retryRef.current.count = 0
    } catch (e) {
      // 失败了过一会儿自动再试，最多 2 次；再不行就等下一次定时整理 / 用户点“整理一下”
      const r = retryRef.current
      if (trigger !== 'retry') r.count = 0
      window.clearTimeout(r.timer)
      if (r.count < CONSOLIDATE_RETRIES) {
        r.count++
        r.timer = window.setTimeout(() => isLeaderRef.current && void consolidateRef.current('retry'), CONSOLIDATE_RETRY_MS)
        note = `整理没成功：${(e as Error).message}（${CONSOLIDATE_RETRY_MS / 60000} 分钟后自动再试，第 ${r.count} 次）`
      } else {
        note = `整理没成功：${(e as Error).message}（已自动重试 ${CONSOLIDATE_RETRIES} 次，等下次定时整理）`
      }
    } finally {
      mergingRef.current = false
      setConsolidationNow((c) => ({ ...c, running: false, at: Date.now(), note }))
      // 整理期间到达的片段，现在接着合并
      void processMerges()
    }
  }
  const consolidateRef = useRef(consolidate)
  consolidateRef.current = consolidate

  /** “再看一眼”有结果后，用文字重写所在事件的描述（把结果讲进去） */
  const refreshEventFor = async (segmentId: string) => {
    const evId = segEventRef.current.get(segmentId)
    const ev = eventsRef.current.find((e) => e.id === evId)
    if (!ev) return
    const segs = ev.segmentIds.map((id) => segByIdRef.current.get(id)).filter((s): s is Segment => !!s)
    patchEvent(ev.id, (e) => ({ ...e, busy: true }))
    try {
      const briefs = segs.map(briefOf)
      const summary = await resummarize(briefs, latest.current.homeCtx.categories)
      const verdict = briefs.reduce<HomiEvent['verdict']>((v, b) => maxVerdict(v, b.verdict), null)
      patchEvent(ev.id, (e) => ({ ...e, summary, verdict, busy: false }))
    } catch {
      patchEvent(ev.id, (e) => ({ ...e, busy: false }))
    }
  }

  /** 有空位就从排队里取片段开始分析（最多同时 concurrency 个） */
  const pump = () => {
    while (activeRef.current < latest.current.concurrency && waitingRef.current.length) {
      const seg = waitingRef.current.shift()!
      activeRef.current++
      void analyzeOne(seg).finally(() => {
        activeRef.current--
        pump()
      })
    }
  }

  /** 片段一出现就送去分析；超过同时分析上限的先排队 */
  const runAnalysis = useCallback((seg: Segment) => {
    if (waitingRef.current.some((s) => s.id === seg.id)) return
    const now = Date.now()
    setAnalyses((all) => ({
      ...all,
      [seg.id]: {
        status: 'queued',
        startedAt: now,
        fast: { model: latest.current.models.fast, status: 'pending', startedAt: now },
        review: { model: latest.current.models.review, status: 'pending', startedAt: now },
        reconcile: { status: 'pending' },
      },
    }))
    waitingRef.current.push(seg)
    pump()
  }, [])

  /**
   * 最终判断确定后：期待型计划被看到 → 页面提醒条 + 系统通知。
   * 同一个计划只提醒一次（记下 matchedAt）；只认生效中的期待型计划。
   */
  const raiseExpectedAlerts = (seg: Segment, final: Judgment) => {
    const ctx = latest.current.homeCtx
    const hits = final.expected
      .filter((e) => e.matched)
      .map((e) => ctx.plans.find((p) => `plan:${p.id}` === e.id))
      .filter((p): p is Plan => !!p && p.kind === 'expect' && !p.matchedAt && isPlanActive(p, seg.endedAt))
    if (hits.length === 0) return
    const at = Date.now()
    const next = { ...ctx, plans: ctx.plans.map((p) => (hits.includes(p) ? { ...p, matchedAt: at } : p)) }
    latest.current.homeCtx = next
    setHomeCtx(next)
    // 之前关于这些计划、还没回答的紧急提问（“是送快递的人吗？”）已经有答案了，一起收起
    const answered = new Set(hits.map((p) => `plan:${p.id}`))
    const stillOpen = (a: Alert) => !(a.kind === 'question' && a.about && answered.has(a.about))
    viewRef.current.alerts = viewRef.current.alerts.filter(stillOpen)
    setAlerts((all) => [
      ...hits.map<ExpectAlert>((p) => ({
        kind: 'expect',
        id: `alert-${seg.id}-${p.id}`,
        planId: p.id,
        planText: p.text,
        segmentId: seg.id,
        message: final.message,
        imageUrl: seg.after.url,
        at,
      })),
      ...all.filter(stillOpen),
    ])
    notifySystem('Homi', final.message, seg.after.url)
  }

  /**
   * 紧急提问（可能是在等的事 / 违反规则，但看不清）→ 马上问。发出前按现在的计划再查一次（events/urgent.ts）：
   * 问的计划已经到达就不问；同一件事已经有一条没回答的，只更新那一条，不再通知。
   */
  const raiseUrgentQuestion = (seg: Segment, final: Judgment) => {
    const open = viewRef.current.alerts.flatMap((a) => (a.kind === 'question' ? [{ id: a.id, about: a.about ?? null }] : []))
    const d = decideUrgentQuestion(final, latest.current.homeCtx, open, Date.now())
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
    // 同步记下，紧接着到的下一个片段能看到这一条（不必等页面重新渲染）
    viewRef.current.alerts = [alert, ...viewRef.current.alerts.filter((a) => a.id !== alert.id)]
    setAlerts((all) => [alert, ...all.filter((a) => a.id !== alert.id)])
    if (d.kind === 'new') notifySystem('Homi 想问你', final.question!, seg.after.url)
  }

  /**
   * 摔倒“再看一眼”（见《产品逻辑》）：疑似摔倒且片段结束时人还在地上 → 片段结束 30 秒后截一张图，
   * 只问“人还在地上吗”。还在 → 紧急提醒（提醒条 + 提示音 + 不会自动消失的系统通知）；
   * 已起身或离开 → 只记录。紧急提醒后 2 分钟再看一次，仍在地上就再提醒一次，之后不再重复。
   * 只通知，不替用户做任何决定（不会自动报警）。
   */
  const startFallWatch = (seg: Segment, final: Judgment) => {
    if (!fallRuleOn(latest.current.homeCtx) || !final.fall?.suspected || !final.fall.onGroundAtEnd) return
    if (fallTimers.current.has(seg.id)) return
    // 片段到达时的真实时间为起点（视频文件来源的片段时间不是真实时间）
    const delay = Math.max(0, (segArrivedAt.current.get(seg.id) ?? Date.now()) + FALL_RECHECK_MS - Date.now())
    setFallWatches((w) => ({ ...w, [seg.id]: { state: 'waiting', round: 1, dueAt: Date.now() + delay } }))
    fallTimers.current.set(seg.id, window.setTimeout(() => void fallCheck(seg, 1), delay))
  }

  const fallCheck = async (seg: Segment, round: number) => {
    if (!isLeaderRef.current) return
    setFallWatches((w) => ({ ...w, [seg.id]: { state: 'checking', round } }))
    const snapP = detectorRef.current?.grabSnapshot()
    let stillDown = true
    let evidence = ''
    let image = seg.after.url
    if (!snapP) {
      // 画面已关闭：看不到就按“仍可能在地上”提醒，宁可多问一次
      evidence = '画面已关闭，无法再确认，请看一眼'
    } else {
      try {
        const snap = await snapP
        image = snap.url
        const r = await recheckStillDown(seg.after, snap, seg.ignoreZones)
        stillDown = r.stillDown
        evidence = r.evidence
      } catch (e) {
        evidence = `没能确认（${(e as Error).message}），请看一眼`
      }
    }
    if (!stillDown) {
      fallTimers.current.delete(seg.id)
      const fw: FallWatch = { state: 'up', round, evidence }
      fallWatchesRef.current = { ...fallWatchesRef.current, [seg.id]: fw }
      setFallWatches((w) => ({ ...w, [seg.id]: fw }))
      void refreshEventFor(seg.id)
      return
    }
    const fw: FallWatch = { state: 'alerted', round, evidence }
    fallWatchesRef.current = { ...fallWatchesRef.current, [seg.id]: fw }
    setFallWatches((w) => ({ ...w, [seg.id]: fw }))
    void refreshEventFor(seg.id)
    const message = round === 1 ? '有人摔倒了，现在还在地上' : '有人摔倒后，2 分钟了还在地上'
    const alert: FallAlert = {
      kind: 'fall',
      id: `fall-${seg.id}-${round}`,
      segmentId: seg.id,
      message,
      imageUrl: image,
      at: Date.now(),
      evidence,
      round,
    }
    setAlerts((all) => [alert, ...all.filter((a) => !(a.kind === 'fall' && a.segmentId === seg.id))])
    playUrgentSound()
    notifySystem('Homi 紧急提醒', message, image, true)
    if (round === 1) {
      fallTimers.current.set(seg.id, window.setTimeout(() => void fallCheck(seg, 2), FALL_SECOND_CHECK_MS))
    } else {
      fallTimers.current.delete(seg.id)
    }
  }

  /** 复核否定了摔倒：还在倒计时（没提醒过）就取消 */
  const cancelFallWatchIfPending = (segmentId: string) => {
    setFallWatches((w) => {
      if (w[segmentId]?.state !== 'waiting') return w
      window.clearTimeout(fallTimers.current.get(segmentId))
      fallTimers.current.delete(segmentId)
      const { [segmentId]: _, ...rest } = w
      return rest
    })
  }

  /** 用户已处理或判为误报：停止后续再看 */
  const stopFallWatch = (segmentId: string) => {
    window.clearTimeout(fallTimers.current.get(segmentId))
    fallTimers.current.delete(segmentId)
  }

  const endPlan = (alert: ExpectAlert) => {
    const ctx = latest.current.homeCtx
    const next = { ...ctx, plans: ctx.plans.map((p) => (p.id === alert.planId ? { ...p, enabled: false, end: Date.now() } : p)) }
    latest.current.homeCtx = next
    setHomeCtx(next)
    setAlerts((all) => all.filter((a) => a.id !== alert.id))
  }

  const recordVote = (segmentId: string, vote: Vote | null) =>
    setFeedbackLog((log) => [...log, { segmentId, t: Date.now(), vote }])

  const saveDraft = (segmentId: string, draft: Draft, note: string): ApplyResult => {
    const res = applyDraft(latest.current.homeCtx, draft)
    if (res.ok) {
      latest.current.homeCtx = res.ctx
      setHomeCtx(res.ctx)
      setFeedbackLog((log) => [...log, { segmentId, t: Date.now(), note, savedRef: res.ref || undefined }])
    }
    return res
  }

  if (!detectorRef.current) {
    detectorRef.current = new MotionDetector({
      onSample: (s, mask) => {
        const arr = samplesRef.current
        arr.push(s)
        while (arr.length && s.t - arr[0].t > WINDOW_MS) arr.shift()
        drawMask(mask)
        setVersion((v) => v + 1)
        // 变化率曲线和变化区域也给镜像页（调试台在旁边看过程）
        if (isLeaderRef.current) post({ type: 'sample', sample: s, mask })
        // 云端版：攒着，和画面截图一起经云端转给其他界面
        else if (sourceRef.current) {
          relaySamplesRef.current.push(s)
          relayMaskRef.current = mask
        }
      },
      onSegment: (seg) => {
        // 云端版：这里只是采集端，片段上传给云端 Homi；结果由云端推回来
        if (!isLeaderRef.current) {
          void (async () => {
            const seq = [seg.before, ...seg.middle, seg.after]
            try {
              await upload('/api/capture/segment', {
                id: seg.id,
                startedAt: seg.startedAt,
                endedAt: seg.endedAt,
                endReason: seg.endReason,
                measurements: seg.measurements,
                ignoreZones: seg.ignoreZones,
                snaps: await Promise.all(seq.map(snapUp)),
                // 云端只收当前采集端的片段（防止两个页面同时采集、片段重复）
                clientId: getClientId(),
                sourceName: sourceRef.current?.name ?? null,
              })
            } catch (e) {
              setError(`片段没传上云端：${(e as Error).message}`)
            } finally {
              seq.forEach((s) => URL.revokeObjectURL(s.url))
            }
          })()
          return
        }
        segArrivedAt.current.set(seg.id, Date.now())
        setSegments((prev) => {
          const next = [seg, ...prev]
          // 最近 MAX_SEGMENTS 个片段在内存里留全部截图（调试“全部 N 张”）；更早的只留关键图（和存进本机的一样）
          return next.map((s, i) => {
            if (i < MAX_SEGMENTS || s.keyFramesOnly || !keyFramesRef.current.has(s.id)) return s
            const reduced = reduceToKeyFrames(s, keyFramesRef.current.get(s.id) ?? null)
            segByIdRef.current.set(s.id, reduced)
            return reduced
          })
        })
        const { policy, config } = latest.current
        segByIdRef.current.set(seg.id, seg)
        if (policy === 'all' || (policy === 'changed' && seg.measurements.netChange >= config.areaThreshold)) {
          mergeQueueRef.current.push(seg.id)
          runAnalysis(seg)
        }
      },
    })
    detectorRef.current.setConfig(config)
    detectorRef.current.setIgnoreZones(zones)
  }

  useEffect(() => {
    detectorRef.current?.setConfig(config)
    save(CONFIG_KEY, config)
    // 本页改的（不是云端推来的）：存到云端，所有界面和采集端都跟着变
    const s = serverSettingsRef.current.config
    if (s && JSON.stringify(config) !== s) void command('setConfig', [config]).catch(() => {})
  }, [config])

  useEffect(() => {
    detectorRef.current?.setIgnoreZones(zones)
    save(ZONES_KEY, zones)
    const s = serverSettingsRef.current.zones
    if (s && JSON.stringify(zones) !== s) void command('setZones', [zones]).catch(() => {})
  }, [zones])

  useEffect(() => save(JUDGE_KEY, { policy, concurrency }), [policy, concurrency])
  // 调高并发上限后，立即让排队的片段开始
  useEffect(() => pump(), [concurrency])

  // 卸载时的清理拿不到最新 state，用 ref 记住当前来源和录制
  const sourceRef = useRef<FrameSource | null>(null)
  /** 采集端：现在有几个别的界面在看（云端告诉的；0 就不转画面） */
  const viewersRef = useRef(0)
  /** 采集端：上次转发以来的变化率采样和最新的变化区域（跟画面一起发给其他界面） */
  const relaySamplesRef = useRef<Sample[]>([])
  const relayMaskRef = useRef<Uint8Array | null>(null)
  const recordingRef = useRef<StreamRecorder | null>(null)
  sourceRef.current = source
  recordingRef.current = recording

  const stopRecording = async () => {
    const rec = recordingRef.current
    if (!rec) return
    recordingRef.current = null
    setRecording(null)
    download(await rec.stop())
  }

  const stop = () => {
    detectorRef.current?.stop()
    void stopRecording()
    const s = sourceRef.current
    // 云端版：告诉云端这里不再有画面
    if (s && !isLeaderRef.current) void command('captureStop').catch(() => {})
    s?.previewElement?.remove()
    s?.stop()
    sourceRef.current = null
    drawMask(null)
    setSource(null)
  }

  /**
   * 停止所有还没完成的“再看一眼”：换了画面来源后，再截图看到的已经不是原来那个场景，
   * 继续检查会拿新画面去确认旧片段里的人。
   */
  const stopAllFallWatches = () => {
    fallTimers.current.forEach((t) => window.clearTimeout(t))
    fallTimers.current.clear()
    setFallWatches((w) =>
      Object.fromEntries(
        Object.entries(w).map(([id, f]) =>
          f.state === 'waiting' || f.state === 'checking' || f.state === 'alerted' ? [id, { ...f, state: 'stopped' }] : [id, f],
        ),
      ),
    )
  }

  const run = async (next: FrameSource, describeError: (e: unknown) => string) => {
    stop()
    stopAllFallWatches()
    // 新来源的片段不和旧来源的事件合并；还没合并的旧片段也不再等
    liveEventIdsRef.current = []
    mergeQueueRef.current = []
    setError(null)
    // 先放进页面再播放：媒体元素在播放后才插入页面，Chrome 可能把它暂停
    if (previewRef.current && next.previewElement) previewRef.current.prepend(next.previewElement)
    try {
      await next.start()
    } catch (e) {
      next.previewElement?.remove()
      next.stop()
      setError(describeError(e))
      return
    }
    samplesRef.current = []
    detectorRef.current!.start(next)
    setSource(next)
    // 云端版：这个页面开始当采集端
    if (!isLeaderRef.current) void command('captureStart', [next.name]).catch((e) => setError(`连不上云端：${(e as Error).message}`))
  }

  const startWebcam = () =>
    run(new WebcamSource(), (e) => {
      const name = (e as DOMException).name
      return name === 'NotAllowedError'
        ? '没有摄像头权限：请在地址栏左侧允许使用摄像头后重试。'
        : name === 'NotFoundError'
          ? '没有找到摄像头。'
          : name === 'NotReadableError'
            ? '摄像头被其他程序占用（如会议软件），关闭后重试。'
            : `摄像头启动失败：${(e as Error).message}`
    })

  const startVideo = (file: File) => run(new VideoFileSource(file), (e) => (e as Error).message)

  const startEufy = (config: EufyConfig) => run(new EufySource(config), (e) => (e as Error).message)

  /** 用云端配好的 eufy 参数连接；云端没配返回 false（调试台改为弹出设置框） */
  const connectEufy = async (): Promise<boolean> => {
    const c = await fetchCloudEufyConfig(authHeaders())
    if (!c) return false
    await startEufy(c)
    return true
  }

  const startRecording = () => {
    if (!(source instanceof WebcamSource) || !source.mediaStream) return
    try {
      setRecording(new StreamRecorder(source.mediaStream))
    } catch (e) {
      setError(`无法录制：${(e as Error).message}`)
    }
  }

  useEffect(() => () => stop(), [])

  // 提醒记录：新出现的提醒记下来；从提醒条消失的标为已处理（误报另外标；2 分钟再提醒替换掉的第一次不算处理）
  useEffect(() => {
    const now = new Set(alerts.map((a) => a.id))
    // 镜像页的提醒记录由主控页发来
    if (!isLeaderRef.current) {
      prevAlertIds.current = now
      return
    }
    const added = alerts.filter((a) => !prevAlertIds.current.has(a.id))
    const removed = [...prevAlertIds.current].filter((id) => !now.has(id))
    prevAlertIds.current = now
    if (added.length === 0 && removed.length === 0) return
    // 同一片段的摔倒提醒被“2 分钟后再提醒”替换：第一次从记录里去掉，只留最新那次
    const replaced = (id: string) => {
      const old = alertLogRef.current.find((l) => l.id === id)
      return !!old?.segmentId && id.startsWith('fall-') && alerts.some((a) => a.kind === 'fall' && a.segmentId === old.segmentId)
    }
    setAlertLog((log) => [
      ...log
        .filter((l) => !(removed.includes(l.id) && replaced(l.id)))
        .map((l) => (removed.includes(l.id) && l.status === 'open' ? { ...l, status: 'handled' as const } : l)),
      ...added.map((a) => ({
        id: a.id,
        at: a.at,
        message: a.message,
        status: 'open' as const,
        segmentId: a.segmentId || null,
        eventId: null,
      })),
    ])
  }, [alerts])

  /**
   * 生成日报（《产品逻辑》3.5）：先强制统一整理一次，再按分类分组（代码算），最后让模型写一句话总结、每组小结、挑最多 3 个问题。
   */
  const generateReport = async (trigger: 'manual' | 'timer') => {
    if (reportRunningRef.current || !isLeaderRef.current) return
    reportRunningRef.current = true
    setReport((r) => ({ ...r, running: '先整理今天的事件…', error: null }))
    try {
      const before = consolidationRef.current.at
      await consolidate('report', true)
      // 整理没成功（或没轮到）：照样按实时合并好的事件写日报，标出来
      const unconsolidated = consolidationRef.current.at === before || consolidationRef.current.note.startsWith('整理没成功')
      setReport((r) => ({ ...r, running: '正在写日报…' }))
      const events = eventsRef.current.filter((e) => isSameDay(e.startedAt, Date.now()))
      const cats = latest.current.homeCtx.categories
      const groups = groupByCategory(events, (c) => groupOf(c, cats))
      const alertsToday = alertLogRef.current.filter((a) => isSameDay(a.at, Date.now())).map((a) => ({
        ...a,
        eventId: a.segmentId ? (segEventRef.current.get(a.segmentId) ?? null) : null,
      }))
      const done = doneKeysRef.current
      const candidates = dedupeQuestions(
        segByIdRef.current.size
          ? [...segByIdRef.current.values()].filter((s) => isSameDay(s.startedAt, Date.now())).flatMap((s): ReportQuestion[] => {
              const j = settledRef.current.get(s.id)
              const key = `q-${s.id}`
              return j?.question && !j.questionUrgent && !done.has(key) ? [{ key, segmentId: s.id, text: j.question }] : []
            })
          : [],
      )
      const open = consolidationRef.current.openChanges
      const verdictName = (v: HomiEvent['verdict']) => (v ? VERDICT_LABEL[v] : '没能分析')
      const input = [
        `现在：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
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
      const text = events.length
        ? parseReportText((await writeReportText(input)).obj, groups, candidates)
        : { headline: '今天还没有记录到画面变化。', groups: [], questions: [] }
      const data: DailyReport = {
        at: Date.now(),
        trigger,
        ...text,
        alerts: alertsToday,
        notices: events.filter((e) => e.verdict === 'notice').map((e) => e.id),
        openChanges: open,
        unconsolidated: unconsolidated && events.length > 0,
      }
      if (trigger === 'timer') {
        lastTimerReportAt.current = data.at
        quiet(saveLastTimerReportAt(data.at))
      }
      setReport({ data, running: null, error: null })
      quiet(saveReport(data))
    } catch (e) {
      setReport((r) => ({ ...r, running: null, error: `日报没生成成功：${(e as Error).message}` }))
    } finally {
      reportRunningRef.current = false
    }
  }
  const generateReportRef = useRef(generateReport)
  generateReportRef.current = generateReport

  // 每晚定时生成日报（到点后、今天还没生成过）
  useEffect(() => {
    const timer = window.setInterval(() => {
      // 本机记录读回来之前不生成；今天还没有事件也先不生成（不占掉今天的定时，等有事件了再生成）
      const hasToday = eventsRef.current.some((e) => isSameDay(e.startedAt, Date.now()))
      if (isLeaderRef.current && loadedRef.current && hasToday && isReportDue(Date.now(), lastTimerReportAt.current)) void generateReportRef.current('timer')
    }, 60000)
    return () => window.clearInterval(timer)
  }, [])

  /**
   * 主控页打开时：读回本机记录（最近 7 天的事件、今天的日报、计划与记忆……），顺便删掉过期的。
   * 镜像页不读，状态由主控页发来。
   */
  const loadFromDisk = () =>
    void (async () => {
      try {
        const r = await loadRecords(Date.now())
        if (r.homeCtx) {
          // 计划与记忆用上次保存的；分类清单跟着代码走（新增的默认分类能用上）
          const ctx = { ...r.homeCtx, categories: latest.current.homeCtx.categories }
          latest.current.homeCtx = ctx
          setHomeCtx(ctx)
        }
        // 已经在页面上的不再读（开发时热更新会重跑这段，页面状态还在）
        const restored = r.segments.filter((s) => !segByIdRef.current.has(s.id)).map((s) => {
          const seg = fromStored(s)
          segByIdRef.current.set(seg.id, seg)
          settledRef.current.set(seg.id, s.judgment)
          if (s.keyFrames) keyFramesRef.current.set(seg.id, s.keyFrames)
          return { seg, stored: s }
        })
        setSegments((live) => [...live, ...restored.map((x) => x.seg)].sort((a, b) => b.startedAt - a.startedAt))
        setKeyFrames((k) => ({ ...Object.fromEntries(restored.flatMap((x) => (x.stored.keyFrames ? [[x.seg.id, x.stored.keyFrames]] : []))), ...k }))
        setAnalyses((a) => ({
          ...Object.fromEntries(
            restored.flatMap((x) => {
              const an = restoredAnalysis(x.stored, latest.current.models)
              return an ? [[x.seg.id, an]] : []
            }),
          ),
          ...a,
        }))
        // 事件；页面关闭前没来得及合并的片段，各自成为一件事（统一整理时再合）
        const inEvent = new Set(r.events.flatMap((e) => e.segmentIds))
        const orphans = restored
          .filter((x) => !inEvent.has(x.seg.id))
          .map((x) =>
            startEvent(
              {
                id: x.seg.id,
                startedAt: x.seg.startedAt,
                endedAt: x.seg.endedAt,
                change: x.stored.judgment?.change ?? null,
                verdict: x.stored.judgment?.verdict ?? null,
                category: x.stored.judgment?.category ?? null,
                notes: [],
              },
              { segmentId: x.seg.id, same: false, reason: '页面关闭前没来得及合并', byRule: true },
              (x.stored.keyFrames?.frames ?? []).map((k) => ({ segmentId: x.seg.id, ...k })),
            ),
          )
        const restoredEvents = [...r.events, ...orphans].filter((e) => !eventsRef.current.some((x) => x.id === e.id))
        restoredEvents.forEach((e) => e.segmentIds.forEach((sid) => segEventRef.current.set(sid, e.id)))
        commitEvents([...restoredEvents, ...eventsRef.current].sort((a, b) => a.startedAt - b.startedAt))
        if (r.consolidation) setConsolidationNow((c) => ({ ...c, ...r.consolidation!, running: false }))
        setAlertLog((l) => [...r.alertLog, ...l])
        setDoneKeys((d) => new Set([...r.doneKeys, ...d]))
        // 没完成的“再看一眼”接不上了
        const fw = Object.fromEntries(
          Object.entries(r.fallWatches).map(([id, w]) =>
            w.state === 'waiting' || w.state === 'checking' ? [id, { ...w, state: 'stopped' as const, evidence: '页面关闭，没有再看' }] : [id, w],
          ),
        )
        fallWatchesRef.current = { ...fw, ...fallWatchesRef.current }
        setFallWatches((w) => ({ ...fw, ...w }))
        lastTimerReportAt.current = r.lastTimerReportAt
        if (r.report) setReport((x) => (x.data ? x : { ...x, data: r.report }))
        const n = r.expired
        setStorage({
          loaded: true,
          usage: await usage(),
          note: `读回 ${r.events.length} 件事、${r.segments.length} 个片段${r.report ? '、今天的日报' : ''}${
            n.events + n.segments + n.reports ? `；删掉过期的 ${n.events} 件事、${n.segments} 个片段、${n.reports} 份日报` : ''
          }`,
        })
        loadedRef.current = true
      } catch (e) {
        setStorage({ loaded: true, usage: null, note: `本机记录读取失败：${(e as Error).message}（这次的记录可能不会保存）` })
        loadedRef.current = true
      }
    })()

  // 有变化就保存（读回来之前不存）
  useEffect(() => {
    if (!loadedRef.current) return
    quiet(saveEvents(events))
  }, [events])
  useEffect(() => {
    if (loadedRef.current) quiet(saveHomeCtx(homeCtx))
  }, [homeCtx])
  useEffect(() => {
    if (!loadedRef.current || consolidation.running) return
    const { running: _, ...rest } = consolidation
    quiet(saveConsolidation(rest))
  }, [consolidation])
  useEffect(() => {
    if (loadedRef.current) quiet(saveAlertLog(alertLog))
  }, [alertLog])
  useEffect(() => {
    if (loadedRef.current) quiet(saveDoneKeys([...doneKeys]))
  }, [doneKeys])
  useEffect(() => {
    if (loadedRef.current) quiet(saveFallWatches(fallWatches))
  }, [fallWatches])
  // 占用空间：每分钟更新一次
  useEffect(() => {
    const timer = window.setInterval(() => void usage().then((u) => setStorage((s) => ({ ...s, usage: u }))), 60000)
    return () => window.clearInterval(timer)
  }, [])

  // 定时统一整理（不提示用户）
  useEffect(() => {
    const timer = window.setInterval(() => isLeaderRef.current && void consolidateRef.current('timer'), CONSOLIDATE_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [])

  /**
   * 系统提醒：摄像头断开 / 画面停了 → 推送（监控已经停了，用户需要知道）。恢复后自动收起。
   * 只看笔记本摄像头；视频文件和测试片段播完是正常结束。
   * eufy 摄像头断了会自动重连，不推提醒，画面里转圈显示“重连中”就够了（10/16 用户：不要做得这么严重）。
   */
  useEffect(() => {
    if (!(source instanceof WebcamSource)) return
    let lostSince: number | null = null
    let raised = false
    const timer = window.setInterval(() => {
      const health = source.health
      if (health === 'ok') {
        lostSince = null
        if (raised) {
          raised = false
          setAlerts((all) => all.filter((a) => a.id !== 'system-camera'))
        }
        return
      }
      lostSince ??= Date.now()
      if (raised || Date.now() - lostSince < CAMERA_LOST_MS) return
      raised = true
      const message =
        health === 'ended' ? '摄像头断开了，我暂时看不到画面' : '摄像头画面停了（可能被别的程序占用），我暂时看不到画面'
      const alert: SystemAlert = { kind: 'system', id: 'system-camera', segmentId: '', message, imageUrl: '', at: Date.now() }
      setAlerts((all) => [alert, ...all.filter((a) => a.id !== alert.id)])
      notifySystem('Homi 系统提醒', message, undefined, true)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [source])

  const finishSetup = (c: SetupChoices) => {
    save(SETUP_KEY, c)
    setSetup(c)
    const next = applySetup(latest.current.homeCtx, c)
    latest.current.homeCtx = next
    setHomeCtx(next)
    // 设置页的点击正好可以请求通知权限（浏览器要求在用户操作中请求）
    requestNotifyPermission()
  }

  /**
   * 删除所有记录（《产品逻辑》第 7 节：可手动删除）：页面上的和本机保存的事件、片段截图、日报、提醒记录、待确认的处理情况。
   * 计划、记忆、首次设置保留。删除前要用户确认。
   */
  const confirmDeleteAll = () =>
    window.confirm(
      '删除所有记录？\n\n会删除云端保存的事件、片段截图、日报、提醒记录和待确认的处理情况，删除后不能恢复。\n计划、记忆和首次设置会保留。',
    )
  /** confirmed：镜像页已经问过用户了 */
  const deleteAll = async (confirmed = false) => {
    if (!confirmed && !confirmDeleteAll()) return
    const ids = new Set(segByIdRef.current.keys())
    setSegments((prev) => {
      prev.forEach(revokeSegment)
      return []
    })
    stopAllFallWatches()
    fallWatchesRef.current = {}
    setFallWatches({})
    // 清掉和这些片段有关的提醒（截图已经释放）
    setAlerts((all) => all.filter((a) => !ids.has(a.segmentId)))
    setAnalyses({})
    setSelectedId(null)
    setFeedbackLog([])
    commitEvents([])
    setConsolidationNow(() => ({ running: false, at: null, links: [], leftChanges: {}, openChanges: [], note: '' }))
    setReport({ data: null, running: null, error: null })
    setAlertLog([])
    setDoneKeys(new Set())
    setAnswering(null)
    setKeyFrames({})
    keyFramesRef.current.clear()
    mergeQueueRef.current = []
    settledRef.current.clear()
    segByIdRef.current.clear()
    segEventRef.current.clear()
    liveEventIdsRef.current = []
    lastTimerReportAt.current = null
    try {
      await deleteRecords()
      setStorage({ loaded: true, usage: await usage(), note: '已删除所有记录（计划、记忆和首次设置保留）' })
    } catch (e) {
      setStorage((s) => ({ ...s, note: `删除本机记录失败：${(e as Error).message}` }))
    }
  }


  /** 提醒条：知道了 / 已处理（摔倒的停止后续再看） */
  const dismissAlert = (id: string) => {
    const a = alerts.find((x) => x.id === id)
    if (a?.kind === 'fall') {
      stopFallWatch(a.segmentId)
      setFallWatches((w) => ({ ...w, [a.segmentId]: { ...w[a.segmentId], state: 'handled' } }))
    }
    setAlerts((all) => all.filter((x) => x.id !== id))
  }

  /** 摔倒提醒是误报：停止后续再看，记进反馈，重写所在事件的描述 */
  const markFalseAlarm = (a: FallAlert) => {
    stopFallWatch(a.segmentId)
    const fw: FallWatch = { ...fallWatchesRef.current[a.segmentId], state: 'false-alarm' }
    fallWatchesRef.current = { ...fallWatchesRef.current, [a.segmentId]: fw }
    setFallWatches((w) => ({ ...w, [a.segmentId]: fw }))
    void refreshEventFor(a.segmentId)
    // 先标误报，提醒条消失时就不会被记成“已处理”
    setAlertLog((log) => log.map((l) => (l.id === a.id ? { ...l, status: 'false-alarm' } : l)))
    setAlerts((all) => all.filter((x) => x.id !== a.id))
    setFeedbackLog((log) => [...log, { segmentId: a.segmentId, t: Date.now(), note: '摔倒提醒是误报' }])
  }

  // ───────────── 多标签页同步（sync/tab-sync.ts） ─────────────

  /** 本页当前的显示状态（角色切换、消息处理在回调里，要读最新的） */
  const viewRef = useRef({ segments, analyses, keyFrames, events, alerts })
  viewRef.current = { segments, analyses, keyFrames, events, alerts }

  /** 主控页发给镜像页的整体状态（都是文字和小对象，变了就整份发） */
  const sharedState = () => ({
    events: eventsRef.current,
    liveEventIds: liveEventIdsRef.current,
    mergeQueue: mergeQueueRef.current,
    consolidation: consolidationRef.current,
    alerts: viewRef.current.alerts,
    alertLog: alertLogRef.current,
    report,
    lastTimerReportAt: lastTimerReportAt.current,
    doneKeys: [...doneKeysRef.current],
    homeCtx: latest.current.homeCtx,
    feedbackLog,
    storage,
    live: sourceRef.current ? { name: sourceRef.current.name } : null,
  })
  type SharedState = ReturnType<typeof sharedState>

  /** 完整状态（镜像页刚打开、主控换了页面时发） */
  const postSnapshot = () => {
    const v = viewRef.current
    sentRef.current = {
      segs: new Map(v.segments.map((s) => [s.id, s])),
      analyses: v.analyses,
      keyFrames: v.keyFrames,
      fallWatches: fallWatchesRef.current,
    }
    post({
      type: 'snapshot',
      segments: v.segments,
      analyses: v.analyses,
      keyFrames: v.keyFrames,
      fallWatches: fallWatchesRef.current,
      state: sharedState(),
    })
  }

  // 主控页：有变化就发给镜像页
  useEffect(() => {
    if (!isLeaderRef.current) return
    const d = diffById(sentRef.current.segs, segments)
    if (d.set.length === 0 && d.del.length === 0) return
    sentRef.current.segs = new Map(segments.map((s) => [s.id, s]))
    post({ type: 'segments', set: d.set, del: d.del, mergeQueue: mergeQueueRef.current })
  }, [segments])
  const sendRecord = <T,>(key: 'analyses' | 'keyFrames' | 'fallWatches', next: Record<string, T>) => {
    if (!isLeaderRef.current) return
    const d = diffRecord(sentRef.current[key] as Record<string, T>, next)
    ;(sentRef.current[key] as Record<string, T>) = next
    if (!isEmptyDiff(d)) post({ type: 'record', key, diff: d })
  }
  useEffect(() => sendRecord('analyses', analyses), [analyses])
  useEffect(() => sendRecord('keyFrames', keyFrames), [keyFrames])
  useEffect(() => sendRecord('fallWatches', fallWatches), [fallWatches])
  useEffect(() => {
    if (isLeaderRef.current) post({ type: 'shared', state: sharedState() })
  }, [events, consolidation, alerts, alertLog, report, doneKeys, homeCtx, feedbackLog, storage, source])

  // 云端版：采集端把画面截图经云端转给其他界面（主页、调试台、别的设备）；没人看时不发
  useEffect(() => {
    if (!syncSupported() || isLeaderRef.current || !source) return
    const canvas = document.createElement('canvas')
    let busy = false
    const timer = window.setInterval(() => {
      const f = source.getFrame()
      if (viewersRef.current <= 0) {
        relaySamplesRef.current = []
        return
      }
      if (!f || busy) return
      canvas.width = MIRROR_FRAME_WIDTH
      canvas.height = Math.round((MIRROR_FRAME_WIDTH * f.height) / f.width)
      canvas.getContext('2d')!.drawImage(f.image, 0, 0, canvas.width, canvas.height)
      busy = true
      canvas.toBlob(
        (blob) => {
          if (!blob) return void (busy = false)
          void blob
            .arrayBuffer()
            .then((b) => {
              const samples = relaySamplesRef.current.splice(0)
              const mask = relayMaskRef.current
              return upload('/api/capture/frame', { clientId: getClientId(), jpeg: bytesB64(new Uint8Array(b)), samples, mask: mask ? bytesB64(mask) : null })
            })
            .catch(() => {})
            .finally(() => (busy = false))
        },
        'image/jpeg',
        0.6,
      )
    }, CLOUD_FRAME_MS)
    return () => window.clearInterval(timer)
  }, [source, role])

  // 主控页：画面截图给镜像页（每秒约 1.5 张，缩小后发）
  useEffect(() => {
    if (!syncSupported() || !isLeaderRef.current) return
    if (!source) {
      post({ type: 'frame', blob: null })
      return
    }
    const canvas = document.createElement('canvas')
    let busy = false
    const timer = window.setInterval(() => {
      const f = source.getFrame()
      if (!f || busy || !isLeaderRef.current) return
      canvas.width = MIRROR_FRAME_WIDTH
      canvas.height = Math.round((MIRROR_FRAME_WIDTH * f.height) / f.width)
      canvas.getContext('2d')!.drawImage(f.image, 0, 0, canvas.width, canvas.height)
      busy = true
      canvas.toBlob(
        (blob) => {
          busy = false
          if (blob) post({ type: 'frame', blob })
        },
        'image/jpeg',
        0.7,
      )
    }, MIRROR_FRAME_MS)
    return () => window.clearInterval(timer)
  }, [source, role])

  /** 镜像页：截图换成本页的地址 */
  const adoptSnap = (s: Snapshot): Snapshot => {
    // 云端发来的截图只有地址（/api/images/…），直接用
    if (!s.blob) return s
    let url = urlMapRef.current.get(s.url)
    if (!url) {
      url = URL.createObjectURL(s.blob)
      urlMapRef.current.set(s.url, url)
    }
    return { ...s, url }
  }
  const adoptSegment = (seg: Segment): Segment => ({
    ...seg,
    before: adoptSnap(seg.before),
    middle: seg.middle.map(adoptSnap),
    after: adoptSnap(seg.after),
  })
  /** 镜像页：不再用到的截图地址释放掉 */
  const releaseUrls = (keep: Set<string>, drop: Segment[]) => {
    const dropped = new Set(drop.flatMap((s) => [s.before, ...s.middle, s.after].map((x) => x.url)))
    for (const [from, to] of urlMapRef.current) {
      if (dropped.has(to) && !keep.has(to)) {
        URL.revokeObjectURL(to)
        urlMapRef.current.delete(from)
      }
    }
  }
  const mapAlertUrl = (a: Alert): Alert => ({ ...a, imageUrl: urlMapRef.current.get(a.imageUrl) ?? a.imageUrl })

  const applySegments = (set: Segment[], del: string[], replaceAll = false) => {
    const adopted = set.map(adoptSegment)
    setSegments((prev) => {
      const next = replaceAll ? adopted.sort((a, b) => b.startedAt - a.startedAt) : upsertById(prev, adopted, del)
      const keep = new Set(next.flatMap((s) => [s.before, ...s.middle, s.after].map((x) => x.url)))
      releaseUrls(keep, prev)
      return next
    })
    if (replaceAll) segByIdRef.current.clear()
    del.forEach((id) => segByIdRef.current.delete(id))
    adopted.forEach((s) => segByIdRef.current.set(s.id, s))
  }

  const applyShared = (s: SharedState) => {
    commitEvents(s.events)
    liveEventIdsRef.current = [...s.liveEventIds]
    mergeQueueRef.current = [...s.mergeQueue]
    setConsolidationNow(() => s.consolidation)
    setAlerts(s.alerts.map(mapAlertUrl))
    alertLogRef.current = s.alertLog
    setAlertLog(s.alertLog)
    setReport(s.report)
    lastTimerReportAt.current = s.lastTimerReportAt
    setDoneKeys(new Set(s.doneKeys))
    latest.current.homeCtx = s.homeCtx
    setHomeCtx(s.homeCtx)
    setFeedbackLog(s.feedbackLog)
    setStorage(s.storage)
    setRemote(s.live)
    // 云端版：摄像头设置（第一层参数、忽略区域）存在云端
    const st = (s as SharedState & { settings?: { config: MotionConfig; zones: Box[] } }).settings
    if (st) {
      serverSettingsRef.current = { config: JSON.stringify(st.config), zones: JSON.stringify(st.zones) }
      setConfig((c) => (JSON.stringify(c) === serverSettingsRef.current.config ? c : st.config))
      setZones((z) => (JSON.stringify(z) === serverSettingsRef.current.zones ? z : st.zones))
    }
    notifyNewAlerts(s.alerts)
  }

  /** 新出现的提醒 → 系统通知（云端只推状态，通知由各个界面自己弹）；刚连上时已有的不弹 */
  const notifyNewAlerts = (list: Alert[]) => {
    const known = knownAlertIdsRef.current
    knownAlertIdsRef.current = new Set(list.map((a) => a.id))
    if (!known) return
    for (const a of list) {
      if (known.has(a.id)) continue
      if (a.kind === 'fall') playUrgentSound()
      const title = { fall: 'Homi 紧急提醒', question: 'Homi 想问你', system: 'Homi 系统提醒', expect: 'Homi' }[a.kind]
      notifySystem(title, a.message, a.imageUrl || undefined, a.kind === 'fall' || a.kind === 'system')
    }
  }

  const applyRecord = (key: 'analyses' | 'keyFrames' | 'fallWatches', d: RecordDiff<unknown>) => {
    if (key === 'analyses') setAnalyses((a) => applyRecordDiff(a, d as RecordDiff<Analysis>))
    else if (key === 'keyFrames') setKeyFrames((k) => applyRecordDiff(k, d as RecordDiff<KeyFrameState>))
    else {
      fallWatchesRef.current = applyRecordDiff(fallWatchesRef.current, d as RecordDiff<FallWatch>)
      setFallWatches(fallWatchesRef.current)
    }
  }

  const setMirrorImage = (blob: Blob | null) =>
    setMirrorFrame((old) => {
      if (old) URL.revokeObjectURL(old)
      return blob ? URL.createObjectURL(blob) : null
    })

  /** 镜像页转来的操作（主控页执行） */
  const commands: Record<string, (...args: never[]) => unknown> = {
    consolidate: (trigger: 'manual') => consolidate(trigger),
    generateReport: (trigger: 'manual') => generateReport(trigger),
    deleteAll: () => deleteAll(true),
    dismissAlert: (id: string) => dismissAlert(id),
    markFalseAlarm: (a: FallAlert) => markFalseAlarm(a),
    endPlan: (a: ExpectAlert) => endPlan(a),
    recordVote: (segmentId: string, vote: Vote | null) => recordVote(segmentId, vote),
    saveDraft: (segmentId: string, draft: Draft, note: string) => saveDraft(segmentId, draft, note),
    markDone: (key: string) => setDoneKeys((d) => new Set(d).add(key)),
    setHomeCtx: (ctx: HomeContext) => {
      latest.current.homeCtx = ctx
      setHomeCtx(ctx)
    },
    applySetup: (c: SetupChoices) => {
      const next = applySetup(latest.current.homeCtx, c)
      latest.current.homeCtx = next
      setHomeCtx(next)
    },
    runAnalysis: (segmentId: string) => {
      const seg = segByIdRef.current.get(segmentId)
      if (seg) runAnalysis(seg)
    },
    stop: () => stop(),
    // 现在看一眼：截一张图回给镜像页
    grabSnapshot: () => detectorRef.current?.grabSnapshot() ?? null,
  }

  /** 主控页：收到镜像页的消息 */
  const onLeaderMessage = (msg: SyncMessage) => {
    if (msg.type === 'hello') postSnapshot()
    else if (msg.type === 'cmd') {
      const fn = commands[msg.name as string]
      const result = fn ? (fn as (...a: unknown[]) => unknown)(...((msg.args as unknown[]) ?? [])) : undefined
      if (msg.askId) {
        void Promise.resolve(result).then(
          (value) => post({ type: 'reply', askId: msg.askId, value: value ?? null }),
          (e: Error) => post({ type: 'reply', askId: msg.askId, error: e.message }),
        )
      }
    }
  }

  /** 镜像页：收到主控页的消息 */
  const onMirrorMessage = (msg: SyncMessage) => {
    switch (msg.type) {
      case 'snapshot': {
        applySegments(msg.segments as Segment[], [], true)
        setAnalyses(msg.analyses as Record<string, Analysis>)
        setKeyFrames(msg.keyFrames as Record<string, KeyFrameState>)
        fallWatchesRef.current = msg.fallWatches as Record<string, FallWatch>
        setFallWatches(fallWatchesRef.current)
        applyShared(msg.state as SharedState)
        break
      }
      case 'segments':
        applySegments(msg.set as Segment[], msg.del as string[])
        mergeQueueRef.current = [...(msg.mergeQueue as string[])]
        break
      case 'record':
        applyRecord(msg.key as 'analyses', msg.diff as RecordDiff<unknown>)
        break
      case 'shared':
        applyShared(msg.state as SharedState)
        break
      case 'sample': {
        const s = msg.sample as Sample
        const arr = samplesRef.current
        arr.push(s)
        while (arr.length && s.t - arr[0].t > WINDOW_MS) arr.shift()
        drawMask(msg.mask as Uint8Array | null)
        setVersion((v) => v + 1)
        break
      }
      case 'frame':
        // 云端转来的是 base64 JPEG（jpeg: null = 画面停了）
        setMirrorImage(typeof msg.jpeg === 'string' ? b64Jpeg(msg.jpeg) : ((msg.blob as Blob | null) ?? null))
        // 一起转来的变化率曲线、变化区域（调试台看过程）
        if (Array.isArray(msg.samples) && msg.samples.length) {
          const arr = samplesRef.current
          for (const s of msg.samples as Sample[]) arr.push(s)
          const lastT = arr[arr.length - 1].t
          while (arr.length && lastT - arr[0].t > WINDOW_MS) arr.shift()
          setVersion((v) => v + 1)
        }
        if (typeof msg.mask === 'string') drawMask(Uint8Array.from(atob(msg.mask), (c) => c.charCodeAt(0)))
        else if (msg.jpeg === null) drawMask(null)
        break
      case 'viewers':
        viewersRef.current = Number(msg.count) || 0
        break
      case 'grab':
        // 云端要一张当前画面（摔倒再看一眼、现在看一眼）
        void (async () => {
          const p = detectorRef.current?.grabSnapshot()
          const snap = p ? await snapUp(await p).catch(() => null) : null
          await upload('/api/capture/grab', { reqId: msg.reqId, snap }).catch(() => {})
        })()
        break
      case 'welcome':
        // 和云端重新连上（如云端重启）：云端不记得谁在采集了，正在采集的页面再报一次到
        if (sourceRef.current) void command('captureStart', [sourceRef.current.name]).catch(() => {})
        break
      case 'capture-stop':
        if (sourceRef.current) {
          // 摄像头交给了另一个页面：这里改为显示它转来的画面，不当成出错
          stop()
          console.info('采集交给了另一个页面：', msg.reason)
        }
        break
      case 'reply': {
        const ask = asksRef.current.get(msg.askId as string)
        if (!ask) break
        asksRef.current.delete(msg.askId as string)
        if (msg.error) ask.reject(new Error(msg.error as string))
        else ask.resolve(msg.value)
        break
      }
    }
  }

  /** 镜像页：让主控页做一件事并等结果 */
  const ask = (name: string, ...args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      const askId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      asksRef.current.set(askId, { resolve, reject })
      post({ type: 'cmd', name, args, askId })
      window.setTimeout(() => {
        if (asksRef.current.delete(askId)) reject(new Error('另一个页面没有回应'))
      }, 30000)
    })

  /**
   * 镜像页接手主控（原主控页关了，或在这里点了开启摄像头）：
   * 用已经同步来的状态接着运行——补上合并用的索引，没分析完的片段重新分析，没完成的“再看一眼”接不上了。
   */
  const adoptLeadership = () => {
    const v = viewRef.current
    segByIdRef.current = new Map(v.segments.map((s) => [s.id, s]))
    keyFramesRef.current = new Map(
      Object.entries(v.keyFrames).flatMap(([id, k]) => (k.status === 'picking' ? [] : [[id, k as KeyFrameResult]])),
    )
    settledRef.current = new Map()
    for (const [id, a] of Object.entries(v.analyses)) {
      if (a.status === 'error') settledRef.current.set(id, null)
      else if (a.status === 'done' && (a.source === 'restored' || keyFramesRef.current.has(id))) settledRef.current.set(id, a.final ?? null)
    }
    segEventRef.current = new Map(v.events.flatMap((e) => e.segmentIds.map((sid) => [sid, e.id] as const)))
    const fw = Object.fromEntries(
      Object.entries(fallWatchesRef.current).map(([id, w]) =>
        w.state === 'waiting' || w.state === 'checking' ? [id, { ...w, state: 'stopped' as const, evidence: '换了页面运行，没有再看' }] : [id, w],
      ),
    )
    fallWatchesRef.current = fw
    setFallWatches(fw)
    prevAlertIds.current = new Set(v.alerts.map((a) => a.id))
    loadedRef.current = true
    setRemote(null)
    setMirrorImage(null)
    postSnapshot()
    // 还在排队合并、但没分析完的片段：重新分析
    for (const id of mergeQueueRef.current) {
      const seg = segByIdRef.current.get(id)
      if (seg && !settledRef.current.has(id)) runAnalysis(seg)
    }
    void processMerges()
  }

  /** 主控被别的页面接走：停下画面和所有在等的事，变成镜像 */
  const demote = () => {
    stop()
    stopAllFallWatches()
    waitingRef.current = []
    loadedRef.current = false
    post({ type: 'hello' })
  }

  const onRole = (r: Role) => {
    const prev = prevRoleRef.current
    if (prev === r) return
    prevRoleRef.current = r
    isLeaderRef.current = r === 'leader'
    setRoleState(r)
    if (r === 'leader') {
      if (prev === 'starting') loadFromDisk()
      else adoptLeadership()
    } else if (r === 'mirror') {
      if (prev === 'leader') demote()
      else post({ type: 'hello' })
    }
  }
  const syncHandlers = useRef({ onRole, onLeaderMessage, onMirrorMessage })
  syncHandlers.current = { onRole, onLeaderMessage, onMirrorMessage }
  useEffect(() => {
    syncHandlers.current.onRole(getRole())
    const offRole = subscribeRole((r) => syncHandlers.current.onRole(r))
    const offMsg = subscribeMessages((m) =>
      isLeaderRef.current ? syncHandlers.current.onLeaderMessage(m) : syncHandlers.current.onMirrorMessage(m),
    )
    const offMismatch = subscribeMismatch(() => setSyncMismatch(true))
    return () => {
      offRole()
      offMsg()
      offMismatch()
    }
  }, [])

  // 设置（第一层参数、忽略区域、模型设置、首次设置）存在本浏览器里：别的页面改了，这里跟着变
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (!e.newValue) return
      try {
        const v = JSON.parse(e.newValue)
        if (e.key === CONFIG_KEY) setConfig({ ...DEFAULT_CONFIG, ...v })
        else if (e.key === ZONES_KEY) setZones(v)
        else if (e.key === JUDGE_KEY) {
          setPolicy(v.policy)
          setConcurrency(v.concurrency)
        } else if (e.key === SETUP_KEY) setSetup({ ...DEFAULT_SETUP, ...v })
      } catch {
        /* 读不了就不跟 */
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  /** 镜像页的操作：转给主控页做（本页先按同样的方式改，主控页的结果随后会发回来） */
  const viaLeader =
    <A extends unknown[]>(name: string, fn: (...a: A) => unknown) =>
    (...a: A) => {
      if (isLeaderRef.current) return fn(...a)
      post({ type: 'cmd', name, args: a })
    }

  const setHomeCtxShared = (u: HomeContext | ((c: HomeContext) => HomeContext)) => {
    const next = typeof u === 'function' ? u(latest.current.homeCtx) : u
    latest.current.homeCtx = next
    setHomeCtx(next)
    if (!isLeaderRef.current) post({ type: 'cmd', name: 'setHomeCtx', args: [next] })
  }

  const saveDraftShared = (segmentId: string, draft: Draft, note: string): ApplyResult => {
    if (isLeaderRef.current) return saveDraft(segmentId, draft, note)
    const res = applyDraft(latest.current.homeCtx, draft)
    if (res.ok) {
      latest.current.homeCtx = res.ctx
      setHomeCtx(res.ctx)
      post({ type: 'cmd', name: 'saveDraft', args: [segmentId, draft, note] })
    }
    return res
  }

  const finishSetupShared = (c: SetupChoices) => {
    if (isLeaderRef.current) return finishSetup(c)
    save(SETUP_KEY, c)
    setSetup(c)
    requestNotifyPermission()
    post({ type: 'cmd', name: 'applySetup', args: [c] })
  }

  const deleteAllShared = async () => {
    if (isLeaderRef.current) return deleteAll()
    if (confirmDeleteAll()) post({ type: 'cmd', name: 'deleteAll', args: [] })
  }

  /** 云端版：Homi 在云端运行，开画面的页面只当采集端，不用切换主控（另一个采集端会被云端叫停） */
  const ensureLeader = async () => true

  const runShared = async (next: FrameSource, describeError: (e: unknown) => string) => {
    if (!(await ensureLeader())) return next.stop()
    return run(next, describeError)
  }
  const startWebcamShared = async () => {
    if (await ensureLeader()) return startWebcam()
  }
  const startVideoShared = async (file: File) => {
    if (await ensureLeader()) return startVideo(file)
  }

  /** 现在看一眼：向云端要（云端再向采集端要）；返回的截图只有地址，送模型时再取图 */
  const grabSnapshotShared = (): Promise<Snapshot> | null => {
    if (isLeaderRef.current) return grabSnapshot()
    if (!remote && !source) return null
    return ask('grabSnapshot').then((v) => {
      if (!v) throw new Error('画面已经关了')
      return { ...(v as Snapshot), blob: undefined as unknown as Blob, gray: new Uint8ClampedArray(0) }
    })
  }

  const snapOf = (k: EventKeyFrame) => {
    const s = segments.find((x) => x.id === k.segmentId)
    return s ? [s.before, ...s.middle, s.after][k.index] : undefined
  }
  const linksOf = (ev: HomiEvent) =>
    consolidation.links
      .filter((l) => l.from === ev.id || l.to === ev.id)
      .map((l) => {
        const other = events.find((e) => e.id === (l.from === ev.id ? l.to : l.from))
        return `${other ? `和 ${clockOf(other.startedAt).slice(0, 5)} 那件事有关：` : ''}${l.relation}`
      })
  /** 今天以前的事件，按天分组（新的在前） */
  const earlierDays = Object.entries(
    [...events]
      .reverse()
      .filter((e) => !isSameDay(e.startedAt, Date.now()))
      .reduce<Record<string, HomiEvent[]>>((acc, e) => {
        ;(acc[dayKey(e.startedAt)] ??= []).push(e)
        return acc
      }, {}),
  ).sort((a, b) => (a[0] < b[0] ? 1 : -1))

  /**
   * 待确认列表（整理后才出现）：未结束的变化、“留意”的事、不紧急的提问。
   * 只在用户打开页面时看到，不推送；逐件回答在第 ④ 步做。
   */
  // 不紧急的提问：有日报时用日报挑的（最多 3 个）；还没日报时去重后取前 3 个
  const questionItems: ReportQuestion[] = report.data
    ? report.data.questions
    : dedupeQuestions(
        segments.filter((s) => isSameDay(s.startedAt, Date.now())).flatMap((s) => {
          const j = analyses[s.id]?.final
          return j?.question && !j.questionUrgent ? [{ key: `q-${s.id}`, segmentId: s.id, text: j.question }] : []
        }),
      ).slice(0, MAX_QUESTIONS)
  const lastSegOf = (e: HomiEvent) => e.segmentIds[e.segmentIds.length - 1] ?? null
  const pending: PendingItem[] = [
    ...consolidation.openChanges.map((o) => ({
      // 按事件记：同一件事整理后措辞变了，用户处理过的也不再出现
      key: `open-${o.eventId}`,
      at: events.find((e) => e.id === o.eventId)?.startedAt ?? 0,
      kind: 'open' as const,
      text: o.text,
      segmentId: null,
    })),
    ...events
      .filter((e) => e.verdict === 'notice' && isSameDay(e.startedAt, Date.now()))
      .map((e) => ({ key: `notice-${e.id}`, at: e.startedAt, kind: 'notice' as const, text: e.summary, segmentId: lastSegOf(e) })),
    ...questionItems.map((q) => ({
      key: q.key,
      at: segments.find((s) => s.id === q.segmentId)?.startedAt ?? 0,
      kind: 'question' as const,
      text: q.text,
      segmentId: q.segmentId,
    })),
  ]
    .filter((p) => !doneKeys.has(p.key))
    .sort((a, b) => a.at - b.at)
  const markDone = (key: string) => setDoneKeys((d) => new Set(d).add(key))
  const answeringSeg = answering?.segmentId ? segments.find((s) => s.id === answering.segmentId) : undefined
  const answeringJudgment = answeringSeg ? analyses[answeringSeg.id]?.final : undefined

  /** 画面在看着：本页开着画面，或（镜像页）主控页开着画面 */
  const running = source !== null || (role === 'mirror' && remote !== null)
  const sourceName = source?.name ?? (role === 'mirror' ? (remote?.name ?? null) : null)

  /** 当场截一张当前画面（“Homi 现在看一眼”）；画面没开时为 null */
  const grabSnapshot = () => detectorRef.current?.grabSnapshot() ?? null

  /** 给底部输入用的事件档案：最近 7 天的全部事件，按时间先后编号 E1、E2…… */
  const chatArchive = () =>
    [...eventsRef.current]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((e, i) => {
        const label = `E${i + 1}`
        const d = new Date(e.startedAt)
        const cat = findCategory(e.category, latest.current.homeCtx.categories).name
        const verdict = e.verdict ? VERDICT_LABEL[e.verdict] : '没能分析'
        const left = leftOf(e)
        return {
          label,
          eventId: e.id,
          line: `${label} ${d.getMonth() + 1}月${d.getDate()}日 ${clockOf(e.startedAt).slice(0, 5)}–${clockOf(e.endedAt).slice(0, 5)}（${cat}，${verdict}）：${e.summary}${left ? `；留下的变化：${left}` : ''}`,
        }
      })

  return {
    role,
    mirrorFrame,
    syncMismatch,
    sourceName,
    grabSnapshot: grabSnapshotShared,
    chatArchive,
    config,
    setConfig,
    zones,
    setZones,
    editingZones,
    setEditingZones,
    showMask,
    setShowMask,
    version,
    samplesRef,
    previewRef,
    maskRef,
    source,
    running,
    error,
    run: runShared,
    // 停止：采集端自己停（会告诉云端）；别的界面请云端叫采集端停。不带参数（按钮的点击事件发不到云端）
    stop: () => (sourceRef.current ? stop() : post({ type: 'cmd', name: 'stop', args: [] })),
    startWebcam: startWebcamShared,
    startVideo: startVideoShared,
    startEufy,
    connectEufy,
    recording,
    startRecording,
    stopRecording,
    policy,
    setPolicy,
    concurrency,
    setConcurrency,
    segments,
    analyses,
    keyFrames,
    fallWatches,
    runAnalysis: (seg: Segment) => (isLeaderRef.current ? runAnalysis(seg) : post({ type: 'cmd', name: 'runAnalysis', args: [seg.id] })),
    selectedId,
    setSelectedId,
    selectedEventId,
    setSelectedEventId,
    homeCtx,
    setHomeCtx: setHomeCtxShared,
    setup,
    setSetup,
    finishSetup: finishSetupShared,
    saveDraft: saveDraftShared,
    recordVote: viaLeader('recordVote', recordVote),
    feedbackLog,
    alerts,
    dismissAlert: viaLeader('dismissAlert', dismissAlert),
    markFalseAlarm: viaLeader('markFalseAlarm', markFalseAlarm),
    endPlan: viaLeader('endPlan', endPlan),
    events,
    consolidation,
    consolidate: viaLeader('consolidate', consolidate),
    report,
    generateReport: viaLeader('generateReport', generateReport),
    snapOf,
    linksOf,
    leftOf,
    earlierDays,
    pending,
    markDone: (key: string) => {
      // 从提醒条点“去回答”答完：收起那条提醒
      if (key.startsWith('alert:')) {
        const id = key.slice('alert:'.length)
        if (isLeaderRef.current) dismissAlert(id)
        else post({ type: 'cmd', name: 'dismissAlert', args: [id] })
        return
      }
      markDone(key)
      if (!isLeaderRef.current) post({ type: 'cmd', name: 'markDone', args: [key] })
    },
    answering,
    setAnswering,
    /** 提醒条上 Homi 的紧急提问：直接打开回答框（答完收起提醒） */
    answerAlert: (a: { id: string; at: number; message: string; segmentId: string }) =>
      setAnswering({ key: `alert:${a.id}`, at: a.at, kind: 'question', text: a.message, segmentId: a.segmentId }),
    answeringSeg,
    answeringJudgment,
    storage,
    deleteAll: deleteAllShared,
  }
}

export type Homi = ReturnType<typeof useHomi>
