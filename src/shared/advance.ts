import type { AdvanceMode, Phase, SessionConfig, SessionRuntime } from './types'

const READY: Phase[] = ['idle', 'attention', 'dormant', 'shell']

export function isEligible(s: SessionConfig, rt: SessionRuntime | undefined): boolean {
  if (s.inactive) return false
  // Quiet while its own background task runs: not ready for you (see SessionRuntime.background).
  if (rt?.phase === 'idle' && rt.background) return false
  return READY.includes(rt?.phase ?? 'dormant')
}

/**
 * Next session to focus after the current one is sent off.
 * Returns null when nothing else is ready (caller stays put).
 */
export function nextSession(
  sessions: SessionConfig[],
  runtime: Record<string, SessionRuntime>,
  currentId: string | null,
  mode: AdvanceMode,
  attentionFirst: boolean
): string | null {
  if (mode === 'off') return null
  const active = sessions.filter((s) => !s.inactive)
  const candidates = active.filter((s) => s.id !== currentId && isEligible(s, runtime[s.id]))
  if (candidates.length === 0) return null

  if (mode === 'priority') {
    if (attentionFirst) {
      // The one that has been waiting longest goes first.
      const waiting = candidates
        .filter((s) => runtime[s.id]?.phase === 'attention')
        .sort((a, b) => (runtime[a.id]?.attentionAt ?? 0) - (runtime[b.id]?.attentionAt ?? 0))[0]
      if (waiting) return waiting.id
    }
    return candidates[0].id
  }

  // sequential: walk down from the current position, wrapping around
  const start = active.findIndex((s) => s.id === currentId)
  for (let step = 1; step <= active.length; step++) {
    const s = active[(start + step + active.length) % active.length]
    if (s.id !== currentId && isEligible(s, runtime[s.id])) return s.id
  }
  return null
}
