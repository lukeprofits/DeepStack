import { describe, expect, it } from 'vitest'
import { nextSession } from '../src/shared/advance'
import type { Phase, SessionConfig, SessionRuntime } from '../src/shared/types'

function session(id: string, inactive = false): SessionConfig {
  return { id, number: 1, color: '#fff', cwd: '/', inactive, queue: [] }
}

function rts(phases: Record<string, Phase>): Record<string, SessionRuntime> {
  return Object.fromEntries(Object.entries(phases).map(([id, phase]) => [id, { phase, unseen: false, claudeAlive: true, lastInputAt: 0 }]))
}

const S = [session('a'), session('b'), session('c'), session('d')]

describe('nextSession', () => {
  it('priority picks the topmost ready session other than the current one', () => {
    expect(nextSession(S, rts({ a: 'idle', b: 'busy', c: 'idle', d: 'idle' }), 'a', 'priority', false)).toBe('c')
    expect(nextSession(S, rts({ a: 'busy', b: 'idle', c: 'idle', d: 'idle' }), 'c', 'priority', false)).toBe('b')
  })

  it('priority with attentionFirst prefers a permission prompt', () => {
    expect(nextSession(S, rts({ a: 'busy', b: 'idle', c: 'attention', d: 'idle' }), 'a', 'priority', true)).toBe('c')
    expect(nextSession(S, rts({ a: 'busy', b: 'idle', c: 'attention', d: 'idle' }), 'a', 'priority', false)).toBe('b')
  })

  it('sequential walks down from the current session and wraps', () => {
    const rt = rts({ a: 'idle', b: 'busy', c: 'idle', d: 'busy' })
    expect(nextSession(S, rt, 'a', 'sequential', false)).toBe('c')
    expect(nextSession(S, rt, 'c', 'sequential', false)).toBe('a')
  })

  it('treats dormant sessions as ready (advancing resumes them)', () => {
    expect(nextSession(S, rts({ a: 'busy', b: 'dormant', c: 'busy', d: 'busy' }), 'a', 'priority', false)).toBe('b')
  })

  it('skips inactive, busy, starting and crashed sessions', () => {
    const list = [session('a'), session('b', true), session('c'), session('d')]
    expect(nextSession(list, rts({ a: 'busy', b: 'idle', c: 'starting', d: 'error' }), 'a', 'priority', false)).toBeNull()
  })

  it('returns null when everything else is busy, or when off', () => {
    expect(nextSession(S, rts({ a: 'idle', b: 'busy', c: 'busy', d: 'busy' }), 'a', 'priority', false)).toBeNull()
    expect(nextSession(S, rts({ a: 'idle', b: 'idle', c: 'idle', d: 'idle' }), 'a', 'off', false)).toBeNull()
  })
})
