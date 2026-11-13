import type { Phase, SessionRuntime } from './types'

// Status comes from three sources (verified against Claude Code 2.1):
//  - terminal title (OSC 0): "✳ <name>" when idle, a spinner glyph ("◐ <name>") when busy.
//    Instant, in-band, and the only signal that catches Esc interrupts (no Stop hook fires).
//  - hooks (via --settings): SessionStart gives the session id; Notification/PermissionRequest
//    tell us Claude is blocked on the human; UserPromptSubmit/Stop are precise busy/idle edges.
//  - the host's process poll: whether Claude is the shell's foreground program, which also
//    covers Claude launched by hand without hooks.
//  - pty exit.

export type StatusEvent =
  | { k: 'spawn'; resumingClaude: boolean }
  | { k: 'proc'; claude: boolean }
  | { k: 'hook'; name: string; payload: Record<string, unknown> }
  | { k: 'title'; title: string }
  | { k: 'input' }
  | { k: 'focus' }
  | { k: 'exit'; code: number; signal: number }
  | { k: 'hostCrash' }

export interface StatusResult {
  rt: SessionRuntime
  /** The focused session was just sent off to Claude: start the advance window. */
  sentOff: boolean
  claudeSid?: string
  autoName?: string
}

export interface StatusContext {
  focused: boolean
  now: number
}

/** Input this recent counts as "the human sent it" (vs. Claude resuming on its own). */
const SEND_WINDOW_MS = 15_000

const ATTENTION_TYPES = ['permission_prompt', 'elicitation_dialog', 'agent_needs_input', 'elicitation_url_dialog']

export function initialRuntime(dormant: boolean): SessionRuntime {
  return {
    phase: dormant ? 'dormant' : 'shell',
    unseen: false,
    claudeAlive: false,
    lastInputAt: 0
  }
}

export interface ParsedTitle {
  state: 'idle' | 'busy' | null
  name?: string
}

const IDLE_GLYPH = '✳'

export function parseTitle(title: string): ParsedTitle {
  const t = title.trim()
  const m = /^(\S)\s+(.+)$/u.exec(t)
  if (!m || /[\p{L}\p{N}]/u.test(m[1])) return { state: null }
  const name = m[2].trim()
  return {
    state: m[1] === IDLE_GLYPH ? 'idle' : 'busy',
    name: name && name !== 'Claude Code' ? name : undefined
  }
}

function notificationType(payload: Record<string, unknown>): string {
  const t = payload.notification_type
  if (typeof t === 'string') return t
  const msg = String(payload.message ?? '').toLowerCase()
  if (msg.includes('permission')) return 'permission_prompt'
  if (msg.includes('waiting for your input')) return 'idle_prompt'
  return 'unknown'
}

const WORKING: Phase[] = ['busy']
const CLAUDE_UP: Phase[] = ['starting', 'idle', 'busy', 'attention']

export function reduceStatus(rt: SessionRuntime, ev: StatusEvent, ctx: StatusContext): StatusResult {
  const prev = rt.phase
  let next: SessionRuntime = { ...rt }
  let claudeSid: string | undefined
  let autoName: string | undefined

  const set = (phase: Phase) => {
    next.phase = phase
  }

  switch (ev.k) {
    case 'spawn':
      next = { ...next, phase: ev.resumingClaude ? 'starting' : 'shell', error: undefined, claudeAlive: false }
      break

    case 'proc':
      if (ev.claude && !rt.claudeAlive) {
        next.claudeAlive = true
        if (prev === 'shell' || prev === 'starting') set('idle')
      } else if (!ev.claude && rt.claudeAlive) {
        next.claudeAlive = false
        if (CLAUDE_UP.includes(prev)) set('shell')
      }
      break

    case 'input':
      next.lastInputAt = ctx.now
      break

    case 'focus':
      next.unseen = false
      break

    case 'title': {
      if (!rt.claudeAlive && prev !== 'starting') break
      const p = parseTitle(ev.title)
      if (p.name) autoName = p.name
      if (p.state === 'busy') set('busy')
      else if (p.state === 'idle') {
        // A permission prompt keeps the idle glyph; only leave attention once the human responded.
        if (prev === 'attention') {
          if (rt.lastInputAt > (rt.attentionAt ?? 0)) set('idle')
        } else if (CLAUDE_UP.includes(prev)) set('idle')
      }
      break
    }

    case 'hook': {
      const p = ev.payload
      switch (ev.name) {
        case 'SessionStart':
          if (typeof p.session_id === 'string') claudeSid = p.session_id
          next.claudeAlive = true
          if (!['busy', 'attention'].includes(prev)) set('idle')
          break
        case 'UserPromptSubmit':
          set('busy')
          break
        case 'PermissionRequest':
          set('attention')
          break
        case 'Notification': {
          const type = notificationType(p)
          if (ATTENTION_TYPES.includes(type)) set('attention')
          else if (type === 'idle_prompt' && prev === 'busy') set('idle')
          break
        }
        case 'Stop':
        case 'StopFailure':
          if (prev === 'busy' || prev === 'attention') set('idle')
          break
        case 'SessionEnd':
          next.claudeAlive = false
          set('shell')
          break
      }
      break
    }

    case 'exit':
      next.claudeAlive = false
      if (ev.code === 0 && ev.signal === 0) set('exited')
      else {
        set('error')
        next.error = ev.signal ? `killed by signal ${ev.signal}` : `exited with code ${ev.code}`
      }
      break

    case 'hostCrash':
      next.claudeAlive = false
      set('error')
      next.error = 'terminal host crashed'
      break
  }

  if (next.phase === 'attention' && prev !== 'attention') next.attentionAt = ctx.now

  const finished = WORKING.includes(prev) && (next.phase === 'idle' || next.phase === 'attention')
  if (finished && !ctx.focused) next.unseen = true

  const sentOff =
    ctx.focused &&
    next.phase === 'busy' &&
    prev !== 'busy' &&
    ctx.now - rt.lastInputAt < SEND_WINDOW_MS

  return { rt: next, sentOff, claudeSid, autoName }
}
