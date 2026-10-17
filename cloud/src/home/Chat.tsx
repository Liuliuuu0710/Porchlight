import { useEffect, useRef, useState } from 'react'
import type { Homi } from '../core/useHomi'
import { askHomi, lookNow } from '../ai/assistant'
import { GatewayError } from '../ai/gateway'
import { applyDraft, type Draft } from '../memory/apply'
import { requestNotifyPermission } from '../components/AlertBanner'
import { EventCard } from '../components/EventCard'
import type { Segment } from '../motion/detector'
import { DraftCard } from './DraftCard'
import { AsrUnavailable, startRecording, toWav, transcribe } from '../ai/asr'

/** 对话只保存在这次打开的页面里（《产品逻辑》第 7 节：聊天记录只在会话内） */
export interface Msg {
  id: number
  role: 'user' | 'homi'
  text: string
  pending?: boolean
  /** 回答依据的事件 id */
  evidence?: string[]
  /** “现在看一眼”时截的图 */
  image?: string
  /** 布置 / 修改计划或记忆的草稿；确认后才生效 */
  draft?: { draft: Draft; error: string | null; state: 'open' | 'saved' | 'cancelled'; savedLabel?: string }
}

let seq = 0

/** 底部统一输入的对话逻辑：发一句 → Homi 判断意图 → 回答 / 草稿 / 看一眼 */
export function useChat(homi: Homi) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [busy, setBusy] = useState(false)
  const patch = (id: number, p: Partial<Msg>) => setMsgs((all) => all.map((m) => (m.id === id ? { ...m, ...p } : m)))

  const send = async (text: string) => {
    const t = text.trim()
    if (!t || busy) return
    const history = msgs
      .filter((m) => !m.pending)
      .slice(-6)
      .map((m) => ({ role: m.role, text: m.text }))
    const reply: Msg = { id: ++seq, role: 'homi', text: '', pending: true }
    setMsgs((all) => [...all, { id: ++seq, role: 'user', text: t }, reply])
    setBusy(true)
    try {
      const ctx = homi.homeCtx
      const r = await askHomi(t, { now: Date.now(), ctx, archive: homi.chatArchive(), history })
      if (r.intent === 'look_now') {
        const snapP = homi.grabSnapshot()
        if (!snapP) {
          patch(reply.id, { pending: false, text: '画面现在没开。打开摄像头后，我就能帮你看一眼。' })
        } else {
          patch(reply.id, { text: '我看一眼…' })
          const snap = await snapP
          const answer = await lookNow(snap, homi.zones, t)
          patch(reply.id, { pending: false, text: answer, image: snap.url })
        }
      } else if (r.plan || r.memory) {
        const updatePlan = r.intent === 'plan_update' && ctx.plans.some((p) => p.id === r.plan?.target)
        const updateMemory = r.intent === 'memory_update' && ctx.memories.some((m) => m.id === r.memory?.target)
        const draft: Draft = r.plan
          ? {
              intent: updatePlan ? 'plan_update' : 'plan_add',
              targetId: updatePlan ? r.plan.target : null,
              text: r.plan.text,
              planKind: r.plan.kind,
              cues: r.plan.cues ?? '',
              start: r.plan.start,
              end: r.plan.end,
            }
          : {
              intent: updateMemory ? 'memory_update' : 'memory_add',
              targetId: updateMemory ? r.memory!.target : null,
              text: r.memory!.text,
              start: '',
              end: '',
            }
        patch(reply.id, { pending: false, text: r.reply, draft: { draft, error: null, state: 'open' } })
      } else {
        patch(reply.id, { pending: false, text: r.reply, evidence: r.evidence })
      }
    } catch (e) {
      const msg = e instanceof GatewayError ? e.message : (e as Error).message
      patch(reply.id, { pending: false, text: `抱歉，我刚才没能处理好（${msg}）。可以再说一次吗？` })
    } finally {
      setBusy(false)
    }
  }

  const changeDraft = (id: number, p: Partial<Draft>) =>
    setMsgs((all) => all.map((m) => (m.id === id && m.draft ? { ...m, draft: { ...m.draft, draft: { ...m.draft.draft, ...p }, error: null } } : m)))

  const confirmDraft = (id: number) => {
    const m = msgs.find((x) => x.id === id)
    if (!m?.draft) return
    const res = applyDraft(homi.homeCtx, m.draft.draft)
    if (!res.ok) return patch(id, { draft: { ...m.draft, error: res.error } })
    homi.setHomeCtx(res.ctx)
    if (m.draft.draft.intent === 'plan_add' && m.draft.draft.planKind === 'expect') requestNotifyPermission()
    patch(id, { draft: { ...m.draft, state: 'saved', savedLabel: res.label } })
  }

  const cancelDraft = (id: number) => {
    const m = msgs.find((x) => x.id === id)
    if (m?.draft) patch(id, { draft: { ...m.draft, state: 'cancelled' } })
  }

  return { msgs, busy, send, changeDraft, confirmDraft, cancelDraft }
}

const hm = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

