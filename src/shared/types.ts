/**
 * dormant   restored from disk, no process yet (lazy resume, spends nothing)
 * starting  shell spawned, waiting for Claude's SessionStart hook
 * idle      Claude waiting at its prompt
 * busy      Claude working
 * attention Claude blocked on the human (permission prompt, question)
 * shell     plain shell, or Claude exited back to its shell
 * exited    process ended cleanly
 * error     process died unexpectedly or the pty host crashed
 */
export type Phase = 'dormant' | 'starting' | 'idle' | 'busy' | 'attention' | 'shell' | 'exited' | 'error'

export interface QueueItem {
  id: string
  text: string
  createdAt: number
}

/** What was running in the terminal at the last check; drives resume on restore. */
export type Program =
  | { kind: 'claude'; sid?: string; flags: string }
  | { kind: 'other'; command: string }

/** Persisted per-session config. Array order in AppState.sessions is the priority order. */
export interface SessionConfig {
  id: string
  /** Name set by the user in DeepStack; wins over everything. */
  name?: string
  /** Name inherited from Claude Code (terminal title / session file). */
  autoName?: string
  number: number
  color: string
  /** Last known working directory of the shell. */
  cwd: string
  program?: Program
  /** Overrides the computed resume command, e.g. "grok --resume". */
  resumeOverride?: string
  inactive: boolean
  queue: QueueItem[]
}

/** Live, non-persisted per-session state. */
export interface SessionRuntime {
  phase: Phase
  /** Finished work while not focused. */
  unseen: boolean
  claudeAlive: boolean
  error?: string
  /** Last time the human typed into this session (ms epoch). */
  lastInputAt: number
  /** When the session entered attention (ms epoch). */
  attentionAt?: number
}

export type AdvanceMode = 'priority' | 'sequential' | 'off'

export interface Settings {
  advanceMode: AdvanceMode
  /** In priority mode, sessions waiting on a permission prompt jump the line. */
  attentionFirst: boolean
  /** Length of the send-off window during which Space cancels the advance. */
  sendOffMs: number
  /**
   * Priority mode only: the moment a session above the current one finishes or needs you,
   * switch to it, even mid-typing. Whatever was typed stays in that terminal's input.
   */
  snapToHigher: boolean
  /** Open in its own window (Electron) instead of a browser tab. */
  standalone: boolean
  bubbleClick: 'load' | 'send'
  pills: string[]
  themeId: string
  /** Lines kept live in xterm; older lines are loaded on demand. */
  scrollback: number
  miniHeight: number
}

export interface ThemeUi {
  bg: string
  sidebar: string
  panel: string
  border: string
  text: string
  muted: string
  accent: string
  bubble: string
  bubbleText: string
  pill: string
  pillText: string
  font: string
  monoFont: string
  fontSize: number
}

export interface TerminalTheme {
  background: string
  foreground: string
  cursor: string
  cursorAccent?: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export interface Theme {
  id: string
  name: string
  builtIn?: boolean
  ui: ThemeUi
  terminal: TerminalTheme
  /** When set, overrides every session's border color. */
  sessionColorOverride?: string
  /** CRT look: phosphor glow, scanlines and vignette over the terminals. */
  crt?: boolean
}

export interface PersistedState {
  version: 1
  sessions: SessionConfig[]
  activeId: string | null
  settings: Settings
  customThemes: Theme[]
  nextNumber: number
  /** The user removed the global Claude hooks; don't reinstall them on start. */
  hooksOptOut?: boolean
}

export interface AppState extends PersistedState {
  runtime: Record<string, SessionRuntime>
  /** Space cancelled the advance; typed text becomes queue bubbles. */
  hold: boolean
  termSize: { cols: number; rows: number }
  warnings: string[]
  home: string
  hooks: { installed: boolean }
}

export type DeliverMode = 'send' | 'load' | 'enqueue'

export type Intent =
  | { t: 'create'; cwd?: string }
  | { t: 'activate'; id: string }
  | { t: 'close'; id: string }
  | { t: 'move'; id: string; inactive: boolean; index: number }
  | { t: 'relaunch'; id: string }
  | { t: 'rename'; id: string; name: string }
  | { t: 'setColor'; id: string; color: string }
  | { t: 'setResumeOverride'; id: string; command: string }
  | { t: 'enqueue'; id: string; text: string }
  | { t: 'removeQueued'; id: string; itemId: string }
  | { t: 'deliver'; id: string; text: string; mode: DeliverMode; itemId?: string }
  | { t: 'resize'; cols: number; rows: number }
  | { t: 'advance' }
  | { t: 'setHold'; hold: boolean }
  | { t: 'setSettings'; settings: Partial<Settings> }
  | { t: 'saveTheme'; theme: Theme }
  | { t: 'deleteTheme'; id: string }
  | { t: 'dismissWarning'; index: number }
  | { t: 'installHooks' }
  | { t: 'removeHooks' }
  | { t: 'quitServer' }

export interface DeliverResult {
  /** Text too long to paste into Claude's input without collapsing; edit it in the composer instead. */
  loadIntoComposer?: string
}

/** Sent server -> client when the focused session was sent off to Claude. */
export interface SendOffEvent {
  id: string
  /** Where the advance will go, so the UI can animate toward it. */
  target: string | null
  at: number
  ms: number
}

/** Sent server -> client when snap mode switched focus without being asked. */
export interface SnapEvent {
  id: string
  from: string | null
}
