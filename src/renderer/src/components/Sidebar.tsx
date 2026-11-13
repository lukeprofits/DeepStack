import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { AppState, SessionConfig, SessionRuntime, Theme } from '../../../shared/types'
import { sessionColor } from '../lib/theme'
import { displayName, stackPosition } from '../lib/session'
import { stack } from '../lib/port'
import { MiniCanvas } from './MiniCanvas'
import type { StageVisual } from './Stage'
import { ParkInvite, ParkSection, ZONE_PARKED } from './ParkDrawer'

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
const PARK_OPEN_KEY = 'deepstack.parkOpen'

interface SlotProps {
  onRequestClose: (id: string) => void
  s: SessionConfig
  rt: SessionRuntime | undefined
  theme: Theme
  big: boolean
  landing: boolean
}

/**
 * One place in the stack. While its session is the big terminal the slot keeps its space and
 * shows a marker dot; the Stage draws the line from that dot to the big terminal's border.
 */
function Slot({ s, rt, theme, big, landing, onRequestClose }: SlotProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: s.id })
  const phase = rt?.phase ?? 'dormant'
  const color = sessionColor(theme, s.color)
  const failed = phase === 'error' || phase === 'exited'

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      data-slot={s.id}
      className={['slot', big ? 'is-big' : '', landing ? 'is-landing' : '', isDragging ? 'is-dragging' : '', s.inactive ? 'is-parked' : ''].join(' ')}
      style={{
        ['--c' as string]: color,
        transform: CSS.Transform.toString(transform),
        transition
      }}
      onClick={() => void stack.intent({ t: 'activate', id: s.id })}
      title={displayName(s)}
    >
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
        {/* Depth in the stack; hovering opens it up to show the title. */}
        <div className="slot-badge">
          <span className="slot-badge-title">{displayName(s)}</span>
          <span className="slot-badge-n">{stackPosition(s)}</span>
        </div>
        <CloseArm name={displayName(s)} onArmedClick={() => onRequestClose(s.id)} />
      </div>
    </div>
  )
}

const RING_R = 12
const RING_LEN = 2 * Math.PI * RING_R

/**
 * Accident-proof close. The ✕ shows when its slot is hovered; hovering the ✕ itself draws a
 * ring around it (0.6s, CSS animation). Only once the ring closes does it turn red and accept a
 * click; an early click just flashes the ring. Never starts a drag or activates the slot.
 */
function CloseArm({ name, onArmedClick }: { name: string; onArmedClick: () => void }) {
  const [phase, setPhase] = useState<'idle' | 'arming' | 'armed'>('idle')
  const [nudge, setNudge] = useState(0)
  return (
    <button
      className={['close-arm', `is-${phase}`, nudge ? `nudge-${nudge % 2}` : ''].join(' ')}
      style={{ ['--ring-len' as string]: RING_LEN }}
      title={phase === 'armed' ? `Close ${name}` : 'Keep hovering to arm'}
      aria-label={`Close ${name}`}
      onPointerEnter={() => setPhase('arming')}
      onPointerLeave={() => setPhase('idle')}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        if (phase === 'armed') onArmedClick()
        else setNudge((n) => n + 1)
      }}
    >
      <svg viewBox="0 0 28 28" aria-hidden>
        <circle className="close-arm-track" cx="14" cy="14" r={RING_R} />
        <circle
          className="close-arm-ring"
          cx="14"
          cy="14"
          r={RING_R}
          onAnimationEnd={(e) => {
            if (e.animationName === 'close-arm-draw') setPhase((p) => (p === 'arming' ? 'armed' : p))
          }}
        />
        <path className="close-arm-x" d="M10.2 10.2l7.6 7.6M17.8 10.2l-7.6 7.6" />
      </svg>
    </button>
  )
}

/** The lifted copy that follows the pointer while a session is dragged. */
function DragCard({ s, theme, origin, overPark }: { s: SessionConfig; theme: Theme; origin: string; overPark: boolean }) {
  return (
    <div className={['drag-card', s.inactive ? 'is-parked' : '', overPark ? 'is-over-park' : ''].join(' ')} style={{ ['--c' as string]: sessionColor(theme, s.color), transformOrigin: origin }}>
      <div className="mini">
        <MiniCanvas id={s.id} foreground={theme.terminal.foreground} fontFamily={theme.ui.monoFont} useSnapshot={false} />
      </div>
      <div className="slot-badge">
        <span className="slot-badge-n">{stackPosition(s)}</span>
      </div>
    </div>
  )
}

