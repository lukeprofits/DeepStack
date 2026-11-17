import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TerminalTheme, SendOffReason } from '../../../shared/types'
import { TerminalLayer, type TerminalLayerHandle } from './TerminalLayer'
import { fxField } from '../lib/fxField'

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
 * 90s Hacker: windows swing in and out like doors on a vertical hinge through the thumbnails'
 * dots, instead of shrinking into them. perspective: viewer distance as a multiple of the stage
 * width (smaller = more dramatic near the camera). slabs: depths (px) of the backing layers that
 * show as a tile's thickness while it turns. echo: how far back (in frames of turn) the smeared
 * copies of the frame trail it. fade: degrees before edge-on over which a window fades out.
 */
const HINGE = { perspective: 2.2, slabs: [10, 22], echo: [1.4, 2.8, 4.2, 5.6], fade: 8, tilt: 45 }
/**
 * The swing's look (90s Hacker). echoA: opacity of each frame echo; trail/trailA: lags and
 * opacity of the filled body afterimages (motion blur); split: red/cyan frame offset range (px),
 * re-rolled every splitStep ms; tear: chance a split copy shows only a torn band; beam/wire:
 * strength of the projection rig from the dot; flicker: chance per frame a wire drops out.
 */
const HINGE_FX = {
  echoA: [0.45, 0.28, 0.16, 0.08],
  trail: [2, 4],
  trailA: [0.18, 0.08],
  split: [2, 9],
  splitStep: [40, 70],
  tear: 0.3,
  beam: 0.16,
  wire: 0.75,
  flicker: 0.12,
  /** Heat distortion: peak displacement (px) mid-swing, and how often it re-shimmers (ms). */
  heat: 12,
  heatStep: 50,
  /** Window tears: chance a step tears at all, and its strength (px) mid-swing. */
  tearChance: 0.5,
  tearPx: [18, 48],
  /** Chromatic aberration on the window's content: channel offset range (px) mid-swing. */
  chroma: [4, 14]
}
const rnd = (a: number, b: number) => a + Math.random() * (b - a)
/** A random tilt for a window's hinge (degrees off vertical), so each one swings in or out from somewhere new. */
const pickTilt = () => rnd(-HINGE.tilt, HINGE.tilt)

const hingedFlights = () =>
  document.documentElement.dataset.fx === 'matrix' && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** The hinge's pivot: the session's dot (or, scrolled away, any dot's x at the stage's middle). */
