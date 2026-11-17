import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  defaultDropAnimationSideEffects,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DropAnimation
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { AppState, SessionConfig, SessionRuntime, Theme } from '../../../shared/types'
import { sessionColor } from '../lib/theme'
import { displayName, stackPosition } from '../lib/session'
import { stack } from '../lib/port'
import { attachBounce } from '../lib/overscroll'
import { glitchThumb } from '../lib/thumbGlitch'
import { CloseArm } from './controls'
import { MiniCanvas } from './MiniCanvas'
import { SidebarResizer } from './SidebarResizer'
import type { StageVisual } from './Stage'
import { ParkInvite, ParkSection, StackInvite, ZONE_PARKED } from './ParkDrawer'

interface Props {
  /** Ask to close a session (the ✕ on a thumbnail, once armed). App confirms first. */
  onRequestClose: (id: string) => void
  state: AppState
  theme: Theme
  visual: StageVisual
  collapsed: boolean
  onToggle: () => void
  onNew: () => void
}

const ZONE_ACTIVE = 'zone:active'

const DROP_MS = 280
const DROP_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'
/**
 * Settling a dropped card: it glides to its slot and, in the same motion, grows back from the
 * lifted size (.drag-card's scale and tilt) to full size, so it lands exactly as the thumbnail.
 */
const dropAnimation: DropAnimation = {
  duration: DROP_MS,
  easing: DROP_EASE,
  // Aim at where the slot really is now (after the reorder), not where dnd-kit last measured it.
  keyframes: ({ active, dragOverlay, transform }) => {
    const slot = document.querySelector(`[data-slot="${String(active.id)}"]`)?.getBoundingClientRect()
    // The overlay's on-screen box right now (its own transform included).
    const at = dragOverlay.node.getBoundingClientRect()
    const final = slot
      ? { ...transform.final, x: transform.initial.x + slot.left - at.left, y: transform.initial.y + slot.top - at.top }
      : transform.final
    return [{ transform: CSS.Transform.toString(transform.initial) }, { transform: CSS.Transform.toString(final) }]
  },
  sideEffects: (args) => {
    const card = args.dragOverlay.node.querySelector<HTMLElement>('.drag-card')
    card?.style.setProperty('--drop-ms', `${DROP_MS}ms`)
    card?.style.setProperty('--drop-ease', DROP_EASE)
    // ...and takes on the landing thumbnail's look as it goes (parked ones are grey and dimmed),
    // so nothing changes in the frame it's swapped for the real one.
    const body = document.querySelector(`[data-slot="${String(args.active.id)}"] .slot-body`)
    if (card && body) {
      const look = getComputedStyle(body)
      card.style.setProperty('--drop-filter', look.filter)
      card.style.setProperty('--drop-opacity', look.opacity)
    }
    card?.classList.add('is-dropping')
    return defaultDropAnimationSideEffects({ styles: { active: { opacity: '0' } } })(args)
  }
}

interface SlotProps {
  onRequestClose: (id: string) => void
  s: SessionConfig
  rt: SessionRuntime | undefined
  theme: Theme
  big: boolean
  landing: boolean
  /** A parked session dragged over the stack will land just above this slot. */
  dropBefore: boolean
  /** The dragged parked session will land after this one (it's the last in the stack). */
  dropAfter: boolean
  /** Just dragged back out of Parked: flashes once in its colour. */
  arrived: boolean
}

/**
 * One place in the stack. While its session is the big terminal the slot keeps its space and
 * shows a marker dot; the Stage draws the line from that dot to the big terminal's border.
 */
