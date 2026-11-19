import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { glitchPanel } from '../lib/thumbGlitch'
import type { TerminalTheme, SendOffReason } from '../../../shared/types'
import { TerminalLayer, type TerminalLayerHandle } from './TerminalLayer'
import { fxBurst, fxField, fxLasso, fxPit } from '../lib/fxField'

/** A switch the parent wants to show: animate `from` back into its slot, revealing `to`. */
export interface Preview {
  from: string
  to: string
  ms: number
  /** Why it's switching (labels the pill): a send-off, or a step of an approval run. */
  reason?: SendOffReason
  /** Approvals still waiting after this one. */
  left?: number
}

/** What the sidebar should look like right now (drives slot collapse/open and landing fade). */
export interface StageVisual {
  /** Session shown in the big terminal (its slot is collapsed to a marker). */
  bigId: string | null
  /** Session flying back into its slot (its mini stays hidden until it lands). */
  landingId: string | null
  /** Duration the sidebar should use for its slot transitions. */
  ms: number
}

interface Props {
  activeId: string | null
  /** Send-off in progress: the switch Space can still cancel. */
  preview: Preview | null
  colorOf: (id: string) => string
  theme: TerminalTheme
  fontFamily: string
  scrollback: number
  inputBlockedUntil: number
  onFocusTerminal: () => void
  onVisual: (v: StageVisual) => void
}

const CLICK_MS = 700
/** A full reversal; a cancel partway through takes its share of this. */
const CANCEL_MS = 520
/**
 * Each window's slice of the switch. They overlap: the next window launches while the current
 * one is on its last stretch home (small, near its own slot, and drawn above it), so the motion
 * hands over without a dead stop in the middle.
 */
const OUT_END = 0.7
const IN_START = 0.3

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** Corner radius of the tether's bends. */
const TETHER_RADIUS = 8
/** How far outside a window the tether's vertical run sits. */
const TETHER_ELBOW_GAP = 9

/** A window's left edge and vertical extent: what a tether attaches to. */
interface Edge {
  left: number
  top: number
  bottom: number
  /** A slanted edge (tilted hinge): its x at a given height. */
  xAt?: (y: number) => number
}
/** If a previewed switch isn't confirmed by the server by then, undo it. */
const COMMIT_GRACE_MS = 1500

// A CSS cubic-bezier timing function, solved for y given x.
function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const bez = (t: number, a: number, b: number) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t
  return (x: number) => {
    let lo = 0
    let hi = 1
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2
      if (bez(mid, x1, x2) < x) lo = mid
      else hi = mid
    }
    return bez((lo + hi) / 2, y1, y2)
  }
}

/** Leaving: accelerates away, lands softly in its slot. */
const easeOut = cubicBezier(0.5, 0, 0.3, 1)
/** Arriving: launches promptly, then a long smooth settle into the stage. */
const easeIn = cubicBezier(0.3, 0, 0.2, 1)

const lerp = (a: number, b: number, p: number) => a + (b - a) * p

/** After the stack changes, keep re-placing the tether this long (covers the slots' glide). */
const FOLLOW_MS = 450

/**
 * The part of the stack's scroll area where `el` can actually be seen: the scroll list, minus
 * the "Parked" heading pinned over its bottom (which covers stack slots, never parked ones).
 */
function visibleBand(el: Element): { el: HTMLElement; top: number; bottom: number } | null {
  const list = el.closest<HTMLElement>('.stack-list')
  if (!list) return null
  const r = list.getBoundingClientRect()
  let bottom = r.bottom
  const head = list.querySelector<HTMLElement>('.park-head')
  if (head && !el.closest('.park-items')) bottom = Math.min(bottom, head.getBoundingClientRect().top)
  return { el: list, top: r.top, bottom }
}

/** Keep the slot a window is flying home to inside the stack's scroll area. */
function keepInView(slot: HTMLElement): void {
  const band = visibleBand(slot)
  if (!band) return
  const list = band.el
  const l = { top: band.top, bottom: band.bottom }
  const r = slot.getBoundingClientRect()
  if (r.bottom > l.bottom) list.scrollTop += Math.min(r.bottom - l.bottom, r.top - l.top)
  else if (r.top < l.top) list.scrollTop -= l.top - r.top
}

const slotEl = (id: string) => document.querySelector<HTMLElement>(`[data-slot="${CSS.escape(id)}"]`)

/** Reach of the drawn dot (its halo) from its centre. */
const DOT_REACH = 11
/** Radius of the dot's solid core. */
const DOT_CORE = 7

/**
 * Centre of a session's marker dot plus the visible band of the list it scrolls in. Null only
 * once the dot (halo included) has scrolled fully out of that band; until then it's clipped.
 */
function markerCenter(id: string): { x: number; y: number; clipTop: number; clipBottom: number; lifted?: boolean } | null {
  const slot = slotEl(id)
  // Being dragged: the session is the lifted card under the pointer now, so the tether follows
  // that (unclipped, since the card floats over everything) rather than the empty placeholder.
  if (slot?.classList.contains('is-dragging')) {
    const card = document.querySelector<HTMLElement>('.drag-card')?.getBoundingClientRect()
    if (!card || card.width === 0) return null
    return { x: card.left + card.width / 2, y: card.top + card.height * 0.36, clipTop: 0, clipBottom: window.innerHeight, lifted: true }
  }
  const dot = slot?.querySelector<HTMLElement>('.slot-marker-dot')
  const list = dot ? visibleBand(dot) : null
  const d = dot?.getBoundingClientRect()
  if (!d || !list || d.width === 0) return null
  const y = d.top + d.height / 2
  if (y + DOT_REACH < list.top || y - DOT_REACH > list.bottom) return null
  return { x: d.left + d.width / 2, y, clipTop: list.top, clipBottom: list.bottom }
}

/** Where a session's thumbnail is (below its title), if it's on screen enough to fly to/from. */
function slotTarget(id: string): DOMRect | null {
  const slot = slotEl(id)
  if (!slot || slot.classList.contains('is-dragging')) return null
  const r = (slot.querySelector<HTMLElement>('.slot-body') ?? slot).getBoundingClientRect()
  const list = visibleBand(slot)
  if (r.width === 0 || !list) return null
  if (r.top < list.top - r.height / 2 || r.bottom > list.bottom + r.height / 2) return null
  return r
}

/**
 * Hacker: the switch is a catch and a throw. The next window comes flying past from far out
 * (somewhere off to the right, random each time); the dot's line lashes out like a lasso, catches
 * it and reels it into the stage with a springy overshoot. The current one is swung on its line
 * like a sling around its dot, let go, and flung off tumbling into the background.
 * ms: how long a switch takes, clicked or sent off (the same either way). outEnd/inStart: where in
 * it the thrown window's part ends and the incoming one's starts: the incoming waits until the
 * throw has been watched well down the shaft (and blown up). perspective: viewer distance (× stage width).
 * catchAt/releaseAt: when in each window's part of the switch the catch / the release happens;
 * lasso: how long (of the incoming part) the line takes to reach it; snap: how long the let-go
 * line takes to whip back. slabs/echo: thickness, smear.
 */
