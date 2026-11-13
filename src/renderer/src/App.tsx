import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isEligible } from '../../shared/advance'
import { findTheme } from '../../shared/themes'
import type { AppState, QueueItem } from '../../shared/types'
import { BottomBar, type ComposerMode } from './components/BottomBar'
import { ConfirmDialog } from './components/ConfirmDialog'
import { SettingsPanel } from './components/SettingsPanel'
import { GearIcon } from './components/icons'
import { Sidebar } from './components/Sidebar'
import { focusMainTerminal, Stage, type Preview, type StageVisual } from './components/Stage'
import { stack } from './lib/port'
import { displayName, homeDir, setHome, setStackOrder, stackPosition } from './lib/session'
import { applyTheme, sessionColor } from './lib/theme'

/** Keystrokes are dropped this long after an automatic switch so typing can't spill over. */
const SWITCH_GUARD_MS = 300

type Conn = 'connecting' | 'open' | 'closed' | 'denied' | 'bye'

/**
 * Shortcuts are Ctrl+Shift based: in a browser tab, ⌘W/⌘N/⌘1-9 belong to the browser, and
 * plain Ctrl/Option combos belong to the shell and Claude.
 */
function shortcut(e: KeyboardEvent): string | null {
  if (!e.ctrlKey || !e.shiftKey || e.metaKey || e.altKey) return null
  if (/^Digit[1-9]$/.test(e.code)) return `focus:${Number(e.code.slice(5)) - 1}`
  const map: Record<string, string> = {
    KeyN: 'new',
    KeyW: 'close',
    KeyR: 'relaunch',
    KeyJ: 'advance',
    KeyI: 'toggleInactive',
    ArrowUp: 'prev',
    ArrowDown: 'next',
    Comma: 'settings',
    KeyB: 'toggleSidebar'
  }
  return map[e.code] ?? null
}

const COLLAPSED_KEY = 'stack.sidebarCollapsed'

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function tildePath(p: string): string {
  const home = homeDir()
  return home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p
}

