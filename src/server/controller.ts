import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isEligible, nextSession } from '../shared/advance'
import { feedLine, isSlashCommand } from './typedLine'
import { pickColor } from '../shared/palette'
import type { HostControl, HostEvent, ProcInfo, Snapshot } from '../shared/protocol'
import { initialRuntime, reduceStatus, type StatusEvent } from '../shared/sessionStatus'
import { buildSpawnSpec, claudeResumeFlags, resumeInput } from '../shared/spawnSpec'
import { DEFAULT_SETTINGS, LEGACY_DEFAULT_PILLS } from '../shared/themes'
import type { AppState, DeliverResult, Intent, PersistedState, Program, SendOffReason, SessionConfig, SessionRuntime, Settings } from '../shared/types'
import { isClaude } from '../ptyhost/procPoll'
import { findTranscript, pendingBackgroundTasks } from './backgroundTasks'
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
  /**
   * A switch from `id` to `target` is coming in `ms` (for the animation; Space cancels).
   * `reason` says why (a send-off or a step of an approval run); `left` = approvals after it.
   */
  sendOff: (id: string, target: string, ms: number, reason: SendOffReason, left: number) => void
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
/** Claude needs a beat after becoming ready before its input box accepts text. */
const INPUT_READY_MS = 400
/** Room for a `/rename` to be typed and submitted before a waiting prompt follows it. */
const RENAME_GAP_MS = 350
/** After typing /rename, ignore the busy blip it causes for auto-switch purposes. */
const RENAME_QUIET_MS = 3000
/**
 * A slash command (`/context`, `/model`…) flashes busy and is usually done at once, so it doesn't
 * send you off. If the session is still busy this long after (a skill, /compact: real work),
 * the send-off goes ahead after all.
 */
const SLASH_GRACE_MS = 2500
/** An approval only pulls you away once you've stopped typing (or switching) for this long. */
const APPROVAL_QUIET_MS = 2500
const SNAPSHOT_EVERY_MS = 60_000
/** How often a session waiting on its background task is re-checked (in case Claude doesn't resume). */
const BACKGROUND_RECHECK_MS = 15_000
/** Give up waiting for a resumed Claude to report in. */
const STARTING_TIMEOUT_MS = 30_000

function isPersisted(v: unknown): v is PersistedState {
  return !!v && typeof v === 'object' && (v as PersistedState).version === 1 && Array.isArray((v as PersistedState).sessions)
}

