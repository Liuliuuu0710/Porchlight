/**
 * 本机存储（浏览器 IndexedDB）：只存在这台电脑的这个浏览器里，不上传。
 * - segments：片段（最终判断 + 只存关键图）
 * - events：事件
 * - reports：日报（只存文字），按日期一天一份
 * - kv：其他（计划与记忆、整理结果、提醒记录、待确认里处理过的……）
 * 保留期限见 store/retention.ts。
 */
const DB_NAME = 'porchlight'
const DB_VERSION = 1
export const STORES = ['segments', 'events', 'reports', 'kv'] as const
export type StoreName = (typeof STORES)[number]

let dbPromise: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

export async function put(store: StoreName, key: string, value: unknown): Promise<void> {
  const tx = (await open()).transaction(store, 'readwrite')
  tx.objectStore(store).put(value, key)
  return done(tx)
}

export async function get<T>(store: StoreName, key: string): Promise<T | undefined> {
  const tx = (await open()).transaction(store, 'readonly')
  const req = tx.objectStore(store).get(key)
  await done(tx)
  return req.result as T | undefined
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  const tx = (await open()).transaction(store, 'readonly')
  const req = tx.objectStore(store).getAll()
  await done(tx)
  return req.result as T[]
}

export async function remove(store: StoreName, keys: string[]): Promise<void> {
  if (keys.length === 0) return
  const tx = (await open()).transaction(store, 'readwrite')
  for (const k of keys) tx.objectStore(store).delete(k)
  return done(tx)
}

/** 用 items 整体替换一个表（事件不多，整体替换最简单，不会留下已合并掉的旧事件） */
export async function replaceAll(store: StoreName, items: { key: string; value: unknown }[]): Promise<void> {
  const tx = (await open()).transaction(store, 'readwrite')
  const s = tx.objectStore(store)
  s.clear()
  for (const it of items) s.put(it.value, it.key)
  return done(tx)
}

export async function clear(stores: StoreName[]): Promise<void> {
  const tx = (await open()).transaction(stores, 'readwrite')
  for (const s of stores) tx.objectStore(s).clear()
  return done(tx)
}

/** 本站点占用的存储空间（浏览器估算） */
export async function usage(): Promise<number | null> {
  try {
    return (await navigator.storage?.estimate())?.usage ?? null
  } catch {
    return null
  }
}
