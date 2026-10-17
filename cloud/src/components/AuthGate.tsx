import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { authState, checkAuthRequired, login, subscribeAuth } from '../core/auth'

/**
 * 访问密码（只在部署的服务器上出现；本机开发时直接放行）：
 * 每次新打开网页先输一次密码，之后这次打开期间不再要（10/16 去掉了每 10 分钟重输）。
 * 服务器不认通行证了（极少：过了 30 天、通行证文件丢了）才再输一次——这时页面不关，正在进行的分析等你输完再继续。
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(subscribeAuth, () => JSON.stringify(authState()))
  const { required, authed } = JSON.parse(state) as ReturnType<typeof authState>
  const [everAuthed, setEverAuthed] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void checkAuthRequired()
  }, [])
  useEffect(() => {
    if (authed) setEverAuthed(true)
  }, [authed])

  // 还不知道要不要密码：先什么都不显示，避免页面闪一下
  if (required === null) return null
  if (!required) return <>{children}</>
  // 第一次打开：输完密码才显示页面
  if (!everAuthed && !authed) return <PasswordBox again={false} {...{ password, setPassword, error, busy, submit }} />

  return (
    <>
      {children}
      {/* 服务器不认通行证了：页面留着，盖一层再输一次 */}
      {!authed && <PasswordBox again {...{ password, setPassword, error, busy, submit }} />}
    </>
  )

  async function submit() {
    if (!password || busy) return
    setBusy(true)
    setError(null)
    const err = await login(password).catch((e: Error) => `连不上服务器：${e.message}`)
    setBusy(false)
    if (err) setError(err)
    else setPassword('')
  }
}

function PasswordBox({
  again,
  password,
  setPassword,
  error,
  busy,
  submit,
}: {
  again: boolean
  password: string
  setPassword: (v: string) => void
  error: string | null
  busy: boolean
  submit: () => void
}) {
  return (
    <div className="auth-backdrop">
      <form
        className="auth-box"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="auth-logo">⌂</div>
        <h2>Porchlight / 留灯</h2>
        <p>{again ? '登录失效了，请再输入一次访问密码。正在进行的分析会等你输完再继续。' : '请输入访问密码。'}</p>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          placeholder="访问密码"
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="auth-error">{error}</p>}
        <button type="submit" disabled={!password || busy}>
          {busy ? '验证中…' : '进入'}
        </button>
      </form>
    </div>
  )
}
