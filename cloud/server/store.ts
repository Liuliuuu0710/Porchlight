/**
 * 云端存储（单户，比赛阶段）：普通文件，放在 DATA_DIR（默认 ./data）。
 *   state.json                 事件、整理结果、提醒记录、日报、计划与记忆、设置……（整份写，先写临时文件再改名）
 *   segments/<片段 id>.json      片段的测量值、最终判断、关键图，以及保留了哪几张截图
 *   images/<片段 id>/<序号>.jpg   截图原图（给用户看；送模型前才裁掉 / 填灰忽略区域）
 * 保留：事件 7 天、日报 30 天；片段跟着事件走；较早的片段只留关键图。
 * 服务器硬盘本身是加密的（AWS 加密卷），传输走 HTTPS，取图要访问密码。
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Segment, Snapshot } from '../src/motion/detector'
import type { Judgment } from '../src/ai/judge'
import type { KeyFrameResult } from '../src/ai/keyframes'

export interface StoredFrameMeta {
  index: number
  t: number
  width: number
  height: number
  /** 64×48 灰度图（base64），挑图、裁剪要用 */
  gray: string
}

export interface ServerStoredSegment {
  id: string
  startedAt: number
  endedAt: number
  endReason: Segment['endReason']
  measurements: Segment['measurements']
  ignoreZones: Segment['ignoreZones']
  middleCount: number
  /** 存了哪几张（序号：0 变化前，1..n 中间帧，n+1 变化后） */
  frames: StoredFrameMeta[]
  keyFramesOnly: boolean
  judgment: Judgment | null
  keyFrames: KeyFrameResult | null
}

export const imageUrl = (segId: string, index: number) => `/api/images/${segId}/${index}.jpg`
const SAFE_ID = /^[\w.-]+$/

export const grayToB64 = (g: Uint8ClampedArray | Uint8Array) => Buffer.from(g.buffer, g.byteOffset, g.byteLength).toString('base64')
export const b64ToGray = (s: string) => new Uint8ClampedArray(Buffer.from(s, 'base64'))

let tmpSeq = 0

export class Store {
  constructor(readonly dir: string) {}

  async init() {
    await mkdir(join(this.dir, 'segments'), { recursive: true })
    await mkdir(join(this.dir, 'images'), { recursive: true })
  }

  imageFile(segId: string, index: number) {
    if (!SAFE_ID.test(segId) || !Number.isInteger(index) || index < 0) throw new Error('图片编号不对')
    return join(this.dir, 'images', segId, `${index}.jpg`)
  }

  async saveImage(segId: string, index: number, jpeg: Buffer) {
    await mkdir(join(this.dir, 'images', segId), { recursive: true })
    await writeFile(this.imageFile(segId, index), jpeg)
  }

  async readImage(segId: string, index: number): Promise<Buffer> {
    return readFile(this.imageFile(segId, index))
  }

  async snapshot(segId: string, f: StoredFrameMeta): Promise<Snapshot> {
    const buf = await this.readImage(segId, f.index)
    return { t: f.t, blob: new Blob([new Uint8Array(buf)], { type: 'image/jpeg' }), url: imageUrl(segId, f.index), width: f.width, height: f.height, gray: b64ToGray(f.gray) }
  }

  async saveSegment(s: ServerStoredSegment) {
    await this.writeJson(join(this.dir, 'segments', `${s.id}.json`), s)
  }

  async loadSegments(): Promise<ServerStoredSegment[]> {
    const names = await readdir(join(this.dir, 'segments')).catch(() => [] as string[])
    const out: ServerStoredSegment[] = []
    for (const n of names.filter((x) => x.endsWith('.json'))) {
      try {
        out.push(JSON.parse(await readFile(join(this.dir, 'segments', n), 'utf8')))
      } catch {
        /* 坏文件跳过 */
      }
    }
    return out
  }

  async deleteSegment(id: string) {
    if (!SAFE_ID.test(id)) return
    await rm(join(this.dir, 'segments', `${id}.json`), { force: true })
    await rm(join(this.dir, 'images', id), { recursive: true, force: true })
  }

  /** 只留这几张截图，其余删掉（较早的片段只留关键图） */
  async pruneImages(segId: string, keep: number[]) {
    const names = await readdir(join(this.dir, 'images', segId)).catch(() => [] as string[])
    await Promise.all(
      names
        .filter((n) => !keep.includes(Number(n.replace('.jpg', ''))))
        .map((n) => rm(join(this.dir, 'images', segId, n), { force: true })),
    )
  }

  async loadState<T>(): Promise<T | null> {
    try {
      return JSON.parse(await readFile(join(this.dir, 'state.json'), 'utf8')) as T
    } catch {
      return null
    }
  }

  async saveState(state: unknown) {
    await this.writeJson(join(this.dir, 'state.json'), state)
  }

  /** 删除所有记录：片段和截图全删；state 由调用方重写 */
  async deleteRecords() {
    await rm(join(this.dir, 'segments'), { recursive: true, force: true })
    await rm(join(this.dir, 'images'), { recursive: true, force: true })
    await this.init()
  }

  private async writeJson(file: string, value: unknown) {
    // 每次写用自己的临时文件：同一个文件同时写两次时，不会互相把对方的临时文件改名走
    const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`
    await writeFile(tmp, JSON.stringify(value))
    await rename(tmp, file)
  }
}
