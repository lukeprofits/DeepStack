import { describe, expect, it } from 'vitest'
import { initialRuntime, parseTitle, reduceStatus, type StatusEvent } from '../src/shared/sessionStatus'
import type { SessionRuntime } from '../src/shared/types'

const focused = { focused: true, now: 10_000 }
const background = { focused: false, now: 10_000 }

function run(rt: SessionRuntime, events: StatusEvent[], ctx = focused) {
  let r = { rt, sentOff: false } as ReturnType<typeof reduceStatus>
  for (const e of events) r = reduceStatus(r.rt, e, ctx)
  return r
}

const started = () => run(initialRuntime(true), [{ k: 'spawn', resumingClaude: true }, { k: 'hook', name: 'SessionStart', payload: { session_id: 's1', source: 'startup' } }]).rt

describe('parseTitle', () => {
  it('reads Claude Code title glyphs', () => {
    expect(parseTitle('✳ Claude Code')).toEqual({ state: 'idle', name: undefined })
    expect(parseTitle('◐ Fix login bug')).toEqual({ state: 'busy', name: 'Fix login bug' })
    expect(parseTitle('✳ Fix login bug').state).toBe('idle')
  })

  it('ignores ordinary shell titles', () => {
    expect(parseTitle('~/Projects/app').state).toBeNull()
    expect(parseTitle('zsh').state).toBeNull()
  })
})

describe('reduceStatus', () => {
  it('spawn -> starting -> idle on SessionStart, capturing the session id', () => {
    const r = run(initialRuntime(true), [{ k: 'spawn', resumingClaude: true }])
    expect(r.rt.phase).toBe('starting')
    const r2 = reduceStatus(r.rt, { k: 'hook', name: 'SessionStart', payload: { session_id: 'abc' } }, focused)
    expect(r2.rt.phase).toBe('idle')
    expect(r2.claudeSid).toBe('abc')
    expect(r2.rt.claudeAlive).toBe(true)
  })

  it('signals send-off when the focused session goes busy right after the human typed', () => {
    const typed = reduceStatus(started(), { k: 'input' }, { focused: true, now: 9_000 }).rt
    const r = reduceStatus(typed, { k: 'hook', name: 'UserPromptSubmit', payload: {} }, focused)
    expect(r.rt.phase).toBe('busy')
    expect(r.sentOff).toBe(true)
  })

  it('does not send off when Claude starts working without recent human input', () => {
    const r = reduceStatus(started(), { k: 'title', title: '◐ Something' }, { focused: true, now: 100_000 })
    expect(r.rt.phase).toBe('busy')
    expect(r.sentOff).toBe(false)
  })

  it('does not send off a background session', () => {
    const typed = reduceStatus(started(), { k: 'input' }, background).rt
    expect(reduceStatus(typed, { k: 'hook', name: 'UserPromptSubmit', payload: {} }, background).sentOff).toBe(false)
  })

  it('recovers to idle from the title after an Esc interrupt (no Stop hook)', () => {
    const busy = run(started(), [{ k: 'hook', name: 'UserPromptSubmit', payload: {} }]).rt
    expect(reduceStatus(busy, { k: 'title', title: '✳ Counting' }, focused).rt.phase).toBe('idle')
  })

  it('marks unseen when a background session finishes', () => {
    const busy = run(started(), [{ k: 'hook', name: 'UserPromptSubmit', payload: {} }], background).rt
    const done = reduceStatus(busy, { k: 'hook', name: 'Stop', payload: {} }, background)
    expect(done.rt.phase).toBe('idle')
    expect(done.rt.unseen).toBe(true)
    expect(reduceStatus(done.rt, { k: 'focus' }, focused).rt.unseen).toBe(false)
  })

  it('permission prompts put the session in attention until the human responds', () => {
    const busy = run(started(), [{ k: 'hook', name: 'UserPromptSubmit', payload: {} }]).rt
    const att = reduceStatus(busy, { k: 'hook', name: 'Notification', payload: { notification_type: 'permission_prompt' } }, { focused: true, now: 20_000 }).rt
    expect(att.phase).toBe('attention')
    // Idle glyph while the prompt is up keeps attention...
    expect(reduceStatus(att, { k: 'title', title: '✳ Task' }, { focused: true, now: 21_000 }).rt.phase).toBe('attention')
    // ...until the human typed something after the prompt appeared.
    const answered = reduceStatus(att, { k: 'input' }, { focused: true, now: 22_000 }).rt
    expect(reduceStatus(answered, { k: 'title', title: '✳ Task' }, { focused: true, now: 22_500 }).rt.phase).toBe('idle')
    // Approving the permission sends Claude back to work, which counts as a send-off.
    const back = reduceStatus(answered, { k: 'title', title: '◐ Task' }, { focused: true, now: 22_500 })
    expect(back.rt.phase).toBe('busy')
    expect(back.sentOff).toBe(true)
  })

  it('idle_prompt notifications do not raise attention', () => {
    expect(reduceStatus(started(), { k: 'hook', name: 'Notification', payload: { notification_type: 'idle_prompt' } }, focused).rt.phase).toBe('idle')
  })

  it('SessionEnd drops to the shell; exit codes map to exited/error', () => {
    expect(reduceStatus(started(), { k: 'hook', name: 'SessionEnd', payload: {} }, focused).rt.phase).toBe('shell')
    expect(reduceStatus(started(), { k: 'exit', code: 0, signal: 0 }, focused).rt.phase).toBe('exited')
    const crashed = reduceStatus(started(), { k: 'exit', code: 1, signal: 0 }, focused).rt
    expect(crashed.phase).toBe('error')
    expect(crashed.error).toContain('1')
  })

  it('ignores titles from a plain shell', () => {
    const shell = run(initialRuntime(false), [{ k: 'spawn', resumingClaude: false }]).rt
    expect(reduceStatus(shell, { k: 'title', title: '◐ looks like claude' }, focused).rt.phase).toBe('shell')
  })
})

describe('reduceStatus: Claude started by hand', () => {
  it('a shell becomes a Claude session when claude is in the foreground, and back when it exits', () => {
    const shell = run(initialRuntime(false), [{ k: 'spawn', resumingClaude: false }]).rt
    const up = reduceStatus(shell, { k: 'proc', claude: true }, focused).rt
    expect(up.phase).toBe('idle')
    expect(up.claudeAlive).toBe(true)
    expect(reduceStatus(up, { k: 'title', title: '◐ Working' }, focused).rt.phase).toBe('busy')
    expect(reduceStatus(up, { k: 'proc', claude: false }, focused).rt.phase).toBe('shell')
  })
})
