import { useState, type ReactNode } from 'react'

const KEY = 'porchlight-panels-open'

function loadOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
}

/**
 * 可折叠的侧栏面板：点标题展开 / 收起，状态记在本浏览器。
 * actions 放在标题右侧（如“恢复默认”），点它不会触发折叠。
 */
export function Panel({
  id,
  title,
  defaultOpen = true,
  actions,
  children,
}: {
  id: string
  title: ReactNode
  defaultOpen?: boolean
  actions?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(() => loadOpen()[id] ?? defaultOpen)
  const toggle = () => {
    const next = !open
    setOpen(next)
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...loadOpen(), [id]: next }))
    } catch {
      /* 记不住也不影响使用 */
    }
  }
  return (
    <section className={`panel ${open ? '' : 'panel-closed'}`}>
      <div className="panel-head">
        <button className="panel-toggle" onClick={toggle} aria-expanded={open}>
          <span className="chevron" aria-hidden>
            {open ? '▾' : '▸'}
          </span>
          <h2>{title}</h2>
        </button>
        {open && actions}
      </div>
      {open && children}
    </section>
  )
}
