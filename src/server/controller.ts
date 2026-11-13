import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isEligible, nextSession } from '../shared/advance'
import { pickColor } from '../shared/palette'
import type { HostControl, HostEvent, ProcInfo, Snapshot } from '../shared/protocol'
import { initialRuntime, reduceStatus, type StatusEvent } from '../shared/sessionStatus'
import { buildSpawnSpec, claudeResumeFlags, resumeInput } from '../shared/spawnSpec'
import { DEFAULT_SETTINGS } from '../shared/themes'
import type { AppState, DeliverResult, Intent, PersistedState, Program, SessionConfig, SessionRuntime } from '../shared/types'
import { isClaude } from '../ptyhost/procPoll'
import { globalHooksInstalled, hooksDisabledByUser, installGlobalHooks, removeGlobalHooks, type HookEvent } from './hookServer'
import { debounced, readJsonSafe, writeJsonAtomic } from './persist'

export interface Paths {
  state: string
  snapshots: string
  history: string
  /** Local hooks file passed with --settings when the global hooks aren't installed. */
  hooksFile: string
  socket: string
}

export interface ControllerDeps {
  paths: Paths
  host: (msg: HostControl) => void
  broadcast: (state: AppState) => void
  /** Focused session was sent off; `target` is where the advance will go (for the animation). */
  sendOff: (id: string, target: string, ms: number) => void
  snap: (id: string, from: string | null) => void
  quit: () => void
  shell: string
  home: string
}

/** Text Claude would collapse into "[Pasted text #N]" if pasted; edit it in the composer instead. */
function tooLongToLoad(text: string): boolean {
  return text.length > 800 || text.split('\n').length > 3
}

const READY_FOR_TEXT = ['idle', 'attention', 'shell']
const SNAPSHOT_EVERY_MS = 60_000
/** Give up waiting for a resumed Claude to report in. */
const STARTING_TIMEOUT_MS = 30_000

function isPersisted(v: unknown): v is PersistedState {
  return !!v && typeof v === 'object' && (v as PersistedState).version === 1 && Array.isArray((v as PersistedState).sessions)
}

