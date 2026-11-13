import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { packMini } from '../shared/miniCodec'
import type { ClientMsg, HostControl, HostEvent, ServerMsg } from '../shared/protocol'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json'
}

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"

/** Slow-client backpressure: pause a session's pty while a viewer's socket is this backed up. */
const PAUSE_ABOVE = 4 * 1024 * 1024
const RESUME_BELOW = 512 * 1024

// Replies a browser's xterm sends on its own (device attributes, cursor position, focus
// in/out, OSC colour queries). They go to the pty but must not count as the human typing.
// (Kitty-protocol key presses are also CSI ... u, so only the "?"-prefixed flags reply counts.)
const TERMINAL_REPORT = /^(\x1b\[[?>]?[\d;]*[cnR]|\x1b\[\?\d*u|\x1b\[[IO]|\x1b\[\??[\d;]*\$y|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1bP[\s\S]*?\x1b\\)+$/

export interface WebDeps {
  staticDir: string
  token: string
  host: (msg: HostControl) => void
  rpc: (method: string, arg: unknown) => unknown | Promise<unknown>
  onInput: (id: string) => void
  getState: () => unknown
}

interface Client {
  ws: WebSocket
  /** Sessions this tab is drawing in a full terminal (two during a switch animation). */
  attached: Set<string>
}

function tokenOk(given: string | null, expected: string): boolean {
  if (!given || given.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected))
}

/**
 * Serves the UI and one WebSocket per browser tab. Listens on 127.0.0.1 only. Because a
 * local server that can type into shells is an attractive target for any web page the user
 * visits, every socket must present the token, come from our own origin, and use a Host
 * header that names us (which defeats DNS rebinding).
 */
export class WebServer {
  readonly http: Server
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 })
  private readonly clients = new Set<Client>()
  private pending = new Map<number, { client: Client; kind: 'attach' | 'history' }>()
  private reqId = 0
  private paused = new Set<string>()
  port = 0

  constructor(private readonly deps: WebDeps) {
    this.http = createServer((req, res) => {
      if (!this.hostOk(req)) {
        res.writeHead(421).end()
        return
      }
      const url = new URL(req.url ?? '/', 'http://x')
      if (url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('stack')
        return
      }
      let file = normalize(join(deps.staticDir, url.pathname))
      if (!file.startsWith(deps.staticDir)) {
        res.writeHead(403).end()
        return
      }
      if (!existsSync(file) || statSync(file).isDirectory()) file = join(deps.staticDir, 'index.html')
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'content-security-policy': CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': file.endsWith('index.html') ? 'no-store' : 'max-age=31536000, immutable'
      })
      createReadStream(file).pipe(res)
    })

    this.http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const origin = req.headers.origin ?? ''
      const allowedOrigins = [`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`]
      if (url.pathname !== '/ws' || !this.hostOk(req) || !allowedOrigins.includes(origin) || !tokenOk(url.searchParams.get('token'), deps.token)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws))
    })

    setInterval(() => this.checkBackpressure(), 100)
  }

  private hostOk(req: IncomingMessage): boolean {
    const host = req.headers.host ?? ''
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`
  }

  listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (e: NodeJS.ErrnoException) => {
        this.http.off('listening', onListening)
        reject(e)
      }
      const onListening = () => {
        this.http.off('error', onError)
        const addr = this.http.address()
        this.port = typeof addr === 'object' && addr ? addr.port : port
        resolve(this.port)
      }
      this.http.once('error', onError)
      this.http.once('listening', onListening)
      this.http.listen(port, '127.0.0.1')
    })
  }

  private send(c: Client, msg: ServerMsg): void {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg))
  }

  broadcast(msg: ServerMsg): void {
    const text = JSON.stringify(msg)
    for (const c of this.clients) if (c.ws.readyState === c.ws.OPEN) c.ws.send(text)
  }

  private watchedChanged(): void {
    const ids = [...new Set([...this.clients].flatMap((c) => [...c.attached]))]
    this.deps.host({ t: 'watched', ids })
  }

  private onConnection(ws: WebSocket): void {
    const client: Client = { ws, attached: new Set() }
    this.clients.add(client)
    this.send(client, { t: 'state', state: this.deps.getState() })
    this.deps.host({ t: 'refreshMinis' })

    ws.on('message', async (raw, isBinary) => {
      if (isBinary) return
      let msg: ClientMsg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      switch (msg.t) {
        case 'rpc':
          try {
            const value = await this.deps.rpc(msg.method, msg.arg)
            this.send(client, { t: 'rpc', rid: msg.rid, ok: true, value })
          } catch (e) {
            this.send(client, { t: 'rpc', rid: msg.rid, ok: false, error: (e as Error).message })
          }
          break
        case 'input':
          this.deps.host({ t: 'write', id: msg.id, data: msg.data })
          if (!TERMINAL_REPORT.test(msg.data)) this.deps.onInput(msg.id)
          break
        case 'attach': {
          client.attached.add(msg.id)
          this.watchedChanged()
          const reqId = ++this.reqId
          this.pending.set(reqId, { client, kind: 'attach' })
          this.deps.host({ t: 'attach', reqId, id: msg.id, scrollback: msg.scrollback })
          break
        }
        case 'detach':
          client.attached.delete(msg.id)
          this.watchedChanged()
          break
        case 'history': {
          const reqId = ++this.reqId
          this.pending.set(reqId, { client, kind: 'history' })
          this.deps.host({ t: 'history', reqId, id: msg.id, lines: msg.lines })
          break
        }
      }
    })
    ws.on('close', () => {
      this.clients.delete(client)
      this.watchedChanged()
    })
    ws.on('error', () => ws.terminate())
  }

  /** Route terminal traffic from the pty host to the browsers that need it. */
  onHostEvent(ev: HostEvent): void {
    switch (ev.t) {
      case 'data': {
        const text = JSON.stringify({ t: 'data', id: ev.id, seq: ev.seq, d: ev.d } satisfies ServerMsg)
        for (const c of this.clients) if (c.attached.has(ev.id) && c.ws.readyState === c.ws.OPEN) c.ws.send(text)
        break
      }
      case 'mini': {
        if (this.clients.size === 0) return
        const frame = packMini(ev.id, ev.cols, ev.rows, ev.cells)
        for (const c of this.clients) if (c.ws.readyState === c.ws.OPEN && c.ws.bufferedAmount < PAUSE_ABOVE) c.ws.send(frame)
        break
      }
      case 'attached': {
        const p = this.pending.get(ev.reqId)
        this.pending.delete(ev.reqId)
        if (p) this.send(p.client, { t: 'attached', id: ev.id, seq: ev.seq, ansi: ev.ansi, live: ev.live })
        break
      }
      case 'history': {
        const p = this.pending.get(ev.reqId)
        this.pending.delete(ev.reqId)
        if (p) this.send(p.client, { t: 'history', id: ev.id, seq: ev.seq, ansi: ev.ansi, lines: ev.lines, complete: ev.complete })
        break
      }
      case 'spawned':
        // A (re)spawned session starts with a fresh screen; re-attach anyone viewing it.
        for (const c of this.clients) {
          if (!c.attached.has(ev.id)) continue
          const reqId = ++this.reqId
          this.pending.set(reqId, { client: c, kind: 'attach' })
          this.deps.host({ t: 'attach', reqId, id: ev.id, scrollback: 2000 })
        }
        break
    }
  }

  /** After a pty host restart, tell it again which sessions are being viewed. */
  resendWatched(): void {
    this.watchedChanged()
  }

  private checkBackpressure(): void {
    const worst = new Map<string, number>()
    for (const c of this.clients) {
      for (const id of c.attached) worst.set(id, Math.max(worst.get(id) ?? 0, c.ws.bufferedAmount))
    }
    for (const [id, amount] of worst) {
      if (amount > PAUSE_ABOVE && !this.paused.has(id)) {
        this.paused.add(id)
        this.deps.host({ t: 'pause', id, paused: true })
      }
    }
    for (const id of [...this.paused]) {
      if ((worst.get(id) ?? 0) < RESUME_BELOW) {
        this.paused.delete(id)
        this.deps.host({ t: 'pause', id, paused: false })
      }
    }
  }

  closeAll(): void {
    this.broadcast({ t: 'bye' })
    for (const c of this.clients) c.ws.close()
  }
}
