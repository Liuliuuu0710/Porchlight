/**
 * 录制摄像头画面为 .webm，用来积累测试素材。录好的文件可作为视频文件帧来源反复测试。
 */
export class StreamRecorder {
  private recorder: MediaRecorder
  private chunks: Blob[] = []
  readonly startedAt = Date.now()

  constructor(stream: MediaStream) {
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    )
    this.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data)
    this.recorder.start(1000)
  }

  /** 停止录制，返回视频文件 */
  stop(): Promise<File> {
    return new Promise((resolve) => {
      this.recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: 'video/webm' })
        resolve(new File([blob], `porchlight-${stamp(this.startedAt)}.webm`, { type: 'video/webm' }))
      }
      this.recorder.stop()
    })
  }
}

function stamp(t: number) {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 触发浏览器下载 */
export function download(file: File) {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