function loadParkOpen(): boolean {
  try {
    return localStorage.getItem(PARK_OPEN_KEY) === '1'
  } catch {
    return false
  }
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

function Zone({ id, className, children }: { id: string; className: string; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id })
  return (
    <div ref={setNodeRef} className={`${className} ${isOver ? 'is-over' : ''}`}>
      {children}
    </div>
  )
}

const Chevron = ({ dir }: { dir: 'left' | 'right' }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={dir === 'left' ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'} />
  </svg>
)


export function Sidebar({ state, theme, visual, collapsed, onToggle, onNew, onRequestClose }: Props) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const active = state.sessions.filter((s) => !s.inactive)
  const inactive = state.sessions.filter((s) => s.inactive)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overPark, setOverPark] = useState(false)
  const [origin, setOrigin] = useState('50% 50%')
  const [parkOpen, setParkOpen] = useState(loadParkOpen)
  const [ate, setAte] = useState<{ key: number; color: string | null }>({ key: 0, color: null })
  const dragged = dragId ? state.sessions.find((s) => s.id === dragId) : undefined
  const draggingFromStack = !!dragged && !dragged.inactive

  useEffect(() => {
    try {
      localStorage.setItem(PARK_OPEN_KEY, parkOpen ? '1' : '0')
    } catch {
      /* private window: not remembered */
    }
  }, [parkOpen])

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
    return closestCenter({ ...args, droppableContainers: pool })
  }

  const onDragStart = ({ active: a, activatorEvent }: DragStartEvent) => {
    setDragId(String(a.id))
    // Scale the lifted card around the point you grabbed, so it stays under the pointer.
    const r = a.rect.current.initial
    const e = activatorEvent as PointerEvent
    if (r && 'clientX' in e) setOrigin(`${e.clientX - r.left}px ${e.clientY - r.top}px`)
  }

  const onDragEnd = ({ active: drag, over }: DragEndEvent) => {
    setDragId(null)
    setOverPark(false)
    if (!over) return
    const id = String(drag.id)
    const overId = String(over.id)
    let toInactive: boolean
    let index: number
    if (overId === ZONE_ACTIVE || overId === ZONE_PARKED) {
      toInactive = overId === ZONE_PARKED
      index = (toInactive ? inactive : active).filter((s) => s.id !== id).length
    } else {
      const target = state.sessions.find((s) => s.id === overId)
      if (!target) return
      toInactive = target.inactive
      const list = toInactive ? inactive : active
      index = list.findIndex((s) => s.id === overId)
    }
    const move = () => void stack.intent({ t: 'move', id, inactive: toInactive, index })
    const s = state.sessions.find((x) => x.id === id)
    // Parked into a closed drawer: it gets eaten by the bar, then moves.
    if (toInactive && s && !s.inactive && !parkOpen) void eatIntoPark(document.querySelector('.drag-card')).then(move)
    else move()
  }

  const countTitle = `${active.length} in the stack${inactive.length ? ` · ${inactive.length} parked` : ''}`

  const slot = (s: SessionConfig) => (
    <Slot
      key={s.id}
      s={s}
      rt={state.runtime[s.id]}
      theme={theme}
      big={s.id === visual.bigId}
      landing={s.id === visual.landingId}
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
        <div className="stack-title" title={countTitle}>
          <StackMark />
          <span className="stack-wordmark">DeepStack</span>
          <span className="stack-count">{active.length}</span>
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
        onDragCancel={() => {
          setDragId(null)
          setOverPark(false)
        }}
        onDragOver={({ over }: DragOverEvent) => setOverPark(over?.id === ZONE_PARKED)}
        onDragEnd={onDragEnd}
      >
        {/* One list in two parts: the stack, then "Parked" (greyscale) under its heading. */}
        <div className="stack-area">
          <Zone id={ZONE_ACTIVE} className="stack-list">
            <SortableContext items={active.map((s) => s.id)} strategy={verticalListSortingStrategy}>
              {active.map(slot)}
            </SortableContext>
            <button className="add-session" onClick={onNew} title="New terminal in ~ (⌃⇧N)" aria-label="New terminal">
              +
            </button>
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
        </div>
        {/* Parking into a closed drawer runs its own "eat" animation instead of settling back. */}
        <DragOverlay dropAnimation={draggingFromStack && !parkOpen ? null : undefined}>
          {dragged && <DragCard s={dragged} theme={theme} origin={origin} overPark={overPark && !dragged.inactive} />}
        </DragOverlay>
      </DndContext>
    </aside>
  )
}
