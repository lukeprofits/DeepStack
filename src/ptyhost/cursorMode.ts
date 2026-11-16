import type { Terminal } from '@xterm/headless'

/**
 * Escape sequence restoring cursor visibility, which @xterm/addon-serialize leaves out. Claude
 * Code hides the real cursor (it draws its own); without this a rebuilt screen shows xterm's
 * cursor, usually as a stray hollow box at the top-left, until the app happens to redraw.
 * xterm exposes the flag only internally (coreService.isCursorHidden).
 */
export function cursorModeSuffix(term: Terminal): string {
  const core = (term as unknown as { _core?: { coreService?: { isCursorHidden?: boolean }; coreMouseService?: { activeEncoding?: string } } })._core
  let out = core?.coreService?.isCursorHidden ? '\x1b[?25l' : ''
  // The serializer restores mouse tracking but not its encoding. Claude asks for SGR (1006); a
  // rebuilt screen without it would report the wheel in the old X10 format.
  const enc = core?.coreMouseService?.activeEncoding
  if (enc === 'SGR') out += '\x1b[?1006h'
  else if (enc === 'SGR_PIXELS') out += '\x1b[?1016h'
  return out
}