function hingePoint(id: string, st: DOMRect): [number, number] {
  const own = markerCenter(id)
  if (own) return [own.x, own.y]
  const any = document.querySelector('.stack-list .slot-marker-dot')?.getBoundingClientRect()
  return [any && any.width ? any.left + any.width / 2 : st.left - 160, st.top + st.height / 2]
}

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
  /** 90s Hacker: each window's hinge tilt (degrees), [incoming, outgoing]. */
  tilt: [number, number]
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
  /** Hinged flights (90s Hacker): per window [incoming, outgoing], two backing slabs and two echoes. */
  const slabEls = useRef<(HTMLDivElement | null)[]>([])
  const echoEls = useRef<(HTMLDivElement | null)[]>([])
  /** Each window's angle last frame, for the echoes' smear. */
  const lastTheta = useRef<[number, number]>([0, 0])
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
    (svg: SVGSVGElement | null, id: string | null, win: Edge | null, dotOpacity: number) => {
      if (!svg) return
      const d = id ? markerCenter(id) : null
      const path = svg.querySelector(':scope > path')
      if (!id || !d || !win || !path || dotOpacity <= 0) {
        svg.style.opacity = '0'
        return
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
    for (const g of [...slabEls.current, ...echoEls.current, ...trailEls.current, ...splitEls.current]) {
      if (!g) continue
      g.style.opacity = '0'
      g.style.transform = ''
    }
    for (const r of rigEls.current) if (r) r.style.opacity = '0'
    for (const g of [ghostRef.current, ghostInRef.current]) g?.style.setProperty('--turn', '0')
    lastTheta.current = [0, 0]
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
   * The same window, swung on the hinge instead of shrunk: q 0 = flat in the stage, 1 = edge-on.
   * dir -1 swings in from its right side toward you; +1 swings away. slot 0 = incoming, 1 = out.
   * Every piece gets the same projection (its own offsets, origin 0 0), so they stay locked.
   */
  const placeHinged = (i: 0 | 1, ghost: HTMLDivElement | null, plate: HTMLDivElement | null, id: string, q: number, dir: 1 | -1, slot: 0 | 1, tilt: number): Edge | null => {
    const el = refs[i].current?.el
    const stage = frameRef.current
    if (!el || !stage) return null
    const st = stage.getBoundingClientRect()
    const [hx, hy] = hingePoint(id, st)
    const ex = st.left + st.width / 2
    const ey = st.top + st.height / 2
    const P = HINGE.perspective * st.width
    const theta = dir * 90 * q
    const fade = clamp01((90 - Math.abs(theta)) / HINGE.fade)
    // Nearer (incoming) above the stack (z 15 while hinging), farther (outgoing) behind it.
    const z = slot === 0 ? 20 : 4
    // The hinge runs through the dot, tilted off vertical by `tilt`.
    const tf = (L: number, T: number, deg: number, depth = 0) =>
      `translate(${ex - L}px, ${ey - T}px) perspective(${P}px) translate(${L - ex}px, ${T - ey}px) ` +
      `translate(${hx - L}px, ${hy - T}px) rotate(${tilt}deg) rotateY(${deg}deg)${depth ? ` translateZ(${-depth}px)` : ''} rotate(${-tilt}deg) translate(${L - hx}px, ${T - hy}px)`
    const host = (el.offsetParent ?? document.body).getBoundingClientRect()
    const mLeft = host.left + el.offsetLeft
    const mTop = host.top + el.offsetTop
    el.style.transform = tf(mLeft, mTop, theta)
    el.style.clipPath = ''
    el.style.opacity = String(fade)
    el.style.zIndex = String(z + 4)
    const frameBox = { left: `${st.left}px`, top: `${st.top}px`, width: `${st.width}px`, height: `${st.height}px`, borderRadius: '10px' }
    const color = colorOf(id)
    for (const [g, k] of [[plate, 2], [ghost, 6]] as const) {
      if (!g) continue
      Object.assign(g.style, frameBox, { transform: tf(st.left, st.top, theta), opacity: String(fade), zIndex: String(z + k) })
    }
    ghost?.style.setProperty('--gc', color)
    // The tile's thickness: slabs behind the plate, only seen side-on.
    HINGE.slabs.forEach((d, k) => {
      const g = slabEls.current[slot * 2 + k]
      if (!g) return
      Object.assign(g.style, frameBox, { transform: tf(st.left, st.top, theta, d), opacity: String(fade * (q > 0.001 ? 1 : 0)), zIndex: String(z - k) })
      g.style.setProperty('--gc', color)
    })
    // Motion blur, cheaply: the frame (and, fainter, the whole body) smeared back along its
    // swing, longer the faster it turns; nothing when it's still.
    const dTheta = theta - lastTheta.current[slot]
    lastTheta.current[slot] = theta
    const speed = clamp01(Math.abs(dTheta) / 3)
    HINGE.echo.forEach((lag, k) => {
      const g = echoEls.current[slot * 4 + k]
      if (!g) return
      Object.assign(g.style, frameBox, {
        transform: tf(st.left, st.top, theta - dTheta * lag),
        opacity: String(fade * speed * HINGE_FX.echoA[k]),
        zIndex: String(z + 5)
      })
      g.style.setProperty('--gc', color)
    })
    HINGE_FX.trail.forEach((lag, k) => {
      const g = trailEls.current[slot * 2 + k]
      if (!g) return
      Object.assign(g.style, frameBox, {
        transform: tf(st.left, st.top, theta - dTheta * lag),
        opacity: String(fade * speed * HINGE_FX.trailA[k]),
        zIndex: String(z + 5)
      })
      g.style.setProperty('--gc', color)
    })
    // How turned it is: drives the glitch, the hologram face and the rig (0 flat or edge-on... ish).
    const turn = Math.sin((Math.abs(theta) * Math.PI) / 180)
    const mid = Math.sin((Math.abs(theta) * Math.PI) / 90)
    // Heat distortion on the content and frame while it turns (the shared filter's strength is
    // set once per frame in frame(), from the stronger of the two swings).
    const hot = mid * fade > 0.04
    // Chromatic aberration on the content: the layer is see-through around its text, so red and
    // cyan drop-shadow copies either side split the text (far cheaper than an SVG channel split).
    const c = chroma.current
    const split = Math.abs(c.dx) > 0.3 ? ` drop-shadow(${c.dx.toFixed(1)}px ${c.dy.toFixed(1)}px 0 rgba(255, 40, 90, 0.75)) drop-shadow(${(-c.dx).toFixed(1)}px ${(-c.dy).toFixed(1)}px 0 rgba(40, 220, 255, 0.75))` : ''
    el.style.filter = hot ? `url(#fx-heat) url(#fx-wtear)${split}` : ''
    if (ghost) ghost.style.filter = hot ? 'url(#fx-heat) url(#fx-wtear)' : ''
    heatPeak.current = Math.max(heatPeak.current, mid * fade)
    ghost?.style.setProperty('--turn', turn.toFixed(3))
    ghost?.style.setProperty('--sweep', (q * 100).toFixed(1) + '%')
    // Edge glitch: red and cyan copies of the frame, thrown sideways in steps, sometimes torn.
    const sp = splitState.current[slot]
    const now = performance.now()
    if (now >= sp.at) {
      sp.at = now + rnd(HINGE_FX.splitStep[0], HINGE_FX.splitStep[1])
      sp.d = rnd(HINGE_FX.split[0], HINGE_FX.split[1]) * (Math.random() < 0.5 ? -1 : 1)
      const h = rnd(6, 26)
      const top = rnd(0, 100 - h)
      sp.band = Math.random() < HINGE_FX.tear ? `inset(${top.toFixed(1)}% 0 ${(100 - top - h).toFixed(1)}% 0)` : ''
    }
    ;[1, -1].forEach((sgn, k) => {
      const g = splitEls.current[slot * 2 + k]
      if (!g) return
      const torn = k === 0 && sp.band
      Object.assign(g.style, frameBox, {
        transform: `translateX(${(sgn * sp.d * (torn ? 2.2 : 1) * turn).toFixed(1)}px) ${tf(st.left, st.top, theta)}`,
        clipPath: torn ? sp.band : '',
        opacity: String(fade * Math.min(1, turn * 1.6) * 0.8),
        zIndex: String(z + 7)
      })
    })
    // Any point of the window at rest, swung about the tilted hinge and projected to the screen
    // (the same steps as tf, right to left).
    const rad = (theta * Math.PI) / 180
    const phi = (tilt * Math.PI) / 180
    const project = (x: number, y: number): [number, number] => {
      const px = x - hx
      const py = y - hy
      const x1 = px * Math.cos(-phi) - py * Math.sin(-phi)
      const y1 = px * Math.sin(-phi) + py * Math.cos(-phi)
      const x2 = x1 * Math.cos(rad)
      const z2 = -x1 * Math.sin(rad)
      const X = hx + x2 * Math.cos(phi) - y1 * Math.sin(phi)
      const Y = hy + x2 * Math.sin(phi) + y1 * Math.cos(phi)
      const sc = P / Math.max(1, P - z2)
      return [ex + (X - ex) * sc, ey + (Y - ey) * sc]
    }
    const corners = [project(st.left, st.top), project(st.right, st.top), project(st.right, st.bottom), project(st.left, st.bottom)]
    // The force field: the backdrop ripples around where the window is (fx/matrix.ts).
    const xs = corners.map((c) => c[0])
    const ys = corners.map((c) => c[1])
    Object.assign(fxField[slot], { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), s: fade * Math.max(mid, speed * 0.6) })
    placeRig(rigEls.current[slot], id, corners, fade * mid, color)
    // The leaving window's rig runs out from behind the stack, like the window itself.
    const rig = rigEls.current[slot]
    if (rig) rig.style.zIndex = slot === 0 ? '29' : '12'
    // The tether meets the window's left edge, swung and projected like everything else (it's
    // slanted when the hinge is tilted, so the tether gets the edge's x at its height).
    const [[ax, ay], [bx, by]] = [corners[0], corners[3]]
    const xAt = (y: number) => (Math.abs(by - ay) < 0.5 ? ax : ax + ((bx - ax) * (y - ay)) / (by - ay))
    return { left: Math.min(ax, bx), top: Math.min(ay, by), bottom: Math.max(ay, by), xAt }
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
    const qOut = easeOut(clamp01(a.p / OUT_END))
    const qIn = 1 - easeIn(clamp01((a.p - IN_START) / (1 - IN_START)))
    if (hingedFlights()) {
      document.documentElement.classList.add('is-hinging')
      heatPeak.current = 0
      // Doors on the dots' hinge line: the current one swings away, the next swings in at you.
      const outEdge = placeHinged(f, ghostRef.current, plateRef.current, a.from, qOut, 1, 1, a.tilt[1])
      const inEdge = placeHinged(b, ghostInRef.current, plateInRef.current, a.to, qIn, -1, 0, a.tilt[0])
      placeTether(connectorOutRef.current, a.from, outEdge, Math.cos((qOut * Math.PI) / 2))
      placeTether(connectorRef.current, a.to, inEdge, Math.cos((qIn * Math.PI) / 2))
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
        const c = rnd(HINGE_FX.chroma[0], HINGE_FX.chroma[1]) * heatPeak.current * (Math.random() < 0.5 ? -1 : 1)
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
      anim.current = { from, to, start: performance.now(), ms, p0: 0, target: 1, committed, p: 0, tilt: [pickTilt(), pickTilt()] }
      raf.current = requestAnimationFrame(frame)
      lockOn(to, ms * 0.4)
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
    if (preview && (!prev || prev.to !== preview.to)) start(preview.to, preview.ms, false)
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
    if (state.current.displayed !== activeId) start(activeId, CLICK_MS, true)
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
    <div className="stage" ref={frameRef} style={{ ['--active-c' as string]: color }}>
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
      {/* Hinged flights (90s Hacker): the tile's thickness and its motion smear, [in, in, out, out]. */}
      {[0, 1, 2, 3].map((k) => (
        <div key={`s${k}`} className="flight-slab" ref={(el) => void (slabEls.current[k] = el)} />
      ))}
      {[0, 1, 2, 3, 4, 5, 6, 7].map((k) => (
        <div key={`e${k}`} className="flight-echo" ref={(el) => void (echoEls.current[k] = el)} />
      ))}
      {[0, 1, 2, 3].map((k) => (
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
