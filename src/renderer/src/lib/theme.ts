import type { Theme } from '../../../shared/types'

export function applyTheme(theme: Theme): void {
  const r = document.documentElement.style
  const u = theme.ui
  r.setProperty('--bg', u.bg)
  r.setProperty('--sidebar', u.sidebar)
  r.setProperty('--panel', u.panel)
  r.setProperty('--border', u.border)
  r.setProperty('--text', u.text)
  r.setProperty('--muted', u.muted)
  r.setProperty('--accent', u.accent)
  r.setProperty('--bubble', u.bubble)
  r.setProperty('--bubble-text', u.bubbleText)
  r.setProperty('--pill', u.pill)
  r.setProperty('--pill-text', u.pillText)
  r.setProperty('--font', u.font)
  r.setProperty('--mono', u.monoFont)
  r.setProperty('--font-size', `${u.fontSize}px`)
  r.setProperty('--term-bg', theme.terminal.background)
  r.setProperty('--term-fg', theme.terminal.foreground)
  document.documentElement.dataset.crt = theme.crt ? 'on' : 'off'
}

export function sessionColor(theme: Theme, color: string): string {
  return theme.sessionColorOverride || color
}