function Slot({ s, rt, theme, big, landing, dropBefore, dropAfter, arrived, onRequestClose }: SlotProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: s.id })
  const phase = rt?.phase ?? 'dormant'
  const color = sessionColor(theme, s.color)
  const failed = phase === 'error' || phase === 'exited'
  // Claude working, or quiet only while a background task of its own runs (comets orbit it).
  const thinking = phase === 'busy' || (phase === 'idle' && !!rt?.background)

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      data-slot={s.id}
      className={['slot', big ? 'is-big' : '', landing ? 'is-landing' : '', isDragging ? 'is-dragging' : '', s.inactive ? 'is-parked' : '', arrived ? 'is-arrived' : '', thinking ? 'is-thinking' : ''].join(' ')}
      style={{
        ['--c' as string]: color,
        transform: CSS.Transform.toString(transform),
        transition
      }}
      onClick={() => void stack.intent({ t: 'activate', id: s.id })}
      onPointerEnter={(e) => glitchThumb(e.currentTarget)}
      title={displayName(s)}
    >
      {dropBefore && <span className="slot-drop-line" aria-hidden />}
      {dropAfter && <span className="slot-drop-line is-after" aria-hidden />}
      <div className="slot-body">
        <div className="slot-marker" aria-hidden>
          <span className="slot-marker-dot" />
        </div>
        <div className={['mini', `phase-${phase}`, s.inactive ? 'is-inactive' : ''].join(' ')}>
          <MiniCanvas id={s.id} foreground={theme.terminal.foreground} fontFamily={theme.ui.monoFont} useSnapshot={phase === 'dormant'} />
          {rt?.unseen && <span className="mini-dot" />}
          {s.queue.length > 0 && <span className="mini-queue">{s.queue.length}</span>}
          {failed && (
            <div className="mini-error">
              <span>{phase === 'exited' ? 'exited' : rt?.error ?? 'crashed'}</span>
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  void stack.intent({ t: 'relaunch', id: s.id })
                }}
              >
                Relaunch
              </button>
            </div>
          )}
        </div>
        <SlotLabel n={stackPosition(s)} name={displayName(s)} busy={phase === 'busy' || phase === 'starting' || (phase === 'idle' && !!rt?.background)} />
        <CloseArm label={`Close ${displayName(s)}`} onArmedClick={() => onRequestClose(s.id)} />
      </div>
    </div>
  )
}



/**
 * "1 │ name" on each thumbnail: depth in the stack, then the session's name. A name too long
 * for the thumbnail fades out at the edge and, on hover, scrolls to show the rest.
 */
