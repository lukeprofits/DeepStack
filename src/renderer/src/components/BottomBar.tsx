import { useEffect, useRef } from 'react'
import type { QueueItem, Settings } from '../../../shared/types'
import { CloseArm } from './controls'

/**
 * What the Queued input is doing. queue: a new follow-up · hold: typed during a cancelled
 * auto-switch (also queues) · edit: long text loaded to finish, Enter sends it to Claude ·
 * revise: rewriting a queued message in place. null: idle (one line, list showing).
 */
export type ComposerMode = 'hold' | 'queue' | 'edit' | 'revise' | null

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
  /** Load a queued message into the input to rewrite it in place. */
  onRevise: (item: QueueItem) => void
  /** The queued message being revised, if any. */
  reviseId: string | null
  onRemoveBubble: (item: QueueItem) => void
}

const BoltIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M13 2.5 4.5 13.5H12l-1 8 8.5-11H12z" />
  </svg>
)

const PlusIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

const QueueIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 6h11M4 12h11M4 18h7" />
    <path d="M18 15v6M15 18h6" />
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
        <span className="bb-title">
          Quick replies <span className="bb-for">one tap sends</span>
        </span>
      </header>
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
            </button>
          )
        })}
        {/* Last in the row, same shape as a reply: opens Settings → Quick replies. */}
        <button className="pill pill-add" onClick={onEdit} title="Add or edit quick replies in Settings">
          <PlusIcon />
          {settings.pills.length ? 'Add new' : 'Add a quick reply'}
        </button>
      </div>
    </section>
  )
}

/**
 * The Queued card's input: always there at the top, styled like Claude Code's own prompt so it
 * reads as "type here". Enter queues (it stays open for the next one); while you type it grows
 * to fill the card. Esc clears it and goes back to the terminal.
 */
function QueueInput(p: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const open = !!p.composerMode
  // Opened from elsewhere (Space during a send-off, Revise, a long quick reply): take focus.
  useEffect(() => {
    if (p.composerMode) inputRef.current?.focus()
  }, [p.composerMode, p.reviseId])

  const reviseN = p.reviseId ? p.queue.findIndex((q) => q.id === p.reviseId) + 1 : 0
  const placeholder = !p.sessionId
    ? 'No session'
    : p.composerMode === 'edit'
      ? 'Finish it, then Enter sends it to Claude · Esc cancels'
      : p.composerMode === 'revise'
        ? 'Enter saves it back in its place · Esc leaves it as it was'
        : `Queue a follow-up for ${p.sessionName}`
  return (
    <div className={`bb-qinput is-${p.composerMode ?? 'idle'}`}>
      {(p.composerMode === 'revise' || p.composerMode === 'hold' || p.composerMode === 'edit') && (
        <div className="bb-qinput-tag">
          {p.composerMode === 'revise' ? `Revising #${reviseN}` : p.composerMode === 'hold' ? 'Auto-switch paused · ⌃⇧J resumes' : 'Finish, then send'}
        </div>
      )}
      <span className="bb-qinput-prompt" aria-hidden>
        &gt;
      </span>
      <textarea
        ref={inputRef}
        rows={1}
        value={open ? p.composerText : ''}
        placeholder={placeholder}
        disabled={!p.sessionId}
        spellCheck={false}
        aria-label="Queue a follow-up"
        onFocus={() => {
          if (!p.composerMode) p.onOpenQueue()
        }}
        onChange={(e) => p.setComposerText(e.target.value)}
        onKeyDown={(e) => {
          // Keep keys here: the app's shortcuts and the terminal shouldn't see them.
          e.stopPropagation()
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            if (p.composerText.trim() || p.composerMode === 'revise') p.onComposerSubmit(p.composerText)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            p.onComposerClose()
          }
        }}
      />
    </div>
  )
}

function QueuePanel(p: Props) {
  const n = p.queue.length
  return (
    <section
      className={`bb-card bb-queue ${p.sessionId ? '' : 'is-disabled'} ${p.composerMode ? 'is-typing' : ''}`}
      style={{ ['--c' as string]: p.sessionColor }}
    >
      <header className="bb-head">
        <span className="bb-icon">
          <QueueIcon />
        </span>
        <span className="bb-title">
          Queued <span className="bb-for">for {p.sessionName}</span>
        </span>
        {n > 0 && <span className="bb-count">{n}</span>}
      </header>
      <QueueInput {...p} />
      <div className="bb-list">
        {n === 0 && <p className="bb-empty">Nothing queued yet. Type above and press Enter; send it when the session is ready.</p>}
        {p.queue.map((q, i) => (
          <div key={q.id} className="bb-item" title={q.text}>
            <span className="bb-item-n">{i + 1}</span>
            <span className="bb-item-text">{q.text}</span>
            {/* On hover: most of the row is SEND NOW, a narrower part on the right is REVISE. */}
            <span className="bb-item-zones">
              <button className="bb-item-send" onClick={() => p.onSendQueued(q)} aria-label={`Send now: ${q.text}`}>
                <span className="bb-item-zone-label">SEND NOW</span>
              </button>
              <button className="bb-item-revise" onClick={() => p.onRevise(q)} aria-label={`Revise: ${q.text}`}>
                <span className="bb-item-zone-label">REVISE</span>
              </button>
            </span>
            <CloseArm label="Delete from the queue" onArmedClick={() => p.onRemoveBubble(q)} />
          </div>
        ))}
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
