/**
 * 云端服务的图片处理（ImageOps 的 Node 实现）：纯 JS 解码 / 编码 JPEG（jpeg-js），不依赖原生库，部署简单。
 * 裁剪 + 面积平均缩小 + 忽略区域填灰，和浏览器画布版效果一致。
 */
import jpeg from 'jpeg-js'
import type { ImageOps } from '../src/ai/image-ops'
import type { Snapshot } from '../src/motion/detector'
import type { Box } from '../src/motion/state-machine'

const GRAY = 128
const QUALITY = 85

interface Raw {
  width: number
  height: number
  data: Uint8Array
}

async function decode(snap: Snapshot): Promise<Raw> {
  const buf = new Uint8Array(await snap.blob.arrayBuffer())
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true })
  return { width: img.width, height: img.height, data: img.data }
}

/** 取 src 的 region，面积平均缩到 w×h（不放大时就是逐像素复制） */
function cropScale(src: Raw, region: Box, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4)
  const sx0 = region.x * src.width
  const sy0 = region.y * src.height
  const fx = (region.w * src.width) / w
  const fy = (region.h * src.height) / h
  for (let y = 0; y < h; y++) {
    const ya = Math.floor(sy0 + y * fy)
    const yb = Math.max(ya + 1, Math.min(src.height, Math.floor(sy0 + (y + 1) * fy)))
    for (let x = 0; x < w; x++) {
      const xa = Math.floor(sx0 + x * fx)
      const xb = Math.max(xa + 1, Math.min(src.width, Math.floor(sx0 + (x + 1) * fx)))
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let yy = ya; yy < yb; yy++) {
        let i = (yy * src.width + xa) * 4
        for (let xx = xa; xx < xb; xx++, i += 4) {
          r += src.data[i]
          g += src.data[i + 1]
          b += src.data[i + 2]
          n++
        }
      }
      const o = (y * w + x) * 4
      out[o] = r / n
      out[o + 1] = g / n
      out[o + 2] = b / n
      out[o + 3] = 255
    }
  }
  return out
}

function fill(data: Uint8Array, w: number, h: number, fills: Box[]) {
  for (const f of fills) {
    const x0 = Math.max(0, Math.floor(f.x * w))
    const y0 = Math.max(0, Math.floor(f.y * h))
    const x1 = Math.min(w, Math.ceil((f.x + f.w) * w))
    const y1 = Math.min(h, Math.ceil((f.y + f.h) * h))
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * w + x) * 4
        data[o] = data[o + 1] = data[o + 2] = GRAY
      }
    }
  }
}

export const nodeImageOps: ImageOps = {
  async size(snap) {
    if (snap.width && snap.height) return { width: snap.width, height: snap.height }
    const img = await decode(snap)
    return { width: img.width, height: img.height }
  },
  async render(snap, region, width, height, fills) {
    const src = await decode(snap)
    const data = cropScale(src, region, width, height)
    fill(data, width, height, fills)
    const enc = jpeg.encode({ width, height, data }, QUALITY)
    return `data:image/jpeg;base64,${Buffer.from(enc.data).toString('base64')}`
  },
  // 总览图（方案 C）云端暂不支持：默认方案是 B
}
