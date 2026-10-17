/**
 * 忽略区域怎么从送模型的图里去掉（10/15 用户确认）：
 * - 先裁：画面四周被忽略的部分整条裁掉——模型按图片尺寸算读取量，裁掉才真的省；
 * - 再填：裁剪框里面还夹着的忽略区域，用中性灰填上（涂黑不省额度，黑块还容易被模型描述）。
 * 只针对送模型的图；给用户看的原图不变（原图存在云端，忽略区域不进模型）。
 * 纯计算，不碰画布，便于测试；坐标都是画面比例 0–1。
 */
import type { Box } from '../motion/state-machine.ts'

export const FULL: Box = { x: 0, y: 0, w: 1, h: 1 }
/** 填忽略区域的颜色 */
export const FILL_GRAY = '#808080'
/** 算“没被忽略的部分”用的格子精度 */
const GRID = 64

export function intersect(a: Box, b: Box): Box | null {
  const x0 = Math.max(a.x, b.x)
  const y0 = Math.max(a.y, b.y)
  const x1 = Math.min(a.x + a.w, b.x + b.w)
  const y1 = Math.min(a.y + a.h, b.y + b.h)
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
}

/** 没被忽略的部分外面那个框；全被忽略（不合理）时返回全图 */
export function keepBox(zones: Box[]): Box {
  if (zones.length === 0) return FULL
  let x0 = GRID
  let y0 = GRID
  let x1 = -1
  let y1 = -1
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const cx = (gx + 0.5) / GRID
      const cy = (gy + 0.5) / GRID
      const ignored = zones.some((z) => cx >= z.x && cx <= z.x + z.w && cy >= z.y && cy <= z.y + z.h)
      if (ignored) continue
      x0 = Math.min(x0, gx)
      y0 = Math.min(y0, gy)
      x1 = Math.max(x1, gx)
      y1 = Math.max(y1, gy)
    }
  }
  if (x1 < 0) return FULL
  return { x: x0 / GRID, y: y0 / GRID, w: (x1 - x0 + 1) / GRID, h: (y1 - y0 + 1) / GRID }
}

/**
 * 送模型的一张图实际取哪块、哪些地方填灰：
 * region 是想要的部分（null = 全图，或变化区域），先和“没被忽略的部分”取交集（裁掉四周的忽略区域）；
 * fills 是裁剪框里还要填灰的矩形，坐标相对裁剪框（0–1）。
 */
export function modelView(region: Box | null, zones: Box[]): { region: Box; fills: Box[] } {
  const want = region ?? FULL
  const r = intersect(want, keepBox(zones)) ?? want
  const fills = zones.flatMap((z) => {
    const i = intersect(z, r)
    // 格子取整留下的细条（不到裁剪框的 2%）不用填
    return i && i.w / r.w >= 0.02 && i.h / r.h >= 0.02 ? [{ x: (i.x - r.x) / r.w, y: (i.y - r.y) / r.h, w: i.w / r.w, h: i.h / r.h }] : []
  })
  return { region: r, fills }
}

/** 裁剪后的尺寸（不放大）：maxSide 限最长边，maxWidth 限宽 */
export function outputSize(srcW: number, srcH: number, region: Box, size: { maxSide?: number; maxWidth?: number }) {
  const sw = region.w * srcW
  const sh = region.h * srcH
  const limit = size.maxSide !== undefined ? size.maxSide / Math.max(sw, sh) : (size.maxWidth ?? sw) / sw
  const scale = Math.min(1, limit)
  return { width: Math.max(1, Math.round(sw * scale)), height: Math.max(1, Math.round(sh * scale)) }
}
