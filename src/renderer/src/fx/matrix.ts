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
import { fxBurst, fxField, fxPit } from '../lib/fxField'
import { stageRect } from '../lib/stageRect'

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
  /** The burst's canvas, over the app (see drawBurstLayer). */
  burst?: HTMLCanvasElement
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
 * at rest; mouse speed and typing multiply it. Glitches are short flickers, so they read as a
 * glitch rather than a split riding down with the glyph. split is a fraction of the glyph's size
 * (so far and near look alike); `wideP` of glitches split `wide` instead (~3x) for their short
 * life. tear is px at the mid plane.
 */
// Mostly single glyphs (`char`: starts per glyph per second); now and then a whole streak (`rate`).
const RAIN_GLITCH = { rate: 0.22, char: 0.2, ms: [50, 150], step: [20, 40], split: [0.1, 0.24], wide: [0.5, 0.8], wideP: 0.12, tear: [8, 28] }
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
  const mainCtx = canvas.getContext('2d')!
  /** Where the backdrop draws: the canvas, or nearBuf while the pit is open (see frame). */
  let ctx = mainCtx
  /** While the pit is open, the planes nearer than the board go here, get the hole cut through them, then go on top. */
  let nearBuf: HTMLCanvasElement | null = null
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
  /** vx/vy/z: only set once the pit's pull has hold of one (see drawAtmosphere). */
  let bokeh: { x: number; y: number; r: number; v: number; a: number; ph: number; vx?: number; vy?: number; z?: number }[] = []
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
  /**
   * g*: the streak's glitch (see RAIN_GLITCH): ends at gUntil, re-rolls at gNext; glyphs gA..gB tear by gT.
   * c*: each glyph's own glitch: until cU[k], split cDx[k], torn sideways by cT[k]; g/cW: a wide split.
   */
  let rain: { x: number; y: number; v: number; len: number; chars: string[]; z: number; gUntil: number; gNext: number; gDx: number; gA: number; gB: number; gT: number; gW: boolean; cU: number[]; cDx: number[]; cT: number[]; cW: boolean[]; free?: Float32Array }[] = []
  type Drop = (typeof rain)[number]
  let freed = 0
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

  function makePiece(r: () => number, z: number, shapes: Shape[] = SHAPES) {
    const s = 0.6 + 0.9 * z
    const shape = shapes[Math.floor(r() * shapes.length)]
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
    // Each piece's tilt baked into its picture once, so a frame only places it (no transform per piece).
    for (const p of list) {
      if (!p.rot) continue
      const { c } = p
      const co = Math.abs(Math.cos(p.rot))
      const sn = Math.abs(Math.sin(p.rot))
      const out = document.createElement('canvas')
      out.width = Math.ceil(c.width * co + c.height * sn)
      out.height = Math.ceil(c.width * sn + c.height * co)
      const g = out.getContext('2d')!
      g.translate(out.width / 2, out.height / 2)
      g.rotate(p.rot)
      g.drawImage(c, -c.width / 2, -c.height / 2)
      p.c = out
      p.rot = 0
    }
    return list.sort((a, b) => a.dpx - b.dpx)
  }

  /** Draw the pieces whose depth falls in [lo, hi), so they interleave with the rain planes. */
  function drawPieces(now: number, lo: number, hi: number): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    for (const p of pieces) {
      if (p.dpx < lo || p.dpx >= hi) continue
      const [ox, oy] = offset(p.dpx)
      const by = Math.sin((now / p.per) * Math.PI * 2 + p.ph) * p.bob
      // Device pixels, untransformed: the tilt is already in its picture (see buildPieces).
      const x = ox + p.x * dpr - p.c.width / 2
      const y = oy + (p.y + by) * dpr - p.c.height / 2
      ctx.drawImage(p.c, x, y)
      if (excite > 0.03) {
        ctx.globalCompositeOperation = 'lighter'
        ctx.globalAlpha = 0.9 * excite
        ctx.drawImage(p.c, x, y)
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
    })).sort((a, b) => a.size - b.size)
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

    // The pit opens under everything nearer than the board, and its hole goes on up through them:
    // they're drawn on their own, the hole is cut out of them, and they're laid over it.
    ctx.save()
    drawPit(now, dt)
    ctx.restore()
    const holed = pit > 0 && pitPlacedBox()
    if (holed) {
      nearBuf ??= document.createElement('canvas')
      if (nearBuf.width !== canvas.width || nearBuf.height !== canvas.height) {
        nearBuf.width = canvas.width
        nearBuf.height = canvas.height
      }
      ctx = nearBuf.getContext('2d')!
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, nearBuf.width, nearBuf.height)
      depth(DEPTH.near)
    }
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
    if (holed) {
      cutHole(ctx)
      ctx = mainCtx
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.drawImage(nearBuf!, 0, 0)
    }
    drawBurstLayer(now)
    drawWave(now, dt)
    drawShatter(dt)
    drawGlitch(now)
    drawField(now)
    elementGlitch(now)
  }

  /**
   * The pit a thrown window falls into (lib/fxField fxPit, the stage's box, written by Stage):
   * a shaft seen straight down its axis, behind the stage bay (only drawn while it's open). Its
   * walls are lined with the backdrop's own broken circuit boards, orbiting the axis faster the
   * deeper they are, tumbling and slowly sinking; cables spiral down it with data running along
   * them, specks fall through it, and fog floors darken it to a faint glow at the bottom. Built
   * as real 3D (screen = centre + (X - cam) / Z), with the camera on the backdrop's parallax, so
   * moving the mouse shifts the mouth more than the depths.
   * depth: the bottom's Z (the mouth is 1); wall: the wall radius at the mouth (× the stage's
   * longer side); cam: how far the mouth shifts at full pointer deflection (px, ~DEPTH.near).
   */
  const PIT = { depth: 16, top: 2.4, wall: 0.4, boards: 34, sprites: 24, specks: 30, cam: DEPTH.near, size: 0.2, sink: 0.3 }
  /** The pit's boards: no discs (they read as orbs down there). */
  /** Mostly broken, irregular pieces (small, a rectangle with a notch just reads as a square). */
  const PIT_SHAPES: Shape[] = ['shard', 'shard', 'shard', 'shard', 'strip', 'strip', 'fracture', 'fracture', 'ell', 'chipped']
  const PIT_FOG = [8, 5, 3, 1.8]
  /**
   * The tunnel: the backdrop drawn into itself again and again, each copy `scale` the size of the
   * last and turned `twist` more, about the vanishing point, so the board itself winds down
   * forever. `spin`: rad/s of the first copy (deeper ones turn faster); `fog`: how much darker
   * and mistier each copy is; `margin`: how far past the stage the pull reaches (× its longer side).
   */
  const PIT_TUNNEL = { layers: 9, scale: 0.8, twist: 0.2, spin: 0.1, fog: 0.15, margin: 0.14 }
  /** Mist sheets, at these tunnel copies, and how thick each is. */
  const PIT_MIST = { at: [2, 4, 6, 8], alpha: [0.12, 0.16, 0.32, 0.42] }
  /** asp/skew: its own fixed stretch and lean, so no two look alike and none reads as a square. */
  type PitBoard = { sp: number; a: number; rho: number; z: number; spin: number; vs: number; tumble: number; vt: number; asp: number; skew: number }
  type PitSpeck = { a: number; rho: number; z: number; v: number; ch: string }
  let pit = 0
  let pitOpenAt = 0
  let pitSprites: HTMLCanvasElement[] = []
  let pitBoards: PitBoard[] = []
  let pitSpecks: PitSpeck[] = []
  let pitMask: HTMLCanvasElement | null = null
  /** The pit's box on screen while it's open (set by drawPit), for the hole through the near planes. */
  let pitBox: [number, number, number, number] | null = null
  const pitPlacedBox = () => pitBox !== null
  /** A soft oval through the near planes over the pit, shifted with their parallax; mostly, not quite, clear. */
  function cutHole(c: CanvasRenderingContext2D): void {
    const [x, y, w, h] = pitBox!
    const [ox, oy] = pitShift(1.9)
    c.save()
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    c.translate(x + w / 2 + ox, y + h / 2 + oy)
    c.scale(w / 2, h / 2)
    const g = c.createRadialGradient(0, 0, 0, 0, 0, 1)
    const a = 0.9 * pit
    g.addColorStop(0, `rgba(0,0,0,${a.toFixed(3)})`)
    g.addColorStop(0.35, `rgba(0,0,0,${(a * 0.9).toFixed(3)})`)
    g.addColorStop(0.7, `rgba(0,0,0,${(a * 0.35).toFixed(3)})`)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    c.globalCompositeOperation = 'destination-out'
    c.fillStyle = g
    c.fillRect(-1, -1, 2, 2)
    c.restore()
  }
  /** The pit is drawn here, then into the backdrop over its deep planes and under its near ones. */
  let pitOff: HTMLCanvasElement | null = null
  /** The pit draws at the screen's own resolution (the backdrop stops at 1.5). */
  const pitDpr = () => Math.min(2, window.devicePixelRatio || 1)
  /** Z spread evenly in perceived depth (log), between the mouth and the bottom. */
  const pitZ = (u: number) => Math.exp(u * Math.log(PIT.depth))
  /** The boards start a way down (PIT.top), so none sits at the mouth in your face. */
  const pitBoardZ = (u: number) => PIT.top * Math.exp(u * Math.log(PIT.depth / PIT.top))
  /** The boards' sprites (makePiece, the backdrop's own), built a few at a time when idle. */
  function buildPitSprites(): void {
    if (stopped) return
    // Never mid-switch: each one is ~50ms of drawing, which would stall the throw.
    if (document.documentElement.classList.contains('is-hinging')) {
      setTimeout(buildPitSprites, 600)
      return
    }
    if (pitSprites.length >= PIT.sprites) {
      // Last, the smoke (~100ms of noise), so the first throw doesn't pay for it either.
      if (!pitSmoke.length && !smokeLoading) buildSmokeSvg()
      if (!flushAtlas.length) buildFlushAtlas()
      return
    }
    // Crisp, bright pieces (the shaft does its own depth fading), at the pit's resolution:
    // makePiece reads dpr, so it's swapped for the one build.
    const keep = dpr
    dpr = pitDpr()
    try {
      pitSprites.push(makePiece(rand, 0.6 + rand() * 0.4, PIT_SHAPES))
    } finally {
      dpr = keep
    }
    if ('requestIdleCallback' in window) window.requestIdleCallback(() => buildPitSprites())
    else setTimeout(buildPitSprites, 120)
  }
  function openPit(): void {
    const sp = () => Math.floor(rand() * pitSprites.length)
    pitBoards = Array.from({ length: PIT.boards }, (_, i) => ({
      sp: sp(),
      // Even-ish around the wall and down the shaft, so it never clumps.
      a: ((i * 0.618) % 1) * Math.PI * 2 + rand() * 0.4,
      rho: 0.75 + rand() * 0.5,
      z: pitBoardZ((i + rand()) / PIT.boards),
      spin: rand() * Math.PI * 2,
      vs: (rand() - 0.5) * 0.8,
      tumble: rand() * Math.PI * 2,
      vt: (0.6 + rand() * 1.4) * (rand() < 0.5 ? -1 : 1),
      asp: 0.4 + rand() * 1.8,
      skew: (rand() - 0.5) * 0.7
    }))
    pitSpecks = Array.from({ length: PIT.specks }, () => newSpeck(pitZ(rand())))
  }
  const newSpeck = (z = 1): PitSpeck => ({ a: rand() * Math.PI * 2, rho: 0.1 + rand() * 0.8, z, v: 0.5 + rand() * 0.9, ch: GLYPHS[Math.floor(rand() * GLYPHS.length)] })
  /** Angular speed (rad/s) at depth z: the deeper, the faster it swirls. */
  /** How fast things turn at depth z: hardly at all near the mouth, harder the deeper. */
  const pitSwirl = (z: number) => 0.02 + 0.08 * Math.max(0, z - PIT.top)

  /** Smooth value noise (about -1..1) on a hashed lattice: the pit's smoke and its flow field. */
  const hash2 = (x: number, y: number) => {
    const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
    return (h - Math.floor(h)) * 2 - 1
  }
  function noise2(x: number, y: number): number {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const xf = x - xi
    const yf = y - yi
    const u = xf * xf * (3 - 2 * xf)
    const v = yf * yf * (3 - 2 * yf)
    const a = hash2(xi, yi)
    const b = hash2(xi + 1, yi)
    const c = hash2(xi, yi + 1)
    const d = hash2(xi + 1, yi + 1)
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
  }
  /** The curl of two octaves of drifting noise at (x, y): a swirling push that never bunches up. */
  function curl(x: number, y: number, t: number): [number, number] {
    const n = (X: number, Y: number) => noise2(X + t * 0.35, Y - t * 0.22) + 0.5 * noise2(X * 2.1 - t * 0.5, Y * 2.1 + 7.3)
    const e = 0.5
    return [(n(x, y + e) - n(x, y - e)) / (2 * e), -(n(x + e, y) - n(x - e, y)) / (2 * e)]
  }

  /** Smoke textures (dark curls, lit wisps, pale mist); see buildSmokeSvg, with buildSmoke as the fallback. */
  let pitSmoke: HTMLCanvasElement[] = []
  let smokeLoading = false
  /**
   * The smoke from the browser's own fractal noise (feTurbulence, 5 octaves) rasterised once at
   * 512px: fine, crisp detail at the size it's drawn. Faded to a ring by a radial mask.
   */
  function buildSmokeSvg(): void {
    smokeLoading = true
    const N = 512
    const ring =
      "<radialGradient id='g'><stop offset='0.12' stop-color='#fff' stop-opacity='0'/><stop offset='0.35' stop-color='#fff' stop-opacity='1'/>" +
      "<stop offset='0.72' stop-color='#fff' stop-opacity='0.7'/><stop offset='1' stop-color='#fff' stop-opacity='0'/></radialGradient>"
    // The mist: the theme's green, deep and saturated (never greyed toward white).
    const [mr, mg, mb] = [ar, ag, ab].map((c) => (0.62 * c + 4) / 255)
    // Noise (red) into alpha with contrast: dense dark curls, sparser lit wisps in the accent.
    const mats = [
      '0 0 0 0 0.004  0 0 0 0 0.02  0 0 0 0 0.012  2.6 0 0 0 -0.9',
      `0 0 0 0 ${(ar / 255).toFixed(3)}  0 0 0 0 ${(ag / 255).toFixed(3)}  0 0 0 0 ${(ab / 255).toFixed(3)}  3.2 0 0 0 -1.7`,
      `0 0 0 0 ${mr.toFixed(3)}  0 0 0 0 ${mg.toFixed(3)}  0 0 0 0 ${mb.toFixed(3)}  2.6 0 0 0 -1.2`
    ]
    const out: HTMLCanvasElement[] = []
    let left = mats.length
    mats.forEach((mat, i) => {
      const svg =
        `<svg xmlns='http://www.w3.org/2000/svg' width='${N}' height='${N}'><defs>` +
        `<filter id='f' x='0' y='0' width='100%' height='100%'><feTurbulence type='fractalNoise' baseFrequency='0.011' numOctaves='5' seed='${7 + i * 13}'/>` +
        `<feColorMatrix type='matrix' values='${mat}'/></filter>${ring}<mask id='m'><rect width='100%' height='100%' fill='url(#g)'/></mask></defs>` +
        `<rect width='100%' height='100%' filter='url(#f)' mask='url(#m)'/></svg>`
      const img = new Image()
      img.onload = () => {
        const c = document.createElement('canvas')
        c.width = c.height = N
        c.getContext('2d')!.drawImage(img, 0, 0)
        out[i] = c
        if (--left === 0) pitSmoke = out
      }
      img.onerror = () => {
        if (!pitSmoke.length) buildSmoke()
      }
      img.src = `data:image/svg+xml,${encodeURIComponent(svg)}`
    })
  }
  function buildSmoke(): void {
    const N = 256
    pitSmoke = [0, 1, 1].map((layer) => {
      const c = document.createElement('canvas')
      c.width = c.height = N
      const g = c.getContext('2d')!
      const img = g.createImageData(N, N)
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const dx = (x / N) * 2 - 1
          const dy = (y / N) * 2 - 1
          const r = Math.hypot(dx, dy)
          const a = Math.atan2(dy, dx)
          // Sampled round the ring (cos/sin, so it wraps without a seam), stretched along it.
          const n = 0.5 + 0.5 * (0.65 * noise2(Math.cos(a) * 2.2 + layer * 5, r * 6 + Math.sin(a) * 2.2) + 0.35 * noise2(Math.cos(a) * 5 + 3, r * 13 - Math.sin(a) * 5))
          const v = Math.pow(n, 2.2) * Math.max(0, 1 - r) * Math.min(1, r / 0.25)
          const i = (y * N + x) * 4
          const [cr, cg, cb] = layer ? [ar, ag, ab] : [1, 5, 3]
          img.data[i] = cr
          img.data[i + 1] = cg
          img.data[i + 2] = cb
          img.data[i + 3] = Math.round(255 * Math.min(1, layer ? v * v * 2 : v * 1.7))
        }
      }
      g.putImageData(img, 0, 0)
      return c
    })
  }


  /**
   * The siphon: currents torn off the falling window (and the pit's rim) and dragged down into the
   * deep. Each rides a flow field (a pull to the centre, a swirl round it that tightens as it nears,
   * and curl noise for the turbulence) and is drawn as a tapered ribbon along its last few
   * positions: thin, fading ends and a fuller middle. Each has a depth, so the deep ones are
   * fainter and thinner (lost in the mist). Fine dust rides the same flow between them, and a few
   */
  /** The pit's lights: the accent lifted, still green (hot() goes nearly white). */
  const lit = (a: number) => `rgba(${Math.min(255, ar + 45)},${Math.min(255, ag + 25)},${Math.min(255, ab + 45)},${a})`
  /**
   * Like the boards, the currents and dust live in depth: each moves in the mouth's plane (pulled
   * in and round, with a little wobble) and sinks in z, drawn toward the vanishing point by its
   * depth, so it plunges away down the shaft, shrinking and fading, instead of wandering about.
   * pull/swirl: the current (px/s); sink: 1/s at the rim and at the middle; curl: wobble (px/s).
   */
  const SIPHON = { wisps: 28, dust: 160, pull: [120, 420], swirl: [0.35, 0.18], grip: 4, sink: [0.7, 3.4], curl: 50, zMax: 10, tail: 14 }
  type Wisp = { x: number; y: number; vx: number; vy: number; z: number; hx: number[]; hy: number[]; age: number; life: number; w: number; hot: boolean; fil: boolean }
  type Mote = { x: number; y: number; vx: number; vy: number; z: number; age: number; life: number }
  let wisps: Wisp[] = []
  let motes: Mote[] = []
  /** The pit (its pitOpenAt) the siphon was last started for. */
  let siphonFor = 0
  /** The thrown window's box in the pit's coordinates, or null once it's gone. */
  function thrownBox(): [number, number, number, number] | null {
    const f = fxField[1]
    if (f.x1 - f.x0 < 2) return null
    return [f.x0 - pitOX, f.y0 - pitOY, f.x1 - pitOX, f.y1 - pitOY]
  }
  function spawnAt(sw: number, sh: number, ix: number, iy: number, fromBox: number): [number, number] {
    const box = thrownBox()
    if (box && rand() < fromBox) {
      // Torn off the window's edge.
      const [x0, y0, x1, y1] = box
      const e = rand() * 4
      const k = rand()
      return e < 1 ? [x0 + (x1 - x0) * k, y0] : e < 2 ? [x1, y0 + (y1 - y0) * k] : e < 3 ? [x0 + (x1 - x0) * k, y1] : [x0, y0 + (y1 - y0) * k]
    }
    // Drawn in off the board around the pit.
    const a = rand() * Math.PI * 2
    const r = 0.18 + rand() * 0.3
    return [ix + Math.cos(a) * r * sw, iy + Math.sin(a) * r * sh]
  }
  function spawnWisp(sw: number, sh: number, ix: number, iy: number): Wisp {
    const [x, y] = spawnAt(sw, sh, ix, iy, 0.55)
    return { x, y, vx: 0, vy: 0, z: 1, hx: Array(SIPHON.tail).fill(x), hy: Array(SIPHON.tail).fill(y), age: 0, life: 1.2 + rand() * 1.8, w: 0.7 + rand() * 1.6, hot: rand() < 0.25, fil: rand() < 0.17 }
  }
  const spawnMote = (sw: number, sh: number, ix: number, iy: number): Mote => {
    const [x, y] = spawnAt(sw, sh, ix, iy, 0.3)
    return { x, y, vx: 0, vy: 0, z: 1, age: 0, life: 0.8 + rand() * 2 }
  }
  /**
   * One step of a siphon particle (mouth-plane x, y, velocity, depth z) toward the vanishing point
   * (ix, iy); R: the pit's half-size. Returns its screen spot in SIPHON_AT ([x, y]).
   */
  const SIPHON_AT = [0, 0]
  function siphonStep(p: { x: number; y: number; vx: number; vy: number; z: number }, ix: number, iy: number, R: number, dt: number, t: number, k: number): void {
    const dx = ix - p.x
    const dy = iy - p.y
    const r = Math.hypot(dx, dy) || 1
    // Stronger toward the middle, never nothing (it's all inside the pit).
    const w = Math.pow(Math.max(0, 1 - r / (1.25 * R)), 1.5)
    const uin = (SIPHON.pull[0] + (SIPHON.pull[1] - SIPHON.pull[0]) * w) * k
    const ut = (SIPHON.swirl[0] + (SIPHON.swirl[1] - SIPHON.swirl[0]) * w) * uin
    // Inward, and round (the tunnel's way: clockwise on screen).
    const ux = (dx / r) * uin - (dy / r) * ut
    const uy = (dy / r) * uin + (dx / r) * ut
    const b = 1 - Math.exp(-SIPHON.grip * dt)
    p.vx += (ux - p.vx) * b
    p.vy += (uy - p.vy) * b
    const [cx, cy] = curl(p.x * 0.006, p.y * 0.006, t)
    p.x += (p.vx + cx * SIPHON.curl) * dt
    p.y += (p.vy + cy * SIPHON.curl) * dt
    p.z += p.z * (SIPHON.sink[0] + (SIPHON.sink[1] - SIPHON.sink[0]) * w) * k * dt
    SIPHON_AT[0] = ix + (p.x - ix) / p.z
    SIPHON_AT[1] = iy + (p.y - iy) / p.z
  }
  function drawSiphon(b: CanvasRenderingContext2D, q: number, sw: number, sh: number, ix: number, iy: number, dt: number, t: number): void {
    // Each pit starts its siphon fresh.
    if (siphonFor !== pitOpenAt) {
      siphonFor = pitOpenAt
      wisps = Array.from({ length: SIPHON.wisps }, () => ({ ...spawnWisp(sw, sh, ix, iy), age: -rand() * 0.6 }))
      motes = Array.from({ length: SIPHON.dust }, () => ({ ...spawnMote(sw, sh, ix, iy), age: -rand() * 0.8 }))
    }
    const R = 0.5 * Math.min(sw, sh)
    const fog = (z: number) => Math.exp(-0.5 * (z - 1))
    b.setTransform(q, 0, 0, q, 0, 0)
    b.globalCompositeOperation = 'lighter'
    // Dust: specks on the current, plunging away down the shaft.
    for (let i = 0; i < motes.length; i++) {
      const m = motes[i]
      m.age += dt
      if (m.age < 0) continue
      siphonStep(m, ix, iy, R, dt, t, 0.85)
      const al = 0.7 * Math.min(1, m.age / 0.25) * fog(m.z) * pit
      if (m.z > SIPHON.zMax || m.age > m.life || al < 0.01) {
        motes[i] = spawnMote(sw, sh, ix, iy)
        continue
      }
      const sz = Math.max(0.35, 0.6 / Math.sqrt(m.z))
      if (i % 5 === 0) {
        b.fillStyle = col(al * 0.18)
        b.beginPath()
        b.arc(SIPHON_AT[0], SIPHON_AT[1], sz * 3, 0, Math.PI * 2)
        b.fill()
      }
      b.fillStyle = lit(al)
      b.beginPath()
      b.arc(SIPHON_AT[0], SIPHON_AT[1], sz, 0, Math.PI * 2)
      b.fill()
    }
    // The currents: ribbons along their last spots on screen, tapered at both ends.
    const n = SIPHON.tail
    for (let i = 0; i < wisps.length; i++) {
      const p = wisps[i]
      p.age += dt
      if (p.age < 0) continue
      siphonStep(p, ix, iy, R, dt, t, 1)
      p.hx.pop()
      p.hy.pop()
      p.hx.unshift(SIPHON_AT[0])
      p.hy.unshift(SIPHON_AT[1])
      const f = Math.min(1, p.age / 0.3) * fog(p.z) * pit
      if (p.z > SIPHON.zMax || p.age > p.life || f < 0.01) {
        wisps[i] = spawnWisp(sw, sh, ix, iy)
        continue
      }
      const a = (p.hot ? 0.85 : 0.6) * f
      const thin = 1 / Math.sqrt(p.z)
      const hx = p.hx
      const hy = p.hy
      // Too short a hop to draw yet (it's only just appeared).
      if (Math.abs(hx[0] - hx[n - 1]) + Math.abs(hy[0] - hy[n - 1]) < 1.5) continue
      // A smooth curve through spots j0..j1 (through the midpoints, the spots as controls).
      const curve = (j0: number, j1: number, ox = 0, oy = 0) => {
        b.beginPath()
        b.moveTo(hx[j0] + ox, hy[j0] + oy)
        for (let j = j0 + 1; j < j1; j++) b.quadraticCurveTo(hx[j] + ox, hy[j] + oy, (hx[j] + hx[j + 1]) / 2 + ox, (hy[j] + hy[j + 1]) / 2 + oy)
        b.lineTo(hx[j1] + ox, hy[j1] + oy)
      }
      // Bright at the head, nothing at the tail.
      const fade = (j0: number, j1: number, a0: number, a1: number, c: (v: number) => string) => {
        const g = b.createLinearGradient(hx[j0], hy[j0], hx[j1], hy[j1])
        g.addColorStop(0, c(a0))
        g.addColorStop(1, c(a1))
        return g
      }
      const W0 = p.w * thin
      // The glow round it.
      curve(0, n - 1)
      b.strokeStyle = fade(0, n - 1, a * 0.12, 0, col)
      b.lineWidth = W0 * 5
      b.stroke()
      // The body, narrowing toward the tail.
      const third = Math.floor((n - 1) / 3)
      for (let s = 0; s < 3; s++) {
        const j0 = s * third
        const j1 = s === 2 ? n - 1 : (s + 1) * third
        curve(j0, j1)
        b.strokeStyle = fade(j0, j1, a * (1 - s / 3), a * (1 - (s + 1) / 3), col)
        b.lineWidth = Math.max(0.3, W0 * (1.3 - 0.4 * s))
        b.stroke()
      }
      // A hot core along the front.
      curve(0, third)
      b.strokeStyle = fade(0, third, Math.min(1, a * (p.hot ? 1.2 : 0.9)), 0, lit)
      b.lineWidth = Math.max(0.25, W0 * 0.45)
      b.stroke()
      // Now and then a hair-fine strand beside it, so some read as twisted energy.
      if (p.fil) {
        const dx = hx[0] - hx[third]
        const dy = hy[0] - hy[third]
        const l = Math.hypot(dx, dy) || 1
        const off = 1.6 * thin * Math.sin(t * 9 + i)
        curve(0, n - 1, (-dy / l) * off, (dx / l) * off)
        b.strokeStyle = fade(0, n - 1, a * 0.5, 0, lit)
        b.lineWidth = 0.35
        b.stroke()
      }
    }
    b.globalCompositeOperation = 'source-over'
  }


  /**
   * The thrown window blowing up far down the shaft (lib/fxField fxBurst, set by Stage): a hard
   * pop with a lens glint, a soft flash that lights the pit, one shockwave ring with a red / cyan
   * fringe, shards of the window (its session colour) and sparks flung out and then caught by the
   * pull and spiralled down into the intake, and a few glyphs tumbling off. ~110 small shapes.
   */
  /** minR: the size it plays at however small the window has got by then (px). */
  const BURST = { ms: 1000, cols: 5, rows: 3, sparks: 60, glyphs: 9, ring: 4, flash: 4, minR: 80 }
  type Bit = { x: number; y: number; vx: number; vy: number; rot: number; vr: number; w: number; h: number; life: number; ch: string }
  /** A piece of the window: a triangle (pts, about its centre) that tumbles about one axis. */
  type Shard = Bit & { pts: number[]; tumble: number; vt: number }
  let burstAt = 0
  /** This burst's shockwave: its noise seed, tilt and squash. */
  let waveSeed = 0
  let waveTilt = 0
  let waveAsp = 1
  let burstBits: Shard[] = []
  let burstSparks: Bit[] = []
  let burstGlyphs: Bit[] = []
  let burstTint: [number, number, number] = [0, 255, 120]
  const burstAlive = (now: number) => fxBurst.at > 0 && now - fxBurst.at < BURST.ms
  function hexRgb(c: string): [number, number, number] | null {
    const m = /^#([0-9a-f]{6})$/i.exec(c.trim())
    if (!m) return null
    const n = parseInt(m[1], 16)
    return [n >> 16, (n >> 8) & 255, n & 255]
  }
  /**
   * The window's quad cut into a jittered grid of triangles (BURST.cols × rows × 2), each flung out
   * from the middle with its own spin and tumble.
   */
  function shatter(corners: [number, number][], ox: number, oy: number, k: number): Shard[] {
    if (corners.length < 4) return []
    const [tl, tr, br, bl] = corners
    const C = BURST.cols
    const Rw = BURST.rows
    // Grid points on the quad, the inner ones jittered so the cracks run crooked.
    const at = (i: number, j: number): [number, number] => {
      const ji = i > 0 && i < C ? (rand() - 0.5) * 0.6 : 0
      const jj = j > 0 && j < Rw ? (rand() - 0.5) * 0.6 : 0
      const u = (i + ji) / C
      const v = (j + jj) / Rw
      const top = [tl[0] + (tr[0] - tl[0]) * u, tl[1] + (tr[1] - tl[1]) * u]
      const bot = [bl[0] + (br[0] - bl[0]) * u, bl[1] + (br[1] - bl[1]) * u]
      return [top[0] + (bot[0] - top[0]) * v - ox, top[1] + (bot[1] - top[1]) * v - oy]
    }
    const g: [number, number][][] = []
    for (let i = 0; i <= C; i++) {
      g.push([])
      for (let j = 0; j <= Rw; j++) g[i].push(at(i, j))
    }
    const mx = (tl[0] + br[0]) / 2 - ox
    const my = (tl[1] + br[1]) / 2 - oy
    const out: Shard[] = []
    for (let i = 0; i < C; i++) {
      for (let j = 0; j < Rw; j++) {
        const quad = [g[i][j], g[i + 1][j], g[i + 1][j + 1], g[i][j + 1]]
        const tris = rand() < 0.5 ? [[0, 1, 2], [0, 2, 3]] : [[0, 1, 3], [1, 2, 3]]
        for (const tri of tris) {
          const v = tri.map((n) => quad[n])
          const cx = (v[0][0] + v[1][0] + v[2][0]) / 3
          const cy = (v[0][1] + v[1][1] + v[2][1]) / 3
          const dx = cx - mx
          const dy = cy - my
          const d = Math.hypot(dx, dy) || 1
          const sp = (140 + rand() * 360) * k
          out.push({
            x: cx,
            y: cy,
            vx: (dx / d) * sp + (rand() - 0.5) * 120,
            vy: (dy / d) * sp + (rand() - 0.5) * 120,
            rot: 0,
            vr: (rand() - 0.5) * 9,
            w: 0,
            h: 0,
            life: 0.7 + rand() * 0.4,
            ch: '',
            pts: v.flatMap(([x, y]) => [x - cx, y - cy]),
            tumble: 0,
            vt: (2 + rand() * 6) * (rand() < 0.5 ? -1 : 1)
          })
        }
      }
    }
    return out
  }
  function startBurst(ox: number, oy: number): void {
    burstAt = fxBurst.at
    waveSeed = rand() * 50
    waveTilt = rand() * Math.PI
    waveAsp = 0.75 + rand() * 0.25
    burstTint = hexRgb(fxBurst.color) ?? [ar, ag, ab]
    const x = fxBurst.x - ox
    const y = fxBurst.y - oy
    const k = Math.min(1.8, Math.max(fxBurst.r, BURST.minR) / 60)
    const many = reduced ? 0 : 0.5 + 0.5 * Math.min(1, intensity)
    const fling = (speed: number[], life: number[], w: number[], h: number[], ch = '') => {
      const a = rand() * Math.PI * 2
      const v = span(speed) * k * (0.4 + 0.6 * rand())
      return { x: x + (rand() - 0.5) * fxBurst.r, y: y + (rand() - 0.5) * fxBurst.r * 0.7, vx: Math.cos(a) * v, vy: Math.sin(a) * v, rot: rand() * Math.PI, vr: (rand() - 0.5) * 18, w: span(w), h: span(h), life: span(life), ch }
    }
    burstBits = many ? shatter(fxBurst.corners, ox, oy, k) : []
    burstSparks = Array.from({ length: Math.round(BURST.sparks * many) }, () => fling([380, 1100], [0.25, 0.6], [0, 0], [0, 0]))
    burstGlyphs = Array.from({ length: Math.round(BURST.glyphs * many) }, () => fling([90, 260], [0.3, 0.55], [0, 0], [0, 0], GLYPHS[Math.floor(rand() * GLYPHS.length)]))
  }
  /** The burst's light (pop, flash, ring), on its own canvas whose top-left is (ox, oy) on screen. */
  function drawBurst(b: CanvasRenderingContext2D, now: number, ox: number, oy: number): void {
    if (!burstAlive(now)) return
    // Pieces are kept in screen coordinates; each canvas draws them offset by its own top-left.
    if (burstAt !== fxBurst.at) startBurst(0, 0)
    const T = (now - fxBurst.at) / 1000
    const x = fxBurst.x - ox
    const y = fxBurst.y - oy
    const R = Math.max(fxBurst.r, BURST.minR)
    b.globalCompositeOperation = 'lighter'
    // The flash: lights up the pit around it, gone in ~0.26s.
    const fk = Math.min(1, T / 0.26)
    if (fk < 1) {
      const fr = R * BURST.flash * (0.6 + 0.4 * fk)
      const g = b.createRadialGradient(x, y, 0, x, y, fr)
      const a = Math.pow(1 - fk, 2)
      g.addColorStop(0, lit(0.9 * a))
      g.addColorStop(0.25, col(0.45 * a))
      g.addColorStop(1, col(0))
      b.fillStyle = g
      b.fillRect(x - fr, y - fr, fr * 2, fr * 2)
    }
    // The pop: a hard core and a cross glint, ~60ms.
    if (T < 0.07) {
      const a = 1 - T / 0.07
      const g = b.createRadialGradient(x, y, 0, x, y, R * 0.6)
      g.addColorStop(0, `rgba(235,255,240,${a.toFixed(3)})`)
      g.addColorStop(1, lit(0))
      b.fillStyle = g
      b.fillRect(x - R * 0.6, y - R * 0.6, R * 1.2, R * 1.2)
      b.strokeStyle = lit(0.85 * a)
      b.lineWidth = 1.2
      b.beginPath()
      b.moveTo(x - R * 3, y)
      b.lineTo(x + R * 3, y)
      b.moveTo(x, y - R * 1.4)
      b.lineTo(x, y + R * 1.4)
      b.stroke()
    }
    // The shockwave: one ring, its edge fringed red and cyan like the glitches.
    const rk = (T - 0.02) / 0.4
    if (rk > 0 && rk < 1 && !reduced) {
      const rr = R * 0.5 + R * BURST.ring * (1 - Math.pow(1 - rk, 3))
      const a = 0.7 * Math.pow(1 - rk, 1.6)
      // A main strand (with the red / cyan fringe) and two faint ones either side, so it reads as
      // a smeared ripple. Each is lumpy (its radius wanders on noise and warps as it grows), squashed
      // and tilted per burst, and broken into arcs where its brightness noise drops away.
      const N = 56
      const strands = [[1, 0, 1], [0.95, 17, 0.35], [1.06, 31, 0.3]] as const
      for (const [scale, seed, w] of strands) {
        for (const [dx, tint, k] of seed === 0
          ? ([[-1.2, 'r', 0.3], [1.2, 'c', 0.3], [0, 'g', 1]] as const)
          : ([[0, 'g', 1]] as const)) {
          let prev: [number, number] | null = null
          for (let i = 0; i <= N; i++) {
            const ang = (i / N) * Math.PI * 2
            const ca = Math.cos(ang)
            const sa = Math.sin(ang)
            const lump = 1 + 0.16 * noise2(ca * 1.7 + waveSeed + seed, sa * 1.7 + T * 3)
            const r0 = rr * scale * lump
            const ex = ca * r0
            const ey = sa * r0 * waveAsp
            const pt: [number, number] = [x + dx + ex * Math.cos(waveTilt) - ey * Math.sin(waveTilt), y + ex * Math.sin(waveTilt) + ey * Math.cos(waveTilt)]
            if (prev) {
              const n = noise2(ca * 2.3 + waveSeed * 2 + seed, sa * 2.3 - T * 2)
              const seg = Math.max(0, Math.min(1, 0.2 + 1.4 * n)) * a * w * k
              if (seg > 0.01) {
                b.strokeStyle = tint === 'r' ? `rgba(255,60,110,${seg.toFixed(3)})` : tint === 'c' ? `rgba(60,220,255,${seg.toFixed(3)})` : col(seg)
                b.lineWidth = (0.4 + 2 * (1 - rk)) * (0.5 + 0.8 * Math.max(0, n + 0.3)) * (seed === 0 ? 1 : 0.6) * (tint === 'g' ? 1 : 0.6)
                b.beginPath()
                b.moveTo(prev[0], prev[1])
                b.lineTo(pt[0], pt[1])
                b.stroke()
              }
            }
            prev = pt
          }
        }
      }
    }
    b.globalCompositeOperation = 'source-over'
  }
  /**
   * The burst's matter (shards, sparks, glyphs) inside the pit (drawPit, whose canvas starts at
   * pitOX/pitOY): each piece sinks from z ~1.2 to ~6 over its life, shrinking with depth and
   * fading into the fog colour, under a veil of mist, so it's in the mist rather than on it.
   * (bx, by): the bottom it's pulled toward, on screen.
   */
  const FOG_RGB: [number, number, number] = [2, 12, 7]
  function drawBurstMatter(b: CanvasRenderingContext2D, now: number, dt: number, q: number, bx: number, by: number, t: number): void {
    if (!burstAlive(now)) return
    if (burstAt !== fxBurst.at) startBurst(0, 0)
    const T = (now - fxBurst.at) / 1000
    const ox = pitOX
    const oy = pitOY
    const [tr, tg, tb] = burstTint
    const depth = (life: number) => 1.2 + 4.8 * Math.pow(Math.min(1, T / life), 0.9)
    const fogOf = (z: number) => 1 - Math.exp(-0.24 * (z - 1))
    const mixRgb = (c: [number, number, number], m: number) => c.map((v, i) => Math.round(v + (FOG_RGB[i] - v) * m)).join(',')
    // Everything flung out is slowed, then caught by the pull and wound down into the dark.
    const step = (p: Bit, drag: number, pull: number) => {
      p.vx *= Math.exp(-drag * dt)
      p.vy *= Math.exp(-drag * dt)
      const dx = bx - p.x
      const dy = by - p.y
      const d = Math.hypot(dx, dy) || 1
      const g = pull * Math.min(1, T / 0.25)
      p.vx += ((dx / d) * g - (dy / d) * g * 0.8) * dt
      p.vy += ((dy / d) * g + (dx / d) * g * 0.8) * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.rot += p.vr * dt
    }
    b.setTransform(q, 0, 0, q, -ox * q, -oy * q)
    b.globalCompositeOperation = 'lighter'
    b.lineWidth = 1
    for (const p of burstSparks) {
      if (T > p.life) continue
      step(p, 3.2, 700)
      const m = fogOf(depth(p.life))
      const a = (1 - T / p.life) * (1 - 0.8 * m) * (rand() < 0.1 ? 0.3 : 1)
      b.strokeStyle = lit(0.85 * a)
      b.beginPath()
      b.moveTo(p.x, p.y)
      b.lineTo(p.x - p.vx * 0.025, p.y - p.vy * 0.025)
      b.stroke()
    }
    b.globalCompositeOperation = 'source-over'
    const glassRgb: [number, number, number] = [Math.round(tr * 0.18 + 2), Math.round(tg * 0.18 + 6), Math.round(tb * 0.18 + 4)]
    const edgeRgb: [number, number, number] = [Math.min(255, tr + 60), Math.min(255, tg + 60), Math.min(255, tb + 60)]
    b.lineJoin = 'round'
    for (const p of burstBits) {
      if (T > p.life) continue
      step(p, 2, 700)
      p.tumble += p.vt * dt
      const z = depth(p.life)
      const m = fogOf(z)
      // Smaller the deeper it is, and swallowed by the fog as it goes.
      const sc = 1.2 / z
      b.globalAlpha = Math.min(1, (1 - Math.pow(T / p.life, 3)) * (1 - 0.85 * m))
      b.setTransform(q, 0, 0, q, (p.x - ox) * q, (p.y - oy) * q)
      b.rotate(p.rot)
      b.scale(sc, sc * (0.15 + 0.85 * Math.abs(Math.cos(p.tumble))))
      const v = p.pts
      b.beginPath()
      b.moveTo(v[0], v[1])
      b.lineTo(v[2], v[3])
      b.lineTo(v[4], v[5])
      b.closePath()
      b.fillStyle = `rgb(${mixRgb(glassRgb, m)})`
      b.fill()
      // The lit edge flashes as the face turns to the light, dimmer the deeper it is.
      b.globalAlpha *= (0.45 + 0.55 * Math.abs(Math.sin(p.tumble))) * (1 - 0.7 * m)
      b.strokeStyle = `rgb(${mixRgb(edgeRgb, m)})`
      b.lineWidth = 1 / sc
      b.stroke()
    }
    b.globalAlpha = 1
    b.setTransform(q, 0, 0, q, -ox * q, -oy * q)
    b.globalCompositeOperation = 'lighter'
    b.font = '600 11px "JetBrains Mono", monospace'
    b.textAlign = 'center'
    b.textBaseline = 'middle'
    for (const p of burstGlyphs) {
      const t0 = T - 0.06
      if (t0 < 0 || t0 > p.life) continue
      step(p, 1.5, 300)
      b.fillStyle = lit(0.8 * (1 - t0 / p.life) * (1 - 0.8 * fogOf(depth(p.life))))
      b.fillText(p.ch, p.x, p.y)
    }
    b.globalCompositeOperation = 'source-over'
    // The veil over them: dark smoke and a thin wisp turning with the pit, thickening as they sink.
    b.setTransform(q, 0, 0, q, 0, 0)
    const veil = Math.min(1, T / 0.35) * pit
    const R = Math.max(fxBurst.r, BURST.minR) * 2.6
    drawMist(b, bx - ox, by - oy, R, t * 0.5, 0.45 * veil, false)
    drawMist(b, bx - ox, by - oy, R * 1.3, -t * 0.35 + 1.7, 0.14 * veil, true)
  }
  let burstShown = false
  /** Where drawPit left the siphon this frame (in the pit's box), for the light layer to draw. */
  let siphonArgs: { sw: number; sh: number; ix: number; iy: number; dt: number; t: number } | null = null
  /**
   * The pit's light layer, on its own canvas at the screen's resolution (behind the app, over the
   * backdrop): the currents and dust while the pit is open, and the burst. Shown only then.
   */
  function drawBurstLayer(now: number): void {
    const bc = opts.burst
    if (!bc) return
    const sip = pit > 0.01 && pitBox && siphonArgs ? siphonArgs : null
    siphonArgs = null
    if (!burstAlive(now) && !sip) {
      if (burstShown) {
        bc.style.display = 'none'
        burstShown = false
      }
      return
    }
    // The pit's box while it's open; else the stage's, with a margin so the ring isn't cut.
    const m = 120
    const x0 = sip ? pitBox![0] : fxPit.x0 - m
    const y0 = sip ? pitBox![1] : fxPit.y0 - m
    const sw = sip ? pitBox![2] : fxPit.x1 - fxPit.x0 + m * 2
    const sh = sip ? pitBox![3] : fxPit.y1 - fxPit.y0 + m * 2
    const q = pitDpr()
    const bw = Math.ceil(sw * q)
    const bh = Math.ceil(sh * q)
    const placed = `${x0},${y0},${sw},${sh}`
    if (!burstShown || bc.dataset.placed !== placed) {
      Object.assign(bc.style, { display: 'block', left: `${x0}px`, top: `${y0}px`, width: `${sw}px`, height: `${sh}px` })
      bc.dataset.placed = placed
      burstShown = true
    }
    if (bc.width !== bw || bc.height !== bh) {
      bc.width = bw
      bc.height = bh
    }
    const b = bc.getContext('2d')!
    b.setTransform(1, 0, 0, 1, 0, 0)
    b.clearRect(0, 0, bw, bh)
    b.setTransform(q, 0, 0, q, 0, 0)
    b.globalAlpha = 1
    if (sip) {
      b.lineCap = 'round'
      b.lineJoin = 'round'
      drawSiphon(b, q, sip.sw, sip.sh, sip.ix, sip.iy, sip.dt, sip.t)
      // Feathered into the board at the pit's edge, like the pit itself.
      if (pitMask) {
        b.setTransform(1, 0, 0, 1, 0, 0)
        b.globalCompositeOperation = 'destination-in'
        b.drawImage(pitMask, 0, 0, bw, bh)
        b.globalCompositeOperation = 'source-over'
        b.setTransform(q, 0, 0, q, 0, 0)
      }
    }
    drawBurst(b, now, x0, y0)
  }

  /** The pit canvas's top-left on screen (the stage's box plus the tunnel's margin). */
  let pitOX = 0
  let pitOY = 0
  /** The pit's parallax: where something at depth scale sc (1 = the board's near plane) has moved to with the pointer. */
  const pitShift = (sc: number): [number, number] => [-px * DEPTH.near * sc, -py * DEPTH.near * sc]
  let tunSrc: HTMLCanvasElement | null = null
  let tunMask: HTMLCanvasElement | null = null
  /** The tunnel is drawn here at 1x (it's made of the backdrop, which is only 1.5x) and scaled up once. */
  let tunBuf: HTMLCanvasElement | null = null
  /**
   * The tunnel (PIT_TUNNEL): the backdrop under the pit, copied and feathered once a frame, then
   * stamped smaller and smaller, each turned further, about the vanishing point (which shifts less
   * with the pointer the deeper it is), with a dark fog over each copy that thickens with depth
   * and mist sheets drifting between. The first stamp is the backdrop itself, so there's no seam.
   */
  function drawTunnel(b: CanvasRenderingContext2D, q: number, sw: number, sh: number, cx: number, cy: number, t: number): void {
    const T = PIT_TUNNEL
    // The board under the pit, without parallax; each stamp then gets one shift of its own, the
    // board's at the mouth and less the deeper it is, so the far end holds still.
    const w = Math.ceil(sw * dpr)
    const h = Math.ceil(sh * dpr)
    if (w < 4 || h < 4) return
    tunSrc ??= document.createElement('canvas')
    if (tunSrc.width !== w || tunSrc.height !== h) {
      tunSrc.width = w
      tunSrc.height = h
      // Soft all the way: solid only near the middle, so each stamp melts into the one around it.
      tunMask = document.createElement('canvas')
      tunMask.width = w
      tunMask.height = h
      const m = tunMask.getContext('2d')!
      m.translate(w / 2, h / 2)
      m.scale(w / 2, h / 2)
      const g = m.createRadialGradient(0, 0, 0, 0, 0, 1)
      g.addColorStop(0, 'rgba(0,0,0,1)')
      g.addColorStop(0.45, 'rgba(0,0,0,1)')
      g.addColorStop(0.7, 'rgba(0,0,0,0.6)')
      g.addColorStop(0.88, 'rgba(0,0,0,0.2)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      m.fillStyle = g
      m.fillRect(-1, -1, 2, 2)
    }
    const src = tunSrc.getContext('2d')!
    // In layer space (no parallax at all): the far board and the base board, as drawFar/drawBase do.
    const lx = Math.round((pitOX + OVERSCAN) * dpr)
    const ly = Math.round((pitOY + OVERSCAN) * dpr)
    src.clearRect(0, 0, w, h)
    // The crisp board only: the far layer's blurred, grainy pieces read as clouds flashing in and
    // out as the stamps turn past each other.
    if (staticLayer) {
      src.globalAlpha = 0.85
      src.drawImage(staticLayer, lx, ly, w, h, 0, 0, w, h)
      src.globalAlpha = 1
    }
    src.globalCompositeOperation = 'destination-in'
    src.drawImage(tunMask!, 0, 0)
    src.globalCompositeOperation = 'source-over'
    // No base copy: the pit canvas is clear there, so the real backdrop shows through, seamlessly.
    const tq = Math.min(1, q)
    const tw = Math.ceil(sw * tq)
    const th = Math.ceil(sh * tq)
    tunBuf ??= document.createElement('canvas')
    if (tunBuf.width !== tw || tunBuf.height !== th) {
      tunBuf.width = tw
      tunBuf.height = th
    }
    const out = b
    b = tunBuf.getContext('2d')!
    b.setTransform(1, 0, 0, 1, 0, 0)
    b.clearRect(0, 0, tw, th)
    q = tq
    const R = Math.max(sw, sh) / 2
    let mist = 0
    for (let k = 1; k <= T.layers; k++) {
      const sc = Math.pow(T.scale, k)
      // Deeper is farther: a stamp at scale sc moves sc times as far as the board (translated before
      // it's turned, so every layer moves the same way), and the deep end hardly moves at all.
      const [ox, oy] = pitShift(sc)
      const vx = cx + ox
      const vy = cy + oy
      // Still at the mouth (like the board round it), turning harder the deeper it goes.
      const d = (k - 1) / (T.layers - 1)
      const rot = d * T.twist * T.layers + t * T.spin * (0.2 + 2.2 * d * d)
      b.setTransform(q, 0, 0, q, vx * q, vy * q)
      b.rotate(rot)
      b.scale(sc, sc)
      b.drawImage(tunSrc, -cx, -cy, sw, sh)
      // Each copy sinks further into the dark.
      b.setTransform(q, 0, 0, q, 0, 0)
      const fr = R * sc * 1.05
      const fog = 1 - Math.pow(1 - T.fog, k)
      const g = b.createRadialGradient(vx, vy, 0, vx, vy, fr)
      g.addColorStop(0, `rgba(1,7,4,${fog.toFixed(3)})`)
      g.addColorStop(0.55, `rgba(1,7,4,${(fog * 0.85).toFixed(3)})`)
      g.addColorStop(1, 'rgba(1,7,4,0)')
      b.fillStyle = g
      b.fillRect(vx - fr, vy - fr, fr * 2, fr * 2)
      // And now and then a sheet of mist drifts across it.
      if (mist < PIT_MIST.at.length && PIT_MIST.at[mist] === k) {
        // Pale wisps up top; deeper, only dark smoke, so the deep reads as darkness, not fog.
        drawMist(b, vx, vy, fr * 1.25, t * T.spin * (0.3 + 2.4 * d * d) + k * 2.1, PIT_MIST.alpha[mist] * pit, mist < 2)
        mist++
      }
    }
    // The bottom: no floor, it just goes black, with a faint breathing rim of light round the dark.
    const hr = R * 0.62
    const breathe = 0.7 + 0.3 * Math.sin(t * 1.3)
    const [dx0, dy0] = pitShift(Math.pow(T.scale, T.layers))
    const ccx = cx + dx0
    const ccy = cy + dy0
    const g = b.createRadialGradient(ccx, ccy, 0, ccx, ccy, hr)
    // Falls off gradually (no edge), so the swirl sinks into the black rather than meeting it.
    g.addColorStop(0, 'rgba(0,0,0,1)')
    g.addColorStop(0.2, 'rgba(0,0,0,0.97)')
    g.addColorStop(0.38, 'rgba(0,2,1,0.82)')
    g.addColorStop(0.56, `rgba(1,8,4,${(0.48 + 0.06 * breathe).toFixed(3)})`)
    g.addColorStop(0.76, `rgba(2,14,8,${(0.18 + 0.04 * breathe).toFixed(3)})`)
    g.addColorStop(1, 'rgba(2,10,5,0)')
    b.fillStyle = g
    b.fillRect(ccx - hr, ccy - hr, hr * 2, hr * 2)
    // Up to the pit's resolution, once.
    out.setTransform(1, 0, 0, 1, 0, 0)
    out.drawImage(tunBuf, 0, 0, tw, th, 0, 0, out.canvas.width, out.canvas.height)
  }
  /**
   * One sheet of mist, turned with the swirl and stretched along it (so it reads as vapour being
   * dragged round): pale wisps, or dark smoke.
   */
  function drawMist(b: CanvasRenderingContext2D, x: number, y: number, r: number, turn: number, a: number, pale: boolean): void {
    if (pitSmoke.length < 3 || a <= 0.005) return
    const t0 = b.getTransform()
    b.translate(x, y)
    b.rotate(turn)
    b.globalAlpha = Math.min(1, pale ? a : a * 1.6)
    const img = pale ? pitSmoke[2] : pitSmoke[0]
    b.drawImage(img, -r * 1.35, -r * 0.8, r * 2.7, r * 1.6)
    b.rotate(1.9)
    b.globalAlpha *= 0.6
    b.drawImage(img, -r * 1.2, -r * 0.7, r * 2.4, r * 1.4)
    b.globalAlpha = 1
    b.setTransform(t0)
  }
  function drawPit(now: number, dt: number): void {
    // TEMP (debug): with the active window hidden (App's HIDE button), hold the pit open over the stage.
    const dbg = document.documentElement.classList.contains('dbg-hide-stage')
    if (dbg) {
      const r = stageRect()
      if (r && !document.documentElement.classList.contains('is-hinging')) Object.assign(fxPit, { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom })
    }
    const target = dbg ? 1 : Math.max(fxPit.s, burstAlive(now) ? 0.9 : 0)
    // Opens in ~0.15s, closes over ~0.45s after the window is gone.
    pit += (target - pit) * (1 - Math.exp(-dt / (target > pit ? 0.06 : 0.35)))
    if (pit < 0.01) {
      pit = 0
      pitOpenAt = 0
      pitBox = null
      return
    }
    if (!pitSprites.length) return
    const pc = (pitOff ??= document.createElement('canvas'))
    const stw = fxPit.x1 - fxPit.x0
    const sth = fxPit.y1 - fxPit.y0
    if (stw < 10 || sth < 10) return
    // The pull reaches past the stage (under the chrome), so nothing shows where it ends.
    const mg = Math.round(PIT_TUNNEL.margin * Math.max(stw, sth))
    pitOX = fxPit.x0 - mg
    pitOY = fxPit.y0 - mg
    const sw = stw + mg * 2
    const sh = sth + mg * 2
    pitBox = [pitOX, pitOY, sw, sh]
    if (!pitOpenAt) {
      pitOpenAt = now
      openPit()
    }
    const t = now / 1000
    // It covers the stage's box (plus the margin), at the backdrop's resolution.
    const q = dpr
    const bw = Math.ceil(sw * q)
    const bh = Math.ceil(sh * q)
    if (pc.width !== bw || pc.height !== bh) {
      pc.width = bw
      pc.height = bh
      // Feathered oval over the box, wide and soft: what's at its edge is the backdrop itself.
      pitMask = document.createElement('canvas')
      pitMask.width = bw
      pitMask.height = bh
      const m = pitMask.getContext('2d')!
      m.translate(bw / 2, bh / 2)
      m.scale(bw / 2, bh / 2)
      const g = m.createRadialGradient(0, 0, 0, 0, 0, 1)
      g.addColorStop(0, 'rgba(0,0,0,1)')
      g.addColorStop(0.45, 'rgba(0,0,0,1)')
      g.addColorStop(0.8, 'rgba(0,0,0,0.6)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      m.fillStyle = g
      m.fillRect(-1, -1, 2, 2)
    }
    const b = pc.getContext('2d')!
    // World units: 1 = the wall radius at the mouth. Screen = C + (X - cam) * S / Z.
    const S = PIT.wall * Math.max(sw, sh)
    const C = [sw / 2, sh / 2]
    const camX = (px * PIT.cam) / S
    const camY = (py * PIT.cam) / S
    const proj = (X: number, Y: number, Z: number): [number, number, number] => {
      const s = S / Z
      return [C[0] + (X - camX) * s, C[1] + (Y - camY) * s, s]
    }
    b.setTransform(q, 0, 0, q, 0, 0)
    b.globalCompositeOperation = 'source-over'
    b.globalAlpha = 1
    const [bx, by] = proj(0, 0, PIT.depth)
    drawTunnel(b, q, sw, sh, C[0], C[1], t)

    // The boards, far to near, with a fog floor laid over everything below each depth.
    for (const p of pitBoards) {
      p.z *= Math.exp(dt * PIT.sink)
      p.a += dt * pitSwirl(p.z)
      p.spin += dt * p.vs
      p.tumble += dt * p.vt
      if (p.z > PIT.depth) {
        p.z = PIT.top
        p.a = rand() * Math.PI * 2
        p.sp = Math.floor(rand() * pitSprites.length)
      }
    }
    const order = [...pitBoards].sort((u, v) => v.z - u.z)
    let fog = 0
    const fogFloor = (zf: number) => {
      const [fx, fy, fs] = proj(0, 0, zf)
      const r = fs * 1.5
      const g = b.createRadialGradient(fx, fy, 0, fx, fy, r)
      g.addColorStop(0, 'rgba(1,5,3,0.58)')
      g.addColorStop(0.6, 'rgba(1,5,3,0.32)')
      g.addColorStop(1, 'rgba(1,5,3,0)')
      b.fillStyle = g
      b.fillRect(fx - r, fy - r, r * 2, r * 2)
      // (No noise texture here: small, deep and turning, it read as cloud blobs flashing past.)
    }
    for (const p of order) {
      while (fog < PIT_FOG.length && p.z < PIT_FOG[fog]) fogFloor(PIT_FOG[fog++])
      const spr = pitSprites[p.sp] ?? pitSprites[0]
      const [x, y, s] = proj(Math.cos(p.a) * p.rho, Math.sin(p.a) * p.rho, p.z)
      const k = (s / S) * PIT.size / q
      // Fade in at the mouth (it comes back from up there) and into the dark at the bottom.
      const a = Math.min(1, (p.z - PIT.top) / 0.6) * Math.min(1, (PIT.depth - p.z) / 3) * 0.75 * Math.exp(-(p.z - PIT.top) * 0.22)
      if (a <= 0.01) continue
      b.globalAlpha = a
      // Lying along the wall: seen edge-on across the shaft (squashed along the radius),
      // turning in its own plane and flipping as it tumbles.
      b.setTransform(q, 0, 0, q, x * q, y * q)
      b.rotate(p.a)
      b.scale(0.45 + 0.55 * Math.abs(Math.cos(p.tumble)), 1)
      b.rotate(p.spin)
      b.transform(p.asp, 0, p.skew, 1, 0, 0)
      b.scale(k, k)
      b.drawImage(spr, -spr.width / 2, -spr.height / 2)
    }
    while (fog < PIT_FOG.length) fogFloor(PIT_FOG[fog++])
    b.setTransform(q, 0, 0, q, 0, 0)
    b.globalAlpha = 1

    // Specks of data falling through: tiny glyphs, brightest near the mouth.
    b.globalCompositeOperation = 'lighter'
    b.font = '600 11px "JetBrains Mono", monospace'
    b.textAlign = 'center'
    b.textBaseline = 'middle'
    for (let i = 0; i < pitSpecks.length; i++) {
      const p = pitSpecks[i]
      p.z *= Math.exp(dt * p.v)
      p.a += dt * pitSwirl(p.z) * 1.3
      if (p.z > PIT.depth) pitSpecks[i] = newSpeck()
      const [x, y, s] = proj(Math.cos(p.a) * p.rho, Math.sin(p.a) * p.rho, p.z)
      const near = s / S
      b.fillStyle = col(Math.min(0.85, 0.9 * near) * Math.min(1, (p.z - 1) / 0.2))
      b.setTransform(q * Math.max(0.25, near), 0, 0, q * Math.max(0.25, near), x * q, y * q)
      b.fillText(p.ch, 0, 0)
    }
    b.setTransform(q, 0, 0, q, 0, 0)
    b.globalAlpha = 1
    // The currents and dust go on the light layer (drawBurstLayer), at the screen's resolution.
    siphonArgs = { sw, sh, ix: bx, iy: by, dt, t }
    drawBurstMatter(b, now, dt, q, C[0] + pitOX + pitShift(0.15)[0], C[1] + pitOY + pitShift(0.15)[1], t)
    b.setTransform(1, 0, 0, 1, 0, 0)
    // Feathered to nothing at the edge, so it melts into the board under it (it fades in, in place).
    b.globalCompositeOperation = 'destination-in'
    b.drawImage(pitMask!, 0, 0)
    b.globalCompositeOperation = 'source-over'
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = pit
    ctx.drawImage(pc, Math.round(pitOX * dpr), Math.round(pitOY * dpr))
    ctx.globalAlpha = 1
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
      gT: 0,
      gW: false,
      cU: new Array(len).fill(0),
      cDx: new Array(len).fill(0),
      cT: new Array(len).fill(0),
      cW: new Array(len).fill(false)
    }
  }
  const span = (r: number[]) => r[0] + rand() * (r[1] - r[0])
  /** A split for a glyph of `size` px: a fraction of it, either way (never under ~1px, or it vanishes). */
  const splitPx = (size: number, wide: boolean) =>
    Math.max(0.8, span(wide ? RAIN_GLITCH.wide : RAIN_GLITCH.split) * size) * (rand() < 0.5 ? -1 : 1)
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

  /**
   * Each rain plane's glyphs pre-drawn in one sheet (built at idle, with the pit's sprites): a
   * glyph falling into the pit is stamped from it, since text drawn at an ever-changing size and angle each
   * frame is slow enough to drop frames.
   */
  let flushAtlas: { c: HTMLCanvasElement; cell: number; dpr: number }[] = []
  const GLYPH_INDEX = new Map([...GLYPHS].map((ch, i) => [ch, i]))
  const ATLAS_COLS = 16
  function buildFlushAtlas(): void {
    const glyphs = [...GLYPHS]
    flushAtlas = RAIN_PLANES.map((pl) => {
      const cell = Math.ceil(pl.size * 1.5 * dpr)
      const sheet = (fill: string) => {
        const c = document.createElement('canvas')
        c.width = cell * ATLAS_COLS
        c.height = cell * Math.ceil(glyphs.length / ATLAS_COLS)
        const g = c.getContext('2d')!
        g.font = `600 ${pl.size * dpr}px "JetBrains Mono", monospace`
        g.textAlign = 'center'
        g.textBaseline = 'middle'
        g.fillStyle = fill
        glyphs.forEach((ch, i) => g.fillText(ch, (i % ATLAS_COLS) * cell + cell / 2, Math.floor(i / ATLAS_COLS) * cell + cell / 2))
        return { c, g }
      }
      return { c: sheet(hot(1)).c, cell, dpr }
    })
  }

  /**
   * Rain falling into the pit, as physics. When a drop comes near the open pit its glyphs are let
   * go as particles (free: x, y, vx, vy, z each, in the plane's layer space; z = 1 is the plane,
   * more is further down the shaft), starting exactly where and as fast as they were falling.
   * Each frame their velocity relaxes toward the vortex's current (mostly inward, some swirl the
   * tunnel's way round), harder the nearer they are, with curl-noise turbulence; near the middle
   * they sink away in depth, seen in perspective toward the vanishing point, so they converge on
   * it, shrink and fade. Far out the current has no grip and they just rain on. A column is a train
   * of particles, so the glyphs behind follow the leader's curve: streams drawn in.
   */
  const PHYS = {
    /** Field radius (x the pit's half-size); the grip falls off as (1 - r/field)^falloff. */
    field: 1.05,
    falloff: 2.4,
    /** The current: inward speed (px/s, full grip; plus a floor), and the swirl as a share of it. */
    inSpeed: 620,
    inFloor: 60,
    swirl: 0.35,
    /** ...tapering to this share at full grip, so deep in it's mostly a plunge. */
    swirlIn: 0.2,
    /** How hard the current takes hold (1/s, at full grip). */
    grip: 7,
    /** Turbulence (px/s^2 at full grip), its scale and how fast it churns. */
    turb: 460,
    turbScale: 0.012,
    turbRate: 1.6,
    /** Surges in the pull: share, and rate (rad/s). */
    gust: 0.35,
    gustRate: 3.1,
    /** Sinking in depth: rate (1/s, at full grip). */
    sinkRate: 3.6,
    /** Gone this deep; and how fast it fades with depth. */
    zMax: 14,
    fadeZ: 0.55,
    /** At most this many drops let go at once. */
    cap: 40
  }
  type RainField = { sx: number; sy: number; R0: number; Rf: number }
  /** The pit's sink on screen (CSS px), kept after it shuts so free rain still has a vanishing point. */
  const sinkScreen = [0, 0]
  function freeDrop(d: Drop, step: number): void {
    const P = new Float32Array(d.len * 5)
    for (let k = 0; k < d.len; k++) {
      P[k * 5] = d.x
      P[k * 5 + 1] = d.y - k * step
      P[k * 5 + 3] = d.v
      P[k * 5 + 4] = 1
    }
    d.free = P
  }
  /** Moves and draws a let-go drop; false once every glyph is gone (swallowed, or off the bottom). */
  function drawFreeDrop(d: Drop, pl: (typeof RAIN_PLANES)[number], dt: number, t: number, f: RainField | null): boolean {
    const P = d.free!
    const atlas = flushAtlas[d.z]
    if (!atlas) return false
    const cl = atlas.cell
    const g = pl.glow ? 1 : 0.5
    let alive = false
    for (let k = 0; k < d.len; k++) {
      const o = k * 5
      let z = P[o + 4]
      if (z <= 0) continue
      let x = P[o]
      let y = P[o + 1]
      let vx = P[o + 2]
      let vy = P[o + 3]
      if (f) {
        const rx = x - f.sx
        const ry = y - f.sy
        const r = Math.hypot(rx, ry) || 1
        // The grip falls off gradually all the way out: a nudge at the edge, a hard suck in the middle.
        const w = Math.pow(Math.max(0, 1 - r / f.Rf), PHYS.falloff)
        if (w > 0.001) {
          // Each glyph has its own temper (fixed per drop and glyph), so a column frays into a
          // ragged stream rather than moving as one ribbon.
          const hg = hash2(d.x * 0.37 + k * 1.91, d.len * 3.3)
          const hs = hash2(k * 2.71 + 5, d.x * 0.29)
          const hz = hash2(d.x * 0.53, k * 0.83 + 11)
          const gust = 1 + PHYS.gust * Math.sin(t * PHYS.gustRate + d.x * 0.07)
          // The current here: in toward the sink, and round it (the tunnel's way: clockwise on screen).
          const uin = (PHYS.inFloor + PHYS.inSpeed * Math.pow(w, 0.7)) * gust
          const ut = (PHYS.swirl + (PHYS.swirlIn - PHYS.swirl) * w) * uin * (1.05 + 0.55 * hs)
          const ux = (-rx / r) * uin + (-ry / r) * ut
          const uy = (-ry / r) * uin + (rx / r) * ut
          const b = 1 - Math.exp(-PHYS.grip * w * (1 + 0.4 * hg) * dt)
          vx += (ux - vx) * b
          vy += (uy - vy) * b
          const [cx, cy] = curl(x * PHYS.turbScale, y * PHYS.turbScale, t * PHYS.turbRate)
          const tw = PHYS.turb * Math.pow(w, 0.6) * dt
          vx += cx * tw
          vy += cy * tw
          z += z * PHYS.sinkRate * Math.pow(w, 1.3) * (1 + 0.3 * hz) * dt
        }
      }
      x += vx * dt
      y += vy * dt
      P[o] = x
      P[o + 1] = y
      P[o + 2] = vx
      P[o + 3] = vy
      P[o + 4] = z
      const al = (k === 0 ? 1 : k < 3 ? 0.9 : Math.pow(1 - k / d.len, 1.4)) * pl.alpha * Math.exp(-PHYS.fadeZ * (z - 1))
      // On screen (CSS px), then in perspective toward the vanishing point by its depth.
      const qx = x - OVERSCAN - px * pl.depth
      const qy = y - OVERSCAN - py * pl.depth
      if (z > PHYS.zMax || al < 0.02 || (qy > VH + pl.step * 2 && z < 1.05)) {
        P[o + 4] = 0
        continue
      }
      alive = true
      const fx = sinkScreen[0] + (qx - sinkScreen[0]) / z
      const fy = sinkScreen[1] + (qy - sinkScreen[1]) / z
      if (rand() < dt * (k === 0 ? 18 : k < 3 ? 10 : 4.5)) d.chars[k] = GLYPHS[Math.floor(rand() * GLYPHS.length)]
      const gi = GLYPH_INDEX.get(d.chars[k])
      if (gi === undefined) continue
      // It leans into its path: upright while it simply rains, tipped as it's swept round.
      const rot = 0.6 * Math.atan2(-vx, Math.max(1, Math.abs(vy)) * Math.sign(vy || 1))
      const sc = 1 / z
      const co = Math.cos(rot) * sc
      const sn = Math.sin(rot) * sc
      ctx.setTransform(co, sn, -sn, co, fx * dpr, fy * dpr)
      if (k === 0 && rainHalo) {
        ctx.globalCompositeOperation = 'lighter'
        ctx.globalAlpha = 0.3 * g * al
        const hs = pl.size * 2.2 * dpr
        ctx.drawImage(rainHalo, -hs / 2 + pl.size * 0.3 * dpr, -hs / 2, hs, hs)
        ctx.globalCompositeOperation = 'source-over'
      }
      ctx.globalAlpha = al
      ctx.drawImage(atlas.c, (gi % ATLAS_COLS) * cl, Math.floor(gi / ATLAS_COLS) * cl, cl, cl, -cl / 2 + pl.size * 0.3 * dpr, -cl / 2, cl, cl)
    }
    ctx.globalAlpha = 1
    depth(pl.depth)
    return alive
  }

  /**
   * The box the pull is centred in: the pit's own while it's open, otherwise the stage's (plus the
   * pit's margin), measured a couple of times a second.
   */
  let stageBox: [number, number, number, number] | null = null
  let stageBoxAt = -1
  function pullBox(now: number): [number, number, number, number] | null {
    if (pitBox) return pitBox
    // Once a frame (the rain and the lights each ask), from the cached stage rect (no layout read).
    if (now !== stageBoxAt) {
      stageBoxAt = now
      const r = stageRect()
      if (r && r.width > 10 && r.height > 10) {
        const mg = Math.round(PIT_TUNNEL.margin * Math.max(r.width, r.height))
        stageBox = [r.left - mg, r.top - mg, r.width + mg * 2, r.height + mg * 2]
      } else stageBox = null
    }
    return stageBox
  }

  function drawRain(dt: number, plane: number): void {
    if (plane === 0) {
      while (rain.length < rainTarget()) rain.push(newDrop(rain.length > 0))
      if (rain.length > rainTarget()) rain.length = rainTarget()
      freed = 0
      for (const d of rain) if (d.free) freed++
    }
    ctx.textBaseline = 'middle'
    if (!rainHalo) rainGlow()
    const now = performance.now()
    const gRate = intensity > 0 && !reduced ? RAIN_GLITCH.rate * (1 + 4 * excite + 3 * wave) * (now < rainGlitchUntil ? 40 : 1) : 0
    // One plane at a time, at its own parallax depth, so pieces can sit between planes.
    const t = now / 1000
    for (let z = plane; z <= plane; z++) {
      const pl = RAIN_PLANES[z]
      depth(pl.depth)
      // The pit's pull in this plane's layer space (see offset). It's always there (behind the
      // stage), drawn or not, so when the pit opens rain is already streaming into it.
      const atlas = flushAtlas[z]
      let field: RainField | null = null
      const box = pullBox(now)
      if (box && !reduced && atlas && atlas.dpr === dpr) {
        const [bx, by, bw, bh] = box
        const R0 = 0.5 * Math.max(bw, bh) * (1 - PIT_TUNNEL.margin)
        sinkScreen[0] = bx + bw / 2
        sinkScreen[1] = by + bh / 2
        field = { sx: sinkScreen[0] + OVERSCAN + px * pl.depth, sy: sinkScreen[1] + OVERSCAN + py * pl.depth, R0, Rf: PHYS.field * R0 }
      }
      ctx.font = `600 ${pl.size}px "JetBrains Mono", monospace`
      // The glyph sheets are at one resolution; if the screen's changed, rebuild them (not mid-switch).
      if (atlas && atlas.dpr !== dpr && !document.documentElement.classList.contains('is-hinging')) buildFlushAtlas()
      for (let i = 0; i < rain.length; i++) {
        const d = rain[i]
        if (d.z !== z) continue
        if (d.free) {
          if (!drawFreeDrop(d, pl, dt, t, field)) rain[i] = newDrop(true)
          continue
        }
        d.y += d.v * dt
        // Near the open pit (its nearest glyph within reach), it's let go to fall into it.
        if (field && freed < PHYS.cap) {
          // Only rain on its way in, so a column is always drawn in head first.
          if (d.y < field.sy && Math.hypot(d.x - field.sx, d.y - field.sy) < field.Rf) {
            freeDrop(d, pl.step)
            freed++
            if (!drawFreeDrop(d, pl, dt, t, field)) rain[i] = newDrop(true)
            continue
          }
        }
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
        if (now >= d.gUntil && gRate && rand() < dt * gRate) {
          d.gUntil = now + span(RAIN_GLITCH.ms)
          d.gW = rand() < RAIN_GLITCH.wideP
        }
        const glitching = now < d.gUntil
        if (glitching && now >= d.gNext) {
          d.gNext = now + span(RAIN_GLITCH.step)
          const k = pl.size / 14
          d.gDx = splitPx(pl.size, d.gW)
          d.gA = Math.floor(rand() * d.len)
          d.gB = rand() < 0.75 ? d.gA + 1 + Math.floor(rand() * 4) : -1
          d.gT = span(RAIN_GLITCH.tear) * k * (rand() < 0.5 ? -1 : 1)
        }
        for (let k = 0; k < d.len; k++) {
          const y = d.y - k * pl.step
          if (y < -pl.step || y > H + pl.step) continue
          // Glyphs keep mutating as they fall: the head churns fastest, the bright glyphs just
          // behind it next, the rest of the trail still flickers a few times a second.
          // A glyph glitching on its own: started at random, its split re-rolled now and then.
          const kk = pl.size / 14
          if (now >= d.cU[k] && gRate && rand() < dt * gRate * (RAIN_GLITCH.char / RAIN_GLITCH.rate)) {
            d.cU[k] = now + span(RAIN_GLITCH.ms)
            d.cT[k] = rand() < 0.4 ? span(RAIN_GLITCH.tear) * kk * (rand() < 0.5 ? -1 : 1) : 0
            d.cW[k] = rand() < RAIN_GLITCH.wideP
            d.cDx[k] = 0
          }
          const own = now < d.cU[k]
          // Re-rolled almost every frame: a jittering flicker, not a copy sliding down with it.
          if (own && (d.cDx[k] === 0 || rand() < dt * 45)) d.cDx[k] = splitPx(pl.size, d.cW[k])
          const split = own ? d.cDx[k] : glitching ? d.gDx : 0
          // A glitching glyph holds its shape, so the split reads on a steady character.
          if (!split && rand() < dt * (k === 0 ? 18 : k < 3 ? 10 : 4.5)) d.chars[k] = GLYPHS[Math.floor(rand() * GLYPHS.length)]
          const a = Math.pow(1 - k / d.len, 1.4) * pl.alpha
          const x = own && d.cT[k] ? d.x + d.cT[k] : glitching && k >= d.gA && k <= d.gB ? d.x + d.gT : d.x
          const gx = x
          const gy = y
          // (Typeset, not stamped from the glyph sheet: measured, Chrome's cached text is faster.)
          ctx.fillStyle = k === 0 ? `rgba(235,255,240,${pl.alpha})` : k < 3 ? hot(0.9 * pl.alpha) : col(a)
          ctx.fillText(d.chars[k], gx, gy)
          if (split) {
            // The split: red and cyan copies either side, added light so they fringe the glyph.
            const ga = (k === 0 ? 1 : k < 3 ? 0.9 : a / pl.alpha) * 0.9 * pl.alpha * (z === 0 ? 0.75 : 1)
            ctx.globalCompositeOperation = 'lighter'
            ctx.fillStyle = `rgba(255,40,90,${ga.toFixed(3)})`
            ctx.fillText(d.chars[k], gx - split, gy)
            ctx.fillStyle = `rgba(40,220,255,${ga.toFixed(3)})`
            ctx.fillText(d.chars[k], gx + split, gy)
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
      // The pit's pull (always on, like the rain's): lights near it are drawn in and sink away.
      const box = reduced ? null : pullBox(now)
      const R0 = box ? 0.5 * Math.max(box[2], box[3]) * (1 - PIT_TUNNEL.margin) : 0
      const scx = box ? box[0] + box[2] / 2 : 0
      const scy = box ? box[1] + box[3] / 2 : 0
      for (const b of bokeh) {
        // Bigger (closer) lights move more.
        const kd = DEPTH.bokehMin + (DEPTH.bokehMax - DEPTH.bokehMin) * Math.min(1, b.r / 32)
        let w = 0
        if (box) {
          const rx = b.x - (scx + OVERSCAN + px * kd)
          const ry = b.y - (scy + OVERSCAN + py * kd)
          const r = Math.hypot(rx, ry) || 1
          w = Math.pow(Math.max(0, 1 - r / (PHYS.field * R0)), PHYS.falloff)
          if (w > 0.001 || b.z !== undefined) {
            b.vx ??= 0
            b.vy ??= -b.v
            b.z ??= 1
            const uin = PHYS.inFloor + PHYS.inSpeed * 0.6 * Math.pow(w, 0.7)
            const ut = PHYS.swirl * uin
            // In and round when it's caught; back to rising when it's not.
            const ux = w > 0.001 ? (-rx / r) * uin + (-ry / r) * ut : 0
            const uy = w > 0.001 ? (-ry / r) * uin + (rx / r) * ut : -b.v
            const k = 1 - Math.exp(-(w > 0.001 ? PHYS.grip * w : 1) * dt)
            b.vx += (ux - b.vx) * k
            b.vy += (uy - b.vy) * k
            b.z += b.z * PHYS.sinkRate * Math.pow(w, 1.3) * dt
          }
        }
        if (b.z !== undefined) {
          b.x += b.vx! * dt
          b.y += b.vy! * dt
        } else b.y -= b.v * dt
        const z = b.z ?? 1
        const fadeZ = Math.exp(-PHYS.fadeZ * (z - 1))
        if (b.y < -b.r * 2 || z > 8 || fadeZ < 0.03) {
          b.y = H + b.r * 2
          b.x = rand() * W
          b.vx = b.vy = b.z = undefined
          continue
        }
        // Once caught, drop the extra state when it's wandered back out and up to the plane.
        if (b.z !== undefined && w <= 0.001 && z < 1.02 && Math.abs(b.vx!) < 2) b.vx = b.vy = b.z = undefined
        ctx.globalAlpha = b.a * (0.6 + 0.4 * Math.sin(t * 0.9 + b.ph)) * fadeZ
        if (z === 1) {
          depth(kd)
          ctx.drawImage(bokehSprite, b.x - b.r, b.y - b.r, b.r * 2, b.r * 2)
        } else {
          // In perspective toward the pit's vanishing point.
          const qx = b.x - OVERSCAN - px * kd
          const qy = b.y - OVERSCAN - py * kd
          const fx = scx + (qx - scx) / z
          const fy = scy + (qy - scy) / z
          const rr = b.r / z
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
          ctx.drawImage(bokehSprite, fx - rr, fy - rr, rr * 2, rr * 2)
        }
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
    // Sorted by size (see build), so the font is only set when it changes (parsing it is slow).
    let size = 0
    for (const gl of glyphs) {
      if (rand() < scramble * dt * 3) gl.ch = GLYPHS[Math.floor(rand() * GLYPHS.length)]
      if (gl.size !== size) {
        size = gl.size
        ctx.font = `${size}px "JetBrains Mono", monospace`
      }
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
  /**
   * What shakes is everything except where you're typing: typing in the terminal, the chrome
   * around it (Quick replies and Queued included); typing in the Queued box, everything else, the
   * big terminal included. Everything that moves also tears (see the rip below), so the one still
   * thing is where you're looking.
   */
  const WAVE_TERMINAL = '.sidebar, .header, .bottom-bar'
  const WAVE_QUEUE = '.sidebar, .header, .bb-replies, .stage'
  let waveSel = WAVE_TERMINAL
  const clearWave = (el: HTMLElement) => {
    el.style.translate = ''
    el.style.rotate = ''
    el.style.filter = ''
  }
  let waveShown = false

  /**
   * Typing distortion: the board ripples sideways in smooth bands, and the chrome around the
   * terminal (stack, header, bottom bar) sways with a light purple colour fringe. The terminal
   * itself is never touched.
   */
  /** Torn bands for the typing distortion: uneven heights and offsets, reshuffled every few frames. */
  let tears: { y: number; h: number; dx: number }[] = []
  /** The rip's two copies (the big terminal's and the sidebar's, see FxLayer ripFilter). */
  let ripMaps: Element[] = []
  let ripNoises: Element[] = []
  /** The turbulent warp under the rip: scale px at full wave (pieces move up to half that); surgeP of reshuffles surge. */
  const WARP = { scale: 28, surgeP: 0.12, surge: 2.6 }
  let warpMaps: Element[] = []
  let warpNoises: Element[] = []
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
      // Fit it to the terminal frame each time it appears.
      const r = stageRect()
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
    const sel = document.activeElement?.closest('.bb-queue') ? WAVE_QUEUE : WAVE_TERMINAL
    if (sel !== waveSel) {
      // Focus moved mid-glitch: whatever leaves the set settles straight back.
      waveEls.forEach(clearWave)
      waveEls = []
      waveSel = sel
    }
    if (!waveEls.length) waveEls = [...document.querySelectorAll<HTMLElement>(waveSel)]
    const [r, g, b] = [ar, ag, ab]
    if (!ripMaps.length) {
      ripMaps = [...document.querySelectorAll('#fx-rip-map, #fx-rip-side-map')]
      ripNoises = [...document.querySelectorAll('#fx-rip-noise, #fx-rip-side-noise')]
      warpMaps = [...document.querySelectorAll('#fx-rip-warp, #fx-rip-side-warp')]
      warpNoises = [...document.querySelectorAll('#fx-rip-warp-noise, #fx-rip-side-warp-noise')]
    }
    // Filters (the rip and the colour fringe) re-render whole panels, so they change ~20x a
    // second; the shake below is a cheap transform and runs every frame.
    const refilter = !on || now >= ripAt
    if (on && refilter) {
      ripAt = now + 50
      // Each reshuffle throws a little harder or softer, so the bands never settle into one stride.
      for (const m of ripMaps) m.setAttribute('scale', String(Math.round(1200 * wave * (0.7 + rand() * 0.6))))
      for (const n of ripNoises) n.setAttribute('seed', String(Math.floor(rand() * 1000)))
      // The warp under the tear, by the same rules: follows the wave, re-rolled with the bands,
      // and now and then it surges (like the long tears).
      for (const m of warpMaps) m.setAttribute('scale', String(Math.round(WARP.scale * wave * (0.7 + rand() * 0.6) * (rand() < WARP.surgeP ? WARP.surge : 1))))
      for (const n of warpNoises) n.setAttribute('seed', String(Math.floor(rand() * 1000)))
    } else if (!on) for (const m of [...ripMaps, ...warpMaps]) m.setAttribute('scale', '0')
    const ab2 = (3.6 * wave).toFixed(1)
    // The fringe's strength follows the wave too, so it dims to nothing instead of lingering at
    // full colour behind the see-through panels and then switching off.
    const fade = Math.min(1, wave * 1.6)
    const al = (n: number) => (n * fade).toFixed(3)
    for (const el of waveEls) {
      if (!on) {
        clearWave(el)
        continue
      }
      // Violent: big random jumps both ways, a little vertical kick, a hint of twist.
      const big = rand() < 0.45
      const sx = (big ? (rand() - 0.5) * 30 : (rand() - 0.5) * 6) * wave
      const sy = (big ? (rand() - 0.5) * 8 : (rand() - 0.5) * 2) * wave
      el.style.translate = `${sx.toFixed(1)}px ${sy.toFixed(1)}px`
      el.style.rotate = `${((rand() - 0.5) * 0.6 * wave).toFixed(2)}deg`
      if (!refilter) continue
      // Rip the stack (and the big terminal, when you're typing in Queued) into sliding bands,
      // then fringe in the theme's greens with a faint purple ghost.
      el.style.filter =
        (el.classList.contains('sidebar') ? `url(#fx-rip-side) ` : el.matches('.stage, .bottom-bar, .bb-replies') ? `url(#fx-rip) ` : '') +
        `drop-shadow(-${ab2}px 0 0 rgba(${Math.min(255, r + 90)},255,${Math.min(255, b + 90)},${al(0.45)})) ` +
        `drop-shadow(${ab2}px 0 0 rgba(${r >> 2},${Math.round(g * 0.55)},${b >> 2},${al(0.7)})) ` +
        `drop-shadow(0 ${(Number(ab2) * 0.6).toFixed(1)}px 0 rgba(170,70,255,${al(0.22)}))`
    }
    waveShown = on
    if (!on) waveEls = []
  }


  /**
   * While you type, the pieces you aren't typing in (each sidebar tile on its own, Quick replies,
   * and Queued unless it has focus) break loose in depth: random kicks shove them back or forward
   * and tilt them, and a stiff, slightly bouncy spring hauls them home, so they strain against
   * their slots. Now and then one is thrown deep. Off the moment the keys stop kicking, they
   * settle in ~0.3s and the transform is cleared.
   */
  const SHATTER = {
    k: 420,
    damp: 0.45,
    /** Kicks per piece per second at full wave. */
    rate: 9,
    /** Kick velocity: depth px/s and tilt deg/s, at full wave. */
    vz: [400, 1300],
    vr: [40, 150],
    bigP: 0.08,
    big: 3,
    /** Depth jitter (px) at full wave. */
    tremble: 1.6,
    zRange: [-260, 90],
    perspective: 700
  }
  type Body = { z: number; vz: number; rx: number; vrx: number; ry: number; vry: number }
  const SHATTER_SEL = '.sidebar .slot-body, .bb-replies, .bb-queue'
  const bodies = new Map<HTMLElement, Body>()
  let shatterEls: HTMLElement[] = []
  let shatterAt = 0
  const clearShatter = (el: HTMLElement) => {
    el.style.transform = ''
    el.style.willChange = ''
  }
  function drawShatter(dt: number): void {
    const on = typingGlitch && wave > 0.015 && !reduced && !document.documentElement.classList.contains('is-hinging')
    if (!on && !bodies.size) return
    if (!on && document.documentElement.classList.contains('is-hinging')) {
      // A switch is starting: everything home now, so the lasso measures real positions.
      bodies.forEach((_, el) => clearShatter(el))
      bodies.clear()
      return
    }
    const now = performance.now()
    if (on && (now >= shatterAt || !shatterEls.length)) {
      // Re-found now and then (tiles come and go), and never the box you're typing in.
      shatterAt = now + 500
      const typingIn = document.activeElement?.closest('.bb-queue')
      shatterEls = [...document.querySelectorAll<HTMLElement>(SHATTER_SEL)].filter((el) => el !== typingIn)
    }
    const step = Math.min(dt, 0.033)
    const c = 2 * Math.sqrt(SHATTER.k) * SHATTER.damp
    const sign = () => (rand() < 0.5 ? -1 : 1)
    if (on) {
      for (const el of shatterEls) {
        if (!bodies.has(el)) bodies.set(el, { z: 0, vz: 0, rx: 0, vrx: 0, ry: 0, vry: 0 })
        if (rand() >= step * SHATTER.rate * wave) continue
        const b = bodies.get(el)!
        const big = rand() < SHATTER.bigP ? SHATTER.big : 1
        // Big ones mostly fly away from you, into the screen.
        b.vz += span(SHATTER.vz) * wave * big * (big > 1 ? (rand() < 0.8 ? -1 : 1) : sign())
        b.vrx += span(SHATTER.vr) * wave * Math.sqrt(big) * sign()
        b.vry += span(SHATTER.vr) * wave * Math.sqrt(big) * sign() * 0.7
      }
    }
    const typingIn = document.activeElement?.closest('.bb-queue')
    for (const [el, b] of bodies) {
      b.vz += (-SHATTER.k * b.z - c * b.vz) * step
      b.vrx += (-SHATTER.k * b.rx - c * b.vrx) * step
      b.vry += (-SHATTER.k * b.ry - c * b.vry) * step
      b.z = Math.max(SHATTER.zRange[0], Math.min(SHATTER.zRange[1], b.z + b.vz * step))
      b.rx = Math.max(-18, Math.min(18, b.rx + b.vrx * step))
      b.ry = Math.max(-18, Math.min(18, b.ry + b.vry * step))
      const settled = Math.abs(b.z) + Math.abs(b.vz) * 0.02 + Math.abs(b.rx) + Math.abs(b.ry) + (Math.abs(b.vrx) + Math.abs(b.vry)) * 0.02 < 0.25
      // Whatever you start typing in, or anything at rest once the keys stop, goes home for good.
      if (el === typingIn || !el.isConnected || (!on && settled)) {
        clearShatter(el)
        bodies.delete(el)
        continue
      }
      const z = b.z + (on ? (rand() - 0.5) * 2 * SHATTER.tremble * wave : 0)
      el.style.willChange = 'transform'
      el.style.transform = `perspective(${SHATTER.perspective}px) translateZ(${z.toFixed(1)}px) rotateX(${b.rx.toFixed(2)}deg) rotateY(${b.ry.toFixed(2)}deg)`
    }
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
  /** During a Hacker switch the backdrop draws every other frame: it costs most then (it's
      composited under the flying 3D layers), and at 30fps behind all that motion it doesn't show. */
  let skipFrame = false
  function loop(now: number): void {
    if (stopped) return
    raf = requestAnimationFrame(loop)
    if (document.documentElement.classList.contains('is-hinging') && (skipFrame = !skipFrame)) return
    // Not looking (another app has focus): half the frames.
    if (!document.hasFocus() && (skipFrame = !skipFrame)) return
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
  // The pit's boards, built in idle moments after boot so the first throw doesn't pay for them.
  setTimeout(buildPitSprites, 2500)

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
