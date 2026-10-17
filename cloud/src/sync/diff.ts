/**
 * 多标签页同步用的纯函数（不碰浏览器，便于测试）。
 * 主控页只把变了的条目发出去：按引用比较（React 的 state 每次更新都会换新对象，没变的条目引用不变）。
 */

/** 按 id 记录的一组数据（片段分析、关键图、摔倒再看一眼……）的变化 */
export interface RecordDiff<T> {
  set: Record<string, T>
  del: string[]
}

export function diffRecord<T>(prev: Record<string, T>, next: Record<string, T>): RecordDiff<T> {
  const set: Record<string, T> = {}
  for (const [k, v] of Object.entries(next)) if (prev[k] !== v) set[k] = v
  const del = Object.keys(prev).filter((k) => !(k in next))
  return { set, del }
}

export const isEmptyDiff = (d: RecordDiff<unknown>) => d.del.length === 0 && Object.keys(d.set).length === 0

export function applyRecordDiff<T>(base: Record<string, T>, d: RecordDiff<T>): Record<string, T> {
  const out = { ...base, ...d.set }
  for (const k of d.del) delete out[k]
  return out
}

/** 带 id 的列表（片段）：新增 / 替换 / 删除，返回变化 */
export function diffById<T extends { id: string }>(prev: Map<string, T>, next: T[]): { set: T[]; del: string[] } {
  const ids = new Set(next.map((x) => x.id))
  return { set: next.filter((x) => prev.get(x.id) !== x), del: [...prev.keys()].filter((id) => !ids.has(id)) }
}

/** 把变化合进列表，按 startedAt 新的在前（和页面上片段列表的顺序一致） */
export function upsertById<T extends { id: string; startedAt: number }>(list: T[], set: T[], del: string[]): T[] {
  const gone = new Set([...del, ...set.map((x) => x.id)])
  return [...list.filter((x) => !gone.has(x.id)), ...set].sort((a, b) => b.startedAt - a.startedAt)
}
