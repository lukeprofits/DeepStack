/**
 * Our own rubber-band bounce for a scroll list. The browser's native overscroll bounce is drawn
 * by the compositor, invisible to layout, so anything positioned from measured rects (the
 * tether from the active slot's dot to the big terminal) stays put while the list bounces.
 * This bounce shifts the list's children with the CSS `translate` property instead (via
 * --overscroll), which getBoundingClientRect sees, and fires a scroll event every frame so
 * scroll-following overlays re-place themselves in step.
 */

/** Furthest the content can be pulled past an edge, px. */
const MAX = 80
/** Share of the wheel delta that turns into overscroll at zero stretch (it stiffens toward MAX). */
const GIVE = 0.45
/** Spring-back time constant, ms: the offset decays by 1/e every TAU. */
const TAU = 110

export function attachBounce(el: HTMLElement): () => void {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return () => {}
  el.style.overscrollBehaviorY = 'none'
  let offset = 0 // > 0: pulled down past the top; < 0: pulled up past the bottom
  let raf = 0
  let last = 0

  const apply = () => {
    el.style.setProperty('--overscroll', `${offset.toFixed(2)}px`)
    el.dispatchEvent(new Event('scroll'))
  }

  const tick = (now: number) => {
    const dt = Math.min(64, now - last)
    last = now
    offset *= Math.exp(-dt / TAU)
    if (Math.abs(offset) < 0.25) {
      offset = 0
      raf = 0
      apply()
      return
    }
    apply()
    raf = requestAnimationFrame(tick)
  }

  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey) return // pinch-zoom
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * el.clientHeight : e.deltaY
    if (!dy || (offset === 0 && el.scrollHeight <= el.clientHeight + 1)) return
    const atTop = el.scrollTop <= 0
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1
    const pushing = (dy < 0 && atTop && offset >= 0) || (dy > 0 && atBottom && offset <= 0)
    if (pushing) {
      offset -= dy * GIVE * (1 - Math.abs(offset) / MAX)
      offset = Math.max(-MAX, Math.min(MAX, offset))
    } else if (offset !== 0) {
      // Scrolling back in while stretched: relax the stretch first.
      offset = Math.sign(offset) * Math.max(0, Math.abs(offset) - Math.abs(dy))
    } else return
    apply()
    if (!raf) {
      last = performance.now()
      raf = requestAnimationFrame(tick)
    }
  }

  el.addEventListener('wheel', onWheel, { passive: true })
  return () => {
    el.removeEventListener('wheel', onWheel)
    cancelAnimationFrame(raf)
    el.style.removeProperty('--overscroll')
    el.style.overscrollBehaviorY = ''
  }
}
