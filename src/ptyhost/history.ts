import { closeSync, createWriteStream, existsSync, openSync, readFileSync, renameSync, rmSync, statSync, type WriteStream } from 'node:fs'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { cursorModeSuffix } from './cursorMode'

// Deep scrollback without the memory cost: xterm instances keep only a modest scrollback,
// while raw PTY output is appended to disk. When the user scrolls to the top of what's
// loaded, the log is replayed into a throwaway headless terminal with a larger scrollback
// and serialized back to the renderer. Replay is approximate across resizes, which is fine
// for reading old output.

const ROTATE_BYTES = 8 * 1024 * 1024

export class HistoryLog {
  private stream: WriteStream | null = null
  private size = 0

  constructor(private readonly path: string) {
    try {
      this.size = existsSync(path) ? statSync(path).size : 0
    } catch {
      this.size = 0
    }
  }

  append(data: string): void {
    try {
      if (!this.stream) {
        closeSync(openSync(this.path, 'a'))
        this.stream = createWriteStream(this.path, { flags: 'a' })
        this.stream.on('error', () => (this.stream = null))
      }
      this.stream.write(data)
      this.size += data.length
      if (this.size > ROTATE_BYTES) this.rotate()
    } catch {
      // History is best-effort; never let it take down a session.
    }
  }

  private rotate(): void {
    this.stream?.end()
    this.stream = null
    try {
      renameSync(this.path, this.path + '.1')
    } catch {
      /* ignore */
    }
    this.size = 0
  }

  read(): string {
    let out = ''
    for (const p of [this.path + '.1', this.path]) {
      try {
        if (existsSync(p)) out += readFileSync(p, 'utf8')
      } catch {
        /* ignore */
      }
    }
    return out
  }

  close(): void {
    this.stream?.end()
    this.stream = null
  }

  remove(): void {
    this.close()
    for (const p of [this.path, this.path + '.1']) rmSync(p, { force: true })
  }
}

export function replayHistory(raw: string, cols: number, rows: number, lines: number): Promise<{ ansi: string; complete: boolean }> {
  return new Promise((resolve) => {
    const term = new Terminal({ cols, rows, scrollback: lines, allowProposedApi: true })
    const ser = new SerializeAddon()
    term.loadAddon(ser as never)
    term.write(raw, () => {
      // Only the normal buffer has history; an alt-screen app (Claude) scrolls itself.
      const total = term.buffer.normal.length
      const ansi = ser.serialize({ scrollback: lines, excludeAltBuffer: true }) + cursorModeSuffix(term)
      term.dispose()
      resolve({ ansi, complete: total < lines + rows })
    })
  })
}
