import type { Terminal } from '@xterm/headless'

/**
 * Escape sequence restoring cursor visibility, which @xterm/addon-serialize leaves out. Claude
 * Code hides the real cursor (it draws its own); without this a rebuilt screen shows xterm's
 * cursor, usually as a stray hollow box at the top-left, until the app happens to redraw.
 * xterm exposes the flag only internally (coreService.isCursorHidden).
 */
export function cursorModeSuffix(term: Terminal): string {
  const core = (term as unknown as { _core?: { coreService?: { isCursorHidden?: boolean } } })._core
  return core?.coreService?.isCursorHidden ? '\x1b[?25l' : ''
}
