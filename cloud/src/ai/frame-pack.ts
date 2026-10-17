/**
 * 浏览器端的图片处理（ImageOps 的画布实现）：裁剪、缩放、忽略区域填灰、总览图。
 * 网页启动时注册（main.tsx）；云端服务用 server/image-ops-node.ts。
 */
import type { Snapshot } from '../motion/detector'
import type { Box } from '../motion/state-machine'
import type { ImageOps } from './image-ops'
import { FILL_GRAY } from './zones'

async function bitmap(snap: Snapshot): Promise<ImageBitmap> {
  // 云端发来的截图只有地址（没有 blob），先取回来
  const blob = snap.blob ?? (await (await fetch(snap.url)).blob())
  return createImageBitmap(blob)
}

/** 把 region 画到 (dx, dy, dw, dh)，fills（相对 region）填灰 */
function drawRegion(g: CanvasRenderingContext2D, bmp: ImageBitmap, region: Box, fills: Box[], dx: number, dy: number, dw: number, dh: number) {
  g.drawImage(bmp, region.x * bmp.width, region.y * bmp.height, region.w * bmp.width, region.h * bmp.height, dx, dy, dw, dh)
  g.fillStyle = FILL_GRAY
  for (const f of fills) g.fillRect(dx + f.x * dw, dy + f.y * dh, f.w * dw, f.h * dh)
}

export const browserImageOps: ImageOps = {
  async size(snap) {
    if (snap.width && snap.height) return { width: snap.width, height: snap.height }
    const bmp = await bitmap(snap)
    const s = { width: bmp.width, height: bmp.height }
    bmp.close()
    return s
  },
  async render(snap, region, width, height, fills) {
    const bmp = await bitmap(snap)
    const c = document.createElement('canvas')
    c.width = width
    c.height = height
    drawRegion(c.getContext('2d')!, bmp, region, fills, 0, 0, width, height)
    bmp.close()
    return c.toDataURL('image/jpeg', 0.85)
  },
  /** 总览图：按时间排成网格，每格左上角标编号；宽度固定，格子按 region 的长宽比排 */
  async sheet(snaps, labels, region, width, fills) {
    const bmps = await Promise.all(snaps.map(bitmap))
    const aspect = (region.h * (bmps[0]?.height ?? 1)) / (region.w * (bmps[0]?.width ?? 1))
    const cols = Math.max(1, Math.round(Math.sqrt(snaps.length / aspect)))
    const rows = Math.ceil(snaps.length / cols)
    const cw = Math.floor(width / cols)
    const ch = Math.round(cw * aspect)
    const c = document.createElement('canvas')
    c.width = cw * cols
    c.height = ch * rows
    const g = c.getContext('2d')!
    g.fillStyle = '#fff'
    g.fillRect(0, 0, c.width, c.height)
    const font = Math.max(12, Math.round(cw / 9))
    bmps.forEach((bmp, i) => {
      const dx = (i % cols) * cw
      const dy = Math.floor(i / cols) * ch
      drawRegion(g, bmp, region, fills, dx, dy, cw, ch)
      g.strokeStyle = '#fff'
      g.lineWidth = 2
      g.strokeRect(dx + 1, dy + 1, cw - 2, ch - 2)
      g.font = `bold ${font}px sans-serif`
      const tw = g.measureText(labels[i]).width
      g.fillStyle = 'rgba(0,0,0,0.75)'
      g.fillRect(dx + 2, dy + 2, tw + 8, font + 6)
      g.fillStyle = '#ff0'
      g.fillText(labels[i], dx + 6, dy + font + 3)
      bmp.close()
    })
    return c.toDataURL('image/jpeg', 0.85)
  },
}
