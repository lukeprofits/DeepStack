import { useLayoutEffect, useRef, useState } from 'react'

const WIDTH_KEY = 'deepstack.sidebarWidth'
/** Never so narrow the DeepStack title row stops fitting, and never under this (the width the
 * Parked heading needs with its count: icon, "Parked", count pill, chevron). */
const FLOOR = 204
/** Leave the big terminal most of the window. */
const maxWidth = () => Math.min(460, Math.round(window.innerWidth * 0.45))

function loadWidth(): number | null {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

function saveWidth(w: number | null): void {
  try {
    if (w === null) localStorage.removeItem(WIDTH_KEY)
    else localStorage.setItem(WIDTH_KEY, String(Math.round(w)))
  } catch {
    /* private mode etc.: the width just isn't remembered */
  }
}

/**
 * Natural width of the sidebar's title row: logo + "DeepStack" + count + collapse button, plus
 * the row's padding. The sidebar can't be dragged (or squeezed by the window) below this.
 */
function titleRowWidth(row: HTMLElement): number {
  const cs = getComputedStyle(row)
  let w = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
  const title = row.querySelector<HTMLElement>('.stack-title')
  if (title) {
    const tcs = getComputedStyle(title)
    const kids = [...title.children] as HTMLElement[]
    w += kids.reduce((sum, k) => sum + k.scrollWidth, 0) + parseFloat(tcs.columnGap || '0') * Math.max(0, kids.length - 1)
  }
  for (const b of row.querySelectorAll<HTMLElement>(':scope > button')) w += b.offsetWidth + 12
  return Math.ceil(w)
}

/**
 * The line between the stack and the big terminal, draggable like an IDE splitter. It writes
 * the width straight onto the app grid (--side-w) while dragging, saves it on release, and
 * double-click puts back the default width.
 */
export function SidebarResizer() {
  const ref = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  const app = () => ref.current?.closest<HTMLElement>('.app') ?? null
  const minWidth = () => {
    const v = parseFloat(app()?.style.getPropertyValue('--side-min') ?? '')
    return Number.isFinite(v) ? v : FLOOR
  }
  const apply = (w: number | null) => {
    const a = app()
    if (!a) return
    if (w === null) a.style.removeProperty('--side-w')
    else a.style.setProperty('--side-w', `${Math.round(w)}px`)
  }

  // Restore the saved width and measure the title row's minimum (again once fonts load, since
  // the wordmark's width depends on them).
  useLayoutEffect(() => {
    const a = app()
    const row = ref.current?.parentElement?.querySelector<HTMLElement>('.sidebar-drag')
    if (!a || !row) return
    const measure = () => a.style.setProperty('--side-min', `${Math.max(FLOOR, titleRowWidth(row))}px`)
    measure()
    void document.fonts?.ready.then(measure)
    apply(loadWidth())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      ref={ref}
      className={`sidebar-resizer ${dragging ? 'is-dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the stack"
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        const a = app()
        const sidebar = ref.current?.parentElement
        if (!a || !sidebar) return
        const startX = e.clientX
        const startW = sidebar.getBoundingClientRect().width
        let w = startW
        ref.current!.setPointerCapture(e.pointerId)
        a.classList.add('is-resizing')
        setDragging(true)
        const move = (ev: PointerEvent) => {
          w = Math.min(maxWidth(), Math.max(minWidth(), startW + ev.clientX - startX))
          apply(w)
        }
        const up = () => {
          ref.current?.removeEventListener('pointermove', move)
          ref.current?.removeEventListener('pointerup', up)
          ref.current?.removeEventListener('pointercancel', up)
          a.classList.remove('is-resizing')
          setDragging(false)
          if (Math.abs(w - startW) >= 1) saveWidth(w)
        }
        ref.current!.addEventListener('pointermove', move)
        ref.current!.addEventListener('pointerup', up)
        ref.current!.addEventListener('pointercancel', up)
      }}
      onDoubleClick={() => {
        saveWidth(null)
        apply(null)
      }}
    />
  )
}
