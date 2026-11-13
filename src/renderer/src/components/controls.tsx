import { useState, type ReactNode } from 'react'

/** Small, consistently styled controls for Settings and dialogs. */

export function Card({ title, children, tone }: { title?: string; children: ReactNode; tone?: 'danger' }) {
  return (
    <section className={['sx-card', tone === 'danger' ? 'is-danger' : ''].join(' ')}>
      {title && <h3 className="sx-card-title">{title}</h3>}
      {children}
    </section>
  )
}

/** A label + description on the left, its control on the right. */
export function SettingRow({ label, desc, children, disabled }: { label: ReactNode; desc?: ReactNode; children?: ReactNode; disabled?: boolean }) {
  return (
    <div className={['sx-row', disabled ? 'is-disabled' : ''].join(' ')}>
      <div className="sx-row-text">
        <div className="sx-row-label">{label}</div>
        {desc && <div className="sx-row-desc">{desc}</div>}
      </div>
      {children && <div className="sx-row-control">{children}</div>}
    </div>
  )
}

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={['sx-toggle', checked ? 'is-on' : ''].join(' ')}
      onClick={() => onChange(!checked)}
    >
      <span className="sx-toggle-knob" />
    </button>
  )
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="sx-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'is-on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Slider({ value, min, max, step, onChange, format, label }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; format: (v: number) => string; label: string }) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div className="sx-slider">
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ ['--pct' as string]: `${pct}%` }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="sx-slider-value">{format(value)}</span>
    </div>
  )
}

export function Stepper({ value, min, max, step, onChange, label }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; label: string }) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v))
  // Typed digits are a draft until blur/Enter, so "5" on the way to "5000" isn't clamped to the minimum.
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const n = Number(draft)
    if (draft !== '' && !Number.isNaN(n)) onChange(clamp(n))
    setDraft(null)
  }
  return (
    <div className="sx-stepper" aria-label={label}>
      <button type="button" aria-label="Less" disabled={value <= min} onClick={() => onChange(clamp(value - step))}>
        −
      </button>
      <input
        inputMode="numeric"
        value={draft ?? String(value)}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      <button type="button" aria-label="More" disabled={value >= max} onClick={() => onChange(clamp(value + step))}>
        +
      </button>
    </div>
  )
}

export const XIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
)
