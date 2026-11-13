import type { SessionConfig } from '../../../shared/types'

let home = ''
let order = new Map<string, number>()

export function setHome(h: string): void {
  home = h
}

/** Stack order (active sessions first, then inactive), used for the "Session N" fallback. */
export function setStackOrder(sessions: SessionConfig[]): void {
  const ids = [...sessions.filter((s) => !s.inactive), ...sessions.filter((s) => s.inactive)].map((s) => s.id)
  order = new Map(ids.map((id, i) => [id, i + 1]))
}

/** User name > Claude's session title > "Session N" by place in the stack. */
export function displayName(s: SessionConfig): string {
  if (s.name) return s.name
  if (s.autoName) return s.autoName
  return `Session ${stackPosition(s)}`
}

export function homeDir(): string {
  return home
}

/** 1-based depth in the stack (active first, then inactive). */
export function stackPosition(s: SessionConfig): number {
  return order.get(s.id) ?? s.number
}
