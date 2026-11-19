/**
 * Hacker: a thumbnail glitches out for a moment as the pointer reaches it. The real thumbnail
 * stays put (it only twitches). Short-lived copies of its picture go on top:
 *  - one carrying just the red channel and one just green-blue, sliding opposite ways in bands
 *    (a real chromatic aberration, with the terminal still underneath);
 *  - one full-colour copy showing only a thin strip or two, shoved sideways: the tear.
 * The whole slot (border, picture, label) rips apart into sideways-shoved bands for a few frames
 * (SVG #fx-thumb-rip, a fresh seed and strength each frame), and its name label kicks sideways
 * with a split on the text. Every glitch is rolled fresh (timing,
 * frame count, distances, where the bands fall), so sweeping down the stack never repeats.
 * The copies exist only for the length of the glitch.
 */
const rnd = (a: number, b: number) => a + Math.random() * (b - a)
const sign = () => (Math.random() < 0.5 ? -1 : 1)

/** A horizontal band (top/bottom insets in %), between `min`% and `max`% tall. */
function band(min: number, max: number): string {
  const h = rnd(min, max)
  const top = rnd(0, 100 - h)
  return `inset(${top.toFixed(1)}% 0 ${(100 - top - h).toFixed(1)}% 0)`
}

/** Stepped keyframes: each frame holds until the next (a glitch jumps, it doesn't glide). */
function frames(n: number, frame: (i: number, t: number) => Keyframe): Keyframe[] {
  const out: Keyframe[] = []
  for (let i = 0; i < n; i++) out.push({ ...frame(i, i / (n - 1)), offset: i / n, easing: 'steps(1, end)' })
  return out
}

/** Steps the shared rip filter on this slot: new bands and a new throw each frame, easing off. */
function rip(slot: HTMLElement, n: number, ms: number, power: number): void {
  const map = document.getElementById('fx-thumb-rip-map')
  const noise = document.getElementById('fx-thumb-rip-noise')
  if (!map || !noise) return
  const body = slot.querySelector<HTMLElement>('.slot-body') ?? slot
  // Keep whatever filter the slot already has (a parked one is grey) and rip on top of it.
  const base = getComputedStyle(body).filter
  const own = body.style.filter
  body.style.filter = `url(#fx-thumb-rip)${base && base !== 'none' ? ` ${base}` : ''}`
  for (let i = 0; i < n; i++) {
    window.setTimeout(() => {
      const t = i / Math.max(1, n - 1)
      // Mostly big throws, now and then a quiet frame so it stutters rather than wobbles.
      const s = Math.random() < 0.2 ? rnd(4, 8) : rnd(35, 60) * power * (1 - t * 0.5)
      map.setAttribute('scale', s.toFixed(0))
      noise.setAttribute('seed', String(Math.floor(Math.random() * 1000)))
    }, (i * ms) / n)
  }
  window.setTimeout(() => {
    map.setAttribute('scale', '0')
    body.style.filter = own
  }, ms)
}

export function glitchThumb(slot: HTMLElement): void {
  if (document.documentElement.dataset.fx !== 'matrix') return
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  if (slot.classList.contains('is-dragging') || document.querySelector('.drag-card')) return
  const mini = slot.querySelector<HTMLElement>('.mini')
  const src = mini?.querySelector<HTMLCanvasElement>('canvas.mini-canvas')
  if (!mini || !src || !src.width || !src.height || mini.querySelector('.mini-ghost')) return

  const ms = rnd(210, 340)
  const n = 3 + Math.floor(Math.random() * 3)
  const power = rnd(0.6, 1.3)
  const dir = sign()
  const ghosts: HTMLCanvasElement[] = []
  const copy = (k: string) => {
    const g = document.createElement('canvas')
    g.width = src.width
    g.height = src.height
    g.getContext('2d')?.drawImage(src, 0, 0)
    g.className = `mini-ghost ${k}`
    Object.assign(g.style, { left: `${src.offsetLeft}px`, top: `${src.offsetTop}px`, width: `${src.offsetWidth}px`, height: `${src.offsetHeight}px` })
    mini.appendChild(g)
    ghosts.push(g)
    return g
  }
  const end: Keyframe = { opacity: 0, transform: 'none', clipPath: 'inset(0 0 0 0)' }

  // Colour split: opposite ways, easing off; some frames whole, some just a band.
  for (const [k, d] of [['is-r', -dir], ['is-gb', dir]] as const) {
    copy(k).animate(
      frames(n + 1, (i, t) =>
        i === n
          ? end
          : {
              opacity: 1,
              transform: `translateX(${(d * rnd(4, 12) * power * (1 - t * 0.7) * (Math.random() < 0.25 ? -1 : 1)).toFixed(1)}px)`,
              clipPath: Math.random() < 0.55 ? band(12, 45) : 'inset(0 0 0 0)'
            }
      ),
      { duration: ms, fill: 'both' }
    )
  }
  // The tear: a thin strip of the real picture shoved sideways, a new strip most frames.
  copy('is-tear').animate(
    frames(n + 1, (i) =>
      i === n || Math.random() < 0.2 ? end : { opacity: 1, transform: `translateX(${(sign() * rnd(3, 9) * power).toFixed(1)}px)`, clipPath: band(4, 16) }
    ),
    { duration: ms, fill: 'both' }
  )
  // The thumbnail itself only twitches (with a flash on the first frame).
  mini.animate(
    frames(n + 1, (i, t) =>
      i === n
        ? { transform: 'none', filter: 'none' }
        : { transform: `translateX(${(sign() * rnd(1, 4) * power * (1 - t)).toFixed(1)}px)`, filter: i === 0 ? `brightness(${rnd(1.1, 1.35).toFixed(2)})` : 'none' }
    ),
    { duration: ms }
  )
  // The label kicks sideways with a red / green-blue split on the text.
  slot.querySelector<HTMLElement>('.slot-badge')?.animate(
    frames(n + 1, (i, t) => {
      if (i === n) return { transform: 'none', textShadow: 'none', boxShadow: 'none' }
      // A hard split: red and cyan copies of the text, and of the pill's outline, either side.
      const s = rnd(3, 8) * power * (1 - t * 0.5)
      const d = sign()
      const x = (k: number) => (k * s).toFixed(1)
      return {
        transform: `translateX(${(sign() * rnd(2, 6) * power * (1 - t)).toFixed(1)}px)`,
        textShadow: `${x(d)}px 0 rgba(255, 40, 80, 0.9), ${x(-d)}px 0 rgba(60, 230, 255, 0.9)`,
        boxShadow: `${x(d)}px 0 0 -1px rgba(255, 40, 80, 0.75), ${x(-d)}px 0 0 -1px rgba(60, 230, 255, 0.75)`
      }
    }),
    { duration: ms }
  )
  rip(slot, n, ms, power)
  window.setTimeout(() => {
    for (const g of ghosts) g.remove()
  }, ms + 20)
}

