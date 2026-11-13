import type { IBufferCell, Terminal } from '@xterm/headless'
import { CELL_DEFAULT_FG, CELL_STRIDE, paletteRgb, rgbCell } from '../shared/miniCodec'

function colorOf(cell: IBufferCell, fg: boolean): number {
  if (fg ? cell.isFgRGB() : cell.isBgRGB()) return rgbCell(fg ? cell.getFgColor() : cell.getBgColor())
  if (fg ? cell.isFgPalette() : cell.isBgPalette()) return rgbCell(paletteRgb(fg ? cell.getFgColor() : cell.getBgColor()))
  return 0
}

/**
 * Encode the visible screen as [fg, bg, codepoint] uint32 triples per cell, row-major. The mini
 * is a true thumbnail of the big terminal: the whole screen, nothing picked or cropped, so every
 * mini has the same shape and scale and a switch is a pure shrink/grow.
 */
export function sampleMini(term: Terminal): { cols: number; rows: number; cells: Uint32Array } {
  const buf = term.buffer.active
  const cols = term.cols
  const rows = term.rows
  const cells = new Uint32Array(cols * rows * CELL_STRIDE)
  const cell = buf.getNullCell()
  for (let r = 0; r < rows; r++) {
    const line = buf.getLine(buf.baseY + r)
    if (!line) continue
    for (let x = 0; x < cols; x++) {
      if (!line.getCell(x, cell)) continue
      const i = (r * cols + x) * CELL_STRIDE
      const ch = cell.getChars()
      const inverse = cell.isInverse() !== 0
      let fg = ch && ch !== ' ' ? colorOf(cell, true) || CELL_DEFAULT_FG : 0
      let bg = colorOf(cell, false)
      if (inverse) {
        const f = fg
        fg = bg
        bg = f || CELL_DEFAULT_FG
      }
      cells[i] = fg
      cells[i + 1] = bg
      if (ch && ch !== ' ') cells[i + 2] = ch.codePointAt(0) ?? 0
    }
  }
  return { cols, rows, cells }
}
