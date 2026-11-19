/**
 * The stage's box on screen, kept up to date without reading layout every frame: re-measured when
 * the stage resizes (ResizeObserver), when the window does, and as a fallback every couple of
 * seconds. The backdrop and the overlay read it each frame instead of calling
 * getBoundingClientRect, which forces a synchronous layout after any style change (hover, typing).
 */
let el: HTMLElement | null = null
let rect: DOMRect | null = null
let dirty = true
let checkedAt = 0
const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => (dirty = true)) : null
if (typeof window !== 'undefined') window.addEventListener('resize', () => (dirty = true))

export function stageRect(): DOMRect | null {
  if (!el?.isConnected) {
    ro?.disconnect()
    el = document.querySelector<HTMLElement>('.stage')
    if (el) ro?.observe(el)
    dirty = true
  }
  const now = performance.now()
  if (el && (dirty || now - checkedAt > 2000)) {
    dirty = false
    checkedAt = now
    rect = el.getBoundingClientRect()
  }
  return el ? rect : null
}
