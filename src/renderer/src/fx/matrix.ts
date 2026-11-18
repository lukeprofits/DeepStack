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
import { fxField } from '../lib/fxField'

export interface MatrixFx {
  setIntensity(intensity: number): void
  /** Whether typing tears and shakes the chrome (the backdrop still livens up either way). */
  setTypingGlitch(on: boolean): void
  /** Custom banner texts (empty: "HACKING..."). */
  setHackTexts(texts: string[]): void
  /** Force a glitch now (also exposed as window.__fxGlitch for poking at it). */
  glitch(): void
  /** A surge of activity (fired on every keystroke). */
  burst(): void
  /** The current parallax offset, about -1.5..1.5 each way (for layers drawn elsewhere, like the overlay). */
  parallax(): [number, number]
  stop(): void
}

interface Opts {
  intensity: number
  accent: string
  typingGlitch?: boolean
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
/** Extra board drawn past each edge so parallax never reveals an edge. */
const OVERSCAN = 200
/** How far each depth travels (px) at full pointer deflection: further away moves less. */
// Far things barely move, near things swing a long way: the spread is what reads as depth.
const DEPTH = { far: 6, fog: 22, near: 34, bokehMin: 30, bokehMax: 125 }
/** How far the mouse swings the parallax: 1 = each depth travels its DEPTH px at the screen edge. */
const PARALLAX_GAIN = 1.5
/** Raining code on three planes: far (small, dim, slow, nearly still), mid, near (big, bright, fast). */
/**
 * Now and then a rain streak glitches: a red / cyan chromatic split on its glyphs and a run of
 * them torn sideways, re-rolled every `step` ms for `ms`. `rate` is starts per streak per second
 * at rest (~3% glitching at once); mouse speed and typing multiply it. split/tear are px at the
 * mid plane (near splits wider, far narrower).
 */
const RAIN_GLITCH = { rate: 0.17, ms: [90, 260], step: [35, 70], split: [1.5, 4.5], tear: [4, 14] }
const RAIN_PLANES = [
  { share: 0.22, size: 10, step: 11, alpha: 0.24, speed: 0.55, depth: 14, glow: false },
  { share: 0.43, size: 14, step: 15, alpha: 0.75, speed: 1, depth: 52, glow: true },
  { share: 0.35, size: 21, step: 22, alpha: 1, speed: 1.6, depth: 110, glow: true }
]

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
  /** The blurred far board, drawn on its own so it can move less than the near one. */
  let farLayer: HTMLCanvasElement | null = null
  /** Floating fragments of circuit board, each at its own depth (sorted far to near). */
  let pieces: { c: HTMLCanvasElement; x: number; y: number; rot: number; dpx: number; bob: number; per: number; ph: number }[] = []
  /** Viewport size; W/H are the layer space, bigger by OVERSCAN on every side for parallax. */
  let VW = 0
  let VH = 0
  // Parallax: the HUD stays put and the world behind it shifts with the pointer (plus a slow
  // idle drift), each depth by its own amount. px/py run about -1.5..1.5 (PARALLAX_GAIN), eased toward the target.
  let px = 0
  let py = 0
  let tx = 0
  let ty = 0
  /**
   * Excitement from mouse speed, 0..1: snaps up fast when you move, then sinks back slowly.
   * Brightens the board and pieces, quickens the pulses, and (via --fx-excite) the HUD glow.
   */
  let excite = 0
  let exciteKick = 0
  let lastPtr: { x: number; y: number; t: number } | null = null
  let exciteMain: HTMLElement | null = null
  let exciteShown = -1
  let shadowAt = 0
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
  /** g*: the streak's glitch (see RAIN_GLITCH): ends at gUntil, re-rolls at gNext; glyphs gA..gB tear by gT. */
  let rain: { x: number; y: number; v: number; len: number; chars: string[]; z: number; gUntil: number; gNext: number; gDx: number; gA: number; gB: number; gT: number }[] = []
  let rings: { x: number; y: number; age: number }[] = []
  let sweepY = -1
  let nextSweep = 0
  let nextElGlitch = 0
  const glitched = new Set<Element>()
  let last = 0
  let stopped = false
  const rand = Math.random

  // ---------------------------------------------------------------- static layer

  /** One broken fragment of circuit board: a chipped plate with its own traces, buses and chips. */
  type Shape = 'shard' | 'ell' | 'strip' | 'fracture' | 'connector' | 'round' | 'chipped'
  const SHAPES: Shape[] = ['shard', 'shard', 'ell', 'strip', 'fracture', 'fracture', 'connector', 'round', 'chipped']

  /** A ragged break line from (x0,y0) to (x1,y1): what's left where a board snapped. */
  function breakLine(path: Path2D, r: () => number, x0: number, y0: number, x1: number, y1: number, rough: number): void {
    const n = 3 + Math.floor(r() * 5)
    const nx = -(y1 - y0)
    const ny = x1 - x0
    const len = Math.hypot(nx, ny) || 1
    for (let i = 1; i < n; i++) {
      const t = i / n + (r() - 0.5) * (0.6 / n)
      const off = (r() - 0.5) * 2 * rough
      path.lineTo(x0 + (x1 - x0) * t + (nx / len) * off, y0 + (y1 - y0) * t + (ny / len) * off)
    }
    path.lineTo(x1, y1)
  }

