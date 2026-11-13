// Mini terminals: each cell is three uint32 words: fg, bg, codepoint (0 = blank).
// fg/bg 0 means "nothing to draw" (blank fg / default bg). Otherwise the high byte tags the value.
// Snapshots saved before codepoints were added have two words per cell; use cellStride().

export const CELL_STRIDE = 3

export function cellStride(cells: Uint32Array, cols: number, rows: number): number {
  return cols && rows ? Math.round(cells.length / (cols * rows)) || CELL_STRIDE : CELL_STRIDE
}

export const CELL_RGB = 0x01000000
/** Non-blank glyph drawn in the theme's default foreground. */
export const CELL_DEFAULT_FG = 0x02000000

export function rgbCell(rgb: number): number {
  return (CELL_RGB | (rgb & 0xffffff)) >>> 0
}

export function isRgb(v: number): boolean {
  return (v & 0xff000000) >>> 0 === CELL_RGB
}

export function encodeCells(cells: Uint32Array): string {
  return Buffer.from(cells.buffer, cells.byteOffset, cells.byteLength).toString('base64')
}

export function decodeCellsBase64(b64: string): Uint32Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Uint32Array(bytes.buffer, 0, Math.floor(bytes.length / 4))
}

// xterm 256-color palette (0-15 come from the theme at draw time on the renderer
// side would be nicer, but snapshots must be self-contained, so we bake a neutral set).
const BASE16 = [
  0x1d1f21, 0xe06c75, 0x98c379, 0xe5c07b, 0x61afef, 0xc678dd, 0x56b6c2, 0xd7dae0,
  0x5c6370, 0xff7b86, 0xb5e890, 0xffd68a, 0x82c4ff, 0xde9bff, 0x7fd8e3, 0xffffff
]

export function paletteRgb(index: number): number {
  if (index < 16) return BASE16[index]
  if (index < 232) {
    const i = index - 16
    const steps = [0, 95, 135, 175, 215, 255]
    const r = steps[Math.floor(i / 36)]
    const g = steps[Math.floor(i / 6) % 6]
    const b = steps[i % 6]
    return (r << 16) | (g << 8) | b
  }
  const v = 8 + (index - 232) * 10
  return (v << 16) | (v << 8) | v
}

// Binary WebSocket frame for mini samples (JSON would triple the size):
// [0]=1 tag, [1..36]=session id (uuid ascii), [37..38]=cols u16, [39..40]=rows u16, [41..43] pad, [44..]=cells
const HEADER = 44

export function packMini(id: string, cols: number, rows: number, cells: Uint32Array): Uint8Array {
  const out = new Uint8Array(HEADER + cells.byteLength)
  out[0] = 1
  for (let i = 0; i < 36; i++) out[1 + i] = id.charCodeAt(i) || 0
  const view = new DataView(out.buffer)
  view.setUint16(37, cols, true)
  view.setUint16(39, rows, true)
  out.set(new Uint8Array(cells.buffer, cells.byteOffset, cells.byteLength), HEADER)
  return out
}

export function unpackMini(buf: ArrayBuffer): { id: string; cols: number; rows: number; cells: Uint32Array } | null {
  const bytes = new Uint8Array(buf)
  if (bytes[0] !== 1 || bytes.length < HEADER) return null
  const id = String.fromCharCode(...bytes.subarray(1, 37)).replace(/\0+$/, '')
  const view = new DataView(buf)
  const cols = view.getUint16(37, true)
  const rows = view.getUint16(39, true)
  return { id, cols, rows, cells: new Uint32Array(buf.slice(HEADER)) }
}
