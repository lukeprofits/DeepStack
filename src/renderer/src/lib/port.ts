import { unpackMini } from '../../../shared/miniCodec'
import type { ClientMsg, ServerMsg, Snapshot } from '../../../shared/protocol'
import type { AppState, DeliverResult, Intent, SendOffEvent, SnapEvent } from '../../../shared/types'

// One WebSocket to the DeepStack server carries everything: RPC, state broadcasts, terminal bytes
// and binary mini-terminal frames. It reconnects on its own; the server keeps all state, so a
// dropped connection or a reloaded tab loses nothing.

const TOKEN_KEY = 'stack-token'

function takeToken(): string {
  const m = /token=([a-f0-9]+)/.exec(location.hash)
  if (m) {
    try {
      localStorage.setItem(TOKEN_KEY, m[1])
    } catch {
      /* private mode: keep it in memory only */
    }
    history.replaceState(null, '', location.pathname + location.search)
    return m[1]
  }
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

type TermMsg = Extract<ServerMsg, { t: 'data' | 'attached' | 'history' }>
type Listener<T> = (v: T) => void

class Client {
  private ws: WebSocket | null = null
  private readonly token = takeToken()
  private rid = 0
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private outbox: string[] = []
  private retry = 250
  private stopped = false
  private bye = false
  readonly term = new Set<Listener<TermMsg>>()
  readonly state = new Set<Listener<AppState>>()
  readonly sendOff = new Set<Listener<SendOffEvent>>()
  readonly snap = new Set<Listener<SnapEvent>>()
  readonly connection = new Set<Listener<'open' | 'closed' | 'denied' | 'bye'>>()
  readonly connectHooks = new Set<() => void>()
  lastState: AppState | null = null

  constructor() {
    this.connect()
  }

  get hasToken(): boolean {
    return !!this.token
  }

  private connect(): void {
    if (this.stopped) return
    const ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(this.token)}`)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    let opened = false
    ws.onopen = () => {
      opened = true
      this.bye = false
      this.retry = 250
      for (const m of this.outbox) ws.send(m)
      this.outbox = []
      this.connection.forEach((f) => f('open'))
      this.connectHooks.forEach((f) => f())
    }
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') {
        const m = unpackMini(e.data as ArrayBuffer)
        if (m) setFrame(m.id, { cols: m.cols, rows: m.rows, cells: m.cells })
        return
      }
      const msg = JSON.parse(e.data) as ServerMsg
      switch (msg.t) {
        case 'rpc': {
          const w = this.waiting.get(msg.rid)
          this.waiting.delete(msg.rid)
          if (msg.ok) w?.resolve(msg.value)
          else w?.reject(new Error(msg.error))
          break
        }
        case 'state':
          this.lastState = msg.state as AppState
          this.state.forEach((f) => f(msg.state as AppState))
          break
        case 'sendOff':
          this.sendOff.forEach((f) => f({ id: msg.id, target: msg.target, ms: msg.ms, at: Date.now() }))
          break
        case 'snap':
          this.snap.forEach((f) => f({ id: msg.id, from: msg.from }))
          break
        case 'bye':
          // Server is quitting. Keep retrying slowly so the tab comes back on the next start.
          this.bye = true
          this.connection.forEach((f) => f('bye'))
          break
        default:
          this.term.forEach((f) => f(msg))
      }
    }
    ws.onclose = () => {
      this.ws = null
      for (const w of this.waiting.values()) w.reject(new Error('disconnected'))
      this.waiting.clear()
      if (this.stopped) return
      if (!this.bye) this.connection.forEach((f) => f(opened ? 'closed' : 'denied'))
      setTimeout(() => this.connect(), this.retry)
      this.retry = Math.min(this.retry * 2, 3000)
    }
  }

  send(msg: ClientMsg): void {
    const text = JSON.stringify(msg)
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(text)
    else if (msg.t === 'rpc') this.outbox.push(text)
    // Terminal input/attach while disconnected is dropped; attach is redone on reconnect.
  }

  rpc<T>(method: 'getState' | 'intent' | 'getSnapshot', arg?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const rid = ++this.rid
      this.waiting.set(rid, { resolve: resolve as (v: unknown) => void, reject })
      this.send({ t: 'rpc', rid, method, arg })
    })
  }
}

const client = new Client()

function sub<T>(set: Set<Listener<T>>, fn: Listener<T>): () => void {
  set.add(fn)
  return () => {
    set.delete(fn)
  }
}

/** App-level API (state, intents). */
export const stack = {
  getState: () => client.rpc<AppState>('getState'),
  intent: (i: Intent) => client.rpc<unknown>('intent', i).catch(() => undefined),
  deliver: (i: Extract<Intent, { t: 'deliver' }>) => client.rpc<DeliverResult | undefined>('intent', i).catch(() => undefined),
  getSnapshot: (id: string) => client.rpc<Snapshot | null>('getSnapshot', id).catch(() => null),
  onState: (fn: Listener<AppState>) => sub(client.state, fn),
  onSendOff: (fn: Listener<SendOffEvent>) => sub(client.sendOff, fn),
  onSnap: (fn: Listener<SnapEvent>) => sub(client.snap, fn),
  onConnection: (fn: Listener<'open' | 'closed' | 'denied' | 'bye'>) => sub(client.connection, fn),
  get hasToken() {
    return client.hasToken
  }
}

/** Terminal byte stream for the main view. */
export const port = {
  send: (msg: Extract<ClientMsg, { t: 'input' | 'attach' | 'detach' | 'history' }>) => client.send(msg),
  on: (fn: Listener<TermMsg>) => sub(client.term, fn),
  onConnect: (fn: () => void) => {
    client.connectHooks.add(fn)
    return () => {
      client.connectHooks.delete(fn)
    }
  }
}

// Mini samples, kept outside React so 20 sessions at 4 Hz don't re-render the tree.
export interface MiniFrame {
  cols: number
  rows: number
  cells: Uint32Array
}

const frames = new Map<string, MiniFrame>()
const frameSubs = new Map<string, Set<() => void>>()

function setFrame(id: string, f: MiniFrame): void {
  frames.set(id, f)
  frameSubs.get(id)?.forEach((fn) => fn())
}

export function getFrame(id: string): MiniFrame | undefined {
  return frames.get(id)
}

export function subscribeFrame(id: string, fn: () => void): () => void {
  let set = frameSubs.get(id)
  if (!set) frameSubs.set(id, (set = new Set()))
  set.add(fn)
  return () => {
    set!.delete(fn)
  }
}