/** busy: Claude is working; a glowing ring circles the number. */
function SlotLabel({ n, name, busy = false }: { n: number; name: string; busy?: boolean }) {
  const box = useRef<HTMLSpanElement>(null)
  const text = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(0)

  useLayoutEffect(() => {
    const b = box.current
    const t = text.current
    if (!b || !t) return
    const measure = () => {
      const o = t.scrollWidth - b.clientWidth
      setOverflow(o > 1 ? o : 0)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(b)
    ro.observe(t)
    return () => ro.disconnect()
  }, [name])

  return (
    <div
      className={`slot-badge ${overflow ? 'is-clipped' : ''}`}
      style={{
        ['--shift' as string]: `${-overflow}px`,
        // Same reading speed whatever the length (~100px/s).
        ['--scroll-ms' as string]: `${Math.round(Math.max(500, overflow * 10))}ms`
      }}
    >
      <span className={`slot-badge-n ${busy ? 'is-busy' : ''}`} title={busy ? 'Working' : undefined}>
        {busy && <span className="slot-badge-ring" aria-hidden />}
        {n}
      </span>
      <span className="slot-badge-sep" aria-hidden />
      <span className="slot-badge-name" ref={box}>
        <span className="slot-badge-text" ref={text}>
          {name}
        </span>
      </span>
    </div>
  )
}

/** The lifted copy that follows the pointer while a session is dragged. */
function DragCard({ s, theme, origin, overPark, overStack }: { s: SessionConfig; theme: Theme; origin: string; overPark: boolean; overStack: boolean }) {
  return (
    <div className={['drag-card', s.inactive ? 'is-parked' : '', overPark ? 'is-over-park' : '', overStack ? 'is-over-stack' : ''].join(' ')} style={{ ['--c' as string]: sessionColor(theme, s.color), transformOrigin: origin }}>
      <div className="mini">
        <MiniCanvas id={s.id} foreground={theme.terminal.foreground} fontFamily={theme.ui.monoFont} useSnapshot={false} />
      </div>
      <SlotLabel n={stackPosition(s)} name={displayName(s)} />
    </div>
  )
}

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

const within = (r: DOMRect, x: number, y: number) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom

/**
 * "Eat": a copy of the dropped card shrinks and fades into the park bar's icon. The canvas is
 * copied by pixels since cloneNode leaves canvases blank.
 */
function eatIntoPark(card: HTMLElement | null): Promise<void> {
  const icon = document.querySelector<HTMLElement>('.park-invite .park-icon') ?? document.querySelector<HTMLElement>('.park-head .park-icon')
  if (!card || !icon || reducedMotion()) return Promise.resolve()
  const from = card.getBoundingClientRect()
  const to = icon.getBoundingClientRect()
  const ghost = card.cloneNode(true) as HTMLElement
  const src = card.querySelectorAll('canvas')
  ghost.querySelectorAll('canvas').forEach((c, i) => {
    c.width = src[i].width
    c.height = src[i].height
    c.getContext('2d')?.drawImage(src[i], 0, 0)
  })
  Object.assign(ghost.style, {
    position: 'fixed',
    left: `${from.left}px`,
    top: `${from.top}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
    margin: '0',
    transform: 'none',
    zIndex: '40',
    pointerEvents: 'none'
  })
  document.body.appendChild(ghost)
  const dx = to.left + to.width / 2 - (from.left + from.width / 2)
  const dy = to.top + to.height / 2 - (from.top + from.height / 2)
  const anim = ghost.animate(
    [
      { transform: 'translate(0, 0) scale(1)', opacity: 1, filter: 'blur(0)' },
      { transform: `translate(${dx}px, ${dy}px) scale(0.06)`, opacity: 0.15, filter: 'blur(1px)' }
    ],
    // Accelerates in, like being pulled down into the tray.
    { duration: 320, easing: 'cubic-bezier(0.55, 0, 0.8, 0.2)', fill: 'forwards' }
  )
  return anim.finished.then(
    () => ghost.remove(),
    () => ghost.remove()
  )
}

/**
 * The DeepStack mark: a solid, wide arrowhead drilling down into slanted layers that narrow,
 * thin and fade with depth. Drawn in currentColor. Keep in sync with public/favicon.svg and
 * public/icon-512.png (and bump ?v= in index.html).
 */
function StackMark() {
  return (
    <svg className="stack-mark" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3.6 4.6 12 9 20.4 4.6V6.6L12 11 3.6 6.6Z" fill="currentColor" strokeWidth="1.5" />
      <path d="M6.2 14.6 12 17.6 17.8 14.6" strokeWidth="2" opacity=".6" />
      <path d="M8.8 19.6 12 21.2 15.2 19.6" strokeWidth="1.8" opacity=".3" />
    </svg>
  )
}

function Zone({ id, className, bounce, children }: { id: string; className: string; bounce?: boolean; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id })
  const el = useRef<HTMLDivElement | null>(null)
  useEffect(() => (bounce && el.current ? attachBounce(el.current) : undefined), [bounce])
  return (
    <div
      ref={(node) => {
        el.current = node
        setNodeRef(node)
      }}
      className={`${className} ${isOver ? 'is-over' : ''}`}
    >
      {children}
    </div>
  )
}

const Chevron = ({ dir }: { dir: 'left' | 'right' }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={dir === 'left' ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'} />
  </svg>
)


/** The order after a move, exactly as the server's 'move' intent makes it (controller.ts). */
function movedOrder(sessions: SessionConfig[], id: string, inactive: boolean, index: number): SessionConfig[] {
  const s = sessions.find((x) => x.id === id)
  if (!s) return sessions
  const rest = sessions.filter((x) => x.id !== id)
  const group = rest.filter((x) => x.inactive === inactive)
  const others = rest.filter((x) => x.inactive !== inactive)
  group.splice(Math.max(0, Math.min(index, group.length)), 0, { ...s, inactive })
  return inactive ? [...others, ...group] : [...group, ...others]
}

const orderKey = (list: SessionConfig[]) => list.map((s) => `${s.id}${s.inactive ? '-' : '+'}`).join(',')

export function Sidebar({ state, theme, visual, collapsed, onToggle, onNew, onRequestClose }: Props) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  // A drop shows its new order straight away, so the released card glides to where it's going
  // rather than back to where it came from; the server's copy replaces it once it arrives.
  const [optimistic, setOptimistic] = useState<SessionConfig[] | null>(null)
  const serverKey = orderKey(state.sessions)
  useEffect(() => {
    if (optimistic && orderKey(optimistic) === serverKey) setOptimistic(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey])
  // Never stuck on a guess if the server didn't take the move.
  useEffect(() => {
    if (!optimistic) return
    const t = window.setTimeout(() => setOptimistic(null), 1500)
    return () => window.clearTimeout(t)
  }, [optimistic])
  const sessions = optimistic
    ? optimistic.map((o) => {
        const live = state.sessions.find((x) => x.id === o.id)
        return live ? { ...live, inactive: o.inactive } : o
      }).filter((o) => state.sessions.some((x) => x.id === o.id))
    : state.sessions
  const active = sessions.filter((s) => !s.inactive)
  const inactive = sessions.filter((s) => s.inactive)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overPark, setOverPark] = useState(false)
  // Dragging a parked session back: is it over the stack, and which slot will it land above?
  const [overStack, setOverStack] = useState(false)
  /** A slot id (land above it), 'end' (below the last one), or null. */
  const [dropBefore, setDropBefore] = useState<string | null>(null)
  const [arrived, setArrived] = useState<string | null>(null)
  const areaRef = useRef<HTMLDivElement | null>(null)
  const [origin, setOrigin] = useState('50% 50%')
  // Parked starts closed on every load: those sessions are out of the way until you ask.
  const [parkOpen, setParkOpen] = useState(false)
  const [ate, setAte] = useState<{ key: number; color: string | null }>({ key: 0, color: null })
  const dragged = dragId ? sessions.find((s) => s.id === dragId) : undefined
  const draggingFromStack = !!dragged && !dragged.inactive
  const draggingFromPark = !!dragged && dragged.inactive

  // The "back to the stack" frame covers the stack down to the + bar; that edge moves
  // (the drawer is open, the list can scroll), so track it for as long as the drag lasts.
  useEffect(() => {
    if (!draggingFromPark) return
    let raf = 0
    const tick = () => {
      const area = areaRef.current
      const head = area?.querySelector('.add-bar') ?? area?.querySelector('.park-head')
      if (area && head) {
        const h = head.getBoundingClientRect().top - area.getBoundingClientRect().top
        area.style.setProperty('--receive-h', `${Math.max(80, h - 14)}px`)
      }
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [draggingFromPark])


  // The last one left Parked: fold it away. (Dragging from the stack shows its own invite, and
  // clicking the heading still opens the empty drawer if you want to look.)
  const parkedCount = inactive.length
  useEffect(() => {
    if (parkedCount === 0) setParkOpen(false)
  }, [parkedCount])

  // A session joined the parked list (drop or ⌃⇧I): the bar pops and flashes its colour.
  const parkedIds = inactive.map((s) => s.id).join(',')
  const prevParked = useRef(new Set(inactive.map((s) => s.id)))
  useEffect(() => {
    const now = new Set(inactive.map((s) => s.id))
    const added = inactive.find((s) => !prevParked.current.has(s.id))
    prevParked.current = now
    if (added) setAte((a) => ({ key: a.key + 1, color: sessionColor(theme, added.color) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parkedIds])

  // Target is wherever the pointer is: inside the park bar/drawer means "park"; anywhere else is
  // a place in the stack (closest slot). Measured live, since the bar grows after the drag starts.
  const collision: CollisionDetection = (args) => {
    const pt = args.pointerCoordinates
    // The invite panel (while dragging from the stack), or the open parked part of the list.
    const zones = document.querySelectorAll<HTMLElement>('.park-invite.is-visible, .park-head, .park-items.is-open')
    const inPark = !!pt && [...zones].some((el) => within(el.getBoundingClientRect(), pt.x, pt.y))
    const ids = new Set((inPark ? inactive : active).map((s) => s.id))
    const pool = args.droppableContainers.filter((c) => ids.has(String(c.id)))
    if (inPark && (!parkOpen || pool.length === 0)) return [{ id: ZONE_PARKED }]
    if (!inPark && pool.length === 0) return [{ id: ZONE_ACTIVE }]
    // Back from Parked: aim by the pointer. It lands above the first slot whose middle is below
    // it; past the last slot's middle it goes to the bottom (the stack zone appends).
    if (!inPark && pt && draggingFromPark) {
      for (const s of active) {
        const r = document.querySelector(`.stack-list > [data-slot="${s.id}"]`)?.getBoundingClientRect()
        if (r && pt.y < r.top + r.height / 2) return [{ id: s.id }]
      }
      return [{ id: ZONE_ACTIVE }]
    }
    return closestCenter({ ...args, droppableContainers: pool })
  }

  const onDragStart = ({ active: a, activatorEvent }: DragStartEvent) => {
    setDragId(String(a.id))
    // Scale the lifted card around the point you grabbed, so it stays under the pointer.
    const r = a.rect.current.initial
    const e = activatorEvent as PointerEvent
    if (r && 'clientX' in e) setOrigin(`${e.clientX - r.left}px ${e.clientY - r.top}px`)
  }

  const onDragOver = ({ over }: DragOverEvent) => {
    const id = over ? String(over.id) : null
    setOverPark(id === ZONE_PARKED)
    const toStack = !!dragged?.inactive && !!id && (id === ZONE_ACTIVE || active.some((s) => s.id === id))
    setOverStack(toStack)
    setDropBefore(!toStack ? null : id === ZONE_ACTIVE ? (active.length ? 'end' : null) : id)
  }

  const endDrag = () => {
    setDragId(null)
    setOverPark(false)
    setOverStack(false)
    setDropBefore(null)
  }

  const onDragEnd = ({ active: drag, over }: DragEndEvent) => {
    endDrag()
    if (!over) return
    const id = String(drag.id)
    const overId = String(over.id)
    let toInactive: boolean
    let index: number
    if (overId === ZONE_ACTIVE || overId === ZONE_PARKED) {
      toInactive = overId === ZONE_PARKED
      index = (toInactive ? inactive : active).filter((s) => s.id !== id).length
    } else {
      const target = sessions.find((s) => s.id === overId)
      if (!target) return
      toInactive = target.inactive
      const list = toInactive ? inactive : active
      index = list.findIndex((s) => s.id === overId)
    }
    const s = sessions.find((x) => x.id === id)
    const move = () => {
      const next = movedOrder(sessions, id, toInactive, index)
      if (orderKey(next) === orderKey(sessions)) return
      setOptimistic(next)
      void stack.intent({ t: 'move', id, inactive: toInactive, index })
    }
    // Back out of Parked: it flashes in its colour where it lands.
    if (!toInactive && s?.inactive) {
      setArrived(id)
      window.setTimeout(() => setArrived((a) => (a === id ? null : a)), 1000)
    }
    // Parked into a closed drawer: it gets eaten by the bar, then moves.
    if (toInactive && s && !s.inactive && !parkOpen) void eatIntoPark(document.querySelector('.drag-card')).then(move)
    else move()
  }


  const slot = (s: SessionConfig) => (
    <Slot
      key={s.id}
      s={s}
      rt={state.runtime[s.id]}
      theme={theme}
      big={s.id === visual.bigId}
      landing={s.id === visual.landingId}
      dropBefore={s.id === dropBefore}
      dropAfter={dropBefore === 'end' && s.id === active[active.length - 1]?.id}
      arrived={s.id === arrived}
      onRequestClose={onRequestClose}
    />
  )

  if (collapsed) {
    // The drawer folded to a rail: one dot per session, still clickable.
    return (
      <aside className="sidebar is-collapsed">
        <div className="sidebar-drag">
          <button className="drawer-toggle" onClick={onToggle} title="Expand stack (⌃⇧B)" aria-label="Expand stack">
            <Chevron dir="right" />
          </button>
        </div>
        <div className="rail-list">
          {[...active, ...inactive].map((s, i) => {
            const phase = state.runtime[s.id]?.phase ?? 'dormant'
            return (
              <Fragment key={s.id}>
                {/* Parked sessions come after a thin divider. */}
                {i === active.length && i > 0 && <span className="rail-divider" aria-hidden />}
                <button
                  className={['rail-dot', `phase-${phase}`, s.id === visual.bigId ? 'is-active' : '', s.inactive ? 'is-inactive' : ''].join(' ')}
                  style={{ ['--c' as string]: sessionColor(theme, s.color) }}
                  onClick={() => void stack.intent({ t: 'activate', id: s.id })}
                  title={displayName(s)}
                  aria-label={displayName(s)}
                >
                  {state.runtime[s.id]?.unseen && <span className="rail-unseen" />}
                </button>
              </Fragment>
            )
          })}
          <button className="rail-add" onClick={onNew} title="New terminal in ~ (⌃⇧N)" aria-label="New terminal">
            +
          </button>
        </div>
      </aside>
    )
  }

  return (
    <aside className="sidebar" style={{ ['--slot-ms' as string]: `${visual.ms}ms` }}>
      <div className="sidebar-drag">
        <div className="stack-title">
          <StackMark />
          <span className="stack-wordmark">DeepStack</span>
        </div>
        <button className="drawer-toggle" onClick={onToggle} title="Collapse stack (⌃⇧B)" aria-label="Collapse stack">
          <Chevron dir="left" />
        </button>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={onDragStart}
        onDragCancel={endDrag}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
      >
        {/* One list in two parts: the stack, then "Parked" (greyscale) under its heading. */}
        <div className="stack-area" ref={areaRef} style={dragged ? { ['--drop-c' as string]: sessionColor(theme, dragged.color) } : undefined}>
          <Zone id={ZONE_ACTIVE} className="stack-list" bounce>
            <SortableContext items={active.map((s) => s.id)} strategy={verticalListSortingStrategy}>
              {active.map(slot)}
            </SortableContext>
            {/* Pinned just above the Parked heading, so it's always one click away and sits
                outside the stack's drop frame. */}
            <div className="add-bar">
              <button className="add-session" onClick={onNew} title="New terminal in ~ (⌃⇧N)" aria-label="New terminal">
                +
              </button>
            </div>
            <ParkSection
              parked={inactive}
              renderSlot={slot}
              open={parkOpen}
              onToggle={() => setParkOpen((v) => !v)}
              ateKey={ate.key}
              ateColor={ate.color}
            />
          </Zone>
          <ParkInvite visible={draggingFromStack} over={overPark} />
          <StackInvite visible={draggingFromPark} over={overStack} />
        </div>
        {/* Parking into a closed drawer runs its own "eat" animation instead of settling back. */}
        <DragOverlay dropAnimation={draggingFromStack && !parkOpen ? null : dropAnimation}>
          {dragged && <DragCard s={dragged} theme={theme} origin={origin} overPark={overPark && !dragged.inactive} overStack={overStack} />}
        </DragOverlay>
      </DndContext>
      <SidebarResizer />
    </aside>
  )
}
