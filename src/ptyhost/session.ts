import * as pty from 'node-pty'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import type { Snapshot, SpawnSpec } from '../shared/protocol'
import { encodeCells } from '../shared/miniCodec'
import { HistoryLog, replayHistory } from './history'
import { sampleMini } from './miniSampler'
import { cursorModeSuffix } from './cursorMode'

export interface SessionCallbacks {
  onData(s: HostSession, data: string): void
  onExit(s: HostSession, code: number, signal: number): void
  onTitle(s: HostSession, title: string): void
}

const COALESCE_MS = 8
/** Type the resume command once the shell has been quiet this long after its first output. */
const INITIAL_INPUT_QUIET_MS = 300
const INITIAL_INPUT_MAX_WAIT_MS = 8000

/**
 * One PTY plus its authoritative headless screen. Browser terminals are just views: on focus
 * they are rebuilt from serialize(), so closing or reloading a tab loses nothing.
 */
export class HostSession {
  readonly id: string
  readonly term: Terminal
  private readonly ser = new SerializeAddon()
  private readonly proc: pty.IPty
  private readonly history: HistoryLog
  private readonly startedAt = Date.now()
  seq = 0
  dirty = true
  /** A browser is viewing this session and answers terminal queries itself. */
  watched = false
  private pending = ''
  private flushTimer: NodeJS.Timeout | null = null
  private paused = false
  private dead = false
  private initialInput: string | undefined
  private initialTimer: NodeJS.Timeout | null = null

  constructor(spec: SpawnSpec, private readonly cb: SessionCallbacks) {
    this.id = spec.id
    this.initialInput = spec.initialInput
    this.term = new Terminal({ cols: spec.cols, rows: spec.rows, scrollback: spec.scrollback, allowProposedApi: true })
    this.term.loadAddon(this.ser as never)
    this.history = new HistoryLog(spec.historyPath)

    this.proc = pty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: spec.cols,
      rows: spec.rows,
      cwd: spec.cwd,
      env: spec.env
    })

    this.term.onWriteParsed(() => (this.dirty = true))
    this.term.onTitleChange((t) => this.cb.onTitle(this, t))
    // Terminal query replies (cursor position, device attributes). A watching browser answers
    // those itself, so only the headless mirror answers for unwatched sessions.
    this.term.onData((d) => {
      if (!this.watched && !this.dead) this.proc.write(d)
    })

    this.proc.onData((d) => {
      this.term.write(d)
      this.history.append(d)
      this.queue(d)
      this.scheduleInitialInput()
    })
    this.proc.onExit(({ exitCode, signal }) => {
      this.dead = true
      this.flush()
      this.history.close()
      this.cb.onExit(this, exitCode, signal ?? 0)
    })
    if (this.initialInput) setTimeout(() => this.sendInitialInput(), INITIAL_INPUT_MAX_WAIT_MS)
  }

  get pid(): number {
    return this.proc.pid
  }

  get uptimeMs(): number {
    return Date.now() - this.startedAt
  }

  get alive(): boolean {
    return !this.dead
  }

  private scheduleInitialInput(): void {
    if (!this.initialInput) return
    if (this.initialTimer) clearTimeout(this.initialTimer)
    this.initialTimer = setTimeout(() => this.sendInitialInput(), INITIAL_INPUT_QUIET_MS)
  }

  private sendInitialInput(): void {
    const text = this.initialInput
    this.initialInput = undefined
    if (this.initialTimer) clearTimeout(this.initialTimer)
    if (text && !this.dead) this.proc.write(text)
  }

  private queue(d: string): void {
    this.pending += d
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), COALESCE_MS)
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (!this.pending) return
    const d = this.pending
    this.pending = ''
    this.seq++
    this.cb.onData(this, d)
  }

  /** Push any coalesced output now; returns the latest seq sent. */
  flushNow(): number {
    this.flush()
    return this.seq
  }

  /** Backpressure from a slow browser connection. */
  setPaused(paused: boolean): void {
    if (paused === this.paused || this.dead) return
    this.paused = paused
    if (paused) this.proc.pause()
    else this.proc.resume()
  }

  /** Full screen + modes + recent scrollback; the browser resets its xterm and writes this. */
  serialize(scrollback: number): string {
    this.flush()
    return this.ser.serialize({ scrollback }) + cursorModeSuffix(this.term)
  }

  write(data: string): void {
    if (!this.dead) this.proc.write(data)
  }

  resize(cols: number, rows: number): void {
    if (this.dead || (cols === this.term.cols && rows === this.term.rows)) return
    try {
      this.proc.resize(cols, rows)
      this.term.resize(cols, rows)
    } catch {
      /* pty may have just exited */
    }
  }

  mini(): { cols: number; rows: number; cells: Uint32Array } {
    this.dirty = false
    return sampleMini(this.term)
  }

  snapshot(): Snapshot {
    const m = sampleMini(this.term)
    return { cols: m.cols, rows: m.rows, cells: encodeCells(m.cells), takenAt: Date.now() }
  }

  loadHistory(lines: number) {
    return replayHistory(this.history.read(), this.term.cols, this.term.rows, lines)
  }

  kill(): void {
    if (this.dead) return
    // Hang up the whole process group so Claude (a child of the shell) goes too.
    try {
      process.kill(-this.proc.pid, 'SIGHUP')
    } catch {
      /* already gone */
    }
    try {
      this.proc.kill('SIGHUP')
    } catch {
      /* already gone */
    }
  }

  dispose(removeHistory: boolean): void {
    this.kill()
    if (removeHistory) this.history.remove()
    else this.history.close()
    this.term.dispose()
  }
}
