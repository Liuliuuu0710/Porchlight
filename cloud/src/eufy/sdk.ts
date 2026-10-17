/**
 * eufy Web SDK（赛事方提供的 UMD 包，public/sdk/index.js，挂到 window.WebSDK）的加载和类型。
 * 用法照赛事方示例（web-sdk-hackathon-demo）：Provider + DeviceLiveLayout 负责开流和播放，
 * subscribeMediaChannelFrames 直接拿解码后的帧（T8171 / T8214 都是 MediaChannel 设备）。
 */
import * as React from 'react'
import * as ReactDOM from 'react-dom'

export interface EufyFrame {
  blob: Blob
  width: number
  height: number
  timestamp: number
  capturedAt: number
}

export interface WebSDK {
  Provider: React.ComponentType<{
    config: { stationSn: string; integration: unknown }
    children: React.ReactNode
    loadingComponent?: React.ReactNode
  }>
  DeviceLiveLayout: React.ComponentType<{
    deviceSn: string
    autoStart?: boolean
    onError?: (error: string) => void
    style?: React.CSSProperties
    className?: string
  }>
  OpenAPIIntegration: new (config: {
    apiDomain: string
    userId: string
    presetKey: string
    authorization: string
    appName: string
    clientId: string
  }) => unknown
  subscribeMediaChannelFrames: (
    stationSn: string,
    onFrame: (frame: EufyFrame) => void,
    options?: {
      intervalMs?: number
      mimeType?: 'image/jpeg' | 'image/png' | 'image/webp'
      quality?: number
      onError?: (error: Error) => void
    },
  ) => () => void
  version: string
}

declare global {
  interface Window {
    React: typeof React
    ReactDOM: typeof ReactDOM
    WebSDK: WebSDK
  }
}

/** eufy 接口的域名。它有的接口不允许网页跨域调用，所以一律经云端 Homi 服务转发（/openapi-api） */
export const OPENAPI_ORIGIN = 'https://openapi-us.eufylife.com'
export const OPENAPI_PROXY = '/openapi-api'
export const viaProxy = (url: string) => (url.startsWith(OPENAPI_ORIGIN) ? OPENAPI_PROXY + url.slice(OPENAPI_ORIGIN.length) : url)

const ready = () => !!window.WebSDK?.Provider && !!window.WebSDK.DeviceLiveLayout && !!window.WebSDK.OpenAPIIntegration

/** SDK 内部用 fetch 调 eufy 接口：改走转发。WebSocket 和视频不受影响，照样直连 eufy */
function patchFetch() {
  const original = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith(OPENAPI_ORIGIN)) {
      return input instanceof Request ? original(new Request(viaProxy(url), input), init) : original(viaProxy(url), init)
    }
    return original(input, init)
  }
}

let loading: Promise<WebSDK> | null = null

/** 第一次用 eufy 摄像头时才加载（SDK 约 5 MB，不用 eufy 就不加载） */
export function loadSdk(): Promise<WebSDK> {
  if (ready()) return Promise.resolve(window.WebSDK)
  loading ??= (async () => {
    // UMD 包用全局的 React / ReactDOM：和我们页面用同一份
    window.React ??= React
    window.ReactDOM ??= ReactDOM
    patchFetch()
    await new Promise<void>((ok, fail) => {
      const s = document.createElement('script')
      s.src = '/sdk/index.js'
      s.async = false
      s.onload = () => ok()
      s.onerror = () => fail(new Error('eufy SDK 加载失败（/sdk/index.js）'))
      document.head.appendChild(s)
    })
    for (let i = 0; i < 20 && !ready(); i++) await new Promise((r) => setTimeout(r, 300))
    if (!ready()) throw new Error('eufy SDK 加载超时')
    return window.WebSDK
  })().catch((e) => {
    loading = null
    throw e
  })
  return loading
}
