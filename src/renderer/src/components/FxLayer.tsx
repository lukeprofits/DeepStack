import { useEffect, useRef } from 'react'
import type { Theme } from '../../../shared/types'
import { startMatrix, type MatrixFx } from '../fx/matrix'
import { startOverlay, type Overlay } from '../fx/overlay'
import { liftCurtain, whenFramesSteady } from '../lib/curtain'

/** The theme's animated backdrop (only the Matrix theme has one). Sits behind the whole app. */
export function FxLayer({ theme, intensity }: { theme: Theme; intensity: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const over = useRef<HTMLCanvasElement>(null)
  const fx = useRef<MatrixFx | null>(null)
  const fg = useRef<Overlay | null>(null)
  const on = theme.fx === 'matrix'

  useEffect(() => {
    if (!on || !canvas.current) return
    fx.current = startMatrix(canvas.current, { intensity, accent: theme.ui.accent })
    if (over.current) fg.current = startOverlay(over.current, { intensity, accent: theme.ui.accent, onKey: () => fx.current?.burst() })
    // Warm up under the curtain (fonts, the terminal attaching, first frames of every effect),
    // then lift it and play the boot sequence on frames that are already smooth.
    let cancelled = false
    void (async () => {
      await Promise.race([document.fonts?.ready, new Promise((r) => setTimeout(r, 1200))])
      await new Promise((r) => setTimeout(r, 350))
      await whenFramesSteady()
      if (cancelled) return
      fg.current?.begin()
      // Lift only after the boot veil has painted, so no frame shows the app before the circle.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      if (cancelled) return
      liftCurtain(false)
    })()
    return () => {
      cancelled = true
      fx.current?.stop()
      fg.current?.stop()
      fx.current = null
      fg.current = null
    }
    // Intensity changes are passed in below without rebuilding the circuitry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, theme.ui.accent])

  useEffect(() => {
    fx.current?.setIntensity(intensity)
    fg.current?.setIntensity(intensity)
  }, [intensity])

  if (!on) return null
  return (
    <>
      <canvas ref={canvas} className="fx-canvas" aria-hidden />
      {/* Atmosphere as CSS layers: the compositor animates them, so they cost the canvas nothing. */}
      <div className="fx-atmo" aria-hidden>
        <div className="fx-fog is-a" />
        <div className="fx-fog is-b" />
        <div className="fx-fog is-c" />
        <div className="fx-vignette" />
        <div className="fx-grain" />
      </div>
      {/* Effects on top of the app (comets, sparks, reticle, boot); never over terminal text. */}
      <canvas ref={over} className="fx-over" aria-hidden />
    </>
  )
}
