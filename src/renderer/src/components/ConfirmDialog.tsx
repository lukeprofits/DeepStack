import { useEffect, type ReactNode } from 'react'

interface Props {
  title: ReactNode
  body: ReactNode
  /** Optional identity row (the session being acted on). */
  identity?: { color: string; n: number | string; title: string; sub?: string }
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Centred, on-brand "are you sure". Enter confirms (the confirm button has focus), Esc or a
 * click on the backdrop cancels. Destructive by design: the confirm button is red.
 */
export function ConfirmDialog({ title, body, identity, confirmLabel, onConfirm, onCancel }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  return (
    <div className="cd-backdrop" onMouseDown={onCancel}>
      <div className="cd-card" role="alertdialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        {identity && (
          <div className="cd-identity" style={{ ['--c' as string]: identity.color }}>
            <span className="cd-badge">{identity.n}</span>
            <div className="cd-identity-text">
              <div className="cd-identity-title">{identity.title}</div>
              {identity.sub && <div className="cd-identity-sub">{identity.sub}</div>}
            </div>
          </div>
        )}
        <h2 className="cd-title">{title}</h2>
        <p className="cd-body">{body}</p>
        <div className="cd-actions">
          <button className="cd-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button className="cd-confirm" autoFocus onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
