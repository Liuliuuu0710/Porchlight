import type { Frame, FrameSource } from './types'

/**
 * 本地视频文件帧来源：同一段视频反复播放，用来对比参数、复现问题。
 * 时间按播放进度计算（以开始播放时的真实时间为起点），暂停时不走。
 */
export class VideoFileSource implements FrameSource {
  readonly name: string
  private video: HTMLVideoElement
  private url: string
  private baseTime = Date.now()

  constructor(file: File) {
    this.name = `视频：${file.name}`
    this.url = URL.createObjectURL(file)
    this.video = document.createElement('video')
    this.video.muted = true
    this.video.playsInline = true
    this.video.controls = true
    this.video.src = this.url
  }

  get previewElement() {
    return this.video
  }

  get ended() {
    return this.video.ended
  }

  async start() {
    await new Promise<void>((resolve, reject) => {
      if (this.video.readyState >= HTMLMediaElement.HAVE_METADATA) return resolve()
      this.video.addEventListener('loadedmetadata', () => resolve(), { once: true })
      this.video.addEventListener('error', () => reject(new Error('无法读取这个视频文件，换成 .webm 或 .mp4 试试')), {
        once: true,
      })
    })
    await fixDuration(this.video)
    this.baseTime = Date.now()
    try {
      await this.video.play()
    } catch (e) {
      // 页面在后台时 Chrome 会暂停无声视频（AbortError）；保持暂停即可，用户点播放继续
      if ((e as DOMException).name !== 'AbortError' && (e as DOMException).name !== 'NotAllowedError') throw e
    }
  }

  stop() {
    this.video.pause()
    this.video.removeAttribute('src')
    this.video.load()
    URL.revokeObjectURL(this.url)
  }

  now() {
    return this.baseTime + Math.round(this.video.currentTime * 1000)
  }

  getFrame(): Frame | null {
    const v = this.video
    if (v.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !v.videoWidth) return null
    return { image: v, width: v.videoWidth, height: v.videoHeight }
  }
}

/**
 * 浏览器录制的 .webm 不写时长（duration = Infinity），进度条拖不动、也没法按时间跳转。
 * 常用做法：先跳到极大的时间点，浏览器会算出真实时长，再跳回开头。
 */
export async function fixDuration(v: HTMLVideoElement) {
  if (Number.isFinite(v.duration)) return
  await new Promise<void>((resolve) => {
    const done = () => {
      v.removeEventListener('durationchange', onChange)
      v.currentTime = 0
      resolve()
    }
    const onChange = () => Number.isFinite(v.duration) && done()
    v.addEventListener('durationchange', onChange)
    v.currentTime = 1e101
    setTimeout(done, 3000) // 兜底：算不出来也不影响播放
  })
}
