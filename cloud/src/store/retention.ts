/**
 * 保留期限和按天划分（《产品逻辑》第 7 节）：事件、片段（只存关键图）、整理结果、提醒记录 7 天；日报 30 天，只存文字。
 * 纯逻辑，方便单测。
 */
export const DAY_MS = 24 * 60 * 60 * 1000
export const EVENT_RETENTION_DAYS = 7
export const REPORT_RETENTION_DAYS = 30

/** 本地日期 YYYY-MM-DD（日报一天一份，用它做键） */
export function dayKey(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const isSameDay = (a: number, b: number) => dayKey(a) === dayKey(b)

/** 今天 0 点 */
export function startOfDay(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 超过保留期：按自然日算，保留今天和往前 days-1 天 */
export function isExpired(t: number, now: number, days: number): boolean {
  return t < startOfDay(now) - (days - 1) * DAY_MS
}

/** 超过保留期的日报日期键 */
export function expiredReportKeys(keys: string[], now: number, days = REPORT_RETENTION_DAYS): string[] {
  const oldest = dayKey(startOfDay(now) - (days - 1) * DAY_MS)
  return keys.filter((k) => k < oldest)
}

/**
 * 片段只存了关键图，读回来时要还原成“变化前 + 中间帧 + 变化后”的完整序列（关键图的编号指的是序列位置）。
 * 没存的位置用最近的、存了的图补上（往前找，找不到再往后），只是为了让序列完整，界面上不会显示它们。
 */
export function sparseSequence<T>(length: number, kept: Map<number, T>): T[] {
  if (kept.size === 0) throw new Error('至少要有一张图')
  const out: T[] = []
  let last: T | undefined
  for (let i = 0; i < length; i++) {
    if (kept.has(i)) last = kept.get(i)
    out.push(last as T)
  }
  // 开头那几位往后找第一张
  const first = [...kept.entries()].sort((a, b) => a[0] - b[0])[0][1]
  return out.map((x) => x ?? first)
}
