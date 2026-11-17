import { useEffect, useRef } from 'react'
import type { Theme } from '../../../shared/types'
import { startMatrix, type MatrixFx } from '../fx/matrix'
import { startOverlay, type Overlay } from '../fx/overlay'
import { liftCurtain, whenFramesSteady } from '../lib/curtain'

/** The theme's animated backdrop (only the Matrix theme has one). Sits behind the whole app. */
export function FxLayer({ theme, intensity, hackBanner, hackTexts, typingGlitch }: { theme: Theme; intensity: number; hackBanner: boolean; hackTexts: string[]; typingGlitch: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const over = useRef<HTMLCanvasElement>(null)
  const fx = useRef<MatrixFx | null>(null)
  const fg = useRef<Overlay | null>(null)
  const on = theme.fx === 'matrix'

  useEffect(() => {
    if (!on || !canvas.current) return
    fx.current = startMatrix(canvas.current, { intensity, accent: theme.ui.accent, typingGlitch })
    if (over.current) fg.current = startOverlay(over.current, { intensity, accent: theme.ui.accent, onKey: () => fx.current?.burst(), parallax: () => fx.current?.parallax() ?? [0, 0] })
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

  useEffect(() => {
    fx.current?.setTypingGlitch(typingGlitch)
  }, [typingGlitch])

  const textsKey = hackTexts.join('\n')
  useEffect(() => {
    fx.current?.setHackTexts(hackTexts)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textsKey, on])

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
      {/* Movie-hacker banner: flickers on over everything while typing (driven by fx/matrix.ts). */}
      {hackBanner && (
        <div className="fx-hack" aria-hidden>
          <div className="fx-hack-box">
            <svg className="fx-hack-skull" viewBox="0 0 64 64">
              <path
                fillRule="evenodd"
                d="M32 4C17 4 7 14 7 28c0 8 4 14 9 17v8a3 3 0 0 0 3 3h26a3 3 0 0 0 3-3v-8c5-3 9-9 9-17C57 14 47 4 32 4Z M15.5 30a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0 -13 0Z M35.5 30a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0 -13 0Z M32 38l-4 7h8Z"
              />
              <path d="M26 49v7M32 49v7M38 49v7" className="fx-hack-teeth" />
            </svg>
            <div className="fx-hack-text">HACKING...</div>
            <div className="fx-hack-sub">BYPASSING MAINFRAME FIREWALL // ACCESS GRANTED</div>
          </div>
        </div>
      )}
      {/* Typing "rip": jagged horizontal bands that slide the chrome apart (driven by fx/matrix.ts). */}
      <svg className="fx-defs" aria-hidden width="0" height="0">
        {/* Thumbnail hover rip: a band or two of the whole slot shoved well sideways; mostly whole
            (lib/thumbGlitch.ts sets the scale and seed each frame). */}
        <filter id="fx-thumb-rip" x="-25%" y="0" width="150%" height="100%" colorInterpolationFilters="sRGB">
          <feTurbulence id="fx-thumb-rip-noise" type="fractalNoise" baseFrequency="0.00008 0.012" numOctaves="1" seed="1" result="n" />
          <feComponentTransfer in="n" result="steps">
            <feFuncR type="discrete" tableValues="0.5 0.5 0.5 0.1 0.5 0.5 0.9 0.5 0.5 0.5" />
            <feFuncG type="linear" slope="0" intercept="0.5" />
          </feComponentTransfer>
          <feDisplacementMap id="fx-thumb-rip-map" in="SourceGraphic" in2="steps" scale="0" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        {/* Heat shimmer on a window swinging on its hinge (Stage placeHinged sets scale and seed). */}
        <filter id="fx-heat" x="-4%" y="-4%" width="108%" height="108%" colorInterpolationFilters="sRGB">
          <feTurbulence id="fx-heat-noise" type="turbulence" baseFrequency="0.006 0.022" numOctaves="2" seed="3" result="n" />
          <feDisplacementMap id="fx-heat-map" in="SourceGraphic" in2="n" scale="0" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        {/* Digital tears on a swinging window: a band or two slipped sideways, in bursts (Stage). */}
        <filter id="fx-wtear" x="-10%" y="0" width="120%" height="100%" colorInterpolationFilters="sRGB">
          <feTurbulence id="fx-wtear-noise" type="fractalNoise" baseFrequency="0.00008 0.009" numOctaves="1" seed="5" result="n" />
          <feComponentTransfer in="n" result="steps">
            <feFuncR type="discrete" tableValues="0.5 0.5 0.5 0.15 0.5 0.5 0.85 0.5 0.5 0.5" />
            <feFuncG type="linear" slope="0" intercept="0.5" />
          </feComponentTransfer>
          <feDisplacementMap id="fx-wtear-map" in="SourceGraphic" in2="steps" scale="0" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        {/* Single-channel copies for the thumbnail hover glitch (lib/thumbGlitch.ts). */}
        <filter id="fx-ch-r" colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" />
        </filter>
        <filter id="fx-ch-gb" colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0" />
        </filter>
        <filter id="fx-rip" x="-60%" y="0" width="220%" height="100%" colorInterpolationFilters="sRGB">
          <feTurbulence id="fx-rip-noise" type="fractalNoise" baseFrequency="0.00008 0.02" numOctaves="1" seed="1" result="n" />
          <feComponentTransfer in="n" result="steps">
            <feFuncR type="discrete" tableValues="0.5 0.5 0 0.5 0.5 0.5 1 0.5 0.5 0.2 0.5 0.5 0.5 0.8 0.5" />
            <feFuncG type="linear" slope="0" intercept="0.5" />
          </feComponentTransfer>
          <feDisplacementMap id="fx-rip-map" in="SourceGraphic" in2="steps" scale="0" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </svg>
    </>
  )
}