/** When each panel last glitched: once on the way in, not again for a moment. */
const panelLast = new WeakMap<HTMLElement, number>()

/**
 * The same glitch for a whole panel (the big terminal, Quick replies, Queued) as the pointer
 * comes onto it. There's no picture to copy, so the panel itself carries it: it rips into
 * sideways-shoved bands (the shared #fx-thumb-rip), splits red / cyan, and twitches, for a few
 * stepped frames. Played as an animation, so it never touches the panel's own styles.
 */
export function glitchPanel(el: HTMLElement): void {
  if (document.documentElement.dataset.fx !== 'matrix') return
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  // Not mid-switch (the windows are flying) or while dragging a thumbnail.
  if (document.documentElement.classList.contains('is-hinging') || el.classList.contains('is-switching') || document.querySelector('.drag-card')) return
  const now = performance.now()
  if (now - (panelLast.get(el) ?? -1e9) < 1200) return
  panelLast.set(el, now)
  const map = document.getElementById('fx-thumb-rip-map')
  const noise = document.getElementById('fx-thumb-rip-noise')
  const ms = rnd(210, 320)
  const n = 3 + Math.floor(Math.random() * 3)
  const power = rnd(0.6, 1.2)
  el.animate(
    frames(n + 1, (i, t) => {
      if (i === n) return { transform: 'none', filter: 'none' }
      // Every frame splits the colour (#fx-panel-ca, its offsets stepped below); most also rip
      // (a quiet frame now and then, so it stutters).
      const torn = Math.random() < 0.8 ? 'url(#fx-thumb-rip) ' : ''
      return {
        transform: `translateX(${(sign() * rnd(1, 4) * power * (1 - t)).toFixed(1)}px)`,
        filter: `${torn}url(#fx-panel-ca)${i === 0 ? ` brightness(${rnd(1.08, 1.25).toFixed(2)})` : ''}`
      }
    }),
    { duration: ms }
  )
  const caR = document.getElementById('fx-panel-ca-r')
  const caGB = document.getElementById('fx-panel-ca-gb')
  const dir = sign()
  for (let i = 0; i < n; i++) {
    window.setTimeout(() => {
      const t = i / Math.max(1, n - 1)
      // The red and the green-blue slid opposite ways, now and then swapping sides.
      const s = rnd(3, 9) * power * (1 - t * 0.6) * (Math.random() < 0.25 ? -dir : dir)
      caR?.setAttribute('dx', s.toFixed(1))
      caGB?.setAttribute('dx', (-s).toFixed(1))
      if (map && noise) {
        map.setAttribute('scale', (Math.random() < 0.2 ? rnd(4, 8) : rnd(30, 55) * power).toFixed(0))
        noise.setAttribute('seed', String(Math.floor(Math.random() * 1000)))
      }
    }, (i * ms) / n)
  }
  window.setTimeout(() => {
    map?.setAttribute('scale', '0')
    caR?.setAttribute('dx', '0')
    caGB?.setAttribute('dx', '0')
  }, ms)
}
