import { fork, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { HostControl, HostEvent } from '../shared/protocol'

/**
 * Owns the pty host child process. If it dies, every session is reported as crashed and a
 * fresh host is started; sessions are then relaunched from their saved cwd/resume command.
 */
export class PtyHostManager {
  private child: ChildProcess | null = null
  private ready = false
  private queue: HostControl[] = []
  private restarts: number[] = []
  private stopping = false

  constructor(
    private readonly onEvent: (ev: HostEvent) => void,
    private readonly onCrash: () => void
  ) {}

  start(): void {
    this.ready = false
    const child = fork(join(__dirname, 'ptyHost.js'), [], {
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    })
    this.child = child
    child.on('message', (ev: HostEvent) => {
      if (ev.t === 'ready') {
        this.ready = true
        const q = this.queue
        this.queue = []
        for (const m of q) child.send(m)
      }
      this.onEvent(ev)
    })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      this.ready = false
      if (this.stopping) return
      console.error(`pty host exited (${code ?? signal}); restarting`)
      this.onCrash()
      const now = Date.now()
      this.restarts = this.restarts.filter((t) => now - t < 60_000).concat(now)
      // Back off if it keeps dying so we don't spin.
      setTimeout(() => this.start(), this.restarts.length > 3 ? 5_000 : 300)
    })
  }

  send(msg: HostControl): void {
    if (this.child && this.ready) this.child.send(msg)
    else if (msg.t === 'spawn' || msg.t === 'resize') this.queue.push(msg)
  }

  stop(): void {
    this.stopping = true
    this.child?.kill('SIGTERM')
    this.child = null
  }
}
