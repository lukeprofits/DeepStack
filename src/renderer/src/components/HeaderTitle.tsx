import { useLayoutEffect, useRef, useState } from 'react'
import type { SessionConfig } from '../../../shared/types'
import { displayName } from '../lib/session'
import { stack } from '../lib/port'
import { focusMainTerminal } from './Stage'

/**
 * The big terminal's title. Double-click to rename: in a Claude session the name is sent to
 * Claude as `/rename …` (so Claude owns it from then on); in a plain shell it's just saved.
 * The input is styled exactly like the title, so starting and finishing an edit doesn't jump.
 */
export function HeaderTitle({ session }: { session: SessionConfig | undefined }) {
  const [draft, setDraft] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const name = session ? displayName(session) : 'No session'

  // Switching sessions mid-edit drops the edit rather than renaming the wrong one.
  const editingId = useRef<string | null>(null)
  if (draft !== null && editingId.current !== session?.id) {
    editingId.current = null
    setDraft(null)
  }

  useLayoutEffect(() => {
    if (draft !== null) input.current?.select()
    // Only when editing starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft !== null])

  const finish = (save: boolean) => {
    const id = editingId.current
    if (!id) return
    const text = (input.current?.value ?? '').replace(/\s+/g, ' ').trim()
    editingId.current = null
    setDraft(null)
    if (save && id && text && text !== name) void stack.intent({ t: 'retitle', id, name: text })
    focusMainTerminal()
  }

  if (draft === null || !session) {
    return (
      <span
        className={`header-title ${session ? 'is-renamable' : ''}`}
        title={session ? 'Double-click to rename' : undefined}
        onDoubleClick={() => {
          if (!session) return
          window.getSelection()?.removeAllRanges()
          editingId.current = session.id
          setDraft(name)
        }}
      >
        {name}
      </span>
    )
  }

  return (
    <input
      ref={input}
      className="header-title header-title-input"
      value={draft}
      maxLength={120}
      spellCheck={false}
      aria-label="Session name"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        // Keep keys here: the app's shortcuts and the terminal shouldn't see them.
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(false)
        }
      }}
    />
  )
}