const HINGE = {
  ms: 2000,
  outEnd: 0.6,
  inStart: 0.5,
  perspective: 2.2,
  slabs: [16],
  echo: [1.6, 3.6],
  catchAt: [0.26, 0.34],
  lasso: 0.16,
  releaseAt: [0.26, 0.32],
  snap: 0.1,
  /** How deep a thrown window falls (× stage width): down the shaft until it's a speck. */
  sinkDepth: 110,
  /** How far round (rad) the whirlpool winds a thrown window on its way down. */
  swirl: 2.4
}
/**
 * The swing's look (Hacker). echoA: opacity of each frame echo; trail/trailA: lags and
 * opacity of the filled body afterimages (motion blur); split: red/cyan frame offset range (px),
 * re-rolled every splitStep ms; tear: chance a split copy shows only a torn band; beam/wire:
 * strength of the projection rig from the dot; flicker: chance per frame a wire drops out.
 */
const HINGE_FX = {
  /** How far through its fall (flungK) the thrown window blows up (fx/matrix.ts drawBurst). */
  burstAt: 0.7,
  echoA: [0.4, 0.18],
  trail: [2.5],
  trailA: [0.16],
  split: [2, 9],
  splitStep: [40, 70],
  tear: 0.3,
  beam: 0.16,
  wire: 0.75,
  flicker: 0.12,
  /** Heat distortion: peak displacement (px) mid-swing, and how often it re-shimmers (ms). */
  heat: 34,
  heatStep: 50,
  /** Window tears: chance a step tears at all, and its strength (px) mid-swing. */
  tearChance: 0.5,
  tearPx: [18, 48],
  /** Chromatic aberration on the window's content: channel offset range (px) mid-swing. */
  chroma: [4, 14]
}
const rnd = (a: number, b: number) => a + Math.random() * (b - a)
const sgn = () => (Math.random() < 0.5 ? -1 : 1)

// ---- 3D poses for the catch and the throw. A pose turns a window about its own rest centre by
// Euler angles e (degrees) and moves it by t (px; z toward you). Same conventions as CSS.
type V3 = [number, number, number]
type M3 = number[]
interface Pose {
  e: V3
  t: V3
}
const REST: Pose = { e: [0, 0, 0], t: [0, 0, 0] }
const mul3 = (a: M3, b: M3): M3 => {
  const o: M3 = []
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o.push(a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c])
  return o
}
/** rotateZ · rotateY · rotateX, as CSS would apply rotateZ() rotateY() rotateX(). */
function euler([rx, ry, rz]: V3): M3 {
  const [a, b, c] = [rx, ry, rz].map((d) => (d * Math.PI) / 180)
  const X = [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)]
  const Y = [Math.cos(b), 0, Math.sin(b), 0, 1, 0, -Math.sin(b), 0, Math.cos(b)]
  const Z = [Math.cos(c), -Math.sin(c), 0, Math.sin(c), Math.cos(c), 0, 0, 0, 1]
  return mul3(Z, mul3(Y, X))
}
const apply3 = (m: M3, v: V3): V3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]
const mixPose = (a: Pose, b: Pose, k: number): Pose => ({
  e: a.e.map((v, i) => v + (b.e[i] - v) * k) as V3,
  t: a.t.map((v, i) => v + (b.t[i] - v) * k) as V3
})
/** CSS matrix3d (column-major) for rotation m then translation t. */
const css3d = (m: M3, t: V3) =>
  `matrix3d(${[m[0], m[3], m[6], 0, m[1], m[4], m[7], 0, m[2], m[5], m[8], 0, t[0], t[1], t[2], 1].map((v) => +v.toFixed(5)).join(',')})`

/** Each switch's dice (kept small): how the next window's swing in falls short, when it's
    caught; how the current one is swung and thrown. */
interface Flight {
  /** The in-swing: vertical offset (× W), roll (deg), and how far ajar it stops (× 200°, ~22-28°). */
  dy: number
  roll: number
  short: number
  uc: number
  /** The throw: swing direction, release moment, tumble. */
  swing: number
  ur: number
  tumble: V3
}
const rollFlight = (): Flight => ({
  dy: rnd(-0.05, 0.05),
  roll: rnd(-3, 3),
  short: rnd(0.11, 0.14),
  uc: rnd(HINGE.catchAt[0], HINGE.catchAt[1]),
  swing: sgn(),
  ur: rnd(HINGE.releaseAt[0], HINGE.releaseAt[1]),
  tumble: [rnd(-40, 40), rnd(-70, 70), rnd(-60, 60)]
})

const hingedFlights = () =>
  document.documentElement.dataset.fx === 'matrix' && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** Opacity of a flying copy at slot-progress q (0 = big, 1 = in its slot): it hands over to the mini near the slot. */
const HANDOFF = 0.85
const copyOpacity = (q: number) => (q < HANDOFF ? 1 : Math.max(0, 1 - (q - HANDOFF) / (1 - HANDOFF)))

interface Anim {
  from: string
  to: string
  start: number
  ms: number
  /** Progress at start (reversals begin mid-flight). */
  p0: number
  /** 1 = flying out, 0 = returning. */
  target: 0 | 1
  /** Server confirmed the switch (activeId === to). */
  committed: boolean
  p: number
  /** Hacker: this switch's catch-and-throw dice. */
  fl: Flight
}

/**
 * The big terminal. Two layers take turns: on a switch the back layer attaches the next
 * session, then the front layer shrinks and flies back into its mini slot in the sidebar,
 * revealing the next one already running behind it.
 */
