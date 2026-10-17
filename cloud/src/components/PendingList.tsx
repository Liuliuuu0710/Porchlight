const clock = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

/** 一件需要用户确认的事 */
export interface PendingItem {
  key: string
  at: number
  /** open：还没结束的变化；notice：值得看一眼的事；question：Homi 想问的（不紧急） */
  kind: 'open' | 'notice' | 'question'
  text: string
  /** 回答 / 反馈时针对哪个片段（打开反馈输入页用） */
  segmentId: string | null
}

const LABEL = { open: '还没结束', notice: '值得看一眼', question: 'Homi 想问' } as const

/**
 * “这里有几件事需要您确认一下”：整理后才出现，不推送；一件一件处理，处理完就从列表里消失。
 * - 还没结束的变化：已经处理了 / 知道了
 * - 值得看一眼：知道了 / 说点什么…（进反馈输入页，可存成记忆或计划，需要确认）
 * - Homi 想问：回答…（进反馈输入页）/ 先不回答
 */
export function PendingList({
  items,
  onDone,
  onAnswer,
}: {
  items: PendingItem[]
  onDone: (key: string) => void
  onAnswer: (item: PendingItem) => void
}) {
  if (items.length === 0) return null
  return (
    <details className="pending" open>
      <summary>这里有 {items.length} 件事需要您确认一下</summary>
      <ul>
        {items.map((it) => (
          <li key={it.key} className={`pending-item pending-${it.kind}`}>
            <span className="pending-text">
              <b>{clock(it.at)}</b> <span className="tag">{LABEL[it.kind]}</span> {it.text}
            </span>
            <span className="pending-actions">
              {it.kind === 'open' && (
                <>
                  <button className="btn small" onClick={() => onDone(it.key)}>
                    已经处理了
                  </button>
                  <button className="link" onClick={() => onDone(it.key)}>
                    知道了
                  </button>
                </>
              )}
              {it.kind === 'notice' && (
                <>
                  <button className="btn small" onClick={() => onDone(it.key)}>
                    知道了
                  </button>
                  {it.segmentId && (
                    <button className="link" onClick={() => onAnswer(it)}>
                      说点什么…
                    </button>
                  )}
                </>
              )}
              {it.kind === 'question' && (
                <>
                  <button className="btn small primary" onClick={() => onAnswer(it)}>
                    回答…
                  </button>
                  <button className="link" onClick={() => onDone(it.key)}>
                    先不回答
                  </button>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </details>
  )
}