function sameProgram(a: Program | undefined, b: Program | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * Single source of truth for app state. Browsers send intents, the pty host and the hook
 * server send events; everything funnels through here and is broadcast back out.
 */
export class Controller {
  state: AppState
  private readonly save = debounced(() => this.persistNow(), 500)
  private pendingSends = new Map<string, string[]>()
  private snapshots = new Map<string, Snapshot>()
  private snapshotReq = 0
  private snapshotWaiters = new Map<number, (s: Snapshot | null) => void>()
  private snapshotTimer: NodeJS.Timeout | null = null
  private shuttingDown = false
  private sendOffTimer: NodeJS.Timeout | null = null

  constructor(private readonly deps: ControllerDeps) {
    const { value, warning } = readJsonSafe(deps.paths.state, isPersisted)
    const persisted: PersistedState = value ?? {
      version: 1,
      sessions: [],
      activeId: null,
      settings: { ...DEFAULT_SETTINGS },
      customThemes: [],
      nextNumber: 1
    }
    const sessions = persisted.sessions.map((s) => ({ ...s, queue: s.queue ?? [], cwd: s.cwd || deps.home }))
    this.state = {
      ...persisted,
      sessions,
      settings: { ...DEFAULT_SETTINGS, ...persisted.settings },
      customThemes: persisted.customThemes ?? [],
      runtime: Object.fromEntries(sessions.map((s) => [s.id, initialRuntime(true)])),
      hold: false,
      termSize: { cols: 120, rows: 36 },
      warnings: warning ? [warning] : [],
      home: deps.home,
      hooks: { installed: globalHooksInstalled() }
    }
    // "Needs you" detection is default behaviour: install the guarded hooks unless the user
    // removed them before.
    if (!this.state.hooks.installed && !persisted.hooksOptOut && !hooksDisabledByUser()) {
      const r = installGlobalHooks()
      if (!r.ok && r.error) this.state.warnings.push(r.error)
      this.state.hooks.installed = globalHooksInstalled()
    }
    if (hooksDisabledByUser()) this.state.warnings.push('disableAllHooks is on in ~/.claude/settings.json, so "needs you" detection is off.')
    if (this.state.activeId && !sessions.some((s) => s.id === this.state.activeId)) this.state.activeId = sessions[0]?.id ?? null
    mkdirSync(deps.paths.snapshots, { recursive: true })
    mkdirSync(deps.paths.history, { recursive: true })
  }

  private restored = false

  /**
   * Called when the pty host is up. Token-safe restore: nothing runs until a session is
   * focused (or sent to); then its shell starts in the saved cwd and Claude resumes by id.
   * After a host crash, sessions stay in the error state for the user to relaunch.
   */
  restoreOnce(): void {
    if (this.restored) return
    this.restored = true
    if (this.state.activeId) this.spawn(this.state.activeId)
    this.snapshotTimer = setInterval(() => void this.snapshotAll(), SNAPSHOT_EVERY_MS)
    this.broadcast()
  }

  // ---------------------------------------------------------------- helpers

  private session(id: string): SessionConfig | undefined {
    return this.state.sessions.find((s) => s.id === id)
  }

  private rt(id: string): SessionRuntime {
    return this.state.runtime[id] ?? (this.state.runtime[id] = initialRuntime(true))
  }

  private broadcast(): void {
    this.deps.broadcast(this.state)
  }

  private changed(persist = true): void {
    if (persist) this.save()
    this.broadcast()
  }

  private persistNow(): void {
    const { version, sessions, activeId, settings, customThemes, nextNumber, hooksOptOut } = this.state
    try {
      writeJsonAtomic(this.deps.paths.state, { version, sessions, activeId, settings, customThemes, nextNumber, hooksOptOut })
    } catch (e) {
      console.error('failed to save state', e)
    }
  }

  private transcriptExists(sid: string): boolean {
    const root = join(homedir(), '.claude', 'projects')
    try {
      return readdirSync(root).some((d) => existsSync(join(root, d, `${sid}.jsonl`)))
    } catch {
      return false
    }
  }

  /** Claude Code's own per-process file (undocumented): session id and name. */
  private claudeSessionFile(pid: number): { sessionId?: string; name?: string; nameSource?: string } | null {
    try {
      return JSON.parse(readFileSync(join(homedir(), '.claude', 'sessions', `${pid}.json`), 'utf8'))
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------- process lifecycle

  private spawn(id: string): void {
    const s = this.session(id)
    if (!s) return
    if (!existsSync(s.cwd)) s.cwd = this.deps.home
    const initialInput = resumeInput(s, {
      hooksPath: this.state.hooks.installed ? undefined : this.deps.paths.hooksFile,
      transcriptExists: (sid) => this.transcriptExists(sid)
    })
    const resumingClaude = !!initialInput?.startsWith('claude ')
    const spec = buildSpawnSpec(s, {
      shell: this.deps.shell,
      hookSocket: this.deps.paths.socket,
      cols: this.state.termSize.cols,
      rows: this.state.termSize.rows,
      scrollback: this.state.settings.scrollback,
      historyPath: join(this.deps.paths.history, `${s.id}.log`),
      baseEnv: process.env,
      initialInput
    })
    this.status(id, { k: 'spawn', resumingClaude })
    this.deps.host({ t: 'spawn', spec })
    if (resumingClaude) {
      setTimeout(() => {
        const rt = this.state.runtime[id]
        if (rt?.phase === 'starting') {
          rt.phase = 'shell'
          this.changed(false)
        }
      }, STARTING_TIMEOUT_MS)
    }
  }

  private ensureSpawned(id: string): void {
    const phase = this.rt(id).phase
    if (phase === 'dormant' || phase === 'exited' || phase === 'error') this.spawn(id)
  }

  // ---------------------------------------------------------------- status

  private status(id: string, ev: StatusEvent): void {
    const s = this.session(id)
    if (!s) return
    const before = this.rt(id)
    const res = reduceStatus(before, ev, { focused: id === this.state.activeId, now: Date.now() })
    this.state.runtime[id] = res.rt
    let dirty = JSON.stringify(before) !== JSON.stringify(res.rt)
    let persist = false
    if (res.claudeSid) {
      const program: Program = { kind: 'claude', sid: res.claudeSid, flags: s.program?.kind === 'claude' ? s.program.flags : '' }
      if (!sameProgram(s.program, program)) {
        s.program = program
        dirty = persist = true
      }
    }
    if (res.autoName && res.autoName !== s.autoName) {
      s.autoName = res.autoName
      dirty = persist = true
    }
    if (READY_FOR_TEXT.includes(res.rt.phase)) this.flushPending(id)
    if (res.sentOff && !this.state.hold && this.state.settings.advanceMode !== 'off') this.startSendOff(id)
    this.maybeSnap(id, before.phase, res.rt.phase)
    if (dirty && ev.k !== 'input') this.changed(persist)
  }

  /**
   * The focused session was just sent to Claude: advance after the send-off window unless the
   * human cancels (Space -> hold) or moves on first. The timer lives here, not in the page,
   * because browsers throttle timers in background tabs.
   */
  private startSendOff(id: string): void {
    this.cancelSendOff()
    const st = this.state
    const mode = st.settings.advanceMode === 'off' ? 'priority' : st.settings.advanceMode
    const target = nextSession(st.sessions, st.runtime, id, mode, st.settings.attentionFirst)
    // Nothing else is ready: stay put (the header says "all busy").
    if (!target) return
    this.deps.sendOff(id, target, st.settings.sendOffMs)
    this.sendOffTimer = setTimeout(() => {
      this.sendOffTimer = null
      if (this.state.activeId !== id || this.state.hold) return
      // Land where the UI was animating to, unless that session stopped being ready.
      const t = this.session(target)
      if (t && isEligible(t, this.state.runtime[target])) this.activate(target)
      else this.intent({ t: 'advance' })
    }, this.state.settings.sendOffMs)
  }

  private cancelSendOff(): void {
    if (this.sendOffTimer) clearTimeout(this.sendOffTimer)
    this.sendOffTimer = null
  }

  /**
   * Snap mode: a session above the focused one just finished or needs the human, so go to it
   * now. Whatever was half-typed stays in the current terminal's input.
   */
  private maybeSnap(id: string, prev: string, phase: string): void {
    const st = this.state
    if (!st.settings.snapToHigher || st.settings.advanceMode !== 'priority') return
    if (!st.activeId || id === st.activeId) return
    const becameReady = (prev === 'busy' && (phase === 'idle' || phase === 'attention')) || (phase === 'attention' && prev !== 'attention')
    if (!becameReady) return
    const list = st.sessions.filter((s) => !s.inactive)
    const target = list.findIndex((s) => s.id === id)
    const current = list.findIndex((s) => s.id === st.activeId)
    if (target === -1 || (current !== -1 && target > current)) return
    const from = st.activeId
    this.activate(id)
    this.deps.snap(id, from)
  }

  private onProc(id: string, info: ProcInfo): void {
    const s = this.session(id)
    if (!s || this.shuttingDown) return
    let persist = false
    if (info.cwd && info.cwd !== s.cwd) {
      s.cwd = info.cwd
      persist = true
    }
    const rt = this.rt(id)
    const fg = info.fg
    const claude = !!fg && isClaude(fg.comm, fg.args)
    let program: Program | undefined
    if (fg && claude) {
      const file = this.claudeSessionFile(fg.pid)
      const sid = (s.program?.kind === 'claude' && s.program.sid) || file?.sessionId
      program = { kind: 'claude', sid: file?.sessionId ?? sid, flags: claudeResumeFlags(fg.args) }
      // "derived" names are just the folder plus a counter; the folder already shows.
      if (file?.name && file.nameSource !== 'derived' && file.name !== s.autoName) {
        s.autoName = file.name
        persist = true
      }
    } else if (fg) {
      program = { kind: 'other', command: fg.args }
    }
    // While a resume command is still being typed/started the shell is in the foreground;
    // don't forget what we're resuming.
    if (!(rt.phase === 'starting' && !program) && !sameProgram(s.program, program)) {
      s.program = program
      persist = true
    }
    this.status(id, { k: 'proc', claude })
    if (persist) this.changed(true)
  }

  onHostEvent(ev: HostEvent): void {
    switch (ev.t) {
      case 'exit':
        this.status(ev.id, { k: 'exit', code: ev.code, signal: ev.signal })
        void this.snapshotOne(ev.id)
        break
      case 'title':
        this.status(ev.id, { k: 'title', title: ev.title })
        break
      case 'proc':
        this.onProc(ev.id, ev.info)
        break
      case 'snapshot': {
        const w = this.snapshotWaiters.get(ev.reqId)
        this.snapshotWaiters.delete(ev.reqId)
        w?.(ev.snapshot)
        break
      }
      case 'error':
        console.error('pty host error', ev.id ?? '', ev.message)
        if (ev.id) {
          this.rt(ev.id).error = ev.message
          this.changed(false)
        }
        break
    }
  }

  onHostCrash(): void {
    for (const s of this.state.sessions) {
      if (this.rt(s.id).phase !== 'dormant') this.status(s.id, { k: 'hostCrash' })
    }
  }

  onHook(e: HookEvent): void {
    const s = this.session(e.sid)
    if (!s) return
    // Ignore hooks from an older Claude conversation in this terminal (after /clear the new
    // id arrives with SessionStart itself).
    const sid = e.payload.session_id
    const known = s.program?.kind === 'claude' ? s.program.sid : undefined
    if (e.name !== 'SessionStart' && typeof sid === 'string' && known && sid !== known) return
    this.status(e.sid, { k: 'hook', name: e.name, payload: e.payload })
  }

  /** The human typed into a session (terminal query replies already filtered out). */
  onInput(id: string): void {
    this.status(id, { k: 'input' })
  }

  // ---------------------------------------------------------------- text delivery

  private writeText(id: string, text: string, submit: boolean): void {
    const data = text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text
    this.deps.host({ t: 'write', id, data })
    this.rt(id).lastInputAt = Date.now()
    // Give Claude's input a moment to finish processing the paste before Enter, or the
    // Enter can be swallowed as part of the paste.
    if (submit) setTimeout(() => this.deps.host({ t: 'write', id, data: '\r' }), 80)
  }

  private flushPending(id: string): void {
    const pending = this.pendingSends.get(id)
    if (!pending?.length) return
    this.pendingSends.delete(id)
    const [first, ...rest] = pending
    // Claude needs a beat after starting before its input box accepts text.
    setTimeout(() => this.writeText(id, first, true), 400)
    // Only one prompt can be sent per turn; the rest go back to the queue.
    for (const text of rest) this.enqueue(id, text)
  }

  private enqueue(id: string, text: string): void {
    const s = this.session(id)
    if (!s || !text.trim()) return
    s.queue.push({ id: randomUUID(), text, createdAt: Date.now() })
  }

  private removeQueued(id: string, itemId?: string): void {
    const s = this.session(id)
    if (s && itemId) s.queue = s.queue.filter((q) => q.id !== itemId)
  }

  /** Single path for pills, queue bubbles, the hold composer and (later) voice transcription. */
  deliver(id: string, text: string, mode: 'send' | 'load' | 'enqueue', itemId?: string): DeliverResult {
    if (!this.session(id)) return {}
    const phase = this.rt(id).phase

    if (mode === 'enqueue') {
      if (!itemId) this.enqueue(id, text)
      this.changed()
      return {}
    }

    if (mode === 'load') {
      this.removeQueued(id, itemId)
      if (tooLongToLoad(text)) {
        this.changed()
        return { loadIntoComposer: text }
      }
      this.ensureSpawned(id)
      this.writeText(id, text, false)
      this.changed()
      return {}
    }

    // send
    if (READY_FOR_TEXT.includes(phase)) {
      this.writeText(id, text, true)
      this.removeQueued(id, itemId)
    } else if (phase === 'busy') {
      if (!itemId) this.enqueue(id, text)
    } else {
      this.ensureSpawned(id)
      this.pendingSends.set(id, [...(this.pendingSends.get(id) ?? []), text])
      this.removeQueued(id, itemId)
    }
    this.changed()
    return {}
  }

  // ---------------------------------------------------------------- snapshots

  private requestSnapshot(id: string): Promise<Snapshot | null> {
    return new Promise((resolve) => {
      const reqId = ++this.snapshotReq
      this.snapshotWaiters.set(reqId, resolve)
      this.deps.host({ t: 'snapshot', reqId, id })
      setTimeout(() => {
        if (this.snapshotWaiters.delete(reqId)) resolve(null)
      }, 2000)
    })
  }

  private async snapshotOne(id: string): Promise<void> {
    const snap = await this.requestSnapshot(id)
    if (!snap) return
    this.snapshots.set(id, snap)
    try {
      writeJsonAtomic(join(this.deps.paths.snapshots, `${id}.json`), snap)
    } catch {
      /* best-effort */
    }
  }

  async snapshotAll(): Promise<void> {
    const live = this.state.sessions.filter((s) => !['dormant', 'error'].includes(this.rt(s.id).phase))
    await Promise.all(live.map((s) => this.snapshotOne(s.id)))
  }

  getSnapshot(id: string): Snapshot | null {
    const cached = this.snapshots.get(id)
    if (cached) return cached
    try {
      const snap = JSON.parse(readFileSync(join(this.deps.paths.snapshots, `${id}.json`), 'utf8')) as Snapshot
      this.snapshots.set(id, snap)
      return snap
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------- intents

  private activate(id: string): void {
    if (!this.session(id)) return
    if (id !== this.state.activeId) this.cancelSendOff()
    this.state.activeId = id
    this.state.hold = false
    this.status(id, { k: 'focus' })
    this.ensureSpawned(id)
    this.changed()
  }

  intent(i: Intent): unknown {
    const st = this.state
    switch (i.t) {
      case 'create': {
        const id = randomUUID()
        const above = st.sessions.filter((x) => !x.inactive).at(-1)
        const s: SessionConfig = {
          id,
          number: st.nextNumber++,
          color: pickColor(st.sessions.map((x) => x.color), above?.color),
          cwd: i.cwd || this.deps.home,
          inactive: false,
          queue: []
        }
        // New sessions go to the bottom of the active list.
        const firstInactive = st.sessions.findIndex((x) => x.inactive)
        if (firstInactive === -1) st.sessions.push(s)
        else st.sessions.splice(firstInactive, 0, s)
        st.runtime[id] = initialRuntime(true)
        this.activate(id)
        return id
      }
      case 'activate':
        this.activate(i.id)
        return
      case 'close': {
        this.deps.host({ t: 'forget', id: i.id })
        st.sessions = st.sessions.filter((s) => s.id !== i.id)
        delete st.runtime[i.id]
        this.pendingSends.delete(i.id)
        this.snapshots.delete(i.id)
        rmSync(join(this.deps.paths.snapshots, `${i.id}.json`), { force: true })
        if (st.activeId === i.id) {
          const next = nextSession(st.sessions, st.runtime, null, 'priority', false) ?? st.sessions[0]?.id ?? null
          if (next) this.activate(next)
          else st.activeId = null
        }
        this.changed()
        return
      }
      case 'move': {
        const s = this.session(i.id)
        if (!s) return
        const rest = st.sessions.filter((x) => x.id !== i.id)
        s.inactive = i.inactive
        const group = rest.filter((x) => x.inactive === i.inactive)
        const others = rest.filter((x) => x.inactive !== i.inactive)
        group.splice(Math.max(0, Math.min(i.index, group.length)), 0, s)
        st.sessions = i.inactive ? [...others, ...group] : [...group, ...others]
        this.changed()
        return
      }
      case 'relaunch':
        this.spawn(i.id)
        this.changed()
        return
      case 'rename': {
        const s = this.session(i.id)
        if (s) s.name = i.name.trim() || undefined
        this.changed()
        return
      }
      case 'setColor': {
        const s = this.session(i.id)
        if (s) s.color = i.color
        this.changed()
        return
      }
      case 'setResumeOverride': {
        const s = this.session(i.id)
        if (s) s.resumeOverride = i.command.trim() || undefined
        this.changed()
        return
      }
      case 'enqueue':
        this.enqueue(i.id, i.text)
        this.changed()
        return
      case 'removeQueued':
        this.removeQueued(i.id, i.itemId)
        this.changed()
        return
      case 'deliver':
        return this.deliver(i.id, i.text, i.mode, i.itemId)
      case 'resize': {
        const cols = Math.max(20, Math.floor(i.cols))
        const rows = Math.max(5, Math.floor(i.rows))
        if (cols === st.termSize.cols && rows === st.termSize.rows) return
        st.termSize = { cols, rows }
        this.deps.host({ t: 'resize', cols, rows, activeId: st.activeId })
        this.changed(false)
        return
      }
      case 'advance': {
        const mode = st.settings.advanceMode === 'off' ? 'priority' : st.settings.advanceMode
        const next = nextSession(st.sessions, st.runtime, st.activeId, mode, st.settings.attentionFirst)
        if (next) this.activate(next)
        else {
          st.hold = false
          this.changed(false)
        }
        return next
      }
      case 'setHold':
        st.hold = i.hold
        if (i.hold) this.cancelSendOff()
        this.changed(false)
        return
      case 'setSettings':
        st.settings = { ...st.settings, ...i.settings }
        this.changed()
        return
      case 'saveTheme': {
        const idx = st.customThemes.findIndex((t) => t.id === i.theme.id)
        const theme = { ...i.theme, builtIn: false }
        if (idx === -1) st.customThemes.push(theme)
        else st.customThemes[idx] = theme
        this.changed()
        return
      }
      case 'deleteTheme':
        st.customThemes = st.customThemes.filter((t) => t.id !== i.id)
        if (st.settings.themeId === i.id) st.settings.themeId = DEFAULT_SETTINGS.themeId
        this.changed()
        return
      case 'dismissWarning':
        st.warnings.splice(i.index, 1)
        this.changed(false)
        return
      case 'installHooks': {
        const r = installGlobalHooks()
        if (!r.ok && r.error) st.warnings.push(r.error)
        st.hooks = { installed: globalHooksInstalled() }
        st.hooksOptOut = false
        this.changed()
        return r
      }
      case 'removeHooks': {
        const r = removeGlobalHooks()
        if (!r.ok && r.error) st.warnings.push(r.error)
        st.hooks = { installed: globalHooksInstalled() }
        st.hooksOptOut = true
        this.changed()
        return r
      }
      case 'quitServer':
        setTimeout(() => this.deps.quit(), 50)
        return
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    if (this.snapshotTimer) clearInterval(this.snapshotTimer)
    await Promise.race([this.snapshotAll(), new Promise((r) => setTimeout(r, 2000))])
    this.save.flush()
    this.persistNow()
  }
}
