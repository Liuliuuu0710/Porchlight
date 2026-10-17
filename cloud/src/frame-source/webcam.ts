import type { Frame, FrameSource } from './types'

/** 笔记本摄像头帧来源（开发阶段替代 eufy） */
export class WebcamSource implements FrameSource {
  readonly name = '笔记本摄像头'
  readonly ended = false
  private video: HTMLVideoElement
  private stream: MediaStream | null = null

  constructor() {
    this.video = document.createElement('video')
    this.video.muted = true
    this.video.playsInline = true
  }

  get previewElement() {
    return this.video
  }

  /** 供录制使用 */
  get mediaStream() {
    return this.stream
  }

  /** 画面是否还在：摄像头被拔掉 / 被系统收回为 ended；暂时没有画面（被别的程序占用、休眠）为 muted */
  get health(): 'ok' | 'ended' | 'muted' {
    const track = this.stream?.getVideoTracks()[0]
    if (!track || track.readyState === 'ended') return 'ended'
    return track.muted ? 'muted' : 'ok'
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    })
    this.video.srcObject = this.stream
    await this.video.play()
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.video.srcObject = null
  }

  now() {
    return Date.now()
  }

  getFrame(): Frame | null {
    const v = this.video
    if (v.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !v.videoWidth) return null
    return { image: v, width: v.videoWidth, height: v.videoHeight }
  }
}
