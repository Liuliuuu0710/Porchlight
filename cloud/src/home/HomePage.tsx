import { useState } from 'react'
import { useHomi } from '../core/useHomi'
import { AlertBanner, requestNotifyPermission } from '../components/AlertBanner'
import { SetupSheet } from '../components/SetupSheet'
import { fallRuleOn } from '../memory/types'
import { isSameDay } from '../store/retention'
import { PlansSheet } from './PlansSheet'
import { MemoriesSheet } from './MemoriesSheet'
import { TodaySheet } from './TodaySheet'
import { SettingsSheet, VisitorSheet } from './SettingsSheet'
import { ChatList, Composer, useChat } from './Chat'
import './home.css'

type Open = 'today' | 'plans' | 'memories' | 'settings' | 'visitor' | null

/**
 * 正式页面（《产品逻辑》3.6，会议 V2 简洁版）：
 * 提醒条 → 实时画面（和访客说话）→ Homi 一句话（点开“今天”）→ 短期计划 / 长期记忆 → 底部输入。
 * 逻辑都在 core/useHomi.ts，和调试台共用。
 */
export function HomePage() {
  const homi = useHomi()
  const chat = useChat(homi)
  const [open, setOpen] = useState<Open>(null)
  const { running, sourceName, homeCtx, events, report, pending } = homi
  const mirror = homi.role === 'mirror'

  const today = events.filter((e) => isSameDay(e.startedAt, Date.now()))
  const enabledPlans = homeCtx.plans.filter((p) => p.enabled).length
  const enabledMemories = homeCtx.memories.filter((m) => m.enabled).length

  // 日报写完之后又有新的事，日报那句话就不准了，改说今天的情况
  const fresh = report.data && !today.some((e) => e.endedAt > report.data!.at)
  // Homi 那一句话：有待确认的事先说这个；否则用今天日报的开头一句；日报过时或还没有就说说今天的情况
  const insight =
    pending.length > 0
      ? `这里有 ${pending.length} 件事需要您确认一下。`
      : fresh
        ? report.data!.headline
        : today.length
          ? `今天记录了 ${today.length} 件事${running ? '，我还在看着' : ''}。`
          : running
            ? '我在看着。有变化会记下来，需要时才打扰你。'
            : '连上摄像头后，我会帮你看着家里。'

  return (
    <div className="home">
      {homi.setup === null && <SetupSheet initial={{ fallAlert: fallRuleOn(homeCtx) }} onDone={homi.finishSetup} />}

      <main className="h-main">
        <header className="h-header">
          <span className="h-logo" aria-hidden>
            ⌂
          </span>
          <span className="h-brand">
            Porchlight <span className="h-muted">/ 留灯</span>
          </span>
          <span className="h-spacer" />
          <span className={`h-status ${running ? 'on' : ''}`}>{running ? '● 正在看着' : '画面未开启'}</span>
          <button className="h-more" onClick={() => setOpen('settings')} aria-label="设置">
            ⋯
          </button>
        </header>

        {homi.error && <p className="h-error">{homi.error}</p>}
        {homi.syncMismatch && <p className="h-error">有 Porchlight 页面是旧版本，请把所有 Porchlight 页面都刷新一下。</p>}

        <div className="h-alerts">
          <AlertBanner
            alerts={homi.alerts}
            canLookNow={running}
            onDismiss={homi.dismissAlert}
            onEndPlan={homi.endPlan}
            onFalseAlarm={homi.markFalseAlarm}
            onLookNow={() => homi.previewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
            onShowSegment={() => setOpen('today')}
            onAnswer={(a) => {
              // 回答框在“今天”里打开（和待确认的回答同一个）
              homi.answerAlert(a)
              setOpen('today')
            }}
          />
        </div>

        <section className="h-scene" ref={homi.previewRef}>
          {mirror && running && !homi.source && homi.mirrorFrame && <img className="h-mirror" src={homi.mirrorFrame} alt="另一个页面的画面" />}
          <span className="h-scene-tag">
            {running ? (homi.source ? `● 实时 · ${sourceName ?? ''}` : `● 画面在另一台设备上 · ${sourceName ?? ''}`) : '画面未开启'}
          </span>
          {!running && (
            <div className="h-scene-empty">
              <p>连上摄像头，Homi 就开始帮你看着。</p>
              <button className="h-primary" onClick={() => void homi.connectEufy().then((ok) => ok || setOpen('settings'))}>
                连接 eufy 摄像头
              </button>
              <button className="h-link light" onClick={() => void homi.startWebcam()}>
                用这台电脑的摄像头
              </button>
              <button className="h-link light" onClick={() => setOpen('settings')}>
                或者播放一段视频
              </button>
            </div>
          )}
          <button className="h-call" onClick={() => setOpen('visitor')}>
            ↗ 和访客说话
          </button>
        </section>

        <button className="h-insight" onClick={() => setOpen('today')}>
          <span className="h-avatar" aria-hidden>
            H
          </span>
          <span className="h-insight-text">{insight}</span>
          <span className="h-insight-more">今天 ›</span>
        </button>

        <div className="h-entries">
          <button className="h-entry" onClick={() => setOpen('plans')}>
            <span className="h-icon" aria-hidden>
              ▤
            </span>
            <span>
              <strong>短期计划</strong>
              <small>{enabledPlans} 条启用 · 点开查看</small>
            </span>
            <span className="h-arrow">↗</span>
          </button>
          <button className="h-entry" onClick={() => setOpen('memories')}>
            <span className="h-icon" aria-hidden>
              ❋
            </span>
            <span>
              <strong>长期记忆</strong>
              <small>{enabledMemories} 条习惯 · 点开查看</small>
            </span>
            <span className="h-arrow">↗</span>
          </button>
        </div>

        <ChatList chat={chat} homi={homi} />
      </main>

      <Composer chat={chat} />

      {open === 'today' && <TodaySheet homi={homi} onClose={() => setOpen(null)} />}
      {open === 'plans' && (
        <PlansSheet
          ctx={homeCtx}
          onChange={homi.setHomeCtx}
          onAdded={(d) => d.intent === 'plan_add' && d.planKind === 'expect' && requestNotifyPermission()}
          onClose={() => setOpen(null)}
        />
      )}
      {open === 'memories' && <MemoriesSheet ctx={homeCtx} onChange={homi.setHomeCtx} onClose={() => setOpen(null)} />}
      {open === 'settings' && <SettingsSheet homi={homi} onClose={() => setOpen(null)} />}
      {open === 'visitor' && <VisitorSheet onClose={() => setOpen(null)} />}
    </div>
  )
}
