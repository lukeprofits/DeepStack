import type { ReactNode } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type { SessionConfig } from '../../../shared/types'

export const ZONE_PARKED = 'zone:inactive'

export const ParkIcon = () => (
  <svg className="park-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {/* A tray: things set down, not thrown away. */}
    <path d="M4 13.5 6.2 6.6A2 2 0 0 1 8.1 5.2h7.8a2 2 0 0 1 1.9 1.4L20 13.5" />
    <path d="M4 13.5V17a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3.5h-4.2a1 1 0 0 0-.9.6l-.5 1a1 1 0 0 1-.9.6h-3a1 1 0 0 1-.9-.6l-.5-1a1 1 0 0 0-.9-.6Z" />
  </svg>
)

const Chevron = ({ open }: { open: boolean }) => (
  <svg className="park-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={open ? 'M6 9l6 6 6-6' : 'M6 15l6-6 6 6'} />
  </svg>
)

interface SectionProps {
  parked: SessionConfig[]
  renderSlot: (s: SessionConfig) => ReactNode
  open: boolean
  onToggle: () => void
  /** Bumps when a session is parked; replays the count pop. */
  ateKey: number
  ateColor: string | null
}

/**
 * The second part of the one stack list: a "Parked" heading (pinned to the bottom of the list
 * while it's scrolled out of view, so it's always reachable) and, when open, the parked
 * sessions under it, greyscale. Closed, it's just the heading with its count.
 */
export function ParkSection({ parked, renderSlot, open, onToggle, ateKey, ateColor }: SectionProps) {
  const { setNodeRef } = useDroppable({ id: ZONE_PARKED })
  const n = parked.length
  return (
    <>
      <button
        key={ateKey}
        className={['park-head', open ? 'is-open' : '', ateKey ? 'is-ate' : ''].join(' ')}
        style={{ ['--ate' as string]: ateColor ?? 'var(--accent)' }}
        onClick={onToggle}
        aria-expanded={open}
        title={open ? 'Hide parked sessions' : 'Show parked sessions'}
      >
        <ParkIcon />
        <span className="park-title">Parked</span>
        <span className={['park-count', n ? '' : 'is-empty'].join(' ')}>{n || 'none'}</span>
        <Chevron open={open} />
      </button>
      <div ref={setNodeRef} className={['park-items', open ? 'is-open' : ''].join(' ')} inert={!open}>
        <div className="park-items-inner">
          <div className="park-list">
            <SortableContext items={parked.map((s) => s.id)} strategy={verticalListSortingStrategy}>
              {parked.map(renderSlot)}
            </SortableContext>
            {n === 0 && <div className="park-empty">Nothing parked. Drag a session down here to set it aside; it keeps running.</div>}
          </div>
        </div>
      </div>
    </>
  )
}

/**
 * While a stack session is dragged, the bottom of the sidebar leans up and offers to take it.
 * Purely an overlay (nothing in the list reflows mid-drag); gone again on release.
 */
export function ParkInvite({ visible, over }: { visible: boolean; over: boolean }) {
  return (
    <div className={['park-invite', visible ? 'is-visible' : '', over ? 'is-over' : ''].join(' ')} aria-hidden={!visible}>
      <ParkIcon />
      <div className="park-invite-copy">
        <div className="park-invite-title">{over ? 'Release to park it' : 'Want to park that one?'}</div>
        <div className="park-invite-sub">It keeps running. Auto-switch skips it.</div>
      </div>
    </div>
  )
}