export function Stage(props: Props) {
  const { activeId, preview, colorOf, onVisual } = props
  const [layers, setLayers] = useState<[string | null, string | null]>([activeId, null])
  const [front, setFront] = useState<0 | 1>(0)
  const [animating, setAnimating] = useState(false)
  const refs = [useRef<TerminalLayerHandle>(null), useRef<TerminalLayerHandle>(null)]
  const ghostRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const anim = useRef<Anim | null>(null)
  const raf = useRef(0)
  const graceTimer = useRef(0)
  const displayed = layers[front]
  const state = useRef({ layers, front, displayed, activeId })
  state.current = { layers, front, displayed, activeId }

  const back = (front === 0 ? 1 : 0) as 0 | 1

  const ghostInRef = useRef<HTMLDivElement>(null)
  const plateRef = useRef<HTMLDivElement>(null)
  const plateInRef = useRef<HTMLDivElement>(null)
  /** Hinged flights (Hacker): per window [incoming, outgoing], two backing slabs and two echoes. */
  const slabEls = useRef<(HTMLDivElement | null)[]>([])
  const echoEls = useRef<(HTMLDivElement | null)[]>([])
  /** Each window's pose and corners last frame (for the smear and its speed), and the throw's
      release state (its pose and velocity, and where the line let go). */
  const lastPose = useRef<[Pose | null, Pose | null]>([null, null])
  const lastCorners = useRef<[[number, number][] | null, [number, number][] | null]>([null, null])
  const release = useRef<{ pose: Pose; vel: Pose; at: [number, number] | null } | null>(null)
  /** Whether this throw's burst has gone off. */
  const burst = useRef(false)
  /** The swing's dressing (HINGE_FX), per window [in, out]: filled afterimages, red/cyan frame copies, the rig. */
  const trailEls = useRef<(HTMLDivElement | null)[]>([])
  const splitEls = useRef<(HTMLDivElement | null)[]>([])
  const rigEls = useRef<(SVGSVGElement | null)[]>([])
  /** The content's red/cyan split (px), re-rolled with the heat shimmer. */
  const chroma = useRef({ dx: 0, dy: 0 })
  /** When the heat shimmer next re-rolls, and the strongest swing this frame. */
  const heatAt = useRef(0)
  const heatPeak = useRef(0)
  /** Current red/cyan offsets and when to re-roll them, per window. */
  const splitState = useRef([
    { at: 0, d: 0, band: '' },
    { at: 0, d: 0, band: '' }
  ])
  /** Tether of the big (or incoming) session, and of the one flying home. */
  const connectorRef = useRef<SVGSVGElement>(null)
  const connectorOutRef = useRef<SVGSVGElement>(null)
  /** The session the lock-on animation last played for (see lockOn). */
  const lockedFor = useRef<string | null>(null)
  /**
   * "Target locked": each time a session takes the big terminal, its tether zaps on: the dot
   * ignites with a shockwave, the line strikes out to the window, the reticle spins in and locks.
   * CSS does the animating (.is-locking); this restarts it.
   */
  const lockOn = useCallback((id: string | null, delayMs = 0) => {
    const svg = connectorRef.current
    if (!svg || !id || id === lockedFor.current) return
    lockedFor.current = id
    // Mid-flight, wait until the incoming window has cleared the slot, or it plays unseen.
    svg.style.setProperty('--lock-delay', `${Math.round(delayMs)}ms`)
    svg.classList.remove('is-locking')
    // With the catch (Hacker), the lasso draws the line itself; the lock-on keeps the rest.
    svg.classList.toggle('is-lasso-lock', hingedFlights())
    void svg.getBoundingClientRect()
    svg.classList.add('is-locking')
  }, [])
  /** Bumped when a flight ends; the layout effect below then clears inline flight styles. */
  const [settled, setSettled] = useState(0)

  /**
   * A tether from a session's slot to its window: the dot sits in the slot the window belongs
   * to, the line runs into the window's left border (a fixed full-window SVG, so the stack
   * list's clipping can't cut it). When the dot is level with the window it's a straight line;
   * when the stack is scrolled so it isn't, the line turns down (or up) just outside the
   * window and meets its border at the nearest point, so it never points at nothing.
   */
  const placeTether = useCallback(
    (svg: SVGSVGElement | null, id: string | null, win: Edge | null, dotOpacity: number): [number, number][] | null => {
      if (!svg) return null
      const d = id ? markerCenter(id) : null
      const path = svg.querySelector(':scope > path')
      if (!id || !d || !win || !path || dotOpacity <= 0) {
        svg.style.opacity = '0'
        return null
      }
      const inset = Math.min(TETHER_RADIUS + 6, (win.bottom - win.top) / 2)
      const ty = Math.min(Math.max(d.y, win.top + inset), win.bottom - inset)
      const edgeX = win.xAt ? win.xAt(ty) : win.left
      // +1 so it runs into the window's 2px border rather than stopping short of it.
      const endX = edgeX + 1
      const dy = ty - d.y
      const ex = edgeX - TETHER_ELBOW_GAP
      const r = Math.min(TETHER_RADIUS, Math.abs(dy) / 2, (ex - d.x) / 2, TETHER_ELBOW_GAP)
      let dAttr: string
      if (Math.abs(dy) < 0.5 || r <= 0) {
        dAttr = `M${d.x} ${d.y}H${Math.max(d.x, endX)}`
      } else {
        const s = Math.sign(dy)
        dAttr =
          `M${d.x} ${d.y}H${ex - r}` +
          `Q${ex} ${d.y} ${ex} ${d.y + s * r}` +
          `V${ty - s * r}` +
          `Q${ex} ${ty} ${ex + r} ${ty}` +
          `H${Math.max(ex + r, endX)}`
      }
      for (const p of svg.querySelectorAll(':scope > path')) p.setAttribute('d', dAttr)
      for (const c of svg.querySelectorAll(':scope > circle')) {
        c.setAttribute('cx', String(d.x))
        c.setAttribute('cy', String(d.y))
      }
      // The reticle lives in the same SVG and moves in the same write, so it can't drift off the dot.
      svg.querySelector('.tether-reticle')?.setAttribute('transform', `translate(${d.x} ${d.y})`)
      // Clip to the band the stack scrolls in: the dot and line slide under the header (or the
      // parked drawer) instead of drawing over it.
      svg.style.clipPath = `inset(${d.clipTop}px 0 ${Math.max(0, window.innerHeight - d.clipBottom)}px 0)`
      svg.classList.toggle('is-lifted', !!d.lifted)
      // As the dot slides out of view the whole tether fades with it, so the bend into the
      // window never lingers on its own looking attached to something off screen.
      const shown = clamp01(Math.min(d.y - d.clipTop, d.clipBottom - d.y) / (2 * DOT_CORE) + 0.5)
      svg.style.opacity = String(dotOpacity * shown)
      svg.style.setProperty('--c', colorOf(id))
      // The line's path, dot to window (the elbow's corners, not its rounding), for the lasso's energy.
      return [[d.x, d.y], [ex, d.y], [ex, ty], [Math.max(ex, endX), ty]]
    },
    [colorOf]
  )

  const finish = useCallback(() => {
    const a = anim.current
    if (!a) return
    cancelAnimationFrame(raf.current)
    window.clearTimeout(graceTimer.current)
    anim.current = null
    const { front: f } = state.current
    const b = (f === 0 ? 1 : 0) as 0 | 1
    // Leave the flight styles in place until React has swapped the layers' classes; clearing
    // them now would show the old terminal full-size for a frame (the end-of-switch blink).
    if (a.target === 1) {
      setFront(b)
      setLayers((l) => {
        const next: [string | null, string | null] = [...l]
        next[f] = null
        return next
      })
      onVisual({ bigId: a.to, landingId: null, ms: CLICK_MS })
    } else {
      setLayers((l) => {
        const next: [string | null, string | null] = [...l]
        next[b] = null
        return next
      })
      onVisual({ bigId: a.from, landingId: null, ms: CANCEL_MS })
    }
    setAnimating(false)
    setSettled((n) => n + 1)
  }, [onVisual])

  // Runs after the commit that hid the finished layer, before paint.
  useLayoutEffect(() => {
    if (!settled || anim.current) return
    for (const i of [0, 1] as const) {
      const el = refs[i].current?.el
      if (el) {
        el.style.transform = ''
        el.style.clipPath = ''
        el.style.opacity = ''
        el.style.zIndex = ''
        el.style.filter = ''
      }
    }
    for (const g of [ghostRef.current, ghostInRef.current, plateRef.current, plateInRef.current]) {
      if (!g) continue
      g.style.opacity = '0'
      g.style.transform = ''
      g.style.zIndex = ''
      g.style.filter = ''
    }
    document.documentElement.classList.remove('is-hinging')
    document.getElementById('fx-heat-map')?.setAttribute('scale', '0')
    document.getElementById('fx-wtear-map')?.setAttribute('scale', '0')
    fxField[0].s = 0
    fxField[1].s = 0
    fxPit.s = 0
    fxLasso.s = 0
    for (const g of [...slabEls.current, ...echoEls.current, ...trailEls.current, ...splitEls.current]) {
      if (!g) continue
      g.style.opacity = '0'
      g.style.transform = ''
    }
    for (const r of rigEls.current) if (r) r.style.opacity = '0'
    for (const g of [ghostRef.current, ghostInRef.current]) {
      g?.style.setProperty('--turn', '0')
      g?.style.setProperty('--mist', '0')
    }
    lastPose.current = [null, null]
    lastCorners.current = [null, null]
    release.current = null
    burst.current = false
    for (const svg of [connectorRef.current, connectorOutRef.current]) svg?.classList.remove('is-lassoing', 'is-caught', 'is-snapped')
    // The incoming frame has landed exactly on the stage's border: take over without a colour fade.
    const stage = frameRef.current
    if (stage?.classList.contains('is-switching')) {
      stage.style.transition = 'none'
      stage.classList.remove('is-switching')
      stage.style.removeProperty('--bay-solid')
      void stage.offsetWidth
      requestAnimationFrame(() => (stage.style.transition = ''))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled])


  /**
   * Put one layer on its way between the big terminal and a slot.
   * q is slot-progress: 0 = full size in the stage, 1 = exactly over the slot.
   */
  const place = (i: 0 | 1, ghost: HTMLDivElement | null, plate: HTMLDivElement | null, id: string, q: number): Edge | null => {
    const el = refs[i].current?.el
    const stage = frameRef.current
    if (!el || !stage) return null
    const mw = el.offsetWidth
    const mh = el.offsetHeight
    const host = (el.offsetParent ?? document.body).getBoundingClientRect()
    const mLeft = host.left + el.offsetLeft
    const mTop = host.top + el.offsetTop
    const r = slotTarget(id)
    if (!r) {
      // Nowhere on screen to fly to: just fade.
      el.style.transform = ''
      el.style.clipPath = ''
      el.style.opacity = String(1 - q)
      if (ghost) ghost.style.opacity = '0'
      if (plate) plate.style.opacity = '0'
      return null
    }
    const s = lerp(1, r.width / mw, q)
    const hs = lerp(mh, r.height, q)
    const inset = Math.max(0, mh - hs / s)
    const top = lerp(mTop, r.top, q)
    const left = lerp(mLeft, r.left, q)
    // Keep the top rows (where a shell's output starts) and trim the bottom to the slot's shape.
    el.style.transform = `translate(${left - mLeft}px, ${top - mTop}px) scale(${s})`
    el.style.clipPath = `inset(0 0 ${inset}px 0 round ${lerp(8, 6, q) / s}px)`
    const o = copyOpacity(q)
    el.style.opacity = String(o)
    // The window's frame: the stage's own border at q=0, the slot's at q=1.
    const st = stage.getBoundingClientRect()
    const gLeft = lerp(st.left, r.left, q)
    const gTop = lerp(st.top, r.top, q)
    const gHeight = lerp(st.height, r.height, q)
    const frameBox = {
      opacity: String(o),
      left: `${gLeft}px`,
      top: `${gTop}px`,
      width: `${lerp(st.width, r.width, q)}px`,
      height: `${gHeight}px`,
      borderRadius: `${lerp(10, 6, q)}px`
    }
    // The plate fills the window behind its content (the content is inset from the frame), so
    // nothing underneath shows through the gap.
    if (plate) Object.assign(plate.style, frameBox)
    if (ghost) Object.assign(ghost.style, frameBox)
    ghost?.style.setProperty('--gc', colorOf(id))
    return { left: gLeft, top: gTop, bottom: gTop + gHeight }
  }

  /**
   * Lay one window (all its pieces) out at a 3D pose, with the swing's dressing. look.fade is its
   * visibility, look.rig the projection rig's strength, look.sweep the hologram sheen's position,
   * look.kick a burst of glitch (the catch, the release). slot 0 = incoming, 1 = outgoing.
   * Returns the window's projected left edge (for the tether), corners and edge midpoint.
   */
  const placeFlight = (
    i: 0 | 1,
    ghost: HTMLDivElement | null,
    plate: HTMLDivElement | null,
    id: string,
    pose: Pose,
    slot: 0 | 1,
    /** field: scales the backdrop's force field around it (off for a window falling away). */
    look: { fade: number; rig: number; sweep: number; kick: number; field?: number }
  ): { edge: Edge; corners: [number, number][]; mid: [number, number] } | null => {
    const el = refs[i].current?.el
    const stage = frameRef.current
    if (!el || !stage) return null
    const st = stage.getBoundingClientRect()
    const ex = st.left + st.width / 2
    const ey = st.top + st.height / 2
    const P = HINGE.perspective * st.width
    const R = euler(pose.e)
    // Facing you (1) to edge-on (0); never shown from behind (it would read mirrored).
    const facing = R[8]
    const fade = look.fade * clamp01((facing - 0.06) / 0.2)
    const turn = clamp01(1 - facing)
    // Incoming above the stack (z 15 while hinging), outgoing behind it.
    const z = slot === 0 ? 20 : 4
    const tf = (L: number, T: number, q: Pose, depth = 0) =>
      `translate(${ex - L}px, ${ey - T}px) perspective(${P}px) ${css3d(euler(q.e), q.t)}${depth ? ` translateZ(${-depth}px)` : ''} translate(${L - ex}px, ${T - ey}px)`
    // Any point of the window at rest, posed and projected to the screen (tf's steps).
    const project = (x: number, y: number): [number, number] => {
      const [X, Y, Z] = apply3(R, [x - ex, y - ey, 0])
      const sc = P / Math.max(1, P - (Z + pose.t[2]))
      return [ex + (X + pose.t[0]) * sc, ey + (Y + pose.t[1]) * sc]
    }
    const corners = [project(st.left, st.top), project(st.right, st.top), project(st.right, st.bottom), project(st.left, st.bottom)]
    // How fast it's moving on screen: drives the smear, the field and the heat.
    const prevC = lastCorners.current[slot]
    lastCorners.current[slot] = corners
    const moved = prevC ? Math.max(...corners.map((c, k) => Math.hypot(c[0] - prevC[k][0], c[1] - prevC[k][1]))) : 0
    const speed = clamp01(moved / 45)
    const prev = lastPose.current[slot] ?? pose
    lastPose.current[slot] = pose
    const hot = fade * Math.max(turn, speed, look.kick)
    // On screen enough to be worth filtering?
    const xs = corners.map((c) => c[0])
    const ys = corners.map((c) => c[1])
    const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
    const vis = Math.max(0, Math.min(box.x1, innerWidth) - Math.max(box.x0, 0)) * Math.max(0, Math.min(box.y1, innerHeight) - Math.max(box.y0, 0))
    // Even mostly off screen (a door swinging in big, close to you) counts: that's when the heat shows most.
    const onScreen = vis / Math.max(1, (box.x1 - box.x0) * (box.y1 - box.y0)) > 0.04

    const host = (el.offsetParent ?? document.body).getBoundingClientRect()
    el.style.transform = tf(host.left + el.offsetLeft, host.top + el.offsetTop, pose)
    el.style.clipPath = ''
    el.style.opacity = String(fade)
    el.style.zIndex = String(z + 4)
    const frameBox = { left: `${st.left}px`, top: `${st.top}px`, width: `${st.width}px`, height: `${st.height}px`, borderRadius: '10px' }
    const color = colorOf(id)
    for (const [g, k] of [[plate, 2], [ghost, 6]] as const) {
      if (!g) continue
      Object.assign(g.style, frameBox, { transform: tf(st.left, st.top, pose), opacity: String(fade), zIndex: String(z + k) })
    }
    ghost?.style.setProperty('--gc', color)
    // The tile's thickness: slabs behind the plate, only seen side-on.
    HINGE.slabs.forEach((d, k) => {
      const g = slabEls.current[slot * HINGE.slabs.length + k]
      if (!g) return
      Object.assign(g.style, frameBox, { transform: tf(st.left, st.top, pose, d), opacity: String(turn > 0.01 ? fade : 0), zIndex: String(z - k) })
      g.style.setProperty('--gc', color)
    })
    // Motion blur, cheaply: the frame (and, fainter, the whole body) smeared back along its path.
    const back = (lag: number) => mixPose(pose, prev, lag)
    HINGE.echo.forEach((lag, k) => {
      const g = echoEls.current[slot * HINGE.echo.length + k]
      if (!g) return
      Object.assign(g.style, frameBox, { transform: tf(st.left, st.top, back(lag)), opacity: String(fade * speed * HINGE_FX.echoA[k]), zIndex: String(z + 5) })
      g.style.setProperty('--gc', color)
    })
    HINGE_FX.trail.forEach((lag, k) => {
      const g = trailEls.current[slot * HINGE_FX.trail.length + k]
      if (!g) return
      Object.assign(g.style, frameBox, { transform: tf(st.left, st.top, back(lag)), opacity: String(fade * speed * HINGE_FX.trailA[k]), zIndex: String(z + 5) })
      g.style.setProperty('--gc', color)
    })
    // Heat, tears and the content's red/cyan split while it's thrown about (shared filters,
    // strength set once per frame in frame()); only while it's really on screen.
    const filtered = hot > 0.04 && onScreen
    const c = chroma.current
    const split =
      Math.abs(c.dx) > 0.3
        ? ` drop-shadow(${c.dx.toFixed(1)}px ${c.dy.toFixed(1)}px 0 rgba(255, 40, 90, 0.75)) drop-shadow(${(-c.dx).toFixed(1)}px ${(-c.dy).toFixed(1)}px 0 rgba(40, 220, 255, 0.75))`
        : ''
    el.style.filter = filtered ? `url(#fx-heat) url(#fx-wtear)${split}` : ''
    // The frame shimmers with it (heat only; its red/cyan copies already split it).
    if (ghost) ghost.style.filter = filtered ? 'url(#fx-heat)' : ''
    if (onScreen) heatPeak.current = Math.max(heatPeak.current, hot)
    // The hologram face repaints a full-window gradient, so it only updates with the heat step.
    if (ghost && performance.now() >= heatAt.current - 1) {
      ghost.style.setProperty('--turn', Math.max(turn, speed * 0.6).toFixed(2))
      ghost.style.setProperty('--sweep', (look.sweep * 100).toFixed(0) + '%')
    }
    // Edge glitch: red and cyan copies of the frame, thrown sideways in steps, sometimes torn.
    const sp = splitState.current[slot]
    const now = performance.now()
    if (now >= sp.at) {
      sp.at = now + rnd(HINGE_FX.splitStep[0], HINGE_FX.splitStep[1])
      sp.d = rnd(HINGE_FX.split[0], HINGE_FX.split[1]) * sgn()
      const h = rnd(6, 26)
      const top = rnd(0, 100 - h)
      sp.band = Math.random() < HINGE_FX.tear ? `inset(${top.toFixed(1)}% 0 ${(100 - top - h).toFixed(1)}% 0)` : ''
    }
    const glitch = Math.min(1, Math.max(turn, speed, look.kick) * 1.6)
    ;[1, -1].forEach((sg, k) => {
      const g = splitEls.current[slot * 2 + k]
      if (!g) return
      const torn = k === 0 && sp.band
      Object.assign(g.style, frameBox, {
        transform: `translateX(${(sg * sp.d * (torn ? 2.2 : 1) * glitch).toFixed(1)}px) ${tf(st.left, st.top, pose)}`,
        clipPath: torn ? sp.band : '',
        opacity: String(fade * glitch * 0.8),
        zIndex: String(z + 7)
      })
    })
    // The force field: the backdrop ripples around where the window is (fx/matrix.ts).
    Object.assign(fxField[slot], { ...box, s: onScreen ? (look.field ?? 1) * fade * Math.max(turn, speed * 0.8, look.kick) : 0 })
    placeRig(rigEls.current[slot], id, corners, fade * look.rig, color)
    const rig = rigEls.current[slot]
    if (rig) rig.style.zIndex = slot === 0 ? '29' : '12'
    // The window's left edge, for the tether (slanted when the window is turned).
    const [[ax, ay], [bx, by]] = [corners[0], corners[3]]
    const xAt = (y: number) => (Math.abs(by - ay) < 0.5 ? ax : ax + ((bx - ax) * (y - ay)) / (by - ay))
    return { edge: { left: Math.min(ax, bx), top: Math.min(ay, by), bottom: Math.max(ay, by), xAt }, corners, mid: [(ax + bx) / 2, (ay + by) / 2] }
  }

  /**
   * The next window swings in like a door on a vertical hinge through its dot: from edge-on (its
   * right side out toward you) to flat in the stage, easing in. The dot's line catches it on the
   * way (fl.uc); s is how far past the catch it is (-1 before). u: 0..1.
   */
  const catchPose = (fl: Flight, u: number, st: DOMRect, hingeX: number): { pose: Pose; s: number } => {
    const yaw = -90 * (1 - easeIn(u))
    const e: V3 = [0, yaw, 0]
    // Turned about the hinge line, not the window's centre.
    const c0q: V3 = [st.left + st.width / 2 - hingeX, 0, 0]
    const r = apply3(euler(e), c0q)
    const pose: Pose = { e, t: [r[0] - c0q[0], r[1] - c0q[1], r[2]] }
    return { pose, s: u <= fl.uc ? -1 : (u - fl.uc) / (1 - fl.uc) }
  }

  /** The current window: swung on its line around its dot, let go at fl.ur, then flung. v: 0..1. */
  const throwPose = (fl: Flight, v: number, W: number, st: DOMRect, dot: [number, number]): Pose => {
    const ex = st.left + st.width / 2
    const ey = st.top + st.height / 2
    const sling = (vv: number): Pose => {
      const w = Math.pow(clamp01(vv / fl.ur), 2)
      const e: V3 = [fl.swing * 8 * w, 30 * w, fl.swing * 30 * w]
      // Swung about the dot (the pivot), pulled a little outward as the line goes taut.
      const c0q: V3 = [ex - dot[0], ey - dot[1], 0]
      const r = apply3(euler(e), c0q)
      const len = Math.hypot(c0q[0], c0q[1]) || 1
      const pull = 0.1 * W * w
      return { e, t: [r[0] - c0q[0] + (c0q[0] / len) * pull, r[1] - c0q[1] + (c0q[1] / len) * pull, r[2] - 0.15 * W * w] }
    }
    if (v <= fl.ur) return sling(v)
    // Let go: carry on with the velocity and spin it had, tumbling, into the deep background.
    if (!release.current) {
      const a = sling(fl.ur)
      const b = sling(fl.ur - 0.02)
      release.current = {
        pose: a,
        vel: { e: a.e.map((x, n) => (x - b.e[n]) / 0.02) as V3, t: a.t.map((x, n) => (x - b.t[n]) / 0.02) as V3 },
        at: null
      }
    }
    // Cast down the shaft: the background is a bottomless pit seen from above and the window falls
    // away into it, shrinking fast toward the centre (perspective does most of it: even a steady
    // fall shrinks quickly at first) until it's a speck. Its sideways offset shrinks with it.
    const { pose: rp, vel } = release.current
    const dv = v - fl.ur
    const k = dv / (1 - fl.ur)
    const g = Math.pow(k, 1.3)
    // Caught by the whirlpool: its offset from the centre winds round (the same way the pit
    // turns) as it closes in, and it rolls with the current.
    const swirl = HINGE.swirl * g
    const ox = (rp.t[0] + vel.t[0] * dv * 0.12) * (1 - g)
    const oy = (rp.t[1] + vel.t[1] * dv * 0.12) * (1 - g)
    const [c, sn] = [Math.cos(swirl), Math.sin(swirl)]
    return {
      e: rp.e.map((x, n) => x + vel.e[n] * dv * 0.25 + fl.tumble[n] * dv + (n === 2 ? (swirl * 180) / Math.PI * 0.8 : 0)) as V3,
      t: [ox * c - oy * sn, ox * sn + oy * c, rp.t[2] - HINGE.sinkDepth * W * g]
    }
  }

  /**
   * The projection rig: the dot "projects" the swinging window. A faint light cone and wires run
   * from the dot to the window's corners, pulses travel out along them, and a dashed hinge axis
   * runs through the dot. Strongest mid-swing; wires drop out and stutter at random.
   */
  const placeRig = (svg: SVGSVGElement | null, id: string, corners: [number, number][], strength: number, color: string) => {
    if (!svg) return
    const d = markerCenter(id)
    if (!d || strength <= 0.01) {
      svg.style.opacity = '0'
      return
    }
    svg.style.opacity = '1'
    svg.style.setProperty('--c', color)
    const [tl, tr, br, bl] = corners
    // The cone: from the dot out to the window's outline.
    const pts = [[d.x, d.y], tl, tr, br, bl].map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
    const beam = svg.querySelector('.rig-beam')
    beam?.setAttribute('points', pts)
    beam?.setAttribute('opacity', (HINGE_FX.beam * strength).toFixed(3))
    const grad = svg.querySelector('linearGradient')
    if (grad) {
      grad.setAttribute('x1', String(d.x))
      grad.setAttribute('y1', String(d.y))
      grad.setAttribute('x2', String((tr[0] + br[0]) / 2))
      grad.setAttribute('y2', String((tr[1] + br[1]) / 2))
    }
    const wires = svg.querySelectorAll<SVGLineElement>('.rig-wire, .rig-pulse')
    wires.forEach((w, i) => {
      const [cx, cy] = corners[i % 4]
      // A wire sometimes stutters sideways for a frame.
      const jog = Math.random() < 0.06 ? rnd(-14, 14) : 0
      w.setAttribute('x1', String(d.x))
      w.setAttribute('y1', String(d.y))
      w.setAttribute('x2', (cx + jog).toFixed(1))
      w.setAttribute('y2', cy.toFixed(1))
      const drop = Math.random() < HINGE_FX.flicker ? 0.3 : 1
      w.setAttribute('opacity', (HINGE_FX.wire * strength * drop).toFixed(3))
    })
    const axis = svg.querySelector('.rig-axis')
    axis?.setAttribute('x1', String(d.x))
    axis?.setAttribute('x2', String(d.x))
    axis?.setAttribute('y1', Math.min(tl[1], tr[1]).toFixed(1))
    axis?.setAttribute('y2', Math.max(bl[1], br[1]).toFixed(1))
    axis?.setAttribute('opacity', (0.6 * strength).toFixed(3))
  }

  const frame = useCallback(() => {
    const a = anim.current
    if (!a) return
    // p runs linearly with time; each phase applies its own easing.
    const t = Math.min(1, (performance.now() - a.start) / a.ms)
    a.p = lerp(a.p0, a.target, t)
    const { front: f } = state.current
    const b = (f === 0 ? 1 : 0) as 0 | 1
    const fromSlot = slotEl(a.from)
    if (fromSlot && a.target === 1) keepInView(fromSlot)
    // One after the other: the current window shrinks home, then the next grows out of its slot.
    const outEnd = hingedFlights() ? HINGE.outEnd : OUT_END
    const inStart = hingedFlights() ? HINGE.inStart : IN_START
    const qOut = easeOut(clamp01(a.p / outEnd))
    const qIn = 1 - easeIn(clamp01((a.p - inStart) / (1 - inStart)))
    if (hingedFlights()) {
      document.documentElement.classList.add('is-hinging')
      heatPeak.current = 0
      const st = frameRef.current?.getBoundingClientRect()
      const W = st?.width ?? 1000
      const fl = a.fl
      // Each window's part of the switch, linear (each path does its own easing).
      const u = clamp01((a.p - inStart) / (1 - inStart))
      const v = clamp01(a.p / outEnd)
      // Going away: swung around its dot on the line, then let go and flung off into the deep.
      const dOut = markerCenter(a.from)
      const dotOut: [number, number] = dOut ? [dOut.x, dOut.y] : st ? [st.left - 150, st.top + st.height / 2] : [0, 0]
      const flungK = v > fl.ur ? (v - fl.ur) / (1 - fl.ur) : 0
      // The pit it falls into opens just as it's let go, at the bottom of the shaft (the stage's
      // centre, where it shrinks to). The backdrop eases it shut once the switch is done.
      if (st) Object.assign(fxPit, { x0: st.left, y0: st.top, x1: st.right, y1: st.bottom, s: clamp01((v - fl.ur + 0.1) / 0.1) })
      const out = st
        ? placeFlight(f, ghostRef.current, plateRef.current, a.from, throwPose(fl, v, W, st, dotOut), 1, {
            // Harder and harder to see through the mist as it sinks, then gone in a couple of
            // frames: it blows up.
            fade: Math.min(clamp01((HINGE_FX.burstAt + 0.04 - flungK) / 0.04), 1 - 0.65 * clamp01(flungK / HINGE_FX.burstAt)),
            rig: v <= fl.ur ? Math.pow(v / fl.ur, 0.7) : 0,
            // The force field eases off as it falls away.
            field: 1 - flungK,
            sweep: v,
            kick: v > fl.ur && v < fl.ur + 0.12 ? 1 : 0
          })
        : null
      // Far down, it blows up in a green flash (once per throw).
      if (out && flungK >= HINGE_FX.burstAt && !burst.current) {
        burst.current = true
        const [tl, , br] = out.corners
        Object.assign(fxBurst, { x: out.mid[0], y: out.mid[1], r: Math.max(6, Math.hypot(br[0] - tl[0], br[1] - tl[1]) / 2), corners: out.corners.map((p) => [...p]), color: colorOf(a.from), at: performance.now() })
      }
      // The green mist it's swallowed by as it sinks.
      ghostRef.current?.style.setProperty('--mist', (0.9 * clamp01(flungK / HINGE_FX.burstAt)).toFixed(3))
      const svgOut = connectorOutRef.current
      if (out && svgOut) {
        if (v <= fl.ur) {
          release.current = null
          svgOut.classList.remove('is-snapped')
          placeTether(svgOut, a.from, out.edge, 1)
        } else {
          // The line lets go and whips back to the dot.
          const rel = release.current
          if (rel && !rel.at) rel.at = out.mid
          const at = rel?.at ?? out.mid
          const k = clamp01((v - fl.ur) / HINGE.snap)
          const x = lerp(at[0], dotOut[0] + 12, easeOut(k))
          const y = lerp(at[1], dotOut[1], easeOut(k))
          svgOut.classList.add('is-snapped')
          placeTether(svgOut, a.from, k < 1 ? { left: x, top: y - 1, bottom: y + 1 } : null, 1 - k)
        }
      }
      // Coming in: swung in on its dot (the anchor), the line catching it on the way.
      const dIn = markerCenter(a.to)
      const hingeIn = dIn ? dIn.x : st ? st.left - 150 : 0
      const { pose: cp, s } = st ? catchPose(fl, u, st, hingeIn) : { pose: REST, s: 1 }
      const inn = placeFlight(b, ghostInRef.current, plateInRef.current, a.to, cp, 0, {
        fade: u > 0 ? 1 : 0,
        rig: s >= 0 ? Math.pow(1 - s, 0.8) : 0,
        sweep: u,
        kick: s >= 0 && s < 0.14 ? 1 - s / 0.14 : 0
      })
      const svg = connectorRef.current
      if (inn && svg) {
        const lassoFrom = fl.uc - HINGE.lasso
        if (u < lassoFrom) {
          svg.classList.remove('is-lassoing', 'is-caught')
          placeTether(svg, a.to, null, 0)
          fxLasso.s = 0
        } else if (u < fl.uc) {
          // The lasso: the line shoots out from the dot toward where the window is.
          const d = markerCenter(a.to)
          const k = easeOut((u - lassoFrom) / HINGE.lasso)
          const x = d ? lerp(d.x + 12, inn.mid[0], k) : inn.mid[0]
          const y = d ? lerp(d.y, inn.mid[1], k) : inn.mid[1]
          svg.classList.add('is-lassoing')
          const pts = placeTether(svg, a.to, { left: x, top: y - 1, bottom: y + 1 }, 1)
          Object.assign(fxLasso, { pts, s: pts ? k : 0 })
        } else {
          // Caught: the line goes taut on the window's edge while it's reeled in.
          if (!svg.classList.contains('is-caught')) {
            svg.classList.remove('is-lassoing')
            void svg.getBoundingClientRect()
            svg.classList.add('is-caught')
          }
          const pts = placeTether(svg, a.to, inn.edge, 1)
          // The energy runs hardest just after the catch and dies off as it's reeled home.
          Object.assign(fxLasso, { pts, s: pts ? clamp01(1.25 - s * 1.4) : 0 })
        }
      }
      const now = performance.now()
      if (now >= heatAt.current) {
        heatAt.current = now + HINGE_FX.heatStep
        document.getElementById('fx-heat-map')?.setAttribute('scale', (HINGE_FX.heat * heatPeak.current).toFixed(1))
        document.getElementById('fx-heat-noise')?.setAttribute('seed', String(Math.floor(Math.random() * 1000)))
        // Digital tears in bursts: some steps clean, some slip bands of the window sideways.
        const tear = Math.random() < HINGE_FX.tearChance ? rnd(HINGE_FX.tearPx[0], HINGE_FX.tearPx[1]) * heatPeak.current : 0
        document.getElementById('fx-wtear-map')?.setAttribute('scale', tear.toFixed(0))
        document.getElementById('fx-wtear-noise')?.setAttribute('seed', String(Math.floor(Math.random() * 1000)))
        // Red one way, green-blue the other, thrown in steps (sometimes a little vertical kick).
        const c = rnd(HINGE_FX.chroma[0], HINGE_FX.chroma[1]) * heatPeak.current * sgn()
        const cy = Math.random() < 0.25 ? rnd(-2, 2) * heatPeak.current : 0
        chroma.current = { dx: c, dy: cy }
      }
    } else {
      const outEdge = place(f, ghostRef.current, plateRef.current, a.from, qOut)
      const inEdge = place(b, ghostInRef.current, plateInRef.current, a.to, qIn)
      // Each window stays tethered to its own slot; the dot fades as the window covers it.
      placeTether(connectorOutRef.current, a.from, outEdge, copyOpacity(qOut))
      placeTether(connectorRef.current, a.to, inEdge, copyOpacity(qIn))
    }
    // While the windows travel, the stage is an empty neutral frame; the flying frames carry the colour.
    const stage = frameRef.current
    if (stage) {
      stage.classList.add('is-switching')
      // The empty stage's black fades out as the old window leaves and back in as the new one
      // grows, so it's already solid when the switch ends (no snap).
      const solid = Math.max(clamp01(1 - qOut / 0.35), clamp01((0.5 - qIn) / 0.45))
      stage.style.setProperty('--bay-solid', solid.toFixed(3))
    }
    if (t < 1) {
      raf.current = requestAnimationFrame(frame)
      return
    }
    if (a.target === 0 || a.committed) finish()
    else {
      // Waiting for the server to confirm the switch; undo if it never does.
      graceTimer.current = window.setTimeout(() => {
        if (anim.current === a && !a.committed) reverse()
      }, COMMIT_GRACE_MS)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorOf, finish, placeTether])

  const start = useCallback(
    (to: string, ms: number, committed: boolean) => {
      const { displayed: from, front: f } = state.current
      if (!from || from === to) return
      if (anim.current) finish()
      const b = (f === 0 ? 1 : 0) as 0 | 1
      setLayers((l) => {
        const next: [string | null, string | null] = [...l]
        next[b] = to
        return next
      })
      setAnimating(true)
      // Instant, so the slot isn't moving while the terminal flies toward it.
      document.querySelector(`[data-slot="${CSS.escape(from)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
      onVisual({ bigId: to, landingId: from, ms })
      const fl = rollFlight()
      anim.current = { from, to, start: performance.now(), ms, p0: 0, target: 1, committed, p: 0, fl }
      raf.current = requestAnimationFrame(frame)
      // The dot's lock-on plays as it catches the window (or, without the catch, as it lands).
      lockOn(to, hingedFlights() ? ms * (HINGE.inStart + fl.uc * (1 - HINGE.inStart)) : ms * 0.4)
    },
    [finish, frame, onVisual, lockOn]
  )

  const reverse = useCallback(() => {
    const a = anim.current
    if (!a || a.target === 0) return
    window.clearTimeout(graceTimer.current)
    cancelAnimationFrame(raf.current)
    anim.current = { ...a, start: performance.now(), ms: Math.max(200, CANCEL_MS * a.p), p0: a.p, target: 0 }
    onVisual({ bigId: a.from, landingId: null, ms: CANCEL_MS })
    raf.current = requestAnimationFrame(frame)
  }, [frame, onVisual])

  // Send-off preview starts / is cancelled.
  const lastPreview = useRef<Preview | null>(null)
  useEffect(() => {
    const prev = lastPreview.current
    lastPreview.current = preview
    // Hacker: the same length as a click (if the send-off window is longer, it holds at the end until it commits).
    if (preview && (!prev || prev.to !== preview.to)) start(preview.to, hingedFlights() ? HINGE.ms : preview.ms, false)
    else if (!preview && prev && anim.current && !anim.current.committed && anim.current.to === prev.to) reverse()
  }, [preview, start, reverse])

  // The server moved focus (commit of a preview, a click, snap mode, a shortcut).
  useLayoutEffect(() => {
    const a = anim.current
    if (!activeId) return
    if (a && a.target === 1 && a.to === activeId) {
      a.committed = true
      if (performance.now() - a.start >= a.ms) finish()
      return
    }
    if (!state.current.displayed) {
      setLayers((l) => {
        const next: [string | null, string | null] = [...l]
        next[state.current.front] = activeId
        return next
      })
      return
    }
    if (state.current.displayed !== activeId) start(activeId, hingedFlights() ? HINGE.ms : CLICK_MS, true)
  }, [activeId, start, finish])

  useEffect(() => {
    if (!animating) onVisual({ bigId: displayed, landingId: null, ms: CLICK_MS })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayed])

  const bigId = anim.current && anim.current.target === 1 ? anim.current.to : displayed

  // Publish the big terminal's shape; minis use it so each is a true thumbnail of it.
  useEffect(() => {
    const el = refs[0].current?.el
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (el.offsetWidth && el.offsetHeight)
        document.documentElement.style.setProperty('--term-aspect', String(el.offsetWidth / el.offsetHeight))
    })
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // At rest, keep the connector on the big session's dot as the stack scrolls, the window resizes,
  // or slots move (reorder, drag, park, open/close Parked).
  useEffect(() => {
    if (animating) return
    const update = () => {
      if (anim.current) return
      const st = frameRef.current?.getBoundingClientRect()
      placeTether(connectorRef.current, displayed, st ? { left: st.left, top: st.top, bottom: st.bottom } : null, 1)
      placeTether(connectorOutRef.current, null, null, 0)
    }
    update()
    // Arrived without a flight (first load, a cancelled switch going back): lock on here.
    lockOn(displayed)
    // Slots may still be settling in this commit; place again once layout is final.
    const r1 = requestAnimationFrame(update)
    const ro = new ResizeObserver(update)
    if (frameRef.current) ro.observe(frameRef.current)
    // Slots move without scrolling: a reorder re-renders them, a drag shifts them with inline
    // transforms, and both glide with CSS transitions. On any such change, follow every frame
    // until things have been still for a moment.
    let follow = 0
    let until = 0
    const tick = () => {
      update()
      follow = performance.now() < until ? requestAnimationFrame(tick) : 0
    }
    const moved = () => {
      until = performance.now() + FOLLOW_MS
      if (!follow) follow = requestAnimationFrame(tick)
    }
    // The whole sidebar: the lifted drag card lives outside the stack area.
    const area = document.querySelector('.sidebar')
    const mo = new MutationObserver(moved)
    if (area) mo.observe(area, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class'] })
    area?.addEventListener('transitionrun', moved)
    document.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      cancelAnimationFrame(r1)
      cancelAnimationFrame(follow)
      mo.disconnect()
      area?.removeEventListener('transitionrun', moved)
      ro.disconnect()
      document.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [animating, displayed, placeTether, colorOf])
  const color = bigId ? colorOf(bigId) : 'transparent'

  return (
    <div className="stage" ref={frameRef} style={{ ['--active-c' as string]: color }} onPointerEnter={(e) => glitchPanel(e.currentTarget)}>
      {([0, 1] as const).map((i) => (
        <TerminalLayer
          key={i}
          ref={refs[i]}
          sessionId={layers[i]}
          interactive={layers[i] === activeId}
          theme={props.theme}
          fontFamily={props.fontFamily}
          scrollback={props.scrollback}
          inputBlockedUntil={props.inputBlockedUntil}
          onFocusTerminal={props.onFocusTerminal}
          className={i === front ? 'is-front' : i === back && layers[i] ? 'is-back' : 'is-idle'}
        />
      ))}
      {/* Hinged flights (Hacker): the tile's thickness and its motion smear, [in, in, out, out]. */}
      {[0, 1].map((k) => (
        <div key={`s${k}`} className="flight-slab" ref={(el) => void (slabEls.current[k] = el)} />
      ))}
      {[0, 1, 2, 3].map((k) => (
        <div key={`e${k}`} className="flight-echo" ref={(el) => void (echoEls.current[k] = el)} />
      ))}
      {[0, 1].map((k) => (
        <div key={`t${k}`} className="flight-trail" ref={(el) => void (trailEls.current[k] = el)} />
      ))}
      {[0, 1, 2, 3].map((k) => (
        <div key={`p${k}`} className={`flight-split ${k % 2 ? 'is-c' : 'is-r'}`} ref={(el) => void (splitEls.current[k] = el)} />
      ))}
      {[0, 1].map((k) => (
        <svg key={`r${k}`} className="hinge-rig" ref={(el) => void (rigEls.current[k] = el)} aria-hidden>
          <defs>
            <linearGradient id={`rig-grad-${k}`} gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="var(--c)" stopOpacity="1" />
              <stop offset="1" stopColor="var(--c)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <polygon className="rig-beam" fill={`url(#rig-grad-${k})`} />
          <line className="rig-axis" />
          {[0, 1, 2, 3].map((w) => (
            <line key={`w${w}`} className="rig-wire" />
          ))}
          {[0, 1, 2, 3].map((w) => (
            <line key={`q${w}`} className="rig-pulse" pathLength={1} />
          ))}
        </svg>
      ))}
      <div className="flight-plate" ref={plateInRef} />
      <div className="flight-ghost" ref={ghostInRef} />
      <div className="flight-plate is-out" ref={plateRef} />
      <div className="flight-ghost is-out" ref={ghostRef} />
      <svg className="slot-connector" ref={connectorRef} aria-hidden>
        <path pathLength={1} />
        {/* Lock-on: a spark that runs the line out to the window, and a shockwave off the dot. */}
        <path className="tether-zap" pathLength={1} />
        <circle className="tether-shock" r="7" />
        <circle className="tether-halo" r="11" />
        <circle className="tether-dot" r="7" />
        {/* Targeting reticle: two broken rings turning opposite ways, and breathing corner ticks. */}
        <g className="tether-reticle">
          <g className="reticle-lock">
            <circle className="reticle-ring is-inner" r="17" />
            <circle className="reticle-ring is-outer" r="24" />
            <g className="reticle-ticks">
              <path d="M19.8 19.8l3.5 3.5M-19.8 19.8l-3.5 3.5M19.8 -19.8l3.5 -3.5M-19.8 -19.8l-3.5 -3.5" />
            </g>
          </g>
          <text className="tether-lock-text" x="31" y="-17">
            TARGET LOCKED
          </text>
        </g>
      </svg>
      <svg className="slot-connector is-out" ref={connectorOutRef} aria-hidden>
        <path />
        <circle className="tether-halo" r="11" />
        <circle className="tether-dot" r="7" />
      </svg>
    </div>
  )
}

export function focusMainTerminal(): void {
  document.querySelector<HTMLTextAreaElement>('.term-layer.is-front .xterm-helper-textarea')?.focus()
}