/** 对话气泡：用户的在右，Homi 的在左；Homi 的回答可以附事件卡、截图或草稿 */
export function ChatList({ chat, homi }: { chat: ReturnType<typeof useChat>; homi: Homi }) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // 不要把 scrollIntoView 的返回值交给 useEffect（新版浏览器会返回 Promise，React 会当成清理函数报错）
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [chat.msgs])
  if (chat.msgs.length === 0) return null
  return (
    <div className="h-chat" aria-live="polite">
      {chat.msgs.map((m) => (
        <div key={m.id} className={`h-bubble ${m.role === 'user' ? 'me' : 'homi'}`}>
          {m.pending && !m.text ? <span className="h-typing">Homi 在想…</span> : <p>{m.text}</p>}
          {m.image && <img className="h-look" src={m.image} alt="刚才截的画面" />}
          {m.evidence?.map((id) => {
            const ev = homi.events.find((e) => e.id === id)
            if (!ev) return null
            const segs = ev.segmentIds.map((s) => homi.segments.find((x) => x.id === s)).filter((s): s is Segment => !!s)
            return (
              <div key={id} className="h-evidence">
                <EventCard
                  event={ev}
                  categories={homi.homeCtx.categories}
                  segments={segs}
                  judgmentOf={(sid) => homi.analyses[sid]?.final}
                  snapOf={homi.snapOf}
                />
              </div>
            )
          })}
          {m.draft?.state === 'open' && (
            <DraftCard
              reply={m.draft.draft.intent === 'plan_update' ? `修改计划：${homi.homeCtx.plans.find((p) => p.id === m.draft!.draft.targetId)?.text ?? ''}` : m.draft.draft.intent === 'memory_update' ? `修改记忆：${homi.homeCtx.memories.find((x) => x.id === m.draft!.draft.targetId)?.text ?? ''}` : '确认一下：'}
              draft={m.draft.draft}
              error={m.draft.error}
              onChange={(p) => chat.changeDraft(m.id, p)}
              onConfirm={() => chat.confirmDraft(m.id)}
              onCancel={() => chat.cancelDraft(m.id)}
            />
          )}
          {m.draft?.state === 'saved' && <p className="h-muted">✓ {m.draft.savedLabel}（{hm(Date.now())}）</p>}
          {m.draft?.state === 'cancelled' && <p className="h-muted">没有保存</p>}
        </div>
      ))}
      <div ref={endRef} className="h-chat-end" />
    </div>
  )
}

type MicState = { phase: 'idle' } | { phase: 'recording'; since: number } | { phase: 'recognizing' }

/** 按住麦克风说话，松开后识别，文字填进输入框（可以改了再发） */
function useMic(onText: (t: string) => void) {
  const [state, setState] = useState<MicState>({ phase: 'idle' })
  const [note, setNote] = useState<string | null>(null)
  const rec = useRef<Awaited<ReturnType<typeof startRecording>> | null>(null)
  const pressed = useRef(false)

  const down = async () => {
    if (state.phase !== 'idle') return
    pressed.current = true
    setNote(null)
    try {
      const r = await startRecording()
      // 还没开始录就已经松开了
      if (!pressed.current) return r.cancel()
      rec.current = r
      setState({ phase: 'recording', since: Date.now() })
    } catch (e) {
      const name = (e as DOMException).name
      setNote(name === 'NotAllowedError' ? '没有麦克风权限：请在地址栏左侧允许使用麦克风' : `没能打开麦克风：${(e as Error).message}`)
    }
  }

  const up = async () => {
    pressed.current = false
    const r = rec.current
    if (!r || state.phase !== 'recording') return
    rec.current = null
    if (Date.now() - state.since < 400) {
      r.cancel()
      setState({ phase: 'idle' })
      return setNote('按住说话，说完再松开')
    }
    setState({ phase: 'recognizing' })
    try {
      const text = await transcribe(await toWav(await r.stop()))
      if (text) onText(text)
      else setNote('没听清，再说一次？')
    } catch (e) {
      setNote(e instanceof AsrUnavailable ? e.message : `没能识别：${(e as Error).message}`)
    } finally {
      setState({ phase: 'idle' })
    }
  }

  return { state, note, down, up }
}

/** 底部输入框（参考 ChatGPT 网页版）：回车发送，Shift+回车换行；输入框会随内容变高；按住麦克风说话 */
export function Composer({ chat }: { chat: ReturnType<typeof useChat> }) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const mic = useMic((t) => {
    setText((old) => (old.trim() ? `${old} ${t}` : t))
    ref.current?.focus()
  })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [text])
  const submit = () => {
    if (!text.trim() || chat.busy) return
    void chat.send(text)
    setText('')
  }
  return (
    <div className="h-composer-wrap">
      <div className="h-composer">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder="告诉 Homi 点什么，或者问问今天发生了什么…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="h-composer-tools">
          <button
            className={`h-mic ${mic.state.phase}`}
            aria-label="按住说话"
            title="按住说话，松开识别"
            disabled={mic.state.phase === 'recognizing'}
            onPointerDown={(e) => {
              e.preventDefault()
              e.currentTarget.setPointerCapture(e.pointerId)
              void mic.down()
            }}
            onPointerUp={() => void mic.up()}
            onPointerCancel={() => void mic.up()}
          >
            {mic.state.phase === 'recognizing' ? '…' : '🎤'}
          </button>
          <button className="h-send" onClick={submit} disabled={!text.trim() || chat.busy} aria-label="发送">
            ↑
          </button>
        </div>
      </div>
      <p className={`h-composer-hint ${mic.note ? 'warn' : ''}`}>
        {mic.state.phase === 'recording'
          ? '正在听…说完松开'
          : mic.state.phase === 'recognizing'
            ? '识别中…'
            : (mic.note ?? 'Homi 只根据摄像头记下的事回答；布置的计划和记忆，你确认后才生效。')}
      </p>
    </div>
  )
}
