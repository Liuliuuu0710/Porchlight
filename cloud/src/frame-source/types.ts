/**
 * 帧来源：把“画面从哪来”与后续处理解耦。
 * 现有：笔记本摄像头（WebcamSource）、本地视频文件（VideoFileSource，用于重复测试）；
 * 拿到 eufy SDK 后新增 EufySource，基于 subscribeMediaChannelFrames 实现同一接口即可。
 */
export interface Frame {
  image: CanvasImageSource
  width: number
  height: number
}

export interface FrameSource {
  readonly name: string
  start(): Promise<void>
  stop(): void
  /** 取最新一帧；尚未出画面时返回 null */
  getFrame(): Frame | null
  /**
   * 当前时刻（毫秒时间戳）。摄像头用真实时间；视频文件按播放进度计算，
   * 暂停时不走、拖动进度条会跳变——检测器据此判断片段时长。
   */
  now(): number
  /** 来源已结束（如视频播完）；检测器会结束进行中的片段 */
  readonly ended: boolean
  /** 用于页面预览的元素（如 <video>） */
  readonly previewElement: HTMLElement | null
}
