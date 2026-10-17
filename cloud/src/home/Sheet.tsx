import { useEffect, type ReactNode } from 'react'

/** 弹层（V2 风格）：点背景或按 Esc 关闭 */
export function Sheet({
  title,
  description,
  onClose,
  children,
  wide = false,
}: {
  title: string
  description?: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="h-backdrop" onClick={onClose}>
      <div
        className={`h-sheet ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-sheet-head">
          <h2>{title}</h2>
          <button className="h-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        {description && <p className="h-description">{description}</p>}
        {children}
      </div>
    </div>
  )
}
