import { useState } from 'react'
import type { HomeContext, Memory } from '../memory/types'
import { Sheet } from './Sheet'
import { SentenceBox } from './PlansSheet'
import { useSentenceDraft } from './useSentenceDraft'

/** 一条记忆：直接改文字；开关；删除（再点一次确认）。内置的预设提醒（如摔倒）只能开关 */
function MemoryCard({ memory, onSave, onToggle, onDelete }: {
  memory: Memory
  onSave: (text: string) => void
  onToggle: () => void
  onDelete: () => void
}) {
  const [text, setText] = useState(memory.text)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const builtIn = !!memory.rule
  return (
    <div className={`h-card ${memory.enabled ? '' : 'off'}`}>
      <div className="h-card-head">
        <span className="h-pill">{builtIn ? '预设提醒' : '习惯'}</span>
        <span className="h-muted">{memory.enabled ? '生效中' : '已停用'}</span>
      </div>
      {builtIn ? (
        <p className="h-card-text">{memory.text}</p>
      ) : (
        <label>
          Homi 的理解
          <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
      )}
      <div className="h-actions">
        {!builtIn && text.trim() && text !== memory.text && (
          <button className="h-primary" onClick={() => onSave(text.trim())}>
            保存修改
          </button>
        )}
        <button className="h-secondary" onClick={onToggle}>
          {memory.enabled ? '停用' : '启用'}
        </button>
        {!builtIn &&
          (confirmDelete ? (
            <>
              <button className="h-danger" onClick={onDelete}>
                确定删除
              </button>
              <button className="h-secondary" onClick={() => setConfirmDelete(false)}>
                不删了
              </button>
            </>
          ) : (
            <button className="h-link" onClick={() => setConfirmDelete(true)}>
              删除
            </button>
          ))}
      </div>
    </div>
  )
}

/** 长期记忆弹层（V2：看看 Homi 怎样理解你的习惯，不准确的地方随时改） */
export function MemoriesSheet({ ctx, onChange, onClose }: { ctx: HomeContext; onChange: (next: HomeContext) => void; onClose: () => void }) {
  const [input, setInput] = useState('')
  const sentence = useSentenceDraft(ctx, (next) => {
    onChange(next)
    setInput('')
  })
  const patch = (id: string, p: Partial<Memory>) =>
    onChange({ ...ctx, memories: ctx.memories.map((m) => (m.id === id ? { ...m, ...p } : m)) })
  return (
    <Sheet title="长期记忆" description="看看 Homi 怎样理解你家的习惯，不准确的地方随时改。" onClose={onClose}>
      {ctx.memories.map((m) => (
        <MemoryCard
          key={m.id}
          memory={m}
          onSave={(text) => patch(m.id, { text })}
          onToggle={() => patch(m.id, { enabled: !m.enabled })}
          onDelete={() => onChange({ ...ctx, memories: ctx.memories.filter((x) => x.id !== m.id) })}
        />
      ))}
      <SentenceBox
        placeholder="用一句话新增，如：家里的猫会在客厅走动，不用提醒"
        input={input}
        setInput={setInput}
        sentence={sentence}
      />
    </Sheet>
  )
}
