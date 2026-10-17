import { useRef } from 'react'
import type { Homi } from '../core/useHomi'
import { TEST_CLIPS, createClipSource } from '../dev/test-clips'
import { Sheet } from './Sheet'

/** “⋯”设置：画面来源、首次设置、删除所有记录、打开调试台、数据说明 */
export function SettingsSheet({ homi, onClose }: { homi: Homi; onClose: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const start = (fn: () => unknown) => {
    void fn()
    onClose()
  }
  return (
    <Sheet title="设置" onClose={onClose}>
      <h3>画面来源</h3>
      <p className="h-muted">
        现在：{homi.sourceName ?? '没有开启'}
        {homi.role === 'mirror' && '（Homi 在另一个页面运行，这里只显示；在这里开启画面会切换到这个页面）'}
      </p>
      <div className="h-actions">
        {homi.running ? (
          <button className="h-secondary" onClick={() => start(homi.stop)}>
            停止
          </button>
        ) : (
          <>
            <button className="h-primary" onClick={() => start(homi.connectEufy)}>
              连接 eufy 摄像头
            </button>
            <button className="h-secondary" onClick={() => start(homi.startWebcam)}>
              电脑摄像头
            </button>
            <button className="h-secondary" onClick={() => fileRef.current?.click()}>
              播放视频文件
            </button>
          </>
        )}
      </div>
      {import.meta.env.DEV && !homi.running && (
        <label>
          开发用测试片段
          <select
            value=""
            onChange={(e) => {
              const c = TEST_CLIPS.find((x) => x.id === e.target.value)
              if (c) start(() => homi.run(createClipSource(c), (err) => (err as Error).message))
            }}
          >
            <option value="">选择一个测试片段…</option>
            {TEST_CLIPS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="video/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) start(() => homi.startVideo(f))
        }}
      />

      <h3>提醒与数据</h3>
      <div className="h-actions">
        <button
          className="h-secondary"
          onClick={() => {
            homi.setSetup(null)
            onClose()
          }}
        >
          重新选择 Homi 帮你留意的事
        </button>
        <button className="h-danger" onClick={() => void homi.deleteAll()}>
          删除所有记录
        </button>
      </div>
      <p className="h-description">
        事件、关键图和日报只保存在这台电脑的浏览器里（事件 7 天、日报 30 天），没被选中的截图不保存。
        需要判断时，截图会经本机代理发到主办方 AI 网关，你框选的忽略区域会先裁掉或填灰，不进模型。
        {homi.storage.usage !== null && ` 目前约占 ${(homi.storage.usage / 1024 / 1024).toFixed(1)} MB。`}
        {homi.storage.note && ` ${homi.storage.note}。`}
      </p>

      <h3>开发</h3>
      <a className="h-link" href="?dev=console">
        打开调试台 ↗
      </a>
    </Sheet>
  )
}

/** 和访客说话：设备对讲还没接通，只说明情况，不做假的通话 */
export function VisitorSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="和镜头前的人说话" description="用来和快递员、朋友等来访的人说话。" onClose={onClose}>
      <div className="h-card">
        <strong>设备对讲尚未接通</strong>
        <p className="h-description">
          网页端的设备接口目前只提供画面，没有对讲。接上支持对讲的设备或 App 之后，这里会变成按住说话、对方能听到。现在不会发出任何声音。
        </p>
      </div>
    </Sheet>
  )
}
