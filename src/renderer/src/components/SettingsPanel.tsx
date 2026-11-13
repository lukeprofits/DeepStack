import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SESSION_COLORS } from '../../../shared/palette'
import { BUILT_IN_THEMES, findTheme } from '../../../shared/themes'
import type { AppState, SessionConfig, Settings, Theme } from '../../../shared/types'
import { displayName, stackPosition } from '../lib/session'
import { stack } from '../lib/port'
import { ConfirmDialog } from './ConfirmDialog'
import { Card, Segmented, SettingRow, Slider, Stepper, Toggle, XIcon } from './controls'

interface Props {
  state: AppState
  onClose: () => void
}

type Section = 'switch' | 'replies' | 'terminal' | 'session' | 'appearance' | 'system'

const set = (settings: Partial<Settings>) => void stack.intent({ t: 'setSettings', settings })

function isTheme(v: unknown): v is Theme {
  const t = v as Theme
  return !!t && typeof t === 'object' && typeof t.name === 'string' && !!t.ui && !!t.terminal
}

function downloadJson(json: string, name: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${name}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function pickJsonFile(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      void file.text().then(resolve)
    }
    input.click()
  })
}

function programLabel(s: SessionConfig): string {
  const p = s.program
  if (!p) return 'shell'
  if (p.kind === 'claude') return p.sid ? `claude (session ${p.sid.slice(0, 8)}…)` : 'claude'
  return p.command
}

// ------------------------------------------------------------------ icons

