// Pty host: a child process of the server, so a native node-pty failure can't take down the
// server (or the UI). The server restarts this process if it dies.
import type { HostControl, HostEvent } from '../shared/protocol'
import { pollProcs } from './procPoll'
import { HostSession } from './session'

const sessions = new Map<string, HostSession>()

const MINI_INTERVAL_MS = 250
const PROC_INTERVAL_MS = 3000
const BACKGROUND_RESIZE_DELAY_MS = 300

function emit(ev: HostEvent): void {
  try {
    process.send?.(ev)
  } catch {
    /* server gone; we'll be killed shortly */
  }
}

const callbacks = {
  onData(s: HostSession, d: string) {
    if (sessions.get(s.id) === s) emit({ t: 'data', id: s.id, seq: s.seq, d })
  },
  onExit(s: HostSession, code: number, signal: number) {
    // A relaunch replaces the session object; ignore the old one's exit.
    if (sessions.get(s.id) !== s) return
    s.dirty = true
    emit({ t: 'exit', id: s.id, code, signal, uptimeMs: s.uptimeMs })
  },
  onTitle(s: HostSession, title: string) {
    if (sessions.get(s.id) === s) emit({ t: 'title', id: s.id, title })
  }
}

let resizeTimer: NodeJS.Timeout | null = null

function resizeAll(cols: number, rows: number, active: string | null): void {
  // Resize the visible session now; stagger the rest so a window drag doesn't make 20
  // Claude sessions reflow at once.
  if (active) sessions.get(active)?.resize(cols, rows)
  if (resizeTimer) clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    let i = 0
    for (const s of sessions.values()) {
      if (s.id === active) continue
      setTimeout(() => s.resize(cols, rows), i++ * 40)
    }
  }, BACKGROUND_RESIZE_DELAY_MS)
}

function onControl(msg: HostControl): void {
  const s = 'id' in msg ? sessions.get(msg.id) : undefined
  switch (msg.t) {
    case 'spawn': {
      const old = sessions.get(msg.spec.id)
      if (old) {
        sessions.delete(msg.spec.id)
        old.dispose(false)
      }
      try {
        const fresh = new HostSession(msg.spec, callbacks)
        sessions.set(fresh.id, fresh)
        emit({ t: 'spawned', id: fresh.id, pid: fresh.pid })
      } catch (e) {
        emit({ t: 'error', id: msg.spec.id, message: (e as Error).message })
        emit({ t: 'exit', id: msg.spec.id, code: 1, signal: 0, uptimeMs: 0 })
      }
      break
    }
    case 'kill':
      s?.kill()
      break
    case 'forget':
      sessions.delete(msg.id)
      s?.dispose(true)
      break
    case 'write':
      s?.write(msg.data)
      break
    case 'resize':
      resizeAll(msg.cols, msg.rows, msg.activeId)
      break
    case 'watched': {
      const ids = new Set(msg.ids)
      for (const x of sessions.values()) x.watched = ids.has(x.id)
      break
    }
    case 'pause':
      s?.setPaused(msg.paused)
      break
    case 'refreshMinis':
      for (const x of sessions.values()) x.dirty = true
      break
    case 'attach':
      emit({
        t: 'attached',
        reqId: msg.reqId,
        id: msg.id,
        seq: s ? s.flushNow() : 0,
        ansi: s ? s.serialize(msg.scrollback) : '',
        live: !!s?.alive
      })
      break
    case 'history': {
      if (!s) return
      // Output up to this seq is already in the log, so the browser drops it after replay.
      const seq = s.flushNow()
      void s.loadHistory(msg.lines).then(({ ansi, complete }) =>
        emit({ t: 'history', reqId: msg.reqId, id: msg.id, seq, ansi, lines: msg.lines, complete })
      )
      break
    }
    case 'snapshot': {
      let snapshot = null
      try {
        snapshot = s ? s.snapshot() : null
      } catch {
        snapshot = null
      }
      emit({ t: 'snapshot', reqId: msg.reqId, id: msg.id, snapshot })
      break
    }
  }
}

process.on('message', (m) => {
  try {
    onControl(m as HostControl)
  } catch (e) {
    emit({ t: 'error', message: `pty host: ${(e as Error).message}` })
  }
})

// If the server dies, take every shell down with us rather than leaving orphans.
process.on('disconnect', () => {
  for (const s of sessions.values()) s.kill()
  process.exit(0)
})

// Mini views: low-rate cell samples of every session that changed.
setInterval(() => {
  for (const s of sessions.values()) {
    if (!s.dirty) continue
    try {
      const m = s.mini()
      emit({ t: 'mini', id: s.id, cols: m.cols, rows: m.rows, cells: m.cells })
    } catch {
      /* sampling must never kill the host */
    }
  }
}, MINI_INTERVAL_MS)

// What each shell is running and where, for resume after a restart.
let polling = false
setInterval(() => {
  if (polling) return
  const pids = new Map<string, number>()
  for (const s of sessions.values()) if (s.alive) pids.set(s.id, s.pid)
  if (pids.size === 0) return
  polling = true
  void pollProcs(pids)
    .then((infos) => {
      for (const [id, info] of infos) emit({ t: 'proc', id, info })
    })
    .finally(() => (polling = false))
}, PROC_INTERVAL_MS)

process.on('uncaughtException', (err) => emit({ t: 'error', message: `pty host: ${err.message}` }))

emit({ t: 'ready' })
