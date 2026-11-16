/**
 * The Matrix theme's backdrop: a messy, animated circuit-board HUD drawn on one full-window
 * canvas behind the app. The app's chrome is see-through in this theme, so the circuitry shows
 * around the panels; the terminals stay opaque, so it never runs behind code.
 *
 * Two layers:
 *  - static: traces, buses, chips, tangled wire and starburst hubs, specks and glyphs. Generated
 *    from a seeded random on resize and cached on an offscreen canvas (with a baked-in glow).
 *  - live: data pulses running along traces, flickering nodes, scrambling glyphs and HUD
 *    readouts, and every few seconds a short glitch tear. Its rate scales with `intensity`.
 */

export interface MatrixFx {
  setIntensity(intensity: number): void
  /** Force a glitch now (also exposed as window.__fxGlitch for poking at it). */
  glitch(): void
  /** A surge of activity (fired on every keystroke). */
  burst(): void
  stop(): void
}

interface Opts {
  intensity: number
  accent: string
}

type Pt = { x: number; y: number }
interface Trace {
  pts: Pt[]
  /** Cumulative length at each point. */
  acc: number[]
  len: number
}

const GLYPHS = 'ΑΒΓΔΘΛΞΠΣΦΨΩαβγδλμπσφψωアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン0123456789ABCDEF'
const TAGS = ['ERR.958', 'SYS//LINK', 'SIGNAL // λόγος', '0x3F·A1', 'NODE 07', 'TRACE ∆', 'BUS.4', 'SYNC', 'PKT', 'MEM 0xA4']
const GRID = 8

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function rgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [92, 255, 143]
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const DIRS: Pt[] = [
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0 },
  { x: -1, y: -1 },
  { x: 0, y: -1 },
  { x: 1, y: -1 }
]

function pointAt(t: Trace, d: number): Pt {
  const { pts, acc } = t
  let i = 1
  while (i < pts.length - 1 && acc[i] < d) i++
  const a = pts[i - 1]
  const b = pts[i]
  const seg = acc[i] - acc[i - 1] || 1
  const f = Math.max(0, Math.min(1, (d - acc[i - 1]) / seg))
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
}

