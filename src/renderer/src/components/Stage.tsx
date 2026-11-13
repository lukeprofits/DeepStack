import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TerminalTheme } from '../../../shared/types'
import { TerminalLayer, type TerminalLayerHandle } from './TerminalLayer'

/** A switch the parent wants to show: animate `from` back into its slot, revealing `to`. */
export interface Preview {
  from: string
  to: string
  ms: number
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

/** Keep the slot a window is flying home to inside the stack's scroll area. */
function keepInView(slot: HTMLElement): void {
  const list = slot.closest<HTMLElement>('.stack-list, .park-list')
  if (!list) return
  const l = list.getBoundingClientRect()
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
function markerCenter(id: string): { x: number; y: number; clipTop: number; clipBottom: number } | null {
  const dot = slotEl(id)?.querySelector<HTMLElement>('.slot-marker-dot')
  const list = dot?.closest<HTMLElement>('.stack-list, .park-list')?.getBoundingClientRect()
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
  const list = slot.closest<HTMLElement>('.stack-list, .park-list')?.getBoundingClientRect()
  if (r.width === 0 || !list) return null
  if (r.top < list.top - r.height / 2 || r.bottom > list.bottom + r.height / 2) return null
  return r
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
  /** Tether of the big (or incoming) session, and of the one flying home. */
  const connectorRef = useRef<SVGSVGElement>(null)
  const connectorOutRef = useRef<SVGSVGElement>(null)
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
      const path = svg.querySelector('path')
      if (!id || !d || !win || !path || dotOpacity <= 0) {
        svg.style.opacity = '0'
        return
      }
      // +1 so it runs into the window's 2px border rather than stopping short of it.
      const endX = win.left + 1
      const inset = Math.min(TETHER_RADIUS + 6, (win.bottom - win.top) / 2)
      const ty = Math.min(Math.max(d.y, win.top + inset), win.bottom - inset)
      const dy = ty - d.y
      const ex = win.left - TETHER_ELBOW_GAP
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
      path.setAttribute('d', dAttr)
      for (const c of svg.querySelectorAll('circle')) {
        c.setAttribute('cx', String(d.x))
        c.setAttribute('cy', String(d.y))
      }
      // Clip to the band the stack scrolls in: the dot and line slide under the header (or the
      // parked drawer) instead of drawing over it.
      svg.style.clipPath = `inset(${d.clipTop}px 0 ${Math.max(0, window.innerHeight - d.clipBottom)}px 0)`
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
      }
    }
    for (const g of [ghostRef.current, ghostInRef.current, plateRef.current, plateInRef.current]) if (g) g.style.opacity = '0'
    // The incoming frame has landed exactly on the stage's border: take over without a colour fade.
    const stage = frameRef.current
    if (stage?.classList.contains('is-switching')) {
      stage.style.transition = 'none'
      stage.classList.remove('is-switching')
      void stage.offsetWidth
      requestAnimationFrame(() => (stage.style.transition = ''))
    }
    for (const m of touched.current) {
      m.style.opacity = ''
      m.style.transition = ''
    }
    touched.current.clear()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled])

  /** Mini elements whose opacity the flight drives inline; cleared once the switch is committed to the DOM. */
  const touched = useRef(new Set<HTMLElement>())

  const setMini = (id: string, opacity: number) => {
    const mini = slotEl(id)?.querySelector<HTMLElement>('.mini')
    if (!mini) return
    touched.current.add(mini)
    mini.style.transition = 'none'
    mini.style.opacity = String(opacity)
  }

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
      setMini(id, q)
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
    setMini(id, 1 - o)
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
    const outEdge = place(f, ghostRef.current, plateRef.current, a.from, qOut)
    const inEdge = place(b, ghostInRef.current, plateInRef.current, a.to, qIn)
    // Each window stays tethered to its own slot; the dot fades as the window covers it.
    placeTether(connectorOutRef.current, a.from, outEdge, copyOpacity(qOut))
    placeTether(connectorRef.current, a.to, inEdge, copyOpacity(qIn))
    // While the windows travel, the stage is an empty neutral frame; the flying frames carry the colour.
    const stage = frameRef.current
    if (stage) stage.classList.add('is-switching')
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
      anim.current = { from, to, start: performance.now(), ms, p0: 0, target: 1, committed, p: 0 }
      raf.current = requestAnimationFrame(frame)
    },
    [finish, frame, onVisual]
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

  // At rest, keep the connector on the big session's dot as the stack scrolls or the window resizes.
  useEffect(() => {
    if (animating) return
    const update = () => {
      if (anim.current) return
      const st = frameRef.current?.getBoundingClientRect()
      placeTether(connectorRef.current, displayed, st ? { left: st.left, top: st.top, bottom: st.bottom } : null, 1)
      placeTether(connectorOutRef.current, null, null, 0)
    }
    update()
    // Slots may still be settling in this commit; place again once layout is final.
    const r1 = requestAnimationFrame(update)
    const ro = new ResizeObserver(update)
    if (frameRef.current) ro.observe(frameRef.current)
    document.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      cancelAnimationFrame(r1)
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
      <div className="flight-plate" ref={plateInRef} />
      <div className="flight-ghost" ref={ghostInRef} />
      <div className="flight-plate is-out" ref={plateRef} />
      <div className="flight-ghost is-out" ref={ghostRef} />
      <svg className="slot-connector" ref={connectorRef} aria-hidden>
        <path />
        <circle className="tether-halo" r="11" />
        <circle className="tether-dot" r="7" />
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