  function shapePath(r: () => number, shape: Shape, w: number, h: number): Path2D {
    const p = new Path2D()
    const rough = Math.min(w, h) * 0.12
    switch (shape) {
      case 'shard': {
        // A broken shard: an irregular polygon around an ellipse.
        const n = 5 + Math.floor(r() * 5)
        const start = r() * Math.PI * 2
        for (let i = 0; i < n; i++) {
          const a = start + (i / n) * Math.PI * 2 + (r() - 0.5) * (1.6 / n)
          const k = 0.55 + r() * 0.45
          const x = w / 2 + Math.cos(a) * (w / 2) * k
          const y = h / 2 + Math.sin(a) * (h / 2) * k
          if (i) p.lineTo(x, y)
          else p.moveTo(x, y)
        }
        break
      }
      case 'ell': {
        // An L: a full board with one corner block missing.
        const cx = w * (0.4 + r() * 0.3)
        const cy = h * (0.4 + r() * 0.3)
        const corner = Math.floor(r() * 4)
        const pts =
          corner === 0 ? [[cx, 0], [w, 0], [w, h], [0, h], [0, cy], [cx, cy]]
          : corner === 1 ? [[0, 0], [w - cx, 0], [w - cx, cy], [w, cy], [w, h], [0, h]]
          : corner === 2 ? [[0, 0], [w, 0], [w, h - cy], [w - cx, h - cy], [w - cx, h], [0, h]]
          : [[0, 0], [w, 0], [w, h], [cx, h], [cx, h - cy], [0, h - cy]]
        pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)))
        break
      }
      case 'strip': {
        // A long thin board snapped at both ends.
        p.moveTo(0, 0)
        p.lineTo(w, 0)
        breakLine(p, r, w, 0, w - r() * 20, h, h * 0.3)
        p.lineTo(0, h)
        breakLine(p, r, 0, h, r() * 20, 0, h * 0.3)
        break
      }
      case 'fracture': {
        // A board with one or two edges broken off along a jagged line.
        const top = r() < 0.5
        const right = r() < 0.6
        p.moveTo(0, 0)
        if (top) breakLine(p, r, 0, 0, w, 0, rough)
        else p.lineTo(w, 0)
        if (right) breakLine(p, r, w, 0, w, h, rough)
        else p.lineTo(w, h)
        p.lineTo(0, h)
        break
      }
      case 'connector': {
        // An edge-connector card: a tab with gold-finger pads along the bottom.
        const tab = w * (0.35 + r() * 0.35)
        const tx = (w - tab) * r()
        const th = 10 + r() * 8
        p.moveTo(0, 0)
        p.lineTo(w, 0)
        p.lineTo(w, h - th)
        p.lineTo(tx + tab, h - th)
        p.lineTo(tx + tab, h)
        p.lineTo(tx, h)
        p.lineTo(tx, h - th)
        p.lineTo(0, h - th)
        break
      }
      case 'round': {
        p.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
        break
      }
      default: {
        const cut = () => 6 + r() * 22
        const [a1, a2, a3, a4] = [cut(), cut(), cut(), cut()]
        p.moveTo(a1, 0)
        p.lineTo(w - a2, 0)
        p.lineTo(w, a2)
        p.lineTo(w, h - a3)
        p.lineTo(w - a3, h)
        p.lineTo(a4, h)
        p.lineTo(0, h - a4)
        p.lineTo(0, a1)
      }
    }
    p.closePath()
    return p
  }

  function makePiece(r: () => number, z: number) {
    const s = 0.6 + 0.9 * z
    const shape = SHAPES[Math.floor(r() * SHAPES.length)]
    // Sizes and proportions vary a lot: tiny chips of board to big slabs, long strips, discs.
    const big = r() < 0.25 ? 1.6 : r() < 0.35 ? 0.55 : 1
    let w = (120 + r() * 320) * big
    let h = (80 + r() * 230) * big
    if (shape === 'strip') {
      w = (260 + r() * 360) * big
      h = 34 + r() * 50
    } else if (shape === 'round') h = w = (110 + r() * 200) * big
    const b = 0.3 + 0.7 * z
    // Depth of field focused up front: the farther a piece, the softer; near pieces are crisp.
    const blur = z < 0.55 ? ((0.55 - z) / 0.55) * 4.5 : 0
    const pad = 10 + blur * 3
    const c = document.createElement('canvas')
    c.width = Math.ceil((w * s + pad * 2) * dpr)
    c.height = Math.ceil((h * s + pad * 2) * dpr)
    const g = c.getContext('2d')!
    g.setTransform(dpr * s, 0, 0, dpr * s, pad * dpr, pad * dpr)
    g.lineCap = 'round'
    g.lineJoin = 'round'
    const plate = shapePath(r, shape, w, h)
    g.fillStyle = col(0.03 + 0.05 * b)
    g.fill(plate)
    g.save()
    g.clip(plate)
    const snap = (v: number) => Math.round(v / GRID) * GRID
    const n = Math.round((w * h) / 2200)
    for (let i = 0; i < n; i++) {
      let x = snap(r() * w)
      let y = snap(r() * h)
      g.strokeStyle = col((0.3 + 0.5 * r()) * b)
      g.lineWidth = r() < 0.2 ? 1.7 : 1
      g.beginPath()
      g.moveTo(x, y)
      let dir = Math.floor(r() * 4) * 2
      for (let k = 0; k < 2 + Math.floor(r() * 5); k++) {
        const len = (1 + Math.floor(r() * 6)) * GRID
        x += DIRS[dir].x * len
        y += DIRS[dir].y * len
        g.lineTo(x, y)
        if (r() < 0.5) dir = (dir + (r() < 0.5 ? 1 : 7)) % 8
      }
      g.stroke()
      g.fillStyle = col(0.7 * b)
      g.beginPath()
      g.arc(x, y, 1.7, 0, Math.PI * 2)
      g.fill()
    }
    // A bus bundle and a chip or two.
    for (let i = 0; i < 1 + Math.floor(r() * 2); i++) {
      const x0 = snap(r() * w * 0.7)
      const y0 = snap(r() * h)
      const len = 40 + r() * w * 0.5
      g.strokeStyle = col(0.45 * b)
      g.lineWidth = 1
      for (let j = 0; j < 3 + Math.floor(r() * 4); j++) {
        g.beginPath()
        g.moveTo(x0, y0 + j * 4)
        g.lineTo(x0 + len, y0 + j * 4)
        g.lineTo(x0 + len + 14, y0 + j * 4 + 14)
        g.stroke()
      }
    }
    for (let i = 0; i < Math.floor(r() * 3); i++) {
      const cw = 16 + Math.floor(r() * 4) * 6
      const ch = 10 + Math.floor(r() * 3) * 6
      const x = snap(r() * (w - cw))
      const y = snap(r() * (h - ch))
      g.fillStyle = 'rgba(2,8,5,0.95)'
      g.fillRect(x, y, cw, ch)
      g.strokeStyle = col(0.75 * b)
      g.strokeRect(x + 0.5, y + 0.5, cw, ch)
      for (let px = x + 3; px < x + cw - 1; px += 4) {
        g.beginPath()
        g.moveTo(px, y)
        g.lineTo(px, y - 3)
        g.moveTo(px, y + ch)
        g.lineTo(px, y + ch + 3)
        g.stroke()
      }
    }
    if (r() < 0.45) {
      g.font = '8px "JetBrains Mono", monospace'
      g.fillStyle = col(0.5 * b)
      g.fillText(`PCB-${Math.floor(r() * 0xffff).toString(16).toUpperCase().padStart(4, '0')}`, 8, h - 8)
    }
    g.restore()
    // Its broken edge, brighter along the top like light catching it.
    g.strokeStyle = col(0.4 * b)
    g.lineWidth = 1
    g.stroke(plate)
    // Light catching the upper edges.
    g.save()
    g.beginPath()
    g.rect(-4, -4, w + 8, h * 0.35 + 4)
    g.clip()
    g.strokeStyle = hot(0.35 * b)
    g.stroke(plate)
    g.restore()
    if (shape === 'connector') {
      // Gold-finger pads on the tab.
      g.fillStyle = hot(0.45 * b)
      g.save()
      g.clip(plate)
      for (let x = 0; x < w; x += 7) g.fillRect(x + 2, h - 9, 3, 7)
      g.restore()
    }

    // Glow, then depth-of-field blur for the far and the very near pieces.
    const out = document.createElement('canvas')
    out.width = c.width
    out.height = c.height
    const o = out.getContext('2d')!
    if (blur > 0) o.filter = `blur(${(blur * dpr).toFixed(1)}px)`
    o.drawImage(c, 0, 0)
    o.filter = `blur(${(3 * dpr).toFixed(1)}px)`
    o.globalCompositeOperation = 'lighter'
    o.globalAlpha = 0.6
    o.drawImage(c, 0, 0)
    return out
  }

  function buildPieces(r: () => number) {
    const n = Math.round(18 + 10 * Math.min(2, (W * H) / 1e6))
    const list = Array.from({ length: n }, () => {
      const z = r()
      return {
        c: makePiece(r, z),
        x: r() * W,
        y: r() * H,
        rot: (r() - 0.5) * (r() < 0.3 ? 1.1 : 0.3),
        dpx: 4 + 126 * z,
        bob: 2 + 6 * z,
        per: 8000 + r() * 9000,
        ph: r() * Math.PI * 2
      }
    })
    // A cluster of near pieces down the left: the stack shows a lot of board between its
    // thumbnails, so close fragments there make the depth obvious.
    const side = document.querySelector('.sidebar')?.getBoundingClientRect().width ?? 300
    for (let i = 0; i < 7; i++) {
      const z = 0.72 + r() * 0.26
      list.push({
        c: makePiece(r, z),
        x: OVERSCAN + r() * side,
        y: OVERSCAN + ((i + r()) / 7) * (H - 2 * OVERSCAN),
        rot: (r() - 0.5) * 0.3,
        dpx: 4 + 126 * z,
        bob: 2 + 6 * z,
        per: 8000 + r() * 9000,
        ph: r() * Math.PI * 2
      })
    }
    return list.sort((a, b) => a.dpx - b.dpx)
  }

  /** Draw the pieces whose depth falls in [lo, hi), so they interleave with the rain planes. */
  function drawPieces(now: number, lo: number, hi: number): void {
    for (const p of pieces) {
      if (p.dpx < lo || p.dpx >= hi) continue
      const [ox, oy] = offset(p.dpx)
      const by = Math.sin((now / p.per) * Math.PI * 2 + p.ph) * p.bob
      ctx.setTransform(1, 0, 0, 1, ox + p.x * dpr, oy + (p.y + by) * dpr)
      ctx.rotate(p.rot)
      ctx.drawImage(p.c, -p.c.width / 2, -p.c.height / 2)
      if (excite > 0.03) {
        ctx.globalCompositeOperation = 'lighter'
        ctx.globalAlpha = 0.9 * excite
        ctx.drawImage(p.c, -p.c.width / 2, -p.c.height / 2)
        ctx.globalAlpha = 1
        ctx.globalCompositeOperation = 'source-over'
      }
    }
  }

  function build(): void {
    VW = window.innerWidth
    VH = window.innerHeight
    W = VW + 2 * OVERSCAN
    H = VH + 2 * OVERSCAN
    dpr = Math.min(1.5, window.devicePixelRatio || 1)
    canvas.width = Math.round(VW * dpr)
    canvas.height = Math.round(VH * dpr)
    canvas.style.width = `${VW}px`
    canvas.style.height = `${VH}px`

    const r = rng(0x5eed ^ (W * 31 + H))
    const area = (W * H) / 1e6
    const off = document.createElement('canvas')
    off.width = Math.round(W * dpr)
    off.height = Math.round(H * dpr)
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
      const blurred = document.createElement('canvas')
      blurred.width = far.width
      blurred.height = far.height
      const bg = blurred.getContext('2d')!
      bg.filter = 'blur(4px)'
      bg.drawImage(far, 0, 0)
      farLayer = blurred
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
      m.fillStyle = 'rgba(0,0,0,0.16)'
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
      const fgc = farLayer?.getContext('2d')
      if (fgc) {
        fgc.globalCompositeOperation = 'destination-in'
        fgc.drawImage(mask, 0, 0)
        fgc.globalCompositeOperation = 'source-over'
      }
    }
    staticLayer = off
    pieces = buildPieces(r)

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

  const pulseTarget = () => Math.round(20 + 80 * intensity + boost + 70 * excite)

  function newPulse(usable?: number[]): { tr: number; d: number; v: number } {
    const pool = usable ?? traces.map((t, i) => (t.len > 60 ? i : -1)).filter((i) => i >= 0)
    const tr = pool[Math.floor(rand() * pool.length)] ?? 0
    return { tr, d: 0, v: 70 + rand() * 120 }
  }

  // ---------------------------------------------------------------- live layer

  function frame(now: number, dt: number): void {
    if (!staticLayer) return
    updateParallax(now, dt)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    drawFar()
    drawPieces(now, 0, 14)
    drawRain(dt, 0)
    drawPieces(now, 14, DEPTH.near)
    drawBase()
    depth(DEPTH.near)

    // Pulses with fading trails.
    boost = Math.max(0, boost - dt * 50)
    while (pulses.length < pulseTarget()) pulses.push(newPulse())
    if (pulses.length > pulseTarget()) pulses.length = pulseTarget()
    ctx.globalCompositeOperation = 'lighter'
    for (let i = 0; i < pulses.length; i++) {
      const p = pulses[i]
      const t = traces[p.tr]
      if (!t) continue
      p.d += p.v * dt * (1 + 1.4 * excite)
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
    flickerDebt += dt * (1 + 5 * intensity)
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
    drawPieces(now, DEPTH.near, 52)
    drawRain(dt, 1)
    drawPieces(now, 52, 110)
    drawRain(dt, 2)
    drawPieces(now, 110, Infinity)
    depth(DEPTH.near)
    drawSweep(now, dt)
    drawText(now, dt)
    drawAtmosphere(now, dt)
    drawWave(now, dt)
    drawGlitch(now)
    drawField(now)
    elementGlitch(now)
  }

  /**
   * The force field around a window swinging on its hinge (lib/fxField, written by Stage): the
   * backdrop around it ripples in thin strips like heat haze, and now and then a strip tears.
   */
  /** Per frame: a copy of the region (sliced into strips), and the rippled result (feathered,
      then cross-faded back over the board). */
  let fieldBuf: HTMLCanvasElement | null = null
  let fieldOut: HTMLCanvasElement | null = null
  const sized = (c: HTMLCanvasElement) => {
    if (c.width < canvas.width || c.height < canvas.height) {
      c.width = canvas.width
      c.height = canvas.height
    }
    return c.getContext('2d')
  }
  function drawField(now: number): void {
    for (const f of fxField) {
      if (f.s < 0.02 || reduced) continue
      // The field reaches well past the window, and fades out to nothing at its edge.
      const pad = 140
      const x0 = Math.max(0, Math.floor((f.x0 - pad) * dpr))
      const x1 = Math.min(canvas.width, Math.ceil((f.x1 + pad) * dpr))
      const y0 = Math.max(0, Math.floor((f.y0 - pad) * dpr))
      const y1 = Math.min(canvas.height, Math.ceil((f.y1 + pad) * dpr))
      if (x1 - x0 < 4 || y1 - y0 < 4) continue
      const w = x1 - x0
      const hh = y1 - y0
      fieldBuf ??= document.createElement('canvas')
      fieldOut ??= document.createElement('canvas')
      const fb = sized(fieldBuf)
      const fo = sized(fieldOut)
      if (!fb || !fo) continue
      fb.clearRect(0, 0, w, hh)
      fb.drawImage(canvas, x0, y0, w, hh, 0, 0, w, hh)
      // The rippled region: the copy, with strips slid sideways (heat haze, now and then a tear).
      fo.globalCompositeOperation = 'copy'
      fo.drawImage(fieldBuf, 0, 0, w, hh, 0, 0, w, hh)
      fo.globalCompositeOperation = 'source-over'
      for (let y = 0; y < hh; ) {
        const h = Math.max(1, Math.round((8 + rand() * 16) * dpr))
        const yy = (y + y0) / dpr
        const wave = Math.sin(yy * 0.05 + now * 0.011) * 6 + Math.sin(yy * 0.013 - now * 0.007) * 4
        const tear = rand() < 0.05 ? (rand() - 0.5) * 70 : 0
        const dx = Math.round((wave + tear) * f.s * dpr)
        if (dx) {
          fo.clearRect(0, y, w, h)
          fo.drawImage(fieldBuf, 0, y, w, h, dx, y, w, h)
          const gx = dx > 0 ? 0 : w + dx
          fo.drawImage(fieldBuf, gx, y, Math.abs(dx), h, gx, y, Math.abs(dx), h)
        }
        y += h
      }
      // Feather it like a mask: an oval that's solid in the middle and fades to nothing at the
      // region's edge, so the ripple never shows a hard line.
      const feather = () => {
        const g = fo.createRadialGradient(0, 0, 0, 0, 0, 1)
        g.addColorStop(0, 'rgba(0,0,0,1)')
        g.addColorStop(0.62, 'rgba(0,0,0,1)')
        g.addColorStop(1, 'rgba(0,0,0,0)')
        return g
      }
      const oval = (c: CanvasRenderingContext2D, ox: number, oy: number) => {
        c.save()
        c.translate(ox + w / 2, oy + hh / 2)
        c.scale(w / 2, hh / 2)
        c.fillStyle = feather()
        c.fillRect(-1, -1, 2, 2)
        c.restore()
      }
      fo.globalCompositeOperation = 'destination-in'
      oval(fo, 0, 0)
      fo.globalCompositeOperation = 'source-over'
      // Cross-fade: take the board out by the mask, add the rippled copy back in by the mask.
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalCompositeOperation = 'destination-out'
      oval(ctx, x0, y0)
      ctx.globalCompositeOperation = 'lighter'
      ctx.drawImage(fieldOut, 0, 0, w, hh, x0, y0, w, hh)
      ctx.restore()
    }
  }

  /** Falling columns of code. Heads are bright, tails fade; characters keep mutating. */
  const rainTarget = () => Math.round((W / 15) * (0.2 + 0.6 * intensity))
  function newDrop(top: boolean) {
    const roll = rand()
    const z = roll < RAIN_PLANES[0].share ? 0 : roll < RAIN_PLANES[0].share + RAIN_PLANES[1].share ? 1 : 2
    const pl = RAIN_PLANES[z]
    const len = 8 + Math.floor(rand() * 22)
    return {
      x: Math.floor(rand() * (W / pl.step)) * pl.step + 4,
      y: top ? -rand() * H * 0.6 : rand() * H,
      v: (170 + rand() * 280) * pl.speed,
      len,
      z,
      chars: Array.from({ length: len }, () => GLYPHS[Math.floor(rand() * GLYPHS.length)]),
      gUntil: 0,
      gNext: 0,
      gDx: 0,
      gA: 0,
      gB: -1,
      gT: 0
    }
  }
  const span = (r: number[]) => r[0] + rand() * (r[1] - r[0])
  /** Rain glitches forced on for testing (window.__fxRainGlitch). */
  let rainGlitchUntil = 0
  /**
   * Glow sprites for the rain, drawn once: a soft round halo for the leading glyph, and a column
   * that fades from bright at the bottom to nothing at the top, stretched behind each trail.
   * Cheap stand-ins for shadowBlur, which is far too slow for hundreds of glyphs.
   */
  let rainHalo: HTMLCanvasElement | null = null
  let rainStreak: HTMLCanvasElement | null = null
  function rainGlow(): void {
    rainHalo = document.createElement('canvas')
    rainHalo.width = rainHalo.height = 64
    const h = rainHalo.getContext('2d')!
    const rg = h.createRadialGradient(32, 32, 0, 32, 32, 32)
    rg.addColorStop(0, col(1))
    rg.addColorStop(0.35, col(0.45))
    rg.addColorStop(1, col(0))
    h.fillStyle = rg
    h.fillRect(0, 0, 64, 64)
    rainStreak = document.createElement('canvas')
    rainStreak.width = 32
    rainStreak.height = 128
    const g = rainStreak.getContext('2d')!
    const across = g.createLinearGradient(0, 0, 32, 0)
    across.addColorStop(0, col(0))
    across.addColorStop(0.5, col(1))
    across.addColorStop(1, col(0))
    g.fillStyle = across
    g.fillRect(0, 0, 32, 128)
    // Fade toward the top (the tail).
    g.globalCompositeOperation = 'destination-in'
    const down = g.createLinearGradient(0, 0, 0, 128)
    down.addColorStop(0, 'rgba(0,0,0,0)')
    down.addColorStop(1, 'rgba(0,0,0,1)')
    g.fillStyle = down
    g.fillRect(0, 0, 32, 128)
  }

  function drawRain(dt: number, plane: number): void {
    if (plane === 0) {
      while (rain.length < rainTarget()) rain.push(newDrop(rain.length > 0))
      if (rain.length > rainTarget()) rain.length = rainTarget()
    }
    ctx.textBaseline = 'middle'
    if (!rainHalo) rainGlow()
    const now = performance.now()
    const gRate = intensity > 0 && !reduced ? RAIN_GLITCH.rate * (1 + 4 * excite + 3 * wave) * (now < rainGlitchUntil ? 40 : 1) : 0
    // One plane at a time, at its own parallax depth, so pieces can sit between planes.
    for (let z = plane; z <= plane; z++) {
      const pl = RAIN_PLANES[z]
      depth(pl.depth)
      ctx.font = `600 ${pl.size}px "JetBrains Mono", monospace`
      for (let i = 0; i < rain.length; i++) {
        const d = rain[i]
        if (d.z !== z) continue
        d.y += d.v * dt
        // Glow behind the trail and around its head, added light so it blooms over the board.
        const cx = d.x + pl.size * 0.3
        const g = pl.glow ? 1 : 0.5
        ctx.globalCompositeOperation = 'lighter'
        ctx.globalAlpha = 0.13 * g * pl.alpha
        ctx.drawImage(rainStreak!, cx - pl.size, d.y - d.len * pl.step, pl.size * 2, d.len * pl.step + pl.step * 0.5)
        ctx.globalAlpha = 0.3 * g * pl.alpha
        ctx.drawImage(rainHalo!, cx - pl.size * 1.1, d.y - pl.size * 1.1, pl.size * 2.2, pl.size * 2.2)
        ctx.globalAlpha = 1
        ctx.globalCompositeOperation = 'source-over'
        // Glitch: start one now and then; while it lasts, re-roll the split and the torn run.
        if (now >= d.gUntil && gRate && rand() < dt * gRate) d.gUntil = now + span(RAIN_GLITCH.ms)
        const glitching = now < d.gUntil
        if (glitching && now >= d.gNext) {
          d.gNext = now + span(RAIN_GLITCH.step)
          const k = pl.size / 14
          d.gDx = span(RAIN_GLITCH.split) * k * (rand() < 0.5 ? -1 : 1)
          d.gA = Math.floor(rand() * d.len)
          d.gB = rand() < 0.75 ? d.gA + 1 + Math.floor(rand() * 4) : -1
          d.gT = span(RAIN_GLITCH.tear) * k * (rand() < 0.5 ? -1 : 1)
          if (rand() < 0.5) d.chars[0] = GLYPHS[Math.floor(rand() * GLYPHS.length)]
        }
        for (let k = 0; k < d.len; k++) {
          const y = d.y - k * pl.step
          if (y < -pl.step || y > H + pl.step) continue
          // Glyphs keep mutating as they fall: the head churns fastest, the bright glyphs just
          // behind it next, the rest of the trail still flickers a few times a second.
          if (rand() < dt * (k === 0 ? 18 : k < 3 ? 10 : 4.5)) d.chars[k] = GLYPHS[Math.floor(rand() * GLYPHS.length)]
          const a = Math.pow(1 - k / d.len, 1.4) * pl.alpha
          const x = glitching && k >= d.gA && k <= d.gB ? d.x + d.gT : d.x
          ctx.fillStyle = k === 0 ? `rgba(235,255,240,${pl.alpha})` : k < 3 ? hot(0.9 * pl.alpha) : col(a)
          ctx.fillText(d.chars[k], x, y)
          if (glitching) {
            // The split: red and cyan copies either side, added light so they fringe the glyph.
            const ga = (k === 0 ? 1 : k < 3 ? 0.9 : a / pl.alpha) * 0.55 * pl.alpha * (z === 0 ? 0.6 : 1)
            ctx.globalCompositeOperation = 'lighter'
            ctx.fillStyle = `rgba(255,40,90,${ga.toFixed(3)})`
            ctx.fillText(d.chars[k], x - d.gDx, y)
            ctx.fillStyle = `rgba(40,220,255,${ga.toFixed(3)})`
            ctx.fillText(d.chars[k], x + d.gDx, y)
            ctx.globalCompositeOperation = 'source-over'
          }
        }
        if (d.y - d.len * pl.step > H) rain[i] = newDrop(true)
      }
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
        // Bigger (closer) lights move more.
        depth(DEPTH.bokehMin + (DEPTH.bokehMax - DEPTH.bokehMin) * Math.min(1, b.r / 32))
        ctx.drawImage(bokehSprite, b.x - b.r, b.y - b.r, b.r * 2, b.r * 2)
      }
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
    }
  }

  /** Layer offset for a depth (px of travel at full pointer deflection), snapped to device px. */
  function offset(k: number): [number, number] {
    return [Math.round((-OVERSCAN - px * k) * dpr), Math.round((-OVERSCAN - py * k) * dpr)]
  }
  /** Draw in layer space at this depth. */
  function depth(k: number): void {
    const [ox, oy] = offset(k)
    ctx.setTransform(dpr, 0, 0, dpr, ox, oy)
  }
  function drawFar(): void {
    if (!farLayer) return
    const [fx, fy] = offset(DEPTH.far)
    ctx.setTransform(1, 0, 0, 1, fx, fy)
    ctx.drawImage(farLayer, 0, 0)
  }
  /** The full board, kept dim and patchy: a base the pieces float over, not the main event. */
  function drawBase(): void {
    if (!staticLayer) return
    const [nx, ny] = offset(DEPTH.near)
    ctx.setTransform(1, 0, 0, 1, nx, ny)
    ctx.globalAlpha = 0.55
    ctx.drawImage(staticLayer, 0, 0)
    if (excite > 0.03) {
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = excite
      ctx.drawImage(staticLayer, 0, 0)
      ctx.globalCompositeOperation = 'source-over'
    }
    ctx.globalAlpha = 1
  }

  function updateParallax(now: number, dt: number): void {
    const t = now / 1000
    // Idle drift keeps it breathing when the pointer is still.
    const gx = tx * PARALLAX_GAIN + Math.sin(t / 9) * 0.1
    const gy = ty * PARALLAX_GAIN + Math.cos(t / 11) * 0.08
    // Tight follow (~35ms): locked to where you look, not floating after the mouse.
    const k = 1 - Math.exp(-dt / 0.035)
    px += (gx - px) * k
    py += (gy - py) * k
    // Excitement: quick attack (~70ms) toward how fast the mouse is moving, slow release (~1.6s).
    exciteKick *= Math.exp(-dt / 0.12)
    if (exciteKick > excite) excite += (exciteKick - excite) * (1 - Math.exp(-dt / 0.07))
    else excite *= Math.exp(-dt / 1.6)
    if (reduced) excite = 0
    const shown = Math.round(excite * 50) / 50
    if (shown !== exciteShown) {
      exciteShown = shown
      exciteMain ??= document.querySelector<HTMLElement>('.main')
      exciteMain?.style.setProperty('--fx-excite', String(shown))
    }
    // The haze layers (CSS) follow at their own depth.
    if (now >= shadowAt) {
      shadowAt = now + 16
      const fog = `${(-px * DEPTH.fog).toFixed(1)}px ${(-py * DEPTH.fog).toFixed(1)}px`
      for (const el of document.querySelectorAll<HTMLElement>('.fx-fog')) el.style.translate = fog
    }
  }

  /** Shockwave rings that pop out of the starburst hubs. */
  function drawRings(now: number, dt: number): void {
    if (hubs.length && rand() < dt * (0.2 + 0.8 * intensity)) rings.push({ ...hubs[Math.floor(rand() * hubs.length)], age: 0 })
    rings = rings.filter((r) => (r.age += dt) < 2.2)
    ctx.lineWidth = 1.2
    for (const r of rings) {
      const f = r.age / 2.2
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
        nextSweep = now + (16000 - 6000 * intensity) * (0.7 + rand() * 0.6)
      }
      return
    }
    sweepY += (260 + 160 * intensity) * dt
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
  const GLITCH_TARGETS = '.stack-wordmark, .header-title, .bb-title, .slot-badge-text, .park-title, .bb-for, .header-cwd'
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
    nextElGlitch = now + (16000 - 6000 * intensity) * (0.6 + rand() * 0.8)
  }

  /** Scrambling glyphs and HUD readouts (also drawn once when the layer is still). */
  function drawText(now: number, dt = 0): void {
    ctx.textBaseline = 'middle'
    const scramble = 0.02 + 0.08 * intensity
    for (const gl of glyphs) {
      if (rand() < scramble * dt * 3) gl.ch = GLYPHS[Math.floor(rand() * GLYPHS.length)]
      ctx.font = `${gl.size}px "JetBrains Mono", monospace`
      ctx.fillStyle = col(gl.a)
      ctx.fillText(gl.ch, gl.x, gl.y)
    }
    ctx.font = '9px "JetBrains Mono", monospace'
    for (const t of tags) {
      if (rand() < dt * (0.3 + 0.8 * intensity)) t.n = (t.n + 1 + Math.floor(rand() * 7)) % 1000
      const pct = (90 + (t.n % 100) / 10).toFixed(1)
      ctx.fillStyle = col(0.55)
      ctx.fillText(`${t.text} ${t.text.includes('//') || t.text === 'SYNC' ? pct + '%' : t.n.toString().padStart(3, '0')}`, t.x, t.y)
    }
    void now
  }

  function startGlitch(now: number, power = 0): void {
    // power 0 = the idle tear; up to 1 = a hard typing glitch (more, taller, wider strips).
    glitchUntil = now + 90 + rand() * 130 + power * 60
    strips = Array.from({ length: 2 + Math.floor(rand() * (4 + 8 * power)) }, () => ({
      y: rand() * H,
      h: 2 + rand() * (18 + 70 * power),
      dx: (rand() - 0.5) * (60 + 220 * power),
      tint: rand()
    }))
  }

  /** Typing heat, 0..1: each key adds some, it cools over ~0.8s. Fast typing glitches harder. */
  let typeHeat = 0
  let typingGlitch = opts.typingGlitch ?? true
  /** The banner's words: one is picked when you start typing after a pause, then held. */
  let hackTexts: string[] = []
  let hackText = ''
  /** Keys after this long a pause count as a fresh start (a new banner text). */
  const HACK_REPICK_MS = 5000
  function pickHackText(): void {
    const pool = hackTexts.length ? hackTexts : ['HACKING...']
    const others = pool.length > 1 ? pool.filter((t) => t !== hackText) : pool
    hackText = others[Math.floor(rand() * others.length)]
    showHackText()
  }
  function showHackText(): void {
    const el = document.querySelector<HTMLElement>('.fx-hack-text')
    if (!el || !hackText || el.textContent === hackText) return
    el.textContent = hackText
    // Long ones shrink to fit the box (see .fx-hack-text).
    el.style.setProperty('--hack-len', String(Math.max(10, hackText.length)))
  }
  let typeAt = 0
  /** Typing distortion strength 0..1; eases off over ~0.4s. */
  let wave = 0
  let waveEls: HTMLElement[] = []
  let waveShown = false

  /**
   * Typing distortion: the board ripples sideways in smooth bands, and the chrome around the
   * terminal (stack, header, bottom bar) sways with a light purple colour fringe. The terminal
   * itself is never touched.
   */
  /** Torn bands for the typing distortion: uneven heights and offsets, reshuffled every few frames. */
  let tears: { y: number; h: number; dx: number }[] = []
  let ripMap: Element | null = null
  let ripNoise: Element | null = null
  let ripAt = 0
  let tearsAt = 0

  let hackEl: HTMLElement | null = null
  let hackShown = '0.00'

  /** The movie-hacker banner: flickers on while typing, gone as soon as the wave dies. */
  function drawHack(): void {
    // Re-found when it comes back (the setting can remove and re-add it).
    if (!hackEl?.isConnected) {
      hackEl = wave > 0.08 ? document.querySelector<HTMLElement>('.fx-hack') : null
      hackShown = '0.00'
      if (hackEl) showHackText()
    }
    if (!hackEl) return
    let o = 0
    if (wave > 0.08) o = Math.min(1, wave * 1.8) * (rand() < 0.14 ? 0.2 : rand() < 0.1 ? 0.6 : 1)
    const shown = o.toFixed(2)
    if (shown === hackShown) return
    if (o > 0 && hackShown === '0.00') {
      // Fit it to the terminal frame each time it appears (cheap: once per burst).
      const r = document.querySelector('.stage')?.getBoundingClientRect()
      if (r) for (const [k, v] of [['x', r.left], ['y', r.top], ['w', r.width], ['h', r.height]] as const) hackEl.style.setProperty(`--hack-${k}`, `${Math.round(v)}px`)
    }
    hackShown = shown
    hackEl.style.opacity = shown
  }

  function drawWave(now: number, dt: number): void {
    // Snappy: dies off within ~half a second of the last key.
    wave *= Math.exp(-dt / 0.13)
    drawHack()
    // Switched off, the wave still runs (it drives the HACKING... banner) but tears nothing.
    const on = typingGlitch && wave > 0.015
    if (on && staticLayer) {
      if (now >= tearsAt) {
        // New jagged tear pattern ~every 40ms: a few big rips, many small slips.
        tearsAt = now + 30 + rand() * 30
        tears = []
        for (let y = 0; y < H; ) {
          // Fewer, taller tears that throw hard; the gaps between them stay put.
          const h = 24 + rand() * 110
          const rip = rand() < 0.35
          tears.push({ y, h, dx: rip ? (rand() - 0.5) * 300 : 0 })
          y += h
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      for (const t of tears) {
        const dx = Math.round(t.dx * wave * dpr)
        if (!dx) continue
        const y = Math.round(t.y * dpr)
        const h = Math.max(1, Math.round(t.h * dpr))
        ctx.drawImage(canvas, 0, y, canvas.width, h, dx, y, canvas.width, h)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    // Chrome jitter, written straight to the elements (no page-wide style recalcs).
    if (!on && !waveShown) return
    if (!waveEls.length) waveEls = [...document.querySelectorAll<HTMLElement>('.sidebar, .header, .bottom-bar')]
    const [r, g, b] = [ar, ag, ab]
    ripMap ??= document.getElementById('fx-rip-map')
    ripNoise ??= document.getElementById('fx-rip-noise')
    // Filters (the rip and the colour fringe) re-render whole panels, so they change ~20x a
    // second; the shake below is a cheap transform and runs every frame.
    const refilter = !on || now >= ripAt
    if (on && refilter) {
      ripAt = now + 50
      ripMap?.setAttribute('scale', String(Math.round(140 * wave)))
      ripNoise?.setAttribute('seed', String(Math.floor(rand() * 1000)))
    } else if (!on) ripMap?.setAttribute('scale', '0')
    const ab2 = (3.6 * wave).toFixed(1)
    // The fringe's strength follows the wave too, so it dims to nothing instead of lingering at
    // full colour behind the see-through panels and then switching off.
    const fade = Math.min(1, wave * 1.6)
    const al = (n: number) => (n * fade).toFixed(3)
    for (const el of waveEls) {
      if (!on) {
        el.style.translate = ''
        el.style.rotate = ''
        el.style.filter = ''
        continue
      }
      // Violent: big random jumps both ways, a little vertical kick, a hint of twist.
      const big = rand() < 0.45
      const sx = (big ? (rand() - 0.5) * 30 : (rand() - 0.5) * 6) * wave
      const sy = (big ? (rand() - 0.5) * 8 : (rand() - 0.5) * 2) * wave
      el.style.translate = `${sx.toFixed(1)}px ${sy.toFixed(1)}px`
      el.style.rotate = `${((rand() - 0.5) * 0.6 * wave).toFixed(2)}deg`
      if (!refilter) continue
      // Rip the stack into sliding bands, then fringe in the theme's greens with a faint purple ghost.
      el.style.filter =
        (el.classList.contains('sidebar') ? `url(#fx-rip) ` : '') +
        `drop-shadow(-${ab2}px 0 0 rgba(${Math.min(255, r + 90)},255,${Math.min(255, b + 90)},${al(0.45)})) ` +
        `drop-shadow(${ab2}px 0 0 rgba(${r >> 2},${Math.round(g * 0.55)},${b >> 2},${al(0.7)})) ` +
        `drop-shadow(0 ${(Number(ab2) * 0.6).toFixed(1)}px 0 rgba(170,70,255,${al(0.22)}))`
    }
    waveShown = on
    if (!on) waveEls = []
  }


  function drawGlitch(now: number): void {
    if (now >= glitchUntil) {
      if (strips.length) strips = []
      if (intensity > 0 && !reduced && now >= nextGlitch) {
        if (nextGlitch) startGlitch(now)
        nextGlitch = now + (18000 - 6000 * intensity) * (0.6 + rand() * 0.8)
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
  /** During a 90s Hacker switch the backdrop draws every other frame: it costs most then (it's
      composited under the flying 3D layers), and at 30fps behind all that motion it doesn't show. */
  let skipFrame = false
  function loop(now: number): void {
    if (stopped) return
    raf = requestAnimationFrame(loop)
    if (document.documentElement.classList.contains('is-hinging') && (skipFrame = !skipFrame)) return
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
    const now = performance.now()
    drawFar()
    drawPieces(now, 0, DEPTH.near)
    drawBase()
    drawPieces(now, DEPTH.near, Infinity)
    depth(DEPTH.near)
    drawText(now)
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
  ;(window as unknown as { __fxRainGlitch?: () => void }).__fxRainGlitch = () => (rainGlitchUntil = performance.now() + 1500)
  // For poking at it: how many streaks are glitching right now.
  ;(window as unknown as { __fxRainStats?: () => string }).__fxRainStats = () => {
    const t = performance.now()
    return `${rain.filter((d) => t < d.gUntil).length}/${rain.length}`
  }

  build()
  run()
  window.addEventListener('resize', onResize)
  const onPointer = (e: PointerEvent) => {
    tx = Math.max(-1, Math.min(1, (e.clientX / Math.max(1, VW)) * 2 - 1))
    ty = Math.max(-1, Math.min(1, (e.clientY / Math.max(1, VH)) * 2 - 1))
    const t = performance.now()
    if (lastPtr && t > lastPtr.t) {
      // px/s; a brisk flick across the screen is ~3000.
      const v = Math.hypot(e.clientX - lastPtr.x, e.clientY - lastPtr.y) / ((t - lastPtr.t) / 1000)
      exciteKick = Math.max(exciteKick, Math.min(1, v / 1300))
    }
    lastPtr = { x: e.clientX, y: e.clientY, t }
  }
  const onLeave = () => {
    tx = 0
    ty = 0
  }
  window.addEventListener('pointermove', onPointer, { passive: true })
  document.documentElement.addEventListener('pointerleave', onLeave)
  document.addEventListener('visibilitychange', onVisibility)

  return {
    setIntensity(n: number) {
      intensity = Math.max(0, Math.min(1, n))
      run()
    },
    setHackTexts(t: string[]) {
      hackTexts = t.map((x) => x.trim()).filter(Boolean)
      if (hackText && !hackTexts.includes(hackText)) hackText = ''
    },
    setTypingGlitch(v: boolean) {
      typingGlitch = v
    },
    glitch,
    parallax: () => [px, py],
    burst() {
      if (intensity <= 0 || reduced) return
      const now = performance.now()
      if (!hackText || now - typeAt > HACK_REPICK_MS) pickHackText()
      typeHeat = Math.min(1, typeHeat * Math.exp(-(now - typeAt) / 800) + 0.3)
      typeAt = now
      // A ripple of distortion that swells with each key and eases off (drawWave).
      wave = Math.min(1, wave + 0.32 + 0.3 * typeHeat)
      boost = Math.min(160, boost + 14)
      for (let i = 0; i < 10; i++) pulses.push({ ...newPulse(), v: 200 + rand() * 160 })
      if (hubs.length && rand() < 0.5) rings.push({ ...hubs[Math.floor(rand() * hubs.length)], age: 0 })
    },
    stop() {
      stopped = true
      cancelAnimationFrame(raf)
      window.clearTimeout(resizeTimer)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pointermove', onPointer)
      document.documentElement.removeEventListener('pointerleave', onLeave)
      document.documentElement.style.removeProperty('--hud-sx')
      document.documentElement.style.removeProperty('--hud-sy')
      for (const el of document.querySelectorAll<HTMLElement>('.fx-fog')) el.style.translate = ''
      document.removeEventListener('visibilitychange', onVisibility)
      for (const el of waveEls) {
        el.style.translate = ''
        el.style.rotate = ''
        el.style.filter = ''
      }
      for (const el of glitched) el.classList.remove('fx-glitch-el')
      glitched.clear()
      delete (window as unknown as { __fxGlitch?: () => void }).__fxGlitch
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
  }
}
