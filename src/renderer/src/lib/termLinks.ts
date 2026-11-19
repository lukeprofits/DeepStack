import type { IBuffer, IBufferCellPosition, ILink, Terminal } from '@xterm/xterm'

/**
 * Clickable URLs in a terminal. xterm asks this provider for the links on a row and handles the
 * hover and click; a click opens the link in the browser (the standalone window hands
 * window.open to the system browser, see electron/main.ts). A thin overlay underlines every link
 * on screen all the time (xterm only underlines on hover), and in Hacker a hovered link
 * glitches with a red/cyan split.
 *
 * A URL can span rows two ways: the terminal soft-wrapped it (isWrapped), or the program broke it
 * with a real newline at its width, as Claude Code does when it re-draws after a resize. The
 * second is joined when the URL runs to the last column and the next row carries on at the same
 * indent.
 */
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/g
const URL_CH = /[^\s<>"'`]/
// Trailing punctuation that usually ends the sentence, not the URL.
const TRAIL = /[.,;:!?]+$/
/** How many rows up a broken URL is followed. */
const MAX_JOIN = 8

export function openLink(url: string): void {
  window.open(url, '_blank', 'noopener')
}

interface Cell {
  ch: string
  x: number
}
interface Found {
  text: string
  /** The cell each character of the link starts in (1-based, like xterm). */
  cells: IBufferCellPosition[]
}

function cellsOf(buf: IBuffer, row: number): Cell[] | null {
  const line = buf.getLine(row)
  if (!line) return null
  const out: Cell[] = []
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x)
    if (!cell || cell.getWidth() === 0) continue
    out.push({ ch: cell.getChars() || ' ', x })
  }
  return out
}
const indentOf = (c: Cell[]) => {
  let n = 0
  while (n < c.length && c[n].ch === ' ') n++
  return n
}
/** Cells up to the last non-blank one. */
const trimEnd = (c: Cell[]) => {
  let n = c.length
  while (n > 0 && c[n - 1].ch === ' ') n--
  return c.slice(0, n)
}
/** The URL-ish characters the row's text ends with. */
const tailOf = (c: Cell[]) => {
  let i = c.length
  while (i > 0 && URL_CH.test(c[i - 1].ch)) i--
  return c
    .slice(i)
    .map((k) => k.ch)
    .join('')
}
/** How close to the right edge a broken URL row must end (programs keep a small margin). */
const EDGE = 16
/** Characters a program breaks a long URL at, so one of them sits either side of the break. */
const BREAK_END = /[/\-_?&=#.%~+:]$/
const BREAK_START = /^[/\-_?&=#.%~+]/

/** Does `row` carry on the previous row's text? 'wrap' (terminal), 'break' (program), or no. */
function joins(buf: IBuffer, row: number, depth = 0): 'wrap' | 'break' | null {
  if (row <= 0) return null
  if (buf.getLine(row)?.isWrapped) return 'wrap'
  if (depth > MAX_JOIN) return null
  const full = cellsOf(buf, row - 1)
  const b = cellsOf(buf, row)
  if (!full || !b) return null
  const a = trimEnd(full)
  const tail = tailOf(a)
  const ind = indentOf(b)
  if (!tail || ind !== indentOf(a) || !b[ind] || !URL_CH.test(b[ind].ch)) return null
  // It must end near the edge: at the last column, or (inside a margin) at a URL-style break,
  // like "…/blob" + "/main/…". A prose word starting the next row isn't taken as more URL.
  const room = full.length - a.length
  const next = b.slice(ind).map((k) => k.ch).join('')
  if (room > 0 && !(room <= EDGE && (BREAK_END.test(tail) || BREAK_START.test(next)))) return null
  if (tail.includes('://')) return 'break'
  // The previous row is itself only URL (a middle piece): it must carry on from above.
  if (tail.length !== a.length - indentOf(a)) return null
  return joins(buf, row - 1, depth + 1) ? 'break' : null
}

/** The links in the logical line that `row` (0-based) belongs to, and that line's last row. */
function linksAt(buf: IBuffer, row: number): { links: Found[]; first: number; last: number } {
  let first = row
  while (first > 0 && row - first < MAX_JOIN && joins(buf, first)) first--
  let last = row
  while (last - row < MAX_JOIN && buf.getLine(last + 1) && joins(buf, last + 1)) last++
  let text = ''
  const at: IBufferCellPosition[] = []
  for (let r = first; r <= last; r++) {
    let cells = cellsOf(buf, r)
    if (!cells) break
    const skip = r > first && joins(buf, r) === 'break' ? indentOf(cells) : 0
    // A row the next one carries on from by a program break: its margin isn't part of the text.
    if (r < last && joins(buf, r + 1) === 'break') cells = trimEnd(cells)
    for (const c of cells.slice(skip)) {
      for (let k = 0; k < c.ch.length; k++) at.push({ x: c.x + 1, y: r + 1 })
      text += c.ch
    }
  }
  const links: Found[] = []
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0].replace(TRAIL, '')
    // Drop a closing bracket the URL didn't open, as in "(see https://x.y/z)".
    for (const [o, c] of [['(', ')'], ['[', ']']] as const) {
      while (url.endsWith(c) && url.split(o).length < url.split(c).length) url = url.slice(0, -1)
    }
    const cells = at.slice(m.index!, m.index! + url.length)
    if (cells.length === url.length) links.push({ text: url, cells })
  }
  return { links, first, last }
}

