/**
 * 读写本机记录：打开页面时读回（顺便删掉过期的），之后各部分有变化就保存。
 * 保留：事件 / 片段 / 整理结果 / 提醒记录 7 天；日报 30 天（只存文字）；计划与记忆一直保留，直到用户删除。
 * “删除所有记录”删的是事件、片段、日报、整理结果、提醒记录和待确认的处理情况；计划、记忆、首次设置保留。
 */
import type { HomiEvent } from '../events/grouping'
import type { EventLink, OpenChange } from '../events/consolidate'
import type { DailyReport, ReportAlert } from '../events/report'
import type { HomeContext } from '../memory/types'
import type { FallWatch } from '../components/SegmentCard'
import { clear, get, getAll, put, remove, replaceAll } from './db'
import type { StoredSegment } from './persist'
import { EVENT_RETENTION_DAYS, dayKey, expiredReportKeys, isExpired } from './retention'

export interface StoredConsolidation {
  at: number | null
  links: EventLink[]
  /** 10/15 以前统一整理写的“留下的变化”；之后写在事件自己的 left 里 */
  leftChanges: Record<string, string>
  openChanges: OpenChange[]
  note: string
  /** 已经判过“是不是同一件”的组合 → 当时两件各有几个片段（没变就不再问）；旧记录没有 */
  checked?: Record<string, string>
}

export interface LoadedRecords {
  segments: StoredSegment[]
  events: HomiEvent[]
  /** 今天的日报 */
  report: DailyReport | null
  homeCtx: HomeContext | undefined
  consolidation: StoredConsolidation | undefined
  alertLog: ReportAlert[]
  doneKeys: string[]
  fallWatches: Record<string, FallWatch>
  lastTimerReportAt: number | null
  /** 这次读的时候删掉了多少过期的 */
  expired: { events: number; segments: number; reports: number }
}

const KV = {
  homeCtx: 'homeCtx',
  consolidation: 'consolidation',
  alertLog: 'alertLog',
  doneKeys: 'doneKeys',
  fallWatches: 'fallWatches',
  lastTimerReportAt: 'lastTimerReportAt',
} as const

export async function loadRecords(now: number): Promise<LoadedRecords> {
  const [segAll, evAll, reports, homeCtx, consolidation, alertLog, doneKeys, fallWatches, lastTimerReportAt] = await Promise.all([
    getAll<StoredSegment>('segments'),
    getAll<HomiEvent>('events'),
    getAll<DailyReport>('reports'),
    get<HomeContext>('kv', KV.homeCtx),
    get<StoredConsolidation>('kv', KV.consolidation),
    get<ReportAlert[]>('kv', KV.alertLog),
    get<string[]>('kv', KV.doneKeys),
    get<Record<string, FallWatch>>('kv', KV.fallWatches),
    get<number | null>('kv', KV.lastTimerReportAt),
  ])

  // 过期：事件按结束时间；片段跟着事件走（不属于任何事件的按自己的结束时间）
  const events = evAll.filter((e) => !isExpired(e.endedAt, now, EVENT_RETENTION_DAYS))
  const keptSegIds = new Set(events.flatMap((e) => e.segmentIds))
  const inExpiredEvent = new Set(evAll.filter((e) => !events.includes(e)).flatMap((e) => e.segmentIds))
  const segments = segAll.filter((s) =>
    keptSegIds.has(s.id) ? true : !inExpiredEvent.has(s.id) && !isExpired(s.endedAt, now, EVENT_RETENTION_DAYS),
  )
  const expiredSegs = segAll.filter((s) => !segments.includes(s)).map((s) => s.id)
  const reportKeys = reports.map((r) => dayKey(r.at))
  const expiredReports = expiredReportKeys(reportKeys, now)
  await Promise.all([
    remove('segments', expiredSegs),
    evAll.length !== events.length ? saveEvents(events) : Promise.resolve(),
    remove('reports', expiredReports),
  ])

  const alive = new Set(events.map((e) => e.id))
  const segAlive = new Set(segments.map((s) => s.id))
  return {
    segments,
    events: events.map((e) => ({ ...e, busy: false })),
    report: reports.find((r) => dayKey(r.at) === dayKey(now)) ?? null,
    homeCtx,
    consolidation: consolidation && {
      ...consolidation,
      links: consolidation.links.filter((l) => alive.has(l.from) && alive.has(l.to)),
      leftChanges: Object.fromEntries(Object.entries(consolidation.leftChanges).filter(([id]) => alive.has(id))),
      openChanges: consolidation.openChanges.filter((o) => alive.has(o.eventId)),
      checked: Object.fromEntries(
        Object.entries(consolidation.checked ?? {}).filter(([k]) => k.split('~').every((id) => alive.has(id))),
      ),
    },
    alertLog: (alertLog ?? []).filter((a) => !isExpired(a.at, now, EVENT_RETENTION_DAYS)),
    doneKeys: doneKeys ?? [],
    fallWatches: Object.fromEntries(Object.entries(fallWatches ?? {}).filter(([id]) => segAlive.has(id))),
    lastTimerReportAt: lastTimerReportAt ?? null,
    expired: { events: evAll.length - events.length, segments: expiredSegs.length, reports: expiredReports.length },
  }
}

export const saveSegment = (s: StoredSegment) => put('segments', s.id, s)

/** 事件整体替换（合并掉的旧事件随之删除）；busy 是运行时状态，不存 */
export const saveEvents = (events: HomiEvent[]) =>
  replaceAll(
    'events',
    events.map((e) => ({ key: e.id, value: { ...e, busy: false } })),
  )

/** 日报一天一份，后生成的覆盖先生成的 */
export const saveReport = (r: DailyReport) => put('reports', dayKey(r.at), r)

export const saveHomeCtx = (c: HomeContext) => put('kv', KV.homeCtx, c)
export const saveConsolidation = (c: StoredConsolidation) => put('kv', KV.consolidation, c)
export const saveAlertLog = (l: ReportAlert[]) => put('kv', KV.alertLog, l)
export const saveDoneKeys = (k: string[]) => put('kv', KV.doneKeys, k)
export const saveFallWatches = (w: Record<string, FallWatch>) => put('kv', KV.fallWatches, w)
export const saveLastTimerReportAt = (t: number | null) => put('kv', KV.lastTimerReportAt, t)

/** 删除所有记录（计划、记忆、首次设置保留） */
export async function deleteRecords(): Promise<void> {
  await clear(['segments', 'events', 'reports'])
  await remove('kv', [KV.consolidation, KV.alertLog, KV.doneKeys, KV.fallWatches, KV.lastTimerReportAt])
}
