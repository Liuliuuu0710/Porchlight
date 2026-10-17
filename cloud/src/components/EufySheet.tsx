import { useEffect, useState } from 'react'
import { fetchCloudEufyConfig, loadEufyConfig, missingFields, saveEufyConfig, type EufyConfig } from '../eufy/config'
import { authHeaders } from '../core/auth'

const FIELDS: { key: keyof EufyConfig; label: string; secret?: boolean; hint?: string }[] = [
  { key: 'appName', label: 'App Name' },
  { key: 'clientId', label: 'Client ID' },
  { key: 'clientSecret', label: 'Client Secret', secret: true, hint: '用 account_uuid 登录时才要' },
  { key: 'presetKey', label: 'Preset Key', secret: true },
  { key: 'stationSn', label: '设备 SN', hint: 'T8171 云台摄像头 / T8214 门铃' },
  { key: 'eufyUserId', label: 'eufy_user_id' },
  { key: 'token', label: 'Token', secret: true, hint: '填了就直接用；不填则用 account_uuid 重新生成' },
  { key: 'accountUuid', label: 'account_uuid' },
]

/**
 * 连接 eufy 摄像头：手动填 / 改鉴权参数（存在这台电脑的浏览器里）。平时用云端配好的参数（/api/eufy-config），不用填。
 * 关掉浏览器自动填充（表单里有密码框，浏览器会把它当登录表单乱填）。
 */
export function EufySheet({ onConnect, onClose }: { onConnect: (c: EufyConfig) => void; onClose: () => void }) {
  const [form, setForm] = useState<EufyConfig>(loadEufyConfig)
  const [show, setShow] = useState(false)
  // 这台浏览器没填过：先填上云端配好的参数，再按需改
  useEffect(() => {
    if (missingFields(loadEufyConfig()).length === 0) return
    void fetchCloudEufyConfig(authHeaders()).then((c) => c && setForm(c))
  }, [])
  const miss = missingFields(form)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (miss.length) return
    saveEufyConfig(form)
    onConnect(form)
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <form className="sheet eufy-sheet" role="dialog" aria-modal="true" aria-label="连接 eufy 摄像头" onClick={(e) => e.stopPropagation()} onSubmit={submit} autoComplete="off">
        <header className="sheet-head">
          <h2>连接 eufy 摄像头</h2>
          <button type="button" className="link" onClick={onClose}>关闭</button>
        </header>
        <p className="hint">
          云端已配好参数时，直接点「eufy 摄像头」就能连；这里用来临时改一次（存在这台电脑的浏览器里）。请用 Chrome，并在 chrome://flags 把 WebRTC PQC for DTLS 设为 Disabled。
          连不上提示 403 时，先逐字核对 App Name、Client ID、Preset Key（大小写，l / I / 1，O / 0），最好直接复制粘贴。
        </p>
        {FIELDS.map((f) => (
          <label key={f.key} className="eufy-field">
            <span>
              {f.label}
              {f.hint && <small>{f.hint}</small>}
            </span>
            <input
              type={f.secret && !show ? 'password' : 'text'}
              autoComplete={f.secret ? 'new-password' : 'off'}
              spellCheck={false}
              value={form[f.key]}
              onChange={(e) => setForm((p) => ({ ...p, [f.key]: e.target.value }))}
            />
          </label>
        ))}
        <label className="eufy-show">
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> 显示密钥
        </label>
        {miss.length > 0 && <p className="hint">还缺：{miss.join('、')}</p>}
        <div className="sheet-actions">
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button type="submit" className="btn primary" disabled={miss.length > 0}>连接</button>
        </div>
      </form>
    </div>
  )
}