export function App() {
  const [collapsed, setCollapsed] = useState(loadCollapsed)
  const [state, setState] = useState<AppState | null>(null)
  const [conn, setConn] = useState<Conn>('connecting')
  const [showSettings, setShowSettings] = useState(false)
  const [confirmClose, setConfirmClose] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [visual, setVisual] = useState<StageVisual>({ bigId: null, landingId: null, ms: 480 })
  const [composerMode, setComposerMode] = useState<ComposerMode>(null)
  const [composerText, setComposerText] = useState('')
  const [inputBlockedUntil, setInputBlockedUntil] = useState(0)
  const previewRef = useRef(preview)
  previewRef.current = preview
  const stateRef = useRef(state)
  stateRef.current = state
  const composerRef = useRef({ mode: composerMode, text: composerText, sessionId: null as string | null })
  composerRef.current = { ...composerRef.current, mode: composerMode, text: composerText }

  useEffect(() => {
    const offState = stack.onState((s) => {
      setHome(s.home)
      setStackOrder(s.sessions)
      setState(s)
    })
    const offConn = stack.onConnection((c) => setConn(c))
    return () => {
      offState()
      offConn()
    }
  }, [])

  const theme = useMemo(() => (state ? findTheme(state.settings.themeId, state.customThemes) : null), [state?.settings.themeId, state?.customThemes])
  useEffect(() => {
    if (theme) applyTheme(theme)
  }, [theme])

  const activeId = state?.activeId ?? null
  const active = state?.sessions.find((s) => s.id === activeId)
  const activeRt = activeId ? state?.runtime[activeId] : undefined

  useEffect(() => {
    document.title = active ? `${displayName(active)} · Stack` : 'Stack'
  }, [active?.name, active?.autoName, active?.cwd, activeId])

  // ---- send-off: the server picked where to go next and will switch after `ms` unless the
  // human presses Space. The animation itself is the window to cancel in.
  useEffect(() => {
    return stack.onSendOff(({ id, target, ms }) => {
      const st = stateRef.current
      if (!st || st.activeId !== id || st.hold || !target) return
      setPreview({ from: id, to: target, ms })
    })
  }, [])

  // Focus moved: a preview that landed is done, and keystrokes are briefly dropped after any
  // switch we didn't click ourselves (advance, snap) so typing can't spill into the new one.
  const prevActive = useRef(activeId)
  useEffect(() => {
    const p = previewRef.current
    if (p && activeId === p.to) setPreview(null)
    else if (p && activeId !== p.from) setPreview(null)
    if (prevActive.current && activeId !== prevActive.current) setInputBlockedUntil(Date.now() + SWITCH_GUARD_MS)
    prevActive.current = activeId
  }, [activeId])

  // A half-typed hold draft becomes a bubble on the session it was written for.
  useEffect(() => {
    const c = composerRef.current
    if (c.mode === 'hold') {
      if (c.text.trim() && c.sessionId && c.sessionId !== activeId) void stack.deliver({ t: 'deliver', id: c.sessionId, text: c.text, mode: 'enqueue' })
      setComposerMode(null)
      setComposerText('')
    }
  }, [activeId])

  useEffect(() => {
    if (state && !state.hold && composerMode === 'hold') setComposerMode(null)
  }, [state?.hold])

  const enterHold = useCallback(() => {
    setPreview(null)
    void stack.intent({ t: 'setHold', hold: true })
    composerRef.current.sessionId = stateRef.current?.activeId ?? null
    setComposerText('')
    setComposerMode('hold')
  }, [])

  const runCommand = useCallback((name: string) => {
    const st = stateRef.current
    if (!st) return
    const list = st.sessions.filter((s) => !s.inactive)
    const idx = list.findIndex((s) => s.id === st.activeId)
    const go = (id: string | undefined) => id && void stack.intent({ t: 'activate', id })
    if (name === 'new') void stack.intent({ t: 'create' })
    else if (name === 'settings') setShowSettings((v) => !v)
    else if (name === 'toggleSidebar') setCollapsed((v) => !v)
    else if (name === 'close' && st.activeId) setConfirmClose(st.activeId)
    else if (name === 'relaunch' && st.activeId) void stack.intent({ t: 'relaunch', id: st.activeId })
    else if (name === 'advance') {
      setComposerMode(null)
      void stack.intent({ t: 'advance' })
    } else if (name === 'prev') go(list[(idx - 1 + list.length) % list.length]?.id)
    else if (name === 'next') go(list[(idx + 1) % list.length]?.id)
    else if (name === 'toggleInactive' && st.activeId) {
      const s = st.sessions.find((x) => x.id === st.activeId)
      if (s) void stack.intent({ t: 'move', id: s.id, inactive: !s.inactive, index: s.inactive ? list.length : 0 })
    } else if (name.startsWith('focus:')) go(list[Number(name.slice(6))]?.id)
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
    } catch {
      /* storage unavailable: the drawer just won't remember */
    }
  }, [collapsed])

  // One capture-phase handler for every key the app (not the terminal) owns.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const cmd = shortcut(e)
      if (cmd) {
        e.preventDefault()
        e.stopPropagation()
        runCommand(cmd)
        return
      }
      if (previewRef.current && e.key === ' ' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        e.stopPropagation()
        enterHold()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [runCommand, enterHold])

  const onFocusTerminal = useCallback(() => {
    if (stateRef.current?.hold) void stack.intent({ t: 'setHold', hold: false })
    setComposerMode((m) => (m === 'hold' ? null : m))
  }, [])

  const colorOf = useCallback(
    (id: string) => {
      const s = stateRef.current?.sessions.find((x) => x.id === id)
      return s && theme ? sessionColor(theme, s.color) : 'transparent'
    },
    [theme]
  )

  // ---- text delivery
  const deliver = useCallback(async (text: string, mode: 'send' | 'load' | 'enqueue', itemId?: string) => {
    const id = stateRef.current?.activeId
    if (!id) return
    const r = await stack.deliver({ t: 'deliver', id, text, mode, itemId })
    if (r?.loadIntoComposer) {
      composerRef.current.sessionId = id
      setComposerText(r.loadIntoComposer)
      setComposerMode('edit')
    } else if (mode !== 'enqueue') focusMainTerminal()
  }, [])

  const onPill = (text: string) => void deliver(text, /[\s:]$/.test(text) ? 'load' : 'send')

  const onBubble = (q: QueueItem, alt: boolean) => {
    const pref = state?.settings.bubbleClick ?? 'load'
    void deliver(q.text, alt ? (pref === 'load' ? 'send' : 'load') : pref, q.id)
  }

  const onComposerSubmit = (text: string) => {
    if (composerMode === 'hold') {
      void deliver(text, 'enqueue')
      setComposerText('')
    } else {
      void deliver(text, 'send')
      setComposerText('')
      setComposerMode(null)
    }
  }

  const onComposerClose = () => {
    if (composerMode === 'hold') void stack.intent({ t: 'setHold', hold: false })
    setComposerMode(null)
    setComposerText('')
    focusMainTerminal()
  }

  if (conn === 'bye') return <div className="fullscreen-note">Stack has quit. Run <code>npm start</code> and this tab reconnects.</div>
  if (!state || !theme) {
    return (
      <div className="fullscreen-note">
        {conn === 'denied' && !stack.hasToken ? (
          <>
            This tab isn't authorized. Open Stack with <code>npm start</code>.
          </>
        ) : conn === 'denied' || conn === 'closed' ? (
          'Waiting for the Stack server…'
        ) : null}
      </div>
    )
  }

  const allBusy = !!activeId && !state.sessions.some((s) => s.id !== activeId && isEligible(s, state.runtime[s.id]))
  const phase = activeRt?.phase
  const closing = state.sessions.find((s) => s.id === confirmClose)
  const previewTarget = preview ? state.sessions.find((s) => s.id === preview.to) : undefined

  return (
    <div className={`app ${collapsed ? 'is-collapsed' : ''}`}>
      <Sidebar
        state={state}
        theme={theme}
        visual={visual}
        collapsed={collapsed}
        onToggle={() => setCollapsed((v) => !v)}
        onNew={() => runCommand('new')}
        onRequestClose={setConfirmClose}
      />

      <main className="main">
        <header className="header" style={{ ['--c' as string]: active ? sessionColor(theme, active.color) : 'transparent' }}>
          {active && <span className="header-badge">{stackPosition(active)}</span>}
          <span className="header-title">{active ? displayName(active) : 'No session'}</span>
          {phase === 'busy' && (
            <span className="header-status is-busy">
              <i />
              working
            </span>
          )}
          {phase === 'attention' && (
            <span className="header-status is-attention">
              <i />
              needs you
            </span>
          )}
          {(phase === 'dormant' || phase === 'starting') && (
            <span className="header-status">
              <i />
              resuming
            </span>
          )}
          <span className="header-right">
            {!state.hold && allBusy && phase === 'busy' && <span className="header-meta">all busy</span>}
            {conn === 'closed' && <span className="header-meta">reconnecting…</span>}
            {state.hold && (
              <button className="header-action" onClick={() => runCommand('advance')}>
                holding · resume auto-switch ⌃⇧J
              </button>
            )}
            {active?.cwd && <span className="header-cwd">{tildePath(active.cwd)}</span>}
            <button className="header-settings" onClick={() => setShowSettings(true)} title="Settings (⌃⇧,)" aria-label="Settings">
              <GearIcon size={18} />
            </button>
          </span>
        </header>

        {state.warnings.map((w, i) => (
          <div key={i} className="banner">
            <span>{w}</span>
            <button className="ghost-button" onClick={() => void stack.intent({ t: 'dismissWarning', index: i })}>
              Dismiss
            </button>
          </div>
        ))}

        <div className="term-wrap">
          <Stage
            activeId={activeId}
            preview={preview}
            colorOf={colorOf}
            theme={theme.terminal}
            fontFamily={theme.ui.monoFont}
            scrollback={state.settings.scrollback}
            inputBlockedUntil={inputBlockedUntil}
            onFocusTerminal={onFocusTerminal}
            onVisual={setVisual}
          />
          {preview && previewTarget && (
            <div className="switch-pill" key={preview.to} style={{ ['--c' as string]: sessionColor(theme, previewTarget.color), animationDuration: `${preview.ms}ms` }}>
              <span className="switch-pill-dot" />
              Switching to {displayName(previewTarget)}
              <kbd>Space</kbd>
              to stay
            </div>
          )}
          {state.sessions.length === 0 && (
            <div className="empty">
              <button className="add-session big" onClick={() => runCommand('new')} aria-label="New terminal">
                +
              </button>
            </div>
          )}
          {active && (phase === 'error' || phase === 'exited') && (
            <div className="term-overlay">
              <span>{phase === 'exited' ? 'Session ended.' : activeRt?.error ?? 'Session crashed.'}</span>
              <button className="primary-button" onClick={() => runCommand('relaunch')}>
                Relaunch ⌃⇧R
              </button>
            </div>
          )}
        </div>

        <BottomBar
          sessionId={activeId}
          queue={active?.queue ?? []}
          settings={state.settings}
          composerMode={composerMode}
          composerText={composerText}
          setComposerText={setComposerText}
          onComposerSubmit={onComposerSubmit}
          onComposerClose={onComposerClose}
          onPill={onPill}
          onBubble={onBubble}
          onRemoveBubble={(q) => active && void stack.intent({ t: 'removeQueued', id: active.id, itemId: q.id })}
        />
      </main>

      {showSettings && <SettingsPanel state={state} onClose={() => setShowSettings(false)} />}

      {closing && (
        <ConfirmDialog
          identity={{
            color: sessionColor(theme, closing.color),
            n: stackPosition(closing),
            title: displayName(closing),
            sub: tildePath(closing.cwd)
          }}
          title="Close this terminal?"
          body="The terminal stops and leaves your stack. A Claude conversation is saved and can be resumed any time with claude --resume."
          confirmLabel="Close terminal"
          onCancel={() => setConfirmClose(null)}
          onConfirm={() => {
            void stack.intent({ t: 'close', id: closing.id })
            setConfirmClose(null)
          }}
        />
      )}
    </div>
  )
}
