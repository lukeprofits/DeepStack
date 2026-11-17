import { useLayoutEffect, useRef, useState } from 'react'
import type { SessionConfig } from '../../../shared/types'
import { displayName } from '../lib/session'
import { stack } from '../lib/port'
import { focusMainTerminal } from './Stage'

/**
 * The big terminal's title. Click to rename (the cursor lands where you clicked): in a Claude session the name is sent to
 * Claude as `/rename …` (so Claude owns it from then on); in a plain shell it's just saved.
 * The input is styled exactly like the title, so starting and finishing an edit doesn't jump.
 */
/** Which character of the title text a click landed on (null if it can't tell: end of text). */
function offsetAt(el: HTMLElement, x: number, y: number): number | null {
  const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }
  const pos = doc.caretPositionFromPoint?.(x, y)
  if (pos && el.contains(pos.offsetNode)) return pos.offset
  const range = document.caretRangeFromPoint?.(x, y)
  if (range && el.contains(range.startContainer)) return range.startOffset
  return null
}

export function HeaderTitle({ session }: { session: SessionConfig | undefined }) {
  const [draft, setDraft] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  /** Character offset the click landed on; the input's cursor starts there. */
  const caret = useRef<number | null>(null)
  const name = session ? displayName(session) : 'No session'

  // Switching sessions mid-edit drops the edit rather than renaming the wrong one.
  const editingId = useRef<string | null>(null)
  if (draft !== null && editingId.current !== session?.id) {
    editingId.current = null
    setDraft(null)
  }

  useLayoutEffect(() => {
    const el = input.current
    if (draft !== null && el) {
      el.focus()
      const at = Math.min(caret.current ?? el.value.length, el.value.length)
      el.setSelectionRange(at, at)
    }
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
        title={session ? 'Click to rename' : undefined}
        onClick={(e) => {
          if (!session) return
          caret.current = offsetAt(e.currentTarget, e.clientX, e.clientY)
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
