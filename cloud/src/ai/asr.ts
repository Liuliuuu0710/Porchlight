/**
 * 语音输入（《产品逻辑》3.6）：按住麦克风录音 → 转成 16k 单声道 WAV → 主办方网关的 qwen-audio-3.0-asr-flash 识别成文字。
 * 录音只经过本机代理发到主办方网关（和截图同一条路），不用浏览器自带的识别（要连 Google，国内多半用不了）。
 *
 * 注意（2026-10-14 实测）：网关对这个模型返回 401“api key is not active”——是网关那边这个模型的上游 Key 没开通，
 * 不是我们的 Key（文字、看图都正常）。所以请求格式（input_audio + wav）还没能实测，开通后要先验证。
 */
import { chat, GatewayError } from './gateway'

const MODEL = 'hackathon/v_model/qwen-audio-3.0-asr-flash'
const RATE = 16000

/** 识别服务暂时用不了（网关没开通等）：界面上提示用户先用文字 */
export class AsrUnavailable extends Error {}

/** 录下来的音频（浏览器一般是 webm/opus）→ 16k 单声道 16 位 WAV */
export async function toWav(blob: Blob): Promise<ArrayBuffer> {
  const ctx = new AudioContext()
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer())
    const length = Math.max(1, Math.ceil(decoded.duration * RATE))
    const offline = new OfflineAudioContext(1, length, RATE)
    const src = offline.createBufferSource()
    src.buffer = decoded
    src.connect(offline.destination)
    src.start()
    const pcm = (await offline.startRendering()).getChannelData(0)
    const buf = new ArrayBuffer(44 + pcm.length * 2)
    const v = new DataView(buf)
    const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
    w(0, 'RIFF')
    v.setUint32(4, 36 + pcm.length * 2, true)
    w(8, 'WAVE')
    w(12, 'fmt ')
    v.setUint32(16, 16, true)
    v.setUint16(20, 1, true)
    v.setUint16(22, 1, true)
    v.setUint32(24, RATE, true)
    v.setUint32(28, RATE * 2, true)
    v.setUint16(32, 2, true)
    v.setUint16(34, 16, true)
    w(36, 'data')
    v.setUint32(40, pcm.length * 2, true)
    for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true)
    return buf
  } finally {
    void ctx.close()
  }
}

function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** 识别一段 WAV，返回文字（去掉首尾空白） */
export async function transcribe(wav: ArrayBuffer): Promise<string> {
  try {
    const res = await chat(MODEL, [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: base64(wav), format: 'wav' } }] }], {
      maxTokens: 1024,
      timeoutMs: 30000,
    })
    return res.text.trim()
  } catch (e) {
    if (e instanceof GatewayError && (e.status === 401 || e.status === 403 || e.status === 404)) {
      throw new AsrUnavailable('语音识别暂时用不了（主办方网关的语音模型还没开通），先打字吧')
    }
    throw e
  }
}

/** 按住说话：开始录音，返回“松开”时调用的结束函数（结束后得到录音） */
export async function startRecording(): Promise<{ stop: () => Promise<Blob>; cancel: () => void }> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const rec = new MediaRecorder(stream)
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  rec.start()
  const release = () => stream.getTracks().forEach((t) => t.stop())
  return {
    stop: () =>
      new Promise<Blob>((resolve) => {
        rec.onstop = () => {
          release()
          resolve(new Blob(chunks, { type: rec.mimeType }))
        }
        rec.stop()
      }),
    cancel: () => {
      rec.onstop = release
      if (rec.state !== 'inactive') rec.stop()
      else release()
    },
  }
}
