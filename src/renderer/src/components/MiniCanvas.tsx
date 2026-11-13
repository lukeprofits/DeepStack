import { useEffect, useRef } from 'react'
import { CELL_DEFAULT_FG, cellStride, decodeCellsBase64, isRgb } from '../../../shared/miniCodec'
import { getFrame, stack, subscribeFrame, type MiniFrame } from '../lib/port'

interface Props {
  id: string
  foreground: string
  fontFamily: string
  /** No live process: draw the last saved snapshot instead. */
  useSnapshot: boolean
}

const FRAME_MS = 200

/** Below this many device pixels per column glyphs are mush; draw blocks instead. */
const MIN_GLYPH_DEVICE_PX = 2.4

function hex(v: number): string {
  return `#${(v & 0xffffff).toString(16).padStart(6, '0')}`
}

/** Advance width of one monospace glyph per 1px of font size. */
const advanceCache = new Map<string, number>()
function advanceRatio(ctx: CanvasRenderingContext2D, fontFamily: string): number {
  let r = advanceCache.get(fontFamily)
  if (r === undefined) {
    ctx.font = `100px ${fontFamily}`
    r = ctx.measureText('M').width / 100 || 0.6
    advanceCache.set(fontFamily, r)
  }
  return r
}

/**
 * A thumbnail of a terminal: the whole screen at one uniform scale, real glyphs in their
 * colours at device resolution. Old snapshots without codepoints (and screens too small to
 * draw glyphs) fall back to minimap blocks.
 */
function draw(canvas: HTMLCanvasElement, frame: MiniFrame, fg: string, fontFamily: string): void {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (!w || !h) return
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const { cols, rows, cells } = frame
  if (!cols || !rows) return
  const stride = cellStride(cells, cols, rows)
  // The whole screen at one uniform scale; the canvas already has the big terminal's shape.
  const cw = w / cols
  const ch = h / rows
  const visible = rows
  const first = 0
  const shownCols = cols
  const glyphs = stride >= 3 && cw * dpr >= MIN_GLYPH_DEVICE_PX

  if (glyphs) {
    // Size the font so one glyph advance is exactly one column.
    const px = Math.min(ch * 0.92, cw / advanceRatio(ctx, fontFamily))
    ctx.font = `${px}px ${fontFamily}`
    ctx.textBaseline = 'middle'
  }

  for (let r = 0; r < visible; r++) {
    const y = r * ch
    const base = (first + r) * cols * stride
    // Backgrounds, run-length merged.
    let x = 0
    while (x < shownCols) {
      const bg = cells[base + x * stride + 1]
      let end = x + 1
      while (end < shownCols && cells[base + end * stride + 1] === bg) end++
      if (bg && isRgb(bg)) {
        ctx.globalAlpha = 0.5
        ctx.fillStyle = hex(bg)
        ctx.fillRect(x * cw, y, (end - x) * cw, ch)
      }
      x = end
    }

    if (glyphs) {
      // Text runs of one colour; blanks inside a run ride along as spaces.
      x = 0
      while (x < shownCols) {
        const v = cells[base + x * stride]
        if (!v) {
          x++
          continue
        }
        let text = ''
        let end = x
        let lastInk = x
        while (end < shownCols) {
          const f = cells[base + end * stride]
          if (f && f !== v) break
          const cp = cells[base + end * stride + 2]
          text += f && cp ? String.fromCodePoint(cp) : ' '
          if (f) lastInk = end
          end++
        }
        ctx.globalAlpha = v === CELL_DEFAULT_FG ? 0.85 : 1
        ctx.fillStyle = v === CELL_DEFAULT_FG ? fg : hex(v)
        ctx.fillText(text.slice(0, lastInk - x + 1), x * cw, y + ch / 2)
        x = lastInk + 1
      }
    } else {
      const glyphH = ch * 0.55
      const glyphY = (ch - glyphH) / 2
      x = 0
      while (x < shownCols) {
        const v = cells[base + x * stride]
        let end = x + 1
        while (end < shownCols && cells[base + end * stride] === v) end++
        if (v) {
          ctx.globalAlpha = v === CELL_DEFAULT_FG ? 0.55 : 0.9
          ctx.fillStyle = v === CELL_DEFAULT_FG ? fg : hex(v)
          ctx.fillRect(x * cw, y + glyphY, (end - x) * cw - Math.min(0.4, cw * 0.2), glyphH)
        }
        x = end
      }
    }
  }
  ctx.globalAlpha = 1
}

export function MiniCanvas({ id, foreground, fontFamily, useSnapshot }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    let frame: MiniFrame | undefined = useSnapshot ? undefined : getFrame(id)
    let pending = false
    let last = 0
    let cancelled = false

    const paint = () => {
      pending = false
      last = performance.now()
      if (frame && !cancelled) draw(canvas, frame, foreground, fontFamily)
    }
    const schedule = () => {
      if (pending) return
      pending = true
      const wait = Math.max(0, FRAME_MS - (performance.now() - last))
      setTimeout(() => requestAnimationFrame(paint), wait)
    }

    let unsub = () => {}
    if (useSnapshot) {
      void stack.getSnapshot(id).then((snap) => {
        if (!snap || cancelled) return
        frame = { cols: snap.cols, rows: snap.rows, cells: decodeCellsBase64(snap.cells) }
        schedule()
      })
    } else {
      unsub = subscribeFrame(id, () => {
        frame = getFrame(id)
        schedule()
      })
    }
    const ro = new ResizeObserver(schedule)
    ro.observe(canvas)
    schedule()
    // Webfonts may arrive after the first paint.
    void document.fonts?.ready.then(() => !cancelled && schedule())
    return () => {
      cancelled = true
      unsub()
      ro.disconnect()
    }
  }, [id, foreground, fontFamily, useSnapshot])

  return <canvas ref={ref} className="mini-canvas" />
}