export function startMatrix(canvas: HTMLCanvasElement, opts: Opts): MatrixFx {
  const ctx = canvas.getContext('2d')!
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  const [ar, ag, ab] = rgb(opts.accent)
  const col = (a: number) => `rgba(${ar},${ag},${ab},${a})`
  const hot = (a: number) => `rgba(${Math.min(255, ar + 120)},${Math.min(255, ag + 40)},${Math.min(255, ab + 110)},${a})`

  let intensity = Math.max(0, Math.min(1, opts.intensity))
  let W = 0
  let H = 0
  let dpr = 1
  let staticLayer: HTMLCanvasElement | null = null
  let bokeh: { x: number; y: number; r: number; v: number; a: number; ph: number }[] = []
  let bokehSprite: HTMLCanvasElement | null = null
  let traces: Trace[] = []
  let nodes: Pt[] = []
  let glyphs: { x: number; y: number; ch: string; size: number; a: number }[] = []
  let tags: { x: number; y: number; text: string; n: number }[] = []
  let pulses: { tr: number; d: number; v: number }[] = []
  let flashes: { x: number; y: number; age: number }[] = []
  let glitchUntil = 0
  let nextGlitch = 0
  let strips: { y: number; h: number; dx: number; tint: number }[] = []
  let raf = 0
  let boost = 0
  let flickerDebt = 0
  let hubs: Pt[] = []
  let rain: { x: number; y: number; v: number; len: number; chars: string[] }[] = []
  let rings: { x: number; y: number; age: number }[] = []
  let sweepY = -1
  let nextSweep = 0
  let nextElGlitch = 0
  const glitched = new Set<Element>()
  let last = 0
  let stopped = false
  const rand = Math.random

  // ---------------------------------------------------------------- static layer

  function build(): void {
    W = window.innerWidth
    H = window.innerHeight
    dpr = Math.min(1.5, window.devicePixelRatio || 1)
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
    canvas.style.width = `${W}px`
    canvas.style.height = `${H}px`

    const r = rng(0x5eed ^ (W * 31 + H))
    const area = (W * H) / 1e6
    const off = document.createElement('canvas')
    off.width = canvas.width
    off.height = canvas.height
    const g = off.getContext('2d')!
    g.scale(dpr, dpr)
    g.lineCap = 'round'
    g.lineJoin = 'round'
    traces = []
    nodes = []
    hubs = []

    const snap = (v: number) => Math.round(v / GRID) * GRID

    // Far layer: a dimmer, out-of-focus board behind the sharp one, for depth.
    {
      const far = document.createElement('canvas')
      far.width = off.width
      far.height = off.height
      const fg = far.getContext('2d')!
      fg.scale(dpr, dpr)
      fg.lineCap = 'round'
      const n = Math.round(320 * area)
      for (let i = 0; i < n; i++) {
        let x = snap(r() * W)
        let y = snap(r() * H)
        fg.strokeStyle = col(0.08 + r() * 0.18)
        fg.lineWidth = 1.4
        fg.beginPath()
        fg.moveTo(x, y)
        let dir = Math.floor(r() * 8)
        for (let k = 0; k < 3 + Math.floor(r() * 5); k++) {
          const len = (2 + Math.floor(r() * 8)) * GRID
          x += DIRS[dir].x * len
          y += DIRS[dir].y * len
          fg.lineTo(x, y)
          if (r() < 0.5) dir = (dir + (r() < 0.5 ? 1 : 7)) % 8
        }
        fg.stroke()
      }
      g.save()
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.filter = 'blur(2.5px)'
      g.drawImage(far, 0, 0)
      g.filter = 'none'
      g.restore()
    }

    // Circuit traces: grid-snapped polylines that bend by 45° now and then.
    const traceCount = Math.round(420 * area)
    for (let i = 0; i < traceCount; i++) {
      const pts: Pt[] = [{ x: snap(r() * W), y: snap(r() * H) }]
      let dir = Math.floor(r() * 4) * 2 // start straight
      const steps = 2 + Math.floor(r() * 7)
      for (let s = 0; s < steps; s++) {
        const p = pts[pts.length - 1]
        const n = (1 + Math.floor(r() * 6)) * GRID
        const d = DIRS[dir]
        pts.push({ x: p.x + d.x * n, y: p.y + d.y * n })
        if (r() < 0.55) dir = (dir + (r() < 0.5 ? 1 : 7)) % 8
      }
      const acc = [0]
      for (let k = 1; k < pts.length; k++) acc.push(acc[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y))
      traces.push({ pts, acc, len: acc[acc.length - 1] })
      g.strokeStyle = col(0.26 + r() * 0.4)
      g.lineWidth = r() < 0.15 ? 1.6 : 1
      g.beginPath()
      pts.forEach((p, k) => (k ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)))
      g.stroke()
      for (const end of [pts[0], pts[pts.length - 1]]) {
        nodes.push(end)
        if (r() < 0.5) {
          g.fillStyle = col(0.55)
          g.beginPath()
          g.arc(end.x, end.y, 1.7, 0, Math.PI * 2)
          g.fill()
        } else {
          g.strokeStyle = col(0.5)
          g.lineWidth = 1
          g.beginPath()
          g.arc(end.x, end.y, 2.6, 0, Math.PI * 2)
          g.stroke()
        }
      }
    }

    // Buses: bundles of parallel traces with a bend.
    const busCount = Math.round(60 * area)
    for (let i = 0; i < busCount; i++) {
      const k = 3 + Math.floor(r() * 5)
      const x0 = snap(r() * W)
      const y0 = snap(r() * H)
      const horiz = r() < 0.5
      const a = (2 + Math.floor(r() * 8)) * GRID
      const b = (2 + Math.floor(r() * 8)) * GRID
      const sx = r() < 0.5 ? 1 : -1
      const sy = r() < 0.5 ? 1 : -1
      g.strokeStyle = col(0.22 + r() * 0.25)
      g.lineWidth = 1
      for (let j = 0; j < k; j++) {
        const o = j * 4
        g.beginPath()
        if (horiz) {
          g.moveTo(x0, y0 + o)
          g.lineTo(x0 + sx * a, y0 + o)
          g.lineTo(x0 + sx * (a + b), y0 + o + sy * b)
          g.lineTo(x0 + sx * (a + b + a * 0.6), y0 + o + sy * b)
        } else {
          g.moveTo(x0 + o, y0)
          g.lineTo(x0 + o, y0 + sy * a)
          g.lineTo(x0 + o + sx * b, y0 + sy * (a + b))
          g.lineTo(x0 + o + sx * b, y0 + sy * (a + b + a * 0.6))
        }
        g.stroke()
      }
    }

    // Chips with pin rows.
    const chipCount = Math.round(26 * area)
    for (let i = 0; i < chipCount; i++) {
      const w = 12 + Math.floor(r() * 4) * 6
      const h = 8 + Math.floor(r() * 3) * 6
      const x = snap(r() * W)
      const y = snap(r() * H)
      g.fillStyle = 'rgba(2,8,5,0.9)'
      g.fillRect(x, y, w, h)
      g.strokeStyle = col(0.6)
      g.lineWidth = 1
      g.strokeRect(x + 0.5, y + 0.5, w, h)
      g.strokeStyle = col(0.45)
      for (let px = x + 3; px < x + w - 1; px += 4) {
        g.beginPath()
        g.moveTo(px, y)
        g.lineTo(px, y - 3)
        g.moveTo(px, y + h)
        g.lineTo(px, y + h + 3)
        g.stroke()
      }
      g.fillStyle = col(0.5)
      g.fillRect(x + 2, y + 2, 2, 2)
      nodes.push({ x: x + w / 2, y: y + h / 2 })
    }

    // Tangled wire: thin, faint curves everywhere...
    const wireCount = Math.round(800 * area)
    g.lineWidth = 0.6
    for (let i = 0; i < wireCount; i++) {
      const x = r() * W
      const y = r() * H
      const len = 40 + r() * 220
      const ang = r() * Math.PI * 2
      g.strokeStyle = col(0.06 + r() * 0.16)
      g.beginPath()
      g.moveTo(x, y)
      g.quadraticCurveTo(x + (r() - 0.5) * len, y + (r() - 0.5) * len, x + Math.cos(ang) * len, y + Math.sin(ang) * len)
      g.stroke()
    }
    // ...and starburst hubs where many of them meet.
    const hubCount = 6 + Math.round(5 * area)
    for (let i = 0; i < hubCount; i++) {
      const cx = r() * W
      const cy = r() * H
      const rays = 60 + Math.floor(r() * 60)
      for (let j = 0; j < rays; j++) {
        const ang = r() * Math.PI * 2
        const len = 30 + r() * 240
        g.strokeStyle = col(0.05 + r() * 0.16)
        g.lineWidth = 0.6
        g.beginPath()
        g.moveTo(cx, cy)
        g.quadraticCurveTo(
          cx + Math.cos(ang + 0.4) * len * 0.5,
          cy + Math.sin(ang + 0.4) * len * 0.5,
          cx + Math.cos(ang) * len,
          cy + Math.sin(ang) * len
        )
        g.stroke()
      }
      nodes.push({ x: cx, y: cy })
      hubs.push({ x: cx, y: cy })
    }

    // Specks.
    const speckCount = Math.round(1300 * area)
    for (let i = 0; i < speckCount; i++) {
      g.fillStyle = col(0.15 + r() * 0.6)
      g.beginPath()
      g.arc(r() * W, r() * H, 0.5 + r() * 1.1, 0, Math.PI * 2)
      g.fill()
    }

    // Faint glyphs baked in; a few more are drawn live so they can scramble.
    g.textBaseline = 'middle'
    const glyphCount = Math.round(180 * area)
    for (let i = 0; i < glyphCount; i++) {
      g.font = `${9 + Math.floor(r() * 5)}px "JetBrains Mono", monospace`
      g.fillStyle = col(0.06 + r() * 0.22)
      g.fillText(GLYPHS[Math.floor(r() * GLYPHS.length)], r() * W, r() * H)
    }
    glyphs = Array.from({ length: Math.round(60 * area) }, () => ({
      x: r() * W,
      y: r() * H,
      ch: GLYPHS[Math.floor(r() * GLYPHS.length)],
      size: 9 + Math.floor(r() * 5),
      a: 0.12 + r() * 0.3
    }))
    tags = Array.from({ length: 8 + Math.round(4 * area) }, () => ({
      x: r() * W,
      y: r() * H,
      text: TAGS[Math.floor(r() * TAGS.length)],
      n: Math.floor(r() * 1000)
    }))

    // Bake a soft glow: a blurred copy of everything, added on top.
    const glow = document.createElement('canvas')
    glow.width = off.width
    glow.height = off.height
    const gg = glow.getContext('2d')!
    gg.filter = 'blur(3px)'
    gg.drawImage(off, 0, 0)
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.globalCompositeOperation = 'lighter'
    g.globalAlpha = 0.95
    g.drawImage(glow, 0, 0)
    g.globalAlpha = 1
    g.globalCompositeOperation = 'source-over'
    // Clusters and voids: keep the board bright in patches and let it fall away into darkness
    // between them, instead of one even sheet.
    {
      const mask = document.createElement('canvas')
      mask.width = off.width
      mask.height = off.height
      const m = mask.getContext('2d')!
      m.scale(dpr, dpr)
      m.fillStyle = 'rgba(0,0,0,0.42)'
      m.fillRect(0, 0, W, H)
      const blobs = 7 + Math.round(6 * area)
      for (let i = 0; i < blobs; i++) {
        const x = r() * W
        const y = r() * H
        const rad = 160 + r() * 420
        const gr = m.createRadialGradient(x, y, 0, x, y, rad)
        gr.addColorStop(0, `rgba(0,0,0,${0.7 + r() * 0.3})`)
        gr.addColorStop(1, 'rgba(0,0,0,0)')
        m.fillStyle = gr
        m.fillRect(x - rad, y - rad, rad * 2, rad * 2)
      }
      g.save()
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.globalCompositeOperation = 'destination-in'
      g.drawImage(mask, 0, 0)
      g.restore()
    }
    staticLayer = off

    if (!bokehSprite) {
      bokehSprite = document.createElement('canvas')
      bokehSprite.width = bokehSprite.height = 64
      const b = bokehSprite.getContext('2d')!
      const bg = b.createRadialGradient(32, 32, 0, 32, 32, 32)
      bg.addColorStop(0, col(0.55))
      bg.addColorStop(0.55, col(0.22))
      bg.addColorStop(1, col(0))
      b.fillStyle = bg
      b.fillRect(0, 0, 64, 64)
    }
    bokeh = Array.from({ length: Math.round(14 + 14 * area) }, () => ({
      x: r() * W,
      y: r() * H,
      r: 6 + r() * 26,
      v: 4 + r() * 14,
      a: 0.25 + r() * 0.5,
      ph: r() * Math.PI * 2
    }))

    const usable = traces.map((t, i) => (t.len > 60 ? i : -1)).filter((i) => i >= 0)
    pulses = []
    const want = pulseTarget()
    for (let i = 0; i < want && usable.length; i++) pulses.push(newPulse(usable))
    flashes = []
    rain = []
    rings = []
  }

  const pulseTarget = () => Math.round(30 + 160 * intensity + boost)

  function newPulse(usable?: number[]): { tr: number; d: number; v: number } {
    const pool = usable ?? traces.map((t, i) => (t.len > 60 ? i : -1)).filter((i) => i >= 0)
    const tr = pool[Math.floor(rand() * pool.length)] ?? 0
    return { tr, d: 0, v: 170 + rand() * 300 }
  }

  // ---------------------------------------------------------------- live layer

  function frame(now: number, dt: number): void {
    if (!staticLayer) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(staticLayer, 0, 0)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // Pulses with fading trails.
    boost = Math.max(0, boost - dt * 50)
    while (pulses.length < pulseTarget()) pulses.push(newPulse())
    if (pulses.length > pulseTarget()) pulses.length = pulseTarget()
    ctx.globalCompositeOperation = 'lighter'
    for (let i = 0; i < pulses.length; i++) {
      const p = pulses[i]
      const t = traces[p.tr]
      if (!t) continue
      p.d += p.v * dt
      if (p.d >= t.len) {
        const end = t.pts[t.pts.length - 1]
        flashes.push({ x: end.x, y: end.y, age: 0 })
        pulses[i] = newPulse()
        continue
      }
      const head = pointAt(t, p.d)
      for (let k = 1; k <= 5; k++) {
        const q = pointAt(t, Math.max(0, p.d - k * 9))
        ctx.fillStyle = col(0.5 - k * 0.08)
        ctx.beginPath()
        ctx.arc(q.x, q.y, 1.4, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.fillStyle = hot(0.95)
      ctx.beginPath()
      ctx.arc(head.x, head.y, 1.8, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = col(0.18)
      ctx.beginPath()
      ctx.arc(head.x, head.y, 5, 0, Math.PI * 2)
      ctx.fill()
    }

    // Node flashes where pulses land, plus random flicker.
    flickerDebt += dt * (3 + 14 * intensity)
    for (; flickerDebt >= 1 && nodes.length; flickerDebt--) flashes.push({ ...nodes[Math.floor(rand() * nodes.length)], age: 0 })
    flashes = flashes.filter((f) => (f.age += dt) < 0.6)
    for (const f of flashes) {
      // Eases in and out instead of popping, so it reads as a glow, not a rendering error.
      const a = Math.sin((f.age / 0.6) * Math.PI)
      ctx.fillStyle = col(0.35 * a)
      ctx.beginPath()
      ctx.arc(f.x, f.y, 3 + 6 * (1 - a), 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = hot(0.9 * a)
      ctx.beginPath()
      ctx.arc(f.x, f.y, 1.6, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalCompositeOperation = 'source-over'

    drawRings(now, dt)
    drawRain(dt)
    drawSweep(now, dt)
    drawText(now, dt)
    drawAtmosphere(now, dt)
    drawGlitch(now)
    elementGlitch(now)
  }

  /** Falling columns of code. Heads are bright, tails fade; characters keep mutating. */
  const RAIN_STEP = 15
  const rainTarget = () => Math.round((W / RAIN_STEP) * (0.2 + 0.7 * intensity))
  function newDrop(top: boolean) {
    const len = 8 + Math.floor(rand() * 22)
    return {
      x: Math.floor(rand() * (W / RAIN_STEP)) * RAIN_STEP + 4,
      y: top ? -rand() * H * 0.6 : rand() * H,
      v: 220 + rand() * 620,
      len,
      chars: Array.from({ length: len }, () => GLYPHS[Math.floor(rand() * GLYPHS.length)])
    }
  }
  function drawRain(dt: number): void {
    while (rain.length < rainTarget()) rain.push(newDrop(rain.length > 0))
    if (rain.length > rainTarget()) rain.length = rainTarget()
    ctx.font = '600 14px "JetBrains Mono", monospace'
    ctx.textBaseline = 'middle'
    for (let i = 0; i < rain.length; i++) {
      const d = rain[i]
      d.y += d.v * dt
      for (let k = 0; k < d.len; k++) {
        const y = d.y - k * RAIN_STEP
        if (y < -RAIN_STEP || y > H + RAIN_STEP) continue
        if (rand() < dt * 1.2) d.chars[k] = GLYPHS[Math.floor(rand() * GLYPHS.length)]
        const a = Math.pow(1 - k / d.len, 1.4) * 0.95
        if (k === 0) {
          ctx.fillStyle = col(0.16)
          ctx.beginPath()
          ctx.arc(d.x + 4, y, 9, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.fillStyle = k === 0 ? 'rgba(235,255,240,1)' : k < 3 ? hot(0.9) : col(a)
        ctx.fillText(d.chars[k], d.x, y)
      }
      if (d.y - d.len * RAIN_STEP > H) rain[i] = newDrop(true)
    }
  }

  /** Out-of-focus lights drifting up through the board. */
  function drawAtmosphere(now: number, dt: number): void {
    const t = now / 1000
    if (bokehSprite) {
      ctx.globalCompositeOperation = 'lighter'
      for (const b of bokeh) {
        b.y -= b.v * dt
        if (b.y < -b.r * 2) {
          b.y = H + b.r * 2
          b.x = rand() * W
        }
        ctx.globalAlpha = b.a * (0.6 + 0.4 * Math.sin(t * 0.9 + b.ph))
        ctx.drawImage(bokehSprite, b.x - b.r, b.y - b.r, b.r * 2, b.r * 2)
      }
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
    }
  }

  /** Shockwave rings that pop out of the starburst hubs. */
  function drawRings(now: number, dt: number): void {
    if (hubs.length && rand() < dt * (0.6 + 3 * intensity)) rings.push({ ...hubs[Math.floor(rand() * hubs.length)], age: 0 })
    rings = rings.filter((r) => (r.age += dt) < 0.9)
    ctx.lineWidth = 1.2
    for (const r of rings) {
      const f = r.age / 0.9
      ctx.strokeStyle = col(0.55 * (1 - f))
      ctx.beginPath()
      ctx.arc(r.x, r.y, 6 + 150 * f, 0, Math.PI * 2)
      ctx.stroke()
    }
    void now
  }

  /** Every few seconds a bright scan band sweeps down the screen. */
  function drawSweep(now: number, dt: number): void {
    if (sweepY < 0) {
      if (now >= nextSweep) {
        if (nextSweep) sweepY = 0
        nextSweep = now + (9000 - 6000 * intensity) * (0.7 + rand() * 0.6)
      }
      return
    }
    sweepY += (900 + 700 * intensity) * dt
    const grad = ctx.createLinearGradient(0, sweepY - 60, 0, sweepY)
    grad.addColorStop(0, col(0))
    grad.addColorStop(1, col(0.16))
    ctx.globalCompositeOperation = 'lighter'
    ctx.fillStyle = grad
    ctx.fillRect(0, sweepY - 60, W, 60)
    ctx.fillStyle = hot(0.4)
    ctx.fillRect(0, sweepY, W, 1)
    ctx.globalCompositeOperation = 'source-over'
    if (sweepY > H + 60) sweepY = -1
  }

  /** One random piece of chrome text glitches at a time, never everything together. */
  const GLITCH_TARGETS = '.stack-wordmark, .header-title, .bb-title, .slot-badge-text, .park-title, .bb-hint, .header-cwd'
  function elementGlitch(now: number): void {
    if (reduced || intensity <= 0 || now < nextElGlitch) return
    if (nextElGlitch) {
      const els = [...document.querySelectorAll(GLITCH_TARGETS)].filter((e) => !glitched.has(e))
      const el = els[Math.floor(rand() * els.length)]
      if (el) {
        glitched.add(el)
        el.classList.add('fx-glitch-el')
        window.setTimeout(() => {
          el.classList.remove('fx-glitch-el')
          glitched.delete(el)
        }, 120 + rand() * 160)
      }
    }
    nextElGlitch = now + (9000 - 5000 * intensity) * (0.6 + rand() * 0.8)
  }

  /** Scrambling glyphs and HUD readouts (also drawn once when the layer is still). */
  function drawText(now: number, dt = 0): void {
    ctx.textBaseline = 'middle'
    const scramble = 0.02 + 0.08 * intensity
    for (const gl of glyphs) {
      if (rand() < scramble * dt * 8) gl.ch = GLYPHS[Math.floor(rand() * GLYPHS.length)]
      ctx.font = `${gl.size}px "JetBrains Mono", monospace`
      ctx.fillStyle = col(gl.a)
      ctx.fillText(gl.ch, gl.x, gl.y)
    }
    ctx.font = '9px "JetBrains Mono", monospace'
    for (const t of tags) {
      if (rand() < dt * (1 + 3 * intensity)) t.n = (t.n + 1 + Math.floor(rand() * 7)) % 1000
      const pct = (90 + (t.n % 100) / 10).toFixed(1)
      ctx.fillStyle = col(0.55)
      ctx.fillText(`${t.text} ${t.text.includes('//') || t.text === 'SYNC' ? pct + '%' : t.n.toString().padStart(3, '0')}`, t.x, t.y)
    }
    void now
  }

  function startGlitch(now: number): void {
    glitchUntil = now + 90 + rand() * 130
    strips = Array.from({ length: 2 + Math.floor(rand() * 4) }, () => ({
      y: rand() * H,
      h: 2 + rand() * 18,
      dx: (rand() - 0.5) * 60,
      tint: rand()
    }))
  }

  function drawGlitch(now: number): void {
    if (now >= glitchUntil) {
      if (strips.length) strips = []
      if (intensity > 0 && !reduced && now >= nextGlitch) {
        if (nextGlitch) startGlitch(now)
        nextGlitch = now + (11000 - 6000 * intensity) * (0.6 + rand() * 0.8)
      }
      return
    }
    if (!staticLayer) return
    // Tear: shift a few horizontal strips sideways, tinted red or cyan, with bright scan lines.
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    for (const s of strips) {
      const y = Math.round(s.y * dpr)
      const h = Math.max(1, Math.round(s.h * dpr))
      ctx.drawImage(canvas, 0, y, canvas.width, h, Math.round(s.dx * dpr), y, canvas.width, h)
      ctx.globalCompositeOperation = 'lighter'
      ctx.fillStyle = s.tint < 0.5 ? 'rgba(255,40,90,0.16)' : 'rgba(40,220,255,0.16)'
      ctx.fillRect(0, y, canvas.width, h)
      ctx.fillStyle = hot(0.35)
      ctx.fillRect(0, y, canvas.width, Math.max(1, Math.round(dpr)))
      ctx.globalCompositeOperation = 'source-over'
    }
  }

  // ---------------------------------------------------------------- loop

  // Draw on every display frame: capping the rate below the refresh rate skips frames unevenly,
  // which reads as stutter. All motion is time-based, so speed doesn't depend on the refresh rate.
  function loop(now: number): void {
    if (stopped) return
    raf = requestAnimationFrame(loop)
    const dt = (now - last) / 1000
    last = now
    // Real elapsed time, so a late frame jumps ahead instead of slowing everything down.
    // Only a long gap (tab switched back, laptop woke) is capped.
    frame(now, Math.min(0.25, dt))
  }

  function drawStill(): void {
    if (!staticLayer) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(staticLayer, 0, 0)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawText(performance.now())
    drawAtmosphere(performance.now(), 0)
  }

  function run(): void {
    cancelAnimationFrame(raf)
    raf = 0
    if (stopped) return
    if (reduced || intensity <= 0 || document.hidden) {
      drawStill()
      return
    }
    last = performance.now()
    raf = requestAnimationFrame(loop)
  }

  let resizeTimer = 0
  const onResize = () => {
    window.clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(() => {
      build()
      run()
    }, 150)
  }
  const onVisibility = () => run()

  const glitch = () => startGlitch(performance.now())
  ;(window as unknown as { __fxGlitch?: () => void }).__fxGlitch = glitch

  build()
  run()
  window.addEventListener('resize', onResize)
  document.addEventListener('visibilitychange', onVisibility)

  return {
    setIntensity(n: number) {
      intensity = Math.max(0, Math.min(1, n))
      run()
    },
    glitch,
    burst() {
      if (intensity <= 0 || reduced) return
      boost = Math.min(160, boost + 14)
      for (let i = 0; i < 10; i++) pulses.push({ ...newPulse(), v: 600 + rand() * 600 })
      if (hubs.length && rand() < 0.5) rings.push({ ...hubs[Math.floor(rand() * hubs.length)], age: 0 })
    },
    stop() {
      stopped = true
      cancelAnimationFrame(raf)
      window.clearTimeout(resizeTimer)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisibility)
      for (const el of glitched) el.classList.remove('fx-glitch-el')
      glitched.clear()
      delete (window as unknown as { __fxGlitch?: () => void }).__fxGlitch
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
  }
}