export function attachLinks(term: Terminal): { dispose(): void } {
  // OSC 8 hyperlinks (text that names its own link): open them without xterm's confirm prompt.
  term.options.linkHandler = { activate: (_e, uri) => openLink(uri), allowNonHttpProtocols: false }
  const overlay = linkOverlay(term)
  const provider = term.registerLinkProvider({
    provideLinks(y, done) {
      const { links } = linksAt(term.buffer.active, y - 1)
      const out: ILink[] = links
        .filter((l) => l.cells[0].y <= y && l.cells[l.cells.length - 1].y >= y)
        .map((l) => ({
          text: l.text,
          range: { start: l.cells[0], end: l.cells[l.cells.length - 1] },
          // The overlay draws the underline, always on; xterm just gives the pointer.
          decorations: { underline: false, pointerCursor: true },
          activate: () => openLink(l.text),
          hover: () => overlay?.hover(l),
          leave: () => overlay?.leave()
        }))
      done(out.length ? out : undefined)
    }
  })
  return {
    dispose() {
      provider.dispose()
      overlay?.dispose()
    }
  }
}

/** Always-on underlines for the links on screen, and the hover glitch. */
function linkOverlay(term: Terminal) {
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
  if (!screen) return null
  const layer = document.createElement('div')
  layer.className = 'term-links'
  screen.appendChild(layer)
  // Underlines get their own box: redrawing them must not wipe a glitch in progress.
  const lines = document.createElement('div')
  layer.appendChild(lines)
  let hot = ''
  let key = ''
  let raf = 0
  const cell = () => ({ w: screen.clientWidth / term.cols, h: screen.clientHeight / term.rows })

  function draw(): void {
    raf = 0
    const buf = term.buffer.active
    const top = buf.viewportY
    const { w, h } = cell()
    const segs: { x: number; y: number; n: number; hot: boolean }[] = []
    for (let r = top; r < top + term.rows; ) {
      const { links, last } = linksAt(buf, r)
      for (const l of links) {
        const rows = new Map<number, [number, number]>()
        for (const c of l.cells) {
          const s = rows.get(c.y)
          rows.set(c.y, s ? [Math.min(s[0], c.x), Math.max(s[1], c.x)] : [c.x, c.x])
        }
        for (const [y, [x0, x1]] of rows) {
          if (y - 1 < top || y - 1 >= top + term.rows) continue
          segs.push({ x: x0 - 1, y: y - 1 - top, n: x1 - x0 + 1, hot: l.text === hot })
        }
      }
      r = Math.max(r + 1, last + 1)
    }
    const k = `${w.toFixed(2)}|${h.toFixed(2)}|` + segs.map((s) => `${s.x},${s.y},${s.n},${+s.hot}`).join(';')
    if (k === key) return
    key = k
    lines.replaceChildren(
      ...segs.map((s) => {
        const d = document.createElement('div')
        d.className = s.hot ? 'term-link-line is-hot' : 'term-link-line'
        Object.assign(d.style, { left: `${s.x * w}px`, top: `${(s.y + 1) * h - 2}px`, width: `${s.n * w}px` })
        return d
      })
    )
  }
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(draw)
  }
  const subs = [term.onRender(schedule), term.onScroll(schedule), term.onResize(schedule)]
  schedule()

  /** Hacker: red and cyan copies of the link's letters tear and jitter for a moment. */
  function glitch(l: Found): void {
    if (document.documentElement.dataset.fx !== 'matrix') return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    layer.querySelector('.term-link-glitch')?.remove()
    const { w, h } = cell()
    const top = term.buffer.active.viewportY
    const box = document.createElement('div')
    box.className = 'term-link-glitch'
    const font = `${term.options.fontSize ?? 13}px ${term.options.fontFamily ?? 'monospace'}`
    const copies = (['is-r', 'is-c'] as const).map((tint) => {
      const c = document.createElement('div')
      c.className = `term-link-copy ${tint}`
      l.text.split('').forEach((ch, i) => {
        const p = l.cells[i]
        const s = document.createElement('span')
        s.textContent = ch
        Object.assign(s.style, { left: `${(p.x - 1) * w}px`, top: `${(p.y - 1 - top) * h}px`, width: `${w}px`, height: `${h}px`, lineHeight: `${h}px`, font })
        c.appendChild(s)
      })
      box.appendChild(c)
      return c
    })
    layer.appendChild(box)
    const rnd = (a: number, b: number) => a + Math.random() * (b - a)
    const frames = 3 + Math.floor(Math.random() * 3)
    const step = rnd(45, 75)
    for (let f = 0; f <= frames; f++) {
      window.setTimeout(() => {
        if (f === frames) return box.remove()
        const d = rnd(1.5, 4) * (Math.random() < 0.5 ? -1 : 1) * (1 - f / (frames + 1))
        copies.forEach((c, k) => {
          const tear = Math.random() < 0.4
          const t = rnd(0, 70)
          c.style.transform = `translate(${(k ? -d : d).toFixed(1)}px, ${Math.random() < 0.2 ? rnd(-1, 1).toFixed(1) : 0}px)`
          c.style.clipPath = tear ? `inset(${t.toFixed(0)}% 0 ${(100 - t - rnd(15, 30)).toFixed(0)}% 0)` : ''
        })
      }, f * step)
    }
  }

  return {
    hover(l: Found) {
      hot = l.text
      key = ''
      schedule()
      glitch(l)
    },
    leave() {
      hot = ''
      key = ''
      schedule()
    },
    dispose() {
      cancelAnimationFrame(raf)
      subs.forEach((s) => s.dispose())
      layer.remove()
    }
  }
}