function sameProgram(a: Program | undefined, b: Program | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/** Untouched old defaults move to the current ones; anything the user customised is kept. */
function upgradeSettings(s: Settings): Settings {
  if (JSON.stringify(s.pills) === JSON.stringify(LEGACY_DEFAULT_PILLS)) return { ...s, pills: [...DEFAULT_SETTINGS.pills] }
  return s
}

/**
 * Single source of truth for app state. Browsers send intents, the pty host and the hook
 * server send events; everything funnels through here and is broadcast back out.
 */

export class Controller {
  state: AppState
  private readonly save = debounced(() => this.persistNow(), 500)
  private pendingSends = new Map<string, string[]>()
  /** A `/rename` waiting for its Claude session to be ready for input. */
  private pendingRenames = new Map<string, string>()
  /** When we last typed /rename into each session. */
  private renamedAt = new Map<string, number>()
  /** What the human is typing into each session, and when they last submitted a slash command. */
  private typed = new Map<string, string>()
  private slashAt = new Map<string, number>()
  private slashTimer: ReturnType<typeof setTimeout> | null = null
  private snapshots = new Map<string, Snapshot>()
  private snapshotReq = 0
  private snapshotWaiters = new Map<number, (s: Snapshot | null) => void>()
  private snapshotTimer: NodeJS.Timeout | null = null
  private shuttingDown = false
  private sendOffTimer: NodeJS.Timeout | null = null
  /**
   * Approval run: permission prompts elsewhere pulled you away from `returnTo`; you're walked
   * through them oldest first, then taken back there. Never pulled out of an unanswered one.
   */
  private run: { returnTo: string | null } | null = null
  private approvalTimer: NodeJS.Timeout | null = null
  /** The pending preview is a step of an approval run (so Space dismisses those approvals). */
  private previewIsApproval = false
  /** Approvals you said "stay" to (Space): not grabbed again until they're answered. */
  private dismissed = new Set<string>()
  /** Last time you switched yourself; counts as activity for the approval quiet period. */
  private manualAt = 0
  /** Each Claude session's transcript file (from its hooks), for spotting background tasks. */
  private transcripts = new Map<string, string>()
  private backgroundTimer: NodeJS.Timeout | null = null

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
      settings: upgradeSettings({ ...DEFAULT_SETTINGS, ...persisted.settings }),
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
  /**
   * DeepStack is never empty: with no sessions at all (first run, or the last one closed) open a
   * terminal in ~ and focus it. Returns true if it made one.
   */
  private ensureOneSession(): boolean {
    if (this.state.sessions.length > 0) return false
    this.intent({ t: 'create' })
    this.changed()
    return true
  }

  restoreOnce(): void {
    if (this.restored) return
    this.restored = true
    if (!this.ensureOneSession() && this.state.activeId) this.spawn(this.state.activeId)
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
    // Going quiet: is it really done, or waiting on a background task of its own?
    if (res.rt.phase !== 'idle') res.rt.background = false
    else if (before.phase !== 'idle') {
      res.rt.background = this.backgroundPending(id, res.claudeSid)
      if (res.rt.background) this.watchBackground()
    }
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
    const renamed = this.flushRename(id, res.rt.phase)
    if (READY_FOR_TEXT.includes(res.rt.phase)) this.flushPending(id, renamed ? RENAME_GAP_MS : 0)
    // Claude flashes busy while it runs our /rename; that's not a prompt being sent.
    const renaming = Date.now() - (this.renamedAt.get(id) ?? 0) < RENAME_QUIET_MS
    // During an approval run, answering decides where you go next (the run), not the send-off.
    const canSendOff = () => !this.state.hold && !this.run && this.state.settings.advanceMode !== 'off'
    if (res.sentOff && !renaming && canSendOff()) {
      if (Date.now() - (this.slashAt.get(id) ?? 0) < RENAME_QUIET_MS) {
        // A slash command: stay unless it turns out to be real work (still busy after the grace).
        if (this.slashTimer) clearTimeout(this.slashTimer)
        this.slashTimer = setTimeout(() => {
          this.slashTimer = null
          if (this.state.activeId === id && this.rt(id).phase === 'busy' && canSendOff()) this.startSendOff(id)
        }, SLASH_GRACE_MS)
      } else this.startSendOff(id)
    }
    this.maybeSnap(id, before.phase, res.rt.phase)
    const raised = res.rt.phase === 'attention' && before.phase !== 'attention'
    const cleared = before.phase === 'attention' && res.rt.phase !== 'attention'
    if (cleared) this.dismissed.delete(id)
    if (raised || (cleared && id === this.state.activeId)) this.checkApprovals()
    if (dirty && ev.k !== 'input') this.changed(persist)
  }

  /** Whether this Claude session has a background task running that hasn't reported back. */
  private backgroundPending(id: string, newSid?: string): boolean {
    const s = this.session(id)
    const sid = newSid ?? (s?.program?.kind === 'claude' ? s.program.sid : undefined)
    let path = this.transcripts.get(id)
    if (!path && sid && s) {
      path = findTranscript(join(homedir(), '.claude', 'projects'), sid, s.cwd) ?? undefined
      if (path) this.transcripts.set(id, path)
    }
    return !!path && pendingBackgroundTasks(path).length > 0
  }

  /** Re-check sessions waiting on a background task until none are (Claude usually resumes first). */
  private watchBackground(): void {
    if (this.backgroundTimer) return
    this.backgroundTimer = setInterval(() => {
      let any = false
      let changed = false
      for (const s of this.state.sessions) {
        const rt = this.state.runtime[s.id]
        if (!rt?.background) continue
        if (rt.phase === 'idle' && this.backgroundPending(s.id)) any = true
        else {
          this.state.runtime[s.id] = { ...rt, background: false }
          changed = true
        }
      }
      if (changed) this.changed(false)
      if (!any && this.backgroundTimer) {
        clearInterval(this.backgroundTimer)
        this.backgroundTimer = null
      }
    }, BACKGROUND_RECHECK_MS)
  }

  /** Sessions waiting on a permission prompt (other than the focused one), oldest first. */
  private approvals(): string[] {
    const st = this.state
    return st.sessions
      .filter((s) => !s.inactive && s.id !== st.activeId && st.runtime[s.id]?.phase === 'attention' && !this.dismissed.has(s.id))
      .sort((a, b) => (st.runtime[a.id]?.attentionAt ?? 0) - (st.runtime[b.id]?.attentionAt ?? 0))
      .map((s) => s.id)
  }

  /**
   * Approval runs. Called whenever that picture may have changed (a prompt appeared, you
   * answered one, hold was lifted, the quiet period ran out). Idempotent.
   */
  private checkApprovals(): void {
    const st = this.state
    if (this.approvalTimer) clearTimeout(this.approvalTimer)
    this.approvalTimer = null
    if (!st.settings.grabApprovals || st.settings.advanceMode === 'off') {
      this.run = null
      return
    }
    const active = st.activeId
    // A switch is already on its way, you asked to stay, or you're looking at an approval.
    if (this.sendOffTimer || st.hold || !active) return
    if (st.runtime[active]?.phase === 'attention') return
    const queue = this.approvals()
    if (!queue.length) {
      // All answered: back to where the run found you.
      if (!this.run) return
      const back = this.run.returnTo
      this.run = null
      const s = back ? this.session(back) : undefined
      if (s && !s.inactive && back !== active) this.preview(active, s.id, 'return', 0)
      return
    }
    if (!this.run) {
      // Don't pull you away mid-sentence (or right after you switched yourself).
      const quiet = Date.now() - Math.max(st.runtime[active]?.lastInputAt ?? 0, this.manualAt)
      if (quiet < APPROVAL_QUIET_MS) {
        this.approvalTimer = setTimeout(() => this.checkApprovals(), APPROVAL_QUIET_MS - quiet + 50)
        return
      }
      this.run = { returnTo: active }
      this.preview(active, queue[0], 'approval', queue.length - 1)
    } else this.preview(active, queue[0], 'next', queue.length - 1)
  }

  /**
   * Announce a switch (the UI animates it; Space cancels) and make it after the send-off window,
   * unless you moved or asked to stay first.
   */
  private preview(from: string, target: string, reason: SendOffReason, left: number): void {
    this.cancelSendOff()
    const ms = this.state.settings.sendOffMs
    this.previewIsApproval = reason === 'approval' || reason === 'next'
    this.deps.sendOff(from, target, ms, reason, left)
    this.sendOffTimer = setTimeout(() => {
      this.sendOffTimer = null
      this.previewIsApproval = false
      if (this.state.activeId !== from || this.state.hold) return
      const t = this.session(target)
      const stillWaiting = reason === 'return' || this.state.runtime[target]?.phase === 'attention'
      if (t && !t.inactive && stillWaiting) this.activate(target, true)
      else this.checkApprovals()
    }, ms)
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
    this.previewIsApproval = false
    this.deps.sendOff(id, target, st.settings.sendOffMs, 'sendOff', 0)
    this.sendOffTimer = setTimeout(() => {
      this.sendOffTimer = null
      if (this.state.activeId !== id || this.state.hold) return
      // Land where the UI was animating to, unless that session stopped being ready.
      const t = this.session(target)
      if (t && isEligible(t, this.state.runtime[target])) this.activate(target, true)
      else this.intent({ t: 'advance' })
    }, this.state.settings.sendOffMs)
  }

  private cancelSendOff(): void {
    if (this.sendOffTimer) clearTimeout(this.sendOffTimer)
    this.sendOffTimer = null
    this.previewIsApproval = false
  }

  /**
   * Snap mode: a session above the focused one just finished or needs the human, so go to it
   * now. Whatever was half-typed stays in the current terminal's input.
   */
  private maybeSnap(id: string, prev: string, phase: string): void {
    const st = this.state
    if (!st.settings.snapToHigher || st.settings.advanceMode !== 'priority') return
    if (!st.activeId || id === st.activeId) return
    // Never pulled out of a permission prompt you haven't answered (approvals queue instead).
    if (st.runtime[st.activeId]?.phase === 'attention') return
    const becameReady = (prev === 'busy' && (phase === 'idle' || phase === 'attention')) || (phase === 'attention' && prev !== 'attention')
    if (!becameReady) return
    // Gone quiet only to wait on its own background task: nothing for you there yet.
    if (phase === 'idle' && st.runtime[id]?.background) return
    const list = st.sessions.filter((s) => !s.inactive)
    const target = list.findIndex((s) => s.id === id)
    const current = list.findIndex((s) => s.id === st.activeId)
    if (target === -1 || (current !== -1 && target > current)) return
    const from = st.activeId
    this.activate(id, true)
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
    if (typeof e.payload.transcript_path === 'string') this.transcripts.set(e.sid, e.payload.transcript_path)
    this.status(e.sid, { k: 'hook', name: e.name, payload: e.payload })
  }

  /** The human typed into a session (terminal query replies already filtered out). */
  onInput(id: string, data = ''): void {
    const fed = feedLine(this.typed.get(id) ?? '', data)
    this.typed.set(id, fed.line.slice(-500))
    if (fed.submitted.some(isSlashCommand)) this.slashAt.set(id, Date.now())
    this.status(id, { k: 'input' })
  }

  // ---------------------------------------------------------------- text delivery

  /** `asInput: false` for our own commands (e.g. /rename), which must never count as a sent prompt. */
  private writeText(id: string, text: string, submit: boolean, asInput = true): void {
    const data = text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text
    this.deps.host({ t: 'write', id, data })
    if (asInput) this.rt(id).lastInputAt = Date.now()
    // Give Claude's input a moment to finish processing the paste before Enter, or the
    // Enter can be swallowed as part of the paste.
    if (submit) setTimeout(() => this.deps.host({ t: 'write', id, data: '\r' }), 80)
  }

  private flushPending(id: string, extraDelay = 0): void {
    const pending = this.pendingSends.get(id)
    if (!pending?.length) return
    this.pendingSends.delete(id)
    const [first, ...rest] = pending
    // Claude needs a beat after starting before its input box accepts text.
    setTimeout(() => this.writeText(id, first, true), INPUT_READY_MS + extraDelay)
    // Only one prompt can be sent per turn; the rest go back to the queue.
    for (const text of rest) this.enqueue(id, text)
  }

  /** Send a waiting `/rename` once Claude can take input. True if one went out. */
  private sendRename(id: string, name: string): void {
    this.renamedAt.set(id, Date.now())
    this.writeText(id, `/rename ${name}`, true, false)
  }

  private flushRename(id: string, phase: string): boolean {
    const name = this.pendingRenames.get(id)
    if (!name || (phase !== 'idle' && phase !== 'attention')) return false
    this.pendingRenames.delete(id)
    setTimeout(() => this.sendRename(id, name), INPUT_READY_MS)
    return true
  }

  private retitle(id: string, raw: string): void {
    const s = this.session(id)
    const name = raw.replace(/\s+/g, ' ').trim()
    if (!s || !name) return
    const phase = this.rt(id).phase
    // The header shows the new name right away; Claude's own title update then confirms the same
    // value, so nothing flickers in between.
    s.name = undefined
    s.autoName = name
    if (s.program?.kind !== 'claude' || phase === 'shell' || phase === 'exited' || phase === 'error') {
      // No Claude to tell: a plain name.
      s.name = name
      s.autoName = undefined
      return
    }
    if (phase === 'idle' || phase === 'attention') {
      this.pendingRenames.delete(id)
      // Slash commands don't fire UserPromptSubmit, so this never triggers an auto-advance.
      this.sendRename(id, name)
      return
    }
    // Busy (don't type into a running turn) or not started yet: send it when it's ready.
    this.pendingRenames.set(id, name)
    this.ensureSpawned(id)
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

  private updateQueued(id: string, itemId: string, text: string): void {
    const s = this.session(id)
    if (!s) return
    if (!text.trim()) return this.removeQueued(id, itemId)
    s.queue = s.queue.map((q) => (q.id === itemId ? { ...q, text } : q))
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
      // SEND NOW on a queued message: typed straight into Claude, which queues it itself (as if
      // you'd typed it in the terminal). Anything else sent while it works waits in our queue.
      if (itemId) {
        this.writeText(id, text, true)
        this.removeQueued(id, itemId)
      } else this.enqueue(id, text)
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

  /** `auto`: DeepStack moved you (send-off, snap, approval run), not a click or shortcut. */
  private activate(id: string, auto = false): void {
    if (!this.session(id)) return
    if (id !== this.state.activeId) this.cancelSendOff()
    // You took over: the approval run ends, and no grab until you've had a moment.
    if (!auto) {
      this.run = null
      this.manualAt = Date.now()
    }
    this.state.activeId = id
    this.state.hold = false
    this.status(id, { k: 'focus' })
    this.ensureSpawned(id)
    this.changed()
    this.checkApprovals()
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
        if (this.ensureOneSession()) return
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
      case 'clearTerminal':
        // Clear the mirror and history, then Ctrl+L so the shell (or Claude) redraws at the top.
        if (!this.session(i.id) || !this.state.runtime[i.id] || ['dormant', 'exited', 'error'].includes(this.state.runtime[i.id].phase)) return
        this.deps.host({ t: 'clear', id: i.id })
        setTimeout(() => this.deps.host({ t: 'write', id: i.id, data: '\x0c' }), 30)
        return
      case 'rename': {
        const s = this.session(i.id)
        if (s) s.name = i.name.trim() || undefined
        this.changed()
        return
      }
      case 'retitle':
        this.retitle(i.id, i.name)
        this.changed()
        return
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
      case 'updateQueued':
        this.updateQueued(i.id, i.itemId, i.text)
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
        if (i.hold) {
          // "Stay" on an approval grab: leave those approvals be until they're answered.
          if (this.sendOffTimer && this.previewIsApproval) {
            for (const a of this.approvals()) this.dismissed.add(a)
            this.run = null
          }
          this.cancelSendOff()
        }
        this.changed(false)
        if (!i.hold) this.checkApprovals()
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
    if (this.backgroundTimer) clearInterval(this.backgroundTimer)
    await Promise.race([this.snapshotAll(), new Promise((r) => setTimeout(r, 2000))])
    this.save.flush()
    this.persistNow()
  }
}
