/**
 * The black curtain from index.html covers the page from the first paint until the app is ready
 * to show, so launch never flashes half-built UI or a janky first frame. Matrix lifts it once its
 * effects are built and frames run steadily (then its boot sequence does the reveal); other
 * themes lift it as soon as the app has rendered.
 */
let lifted = false

export function liftCurtain(fade = true): void {
  if (lifted) return
  lifted = true
  const el = document.getElementById('boot-curtain')
  if (!el) return
  if (!fade) {
    el.remove()
    return
  }
  el.style.opacity = '0'
  window.setTimeout(() => el.remove(), 300)
}

/** Resolves once animation frames arrive steadily (or after `maxMs`, whichever is first). */
export function whenFramesSteady(maxMs = 2500, need = 6): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now()
    let last = start
    let good = 0
    const tick = (t: number) => {
      good = t - last < 22 ? good + 1 : 0
      last = t
      if (good >= need || t - start > maxMs) resolve()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}
