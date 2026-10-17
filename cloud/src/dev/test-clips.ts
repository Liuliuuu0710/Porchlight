/**
 * 开发用测试片段（仅开发测试，不提交、不在路演播放）：
 * - UR Fall Detection Dataset（CC BY-NC-SA 4.0，见 test-videos/ur-fall/来源与许可.md）：视频是“深度图 + 彩色图”左右拼接，只取右半边彩色画面
 * - CAVIAR（CC BY-SA，见 test-videos/caviar/来源与许可.md）：原视频是 MPEG-2，浏览器放不了，用逐帧 JPEG 播放
 * 内容为目测，个别可能不准。
 */
import { ClipSource, type ClipOptions } from '../frame-source/clip'
import { ImageSequenceSource, type ImageSequenceOptions } from '../frame-source/image-sequence'
import type { MotionConfig } from '../motion/state-machine'

export interface TestClip {
  id: string
  label: string
  /** 视频文件（UR）；逐帧图片的片段为空 */
  file: string
  /** 期望：摔倒且起不来 → 紧急提醒；摔倒后起身 → 只记录；正常动作 → 不提醒；长场景 → 看合并和关键图 */
  expect: 'fall-stays-down' | 'fall-gets-up' | 'not-fall' | 'long-scene'
  options: ClipOptions
  /** 逐帧图片（CAVIAR） */
  sequence?: ImageSequenceOptions
  /** 这个片段需要的第一层参数（如广角远景里人很小，面积阈值要调低） */
  motion?: Partial<MotionConfig>
}

/** 按片段类型创建帧来源；tailMs 可覆盖结尾停留时间（评测时缩短） */
export function createClipSource(c: TestClip, tailMs?: number): ClipSource | ImageSequenceSource {
  if (c.sequence) return new ImageSequenceSource(c.label, { ...c.sequence, ...(tailMs !== undefined ? { tailMs } : {}) })
  return new ClipSource(c.file, c.label, { ...c.options, ...(tailMs !== undefined ? { tailMs } : {}) })
}

const RGB_HALF = { x: 0.5, y: 0, w: 0.5, h: 1 }
const base = '/test-videos/ur-fall/'

const fall = (n: string, desc: string): TestClip[] => [
  {
    id: `fall-${n}`,
    label: `摔倒 ${n}：${desc}（摔倒后起不来）`,
    file: `${base}fall-${n}-cam0.mp4`,
    expect: 'fall-stays-down',
    options: { crop: RGB_HALF, ending: 'hold' },
  },
  {
    id: `fall-${n}-up`,
    label: `摔倒 ${n}：${desc}（倒放模拟起身）`,
    file: `${base}fall-${n}-cam0.mp4`,
    expect: 'fall-gets-up',
    options: { crop: RGB_HALF, ending: 'reverse' },
  },
]

const adl = (n: string, desc: string): TestClip => ({
  id: `adl-${n}`,
  label: `正常 ${n}：${desc}`,
  file: `${base}adl-${n}-cam0.mp4`,
  expect: 'not-fall',
  options: { crop: RGB_HALF, ending: 'hold' },
})

export const TEST_CLIPS: TestClip[] = [
  ...fall('01', '走动中摔倒'),
  ...fall('02', '从半蹲摔倒'),
  ...fall('05', '向前扑倒'),
  ...fall('10', '跪着倒下'),
  adl('01', '弯腰捡东西'),
  adl('05', '蹲下再站起'),
  adl('10', '坐到沙发上'),
  adl('20', '主动躺到地上又起来'),
  {
    // 用户 10/14 用笔记本摄像头录的（33.5 秒，1280×720）：拿纸盒走进来、举起看、在右边弯腰放下、走到窗边、转身喝水、到右边弯腰、走回镜头前
    id: 'own-box',
    label: '长场景（自己录）：拿纸盒进来放下、喝水、走回来（约 33 秒）',
    file: '/test-videos/own/porchlight-20261014-185234.webm',
    expect: 'long-scene',
    options: { ending: 'hold', tailMs: 6000 },
  },
  {
    id: 'caviar-leftbag',
    label: '长场景：门厅有人放下包离开，之后回来拿走（约 54 秒）',
    file: '',
    expect: 'long-scene',
    options: {},
    sequence: {
      url: (i) => `/test-videos/caviar/leftbag-pickedup/JPEGS/LeftBag_PickedUp${String(i).padStart(4, '0')}.jpg`,
      count: 1355,
      fps: 25,
    },
    // 广角门厅远景，人只占画面很小一块：帧间变化最大约 1.6%，默认 2% 切不出片段
    motion: { areaThreshold: 0.005 },
  },
]
