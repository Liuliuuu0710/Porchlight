/**
 * 送模型的图怎么画：浏览器用画布（image-ops-browser.ts），云端服务用纯 JS 解码 / 编码（server/image-ops-node.ts）。
 * 启动时注册一种；AI 代码只调这里，不关心在哪运行。
 * 忽略区域按 zones.ts 处理：先裁掉四周的，剩下的填灰。
 */
import type { Snapshot } from '../motion/detector'
import type { Box } from '../motion/state-machine'
import { modelView, outputSize } from './zones'

export interface ImageOps {
  /** 取 snap 的 region 部分，缩放到 width×height，fills（相对 region 0–1）填灰，编码成 JPEG Data URL */
  render(snap: Snapshot, region: Box, width: number, height: number, fills: Box[]): Promise<string>
  /** 原图尺寸（浏览器端从截图里读，服务端从 Snapshot.width/height） */
  size(snap: Snapshot): Promise<{ width: number; height: number }>
  /** 总览图（方案 C 用，云端暂不支持） */
  sheet?(snaps: Snapshot[], labels: string[], region: Box, width: number, fills: Box[]): Promise<string>
}

let impl: ImageOps | null = null
export function setImageOps(o: ImageOps) {
  impl = o
}
function ops(): ImageOps {
  if (!impl) throw new Error('还没注册图片处理（setImageOps）')
  return impl
}

/** 截图 → 送模型的图：region（null = 全图）先去掉忽略区域，再按最长边 / 宽度缩小 */
export async function modelImage(snap: Snapshot, region: Box | null, size: { maxSide?: number; maxWidth?: number }, zones: Box[]) {
  const v = modelView(region, zones)
  const src = await ops().size(snap)
  const out = outputSize(src.width, src.height, v.region, size)
  return ops().render(snap, v.region, out.width, out.height, v.fills)
}

export async function modelSheet(snaps: Snapshot[], labels: string[], region: Box | null, width: number, zones: Box[]) {
  const o = ops()
  if (!o.sheet) throw new Error('这里不支持总览图（送图方案 C）')
  const v = modelView(region, zones)
  return o.sheet(snaps, labels, v.region, width, v.fills)
}
