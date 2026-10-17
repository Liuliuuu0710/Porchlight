interface AlertBase {
  id: string
  /** 系统提醒没有对应片段，为空 */
  segmentId: string
  message: string
  /** 截图（给用户看的原图）；系统提醒没有 */
  imageUrl: string
  at: number
}

/** 期待型计划被看到（如“送快递的人到了”） */
export interface ExpectAlert extends AlertBase {
  kind: 'expect'
  planId: string
  planText: string
}

/** 紧急：有人摔倒后仍在地上（“再看一眼”确认过） */
export interface FallAlert extends AlertBase {
  kind: 'fall'
  /** 再看一眼时看到了什么 */
  evidence: string
  /** 第几次提醒（2 分钟后仍在地上会再提醒一次） */
  round: number
}

/** 紧急提问：可能是用户在等的事 / 违反规则，但看不清 */
export interface QuestionAlert extends AlertBase {
  kind: 'question'
  /** 问的是哪条计划 / 记忆（如 "plan:p1"）：同一件事只留一条，计划到达后自动收起 */
  about?: string | null
}

/** 系统提醒：与画面内容无关，如摄像头断开、画面停了 */
export interface SystemAlert extends AlertBase {
  kind: 'system'
}

export type Alert = ExpectAlert | FallAlert | QuestionAlert | SystemAlert

const hm = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

const ICON = { expect: '📦', fall: '🚨', question: '❓', system: '⚠️' } as const

/**
 * 页面顶部的 Homi 提醒条：一句话 + 截图 + 处理按钮。只有 4 种情况 + 系统提醒会出现在这里（见《产品逻辑》3.2）。
 * 期待型：知道了 / 结束这个计划 / 看看现在；紧急（摔倒）：看看现在 / 我知道了，已处理 / 是误报；
 * 紧急提问：去回答（打开回答框）/ 知道了；系统：知道了。
 */
export function AlertBanner({
  alerts,
  canLookNow,
  onDismiss,
  onEndPlan,
  onFalseAlarm,
  onLookNow,
  onShowSegment,
  onAnswer,
}: {
  alerts: Alert[]
  canLookNow: boolean
  onDismiss: (id: string) => void
  onEndPlan: (alert: ExpectAlert) => void
  onFalseAlarm: (alert: FallAlert) => void
  onLookNow: () => void
  onShowSegment: (segmentId: string) => void
  /** 紧急提问的“去回答”：打开回答框；不给就跳到片段 */
  onAnswer?: (alert: Alert) => void
}) {
  if (alerts.length === 0) return null
  return (
    <div className="alerts" role="region" aria-label="Homi 提醒">
      {alerts.map((a) => (
        <div key={a.id} className={`alert ${a.kind === 'fall' || a.kind === 'system' ? 'alert-urgent' : ''}`} role="alert">
          {a.imageUrl && (
            <button className="alert-img" onClick={() => onShowSegment(a.segmentId)} title="查看这个片段">
              <img src={a.imageUrl} alt="提醒时的画面" />
            </button>
          )}
          <div className="alert-body">
            <p className="alert-msg">
              {ICON[a.kind]} Homi：{a.message}
            </p>
            <p className="alert-meta">
              {hm(a.at)}
              {a.kind === 'fall' && ` · ${a.round > 1 ? '再次确认：' : '已再看一眼确认：'}${a.evidence}`}
              {a.kind === 'expect' && ` · 你在等的：${a.planText}`}
              {a.kind === 'question' && ' · 看不太清，想马上问你'}
            </p>
            <div className="alert-actions">
              {a.kind === 'fall' && (
                <>
                  <button className="btn small primary" onClick={onLookNow} disabled={!canLookNow}>
                    看看现在
                  </button>
                  <button className="btn small" onClick={() => onDismiss(a.id)}>
                    我知道了，已处理
                  </button>
                  <button className="link" onClick={() => onFalseAlarm(a)}>
                    是误报
                  </button>
                </>
              )}
              {a.kind === 'expect' && (
                <>
                  <button className="btn small primary" onClick={() => onDismiss(a.id)}>
                    知道了
                  </button>
                  <button className="btn small" onClick={() => onEndPlan(a)}>
                    结束这个计划
                  </button>
                  <button className="link" onClick={onLookNow} disabled={!canLookNow}>
                    看看现在
                  </button>
                </>
              )}
              {a.kind === 'question' && (
                <>
                  <button className="btn small primary" onClick={() => (onAnswer ? onAnswer(a) : onShowSegment(a.segmentId))}>
                    去回答
                  </button>
                  <button className="btn small" onClick={() => onDismiss(a.id)}>
                    知道了
                  </button>
                  <button className="link" onClick={onLookNow} disabled={!canLookNow}>
                    看看现在
                  </button>
                </>
              )}
              {a.kind === 'system' && (
                <button className="btn small primary" onClick={() => onDismiss(a.id)}>
                  知道了
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

/** 紧急提示音：三声短促的“嘀”。浏览器要求页面先有过用户操作才能出声，出不了声也不影响提醒条 */
export function playUrgentSound() {
  try {
    const ac = new AudioContext()
    for (let i = 0; i < 3; i++) {
      const o = ac.createOscillator()
      const g = ac.createGain()
      o.frequency.value = 880
      g.gain.setValueAtTime(0.0001, ac.currentTime + i * 0.35)
      g.gain.exponentialRampToValueAtTime(0.3, ac.currentTime + i * 0.35 + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + i * 0.35 + 0.25)
      o.connect(g).connect(ac.destination)
      o.start(ac.currentTime + i * 0.35)
      o.stop(ac.currentTime + i * 0.35 + 0.3)
    }
    setTimeout(() => void ac.close(), 1500)
  } catch {
    /* 没有声音也不影响提醒条和系统通知 */
  }
}

/** 浏览器系统通知：页面在后台时也能看到。需要用户先允许 */
export function notifySystem(title: string, body: string, icon?: string, urgent = false) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return
    // 紧急提醒不自动消失，要用户自己关掉
    const n = new Notification(title, { body, icon, tag: urgent ? 'porchlight-urgent' : 'porchlight', requireInteraction: urgent })
    n.onclick = () => {
      window.focus()
      n.close()
    }
  } catch {
    /* 个别浏览器不支持，不影响页面内提醒 */
  }
}

/** 请求通知权限：必须在用户点击等操作中调用 */
export function requestNotifyPermission() {
  try {
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission()
  } catch {
    /* 忽略 */
  }
}
