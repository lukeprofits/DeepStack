/**
 * The Matrix theme's foreground: effects that sit on top of the app, right where you look, but
 * never over terminal text (the big terminal's inside is clipped out, except during the brief
 * boot sequence).
 *
 *  - comets orbiting the big terminal's border, in the active session's colour
 *  - sparks thrown off that border on every keystroke (`onKey` also fires a backdrop burst)
 *  - titles that decrypt through random glyphs when they change
 *  - a boot sequence on load: the screen opens from the centre and "// SYSTEM ONLINE" decrypts
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
}

const SCRAMBLE = 'ΑΒΓΔΘΛΞΠΣΦΨΩアイウエオカキクケコサシスセソタチツテト0123456789ABCDEF#$%&*<>/\\'
const DECODE_TARGETS = ['.header-title:not(.header-title-input)', '.stack-wordmark']
const STAGE_R = 10 // the stage's corner radius
const R = STAGE_R
const THUMB_R = 6 // a thumbnail's corner radius

type Rect = { left: number; top: number; width: number; height: number }

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
    if (intensity <= 0 || e.repeat || e.metaKey) return
    opts.onKey()
    const r = stageRect()
    if (!r) return
    const n = Math.round(10 + 16 * intensity)
    const p = perimeter(r, Math.random() * perimLength(r))
    for (let i = 0; i < n; i++) {
      const spread = (Math.random() - 0.5) * 1.6
      const a = Math.atan2(p.ny, p.nx) + spread
      const v = 160 + Math.random() * 260
      sparks.push({ x: p.x, y: p.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, age: 0, life: 0.5 + Math.random() * 0.5 })
    }
    if (sparks.length > 400) sparks.splice(0, sparks.length - 400)
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

  /** Comets orbiting the active session's thumbnail in the stack, in its colour. */
  function drawComets(now: number): void {
    const mini = document.querySelector('.slot.is-big:not(.is-dragging) .mini')
    const list = mini?.closest('.stack-list, .park-list')?.getBoundingClientRect()
    const m = mini?.getBoundingClientRect()
    if (!m || !list || m.width < 20 || m.bottom < list.top || m.top > list.bottom) return
    const r: Rect = { left: m.left + 1, top: m.top + 1, width: m.width - 2, height: m.height - 2 }
    const [cr, cg, cb] = stageColor
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
      const head = ((now / period + c / count) % 1) * L
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
