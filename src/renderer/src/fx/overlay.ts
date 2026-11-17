/**
 * The Matrix theme's foreground: effects that sit on top of the app, right where you look, but
 * never over terminal text (the big terminal's inside is clipped out, except during the brief
 * boot sequence).
 *
 *  - comets orbiting the thumbnail of every session that's thinking, in its colour
 *  - every keystroke fires a glitch through the backdrop and the chrome (MatrixFx.burst)
 *  - titles that decrypt through random glyphs when they change
 *  - a boot sequence on load: the screen opens from the centre and "// SYSTEM ONLINE" decrypts
 *  - now and then, a few huge, out-of-focus streaks of raining code rush past right in front of
 *    the camera, over everything (the one thing allowed over terminal text, for a second or two;
 *    the HACKING banner sits above it)
 */

export interface Overlay {
  setIntensity(n: number): void
  /** Start the boot sequence (called once everything is warmed up under the curtain). */
  begin(): void
  stop(): void
}

interface Opts {
  intensity: number
  accent: string
  onKey: () => void
  /** The backdrop's parallax offset, about -1.5..1.5 each way (see PARALLAX_GAIN). */
  parallax: () => [number, number]
}

const SCRAMBLE = 'ΑΒΓΔΘΛΞΠΣΦΨΩアイウエオカキクケコサシスセソタチツテト0123456789ABCDEF#$%&*<>/\\'
const DECODE_TARGETS = ['.header-title:not(.header-title-input)', '.stack-wordmark']
const STAGE_R = 10 // the stage's corner radius
const R = STAGE_R
const THUMB_R = 6 // a thumbnail's corner radius

type Rect = { left: number; top: number; width: number; height: number }

/**
 * Close-up rain: every `every` ms (shorter at higher intensity) a burst of `cols` big glyph
 * streaks falls past, nearer the camera than anything else: faint glowing letters you see
 * through, fast, and swinging furthest with the parallax (`depth` px). Sizes px, speeds px/s;
 * `alpha` is the crisp letter, `glow` the soft halo around it.
 */
const SHOWER = {
  every: [9000, 22000],
  spread: 1800,
  cols: [2, 5],
  size: [48, 92],
  len: [5, 10],
  speed: [1000, 1700],
  alpha: [0.1, 0.2],
  glow: 0.5,
  depth: 260,
  /** Chromatic glitch: starts per streak per second, how long (ms), re-roll step (ms), split (px). */
  glitch: { rate: 0.5, ms: [90, 240], step: [40, 70], split: [3, 9] }
}
/** The soft halo sprites, drawn once at this size and scaled (blurred, so resolution doesn't show). */
const SPRITE = 90

