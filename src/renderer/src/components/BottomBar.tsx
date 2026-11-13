import { useEffect, useRef } from 'react'
import type { QueueItem, Settings } from '../../../shared/types'

export type ComposerMode = 'hold' | 'edit' | null

interface Props {
  sessionId: string | null
  queue: QueueItem[]
  settings: Settings
  composerMode: ComposerMode
  composerText: string
  setComposerText: (t: string) => void
  onComposerSubmit: (text: string) => void
  onComposerClose: () => void
  onPill: (text: string) => void
  onBubble: (item: QueueItem, alt: boolean) => void
  onRemoveBubble: (item: QueueItem) => void
}

export function BottomBar(p: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (p.composerMode) inputRef.current?.focus()
  }, [p.composerMode])

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(160, el.scrollHeight)}px`
  }, [p.composerText, p.composerMode])

  return (
    <footer className="bottom-bar">
      {p.settings.pills.length > 0 && (
        <div className="presets">
          <span className="presets-label">Quick replies · one tap sends</span>
          <div className="pills">
            {p.settings.pills.map((text) => {
              // A trailing space marks a preset that loads into the input for finishing instead of sending.
              const loads = text.endsWith(' ')
              return (
                <button
                  key={text}
                  className="pill"
                  disabled={!p.sessionId}
                  onClick={() => p.onPill(text)}
                  title={loads ? `Load “${text.trim()}” into the input to finish` : `Send “${text}” now`}
                >
                  {text.trim()}
                  <span className="pill-icon" aria-hidden>
                    {loads ? '✎' : '↵'}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div className="queue">
        {p.composerMode && (
          <div className={`composer composer-${p.composerMode}`}>
            <textarea
              ref={inputRef}
              rows={1}
              value={p.composerText}
              placeholder={p.composerMode === 'hold' ? 'Queue a follow-up…  (Enter to add, Esc to close)' : 'Edit, then Enter to send'}
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
          </div>
        )}
        <div className="bubbles">
          {p.queue.map((q) => (
            <div key={q.id} className="bubble-row">
              <button
                className="bubble"
                onClick={(e) => p.onBubble(q, e.altKey)}
                title={`${p.settings.bubbleClick === 'load' ? 'Click to load into input' : 'Click to send'} · ⌥-click to ${p.settings.bubbleClick === 'load' ? 'send' : 'load'}`}
              >
                {q.text}
              </button>
              <button className="bubble-x" onClick={() => p.onRemoveBubble(q)} aria-label="Remove">
                ×
              </button>
            </div>
          ))}
        </div>
      </div>
    </footer>
  )
}