const ico = (d: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d}
  </svg>
)
const ICONS: Record<Section, ReactNode> = {
  switch: ico(<path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3" />),
  replies: ico(<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5Z" />),
  terminal: ico(<><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4" /></>),
  session: ico(<><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="3" /></>),
  appearance: ico(<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.9 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8h2.2a4.2 4.2 0 0 0 4.2-4.2C21 6.9 17 3.5 12 3.5ZM7.5 12.5h0M9.5 8h0M14.5 8h0" />),
  system: ico(<><rect x="4" y="4" width="16" height="6.5" rx="2" /><rect x="4" y="13.5" width="16" height="6.5" rx="2" /><path d="M8 7.25h0M8 16.75h0" /></>)
}

const SECTIONS: { id: Section; label: string; title: string; desc: string }[] = [
  { id: 'switch', label: 'Auto-switch', title: 'Auto-switch', desc: 'Where the big terminal goes after you send a prompt.' },
  { id: 'replies', label: 'Quick replies', title: 'Quick replies', desc: 'One-tap prompts along the bottom bar, and how queued bubbles behave.' },
  { id: 'terminal', label: 'Terminal', title: 'Terminal', desc: 'Scrollback and how DeepStack opens.' },
  { id: 'session', label: 'This session', title: 'This session', desc: 'Name, colour and restore command for the session on the big terminal.' },
  { id: 'appearance', label: 'Appearance', title: 'Appearance', desc: 'Themes for the whole app and its terminals.' },
  { id: 'system', label: 'System', title: 'System', desc: 'Claude integration and the DeepStack server.' }
]

// ------------------------------------------------------------------ sections

const MODE_TEXT: Record<Settings['advanceMode'], string> = {
  priority: 'Jumps to the topmost session that’s ready. Order your stack by importance.',
  sequential: 'Moves to the next ready session below the current one, wrapping around.',
  off: 'Stays put after you send. Switch yourself with a click or ⌃⇧↑/↓.'
}

function AutoSwitch({ settings }: { settings: Settings }) {
  return (
    <>
      <Card>
        <SettingRow label="After you send" desc={MODE_TEXT[settings.advanceMode]}>
          <Segmented
            label="Auto-switch mode"
            value={settings.advanceMode}
            onChange={(v) => set({ advanceMode: v })}
            options={[
              { value: 'priority', label: 'Priority' },
              { value: 'sequential', label: 'Sequential' },
              { value: 'off', label: 'Off' }
            ]}
          />
        </SettingRow>
        <SettingRow label="Send-off window" desc="Time to press Space and stay before it switches.">
          <Slider label="Send-off window" min={0} max={3000} step={100} value={settings.sendOffMs} onChange={(v) => set({ sendOffMs: v })} format={(v) => `${(v / 1000).toFixed(1)} s`} />
        </SettingRow>
      </Card>
      <Card>
        <SettingRow label="Needs-you first" desc="Sessions waiting on a permission prompt jump the queue.">
          <Toggle label="Needs-you first" checked={settings.attentionFirst} onChange={(v) => set({ attentionFirst: v })} />
        </SettingRow>
        <SettingRow
          label="Snap to higher sessions"
          desc="Jump the moment a session above finishes or needs you, even mid-typing. Your text stays in that terminal."
          disabled={settings.advanceMode !== 'priority'}
        >
          <Toggle label="Snap to higher sessions" checked={settings.snapToHigher} disabled={settings.advanceMode !== 'priority'} onChange={(v) => set({ snapToHigher: v })} />
        </SettingRow>
      </Card>
    </>
  )
}

/** A quick reply ending in a space loads into the input instead of sending (existing storage format). */
function QuickReplies({ settings }: { settings: Settings }) {
  const [rows, setRows] = useState(() => settings.pills.map((p) => ({ text: p.trimEnd(), loads: p.endsWith(' ') })))
  const save = (next: typeof rows) => {
    setRows(next)
    set({ pills: next.filter((r) => r.text.trim()).map((r) => r.text.trim() + (r.loads ? ' ' : '')) })
  }
  return (
    <>
      <Card title="Buttons">
        <div className="sx-replies">
          {rows.map((r, i) => (
            <div className="sx-reply" key={i}>
              <input
                className="sx-input"
                value={r.text}
                placeholder="e.g. run the tests"
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                onBlur={() => save(rows)}
              />
              <Segmented
                label="When tapped"
                value={r.loads ? 'load' : 'send'}
                onChange={(v) => save(rows.map((x, j) => (j === i ? { ...x, loads: v === 'load' } : x)))}
                options={[
                  { value: 'send', label: 'Sends ↵' },
                  { value: 'load', label: 'Loads ✎' }
                ]}
              />
              <button className="sx-icon-btn" aria-label={`Remove ${r.text}`} onClick={() => save(rows.filter((_, j) => j !== i))}>
                <XIcon size={13} />
              </button>
            </div>
          ))}
          <button className="sx-add" onClick={() => setRows([...rows, { text: '', loads: false }])}>
            + Add quick reply
          </button>
        </div>
        <p className="sx-note">Sends types it and presses Enter. Loads puts it in the input for you to finish, like “do deep research on …”.</p>
      </Card>
      <Card>
        <SettingRow label="Clicking a queued bubble" desc="Bubbles are follow-ups you queued while holding.">
          <Segmented
            label="Bubble click"
            value={settings.bubbleClick}
            onChange={(v) => set({ bubbleClick: v })}
            options={[
              { value: 'load', label: 'Load into input' },
              { value: 'send', label: 'Send now' }
            ]}
          />
        </SettingRow>
      </Card>
    </>
  )
}

function TerminalSection({ settings }: { settings: Settings }) {
  return (
    <Card>
      <SettingRow label="Live scrollback" desc="Lines kept in memory per terminal. Older output still loads when you scroll to the top.">
        <Stepper label="Live scrollback lines" min={200} max={10000} step={500} value={settings.scrollback} onChange={(v) => set({ scrollback: v })} />
      </SettingRow>
      <SettingRow label="Launch standalone" desc="Open in its own window instead of a browser tab. Takes effect next start.">
        <Toggle label="Launch standalone" checked={settings.standalone} onChange={(v) => set({ standalone: v })} />
      </SettingRow>
    </Card>
  )
}

function SessionSection({ state }: { state: AppState }) {
  const s = state.sessions.find((x) => x.id === state.activeId)
  if (!s) return <p className="sx-empty">No session is on the big terminal.</p>
  return (
    <>
      <div className="sx-session-chip" style={{ ['--c' as string]: s.color }}>
        <span className="sx-session-n">{stackPosition(s)}</span>
        <span className="sx-session-title">{displayName(s)}</span>
      </div>
      <Card>
        <SettingRow label="Name" desc="Leave blank to use Claude’s title, or “Session N”.">
          <input className="sx-input" defaultValue={s.name ?? ''} placeholder={displayName({ ...s, name: undefined })} onBlur={(e) => void stack.intent({ t: 'rename', id: s.id, name: e.target.value })} />
        </SettingRow>
        <div className="sx-row sx-row-stack">
          <div className="sx-row-text">
            <div className="sx-row-label">Colour</div>
            <div className="sx-row-desc">Its border, line and number everywhere.</div>
          </div>
          <div className="sx-swatches">
            {SESSION_COLORS.map((c) => (
              <button key={c} className={['sx-swatch', c === s.color ? 'is-on' : ''].join(' ')} style={{ ['--c' as string]: c }} aria-label={c} onClick={() => void stack.intent({ t: 'setColor', id: s.id, color: c })} />
            ))}
            <label className="sx-swatch sx-swatch-custom" title="Custom colour">
              <input type="color" value={s.color} onChange={(e) => void stack.intent({ t: 'setColor', id: s.id, color: e.target.value })} />
            </label>
          </div>
        </div>
      </Card>
      <Card>
        <SettingRow label="Folder">
          <code className="sx-code">{s.cwd}</code>
        </SettingRow>
        <SettingRow label="Running">
          <code className="sx-code">{programLabel(s)}</code>
        </SettingRow>
        <SettingRow label="Resume command" desc="Run in this folder on restore instead of the automatic one, e.g. grok --resume.">
          <input
            className="sx-input sx-mono"
            defaultValue={s.resumeOverride ?? ''}
            spellCheck={false}
            placeholder="automatic"
            onBlur={(e) => void stack.intent({ t: 'setResumeOverride', id: s.id, command: e.target.value })}
          />
        </SettingRow>
      </Card>
    </>
  )
}

const UI_KEYS: (keyof Theme['ui'])[] = ['bg', 'sidebar', 'panel', 'border', 'text', 'muted', 'accent', 'bubble', 'bubbleText', 'pill', 'pillText']

function ThemePreview({ t }: { t: Theme }) {
  return (
    <span className="sx-theme-preview" style={{ background: t.terminal.background, borderColor: t.ui.border }}>
      <i style={{ background: t.terminal.foreground, width: '62%' }} />
      <i style={{ background: t.terminal.green, width: '40%' }} />
      <i style={{ background: t.terminal.blue, width: '74%' }} />
      <b style={{ background: t.ui.accent }} />
    </span>
  )
}

function Appearance({ state }: { state: AppState }) {
  const current = findTheme(state.settings.themeId, state.customThemes)
  const all = useMemo(() => [...BUILT_IN_THEMES, ...state.customThemes], [state.customThemes])
  const [json, setJson] = useState<string | null>(null)
  const [error, setError] = useState('')

  const save = (t: Theme) => void stack.intent({ t: 'saveTheme', theme: t })
  const duplicate = (t: Theme) => {
    const copy: Theme = { ...structuredClone(t), id: `custom-${Date.now()}`, name: `${t.name} copy`, builtIn: false }
    save(copy)
    set({ themeId: copy.id })
  }
  const importTheme = async () => {
    const text = await pickJsonFile()
    if (!text) return
    try {
      const t = JSON.parse(text)
      if (!isTheme(t)) throw new Error('not a theme')
      const imported = { ...t, id: `custom-${Date.now()}`, builtIn: false }
      save(imported)
      set({ themeId: imported.id })
    } catch (e) {
      setError(`Import failed: ${(e as Error).message}`)
    }
  }

  return (
    <>
      <div className="sx-themes">
        {all.map((t) => (
          <button key={t.id} className={['sx-theme', t.id === current.id ? 'is-on' : ''].join(' ')} onClick={() => set({ themeId: t.id })}>
            <ThemePreview t={t} />
            <span className="sx-theme-name">{t.name}</span>
          </button>
        ))}
      </div>
      <div className="sx-actions">
        <button className="sx-btn" onClick={() => duplicate(current)}>
          Duplicate
        </button>
        <button className="sx-btn" onClick={() => downloadJson(JSON.stringify(current, null, 2), current.name)}>
          Export
        </button>
        <button className="sx-btn" onClick={() => void importTheme()}>
          Import
        </button>
        {!current.builtIn && (
          <button className="sx-btn is-danger" onClick={() => void stack.intent({ t: 'deleteTheme', id: current.id })}>
            Delete
          </button>
        )}
      </div>

      {current.builtIn ? (
        <p className="sx-note">Built-in themes are read-only. Duplicate one to customise it.</p>
      ) : (
        <Card title="Edit theme">
          <SettingRow label="Name">
            <input className="sx-input" value={current.name} onChange={(e) => save({ ...current, name: e.target.value })} />
          </SettingRow>
          <div className="sx-colors">
            {UI_KEYS.map((k) => (
              <label key={k} className="sx-color">
                <input type="color" value={String(current.ui[k]).slice(0, 7)} onChange={(e) => save({ ...current, ui: { ...current.ui, [k]: e.target.value } })} />
                <span>{k}</span>
              </label>
            ))}
            <label className="sx-color">
              <input type="color" value={current.terminal.background} onChange={(e) => save({ ...current, terminal: { ...current.terminal, background: e.target.value } })} />
              <span>terminal bg</span>
            </label>
            <label className="sx-color">
              <input type="color" value={current.terminal.foreground} onChange={(e) => save({ ...current, terminal: { ...current.terminal, foreground: e.target.value } })} />
              <span>terminal fg</span>
            </label>
          </div>
          <SettingRow label="One border colour for every session" desc="Use the accent instead of each session’s own colour.">
            <Toggle
              label="One border colour"
              checked={!!current.sessionColorOverride}
              onChange={(v) => save({ ...current, sessionColorOverride: v ? current.ui.accent : undefined })}
            />
          </SettingRow>
          <button className="sx-btn" onClick={() => setJson(json === null ? JSON.stringify(current, null, 2) : null)}>
            {json === null ? 'Edit JSON…' : 'Hide JSON'}
          </button>
          {json !== null && (
            <>
              <textarea className="sx-input sx-json" rows={14} value={json} spellCheck={false} onChange={(e) => setJson(e.target.value)} />
              <button
                className="sx-btn is-primary"
                onClick={() => {
                  try {
                    const t = JSON.parse(json)
                    if (!isTheme(t)) throw new Error('missing name/ui/terminal')
                    save({ ...t, id: current.id })
                    setError('')
                  } catch (e) {
                    setError((e as Error).message)
                  }
                }}
              >
                Apply JSON
              </button>
            </>
          )}
        </Card>
      )}
      {error && <p className="sx-error">{error}</p>}
    </>
  )
}

function System({ state, onQuit }: { state: AppState; onQuit: () => void }) {
  const installed = state.hooks.installed
  return (
    <>
      <Card>
        <SettingRow
          label={
            <>
              Claude hooks <span className={['sx-pill', installed ? 'is-ok' : ''].join(' ')}>{installed ? 'Installed' : 'Not installed'}</span>
            </>
          }
          desc={
            installed
              ? 'In ~/.claude/settings.json, for “needs you” and busy detection. They do nothing outside DeepStack.'
              : '“Needs you” detection only works for Claude sessions DeepStack resumed itself.'
          }
        >
          <button className="sx-btn" onClick={() => void stack.intent({ t: installed ? 'removeHooks' : 'installHooks' })}>
            {installed ? 'Remove' : 'Install'}
          </button>
        </SettingRow>
      </Card>
      <Card tone="danger">
        <SettingRow label="Quit DeepStack" desc="Terminals keep running when this tab closes. Quitting ends every session; they resume next start.">
          <button className="sx-btn is-danger" onClick={onQuit}>
            Quit
          </button>
        </SettingRow>
      </Card>
    </>
  )
}

// ------------------------------------------------------------------ panel

export function SettingsPanel({ state, onClose }: Props) {
  const [section, setSection] = useState<Section>('switch')
  const [confirmQuit, setConfirmQuit] = useState(false)
  const meta = SECTIONS.find((s) => s.id === section)!
  const panelRef = useRef<HTMLDivElement>(null)

  // Take focus from the terminal so typing here never reaches it.
  useEffect(() => panelRef.current?.focus(), [])

  // Capture phase: a focused xterm swallows Escape before it would bubble to window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || confirmQuit) return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, confirmQuit])

  return (
    <div className="sx-backdrop" onMouseDown={onClose}>
      <div ref={panelRef} tabIndex={-1} className="sx-panel" role="dialog" aria-modal="true" aria-label="Settings" onMouseDown={(e) => e.stopPropagation()}>
        <nav className="sx-nav">
          <div className="sx-nav-title">Settings</div>
          {SECTIONS.map((s) => (
            <button key={s.id} className={['sx-nav-item', s.id === section ? 'is-on' : ''].join(' ')} onClick={() => setSection(s.id)}>
              {ICONS[s.id]}
              {s.label}
            </button>
          ))}
          <div className="sx-nav-foot">Changes save automatically.</div>
        </nav>
        <div className="sx-main">
          <header className="sx-head">
            <div>
              <h2 className="sx-title">{meta.title}</h2>
              <p className="sx-desc">{meta.desc}</p>
            </div>
            <button className="sx-close" onClick={onClose} aria-label="Close settings" title="Close (Esc)">
              <XIcon size={15} />
            </button>
          </header>
          <div className="sx-scroll" key={section}>
            {section === 'switch' && <AutoSwitch settings={state.settings} />}
            {section === 'replies' && <QuickReplies settings={state.settings} />}
            {section === 'terminal' && <TerminalSection settings={state.settings} />}
            {section === 'session' && <SessionSection key={state.activeId} state={state} />}
            {section === 'appearance' && <Appearance state={state} />}
            {section === 'system' && <System state={state} onQuit={() => setConfirmQuit(true)} />}
          </div>
        </div>
      </div>
      {confirmQuit && (
        <div onMouseDown={(e) => e.stopPropagation()}>
          <ConfirmDialog
            title="Quit DeepStack?"
            body="Every terminal ends now. Claude sessions resume the next time you start DeepStack; plain shells start fresh."
            confirmLabel="Quit DeepStack"
            onCancel={() => setConfirmQuit(false)}
            onConfirm={() => void stack.intent({ t: 'quitServer' })}
          />
        </div>
      )}
    </div>
  )
}