function rgb(color: string, fallback: [number, number, number]): [number, number, number] {
  const c = color.trim()
  let m = /^#?([0-9a-f]{6})$/i.exec(c)
  if (m) {
    const n = parseInt(m[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c)
  return m ? [+m[1], +m[2], +m[3]] : fallback
}

/** A point `s` px along a rounded rectangle's perimeter (clockwise from the top-left corner's end), plus its outward normal. */
function perimeter(r: Rect, s: number, R = STAGE_R): { x: number; y: number; nx: number; ny: number } {
  const w = r.width - 2 * R
  const h = r.height - 2 * R
  const arc = (Math.PI / 2) * R
  const total = 2 * w + 2 * h + 4 * arc
  let d = ((s % total) + total) % total
  const segs: [number, (t: number) => { x: number; y: number; nx: number; ny: number }][] = [
    [w, (t) => ({ x: r.left + R + t, y: r.top, nx: 0, ny: -1 })],
    [arc, (t) => corner(R, r.left + r.width - R, r.top + R, -Math.PI / 2 + t / R)],
    [h, (t) => ({ x: r.left + r.width, y: r.top + R + t, nx: 1, ny: 0 })],
    [arc, (t) => corner(R, r.left + r.width - R, r.top + r.height - R, t / R)],
    [w, (t) => ({ x: r.left + r.width - R - t, y: r.top + r.height, nx: 0, ny: 1 })],
    [arc, (t) => corner(R, r.left + R, r.top + r.height - R, Math.PI / 2 + t / R)],
    [h, (t) => ({ x: r.left, y: r.top + r.height - R - t, nx: -1, ny: 0 })],
    [arc, (t) => corner(R, r.left + R, r.top + R, Math.PI + t / R)]
  ]
  for (const [len, at] of segs) {
    if (d <= len) return at(d)
    d -= len
  }
  return segs[0][1](0)
}

function corner(R: number, cx: number, cy: number, a: number) {
  return { x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R, nx: Math.cos(a), ny: Math.sin(a) }
}

const perimLength = (r: Rect, R = STAGE_R) => 2 * (r.width - 2 * R) + 2 * (r.height - 2 * R) + 2 * Math.PI * R

function roundRectPath(ctx: CanvasRenderingContext2D, r: Rect, rad: number): void {
  ctx.moveTo(r.left + rad, r.top)
  ctx.arcTo(r.left + r.width, r.top, r.left + r.width, r.top + r.height, rad)
  ctx.arcTo(r.left + r.width, r.top + r.height, r.left, r.top + r.height, rad)
  ctx.arcTo(r.left, r.top + r.height, r.left, r.top, rad)
  ctx.arcTo(r.left, r.top, r.left + r.width, r.top, rad)
  ctx.closePath()
}

export function startOverlay(canvas: HTMLCanvasElement, opts: Opts): Overlay {
  const ctx = canvas.getContext('2d')!
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  const accent = rgb(opts.accent, [92, 255, 143])
  let intensity = Math.max(0, Math.min(1, opts.intensity))
  let W = 0
  let H = 0
  let dpr = 1
  let raf = 0
  let last = 0
  let stopped = false
  /** When the boot sequence started; Infinity until begin(). */
  let born = Infinity
  const BOOT_MS = 3400
  let sparks: { x: number; y: number; vx: number; vy: number; age: number; life: number }[] = []
  let stageColor = accent
  /** Close-up rain (SHOWER): streaks falling past the camera, and when the next burst starts. */
  /** gUntil/gNext/gDx: the streak's chromatic glitch (SHOWER.glitch). */
  let drops: { x: number; y: number; v: number; size: number; a: number; chars: number[]; at: number; gUntil: number; gNext: number; gDx: number }[] = []
  let nextShower = 0
  /** Blurred halo sprite per glyph (the crisp letter is drawn live on top). */
  let sprites: HTMLCanvasElement[] = []
  let colorCheck = 0

  // Decrypting titles: remember each target's text; a change starts a decode.
  // Keyed by selector: React may swap in a new element when the session changes.
  const lastText = new Map<string, string>()
  const decoding = new Map<Element, { text: string; start: number; ms: number }>()

  function size(): void {
    W = window.innerWidth
    H = window.innerHeight
    dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
    canvas.style.width = `${W}px`
    canvas.style.height = `${H}px`
  }

  const stageRect = (): Rect | null => {
    const r = document.querySelector('.stage')?.getBoundingClientRect()
    return r && r.width > 40 ? r : null
  }

  function onKey(e: KeyboardEvent): void {
    // Typing kicks a glitch through everything around the terminal (see MatrixFx.burst).
    if (intensity <= 0 || e.repeat || e.metaKey) return
    opts.onKey()
  }


  function scrambled(text: string, p: number): string {
    const done = Math.floor(text.length * p)
    let out = text.slice(0, done)
    for (let i = done; i < text.length; i++) out += text[i] === ' ' ? ' ' : SCRAMBLE[Math.floor(Math.random() * SCRAMBLE.length)]
    return out
  }

  function decode(now: number, booting: boolean): void {
    for (const sel of DECODE_TARGETS) {
      const el = document.querySelector(sel)
      if (!el) continue
      const text = el.textContent ?? ''
      const prev = lastText.get(sel)
      lastText.set(sel, text)
      if ((prev !== undefined && prev !== text) || (prev === undefined && booting)) {
        decoding.set(el, { text, start: now + (booting ? 350 : 0), ms: booting ? 900 : 520 })
      }
    }
    for (const [el, d] of decoding) {
      const p = (now - d.start) / d.ms
      if (p >= 1 || !el.isConnected || el.textContent !== d.text) {
        el.classList.remove('fx-decoding')
        el.removeAttribute('data-fx-text')
        decoding.delete(el)
        continue
      }
      el.classList.add('fx-decoding')
      el.setAttribute('data-fx-text', scrambled(d.text, Math.max(0, p)))
    }
  }

  /**
   * Comets orbiting the thumbnail of every session that's thinking (Claude working, or waiting
   * on a background task of its own), each in its session's colour and on its own beat.
   */
  function drawComets(now: number): void {
    for (const slot of document.querySelectorAll<HTMLElement>('.slot.is-thinking:not(.is-dragging)')) {
      const mini = slot.querySelector('.mini')
      const list = slot.closest('.stack-list, .park-list')?.getBoundingClientRect()
      const m = mini?.getBoundingClientRect()
      if (!m || !list || m.width < 20 || m.bottom < list.top || m.top > list.bottom) continue
      const color = rgb(slot.style.getPropertyValue('--c'), accent)
      // Out of step with each other: a fixed offset from the session id.
      const id = slot.dataset.slot ?? ''
      let phase = 0
      for (let i = 0; i < id.length; i++) phase = (phase * 31 + id.charCodeAt(i)) % 1000
      orbit(now, { left: m.left + 1, top: m.top + 1, width: m.width - 2, height: m.height - 2 }, list, color, phase / 1000)
    }
  }

  function orbit(now: number, r: Rect, list: DOMRect, [cr, cg, cb]: [number, number, number], phase: number): void {
    const count = intensity < 0.5 ? 1 : 2
    const period = 9000 - 3000 * intensity
    const L = perimLength(r, THUMB_R)
    const tail = Math.min(L * 0.32, 80 + 140 * intensity)
    const steps = 36
    ctx.save()
    // Stay inside the stack's scroll band, so the comets slide under the header like the thumbnails.
    ctx.beginPath()
    ctx.rect(list.left - 20, list.top, list.width + 40, list.height)
    ctx.clip()
    ctx.lineCap = 'butt'
    for (let c = 0; c < count; c++) {
      const head = ((now / period + phase + c / count) % 1) * L
      const pts = Array.from({ length: steps + 1 }, (_, i) => perimeter(r, head - (tail * i) / steps, THUMB_R))
      for (const [width, alpha] of [
        [10, 0.12],
        [5, 0.3],
        [2.2, 1]
      ] as const) {
        for (let i = 0; i < steps; i++) {
          const f = 1 - i / steps
          const wv = (v: number) => Math.round(v + (255 - v) * (0.25 + 0.65 * f))
          ctx.strokeStyle = `rgba(${wv(cr)},${wv(cg)},${wv(cb)},${alpha * f})`
          ctx.lineWidth = width * (0.35 + 0.65 * f)
          ctx.beginPath()
          ctx.moveTo(pts[i].x, pts[i].y)
          ctx.lineTo(pts[i + 1].x, pts[i + 1].y)
          ctx.stroke()
        }
      }
      const h = pts[0]
      ctx.fillStyle = `rgba(${cr},${cg},${cb},0.25)`
      ctx.beginPath()
      ctx.arc(h.x, h.y, 6, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.beginPath()
      ctx.arc(h.x, h.y, 2.2, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  function drawSparks(dt: number): void {
    const [cr, cg, cb] = stageColor
    sparks = sparks.filter((s) => (s.age += dt) < s.life)
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'round'
    for (const s of sparks) {
      s.x += s.vx * dt
      s.y += s.vy * dt
      s.vx *= 0.92
      s.vy *= 0.92
      const f = 1 - s.age / s.life
      ctx.strokeStyle = `rgba(${Math.min(255, cr + 90)},${Math.min(255, cg + 60)},${Math.min(255, cb + 90)},${f})`
      ctx.beginPath()
      ctx.moveTo(s.x, s.y)
      ctx.lineTo(s.x - s.vx * 0.05, s.y - s.vy * 0.05)
      ctx.lineWidth = 6
      ctx.globalAlpha = 0.22
      ctx.stroke()
      ctx.lineWidth = 2
      ctx.globalAlpha = 1
      ctx.stroke()
    }
    ctx.shadowBlur = 0
    ctx.globalCompositeOperation = 'source-over'
  }

  const span = ([a, b]: number[]) => a + Math.random() * (b - a)
  const RAIN_GLYPHS = 'アイウエオカキクケコサシスセソタチツテトΣΔΨΩΛΞ0123456789'

  /** Pre-render the close-up glyphs, blurred, so a burst costs only drawImage calls. */
  function buildSprites(): void {
    const [ar, ag, ab] = accent
    const pad = 24
    sprites = [...RAIN_GLYPHS].map((ch) => {
      const c = document.createElement('canvas')
      c.width = c.height = SPRITE + pad * 2
      const g = c.getContext('2d')!
      g.filter = 'blur(9px)'
      g.font = `700 ${SPRITE}px "JetBrains Mono", monospace`
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillStyle = `rgb(${ar},${ag},${ab})`
      g.fillText(ch, c.width / 2, c.height / 2)
      return c
    })
  }

  function startShower(now: number): void {
    // A handful of streaks, staggered across the next ~2s, anywhere on screen.
    const n = Math.round(span(SHOWER.cols))
    for (let i = 0; i < n; i++) {
      const size = span(SHOWER.size)
      const len = Math.round(span(SHOWER.len))
      drops.push({
        x: Math.random() * W,
        y: -size,
        v: span(SHOWER.speed) * (size / 115),
        size,
        a: span(SHOWER.alpha),
        chars: Array.from({ length: len }, () => Math.floor(Math.random() * RAIN_GLYPHS.length)),
        at: now + Math.random() * SHOWER.spread,
        gUntil: 0,
        gNext: 0,
        gDx: 0
      })
    }
  }

  /** Every so often, a few huge streaks of code rush past right in front of the camera. */
  function drawShower(now: number, dt: number): void {
    if (!sprites.length) buildSprites()
    if (!nextShower) nextShower = now + span(SHOWER.every) / (0.5 + intensity)
    if (now >= nextShower) {
      startShower(now)
      nextShower = now + span(SHOWER.every) / (0.5 + intensity)
    }
    if (!drops.length) return
    const [px, py] = opts.parallax()
    const ox = -px * SHOWER.depth
    const oy = -py * SHOWER.depth * 0.5
    drops = drops.filter((d) => d.y - d.chars.length * d.size < H + 40)
    const [ar, ag, ab] = accent
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const d of drops) {
      if (now < d.at) continue
      d.y += d.v * dt
      // Every glyph keeps mutating (the leading one fastest).
      for (let k = 0; k < d.chars.length; k++) if (Math.random() < dt * (k === 0 ? 14 : 4)) d.chars[k] = Math.floor(Math.random() * RAIN_GLYPHS.length)
      const len = d.chars.length
      const s = (d.size / SPRITE) * (SPRITE + 48)
      const G = SHOWER.glitch
      if (now >= d.gUntil && Math.random() < dt * G.rate) d.gUntil = now + span(G.ms)
      const glitching = now < d.gUntil
      if (glitching && now >= d.gNext) {
        d.gNext = now + span(G.step)
        d.gDx = span(G.split) * (Math.random() < 0.5 ? -1 : 1)
      }
      ctx.font = `700 ${Math.round(d.size)}px "JetBrains Mono", monospace`
      for (let k = 0; k < len; k++) {
        const y = d.y - k * d.size * 0.95 + oy
        if (y < -s || y > H + s) continue
        const x = d.x + ox
        const f = k === 0 ? 1 : 1 - k / len
        // Soft halo, then the letter itself: faint and crisp, so you see right through it.
        ctx.globalAlpha = SHOWER.glow * d.a * 3 * f
        ctx.drawImage(sprites[d.chars[k]], x - s / 2, y - s / 2, s, s)
        ctx.globalAlpha = Math.min(1, (k === 0 ? 2.2 : 1) * d.a * f)
        ctx.fillStyle = k === 0 ? `rgb(${Math.min(255, ar + 140)},255,${Math.min(255, ab + 140)})` : `rgb(${ar},${ag},${ab})`
        ctx.fillText(RAIN_GLYPHS[d.chars[k]], x, y)
        if (glitching) {
          // Red and cyan copies either side (added light, like everything here).
          ctx.fillStyle = 'rgb(255,40,90)'
          ctx.fillText(RAIN_GLYPHS[d.chars[k]], x - d.gDx, y)
          ctx.fillStyle = 'rgb(40,220,255)'
          ctx.fillText(RAIN_GLYPHS[d.chars[k]], x + d.gDx, y)
        }
      }
    }
    ctx.restore()
  }

  function drawBoot(now: number): void {
    const p = (now - born) / BOOT_MS
    if (p >= 1) return
    const [ar, ag, ab] = accent
    // Darkness opening from the centre, with a bright ring at its edge.
    const ease = 1 - Math.pow(1 - Math.min(1, p / 0.4), 3)
    const maxR = Math.hypot(W, H) / 2
    const rad = maxR * ease
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, W, H)
    ctx.arc(W / 2, H / 2, Math.max(0.1, rad), 0, Math.PI * 2, true)
    ctx.fillStyle = '#010402' // fully opaque, the same black as the curtain: nothing shows through before the circle opens
    ctx.fill('evenodd')
    ctx.globalCompositeOperation = 'lighter'
    ctx.strokeStyle = `rgba(${ar},${ag},${ab},${0.8 * (1 - ease)})`
    ctx.lineWidth = 3
    ctx.shadowColor = `rgb(${ar},${ag},${ab})`
    ctx.shadowBlur = 24
    ctx.beginPath()
    ctx.arc(W / 2, H / 2, rad, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
    // The banner decrypts, holds, then fades.
    const text = '// SYSTEM ONLINE'
    // Decrypts over ~1s, holds readable for ~1.5s, then fades.
    const tp = Math.max(0, Math.min(1, (p - 0.04) / 0.3))
    const fade = p < 0.8 ? 1 : (1 - p) / 0.2
    ctx.save()
    // A soft dark backing so the banner reads over whatever is behind it.
    const back = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, 260)
    back.addColorStop(0, `rgba(1,4,2,${0.85 * fade})`)
    back.addColorStop(1, 'rgba(1,4,2,0)')
    ctx.fillStyle = back
    ctx.fillRect(W / 2 - 260, H / 2 - 260, 520, 520)
    ctx.font = '600 28px "JetBrains Mono", monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.shadowColor = `rgb(${ar},${ag},${ab})`
    ctx.shadowBlur = 18
    ctx.fillStyle = `rgba(${Math.min(255, ar + 80)},255,${Math.min(255, ab + 80)},${fade})`
    ctx.fillText(scrambled(text, tp), W / 2, H / 2)
    ctx.font = '11px "JetBrains Mono", monospace'
    ctx.shadowBlur = 6
    ctx.fillStyle = `rgba(${ar},${ag},${ab},${0.8 * fade})`
    const n = document.querySelectorAll('[data-slot]').length
    ctx.fillText(scrambled(`DEEPSTACK · ${n} SESSION${n === 1 ? '' : 'S'} LINKED · ENCRYPTED`, tp), W / 2, H / 2 + 30)
    ctx.restore()
  }

  function frame(now: number, dt: number): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    // Warming up under the curtain: draw everything (so it's all warm when it lifts) except the
    // boot banner and title decrypts, which wait for begin().
    const warming = born === Infinity
    const booting = !warming && now - born < BOOT_MS
    if (!warming) decode(now, booting)

    const r = stageRect()
    if (now >= colorCheck) {
      colorCheck = now + 400
      const s = document.querySelector('.stage')
      if (s) stageColor = rgb(getComputedStyle(s).getPropertyValue('--active-c'), accent)
    }

    // Everything below stays out of the terminal's text area.
    ctx.save()
    if (r) {
      ctx.beginPath()
      ctx.rect(0, 0, W, H)
      roundRectPath(ctx, { left: r.left + 3, top: r.top + 3, width: r.width - 6, height: r.height - 6 }, R - 2)
      ctx.clip('evenodd')
    }
    drawSparks(dt)
    ctx.restore()
    if (!document.querySelector('.stage.is-switching')) drawComets(now)
    if (!warming && !booting) drawShower(now, dt)

    if (booting) drawBoot(now)
  }

  function loop(now: number): void {
    if (stopped) return
    raf = requestAnimationFrame(loop)
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    frame(now, dt)
  }

  function run(): void {
    cancelAnimationFrame(raf)
    raf = 0
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (stopped || reduced || intensity <= 0 || document.hidden) return
    last = performance.now()
    raf = requestAnimationFrame(loop)
  }

  const onResize = () => {
    size()
    run()
  }
  const onVisibility = () => run()

  // For testing: start a shower now.
  ;(window as unknown as { __fxRain?: () => void }).__fxRain = () => startShower(performance.now())

  size()
  run()
  window.addEventListener('resize', onResize)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('keydown', onKey, true)

  return {
    setIntensity(n: number) {
      intensity = Math.max(0, Math.min(1, n))
      run()
    },
    begin() {
      // Fonts are loaded and the curtain is still down: draw the rain sprites now, not mid-show.
      if (!sprites.length && !reduced) buildSprites()
      if (born === Infinity) born = performance.now()
    },
    stop() {
      stopped = true
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('keydown', onKey, true)
      for (const el of decoding.keys()) {
        el.classList.remove('fx-decoding')
        el.removeAttribute('data-fx-text')
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
  }
}
