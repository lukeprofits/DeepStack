import { useEffect, useRef } from 'react'
import type { QueueItem, Settings } from '../../../shared/types'

/** hold: typed during a cancelled auto-switch · queue: "+ Add" · edit: long text loaded to finish. */
export type ComposerMode = 'hold' | 'queue' | 'edit' | null

interface Props {
  sessionId: string | null
  sessionName: string
  sessionColor: string
  queue: QueueItem[]
  settings: Settings
  composerMode: ComposerMode
  composerText: string
  setComposerText: (t: string) => void
  onComposerSubmit: (text: string) => void
  onComposerClose: () => void
  onOpenQueue: () => void
  /** Opens Settings → Quick replies. */
  onEditReplies: () => void
  onPill: (text: string) => void
  onBubble: (item: QueueItem, alt: boolean) => void
  onSendQueued: (item: QueueItem) => void
  onLoadQueued: (item: QueueItem) => void
  onRemoveBubble: (item: QueueItem) => void
}

const BoltIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M13 2.5 4.5 13.5H12l-1 8 8.5-11H12z" />
  </svg>
)

const QueueIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 6h11M4 12h11M4 18h7" />
    <path d="M18 15v6M15 18h6" />
  </svg>
)

const SendIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M20 5v7a3 3 0 0 1-3 3H5" />
    <path d="m9 11-4 4 4 4" />
  </svg>
)

const EditIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" />
  </svg>
)

const XIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
)

/** Shown with a capital first letter; sent exactly as written. */
const label = (t: string) => t.trim().charAt(0).toUpperCase() + t.trim().slice(1)

function QuickReplies({ settings, disabled, onPill, onEdit }: { settings: Settings; disabled: boolean; onPill: (t: string) => void; onEdit: () => void }) {
  return (
    <section className="bb-card bb-replies">
      <header className="bb-head">
        <span className="bb-icon">
          <BoltIcon />
        </span>
        <span className="bb-title">Quick replies</span>
        <span className="bb-hint">one tap sends</span>
        <button className="bb-add" onClick={onEdit} title="Add or edit quick replies in Settings">
          + Add
        </button>
      </header>
      {settings.pills.length > 0 ? (
        <div className="pills">
          {settings.pills.map((text) => {
            // A trailing space marks a preset that loads into the input for finishing instead of sending.
            const loads = /[\s:]$/.test(text)
            return (
              <button
                key={text}
                className="pill"
                disabled={disabled}
                onClick={() => onPill(text)}
                title={loads ? `Load “${text.trim()}” into the input to finish` : `Send “${text}” now`}
              >
                {label(text)}
                <span className="pill-icon" aria-hidden>
                  {loads ? '✎' : '↵'}
                </span>
              </button>
            )
          })}
        </div>
      ) : (
        <p className="bb-empty">No quick replies yet. Use + Add to make one-tap prompts you send often.</p>
      )}
    </section>
  )
}

function Composer(p: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [p.composerMode])
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(96, el.scrollHeight)}px`
  }, [p.composerText])

  const placeholder =
    p.composerMode === 'edit' ? 'Edit, then Enter to send · Esc to cancel' : 'Type a follow-up · Enter adds it · Esc closes'
  return (
    <div className={`bb-composer is-${p.composerMode}`}>
      <textarea
        ref={inputRef}
        rows={1}
        value={p.composerText}
        placeholder={placeholder}
        onChange={(e) => p.setComposerText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            if (p.composerText.trim()) p.onComposerSubmit(p.composerText)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            p.onComposerClose()
          }
        }}
      />
      {p.composerMode === 'hold' && <span className="bb-chip">Auto-switch paused · ⌃⇧J resumes</span>}
    </div>
  )
}

function QueuePanel(p: Props) {
  const n = p.queue.length
  // No add button: clicking the open space in the card starts a new follow-up.
  const canAdd = !!p.sessionId && !p.composerMode
  return (
    <section className={`bb-card bb-queue ${p.sessionId ? '' : 'is-disabled'}`} style={{ ['--c' as string]: p.sessionColor }}>
      <header className="bb-head">
        <span className="bb-icon">
          <QueueIcon />
        </span>
        <span className="bb-title">
          Queued <span className="bb-for">for {p.sessionName}</span>
        </span>
        {n > 0 && <span className="bb-count">{n}</span>}
      </header>
      <div
        className={`bb-list ${canAdd ? 'is-addable' : ''}`}
        onClick={(e) => {
          if (canAdd && !(e.target as HTMLElement).closest('.bb-item, .bb-composer')) p.onOpenQueue()
        }}
      >
        {n === 0 && !p.composerMode && <p className="bb-empty">Nothing queued. Click here to line up a follow-up, then send it when the session is ready.</p>}
        {p.queue.map((q, i) => (
          <div key={q.id} className="bb-item" title={q.text}>
            <span className="bb-item-n">{i + 1}</span>
            <span className="bb-item-text">{q.text}</span>
            {/* On hover the row splits into thirds: send · edit · delete. */}
            <span className="bb-item-zones">
              <button onClick={() => p.onSendQueued(q)} aria-label="Send now">
                <SendIcon />
                Send
              </button>
              <button onClick={() => p.onLoadQueued(q)} aria-label="Edit">
                <EditIcon />
                Edit
              </button>
              <button className="is-remove" onClick={() => p.onRemoveBubble(q)} aria-label="Delete">
                <XIcon />
                Delete
              </button>
            </span>
          </div>
        ))}
        {n > 0 && canAdd && (
          <button className="bb-new" onClick={p.onOpenQueue}>
            + Queue another
          </button>
        )}
        {p.composerMode && <Composer {...p} />}
      </div>
    </section>
  )
}

export function BottomBar(p: Props) {
  return (
    <footer className="bottom-bar">
      <QuickReplies settings={p.settings} disabled={!p.sessionId} onPill={p.onPill} onEdit={p.onEditReplies} />
      <QueuePanel {...p} />
    </footer>
  )
}
